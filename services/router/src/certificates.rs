//! Versioned custom-certificate inventory for the TLS edge.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context as _;
use async_trait::async_trait;
use aws_sdk_s3::Client as S3Client;
use deadpool_postgres::Pool;
use futures_util::StreamExt as _;
use redis::aio::ConnectionManager;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::ResolvesServerCertUsingSni;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use tokio::io::AsyncReadExt as _;
use tokio::sync::Mutex;

use crate::edge::ConfiguredResolver;

pub const INVALIDATION_CHANNEL: &str = "certificates:invalidate";
pub const SERVING_REPLICAS_KEY: &str = "cert:serving-replicas";
const MAX_CERTIFICATE_OBJECT_BYTES: i64 = 1024 * 1024;
const INVENTORY_IO_TIMEOUT: Duration = Duration::from_secs(10);

/// Repeated proof that this process parsed and is serving one immutable platform certificate
/// version. Platform wildcard certificates do not use the exact-host hot-reload inventory: a
/// rolling restart fetches the new version before boot, and the control plane stays in
/// `awaiting_deployment` until enough live instances publish these expiring acknowledgements.
pub struct PlatformCertificateAck {
    valkey: ConnectionManager,
    object_version: String,
    instance_id: String,
    interval: Duration,
    ttl: Duration,
}

impl PlatformCertificateAck {
    pub fn from_runtime(runtime: &Runtime) -> anyhow::Result<Self> {
        let object_version = std::env::var("ROUTER_TLS_EDGE_PLATFORM_CERT_VERSION").context(
            "ROUTER_TLS_EDGE_PLATFORM_CERT_VERSION is required when the TLS edge is enabled",
        )?;
        anyhow::ensure!(
            !object_version.is_empty(),
            "platform certificate version is empty"
        );
        Ok(Self {
            valkey: runtime.valkey.clone(),
            object_version,
            instance_id: runtime.instance_id.clone(),
            interval: runtime.poll_interval,
            ttl: runtime.ack_ttl,
        })
    }

    async fn acknowledge(&self) -> anyhow::Result<()> {
        let mut connection = self.valkey.clone();
        let expires_at = serving_expiry_ms(SystemTime::now(), self.ttl)?;
        let mut pipeline = redis::pipe();
        pipeline
            .atomic()
            .cmd("SET")
            .arg(platform_ack_key(&self.object_version, &self.instance_id))
            .arg("1")
            .arg("EX")
            .arg(self.ttl.as_secs())
            .ignore()
            .cmd("ZADD")
            .arg(SERVING_REPLICAS_KEY)
            .arg(expires_at)
            .arg(&self.instance_id)
            .ignore();
        pipeline.query_async::<()>(&mut connection).await?;
        Ok(())
    }

    /// Acknowledge only after the edge parsed the PEM, loaded exact certificates, and bound its
    /// listener. The recurring refresh makes a crashed instance disappear without explicit
    /// deregistration and gives reconciliation durable serving membership rather than a static
    /// replica count or boot history. The worker expires old sorted-set members atomically while
    /// checking that every remaining member acknowledged the exact version.
    pub async fn start(self) -> anyhow::Result<tokio::task::JoinHandle<()>> {
        self.acknowledge().await?;
        Ok(tokio::spawn(async move {
            let mut interval = tokio::time::interval(self.interval);
            interval.tick().await;
            loop {
                interval.tick().await;
                if let Err(cause) = self.acknowledge().await {
                    tracing::error!(%cause, "platform certificate acknowledgement failed");
                }
            }
        }))
    }
}

fn serving_expiry_ms(now: SystemTime, ttl: Duration) -> anyhow::Result<u64> {
    let milliseconds = now
        .duration_since(UNIX_EPOCH)
        .context("system clock precedes the Unix epoch")?
        .checked_add(ttl)
        .context("serving-replica expiry overflowed")?
        .as_millis();
    u64::try_from(milliseconds).context("serving-replica expiry exceeds u64 milliseconds")
}

fn platform_ack_key(object_version: &str, instance_id: &str) -> String {
    format!(
        "cert:platform-loaded:{}:{instance_id}",
        certificate_version_key(object_version)
    )
}

fn certificate_version_key(object_version: &str) -> String {
    let digest = Sha256::digest(object_version.as_bytes());
    format!("{digest:x}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesiredCertificate {
    pub hostname: String,
    pub object_key: String,
    pub object_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CertificateObject {
    version: u8,
    hostname: String,
    certificate_pem: String,
    private_key_pem: String,
    issued_at: String,
    expires_at: String,
}

#[derive(Clone)]
struct LoadedCertificate {
    object_version: String,
    expires_at: chrono::DateTime<chrono::Utc>,
    certificate: Arc<rustls::sign::CertifiedKey>,
}

#[async_trait]
pub trait CertificateSource: Send + Sync {
    async fn desired(&self) -> anyhow::Result<Vec<DesiredCertificate>>;
}

#[async_trait]
pub trait CertificateObjects: Send + Sync {
    async fn fetch(&self, desired: &DesiredCertificate) -> anyhow::Result<Vec<u8>>;
}

#[async_trait]
pub trait ReadinessAcks: Send + Sync {
    async fn acknowledge_all(
        &self,
        loaded: &[(String, String)],
        instance_id: &str,
        ttl: Duration,
    ) -> anyhow::Result<()>;
}

pub struct PostgresCertificateSource {
    pool: Pool,
}

impl PostgresCertificateSource {
    pub fn new(pool: Pool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl CertificateSource for PostgresCertificateSource {
    async fn desired(&self) -> anyhow::Result<Vec<DesiredCertificate>> {
        let client = self.pool.get().await?;
        let rows = client
            .query(
                r#"
                select hostname, status, certificate_object_key, certificate_object_version
                  from custom_domain
                 where deleted_at is null
                   and certificate_object_key is not null
                   and certificate_object_version is not null
                "#,
                &[],
            )
            .await?;
        Ok(rows
            .into_iter()
            .filter(|row| certificate_status_is_serving(row.get("status")))
            .map(|row| DesiredCertificate {
                hostname: row.get("hostname"),
                object_key: row.get("certificate_object_key"),
                object_version: row.get("certificate_object_version"),
            })
            .collect())
    }
}

fn certificate_status_is_serving(status: &str) -> bool {
    matches!(
        status,
        "issuing" | "propagating" | "active" | "renewal_warning"
    )
}

pub struct S3CertificateObjects {
    client: S3Client,
    bucket: String,
}

impl S3CertificateObjects {
    pub fn new(client: S3Client, bucket: String) -> Self {
        Self { client, bucket }
    }
}

#[async_trait]
impl CertificateObjects for S3CertificateObjects {
    async fn fetch(&self, desired: &DesiredCertificate) -> anyhow::Result<Vec<u8>> {
        let object = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&desired.object_key)
            .version_id(&desired.object_version)
            .send()
            .await
            .with_context(|| {
                format!(
                    "could not fetch s3://{}/{} version {}",
                    self.bucket, desired.object_key, desired.object_version
                )
            })?;
        anyhow::ensure!(
            object.content_length().unwrap_or(0) <= MAX_CERTIFICATE_OBJECT_BYTES,
            "certificate object is larger than one MiB"
        );
        let mut bytes = Vec::new();
        object
            .body
            .into_async_read()
            .take((MAX_CERTIFICATE_OBJECT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await?;
        anyhow::ensure!(
            bytes.len() <= MAX_CERTIFICATE_OBJECT_BYTES as usize,
            "certificate object is larger than one MiB"
        );
        Ok(bytes)
    }
}

#[async_trait]
impl ReadinessAcks for ConnectionManager {
    async fn acknowledge_all(
        &self,
        loaded: &[(String, String)],
        instance_id: &str,
        ttl: Duration,
    ) -> anyhow::Result<()> {
        if loaded.is_empty() {
            return Ok(());
        }
        let mut connection = self.clone();
        let mut pipeline = redis::pipe();
        for (hostname, object_version) in loaded {
            let key = format!(
                "cert:loaded:{hostname}:{}:{instance_id}",
                certificate_version_key(object_version)
            );
            pipeline
                .cmd("SET")
                .arg(key)
                .arg("1")
                .arg("EX")
                .arg(ttl.as_secs())
                .ignore();
        }
        pipeline.query_async::<()>(&mut connection).await?;
        Ok(())
    }
}

pub struct CertificateInventory {
    resolver: Arc<ConfiguredResolver>,
    source: Arc<dyn CertificateSource>,
    objects: Arc<dyn CertificateObjects>,
    acks: Arc<dyn ReadinessAcks>,
    instance_id: String,
    ack_ttl: Duration,
    loaded: Mutex<HashMap<String, LoadedCertificate>>,
}

impl CertificateInventory {
    pub(crate) fn new(
        resolver: Arc<ConfiguredResolver>,
        source: Arc<dyn CertificateSource>,
        objects: Arc<dyn CertificateObjects>,
        acks: Arc<dyn ReadinessAcks>,
        instance_id: String,
        ack_ttl: Duration,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(!instance_id.is_empty(), "certificate instance ID is empty");
        anyhow::ensure!(
            instance_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
            "certificate instance ID is not safe for a Valkey key"
        );
        anyhow::ensure!(
            !ack_ttl.is_zero(),
            "certificate acknowledgement TTL is zero"
        );
        Ok(Self {
            resolver,
            source,
            objects,
            acks,
            instance_id,
            ack_ttl,
            loaded: Mutex::new(HashMap::new()),
        })
    }

    /// Refresh one complete immutable snapshot. Initial load is strict; a listener must not become
    /// ready when any desired certificate is absent or invalid. Later refreshes retain the old valid
    /// certificate for a hostname whose replacement temporarily cannot be fetched or validated.
    pub async fn reload(&self, initial: bool) -> anyhow::Result<()> {
        let desired = tokio::time::timeout(INVENTORY_IO_TIMEOUT, self.source.desired())
            .await
            .context("certificate inventory database read timed out")??;
        let previous = self.loaded.lock().await.clone();
        let mut next = HashMap::with_capacity(desired.len());
        let mut first_error = None;

        for desired in desired {
            let hostname = normalize_exact_hostname(&desired.hostname)?;
            let loaded = if let Some(existing) = previous.get(&hostname).filter(|loaded| {
                loaded.object_version == desired.object_version
                    && loaded.expires_at > chrono::Utc::now()
            }) {
                Some(existing.clone())
            } else {
                match self.load_one(&desired, &hostname).await {
                    Ok(certificate) => Some(certificate),
                    Err(cause) => {
                        tracing::error!(%cause, %hostname, "custom certificate refresh failed");
                        if first_error.is_none() {
                            first_error = Some(cause);
                        }
                        previous
                            .get(&hostname)
                            .filter(|loaded| loaded.expires_at > chrono::Utc::now())
                            .cloned()
                    }
                }
            };

            if let Some(loaded) = loaded {
                next.insert(hostname, loaded);
            }
        }

        if initial && let Some(cause) = first_error.take() {
            return Err(cause).context("initial custom certificate inventory is incomplete");
        }

        self.resolver.replace_custom(
            next.iter()
                .map(|(hostname, loaded)| (hostname.clone(), Arc::clone(&loaded.certificate)))
                .collect(),
        );
        *self.loaded.lock().await = next.clone();

        let acknowledgements = next
            .iter()
            .map(|(hostname, certificate)| (hostname.clone(), certificate.object_version.clone()))
            .collect::<Vec<_>>();
        if let Err(cause) = tokio::time::timeout(
            INVENTORY_IO_TIMEOUT,
            self.acks
                .acknowledge_all(&acknowledgements, &self.instance_id, self.ack_ttl),
        )
        .await
        .context("certificate readiness acknowledgement timed out")
        .and_then(|result| result)
            && first_error.is_none()
        {
            first_error = Some(cause);
        }
        match first_error {
            Some(cause) => Err(cause).context("custom certificate inventory refresh was partial"),
            None => Ok(()),
        }
    }

    async fn load_one(
        &self,
        desired: &DesiredCertificate,
        normalized_hostname: &str,
    ) -> anyhow::Result<LoadedCertificate> {
        let bytes = tokio::time::timeout(INVENTORY_IO_TIMEOUT, self.objects.fetch(desired))
            .await
            .context("certificate object fetch timed out")??;
        let object: CertificateObject =
            serde_json::from_slice(&bytes).context("certificate object is not valid JSON")?;
        anyhow::ensure!(
            object.version == 1,
            "unsupported certificate object version"
        );
        anyhow::ensure!(
            normalize_exact_hostname(&object.hostname)? == normalized_hostname,
            "certificate object hostname does not match inventory hostname"
        );
        let issued_at = chrono::DateTime::parse_from_rfc3339(&object.issued_at)
            .context("certificate issuedAt is not RFC 3339")?;
        let expires_at = chrono::DateTime::parse_from_rfc3339(&object.expires_at)
            .context("certificate expiresAt is not RFC 3339")?;
        anyhow::ensure!(
            expires_at > issued_at,
            "certificate expiry precedes issuance"
        );
        anyhow::ensure!(
            expires_at > chrono::Utc::now(),
            "certificate object is already expired"
        );
        let certificate = certified_key(
            object.certificate_pem.as_bytes(),
            object.private_key_pem.as_bytes(),
            normalized_hostname,
        )?;
        Ok(LoadedCertificate {
            object_version: desired.object_version.clone(),
            expires_at: expires_at.with_timezone(&chrono::Utc),
            certificate,
        })
    }
}

fn certified_key(
    certificate_pem: &[u8],
    private_key_pem: &[u8],
    hostname: &str,
) -> anyhow::Result<Arc<rustls::sign::CertifiedKey>> {
    let mut certificate_reader = certificate_pem;
    let certificates = rustls_pemfile::certs(&mut certificate_reader)
        .collect::<Result<Vec<CertificateDer<'static>>, _>>()?;
    anyhow::ensure!(!certificates.is_empty(), "certificate PEM is empty");
    let mut key_reader = private_key_pem;
    let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut key_reader)?
        .context("certificate private-key PEM is empty")?;
    let signing_key = rustls::crypto::aws_lc_rs::default_provider()
        .key_provider
        .load_private_key(key)?;
    let certified = rustls::sign::CertifiedKey::new(certificates, signing_key);
    certified
        .keys_match()
        .context("certificate and private key do not match")?;
    let mut verifier = ResolvesServerCertUsingSni::new();
    verifier
        .add(hostname, certified.clone())
        .with_context(|| format!("certificate does not cover {hostname}"))?;
    Ok(Arc::new(certified))
}

fn normalize_exact_hostname(hostname: &str) -> anyhow::Result<String> {
    let hostname = hostname.trim().trim_end_matches('.').to_ascii_lowercase();
    let valid = !hostname.is_empty()
        && hostname.len() <= 253
        && !hostname.contains('*')
        && hostname.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        });
    anyhow::ensure!(valid, "invalid exact certificate hostname");
    Ok(hostname)
}

pub struct Runtime {
    pub pool: Pool,
    pub s3: S3Client,
    pub bucket: String,
    pub valkey: ConnectionManager,
    pub redis: redis::Client,
    pub instance_id: String,
    pub poll_interval: Duration,
    pub ack_ttl: Duration,
}

pub(crate) async fn start(
    resolver: Arc<ConfiguredResolver>,
    runtime: Runtime,
) -> anyhow::Result<tokio::task::JoinHandle<()>> {
    anyhow::ensure!(
        runtime.poll_interval >= Duration::from_secs(5)
            && runtime.poll_interval <= Duration::from_secs(300),
        "certificate poll interval must be between 5 and 300 seconds"
    );
    anyhow::ensure!(
        runtime.ack_ttl > runtime.poll_interval * 2,
        "certificate acknowledgement TTL must exceed two poll intervals"
    );
    let inventory = Arc::new(CertificateInventory::new(
        resolver,
        Arc::new(PostgresCertificateSource::new(runtime.pool)),
        Arc::new(S3CertificateObjects::new(runtime.s3, runtime.bucket)),
        Arc::new(runtime.valkey),
        runtime.instance_id,
        runtime.ack_ttl,
    )?);
    inventory.reload(true).await?;

    Ok(tokio::spawn(async move {
        supervise(inventory, runtime.redis, runtime.poll_interval).await;
    }))
}

async fn supervise(
    inventory: Arc<CertificateInventory>,
    redis: redis::Client,
    poll_interval: Duration,
) {
    loop {
        let mut pubsub = match redis.get_async_pubsub().await {
            Ok(pubsub) => pubsub,
            Err(cause) => {
                tracing::error!(%cause, "certificate invalidation subscription failed");
                tokio::time::sleep(poll_interval).await;
                let _ = inventory.reload(false).await;
                continue;
            }
        };
        if let Err(cause) = pubsub.subscribe(INVALIDATION_CHANNEL).await {
            tracing::error!(%cause, "certificate invalidation subscribe failed");
            tokio::time::sleep(poll_interval).await;
            if let Err(cause) = inventory.reload(false).await {
                tracing::error!(%cause, "certificate inventory fallback poll failed");
            }
            continue;
        }
        let mut messages = pubsub.on_message();
        let mut polling = tokio::time::interval(poll_interval);
        polling.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // The strict startup reload already ran; do not immediately duplicate it.
        polling.tick().await;
        loop {
            tokio::select! {
                _ = polling.tick() => {
                    if let Err(cause) = inventory.reload(false).await {
                        tracing::error!(%cause, "certificate inventory poll failed");
                    }
                }
                message = messages.next() => {
                    if message.is_none() {
                        break;
                    }
                    if let Err(cause) = inventory.reload(false).await {
                        tracing::error!(%cause, "certificate inventory invalidation failed");
                    }
                }
            }
        }
        tracing::warn!("certificate invalidation subscription ended; reconnecting");
        tokio::time::sleep(poll_interval).await;
        if let Err(cause) = inventory.reload(false).await {
            tracing::error!(%cause, "certificate inventory fallback poll failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use axum::Router as AxumRouter;
    use rcgen::{CertifiedKey, generate_simple_self_signed};
    use rustls::ClientConfig;

    #[derive(serde::Deserialize)]
    struct VersionKeyFixture {
        vectors: Vec<VersionKeyVector>,
    }

    #[derive(serde::Deserialize)]
    struct VersionKeyVector {
        version: String,
        sha256: String,
    }

    #[test]
    fn certificate_version_keys_match_the_typescript_consumer_fixture() {
        let fixture: VersionKeyFixture =
            serde_json::from_str(include_str!("../fixtures/certificate-version-key.json")).unwrap();
        for vector in fixture.vectors {
            assert_eq!(certificate_version_key(&vector.version), vector.sha256);
        }
    }

    #[test]
    fn serving_membership_expiry_tracks_the_ack_ttl() {
        let now = UNIX_EPOCH + Duration::from_secs(1_000);
        assert_eq!(
            serving_expiry_ms(now, Duration::from_secs(90)).unwrap(),
            1_090_000
        );
    }

    #[test]
    fn renewal_keeps_the_previous_certificate_in_the_desired_inventory() {
        // `issuing` with a non-null object pair is a renewal. Initial issuance has no object pair
        // and is excluded in SQL before this predicate runs.
        assert!(certificate_status_is_serving("issuing"));
        assert!(certificate_status_is_serving("propagating"));
        assert!(!certificate_status_is_serving("pending_dns"));
        assert!(!certificate_status_is_serving("failed"));
    }
    use rustls::pki_types::ServerName;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::{TcpListener, TcpStream};
    use tokio_rustls::TlsConnector;

    use super::*;
    use crate::edge::Edge;

    struct FakeSource(StdMutex<Vec<DesiredCertificate>>);

    #[async_trait]
    impl CertificateSource for FakeSource {
        async fn desired(&self) -> anyhow::Result<Vec<DesiredCertificate>> {
            Ok(self.0.lock().unwrap().clone())
        }
    }

    struct FakeObjects(StdMutex<HashMap<String, Vec<u8>>>);

    #[async_trait]
    impl CertificateObjects for FakeObjects {
        async fn fetch(&self, desired: &DesiredCertificate) -> anyhow::Result<Vec<u8>> {
            self.0
                .lock()
                .unwrap()
                .get(&desired.object_version)
                .cloned()
                .context("missing fake object")
        }
    }

    #[derive(Default)]
    struct FakeAcks(StdMutex<Vec<(String, String, String)>>);

    #[async_trait]
    impl ReadinessAcks for FakeAcks {
        async fn acknowledge_all(
            &self,
            loaded: &[(String, String)],
            instance_id: &str,
            _ttl: Duration,
        ) -> anyhow::Result<()> {
            self.0
                .lock()
                .unwrap()
                .extend(loaded.iter().map(|(hostname, version)| {
                    (hostname.clone(), version.clone(), instance_id.into())
                }));
            Ok(())
        }
    }

    fn desired(version: &str) -> DesiredCertificate {
        DesiredCertificate {
            hostname: "app.example.test".into(),
            object_key: "certificates/app.json".into(),
            object_version: version.into(),
        }
    }

    fn object(hostname: &str, certified: &CertifiedKey) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "hostname": hostname,
            "certificatePem": certified.cert.pem(),
            "privateKeyPem": certified.key_pair.serialize_pem(),
            "issuedAt": (chrono::Utc::now() - chrono::Duration::minutes(1)).to_rfc3339(),
            "expiresAt": (chrono::Utc::now() + chrono::Duration::days(30)).to_rfc3339(),
        }))
        .unwrap()
    }

    fn resolver() -> Arc<ConfiguredResolver> {
        crate::install_crypto_provider();
        let platform = generate_simple_self_signed(vec!["*.platform.test".into()]).unwrap();
        Edge::from_pem(
            platform.cert.pem().as_bytes(),
            platform.key_pair.serialize_pem().as_bytes(),
            ["*.platform.test".into()],
            None,
            None,
            AxumRouter::new(),
            10,
        )
        .unwrap()
        .resolver()
    }

    fn inventory(
        resolver: Arc<ConfiguredResolver>,
        source: Arc<FakeSource>,
        objects: Arc<FakeObjects>,
        acks: Arc<FakeAcks>,
    ) -> CertificateInventory {
        CertificateInventory::new(
            resolver,
            source,
            objects,
            acks,
            "instance-a".into(),
            Duration::from_secs(90),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn reload_atomically_replaces_a_complete_snapshot_for_concurrent_readers() {
        let first = generate_simple_self_signed(vec!["app.example.test".into()]).unwrap();
        let second = generate_simple_self_signed(vec!["app.example.test".into()]).unwrap();
        let source = Arc::new(FakeSource(StdMutex::new(vec![desired("v1")])));
        let objects = Arc::new(FakeObjects(StdMutex::new(HashMap::from([
            ("v1".into(), object("app.example.test", &first)),
            ("v2".into(), object("app.example.test", &second)),
        ]))));
        let acks = Arc::new(FakeAcks::default());
        let resolver = resolver();
        let inventory = inventory(
            Arc::clone(&resolver),
            Arc::clone(&source),
            objects,
            Arc::clone(&acks),
        );
        inventory.reload(true).await.unwrap();
        let old = resolver.resolve_name("app.example.test").unwrap();

        *source.0.lock().unwrap() = vec![desired("v2")];
        let readers = (0..16)
            .map(|_| {
                let resolver = Arc::clone(&resolver);
                tokio::spawn(async move {
                    for _ in 0..500 {
                        assert!(resolver.resolve_name("app.example.test").is_some());
                        tokio::task::yield_now().await;
                    }
                })
            })
            .collect::<Vec<_>>();
        inventory.reload(false).await.unwrap();
        for reader in readers {
            reader.await.unwrap();
        }

        let new = resolver.resolve_name("app.example.test").unwrap();
        assert!(!Arc::ptr_eq(&old, &new));
        assert!(
            acks.0
                .lock()
                .unwrap()
                .iter()
                .any(|ack| ack == &("app.example.test".into(), "v2".into(), "instance-a".into()))
        );
    }

    #[tokio::test]
    async fn invalid_replacement_retains_the_previous_valid_certificate() {
        let first = generate_simple_self_signed(vec!["app.example.test".into()]).unwrap();
        let wrong_cert = generate_simple_self_signed(vec!["other.example.test".into()]).unwrap();
        let unrelated_key = generate_simple_self_signed(vec!["app.example.test".into()]).unwrap();
        let broken = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "hostname": "app.example.test",
            "certificatePem": wrong_cert.cert.pem(),
            "privateKeyPem": unrelated_key.key_pair.serialize_pem(),
            "issuedAt": chrono::Utc::now().to_rfc3339(),
            "expiresAt": (chrono::Utc::now() + chrono::Duration::days(30)).to_rfc3339(),
        }))
        .unwrap();
        let source = Arc::new(FakeSource(StdMutex::new(vec![desired("v1")])));
        let objects = Arc::new(FakeObjects(StdMutex::new(HashMap::from([
            ("v1".into(), object("app.example.test", &first)),
            ("v2".into(), broken),
        ]))));
        let resolver = resolver();
        let inventory = inventory(
            Arc::clone(&resolver),
            Arc::clone(&source),
            objects,
            Arc::new(FakeAcks::default()),
        );
        inventory.reload(true).await.unwrap();
        let old = resolver.resolve_name("app.example.test").unwrap();

        *source.0.lock().unwrap() = vec![desired("v2")];
        assert!(inventory.reload(false).await.is_err());

        let still_old = resolver.resolve_name("app.example.test").unwrap();
        assert!(Arc::ptr_eq(&old, &still_old));
    }

    #[tokio::test]
    async fn deleted_inventory_rows_remove_the_exact_certificate() {
        let certificate = generate_simple_self_signed(vec!["app.example.test".into()]).unwrap();
        let source = Arc::new(FakeSource(StdMutex::new(vec![desired("v1")])));
        let objects = Arc::new(FakeObjects(StdMutex::new(HashMap::from([(
            "v1".into(),
            object("app.example.test", &certificate),
        )]))));
        let resolver = resolver();
        let inventory = inventory(
            Arc::clone(&resolver),
            Arc::clone(&source),
            objects,
            Arc::new(FakeAcks::default()),
        );
        inventory.reload(true).await.unwrap();
        assert!(resolver.resolve_name("app.example.test").is_some());

        source.0.lock().unwrap().clear();
        inventory.reload(false).await.unwrap();
        assert!(resolver.resolve_name("app.example.test").is_none());
        assert!(resolver.resolve_name("generated.platform.test").is_some());
    }

    #[tokio::test]
    async fn startup_refuses_an_incomplete_inventory() {
        let source = Arc::new(FakeSource(StdMutex::new(vec![desired("missing")])));
        let resolver = resolver();
        let inventory = inventory(
            Arc::clone(&resolver),
            source,
            Arc::new(FakeObjects(StdMutex::new(HashMap::new()))),
            Arc::new(FakeAcks::default()),
        );

        assert!(inventory.reload(true).await.is_err());
        assert!(resolver.resolve_name("app.example.test").is_none());
    }

    #[tokio::test]
    async fn a_hot_loaded_exact_certificate_completes_a_real_tls_handshake() {
        crate::install_crypto_provider();
        let platform = generate_simple_self_signed(vec!["*.platform.test".into()]).unwrap();
        let custom = generate_simple_self_signed(vec!["app.example.test".into()]).unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(custom.cert.der().clone()).unwrap();
        let edge = Arc::new(
            Edge::from_pem(
                platform.cert.pem().as_bytes(),
                platform.key_pair.serialize_pem().as_bytes(),
                ["*.platform.test".into()],
                None,
                None,
                AxumRouter::new().fallback(|| async { "lambda" }),
                10,
            )
            .unwrap(),
        );
        let source = Arc::new(FakeSource(StdMutex::new(vec![desired("v1")])));
        let objects = Arc::new(FakeObjects(StdMutex::new(HashMap::from([(
            "v1".into(),
            object("app.example.test", &custom),
        )]))));
        inventory(
            edge.resolver(),
            source,
            objects,
            Arc::new(FakeAcks::default()),
        )
        .reload(true)
        .await
        .unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            edge.serve_connection(stream).await.unwrap();
        });
        let client = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let stream = TcpStream::connect(address).await.unwrap();
        let mut tls = TlsConnector::from(Arc::new(client))
            .connect(
                ServerName::try_from("app.example.test".to_owned()).unwrap(),
                stream,
            )
            .await
            .unwrap();
        tls.write_all(b"GET / HTTP/1.1\r\nHost: app.example.test\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        tls.read_to_end(&mut response).await.unwrap();
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200"));
    }
}
