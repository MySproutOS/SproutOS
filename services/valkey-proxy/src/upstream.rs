//! Opening the connection to the tenant Valkey, with or without TLS.
//!
//! The proxy opened its upstream with a bare `TcpStream::connect` and had no TLS anywhere in it.
//! That is fine against the compose Valkey, which is how every test runs, and cannot work against
//! the thing it would actually be pointed at: ElastiCache is created with transit encryption
//! enabled, so it *requires* TLS and answers a plaintext handshake by closing the connection.
//!
//! The shape of that failure is worth naming, because it is not a compile error and not a
//! configuration error either. Everything is present — an instance, a proxy, a security group rule
//! that admits it — and the two ends simply do not speak the same thing. It reads as "not wired up
//! yet" right until someone wires it up.
//!
//! Scheme-driven rather than a separate flag. `rediss://` already means "this one is TLS" to every
//! Redis client anyone has used, and a `VALKEY_PROXY_BACKEND_TLS` beside the address would be a
//! second source of truth for something the address can say itself.

use std::sync::Arc;

use anyhow::{Context, Result};
use rustls_pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};

use std::io;
use std::pin::Pin;
use std::task::{Context as TaskContext, Poll};

/// Where the upstream is and how to speak to it.
#[derive(Debug, PartialEq, Eq)]
pub struct Backend {
    /// `host:port`, ready for `TcpStream::connect`.
    pub address: String,
    /// The host alone, for SNI and certificate verification.
    pub host: String,
    pub tls: bool,
    /*
      What the proxy presents to the backend, when the backend asks for anything.

      This used to be dropped on the floor, with a comment saying the proxy "holds no credential of
      its own for the backend". That was true of ElastiCache, which is reached over a private
      network inside the VPC and authenticates nobody. It stops being true the moment the backend is
      the Valkey on the OVH box, which is reached across the public internet — and there "the proxy
      is the boundary" needs the backend to be unreachable by anything else, which an IP allowlist
      cannot provide: tenant Lambdas egress through the same NAT address the allowlist admits.

      So the backend gets a second lock and this is the key. `None` where the backend is genuinely
      private, because a credential nothing checks is a credential to rotate for no reason.

      Kept apart from `address` on purpose: a password inside the address string ends up in every
      connection error that names it.
    */
    pub credentials: Option<Credentials>,
}

/// A username and password for the backend, from the userinfo of `VALKEY_PROXY_BACKEND`.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Credentials {
    /// `default` where the URL gives only a password — Valkey's own name for the implicit user, and
    /// what `requirepass` alone authenticates as.
    pub username: String,
    pub password: String,
}

/// The default RESP port, applied when the address names only a host.
const DEFAULT_PORT: u16 = 6379;

/// Reads `VALKEY_PROXY_BACKEND` in any of the forms someone will actually write.
///
/// `rediss://` selects TLS, `redis://` and a bare `host:port` do not. A missing port is the default
/// rather than an error: `master.sproutos-platform.7gteeb.use1.cache.amazonaws.com` is what the
/// console shows you, and refusing it over a port everyone knows would be pedantry with an outage
/// attached.
pub fn parse_backend(raw: &str) -> Result<Backend> {
    let trimmed = raw.trim();
    anyhow::ensure!(!trimmed.is_empty(), "the Valkey backend address is empty");

    let (tls, rest) = match trimmed {
        _ if trimmed.starts_with("rediss://") => (true, &trimmed["rediss://".len()..]),
        _ if trimmed.starts_with("redis://") => (false, &trimmed["redis://".len()..]),
        _ => (false, trimmed),
    };

    // Anything after the authority is a database selector or a path, and this proxy namespaces by
    // key prefix rather than by database — see `keyspace.rs`. Ignored rather than rejected.
    let authority = rest.split(['/', '?']).next().unwrap_or(rest);

    // Split at the *last* `@`, so a password containing one still leaves a parseable host.
    let (userinfo, authority) = match authority.rsplit_once('@') {
        Some((userinfo, host)) => (Some(userinfo), host),
        None => (None, authority),
    };

    let credentials = userinfo.filter(|value| !value.is_empty()).map(|value| {
        let (username, password) = match value.split_once(':') {
            Some((username, password)) => (username, password),
            // `redis://:secret@host` and `redis://secret@host` are both written in the wild. A
            // lone field is the password, because `requirepass` is the common case.
            None => ("", value),
        };
        Credentials {
            username: if username.is_empty() {
                "default".to_owned()
            } else {
                username.to_owned()
            },
            password: password.to_owned(),
        }
    });
    anyhow::ensure!(
        !authority.is_empty(),
        "the Valkey backend address has no host"
    );

    let (host, port) = match authority.rsplit_once(':') {
        // Not a port: an IPv6 literal without brackets, which we take whole.
        Some((_, tail)) if tail.parse::<u16>().is_err() => (authority, DEFAULT_PORT),
        Some((head, tail)) => (head, tail.parse::<u16>().unwrap_or(DEFAULT_PORT)),
        None => (authority, DEFAULT_PORT),
    };

    let host = host.trim_start_matches('[').trim_end_matches(']');
    anyhow::ensure!(!host.is_empty(), "the Valkey backend address has no host");

    /*
      Brackets go back on an IPv6 literal, and only on one.

      `2600:1f18::1:6379` is not an address anything can connect to — the colons are ambiguous, and
      `TcpStream::connect` rejects it. The host is kept bare because SNI and certificate
      verification want it that way, so the two forms genuinely differ and cannot be one field.
    */
    let address = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };

    Ok(Backend {
        address,
        host: host.to_owned(),
        tls,
        credentials,
    })
}

/// The backend address with any credential removed, for logging.
///
/// `VALKEY_PROXY_BACKEND` is a URI and the password lives in its userinfo, so anything that prints
/// the raw value prints the password. The startup line did exactly that — one `INFO` per boot, into
/// journald and from there into whatever collects it, containing the credential for every tenant's
/// queue.
///
/// Returns the address alone. An unparseable value yields `<unparseable>` rather than the input,
/// because the one case where the string is not shaped as expected is the case where guessing which
/// part of it is secret is least safe.
pub fn redacted(raw: &str) -> String {
    match parse_backend(raw) {
        Ok(backend) => {
            let scheme = if backend.tls { "rediss" } else { "redis" };
            let credential = if backend.credentials.is_some() {
                "***@"
            } else {
                ""
            };
            format!("{scheme}://{credential}{}", backend.address)
        }
        Err(_) => "<unparseable>".to_owned(),
    }
}

/// A connected upstream, which is either a plain socket or a TLS session over one.
///
/// An enum rather than a boxed `dyn AsyncRead + AsyncWrite`: this sits on every tenant command, and
/// a vtable hop per poll is not worth the handful of lines it would save.
#[derive(Debug)]
pub enum Upstream {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

/// Opens the upstream named by `raw`, negotiating TLS when the scheme asks for it and
/// authenticating when the address carries a credential.
pub async fn connect(raw: &str) -> Result<Upstream> {
    connect_as(raw, None).await
}

/// Opens the upstream, authenticating as `credentials` instead of the administrator in the URL.
pub async fn connect_as(raw: &str, credentials: Option<&Credentials>) -> Result<Upstream> {
    let backend = parse_backend(raw)?;
    let stream = TcpStream::connect(&backend.address)
        .await
        .with_context(|| format!("could not reach the Valkey backend at {}", backend.address))?;

    let mut upstream = if backend.tls {
        let server_name = ServerName::try_from(backend.host.clone())
            .with_context(|| format!("{} is not a valid TLS server name", backend.host))?;

        let session = connector()
            .connect(server_name, stream)
            .await
            .with_context(|| format!("the TLS handshake with {} failed", backend.host))?;

        Upstream::Tls(Box::new(session))
    } else {
        Upstream::Plain(stream)
    };

    if let Some(credentials) = credentials.or(backend.credentials.as_ref()) {
        authenticate(&mut upstream, credentials, &backend.host).await?;
    }

    Ok(upstream)
}

/// Whether a failed connection was rejected because its ACL user is absent or stale.
pub fn is_wrongpass(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string().contains("WRONGPASS"))
}

/*
  `AUTH`, before the tenant's first byte reaches the backend.

  Sent here rather than forwarded from the client, because the tenant's `AUTH` is a *SproutOS*
  credential that the backend has never heard of — `lib.rs` consumes it and answers it itself. The
  two authentications are of different things to different parties and only look alike.

  The reply is read to completion rather than left in the socket. A `+OK` still sitting in the
  buffer when the splice starts is a `+OK` the tenant's client reads as the answer to *its* first
  command, and from then on every reply is one behind — which does not look like an authentication
  problem at all.
*/
async fn authenticate(
    upstream: &mut Upstream,
    credentials: &Credentials,
    host: &str,
) -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let command = format!(
        "*3\r\n$4\r\nAUTH\r\n${}\r\n{}\r\n${}\r\n{}\r\n",
        credentials.username.len(),
        credentials.username,
        credentials.password.len(),
        credentials.password,
    );

    upstream
        .write_all(command.as_bytes())
        .await
        .with_context(|| format!("could not send AUTH to the Valkey backend at {host}"))?;
    upstream.flush().await?;

    // A simple string or an error, both terminated by CRLF, and nothing else can come first.
    let mut reply = Vec::with_capacity(64);
    let mut byte = [0u8; 1];
    loop {
        let read = upstream
            .read(&mut byte)
            .await
            .with_context(|| format!("the Valkey backend at {host} closed during AUTH"))?;
        anyhow::ensure!(read == 1, "the Valkey backend at {host} closed during AUTH");
        reply.push(byte[0]);
        if reply.ends_with(b"\r\n") {
            break;
        }
        anyhow::ensure!(
            reply.len() < 512,
            "the Valkey backend at {host} answered AUTH with something that is not a RESP reply"
        );
    }

    // The password is never in the error. It is in `command`, three lines up, and an error that
    // echoed the reply verbatim would still be safe — but one that echoed the *request* would not,
    // and that is the mistake this comment exists to stop somebody making later.
    anyhow::ensure!(
        reply.starts_with(b"+"),
        "the Valkey backend at {host} refused the proxy's credential: {}",
        String::from_utf8_lossy(&reply).trim_end().to_owned()
    );

    Ok(())
}

/// Built once. Assembling a root store per connection would parse the whole bundle each time.
fn connector() -> TlsConnector {
    static CONNECTOR: std::sync::OnceLock<TlsConnector> = std::sync::OnceLock::new();

    CONNECTOR
        .get_or_init(|| {
            /*
              Webpki's bundled roots, not the platform's.

              The container is `FROM scratch`-adjacent and carries no certificate store, so reading
              the system's would find nothing and fail every handshake — with an error about
              certificates rather than about the missing file, which is the hard kind to diagnose.
              AWS's endpoints chain to public roots, so the bundle is sufficient.
            */
            let roots = RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            };

            let config = ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth();

            TlsConnector::from(Arc::new(config))
        })
        .clone()
}

impl AsyncRead for Upstream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Upstream::Plain(stream) => Pin::new(stream).poll_read(cx, buf),
            Upstream::Tls(stream) => Pin::new(stream.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Upstream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Upstream::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
            Upstream::Tls(stream) => Pin::new(stream.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Upstream::Plain(stream) => Pin::new(stream).poll_flush(cx),
            Upstream::Tls(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Upstream::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            Upstream::Tls(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /*
      The proxy could only ever open a plain socket, and every test it had ran against the compose
      Valkey, which is happy with that. ElastiCache is created with transit encryption enabled and
      answers a plaintext handshake by hanging up — so the one deployment this would be pointed at
      is the one configuration nothing exercised.
    */
    #[test]
    fn rediss_selects_tls_and_redis_does_not() {
        assert!(
            parse_backend("rediss://cache.example.com:6379")
                .unwrap()
                .tls
        );
        assert!(!parse_backend("redis://cache.example.com:6379").unwrap().tls);
        assert!(!parse_backend("cache.example.com:6379").unwrap().tls);
    }

    /*
      The console shows the endpoint without a port, so that is what gets pasted into configuration.
      Refusing it would be pedantry with an outage attached.
    */
    #[test]
    fn a_missing_port_is_the_default_one() {
        let backend = parse_backend("master.sproutos-platform.use1.cache.amazonaws.com").unwrap();

        assert_eq!(
            backend.address,
            "master.sproutos-platform.use1.cache.amazonaws.com:6379"
        );
        assert_eq!(
            backend.host,
            "master.sproutos-platform.use1.cache.amazonaws.com"
        );
    }

    /// SNI and certificate verification need the host alone; connecting needs the pair.
    #[test]
    fn the_host_is_kept_apart_from_the_address() {
        let backend = parse_backend("rediss://cache.example.com:6380").unwrap();

        assert_eq!(backend.address, "cache.example.com:6380");
        assert_eq!(backend.host, "cache.example.com");
    }

    /*
      A database selector is not an error here. This proxy namespaces by key prefix rather than by
      database — see `keyspace.rs` — so `/0` is noise, and rejecting it would fail a URL that every
      other Redis client accepts.
    */
    #[test]
    fn a_database_selector_is_ignored_rather_than_refused() {
        assert_eq!(
            parse_backend("redis://cache.example.com:6379/0")
                .unwrap()
                .address,
            "cache.example.com:6379"
        );
    }

    /*
      The credential is kept, and kept *out of* the address.

      It used to be dropped entirely, which was right while the only backend was an ElastiCache
      inside the VPC that authenticates nobody. A backend reached across the public internet needs a
      second lock, and this is the key to it.

      The address must still not carry it: a password inside `address` ends up in every connection
      error that names the backend, and those get logged.
    */
    #[test]
    fn a_credential_is_kept_apart_from_the_address() {
        let backend = parse_backend("rediss://someone:hunter2@cache.example.com:6379").unwrap();

        assert_eq!(backend.address, "cache.example.com:6379");
        assert!(!backend.address.contains("hunter2"));
        assert!(!backend.host.contains("hunter2"));

        let credentials = backend.credentials.expect("the credential is carried");
        assert_eq!(credentials.username, "someone");
        assert_eq!(credentials.password, "hunter2");
    }

    /*
      `requirepass` authenticates as the implicit user, which Valkey calls `default`. Both spellings
      of a password-only URL appear in the wild and both mean that.
    */
    #[test]
    fn a_password_alone_authenticates_as_default() {
        for url in [
            "redis://:hunter2@cache.example.com",
            "redis://hunter2@cache.example.com",
        ] {
            let credentials = parse_backend(url).unwrap().credentials.expect(url);
            assert_eq!(credentials.username, "default", "{url}");
            assert_eq!(credentials.password, "hunter2", "{url}");
        }
    }

    /*
      No userinfo means no `AUTH` is sent at all, rather than an empty one.

      An `AUTH  ` against a backend with no password is an error reply, and `connect` treats an
      error reply as fatal — so getting this wrong would break every existing deployment, all of
      which point at a backend that authenticates nobody.
    */
    #[test]
    fn an_address_without_a_credential_sends_no_auth() {
        assert!(
            parse_backend("rediss://cache.example.com:6379")
                .unwrap()
                .credentials
                .is_none()
        );
        assert!(
            parse_backend("cache.example.com:6379")
                .unwrap()
                .credentials
                .is_none()
        );
    }

    /*
      The handshake itself, against a server that only speaks the two lines this cares about.

      `parse_backend` tests say what is *carried*; this says what goes on the wire and what is taken
      off it. Both matter and only one of them was ever the bug: an `AUTH` whose `+OK` is left in
      the socket is a proxy that works perfectly except that every reply the tenant reads is one
      behind, which presents as data corruption rather than as an authentication problem.
    */
    #[tokio::test]
    async fn auth_is_sent_as_resp_and_its_reply_is_consumed() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();

            let mut seen = vec![0u8; 64];
            let read = socket.read(&mut seen).await.unwrap();
            seen.truncate(read);

            socket.write_all(b"+OK\r\n").await.unwrap();
            // A byte the tenant's session must receive, to prove the `+OK` above was not left for
            // it to read as the answer to its own first command.
            socket.write_all(b"+SECOND\r\n").await.unwrap();
            socket.flush().await.unwrap();

            seen
        });

        let mut upstream = connect(&format!("redis://someone:hunter2@127.0.0.1:{port}"))
            .await
            .expect("the backend accepted the credential");

        let sent = server.await.unwrap();
        assert_eq!(
            sent,
            b"*3\r\n$4\r\nAUTH\r\n$7\r\nsomeone\r\n$7\r\nhunter2\r\n",
            "got {:?}",
            String::from_utf8_lossy(&sent)
        );

        let mut next = [0u8; 9];
        upstream.read_exact(&mut next).await.unwrap();
        assert_eq!(&next, b"+SECOND\r\n");
    }

    /// A backend that refuses the credential fails the connection rather than splicing a session
    /// onto a socket that will error on its first real command.
    #[tokio::test]
    async fn a_refused_credential_fails_the_connection() {
        use tokio::io::AsyncWriteExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket
                .write_all(b"-WRONGPASS invalid username-password pair\r\n")
                .await
                .unwrap();
            socket.flush().await.unwrap();
        });

        let refused = connect(&format!("redis://:wrong@127.0.0.1:{port}")).await;
        let cause = refused
            .expect_err("a refused credential must fail")
            .to_string();

        assert!(cause.contains("WRONGPASS"), "{cause}");
        // The password is the one thing that must never reach a log line.
        assert!(!cause.contains("wrong@"), "{cause}");
    }

    /*
      The log line must not carry the credential.

      This is asserted rather than reviewed because it is invisible in normal operation: the log is
      correct-looking either way, and the only difference is whether a secret is in it. The startup
      line printed the raw `VALKEY_PROXY_BACKEND` and therefore the password, once per boot.
    */
    #[test]
    fn the_redacted_form_keeps_the_address_and_drops_the_secret() {
        let shown = redacted("rediss://:hunter2@queue.example.com:6379");

        assert_eq!(shown, "rediss://***@queue.example.com:6379");
        assert!(!shown.contains("hunter2"));
    }

    /// Nothing to redact is still shown in full — an address is not a secret.
    #[test]
    fn an_address_without_a_credential_is_shown_whole() {
        assert_eq!(
            redacted("cache.example.com:6379"),
            "redis://cache.example.com:6379"
        );
    }

    /// A value that does not parse is not echoed. If the shape is unknown, so is which part is secret.
    #[test]
    fn an_unparseable_backend_is_not_echoed() {
        assert_eq!(redacted(""), "<unparseable>");
    }

    /// A password may contain an `@`. Splitting at the first one would leave it in the host.
    #[test]
    fn the_split_is_at_the_last_at_sign() {
        let backend = parse_backend("redis://user:pa@ss@cache.example.com:6379").unwrap();

        assert_eq!(backend.host, "cache.example.com");
        assert_eq!(backend.credentials.unwrap().password, "pa@ss");
    }

    /*
      The first version of this test asserted `2600:1f18::1:6379`, which is what the code produced
      and is not an address: the colons are ambiguous and `TcpStream::connect` refuses it. Writing
      down what the code did rather than what would connect is how a test comes to guard a bug.
    */
    #[test]
    fn an_ipv6_literal_is_bracketed_in_the_address_and_bare_in_the_host() {
        let backend = parse_backend("redis://[2600:1f18::1]:6379").unwrap();

        // Bare, because SNI and certificate verification want it that way.
        assert_eq!(backend.host, "2600:1f18::1");
        // Bracketed, because that is the only form a socket address parser accepts.
        assert_eq!(backend.address, "[2600:1f18::1]:6379");
        assert!(backend.address.parse::<std::net::SocketAddr>().is_ok());
    }

    /// A name is not bracketed. The rule keys on the colons, so it must not fire on a hostname.
    #[test]
    fn a_hostname_is_not_bracketed() {
        assert_eq!(
            parse_backend("cache.example.com:6379").unwrap().address,
            "cache.example.com:6379"
        );
    }

    #[test]
    fn an_empty_backend_is_refused_rather_than_defaulted() {
        assert!(parse_backend("").is_err());
        assert!(parse_backend("   ").is_err());
        assert!(parse_backend("rediss://").is_err());
    }
}
