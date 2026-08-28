//! Opt-in TLS edge for customer hostnames.
//!
//! The platform wildcard and egress certificate comes from startup PEM files. Exact custom-domain
//! certificates are immutable snapshots hot-swapped by `certificates`; handshakes see either the old
//! complete inventory or the new one. The existing ALB and protocol listeners remain intact until
//! the opt-in edge listener is configured.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::Context as _;
use arc_swap::ArcSwap;
use axum::Router as AxumRouter;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use hyper::body::Incoming;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder as ConnectionBuilder;
use hyper_util::service::TowerToHyperService;
use rustls::ServerConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::{ClientHello, ResolvesServerCert, ResolvesServerCertUsingSni};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_rustls::LazyConfigAcceptor;
use tokio_rustls::server::TlsStream;
use tower::{Service, ServiceExt as _};

use sproutos_sandbox_forward_proxy::SandboxForwardProxy;

const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const DEFAULT_MAX_CONNECTIONS: usize = 1_024;

/// Socket metadata established by the edge rather than supplied by the request.
#[derive(Debug, Clone)]
pub struct ConnectionContext {
    pub peer: SocketAddr,
    pub sni: Arc<str>,
    pub scheme: &'static str,
}

/// What owns a connection after TLS has authenticated its SNI name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Egress,
    Http,
}

/// A decrypted connection after rustls has authenticated its SNI.
pub trait EdgeIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T> EdgeIo for T where T: AsyncRead + AsyncWrite + Unpin + Send {}

#[async_trait::async_trait]
pub trait EgressHandoff: Send + Sync {
    async fn serve(&self, connection: Box<dyn EdgeIo>) -> io::Result<()>;
}

#[async_trait::async_trait]
impl EgressHandoff for SandboxForwardProxy {
    async fn serve(&self, connection: Box<dyn EdgeIo>) -> io::Result<()> {
        self.serve_connection(connection).await
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DispatchError {
    #[error("TLS SNI is required")]
    MissingSni,
    #[error("TLS SNI is not configured")]
    UnknownSni,
}

/// Classify only names for which the TLS resolver has a certificate.
pub fn target_for_sni(
    sni: Option<&str>,
    configured_names: &HashSet<String>,
    egress_sni: Option<&str>,
) -> Result<Target, DispatchError> {
    let sni = sni.ok_or(DispatchError::MissingSni)?.to_ascii_lowercase();
    if !configured_names
        .iter()
        .any(|pattern| sni_matches(pattern, &sni))
    {
        return Err(DispatchError::UnknownSni);
    }
    Ok(
        if egress_sni.is_some_and(|host| host.eq_ignore_ascii_case(&sni)) {
            Target::Egress
        } else {
            Target::Http
        },
    )
}

fn sni_matches(pattern: &str, sni: &str) -> bool {
    let pattern = pattern.trim_end_matches('.');
    let sni = sni.trim_end_matches('.');
    if pattern.eq_ignore_ascii_case(sni) {
        return true;
    }
    let Some(suffix) = pattern.strip_prefix("*.") else {
        return false;
    };
    let Some(label) = sni
        .strip_suffix(suffix)
        .and_then(|prefix| prefix.strip_suffix('.'))
    else {
        return false;
    };
    !label.is_empty() && !label.contains('.')
}

#[derive(Debug)]
pub(crate) struct ConfiguredResolver {
    platform_names: HashSet<String>,
    platform_certificate: Arc<rustls::sign::CertifiedKey>,
    custom: ArcSwap<HashMap<String, Arc<rustls::sign::CertifiedKey>>>,
}

impl ResolvesServerCert for ConfiguredResolver {
    fn resolve(&self, client_hello: ClientHello<'_>) -> Option<Arc<rustls::sign::CertifiedKey>> {
        let sni = client_hello.server_name()?;
        self.resolve_name(sni)
    }
}

impl ConfiguredResolver {
    pub(crate) fn resolve_name(&self, sni: &str) -> Option<Arc<rustls::sign::CertifiedKey>> {
        if let Some(certificate) = self.custom.load().get(&sni.to_ascii_lowercase()) {
            return Some(Arc::clone(certificate));
        }
        self.platform_names
            .iter()
            .any(|pattern| sni_matches(pattern, sni))
            .then(|| Arc::clone(&self.platform_certificate))
    }

    pub(crate) fn replace_custom(
        &self,
        certificates: HashMap<String, Arc<rustls::sign::CertifiedKey>>,
    ) {
        self.custom.store(Arc::new(certificates));
    }
}

/// Host must name the same authority TLS authenticated. Ports are not part of either DNS name.
pub fn host_matches_sni(host: Option<&str>, sni: &str) -> bool {
    let Some(host) = host else { return false };
    let host = host.trim();
    let host = if host.starts_with('[') {
        // Public SNI names are DNS names, not IP literals. Refuse bracketed IPv6 rather than trying
        // to make its colons look like a port separator.
        return false;
    } else {
        host.rsplit_once(':')
            .filter(|(_, port)| port.parse::<u16>().is_ok())
            .map_or(host, |(name, _)| name)
    };
    host.trim_end_matches('.')
        .eq_ignore_ascii_case(sni.trim_end_matches('.'))
}

/// A configured edge. Constructing it parses every key and certificate before a socket is bound.
pub struct Edge {
    http_config: Arc<ServerConfig>,
    egress_config: Arc<ServerConfig>,
    resolver: Arc<ConfiguredResolver>,
    egress_sni: Option<String>,
    egress: Option<Arc<dyn EgressHandoff>>,
    http: AxumRouter,
    connections: Arc<Semaphore>,
}

impl Edge {
    pub fn from_pem(
        certificate_pem: &[u8],
        private_key_pem: &[u8],
        names: impl IntoIterator<Item = String>,
        egress_sni: Option<String>,
        egress: Option<Arc<dyn EgressHandoff>>,
        http: AxumRouter,
        max_connections: usize,
    ) -> anyhow::Result<Self> {
        let configured_names = names
            .into_iter()
            .map(|name| name.trim().trim_end_matches('.').to_ascii_lowercase())
            .filter(|name| !name.is_empty())
            .collect::<HashSet<_>>();
        anyhow::ensure!(
            !configured_names.is_empty(),
            "the TLS edge has no SNI names"
        );
        anyhow::ensure!(
            max_connections > 0,
            "the TLS edge connection limit must be positive"
        );
        if let Some(egress_name) = egress_sni.as_deref() {
            anyhow::ensure!(
                configured_names
                    .iter()
                    .any(|pattern| sni_matches(pattern, egress_name)),
                "the egress SNI is not covered by ROUTER_TLS_EDGE_SNI_NAMES"
            );
            anyhow::ensure!(
                egress.is_some(),
                "the egress SNI is configured but the forward proxy is not"
            );
        }

        let mut certificate_reader = certificate_pem;
        let certificates = rustls_pemfile::certs(&mut certificate_reader)
            .collect::<Result<Vec<CertificateDer<'static>>, _>>()
            .context("the TLS edge certificate PEM is invalid")?;
        anyhow::ensure!(
            !certificates.is_empty(),
            "the TLS edge certificate PEM is empty"
        );
        let mut private_key_reader = private_key_pem;
        let key: PrivateKeyDer<'static> = rustls_pemfile::private_key(&mut private_key_reader)
            .context("the TLS edge private-key PEM is invalid")?
            .context("the TLS edge private-key PEM is empty")?;
        let signing_key = rustls::crypto::aws_lc_rs::default_provider()
            .key_provider
            .load_private_key(key)
            .context("the TLS edge private key is unsupported")?;
        let certified = Arc::new(rustls::sign::CertifiedKey::new(certificates, signing_key));

        // Use rustls' verifier at boot so a typo cannot create an edge that accepts an SNI and then
        // presents a certificate no client will trust. The custom resolver below adds wildcard
        // matching; rustls' stock resolver stores exact names only.
        let mut verifier = ResolvesServerCertUsingSni::new();
        for name in &configured_names {
            let verification_name = name
                .strip_prefix("*.")
                .map_or_else(|| name.clone(), |suffix| format!("wildcard-check.{suffix}"));
            verifier
                .add(&verification_name, (*certified).clone())
                .with_context(|| format!("the TLS edge certificate does not cover {name}"))?;
        }
        let resolver = Arc::new(ConfiguredResolver {
            platform_names: configured_names,
            platform_certificate: certified,
            custom: ArcSwap::from_pointee(HashMap::new()),
        });
        let mut http_config = ServerConfig::builder()
            .with_no_client_auth()
            .with_cert_resolver(resolver.clone());
        http_config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        let mut egress_config = ServerConfig::builder()
            .with_no_client_auth()
            .with_cert_resolver(resolver.clone());
        egress_config.alpn_protocols = vec![b"http/1.1".to_vec()];

        Ok(Self {
            http_config: Arc::new(http_config),
            egress_config: Arc::new(egress_config),
            resolver,
            egress_sni: egress_sni.map(|name| name.to_ascii_lowercase()),
            egress,
            http,
            connections: Arc::new(Semaphore::new(max_connections)),
        })
    }

    pub async fn serve(self: Arc<Self>, listener: TcpListener) -> io::Result<()> {
        loop {
            let (stream, peer) = listener.accept().await?;
            let Some(permit) = self.connection_permit() else {
                tracing::warn!(%peer, "TLS edge connection limit reached");
                drop(stream);
                continue;
            };
            let edge = Arc::clone(&self);
            tokio::spawn(async move {
                let _permit = permit;
                if let Err(cause) = edge.serve_connection(stream).await {
                    tracing::debug!(%peer, %cause, "TLS edge connection ended");
                }
            });
        }
    }

    pub async fn serve_connection(&self, stream: TcpStream) -> anyhow::Result<()> {
        let peer = stream
            .peer_addr()
            .context("could not read TLS edge peer address")?;
        let deadline = tokio::time::Instant::now() + HANDSHAKE_TIMEOUT;
        let start = tokio::time::timeout_at(
            deadline,
            LazyConfigAcceptor::new(rustls::server::Acceptor::default(), stream),
        )
        .await
        .context("TLS edge handshake timed out")?
        .context("TLS edge handshake failed")?;
        let sni = start
            .client_hello()
            .server_name()
            .map(str::to_owned)
            .ok_or(DispatchError::MissingSni)?;
        if self.resolver.resolve_name(&sni).is_none() {
            return Err(DispatchError::UnknownSni.into());
        }
        let target = if self
            .egress_sni
            .as_deref()
            .is_some_and(|name| name.eq_ignore_ascii_case(&sni))
        {
            Target::Egress
        } else {
            Target::Http
        };
        let config = match target {
            Target::Egress => Arc::clone(&self.egress_config),
            Target::Http => Arc::clone(&self.http_config),
        };
        let tls = tokio::time::timeout_at(deadline, start.into_stream(config))
            .await
            .context("TLS edge handshake timed out")?
            .context("TLS edge handshake failed")?;
        self.dispatch_tls(tls, target, sni, peer).await
    }

    fn connection_permit(&self) -> Option<OwnedSemaphorePermit> {
        Arc::clone(&self.connections).try_acquire_owned().ok()
    }

    pub(crate) fn resolver(&self) -> Arc<ConfiguredResolver> {
        Arc::clone(&self.resolver)
    }

    async fn dispatch_tls<T>(
        &self,
        tls: TlsStream<T>,
        target: Target,
        sni: String,
        peer: SocketAddr,
    ) -> anyhow::Result<()>
    where
        T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        match target {
            Target::Egress => self
                .egress
                .as_ref()
                .context("egress SNI is configured but the forward proxy is not")?
                .serve(Box::new(tls))
                .await
                .context("the forward proxy connection failed"),
            Target::Http => serve_http(tls, self.http.clone(), sni, peer).await,
        }
    }
}

/// Start the edge only when its listen address is set. Existing public paths remain authoritative
/// when it is absent, which makes this safe to ship before an NLB listener points at it.
pub async fn start_from_env(
    egress: Option<Arc<SandboxForwardProxy>>,
    http: AxumRouter,
    certificate_runtime: Option<crate::certificates::Runtime>,
) -> anyhow::Result<Option<tokio::task::JoinHandle<()>>> {
    let listen = match std::env::var("ROUTER_TLS_EDGE_LISTEN") {
        Ok(listen) => listen,
        Err(std::env::VarError::NotPresent) => {
            let partial = [
                "ROUTER_TLS_EDGE_CERT_FILE",
                "ROUTER_TLS_EDGE_KEY_FILE",
                "ROUTER_TLS_EDGE_SNI_NAMES",
                "ROUTER_TLS_EDGE_EGRESS_SNI",
                "ROUTER_TLS_EDGE_MAX_CONNECTIONS",
                "ROUTER_TLS_EDGE_PLATFORM_CERT_VERSION",
            ]
            .into_iter()
            .find(|name| std::env::var(name).is_ok());
            anyhow::ensure!(
                partial.is_none(),
                "{} is set but ROUTER_TLS_EDGE_LISTEN is not",
                partial.unwrap_or_default()
            );
            return Ok(None);
        }
        Err(cause) => return Err(cause).context("ROUTER_TLS_EDGE_LISTEN is not valid Unicode"),
    };
    let certificate_path = std::env::var("ROUTER_TLS_EDGE_CERT_FILE")
        .context("ROUTER_TLS_EDGE_CERT_FILE is required when the TLS edge is enabled")?;
    let key_path = std::env::var("ROUTER_TLS_EDGE_KEY_FILE")
        .context("ROUTER_TLS_EDGE_KEY_FILE is required when the TLS edge is enabled")?;
    let names = std::env::var("ROUTER_TLS_EDGE_SNI_NAMES")
        .context("ROUTER_TLS_EDGE_SNI_NAMES is required when the TLS edge is enabled")?
        .split(',')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let egress_sni = std::env::var("ROUTER_TLS_EDGE_EGRESS_SNI")
        .ok()
        .filter(|name| !name.is_empty());
    let max_connections = std::env::var("ROUTER_TLS_EDGE_MAX_CONNECTIONS")
        .ok()
        .map(|value| value.parse::<usize>())
        .transpose()
        .context("ROUTER_TLS_EDGE_MAX_CONNECTIONS must be a positive integer")?
        .unwrap_or(DEFAULT_MAX_CONNECTIONS);
    let certificate = std::fs::read(&certificate_path)
        .with_context(|| format!("could not read {certificate_path}"))?;
    let key = std::fs::read(&key_path).with_context(|| format!("could not read {key_path}"))?;
    let edge = Arc::new(Edge::from_pem(
        &certificate,
        &key,
        names,
        egress_sni,
        egress.map(|proxy| proxy as Arc<dyn EgressHandoff>),
        http,
        max_connections,
    )?);
    let certificate_runtime = certificate_runtime
        .context("custom certificate inventory is required when the TLS edge is enabled")?;
    let platform_ack =
        crate::certificates::PlatformCertificateAck::from_runtime(&certificate_runtime)?;
    let _inventory = crate::certificates::start(edge.resolver(), certificate_runtime)
        .await
        .context("initial custom certificate inventory failed")?;
    let listener = TcpListener::bind(&listen)
        .await
        .with_context(|| format!("could not bind {listen} for the TLS edge"))?;
    let _platform_ack = platform_ack
        .start()
        .await
        .context("initial platform certificate acknowledgement failed")?;
    tracing::info!(%listen, "opt-in TLS edge listening");
    Ok(Some(tokio::spawn(async move {
        if let Err(cause) = edge.serve(listener).await {
            tracing::error!(%cause, "TLS edge stopped serving");
        }
    })))
}

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

#[derive(Clone)]
struct HostGuard {
    inner: AxumRouter,
    sni: Arc<str>,
    context: ConnectionContext,
}

impl Service<Request<Incoming>> for HostGuard {
    type Response = Response;
    type Error = std::convert::Infallible;
    type Future = BoxFuture<Result<Response, Self::Error>>;

    fn poll_ready(
        &mut self,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        <AxumRouter as Service<Request<Body>>>::poll_ready(&mut self.inner, cx)
    }

    fn call(&mut self, mut request: Request<Incoming>) -> Self::Future {
        if !host_matches_sni(
            request
                .headers()
                .get("host")
                .and_then(|value| value.to_str().ok()),
            &self.sni,
        ) {
            return Box::pin(async {
                Ok((
                    StatusCode::MISDIRECTED_REQUEST,
                    "Host does not match TLS SNI",
                )
                    .into_response())
            });
        }
        request.extensions_mut().insert(self.context.clone());
        let service = self.inner.clone();
        let request = request.map(Body::new);
        Box::pin(async move { Ok(service.oneshot(request).await.expect("Axum is infallible")) })
    }
}

async fn serve_http<T>(
    tls: TlsStream<T>,
    app: AxumRouter,
    sni: String,
    peer: SocketAddr,
) -> anyhow::Result<()>
where
    T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let sni: Arc<str> = sni.into();
    let service = HostGuard {
        inner: app,
        sni: Arc::clone(&sni),
        context: ConnectionContext {
            peer,
            sni,
            scheme: "https",
        },
    };
    ConnectionBuilder::new(TokioExecutor::new())
        .serve_connection(TokioIo::new(tls), TowerToHyperService::new(service))
        .await
        .map_err(|cause| anyhow::anyhow!("serving TLS-edge HTTP failed: {cause}"))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use axum::extract::Extension;
    use axum::routing::get;
    use rcgen::generate_simple_self_signed;
    use rustls::ClientConfig;
    use rustls::pki_types::ServerName;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio_rustls::TlsConnector;

    use super::*;

    struct RecordingEgress(AtomicBool);

    #[async_trait::async_trait]
    impl EgressHandoff for RecordingEgress {
        async fn serve(&self, mut connection: Box<dyn EdgeIo>) -> io::Result<()> {
            let mut request = [0_u8; 4];
            connection.read_exact(&mut request).await?;
            if request == *b"PING" {
                self.0.store(true, Ordering::SeqCst);
                connection.write_all(b"PONG").await?;
            }
            Ok(())
        }
    }

    struct Fixture {
        certificate: Vec<u8>,
        key: Vec<u8>,
        roots: rustls::RootCertStore,
    }

    fn fixture() -> Fixture {
        crate::install_crypto_provider();
        let certified = generate_simple_self_signed(vec![
            "app.example.test".to_owned(),
            "egress.example.test".to_owned(),
        ])
        .unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(certified.cert.der().clone()).unwrap();
        Fixture {
            certificate: certified.cert.pem().into_bytes(),
            key: certified.key_pair.serialize_pem().into_bytes(),
            roots,
        }
    }

    fn edge(fixture: &Fixture, egress: Arc<dyn EgressHandoff>) -> Arc<Edge> {
        Arc::new(
            Edge::from_pem(
                &fixture.certificate,
                &fixture.key,
                ["app.example.test".into(), "egress.example.test".into()],
                Some("egress.example.test".into()),
                Some(egress),
                AxumRouter::new().fallback(get(|| async { "lambda" })),
                DEFAULT_MAX_CONNECTIONS,
            )
            .unwrap(),
        )
    }

    async fn connect(
        listener: TcpListener,
        edge: Arc<Edge>,
        roots: rustls::RootCertStore,
        name: &str,
    ) -> anyhow::Result<tokio_rustls::client::TlsStream<TcpStream>> {
        connect_with_alpn(listener, edge, roots, name, Vec::new()).await
    }

    async fn connect_with_alpn(
        listener: TcpListener,
        edge: Arc<Edge>,
        roots: rustls::RootCertStore,
        name: &str,
        alpn_protocols: Vec<Vec<u8>>,
    ) -> anyhow::Result<tokio_rustls::client::TlsStream<TcpStream>> {
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            edge.serve_connection(stream).await
        });
        let mut client = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        client.alpn_protocols = alpn_protocols;
        let stream = TcpStream::connect(address).await?;
        let tls = TlsConnector::from(Arc::new(client))
            .connect(ServerName::try_from(name.to_owned())?, stream)
            .await?;
        // The server task owns the connection lifetime and is intentionally detached until the
        // caller closes its half.
        drop(server);
        Ok(tls)
    }

    #[test]
    fn missing_and_unknown_sni_are_never_dispatched() {
        let names = HashSet::from(["app.example.test".to_owned()]);
        assert_eq!(
            target_for_sni(None, &names, None),
            Err(DispatchError::MissingSni)
        );
        assert_eq!(
            target_for_sni(Some("other.example.test"), &names, None),
            Err(DispatchError::UnknownSni)
        );
    }

    #[test]
    fn wildcard_accepts_one_generated_label_and_not_deeper_names() {
        let names = HashSet::from(["*.sproutos.run".to_owned()]);
        assert_eq!(
            target_for_sni(Some("generated.sproutos.run"), &names, None),
            Ok(Target::Http)
        );
        assert_eq!(
            target_for_sni(Some("preview.generated.sproutos.run"), &names, None),
            Err(DispatchError::UnknownSni)
        );
    }

    #[test]
    fn host_must_match_sni_including_after_port_normalisation() {
        assert!(host_matches_sni(
            Some("APP.EXAMPLE.TEST:443"),
            "app.example.test"
        ));
        assert!(!host_matches_sni(
            Some("other.example.test"),
            "app.example.test"
        ));
        assert!(!host_matches_sni(None, "app.example.test"));
    }

    #[tokio::test]
    async fn mismatched_http_host_is_refused_before_the_lambda_router() {
        let fixture = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let edge = edge(&fixture, Arc::new(RecordingEgress(AtomicBool::new(false))));
        let mut tls = connect(listener, edge, fixture.roots, "app.example.test")
            .await
            .unwrap();
        tls.write_all(b"GET / HTTP/1.1\r\nHost: other.example.test\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        tls.read_to_end(&mut response).await.unwrap();
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 421"));
    }

    #[tokio::test]
    async fn unknown_sni_is_rejected_during_the_tls_handshake() {
        let fixture = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let edge = edge(&fixture, Arc::new(RecordingEgress(AtomicBool::new(false))));
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            edge.serve_connection(stream).await
        });
        let client = ClientConfig::builder()
            .with_root_certificates(fixture.roots)
            .with_no_client_auth();
        let stream = TcpStream::connect(address).await.unwrap();
        let result = TlsConnector::from(Arc::new(client))
            .connect(
                ServerName::try_from("unknown.example.test".to_owned()).unwrap(),
                stream,
            )
            .await;
        assert!(result.is_err());
        assert!(server.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn exact_egress_sni_hands_the_decrypted_stream_to_the_proxy_seam() {
        let fixture = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let handoff = Arc::new(RecordingEgress(AtomicBool::new(false)));
        let edge = edge(&fixture, handoff.clone());
        let mut tls = connect(listener, edge, fixture.roots, "egress.example.test")
            .await
            .unwrap();
        tls.write_all(b"PING").await.unwrap();
        let mut response = [0_u8; 4];
        tls.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"PONG");
        assert!(handoff.0.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn wildcard_certificate_starts_and_completes_a_real_handshake() {
        crate::install_crypto_provider();
        let certified = generate_simple_self_signed(vec!["*.sproutos.run".to_owned()]).unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(certified.cert.der().clone()).unwrap();
        let edge = Arc::new(
            Edge::from_pem(
                certified.cert.pem().as_bytes(),
                certified.key_pair.serialize_pem().as_bytes(),
                ["*.sproutos.run".into()],
                None,
                None,
                AxumRouter::new().fallback(get(|| async { "lambda" })),
                DEFAULT_MAX_CONNECTIONS,
            )
            .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();

        let mut tls = connect(listener, edge, roots, "generated.sproutos.run")
            .await
            .unwrap();
        tls.write_all(
            b"GET / HTTP/1.1\r\nHost: generated.sproutos.run\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
        let mut response = Vec::new();
        tls.read_to_end(&mut response).await.unwrap();
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200"));
    }

    #[tokio::test]
    async fn alpn_is_selected_by_sni_before_the_handshake_completes() {
        let fixture = fixture();
        let handoff = Arc::new(RecordingEgress(AtomicBool::new(false)));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let app_edge = edge(&fixture, handoff.clone());
        let app_tls = connect_with_alpn(
            listener,
            app_edge,
            fixture.roots.clone(),
            "app.example.test",
            vec![b"h2".to_vec(), b"http/1.1".to_vec()],
        )
        .await
        .unwrap();
        assert_eq!(app_tls.get_ref().1.alpn_protocol(), Some(b"h2".as_slice()));
        drop(app_tls);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let edge = edge(&fixture, handoff);
        let egress_tls = connect_with_alpn(
            listener,
            edge,
            fixture.roots,
            "egress.example.test",
            vec![b"h2".to_vec(), b"http/1.1".to_vec()],
        )
        .await
        .unwrap();
        assert_eq!(
            egress_tls.get_ref().1.alpn_protocol(),
            Some(b"http/1.1".as_slice())
        );
    }

    #[test]
    fn connection_limit_is_enforced_before_spawning_more_handshakes() {
        let fixture = fixture();
        let edge = Edge::from_pem(
            &fixture.certificate,
            &fixture.key,
            ["app.example.test".into()],
            None,
            None,
            AxumRouter::new(),
            1,
        )
        .unwrap();

        let first = edge.connection_permit().expect("first connection admitted");
        assert!(edge.connection_permit().is_none());
        drop(first);
        assert!(edge.connection_permit().is_some());
    }

    #[tokio::test]
    async fn http_handoff_carries_the_trusted_socket_peer() {
        let fixture = fixture();
        let http = AxumRouter::new().fallback(get(
            |Extension(context): Extension<ConnectionContext>| async move {
                context.peer.ip().to_string()
            },
        ));
        let edge = Arc::new(
            Edge::from_pem(
                &fixture.certificate,
                &fixture.key,
                ["app.example.test".into()],
                None,
                None,
                http,
                DEFAULT_MAX_CONNECTIONS,
            )
            .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut tls = connect(listener, edge, fixture.roots, "app.example.test")
            .await
            .unwrap();
        tls.write_all(b"GET / HTTP/1.1\r\nHost: app.example.test\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        tls.read_to_end(&mut response).await.unwrap();
        assert!(String::from_utf8_lossy(&response).ends_with("127.0.0.1"));
    }
}
