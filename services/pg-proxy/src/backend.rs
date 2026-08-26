//! The client half: this proxy talking to the real Postgres.
//!
//! It connects as an administrative role, because reaching an arbitrary tenant's database requires
//! one, and then immediately gives that privilege away with `SET ROLE`. The window between those
//! two facts is the whole risk in this file, and it is why `SET ROLE` happens here rather than being
//! left to the tenant's first statement — a session that reached the splice still administrative
//! would let one customer read every other customer's tables.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};

use rustls_pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};

use crate::{BackendConfig, SessionError};

/// `SSLRequest`: the eight bytes that ask a Postgres server to start TLS.
///
/// Postgres does not wrap its protocol in TLS — it negotiates *inside* it. The client sends this
/// instead of a startup packet and the server answers one byte: `S` to proceed with a handshake,
/// `N` to carry on in the clear. Which is also why no load balancer can terminate TLS in front of
/// Postgres: there is nothing at the front of the connection to terminate.
const SSL_REQUEST_CODE: i32 = 80_877_103;

/// The backend socket, which is either a plain one or a TLS session over it.
///
/// An enum rather than a boxed trait object: every byte a tenant sends crosses this, and a vtable
/// hop per poll is not worth the lines it saves. The same shape `valkey-proxy` uses upstream.
#[derive(Debug)]
pub enum Stream {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(stream) => Pin::new(stream).poll_read(cx, buf),
            Stream::Tls(stream) => Pin::new(stream.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Stream::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
            Stream::Tls(stream) => Pin::new(stream.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(stream) => Pin::new(stream).poll_flush(cx),
            Stream::Tls(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            Stream::Tls(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
        }
    }
}

/// Built once. Assembling a root store per connection would parse the whole bundle each time.
fn connector() -> TlsConnector {
    static CONNECTOR: std::sync::OnceLock<TlsConnector> = std::sync::OnceLock::new();

    CONNECTOR
        .get_or_init(|| {
            // Webpki's bundled roots: the image carries no system certificate store, and managed
            // Postgres chains to public roots.
            let roots = RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            };
            TlsConnector::from(Arc::new(
                ClientConfig::builder()
                    .with_root_certificates(roots)
                    .with_no_client_auth(),
            ))
        })
        .clone()
}

/// Ask for TLS, and upgrade if the server agrees.
async fn negotiate_tls(
    mut server: TcpStream,
    backend: &BackendConfig,
) -> Result<Stream, SessionError> {
    let mut request = Vec::with_capacity(8);
    request.extend_from_slice(&8_i32.to_be_bytes());
    request.extend_from_slice(&SSL_REQUEST_CODE.to_be_bytes());
    server.write_all(&request).await?;
    server.flush().await?;

    let mut answer = [0u8; 1];
    server.read_exact(&mut answer).await?;

    match answer[0] {
        b'S' => {
            let name = ServerName::try_from(backend.host.clone()).map_err(|_| {
                SessionError::Backend(format!("{} is not a valid TLS server name", backend.host))
            })?;
            let session = connector().connect(name, server).await.map_err(|error| {
                SessionError::Backend(format!("the TLS handshake failed: {error}"))
            })?;
            Ok(Stream::Tls(Box::new(session)))
        }
        /*
          The server declined. Acceptable only where the configuration says so.

          Refusing loudly rather than continuing is the point: a backend that will not do TLS and a
          configuration that requires it is a misconfiguration, and the alternative is a tenant's
          rows crossing the internet in the clear while everything reports healthy.
        */
        b'N' if !backend.require_tls => Ok(Stream::Plain(server)),
        b'N' => Err(SessionError::Backend(
            "the backend refused TLS and this connection requires it".to_owned(),
        )),
        other => Err(SessionError::Backend(format!(
            "the backend answered SSLRequest with {other:#x}, which is not S or N"
        ))),
    }
}

/// Read the backend's address and credentials from the environment.
pub fn backend_config_from_env() -> Result<BackendConfig, SessionError> {
    let host = std::env::var("PG_PROXY_BACKEND_HOST").unwrap_or_else(|_| "127.0.0.1".to_owned());
    let port = std::env::var("PG_PROXY_BACKEND_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5432);
    let user = std::env::var("PG_PROXY_BACKEND_USER").unwrap_or_else(|_| "postgres".to_owned());
    let password = std::env::var("PG_PROXY_BACKEND_PASSWORD")
        .map_err(|_| SessionError::Backend("PG_PROXY_BACKEND_PASSWORD is not set".to_owned()))?;

    Ok(BackendConfig {
        host,
        port,
        user,
        password,
        /*
          Off by default for the *configured* cluster, unlike a resolved one.

          The shared cluster in development is the compose Postgres on loopback, which has no
          certificate. A deployment whose shared cluster is remote sets this, and then a backend
          that declines TLS fails the session rather than quietly carrying rows in the clear.
        */
        require_tls: std::env::var("PG_PROXY_BACKEND_REQUIRE_TLS")
            .is_ok_and(|value| value == "1" || value.eq_ignore_ascii_case("true")),
    })
}

/// A backend session, plus the handshake the client still needs to see.
pub struct Backend {
    pub stream: Stream,
    /// `ParameterStatus` as the backend sent it.
    ///
    /// **Not** `BackendKeyData` — that is replaced, see `key`.
    ///
    /// The client is mid-handshake and expects these after `AuthenticationOk`. They were consumed
    /// here while waiting for the backend's `ReadyForQuery`, so they have to be handed on rather
    /// than dropped — a client that gets `AuthenticationOk` and then silence waits forever, which
    /// is exactly what the first version of this did.
    ///
    /// The values are the backend's own: `server_version`, `client_encoding`, `TimeZone`. Inventing
    /// them would mean a client's `SHOW server_version` disagreeing with the server it is talking
    /// to.
    pub handshake: Vec<u8>,

    /// The backend's cancellation pair, held so a `CancelRequest` can be routed to it.
    ///
    /// `None` when the backend sent no `BackendKeyData`, which is legal — cancellation is optional —
    /// and means this session simply cannot be cancelled.
    pub key: Option<crate::cancel::BackendKey>,
}

/// Connect, authenticate, and drop to the tenant's role.
pub async fn connect(
    backend: &BackendConfig,
    database: &str,
    role: &str,
) -> Result<Backend, SessionError> {
    let socket = TcpStream::connect((backend.host.as_str(), backend.port))
        .await
        .map_err(|error| SessionError::Backend(format!("could not reach the cluster: {error}")))?;
    // The tenant's queries are request/response; a delayed ACK on a small packet is latency added
    // to every one of them.
    let _ = socket.set_nodelay(true);

    // Before the startup packet, because that is where Postgres puts the negotiation.
    let mut server = negotiate_tls(socket, backend).await?;

    send_startup(&mut server, &backend.user, database).await?;
    let (handshake, key) = complete_authentication(&mut server, &backend.password).await?;
    set_role(&mut server, role).await?;

    Ok(Backend {
        stream: server,
        handshake,
        key,
    })
}

async fn send_startup(server: &mut Stream, user: &str, database: &str) -> Result<(), SessionError> {
    let mut body = Vec::new();
    body.extend_from_slice(&crate::protocol::PROTOCOL_3_0.to_be_bytes());

    for (key, value) in [
        ("user", user),
        ("database", database),
        // Named so a `pg_stat_activity` row says which process opened the session. On a shared
        // cluster with a connection problem, that is the first column anyone looks at.
        ("application_name", "sproutos-pg-proxy"),
    ] {
        body.extend_from_slice(key.as_bytes());
        body.push(0);
        body.extend_from_slice(value.as_bytes());
        body.push(0);
    }
    body.push(0);

    // Length counts itself, which is the off-by-four this protocol invites.
    let length = i32::try_from(body.len() + 4).unwrap_or(i32::MAX);
    server.write_all(&length.to_be_bytes()).await?;
    server.write_all(&body).await?;
    server.flush().await?;

    Ok(())
}

/// Answer whatever the backend asks for, until it says `ReadyForQuery`.
///
/// Handles trust (`AuthenticationOk` straight away), cleartext, and MD5. **Not SCRAM**, which is
/// Postgres's default since 14 and is therefore the case a real deployment hits — it is a
/// multi-round exchange with channel binding, and doing it badly is worse than not doing it. The
/// README says so; this is the honest edge of what is implemented.
type Handshake = (Vec<u8>, Option<crate::cancel::BackendKey>);

async fn complete_authentication(
    server: &mut Stream,
    password: &str,
) -> Result<Handshake, SessionError> {
    // Everything the client will need to be told, kept in the bytes the backend used to say it.
    let mut handshake = Vec::new();
    let mut key = None;

    loop {
        let mut tag = [0u8; 1];
        server
            .read_exact(&mut tag)
            .await
            .map_err(|_| SessionError::Backend("the cluster closed the connection".to_owned()))?;

        let mut length_bytes = [0u8; 4];
        server.read_exact(&mut length_bytes).await?;
        let length = i32::from_be_bytes(length_bytes);
        let remaining = usize::try_from(length).unwrap_or(0).saturating_sub(4);

        let mut body = vec![0u8; remaining];
        server.read_exact(&mut body).await?;

        match tag[0] {
            b'R' => {
                let kind = i32::from_be_bytes([body[0], body[1], body[2], body[3]]);
                match kind {
                    0 => {} // AuthenticationOk. Keep reading until ReadyForQuery.
                    3 => send_password(server, password).await?,
                    5 => {
                        let salt = [body[4], body[5], body[6], body[7]];
                        // The username is empty because the proxy's backend user is already in the startup
                        // packet; Postgres hashes against what it recorded there.
                        let hashed = md5_password("", password, salt);
                        send_password(server, &hashed).await?;
                    }
                    // AuthenticationSASL: the mechanisms the server offers, null-separated.
                    // Postgres has defaulted to this since 14, so it is the ordinary case rather
                    // than an exotic one.
                    10 => {
                        scram_exchange(server, password, &body[4..]).await?;
                    }
                    other => {
                        return Err(SessionError::Backend(format!(
                            "unsupported authentication method {other}"
                        )));
                    }
                }
            }
            // ReadyForQuery: the session is usable. Not forwarded from here — one is sent to the
            // client after `SET ROLE`, so the client's first query starts from a clean state.
            b'Z' => return Ok((handshake, key)),
            b'E' => {
                return Err(SessionError::Backend(error_message(&body)));
            }
            // `ParameterStatus` is the client's to receive, verbatim.
            b'S' => {
                handshake.push(tag[0]);
                handshake.extend_from_slice(&length_bytes);
                handshake.extend_from_slice(&body);
            }
            /*
                `BackendKeyData` is captured, not forwarded.

                The pair identifies a session on the *backend*, and a cancel arrives at the *proxy* —
                so a client holding the backend's pair holds a key it can only send somewhere that
                cannot act on it. The proxy issues its own pair instead and keeps this one to replay.
            */
            b'K' => {
                key = crate::cancel::parse_backend_key(&body);
            }
            // NoticeResponse and anything else: the client did not ask and does not need it.
            _ => {}
        }
    }
}

/// Run SCRAM-SHA-256 to completion.
///
/// Kept in one function because the exchange is a sequence, not a state machine: every step's input
/// is the previous step's output, and splitting it across the outer message loop would mean holding
/// the half-finished exchange in a variable that is meaningless the rest of the time.
async fn scram_exchange(
    server: &mut Stream,
    password: &str,
    mechanisms: &[u8],
) -> Result<(), SessionError> {
    let offered = String::from_utf8_lossy(mechanisms);
    if !offered.contains("SCRAM-SHA-256") {
        return Err(SessionError::Backend(format!(
            "the cluster offers only {offered}, and this proxy speaks SCRAM-SHA-256"
        )));
    }
    // `SCRAM-SHA-256-PLUS` is deliberately not selected even when offered: it binds the exchange to
    // the TLS channel, and this hop has no TLS to bind to. Choosing it would mean sending a channel
    // binding we cannot compute.

    let nonce = generate_nonce();
    // Empty username: Postgres takes it from the startup packet and ignores this field.
    let (first, first_message) = crate::scram::client_first("", &nonce);

    send_sasl_initial(server, "SCRAM-SHA-256", &first_message).await?;

    // AuthenticationSASLContinue.
    let server_first = read_auth_payload(server, 11).await?;
    let parsed = crate::scram::parse_server_first(&server_first)
        .map_err(|error| SessionError::Backend(error.to_string()))?;

    let final_message = crate::scram::client_final(&first, &parsed, &server_first, password)
        .map_err(|error| SessionError::Backend(error.to_string()))?;

    send_sasl_response(server, &final_message.message).await?;

    // AuthenticationSASLFinal. Verifying it is what makes SCRAM mutual: skipping the check would
    // complete an exchange with something that does not know the password.
    let server_final = read_auth_payload(server, 12).await?;
    crate::scram::verify_server_final(&server_final, &final_message.server_signature)
        .map_err(|error| SessionError::Backend(error.to_string()))?;

    Ok(())
}

/// 18 bytes of randomness, base64'd — the length libpq uses.
fn generate_nonce() -> String {
    use base64::Engine as _;
    let mut bytes = [0u8; 18];
    getrandom(&mut bytes);
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn getrandom(buffer: &mut [u8]) {
    // `rand` is already in the workspace for the other services. Using the OS source rather than a
    // seeded PRNG matters here: a predictable client nonce lets a server replay an exchange.
    use rand::RngCore as _;
    rand::rngs::OsRng.fill_bytes(buffer);
}

/// Read one `R` message and return its payload, asserting the auth type.
///
/// Asserted rather than assumed: an `ErrorResponse` here is a wrong password, and reading it as a
/// SASL payload would produce a parse error that says nothing about what happened.
async fn read_auth_payload(server: &mut Stream, expected: i32) -> Result<String, SessionError> {
    let mut tag = [0u8; 1];
    server.read_exact(&mut tag).await?;

    let mut length_bytes = [0u8; 4];
    server.read_exact(&mut length_bytes).await?;
    let remaining = usize::try_from(i32::from_be_bytes(length_bytes))
        .unwrap_or(0)
        .saturating_sub(4);

    let mut body = vec![0u8; remaining];
    server.read_exact(&mut body).await?;

    if tag[0] == b'E' {
        return Err(SessionError::Backend(error_message(&body)));
    }
    if tag[0] != b'R' {
        return Err(SessionError::Backend(format!(
            "expected an authentication message, got `{}`",
            char::from(tag[0])
        )));
    }

    let kind = i32::from_be_bytes([body[0], body[1], body[2], body[3]]);
    if kind != expected {
        return Err(SessionError::Backend(format!(
            "expected authentication message {expected}, got {kind}"
        )));
    }

    Ok(String::from_utf8_lossy(&body[4..]).into_owned())
}

async fn send_sasl_initial(
    server: &mut Stream,
    mechanism: &str,
    message: &str,
) -> Result<(), SessionError> {
    // mechanism + NUL + int32 length + the message itself.
    let length = i32::try_from(4 + mechanism.len() + 1 + 4 + message.len()).unwrap_or(i32::MAX);

    server.write_all(b"p").await?;
    server.write_all(&length.to_be_bytes()).await?;
    server.write_all(mechanism.as_bytes()).await?;
    server.write_all(&[0]).await?;
    server
        .write_all(
            &i32::try_from(message.len())
                .unwrap_or(i32::MAX)
                .to_be_bytes(),
        )
        .await?;
    server.write_all(message.as_bytes()).await?;
    server.flush().await?;
    Ok(())
}

async fn send_sasl_response(server: &mut Stream, message: &str) -> Result<(), SessionError> {
    // No null terminator and no inner length: a SASLResponse is the raw payload.
    let length = i32::try_from(4 + message.len()).unwrap_or(i32::MAX);
    server.write_all(b"p").await?;
    server.write_all(&length.to_be_bytes()).await?;
    server.write_all(message.as_bytes()).await?;
    server.flush().await?;
    Ok(())
}

async fn send_password(server: &mut Stream, password: &str) -> Result<(), SessionError> {
    let length = i32::try_from(password.len() + 5).unwrap_or(i32::MAX);
    server.write_all(b"p").await?;
    server.write_all(&length.to_be_bytes()).await?;
    server.write_all(password.as_bytes()).await?;
    server.write_all(&[0]).await?;
    server.flush().await?;
    Ok(())
}

/// `md5(md5(password + username) + salt)`, hex, prefixed `md5`.
///
/// Kept because a cluster configured before Postgres 14, or upgraded without rewriting its
/// `pg_hba.conf`, still asks for it. The username is empty here because the proxy's own backend user
/// is passed separately — see the caller.
fn md5_password(username: &str, password: &str, salt: [u8; 4]) -> String {
    use std::fmt::Write as _;

    let inner = md5_hex(format!("{password}{username}").as_bytes());
    let mut salted = inner.into_bytes();
    salted.extend_from_slice(&salt);

    let mut out = String::from("md5");
    for byte in md5_hex(&salted).into_bytes() {
        out.push(char::from(byte));
    }
    let _ = write!(out, "");
    out
}

fn md5_hex(input: &[u8]) -> String {
    use std::fmt::Write as _;

    let digest = md5::compute(input);
    let mut out = String::with_capacity(32);
    for byte in digest.0 {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Drop from the proxy's administrative role to the tenant's.
///
/// A simple query, and the identifier is not parameterizable — `SET ROLE $1` is not valid SQL. That
/// is why `routing::is_safe_identifier` is asserted before this is ever reached.
async fn set_role(server: &mut Stream, role: &str) -> Result<(), SessionError> {
    let statement = format!("SET ROLE {role}");
    let length = i32::try_from(statement.len() + 5).unwrap_or(i32::MAX);

    server.write_all(b"Q").await?;
    server.write_all(&length.to_be_bytes()).await?;
    server.write_all(statement.as_bytes()).await?;
    server.write_all(&[0]).await?;
    server.flush().await?;

    // Read until ReadyForQuery. An error here means the role does not exist, which means the
    // control plane and this proxy disagree about naming — and the connection must fail rather than
    // proceed with the proxy's own privileges.
    loop {
        let mut tag = [0u8; 1];
        server.read_exact(&mut tag).await?;

        let mut length_bytes = [0u8; 4];
        server.read_exact(&mut length_bytes).await?;
        let remaining = usize::try_from(i32::from_be_bytes(length_bytes))
            .unwrap_or(0)
            .saturating_sub(4);

        let mut body = vec![0u8; remaining];
        server.read_exact(&mut body).await?;

        match tag[0] {
            b'Z' => return Ok(()),
            b'E' => return Err(SessionError::Backend(error_message(&body))),
            _ => {}
        }
    }
}

/// Pull the human-readable message out of an `ErrorResponse`.
fn error_message(body: &[u8]) -> String {
    for field in body.split(|byte| *byte == 0) {
        if field.first() == Some(&b'M') {
            return String::from_utf8_lossy(&field[1..]).into_owned();
        }
    }
    "the cluster reported an error with no message".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_response_yields_its_message() {
        // Field-tagged, null-separated, as Postgres sends it.
        let body = b"SFATAL\0C3D000\0Mdatabase \"sprout_db_nope\" does not exist\0\0";
        assert_eq!(
            error_message(body),
            "database \"sprout_db_nope\" does not exist"
        );
    }

    #[test]
    fn an_error_response_without_a_message_still_says_something() {
        assert!(error_message(b"SFATAL\0C28000\0\0").contains("no message"));
    }

    #[test]
    fn md5_matches_the_shape_postgres_expects() {
        let hashed = md5_password("", "secret", [1, 2, 3, 4]);
        // `md5` plus 32 hex characters. Postgres rejects anything else outright.
        assert!(hashed.starts_with("md5"));
        assert_eq!(hashed.len(), 35);
        assert!(hashed[3..].chars().all(|c| c.is_ascii_hexdigit()));
    }
}

/// The client half of TLS: what this proxy presents when a customer asks for it.
///
/// Optional, deliberately. `sslmode=disable` never sends `SSLRequest` at all, so a client that does
/// not want TLS is unaffected either way — and a deployment with no certificate configured keeps
/// answering `N` and working exactly as before. Managed Postgres services differ on this; Supabase
/// leaves it to the client too.
///
/// What it is *not* is a reason to leave TLS unavailable. Without a certificate here, `pg-proxy`
/// asks for the password with `AuthenticationCleartextPassword` over a plaintext socket, so the
/// credential itself crosses the internet in the clear on every connection — not merely the rows.
pub mod client_tls {
    use std::io;
    use std::sync::Arc;

    use tokio::net::TcpStream;
    use tokio_rustls::TlsAcceptor;
    use tokio_rustls::rustls::ServerConfig;
    use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};

    /// Where the certificate and key are read from, if this deployment has them.
    const CERT_VARIABLE: &str = "PG_PROXY_TLS_CERT_FILE";
    const KEY_VARIABLE: &str = "PG_PROXY_TLS_KEY_FILE";

    /// Build an acceptor, or `None` where no certificate is configured.
    ///
    /// Built once at startup rather than per connection: parsing a PEM and building a
    /// `ServerConfig` on every `SSLRequest` would put that work on the connection path, which for a
    /// serverless application is every invocation.
    ///
    /// A configured-but-unreadable certificate is an error rather than a silent fallback to `N`.
    /// Falling back would mean a deployment that believes it offers TLS and does not, which is the
    /// worst of the three states — the other two are at least legible from the outside.
    pub fn acceptor() -> anyhow::Result<Option<TlsAcceptor>> {
        let (Ok(cert_path), Ok(key_path)) =
            (std::env::var(CERT_VARIABLE), std::env::var(KEY_VARIABLE))
        else {
            return Ok(None);
        };
        if cert_path.is_empty() || key_path.is_empty() {
            return Ok(None);
        }

        let certs: Vec<CertificateDer<'static>> =
            rustls_pemfile::certs(&mut io::BufReader::new(std::fs::File::open(&cert_path)?))
                .collect::<Result<_, _>>()?;
        anyhow::ensure!(!certs.is_empty(), "{cert_path} contains no certificate");

        let key: PrivateKeyDer<'static> =
            rustls_pemfile::private_key(&mut io::BufReader::new(std::fs::File::open(&key_path)?))?
                .ok_or_else(|| anyhow::anyhow!("{key_path} contains no private key"))?;

        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(certs, key)?;

        Ok(Some(TlsAcceptor::from(Arc::new(config))))
    }

    /// The client socket, plain or upgraded.
    #[derive(Debug)]
    pub enum ClientStream {
        Plain(TcpStream),
        Tls(Box<tokio_rustls::server::TlsStream<TcpStream>>),
    }

    impl tokio::io::AsyncRead for ClientStream {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            match self.get_mut() {
                ClientStream::Plain(stream) => std::pin::Pin::new(stream).poll_read(cx, buf),
                ClientStream::Tls(stream) => std::pin::Pin::new(stream.as_mut()).poll_read(cx, buf),
            }
        }
    }

    impl tokio::io::AsyncWrite for ClientStream {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<io::Result<usize>> {
            match self.get_mut() {
                ClientStream::Plain(stream) => std::pin::Pin::new(stream).poll_write(cx, buf),
                ClientStream::Tls(stream) => {
                    std::pin::Pin::new(stream.as_mut()).poll_write(cx, buf)
                }
            }
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            match self.get_mut() {
                ClientStream::Plain(stream) => std::pin::Pin::new(stream).poll_flush(cx),
                ClientStream::Tls(stream) => std::pin::Pin::new(stream.as_mut()).poll_flush(cx),
            }
        }

        fn poll_shutdown(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            match self.get_mut() {
                ClientStream::Plain(stream) => std::pin::Pin::new(stream).poll_shutdown(cx),
                ClientStream::Tls(stream) => std::pin::Pin::new(stream.as_mut()).poll_shutdown(cx),
            }
        }
    }
}
