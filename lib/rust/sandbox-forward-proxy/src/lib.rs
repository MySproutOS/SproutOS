//! The authenticated egress boundary for untrusted coding sandboxes.
//!
//! A sandbox receives only a derived Basic-auth credential. The proxy resolves destinations itself,
//! refuses every non-public answer before dialing, and forwards either HTTP/1.1 absolute-form
//! requests or a `CONNECT` tunnel to HTTPS or the public SproutOS Postgres listener. It deliberately
//! does not terminate the tunneled protocol.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use http::uri::{Authority, Uri};
use sha2::Sha256;
use subtle::ConstantTimeEq as _;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio::time::timeout;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

pub const DOMAIN_SEPARATOR: &str = "sproutos:sandbox-forward-proxy:v1";
pub const DEFAULT_MAX_HEADER_BYTES: usize = 32 * 1024;
pub const DEFAULT_MAX_HEADERS: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxState {
    Starting,
    Running,
    Idle,
    Stopped,
    Failed,
    Destroyed,
}

impl SandboxState {
    fn allows_egress(self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::Idle)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxAuthorization {
    pub sandbox_id: Uuid,
    pub organization_id: Uuid,
    pub project_id: Uuid,
    pub state: SandboxState,
}

/// Bytes the authenticated sandbox caused the platform proxy to send out of AWS.
///
/// `request_bytes` are the sanitized HTTP request or tunneled bytes written to a public upstream.
/// `response_bytes` are upstream bytes written back to Daytona. Both are internet DTO from the
/// proxy's point of view; bytes merely received by the proxy are not billed here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EgressObservation {
    pub authorization: SandboxAuthorization,
    pub connection_id: Uuid,
    pub request_bytes: u64,
    pub response_bytes: u64,
    pub occurred_at: i64,
    pub protocol: &'static str,
}

impl EgressObservation {
    pub fn total_bytes(&self) -> u64 {
        self.request_bytes.saturating_add(self.response_bytes)
    }
}

pub trait EgressReservation: Send {
    fn commit(self: Box<Self>, observation: EgressObservation);
}

pub trait EgressMeter: Send + Sync {
    fn reserve(&self) -> Result<Box<dyn EgressReservation>, MeteringCapacityError>;
}

#[derive(Debug, Clone, Copy, thiserror::Error)]
#[error("sandbox egress metering has no durable capacity")]
pub struct MeteringCapacityError;

#[async_trait]
pub trait Authorizer: Send + Sync {
    async fn lookup(&self, sandbox_id: Uuid) -> Result<Option<SandboxAuthorization>, AuthzError>;
}

#[derive(Debug, Clone, Copy, thiserror::Error)]
#[error("sandbox authorization lookup failed")]
pub struct AuthzError;

#[async_trait]
pub trait Resolver: Send + Sync {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<IpAddr>>;
}

pub trait ProxyIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T> ProxyIo for T where T: AsyncRead + AsyncWrite + Unpin + Send {}

#[async_trait]
pub trait Dialer: Send + Sync {
    async fn connect(&self, address: SocketAddr) -> io::Result<Box<dyn ProxyIo>>;
}

#[derive(Debug, Default)]
pub struct TokioResolver;

#[async_trait]
impl Resolver for TokioResolver {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<IpAddr>> {
        Ok(tokio::net::lookup_host((host, port))
            .await?
            .map(|address| address.ip())
            .collect())
    }
}

#[derive(Debug, Default)]
pub struct TokioDialer;

#[async_trait]
impl Dialer for TokioDialer {
    async fn connect(&self, address: SocketAddr) -> io::Result<Box<dyn ProxyIo>> {
        Ok(Box::new(TcpStream::connect(address).await?))
    }
}

#[derive(Debug, Clone)]
pub struct Limits {
    pub max_header_bytes: usize,
    pub max_headers: usize,
    pub max_connections: usize,
    pub header_timeout: Duration,
    pub authorization_timeout: Duration,
    pub resolve_timeout: Duration,
    pub connect_timeout: Duration,
    pub tunnel_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_header_bytes: DEFAULT_MAX_HEADER_BYTES,
            max_headers: DEFAULT_MAX_HEADERS,
            max_connections: 256,
            header_timeout: Duration::from_secs(10),
            authorization_timeout: Duration::from_secs(3),
            resolve_timeout: Duration::from_secs(5),
            connect_timeout: Duration::from_secs(10),
            tunnel_timeout: Duration::from_secs(300),
        }
    }
}

#[derive(Clone)]
pub struct SandboxForwardProxy {
    root_key: Arc<[u8]>,
    authorizer: Arc<dyn Authorizer>,
    resolver: Arc<dyn Resolver>,
    dialer: Arc<dyn Dialer>,
    connect_overrides: Arc<BTreeMap<(String, u16), SocketAddr>>,
    meter: Option<Arc<dyn EgressMeter>>,
    limits: Limits,
}

impl SandboxForwardProxy {
    pub fn new(
        root_key: impl Into<Vec<u8>>,
        authorizer: Arc<dyn Authorizer>,
        resolver: Arc<dyn Resolver>,
        dialer: Arc<dyn Dialer>,
        limits: Limits,
    ) -> Result<Self, ConfigError> {
        let root_key = root_key.into();
        if root_key.len() < 32 {
            return Err(ConfigError::WeakRootKey);
        }
        if limits.max_header_bytes == 0 || limits.max_headers == 0 || limits.max_connections == 0 {
            return Err(ConfigError::ZeroLimit);
        }
        Ok(Self {
            root_key: root_key.into(),
            authorizer,
            resolver,
            dialer,
            connect_overrides: Arc::new(BTreeMap::new()),
            meter: None,
            limits,
        })
    }

    #[must_use]
    pub fn with_meter(mut self, meter: Arc<dyn EgressMeter>) -> Self {
        self.meter = Some(meter);
        self
    }

    /// Route one exact public authority to a platform-owned local listener.
    ///
    /// This is not a sandbox-controlled bypass: callers configure the authority at router boot,
    /// and every other destination still resolves and passes the public-address check. It exists
    /// for a public load balancer that cannot be hairpinned from the instance behind it.
    pub fn with_connect_override(
        mut self,
        host: impl Into<String>,
        port: u16,
        target: SocketAddr,
    ) -> Self {
        let mut overrides = (*self.connect_overrides).clone();
        overrides.insert((normalize_host(&host.into()), port), target);
        self.connect_overrides = Arc::new(overrides);
        self
    }

    /// Serve a listener suitable for the router's eventual sixth port.
    pub async fn serve(self: Arc<Self>, listener: TcpListener) -> io::Result<()> {
        let connections = Arc::new(Semaphore::new(self.limits.max_connections));
        loop {
            let (stream, _) = listener.accept().await?;
            let Ok(permit) = Arc::clone(&connections).try_acquire_owned() else {
                // Capacity is bounded before a task is created. Closing is intentionally silent:
                // peer addresses are not useful enough to justify a log line per hostile connect.
                drop(stream);
                continue;
            };
            let proxy = Arc::clone(&self);
            tokio::spawn(async move {
                let _permit = permit;
                let _ = proxy.serve_connection(stream).await;
            });
        }
    }

    /// Serve one accepted client. Public for router integration and in-memory tests.
    pub async fn serve_connection<T>(&self, mut client: T) -> io::Result<()>
    where
        T: AsyncRead + AsyncWrite + Unpin + Send,
    {
        let request = match timeout(
            self.limits.header_timeout,
            read_request(&mut client, &self.limits),
        )
        .await
        {
            Ok(Ok(request)) => request,
            _ => return respond(&mut client, ResponseKind::BadRequest).await,
        };

        let Some((sandbox_id, supplied_password)) = basic_credentials(&request.headers) else {
            return respond(&mut client, ResponseKind::ProxyAuthRequired).await;
        };
        let expected = derive_password(&self.root_key, sandbox_id);
        if supplied_password
            .as_bytes()
            .ct_eq(expected.as_bytes())
            .unwrap_u8()
            != 1
        {
            return respond(&mut client, ResponseKind::ProxyAuthRequired).await;
        }
        let authorization = match timeout(
            self.limits.authorization_timeout,
            self.authorizer.lookup(sandbox_id),
        )
        .await
        {
            Ok(Ok(Some(authorization)))
                if authorization.sandbox_id == sandbox_id
                    && authorization.state.allows_egress() =>
            {
                authorization
            }
            _ => return respond(&mut client, ResponseKind::ProxyAuthRequired).await,
        };
        let destination = match request.destination() {
            Ok(destination) => destination,
            Err(_) => return respond(&mut client, ResponseKind::BadRequest).await,
        };
        let metering_reservation = match &self.meter {
            Some(meter) => match meter.reserve() {
                Ok(reservation) => Some(reservation),
                Err(_) => return respond(&mut client, ResponseKind::ServiceUnavailable).await,
            },
            None => None,
        };
        let override_key = (normalize_host(&destination.host), destination.port);
        let is_platform_override = self.connect_overrides.contains_key(&override_key);
        let socket_addresses = if let Some(address) = self.connect_overrides.get(&override_key) {
            vec![*address]
        } else {
            let addresses = match timeout(
                self.limits.resolve_timeout,
                self.resolver.resolve(&destination.host, destination.port),
            )
            .await
            {
                Ok(Ok(addresses)) if !addresses.is_empty() => addresses,
                _ => return respond(&mut client, ResponseKind::BadGateway).await,
            };
            // Reject the whole answer, not merely the private entries. Otherwise a rebinding name
            // with one public and one private result gets as many attempts as the resolver's ordering
            // gives it. Only an exact, boot-configured platform override skips this check.
            if addresses.iter().any(|address| !is_public_ip(*address)) {
                return respond(&mut client, ResponseKind::DestinationForbidden).await;
            }
            addresses
                .into_iter()
                .map(|ip| SocketAddr::new(ip, destination.port))
                .collect()
        };
        // DNS answer order is not an availability guarantee. Start every validated public address
        // under one shared deadline, so a stalled first AAAA/A record cannot prevent a later answer
        // from succeeding and a large answer cannot multiply the timeout. The losing attempts are
        // aborted as soon as one connects or the shared deadline expires.
        let mut attempts = tokio::task::JoinSet::new();
        for address in socket_addresses {
            let dialer = Arc::clone(&self.dialer);
            attempts.spawn(async move { dialer.connect(address).await });
        }
        let upstream = timeout(self.limits.connect_timeout, async {
            while let Some(attempt) = attempts.join_next().await {
                if let Ok(Ok(upstream)) = attempt {
                    return Some(upstream);
                }
            }
            None
        })
        .await
        .ok()
        .flatten();
        attempts.abort_all();
        let Some(upstream) = upstream else {
            return respond(&mut client, ResponseKind::BadGateway).await;
        };

        let connection_id = Uuid::now_v7();
        let protocol = if request.method.eq_ignore_ascii_case("CONNECT") {
            "connect"
        } else {
            "http"
        };
        let request_counter = Arc::new(AtomicU64::new(0));
        let response_counter = Arc::new(AtomicU64::new(0));
        let result: io::Result<()> = async {
            if request.method.eq_ignore_ascii_case("CONNECT") {
                client
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .await?;
                let mut upstream = CountingIo::new(upstream, Arc::clone(&request_counter));
                let mut client = CountingIo::new(client, Arc::clone(&response_counter));
                // Clients commonly send the TLS ClientHello in the same packet as CONNECT. The
                // header reader may already own those bytes; dropping them makes an otherwise
                // valid tunnel hang immediately after the 200 response.
                upstream.write_all(&request.buffered_body).await?;
                match timeout(
                    self.limits.tunnel_timeout,
                    tokio::io::copy_bidirectional(&mut client, &mut upstream),
                )
                .await
                {
                    Ok(Ok(_)) => Ok(()),
                    Ok(Err(error)) => Err(error),
                    Err(_) => Ok(()),
                }
            } else {
                let mut upstream = CountingIo::new(upstream, Arc::clone(&request_counter));
                upstream
                    .write_all(&request.forward_head(&destination))
                    .await?;
                upstream.write_all(&request.buffered_body).await?;
                // Carry exactly one parsed request. Relaying arbitrary client bytes after its body
                // would let a pipelined second request bypass destination and credential parsing.
                let remaining = request.content_length() - request.buffered_body.len() as u64;
                if remaining > 0 {
                    tokio::io::copy(&mut (&mut client).take(remaining), &mut upstream).await?;
                }
                upstream.shutdown().await?;
                let mut client = CountingIo::new(client, Arc::clone(&response_counter));
                tokio::io::copy(&mut upstream, &mut client)
                    .await
                    .map(|_| ())
            }
        }
        .await;

        let request_bytes = if is_platform_override {
            // The exact, boot-configured Postgres override stays on loopback. Its request leg does
            // not leave AWS, while its response still crosses the public proxy endpoint to Daytona.
            0
        } else {
            request_counter.load(Ordering::Relaxed)
        };
        let response_bytes = response_counter.load(Ordering::Relaxed);
        if (request_bytes != 0 || response_bytes != 0)
            && let Some(reservation) = metering_reservation
        {
            reservation.commit(EgressObservation {
                authorization,
                connection_id,
                request_bytes,
                response_bytes,
                occurred_at: now_millis(),
                protocol,
            });
        }
        result
    }
}

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

struct CountingIo<T> {
    inner: T,
    written: Arc<AtomicU64>,
}

impl<T> CountingIo<T> {
    fn new(inner: T, written: Arc<AtomicU64>) -> Self {
        Self { inner, written }
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for CountingIo<T> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buffer)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for CountingIo<T> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buffer: &[u8],
    ) -> std::task::Poll<Result<usize, io::Error>> {
        match std::pin::Pin::new(&mut self.inner).poll_write(cx, buffer) {
            std::task::Poll::Ready(Ok(written)) => {
                self.written.fetch_add(written as u64, Ordering::Relaxed);
                std::task::Poll::Ready(Ok(written))
            }
            other => other,
        }
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), io::Error>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), io::Error>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

fn normalize_host(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("sandbox forward-proxy root key must contain at least 32 bytes")]
    WeakRootKey,
    #[error("sandbox forward-proxy limits must be non-zero")]
    ZeroLimit,
}

/// Derive the password handed to exactly one sandbox.
///
/// The message is UTF-8 `DOMAIN_SEPARATOR`, one NUL byte, then the lowercase hyphenated UUID text.
/// The password is unpadded base64url, making it safe in Basic auth and environment variables.
pub fn derive_password(root_key: &[u8], sandbox_id: Uuid) -> String {
    let mut mac = HmacSha256::new_from_slice(root_key).expect("HMAC accepts any key length");
    mac.update(DOMAIN_SEPARATOR.as_bytes());
    mac.update(&[0]);
    mac.update(sandbox_id.hyphenated().to_string().as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

#[derive(Debug)]
struct RequestHead {
    method: String,
    target: String,
    headers: Vec<(String, Vec<u8>)>,
    buffered_body: Vec<u8>,
}

#[derive(Debug)]
struct Destination {
    host: String,
    authority: String,
    port: u16,
    origin_form: String,
}

impl RequestHead {
    fn content_length(&self) -> u64 {
        self.headers
            .iter()
            .find(|(name, _)| name == "content-length")
            .and_then(|(_, value)| std::str::from_utf8(value).ok())
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(0)
    }

    fn destination(&self) -> Result<Destination, ()> {
        if self.method.eq_ignore_ascii_case("CONNECT") {
            if self.target.contains('@') {
                return Err(());
            }
            let authority: Authority = self.target.parse().map_err(|_| ())?;
            let port = authority.port_u16().ok_or(())?;
            if !matches!(port, 443 | 5432) {
                return Err(());
            }
            return Ok(Destination {
                host: authority.host().to_owned(),
                authority: authority.as_str().to_owned(),
                port,
                origin_form: String::new(),
            });
        }

        let uri: Uri = self.target.parse().map_err(|_| ())?;
        if uri.scheme_str() != Some("http") {
            return Err(());
        }
        let authority = uri.authority().ok_or(())?;
        if authority.as_str().contains('@') {
            return Err(());
        }
        let port = authority.port_u16().unwrap_or(80);
        if port == 0 {
            return Err(());
        }
        Ok(Destination {
            host: authority.host().to_owned(),
            authority: authority.as_str().to_owned(),
            port,
            origin_form: uri
                .path_and_query()
                .map_or_else(|| "/".to_owned(), ToString::to_string),
        })
    }

    fn forward_head(&self, destination: &Destination) -> Vec<u8> {
        let connection_named = connection_named_headers(&self.headers);
        let mut out = Vec::new();
        out.extend_from_slice(self.method.as_bytes());
        out.extend_from_slice(b" ");
        out.extend_from_slice(destination.origin_form.as_bytes());
        out.extend_from_slice(b" HTTP/1.1\r\nHost: ");
        out.extend_from_slice(destination.authority.as_bytes());
        out.extend_from_slice(b"\r\nConnection: close\r\n");
        for (name, value) in &self.headers {
            if name == "host" || is_hop_by_hop(name) || connection_named.contains(name) {
                continue;
            }
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(b": ");
            out.extend_from_slice(value);
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(b"\r\n");
        out
    }
}

async fn read_request<T>(client: &mut T, limits: &Limits) -> io::Result<RequestHead>
where
    T: AsyncRead + Unpin,
{
    let mut buffer = Vec::with_capacity(2048);
    let header_end = loop {
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            let end = index + 4;
            if end > limits.max_header_bytes {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "headers too large",
                ));
            }
            break end;
        }
        if buffer.len() >= limits.max_header_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "headers too large",
            ));
        }
        let mut chunk = [0u8; 2048];
        let read = client.read(&mut chunk).await?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "incomplete headers",
            ));
        }
        if buffer.len() + read > limits.max_header_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "headers too large",
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let mut slots = vec![httparse::EMPTY_HEADER; limits.max_headers];
    let mut parsed = httparse::Request::new(&mut slots);
    if !matches!(
        parsed.parse(&buffer[..header_end]),
        Ok(httparse::Status::Complete(_))
    ) || parsed.version != Some(1)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid HTTP/1.1 request",
        ));
    }
    let method = parsed
        .method
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))?;
    let target = parsed
        .path
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))?;
    let headers = parsed
        .headers
        .iter()
        .map(|header| (header.name.to_ascii_lowercase(), header.value.to_vec()))
        .collect::<Vec<_>>();
    validate_framing(method, &headers, &buffer[header_end..])?;
    Ok(RequestHead {
        method: method.to_owned(),
        target: target.to_owned(),
        headers,
        buffered_body: buffer[header_end..].to_vec(),
    })
}

fn validate_framing(
    method: &str,
    headers: &[(String, Vec<u8>)],
    buffered_body: &[u8],
) -> io::Result<()> {
    if headers.iter().any(|(name, _)| name == "transfer-encoding") {
        // Passing chunk framing after stripping Transfer-Encoding is corruption; retaining it
        // permits request-smuggling differences between this parser and the origin's parser.
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "transfer encoding is unsupported",
        ));
    }
    let lengths: Vec<_> = headers
        .iter()
        .filter(|(name, _)| name == "content-length")
        .collect();
    if lengths.len() > 1
        || lengths.first().is_some_and(|(_, value)| {
            std::str::from_utf8(value)
                .ok()
                .and_then(|value| value.trim().parse::<u64>().ok())
                .is_none()
        })
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "ambiguous content length",
        ));
    }
    let declared_length = lengths
        .first()
        .and_then(|(_, value)| std::str::from_utf8(value).ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    if !method.eq_ignore_ascii_case("CONNECT") && buffered_body.len() as u64 > declared_length {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bytes after the declared request body are unsupported",
        ));
    }
    let connection_named = connection_named_headers(headers);
    if connection_named.iter().any(|name| {
        matches!(
            name.as_str(),
            "content-length" | "host" | "proxy-authorization"
        )
    }) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "connection header names a protected field",
        ));
    }
    if method.eq_ignore_ascii_case("CONNECT")
        && (!buffered_body.is_empty()
            || lengths
                .first()
                .is_some_and(|(_, value)| value.as_slice() != b"0"))
    {
        // Eager tunnel bytes have no Content-Length and are allowed. An HTTP entity on CONNECT is
        // ambiguous and has no meaning in this protocol.
        if !lengths.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "CONNECT cannot carry an HTTP body",
            ));
        }
    }
    Ok(())
}

fn basic_credentials(headers: &[(String, Vec<u8>)]) -> Option<(Uuid, String)> {
    let values: Vec<_> = headers
        .iter()
        .filter(|(name, _)| name == "proxy-authorization")
        .collect();
    if values.len() != 1 {
        return None;
    }
    let raw = std::str::from_utf8(&values[0].1).ok()?;
    let encoded = raw
        .strip_prefix("Basic ")
        .or_else(|| raw.strip_prefix("basic "))?;
    let decoded = STANDARD.decode(encoded.trim()).ok()?;
    let decoded = std::str::from_utf8(&decoded).ok()?;
    let (username, password) = decoded.split_once(':')?;
    if password.is_empty() || password.contains(':') {
        return None;
    }
    Some((username.parse().ok()?, password.to_owned()))
}

fn connection_named_headers(headers: &[(String, Vec<u8>)]) -> BTreeSet<String> {
    headers
        .iter()
        .filter(|(name, _)| name == "connection" || name == "proxy-connection")
        .flat_map(|(_, value)| {
            String::from_utf8_lossy(value)
                .split(',')
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .map(|name| name.trim().to_ascii_lowercase())
        .filter(|name| !name.is_empty())
        .collect()
}

fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

pub fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_v4(address),
        IpAddr::V6(address) => address
            .to_ipv4_mapped()
            .map_or_else(|| is_public_v6(address), is_public_v4),
    }
}

fn is_public_v4(address: Ipv4Addr) -> bool {
    let [a, b, c, d] = address.octets();
    // 192.0.0.0/24 is special-purpose except for the two globally reachable anycast addresses.
    // The old `(192, 0)` match denied the entire 192.0.0.0/16, including ordinary public space.
    if (a, b, c) == (192, 0, 0) {
        return matches!(d, 9 | 10);
    }
    !matches!(
        (a, b),
        (0, _)
            | (10, _)
            | (100, 64..=127)
            | (127, _)
            | (169, 254)
            | (172, 16..=31)
            | (192, 168)
            | (198, 18..=19)
            | (224..=255, _)
    ) && !address.is_documentation()
        && (a, b, c) != (192, 88, 99)
}

fn is_public_v6(address: Ipv6Addr) -> bool {
    // Follow IANA's Globally Reachable column. Most public unicast is 2000::/3; the exceptions
    // below are special-purpose ranges that are not globally reachable, with IANA's more-specific
    // globally reachable allocations admitted again. NAT64's well-known prefix is the one public
    // allocation outside 2000::/3 in the current registry.
    if in_v6_prefix(address, "64:ff9b::".parse().unwrap(), 96) {
        return true;
    }
    if !in_v6_prefix(address, "2000::".parse().unwrap(), 3) {
        return false;
    }
    if in_v6_prefix(address, "2002::".parse().unwrap(), 16)
        || in_v6_prefix(address, "2001:db8::".parse().unwrap(), 32)
        || in_v6_prefix(address, "3fff::".parse().unwrap(), 20)
    {
        return false;
    }
    if !in_v6_prefix(address, "2001::".parse().unwrap(), 23) {
        return true;
    }

    matches!(
        address,
        address if address == "2001:1::1".parse::<Ipv6Addr>().unwrap()
            || address == "2001:1::2".parse::<Ipv6Addr>().unwrap()
            || address == "2001:1::3".parse::<Ipv6Addr>().unwrap()
    ) || in_v6_prefix(address, "2001:3::".parse().unwrap(), 32)
        || in_v6_prefix(address, "2001:4:112::".parse().unwrap(), 48)
        || in_v6_prefix(address, "2001:20::".parse().unwrap(), 28)
        || in_v6_prefix(address, "2001:30::".parse().unwrap(), 28)
}

fn in_v6_prefix(address: Ipv6Addr, network: Ipv6Addr, prefix: u32) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - prefix)
    };
    u128::from(address) & mask == u128::from(network) & mask
}

enum ResponseKind {
    BadRequest,
    ProxyAuthRequired,
    DestinationForbidden,
    BadGateway,
    ServiceUnavailable,
}

async fn respond<T>(client: &mut T, kind: ResponseKind) -> io::Result<()>
where
    T: AsyncWrite + Unpin,
{
    let response: &[u8] = match kind {
        ResponseKind::BadRequest => {
            b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
        }
        ResponseKind::ProxyAuthRequired => b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"sandbox\"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        ResponseKind::DestinationForbidden => {
            b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
        }
        ResponseKind::BadGateway => {
            b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
        }
        ResponseKind::ServiceUnavailable => {
            b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
        }
    };
    client.write_all(response).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::sync::Mutex;
    use tokio::io::DuplexStream;

    const SANDBOX: &str = "01930000-0000-7000-8000-000000000001";
    const ROOT: [u8; 32] = [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
        25, 26, 27, 28, 29, 30, 31,
    ];

    struct StaticAuthorizer {
        result: Result<Option<SandboxAuthorization>, AuthzError>,
    }

    #[async_trait]
    impl Authorizer for StaticAuthorizer {
        async fn lookup(&self, _: Uuid) -> Result<Option<SandboxAuthorization>, AuthzError> {
            self.result.clone()
        }
    }

    struct StaticResolver(Vec<IpAddr>);

    #[async_trait]
    impl Resolver for StaticResolver {
        async fn resolve(&self, _: &str, _: u16) -> io::Result<Vec<IpAddr>> {
            Ok(self.0.clone())
        }
    }

    #[derive(Default)]
    struct RecordingMeter(Arc<Mutex<Vec<EgressObservation>>>);

    impl EgressMeter for RecordingMeter {
        fn reserve(&self) -> Result<Box<dyn EgressReservation>, MeteringCapacityError> {
            Ok(Box::new(RecordingReservation(Arc::clone(&self.0))))
        }
    }

    struct RecordingReservation(Arc<Mutex<Vec<EgressObservation>>>);

    impl EgressReservation for RecordingReservation {
        fn commit(self: Box<Self>, observation: EgressObservation) {
            self.0.lock().unwrap().push(observation);
        }
    }

    struct FullMeter;

    impl EgressMeter for FullMeter {
        fn reserve(&self) -> Result<Box<dyn EgressReservation>, MeteringCapacityError> {
            Err(MeteringCapacityError)
        }
    }

    struct RecordingDialer {
        addresses: Arc<Mutex<Vec<SocketAddr>>>,
        peer: Mutex<Option<DuplexStream>>,
    }

    #[async_trait]
    impl Dialer for RecordingDialer {
        async fn connect(&self, address: SocketAddr) -> io::Result<Box<dyn ProxyIo>> {
            self.addresses.lock().unwrap().push(address);
            Ok(Box::new(self.peer.lock().unwrap().take().unwrap()))
        }
    }

    struct StallingFirstDialer {
        addresses: Arc<Mutex<Vec<SocketAddr>>>,
        peer: Mutex<Option<DuplexStream>>,
    }

    #[async_trait]
    impl Dialer for StallingFirstDialer {
        async fn connect(&self, address: SocketAddr) -> io::Result<Box<dyn ProxyIo>> {
            let is_first = address.ip() == "1.1.1.1".parse::<IpAddr>().unwrap();
            self.addresses.lock().unwrap().push(address);
            if is_first {
                return std::future::pending().await;
            }
            Ok(Box::new(self.peer.lock().unwrap().take().unwrap()))
        }
    }

    fn authorization(state: SandboxState) -> SandboxAuthorization {
        SandboxAuthorization {
            sandbox_id: SANDBOX.parse().unwrap(),
            organization_id: Uuid::from_u128(2),
            project_id: Uuid::from_u128(3),
            state,
        }
    }

    fn make_proxy(
        root: &[u8],
        auth: Result<Option<SandboxAuthorization>, AuthzError>,
        addresses: Vec<IpAddr>,
    ) -> (
        SandboxForwardProxy,
        Arc<Mutex<Vec<SocketAddr>>>,
        DuplexStream,
    ) {
        let (upstream, peer) = tokio::io::duplex(16 * 1024);
        let dialed = Arc::new(Mutex::new(Vec::new()));
        let dialer = RecordingDialer {
            addresses: Arc::clone(&dialed),
            peer: Mutex::new(Some(upstream)),
        };
        (
            SandboxForwardProxy::new(
                root,
                Arc::new(StaticAuthorizer { result: auth }),
                Arc::new(StaticResolver(addresses)),
                Arc::new(dialer),
                Limits {
                    tunnel_timeout: Duration::from_millis(100),
                    ..Limits::default()
                },
            )
            .unwrap(),
            dialed,
            peer,
        )
    }

    fn request(root: &[u8], target: &str, extra: &str) -> String {
        let password = derive_password(root, SANDBOX.parse().unwrap());
        let basic = STANDARD.encode(format!("{SANDBOX}:{password}"));
        format!(
            "GET {target} HTTP/1.1\r\nHost: ignored.invalid\r\nProxy-Authorization: Basic {basic}\r\n{extra}\r\n"
        )
    }

    async fn exchange(proxy: SandboxForwardProxy, request: &[u8]) -> Vec<u8> {
        let (mut client, server) = tokio::io::duplex(64 * 1024);
        let task = tokio::spawn(async move { proxy.serve_connection(server).await });
        client.write_all(request).await.unwrap();
        client.shutdown().await.unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        task.await.unwrap().unwrap();
        response
    }

    #[test]
    fn credential_vectors_are_shared_with_the_control_plane() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fixture {
            domain_separator: String,
            root_key_base64: String,
            vectors: Vec<Vector>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Vector {
            sandbox_id: Uuid,
            password: String,
        }
        let fixture: Fixture =
            serde_json::from_str(include_str!("../fixtures/credentials.json")).unwrap();
        assert_eq!(fixture.domain_separator, DOMAIN_SEPARATOR);
        let root = STANDARD.decode(fixture.root_key_base64).unwrap();
        for vector in fixture.vectors {
            assert_eq!(derive_password(&root, vector.sandbox_id), vector.password);
        }
    }

    #[test]
    fn public_address_policy_tracks_iana_global_reachability() {
        for denied in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "192.0.0.8",
            "192.0.0.170",
            "192.0.2.1",
            "192.88.99.2",
            "198.18.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "64:ff9b:1::1",
            "100::1",
            "2001::1",
            "2001:2::1",
            "2001:10::1",
            "2001:db8::1",
            "2002::1",
            "3fff::1",
            "5f00::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!is_public_ip(denied.parse().unwrap()), "allowed {denied}");
        }
        for allowed in [
            "1.1.1.1",
            "8.8.8.8",
            "192.0.0.9",
            "192.0.0.10",
            "192.0.1.1",
            "192.31.196.1",
            "192.52.193.1",
            "192.175.48.1",
            "64:ff9b::1",
            "2001:1::1",
            "2001:3::1",
            "2001:4:112::1",
            "2001:20::1",
            "2001:30::1",
            "2606:4700:4700::1111",
            "::ffff:8.8.8.8",
        ] {
            assert!(is_public_ip(allowed.parse().unwrap()), "denied {allowed}");
        }
    }

    #[tokio::test]
    async fn a_stalled_first_public_dns_answer_does_not_block_the_next() {
        let root = &ROOT;
        let (upstream, mut peer) = tokio::io::duplex(16 * 1024);
        let dialed = Arc::new(Mutex::new(Vec::new()));
        let proxy = SandboxForwardProxy::new(
            root,
            Arc::new(StaticAuthorizer {
                result: Ok(Some(authorization(SandboxState::Running))),
            }),
            Arc::new(StaticResolver(vec![
                "1.1.1.1".parse().unwrap(),
                "8.8.8.8".parse().unwrap(),
            ])),
            Arc::new(StallingFirstDialer {
                addresses: Arc::clone(&dialed),
                peer: Mutex::new(Some(upstream)),
            }),
            Limits {
                connect_timeout: Duration::from_millis(500),
                ..Limits::default()
            },
        )
        .unwrap();

        let (mut client, server) = tokio::io::duplex(64 * 1024);
        let task = tokio::spawn(async move { proxy.serve_connection(server).await });
        client
            .write_all(request(root, "http://example.com/", "").as_bytes())
            .await
            .unwrap();
        let mut forwarded = vec![0; 4096];
        let read = timeout(Duration::from_millis(250), peer.read(&mut forwarded))
            .await
            .expect("the second public address was never tried")
            .unwrap();
        assert!(String::from_utf8_lossy(&forwarded[..read]).starts_with("GET / HTTP/1.1"));
        peer.write_all(
            b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
        peer.shutdown().await.unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        task.await.unwrap().unwrap();
        assert!(response.starts_with(b"HTTP/1.1 204"));
        let dialed = dialed
            .lock()
            .unwrap()
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        assert_eq!(
            dialed,
            BTreeSet::from(["1.1.1.1:80".parse().unwrap(), "8.8.8.8:80".parse().unwrap(),])
        );
    }

    #[tokio::test]
    async fn every_authentication_failure_is_the_same_407() {
        let root = &ROOT;
        let cases = [
            (None, SandboxState::Running),
            (
                Some(authorization(SandboxState::Stopped)),
                SandboxState::Stopped,
            ),
        ];
        let mut responses = Vec::new();
        for (auth, _) in cases {
            let (proxy, _, _) = make_proxy(root, Ok(auth), vec!["1.1.1.1".parse().unwrap()]);
            responses
                .push(exchange(proxy, request(root, "http://example.com/", "").as_bytes()).await);
        }
        let (proxy, _, _) = make_proxy(root, Err(AuthzError), vec!["1.1.1.1".parse().unwrap()]);
        responses.push(exchange(proxy, request(root, "http://example.com/", "").as_bytes()).await);
        let (proxy, _, _) = make_proxy(
            root,
            Ok(Some(authorization(SandboxState::Running))),
            vec!["1.1.1.1".parse().unwrap()],
        );
        responses.push(
            exchange(
                proxy,
                b"GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n",
            )
            .await,
        );
        let wrong = STANDARD.encode(format!("{SANDBOX}:wrong-password"));
        let request = format!(
            "GET http://example.com/ HTTP/1.1\r\nProxy-Authorization: Basic {wrong}\r\n\r\n"
        );
        let (proxy, _, _) = make_proxy(
            root,
            Ok(Some(authorization(SandboxState::Running))),
            vec!["1.1.1.1".parse().unwrap()],
        );
        responses.push(exchange(proxy, request.as_bytes()).await);
        assert!(responses.windows(2).all(|pair| pair[0] == pair[1]));
        assert!(responses[0].starts_with(b"HTTP/1.1 407"));
    }

    #[tokio::test]
    async fn a_full_metering_spool_refuses_traffic_before_dialing() {
        let root = &ROOT;
        let (proxy, dialed, _) = make_proxy(
            root,
            Ok(Some(authorization(SandboxState::Running))),
            vec!["1.1.1.1".parse().unwrap()],
        );
        let response = exchange(
            proxy.with_meter(Arc::new(FullMeter)),
            request(root, "http://example.com/", "").as_bytes(),
        )
        .await;
        assert!(response.starts_with(b"HTTP/1.1 503"));
        assert!(dialed.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn absolute_form_is_rewritten_and_proxy_headers_are_stripped() {
        let root = &ROOT;
        let (proxy, dialed, mut upstream) = make_proxy(
            root,
            Ok(Some(authorization(SandboxState::Running))),
            vec!["1.1.1.1".parse().unwrap()],
        );
        let meter = Arc::new(RecordingMeter::default());
        let proxy = proxy.with_meter(meter.clone());
        let (mut client, server) = tokio::io::duplex(64 * 1024);
        let task = tokio::spawn(async move { proxy.serve_connection(server).await });
        client
            .write_all(
                request(
                    root,
                    "http://example.com/private?q=secret",
                    "Connection: x-remove\r\nX-Remove: secret\r\nX-Keep: yes\r\n",
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut forwarded = vec![0; 4096];
        let read = upstream.read(&mut forwarded).await.unwrap();
        let forwarded_bytes = forwarded[..read].to_vec();
        let forwarded = String::from_utf8_lossy(&forwarded_bytes);
        assert!(forwarded.starts_with("GET /private?q=secret HTTP/1.1\r\nHost: example.com\r\n"));
        assert!(forwarded.contains("x-keep: yes\r\n"));
        assert!(!forwarded.contains("proxy-authorization"));
        assert!(!forwarded.contains("x-remove"));
        let upstream_response =
            b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        upstream.write_all(upstream_response).await.unwrap();
        upstream.shutdown().await.unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        task.await.unwrap().unwrap();
        assert!(response.starts_with(b"HTTP/1.1 204"));
        assert_eq!(*dialed.lock().unwrap(), vec!["1.1.1.1:80".parse().unwrap()]);
        let observations = meter.0.lock().unwrap();
        assert_eq!(observations.len(), 1);
        assert_eq!(
            observations[0].authorization,
            authorization(SandboxState::Running)
        );
        assert_eq!(observations[0].request_bytes, forwarded_bytes.len() as u64);
        assert_eq!(
            observations[0].response_bytes,
            upstream_response.len() as u64
        );
        assert_eq!(
            observations[0].total_bytes(),
            (forwarded_bytes.len() + upstream_response.len()) as u64
        );
        assert_eq!(observations[0].protocol, "http");
    }

    #[tokio::test]
    async fn connect_allows_https_and_postgres_and_tunnels_after_resolution() {
        let root = &ROOT;
        let (proxy, dialed, mut upstream) = make_proxy(
            root,
            Ok(Some(authorization(SandboxState::Running))),
            vec!["8.8.8.8".parse().unwrap()],
        );
        let password = derive_password(root, SANDBOX.parse().unwrap());
        let basic = STANDARD.encode(format!("{SANDBOX}:{password}"));
        let request = format!(
            "CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: Basic {basic}\r\n\r\neager hello"
        );
        let meter = Arc::new(RecordingMeter::default());
        let proxy = proxy.with_meter(meter.clone());
        let (mut client, server) = tokio::io::duplex(4096);
        let task = tokio::spawn(async move { proxy.serve_connection(server).await });
        client.write_all(request.as_bytes()).await.unwrap();
        let mut established = [0; 39];
        client.read_exact(&mut established).await.unwrap();
        assert_eq!(&established, b"HTTP/1.1 200 Connection Established\r\n\r\n");
        let mut eager = [0; 11];
        upstream.read_exact(&mut eager).await.unwrap();
        assert_eq!(&eager, b"eager hello");
        client.write_all(b"tunnel bytes").await.unwrap();
        let mut tunneled = [0; 12];
        upstream.read_exact(&mut tunneled).await.unwrap();
        assert_eq!(&tunneled, b"tunnel bytes");
        upstream.write_all(b"upstream reply").await.unwrap();
        let mut reply = [0; 14];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(&reply, b"upstream reply");
        drop(client);
        drop(upstream);
        task.await.unwrap().unwrap();
        assert_eq!(
            *dialed.lock().unwrap(),
            vec!["8.8.8.8:443".parse().unwrap()]
        );
        {
            let observations = meter.0.lock().unwrap();
            assert_eq!(observations.len(), 1);
            assert_eq!(observations[0].request_bytes, 23);
            assert_eq!(observations[0].response_bytes, 14);
            assert_eq!(observations[0].protocol, "connect");
        }

        let (proxy, _, _) = make_proxy(
            root,
            Ok(Some(authorization(SandboxState::Running))),
            vec!["8.8.8.8".parse().unwrap()],
        );
        let bad = request.replace(":443", ":80");
        assert!(
            exchange(proxy, bad.as_bytes())
                .await
                .starts_with(b"HTTP/1.1 400")
        );

        let (proxy, dialed, mut upstream) = make_proxy(
            root,
            Ok(Some(authorization(SandboxState::Running))),
            vec!["8.8.4.4".parse().unwrap()],
        );
        let postgres = request.replace("example.com:443", "database.example:5432");
        let (mut client, server) = tokio::io::duplex(4096);
        let task = tokio::spawn(async move { proxy.serve_connection(server).await });
        client.write_all(postgres.as_bytes()).await.unwrap();
        client.read_exact(&mut established).await.unwrap();
        assert_eq!(&established, b"HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.read_exact(&mut eager).await.unwrap();
        assert_eq!(&eager, b"eager hello");
        drop(client);
        drop(upstream);
        task.await.unwrap().unwrap();
        assert_eq!(
            *dialed.lock().unwrap(),
            vec!["8.8.4.4:5432".parse().unwrap()]
        );
    }

    #[tokio::test]
    async fn exact_platform_postgres_authority_can_use_a_loopback_override() {
        let root = &ROOT;
        let (proxy, dialed, mut upstream) = make_proxy(
            root,
            Ok(Some(authorization(SandboxState::Running))),
            vec!["8.8.8.8".parse().unwrap()],
        );
        let proxy = proxy.with_connect_override(
            "postgres.sproutos.me",
            5432,
            "127.0.0.1:15432".parse().unwrap(),
        );
        let meter = Arc::new(RecordingMeter::default());
        let proxy = proxy.with_meter(meter.clone());
        let password = derive_password(root, SANDBOX.parse().unwrap());
        let basic = STANDARD.encode(format!("{SANDBOX}:{password}"));
        let request = format!(
            "CONNECT POSTGRES.SPROUTOS.ME.:5432 HTTP/1.1\r\nProxy-Authorization: Basic {basic}\r\n\r\n"
        );
        let (mut client, server) = tokio::io::duplex(4096);
        let task = tokio::spawn(async move { proxy.serve_connection(server).await });
        client.write_all(request.as_bytes()).await.unwrap();
        let mut established = [0; 39];
        client.read_exact(&mut established).await.unwrap();
        assert_eq!(&established, b"HTTP/1.1 200 Connection Established\r\n\r\n");
        client.write_all(b"postgres startup").await.unwrap();
        let mut tunneled = [0; 16];
        upstream.read_exact(&mut tunneled).await.unwrap();
        assert_eq!(&tunneled, b"postgres startup");
        upstream.write_all(b"postgres response").await.unwrap();
        let mut response = [0; 17];
        client.read_exact(&mut response).await.unwrap();
        assert_eq!(&response, b"postgres response");
        drop(client);
        drop(upstream);
        task.await.unwrap().unwrap();
        assert_eq!(
            *dialed.lock().unwrap(),
            vec!["127.0.0.1:15432".parse().unwrap()]
        );
        let observations = meter.0.lock().unwrap();
        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0].request_bytes, 0);
        assert_eq!(observations[0].response_bytes, 17);
    }

    #[tokio::test]
    async fn ambiguous_framing_is_rejected_before_dialing() {
        let root = &ROOT;
        for extra in [
            "Transfer-Encoding: chunked\r\n",
            "Content-Length: 0\r\nContent-Length: 1\r\n",
            "Content-Length: no\r\n",
            "Connection: content-length\r\nContent-Length: 0\r\n",
        ] {
            let (proxy, dialed, _) = make_proxy(
                root,
                Ok(Some(authorization(SandboxState::Running))),
                vec!["1.1.1.1".parse().unwrap()],
            );
            let response = exchange(
                proxy,
                request(root, "http://example.com/", extra).as_bytes(),
            )
            .await;
            assert!(response.starts_with(b"HTTP/1.1 400"), "accepted {extra:?}");
            assert!(dialed.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn any_private_dns_answer_prevents_dialing() {
        let root = &ROOT;
        let (proxy, dialed, _) = make_proxy(
            root,
            Ok(Some(authorization(SandboxState::Running))),
            vec!["1.1.1.1".parse().unwrap(), "10.0.0.1".parse().unwrap()],
        );
        let response = exchange(proxy, request(root, "http://example.com/", "").as_bytes()).await;
        assert!(response.starts_with(b"HTTP/1.1 403"));
        assert!(dialed.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn oversized_headers_are_rejected_before_auth_or_dns() {
        let root = &ROOT;
        let (mut proxy, dialed, _) = make_proxy(
            root,
            Ok(Some(authorization(SandboxState::Running))),
            vec!["1.1.1.1".parse().unwrap()],
        );
        proxy.limits.max_header_bytes = 128;
        let response = exchange(
            proxy,
            request(
                root,
                "http://example.com/",
                &format!("X: {}\r\n", "a".repeat(200)),
            )
            .as_bytes(),
        )
        .await;
        assert!(response.starts_with(b"HTTP/1.1 400"));
        assert!(dialed.lock().unwrap().is_empty());
    }
}
