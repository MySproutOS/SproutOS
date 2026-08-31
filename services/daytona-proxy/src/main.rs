use std::collections::BTreeSet;
use std::io;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context as _, bail};
use async_trait::async_trait;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use sproutos_llm_proxy::spool::{DeliveryConfig, MeteringSpool, SpoolLimits, SpoolReservation};
use sproutos_metering_proto::{UsageBatch, UsageDimension, UsageEvent};
use sproutos_sandbox_forward_proxy::{
    Authorizer, AuthzError, CredentialVerifier, EgressMeter, EgressObservation, EgressReservation,
    MeteringCapacityError, Resolver, SandboxAuthorization, SandboxForwardProxy, SandboxState,
    TokioDialer,
};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;
const METER_SOURCE: &str = "sandbox-forward-proxy";
const CREDENTIAL_ISSUER: &str = "sproutos-control-plane";
const CREDENTIAL_AUDIENCE: &str = "sproutos-daytona-proxy";
const CREDENTIAL_TTL_SECONDS: i64 = 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS: i64 = 60;

struct UnusedAuthorizer;

#[async_trait]
impl Authorizer for UnusedAuthorizer {
    async fn lookup(&self, _: Uuid) -> Result<Option<SandboxAuthorization>, AuthzError> {
        Err(AuthzError)
    }
}

#[derive(Deserialize)]
struct CredentialHeader {
    alg: String,
    typ: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialClaims {
    iss: String,
    aud: String,
    sub: Uuid,
    organization_id: Uuid,
    project_id: Uuid,
    iat: i64,
    exp: i64,
}

struct JwtCredentialVerifier {
    root_key: Arc<[u8]>,
}

impl JwtCredentialVerifier {
    fn verify_at(
        &self,
        sandbox_id: Uuid,
        supplied_password: &str,
        now: i64,
    ) -> Option<SandboxAuthorization> {
        let mut segments = supplied_password.split('.');
        let header_segment = segments.next()?;
        let payload_segment = segments.next()?;
        let signature_segment = segments.next()?;
        if segments.next().is_some() {
            return None;
        }

        let header: CredentialHeader = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(header_segment)
                .ok()?,
        )
        .ok()?;
        if header.alg != "HS256" || header.typ != "JWT" {
            return None;
        }
        let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(signature_segment)
            .ok()?;
        let mut mac = HmacSha256::new_from_slice(&self.root_key).ok()?;
        mac.update(format!("{header_segment}.{payload_segment}").as_bytes());
        mac.verify_slice(&signature).ok()?;

        let claims: CredentialClaims = serde_json::from_slice(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(payload_segment)
                .ok()?,
        )
        .ok()?;
        if claims.iss != CREDENTIAL_ISSUER
            || claims.aud != CREDENTIAL_AUDIENCE
            || claims.sub != sandbox_id
            || claims.exp.checked_sub(claims.iat) != Some(CREDENTIAL_TTL_SECONDS)
            || claims.iat > now.saturating_add(MAX_CLOCK_SKEW_SECONDS)
            || claims.exp <= now
        {
            return None;
        }
        Some(SandboxAuthorization {
            sandbox_id,
            project_id: claims.project_id,
            organization_id: claims.organization_id,
            state: SandboxState::Running,
        })
    }
}

impl CredentialVerifier for JwtCredentialVerifier {
    fn verify(&self, sandbox_id: Uuid, supplied_password: &str) -> Option<SandboxAuthorization> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs()
            .try_into()
            .ok()?;
        self.verify_at(sandbox_id, supplied_password, now)
    }
}

struct SelfRejectingResolver {
    self_addresses: BTreeSet<IpAddr>,
}

#[async_trait]
impl Resolver for SelfRejectingResolver {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<IpAddr>> {
        let addresses = tokio::net::lookup_host((host, port))
            .await?
            .map(|address| address.ip())
            .collect::<Vec<_>>();
        if addresses
            .iter()
            .any(|address| self.self_addresses.contains(address))
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the Daytona proxy cannot connect to itself",
            ));
        }
        Ok(addresses)
    }
}

#[derive(Clone)]
struct EgressUsageMeter {
    spool: MeteringSpool,
}

impl EgressMeter for EgressUsageMeter {
    fn reserve(&self) -> Result<Box<dyn EgressReservation>, MeteringCapacityError> {
        self.spool
            .reserve()
            .map(|reservation| {
                Box::new(UsageReservation(reservation)) as Box<dyn EgressReservation>
            })
            .map_err(|cause| {
                tracing::error!(%cause, "Daytona egress metering spool has no capacity");
                MeteringCapacityError
            })
    }
}

struct UsageReservation(SpoolReservation);

impl EgressReservation for UsageReservation {
    fn commit(self: Box<Self>, observation: EgressObservation) {
        let bytes = observation.total_bytes();
        if bytes == 0 {
            return;
        }
        let event = UsageEvent::new(
            format!(
                "{METER_SOURCE}:{}:sandbox_egress_byte:{}",
                observation.authorization.sandbox_id, observation.connection_id
            ),
            observation.authorization.organization_id,
            UsageDimension::SandboxEgressByte,
            bytes as f64,
            observation.occurred_at,
        )
        .with_project(observation.authorization.project_id)
        .with_attribute("protocol", observation.protocol)
        .with_attribute("request_bytes", observation.request_bytes.to_string())
        .with_attribute("response_bytes", observation.response_bytes.to_string())
        .with_attribute(
            "sandbox_id",
            observation.authorization.sandbox_id.to_string(),
        );
        let batch = UsageBatch::new(METER_SOURCE, vec![event]);
        if let Err(cause) = self.0.commit(&batch) {
            tracing::error!(%cause, "Daytona egress usage could not be committed");
        }
    }
}

fn required(name: &str) -> anyhow::Result<String> {
    std::env::var(name).with_context(|| format!("{name} is required"))
}

fn root_key() -> anyhow::Result<Vec<u8>> {
    let encoded = required("SANDBOX_FORWARD_PROXY_ROOT_KEY")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&encoded)
        .context("SANDBOX_FORWARD_PROXY_ROOT_KEY is not base64")?;
    if decoded.len() != 32 || base64::engine::general_purpose::STANDARD.encode(&decoded) != encoded
    {
        bail!("SANDBOX_FORWARD_PROXY_ROOT_KEY must be exactly 32 bytes in canonical base64");
    }
    Ok(decoded)
}

async fn self_addresses() -> anyhow::Result<BTreeSet<IpAddr>> {
    let host = required("DAYTONA_PROXY_PUBLIC_HOST")?;
    if let Ok(address) = host.parse() {
        return Ok(BTreeSet::from([address]));
    }
    Ok(tokio::net::lookup_host((host.as_str(), 3128))
        .await?
        .map(|address| address.ip())
        .collect())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .json()
        .init();

    let key = root_key()?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(4))
        .build()?;
    let credential_verifier = Arc::new(JwtCredentialVerifier {
        root_key: Arc::from(key.clone()),
    });
    let spool = MeteringSpool::open(
        PathBuf::from(required("DAYTONA_PROXY_METERING_SPOOL_DIR")?),
        SpoolLimits::default(),
    )?;
    spool.spawn_delivery(DeliveryConfig::new(
        client,
        required("METERING_INGEST_URL")?,
        required("METERING_INGEST_HMAC_KEY")?.into_bytes(),
    ));
    let proxy = Arc::new(
        SandboxForwardProxy::new(
            key,
            Arc::new(UnusedAuthorizer),
            Arc::new(SelfRejectingResolver {
                self_addresses: self_addresses().await?,
            }),
            Arc::new(TokioDialer),
            sproutos_sandbox_forward_proxy::Limits::default(),
        )?
        .with_credential_verifier(credential_verifier)
        .with_meter(Arc::new(EgressUsageMeter { spool })),
    );
    let listen = required("DAYTONA_PROXY_LISTEN")?;
    let listener = TcpListener::bind(&listen)
        .await
        .with_context(|| format!("could not bind {listen}"))?;
    tracing::info!(%listen, "standalone Daytona proxy listening");
    proxy.serve(listener).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT_KEY_BASE64: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
    const SANDBOX_ID: &str = "01930000-0000-7000-8000-000000000001";
    const ORGANIZATION_ID: &str = "01930000-0000-7000-8000-000000000002";
    const PROJECT_ID: &str = "01930000-0000-7000-8000-000000000003";
    const ISSUED_AT: i64 = 1_800_000_000;
    const TYPESCRIPT_TOKEN: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzcHJvdXRvcy1jb250cm9sLXBsYW5lIiwiYXVkIjoic3Byb3V0b3MtZGF5dG9uYS1wcm94eSIsInN1YiI6IjAxOTMwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDAwMSIsIm9yZ2FuaXphdGlvbklkIjoiMDE5MzAwMDAtMDAwMC03MDAwLTgwMDAtMDAwMDAwMDAwMDAyIiwicHJvamVjdElkIjoiMDE5MzAwMDAtMDAwMC03MDAwLTgwMDAtMDAwMDAwMDAwMDAzIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwODY0MDB9.koRIqFKmPJ8Ghp8iKunuurZQmaRISE67KW1gGoRuYWA";

    fn token(exp: i64, key: &[u8]) -> String {
        let header = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let claims = serde_json::json!({
            "iss": CREDENTIAL_ISSUER,
            "aud": CREDENTIAL_AUDIENCE,
            "sub": SANDBOX_ID,
            "organizationId": ORGANIZATION_ID,
            "projectId": PROJECT_ID,
            "iat": ISSUED_AT,
            "exp": exp,
        });
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&claims).unwrap());
        let signing_input = format!("{header}.{payload}");
        let mut mac = HmacSha256::new_from_slice(key).unwrap();
        mac.update(signing_input.as_bytes());
        let signature =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{signing_input}.{signature}")
    }

    fn verifier() -> JwtCredentialVerifier {
        JwtCredentialVerifier {
            root_key: Arc::from(
                base64::engine::general_purpose::STANDARD
                    .decode(ROOT_KEY_BASE64)
                    .unwrap(),
            ),
        }
    }

    #[test]
    fn accepts_a_valid_24_hour_credential() {
        let authorization = verifier()
            .verify_at(
                SANDBOX_ID.parse().unwrap(),
                &token(ISSUED_AT + CREDENTIAL_TTL_SECONDS, &root_key_for_test()),
                ISSUED_AT + 1,
            )
            .unwrap();
        assert_eq!(authorization.organization_id.to_string(), ORGANIZATION_ID);
        assert_eq!(authorization.project_id.to_string(), PROJECT_ID);
    }

    #[test]
    fn accepts_the_exact_typescript_credential_vector() {
        assert!(
            verifier()
                .verify_at(SANDBOX_ID.parse().unwrap(), TYPESCRIPT_TOKEN, ISSUED_AT + 1,)
                .is_some()
        );
    }

    #[test]
    fn rejects_expired_tampered_and_wrong_lifetime_credentials() {
        let key = root_key_for_test();
        let valid = token(ISSUED_AT + CREDENTIAL_TTL_SECONDS, &key);
        assert!(
            verifier()
                .verify_at(
                    SANDBOX_ID.parse().unwrap(),
                    &valid,
                    ISSUED_AT + CREDENTIAL_TTL_SECONDS
                )
                .is_none()
        );
        assert!(
            verifier()
                .verify_at(
                    SANDBOX_ID.parse().unwrap(),
                    &format!("{valid}x"),
                    ISSUED_AT + 1,
                )
                .is_none()
        );
        assert!(
            verifier()
                .verify_at(
                    SANDBOX_ID.parse().unwrap(),
                    &token(ISSUED_AT + CREDENTIAL_TTL_SECONDS + 1, &key),
                    ISSUED_AT + 1,
                )
                .is_none()
        );
    }

    fn root_key_for_test() -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(ROOT_KEY_BASE64)
            .unwrap()
    }
}
