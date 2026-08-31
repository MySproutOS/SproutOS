use std::collections::BTreeSet;
use std::io;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context as _, bail};
use async_trait::async_trait;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use reqwest::StatusCode;
use serde::Deserialize;
use sha2::Sha256;
use sproutos_llm_proxy::spool::{DeliveryConfig, MeteringSpool, SpoolLimits, SpoolReservation};
use sproutos_metering_proto::{UsageBatch, UsageDimension, UsageEvent};
use sproutos_sandbox_forward_proxy::{
    Authorizer, AuthzError, EgressMeter, EgressObservation, EgressReservation,
    MeteringCapacityError, Resolver, SandboxAuthorization, SandboxForwardProxy, SandboxState,
    TokioDialer,
};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;
const AUTHORIZE_DOMAIN: &str = "sproutos:daytona-proxy-authorize:v1";
const METER_SOURCE: &str = "sandbox-forward-proxy";

#[derive(Clone)]
struct ApiAuthorizer {
    client: reqwest::Client,
    base_url: String,
    root_key: Arc<[u8]>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizationResponse {
    sandbox_id: Uuid,
    project_id: Uuid,
    organization_id: Uuid,
    state: String,
}

#[async_trait]
impl Authorizer for ApiAuthorizer {
    async fn lookup(&self, sandbox_id: Uuid) -> Result<Option<SandboxAuthorization>, AuthzError> {
        let signature =
            authorization_signature(&self.root_key, sandbox_id).map_err(|_| AuthzError)?;
        let response = self
            .client
            .get(format!(
                "{}/{}",
                self.base_url.trim_end_matches('/'),
                sandbox_id
            ))
            .header("x-daytona-proxy-signature", signature)
            .send()
            .await
            .map_err(|_| AuthzError)?;
        if response.status() == StatusCode::UNAUTHORIZED
            || response.status() == StatusCode::NOT_FOUND
        {
            return Ok(None);
        }
        let response = response
            .error_for_status()
            .map_err(|_| AuthzError)?
            .json::<AuthorizationResponse>()
            .await
            .map_err(|_| AuthzError)?;
        let state = match response.state.as_str() {
            "starting" => SandboxState::Starting,
            "running" => SandboxState::Running,
            "idle" => SandboxState::Idle,
            _ => return Ok(None),
        };
        Ok(Some(SandboxAuthorization {
            sandbox_id: response.sandbox_id,
            project_id: response.project_id,
            organization_id: response.organization_id,
            state,
        }))
    }
}

fn authorization_signature(root_key: &[u8], sandbox_id: Uuid) -> anyhow::Result<String> {
    let mut mac = HmacSha256::new_from_slice(root_key)?;
    mac.update(AUTHORIZE_DOMAIN.as_bytes());
    mac.update(&[0]);
    mac.update(sandbox_id.to_string().as_bytes());
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
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
    let authorizer = Arc::new(ApiAuthorizer {
        client: client.clone(),
        base_url: required("DAYTONA_PROXY_AUTHORIZE_URL")?,
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
            authorizer,
            Arc::new(SelfRejectingResolver {
                self_addresses: self_addresses().await?,
            }),
            Arc::new(TokioDialer),
            sproutos_sandbox_forward_proxy::Limits::default(),
        )?
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

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        root_key_base64: String,
        vectors: Vec<Vector>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vector {
        sandbox_id: Uuid,
        authorization_signature: String,
    }

    #[test]
    fn authorization_signature_matches_typescript_vectors() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../lib/rust/sandbox-forward-proxy/fixtures/credentials.json"
        ))
        .unwrap();
        let key = base64::engine::general_purpose::STANDARD
            .decode(fixture.root_key_base64)
            .unwrap();
        for vector in fixture.vectors {
            assert_eq!(
                authorization_signature(&key, vector.sandbox_id).unwrap(),
                vector.authorization_signature
            );
        }
    }
}
