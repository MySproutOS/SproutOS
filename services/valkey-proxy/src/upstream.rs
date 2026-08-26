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

    // Credentials in the URL are not carried through: the proxy authenticates the *tenant* and
    // holds no credential of its own for the backend.
    let authority = authority.rsplit('@').next().unwrap_or(authority);
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
    })
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

/// Opens the upstream named by `raw`, negotiating TLS when the scheme asks for it.
pub async fn connect(raw: &str) -> Result<Upstream> {
    let backend = parse_backend(raw)?;
    let stream = TcpStream::connect(&backend.address)
        .await
        .with_context(|| format!("could not reach the Valkey backend at {}", backend.address))?;

    if !backend.tls {
        return Ok(Upstream::Plain(stream));
    }

    let server_name = ServerName::try_from(backend.host.clone())
        .with_context(|| format!("{} is not a valid TLS server name", backend.host))?;

    let session = connector()
        .connect(server_name, stream)
        .await
        .with_context(|| format!("the TLS handshake with {} failed", backend.host))?;

    Ok(Upstream::Tls(Box::new(session)))
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
      The proxy authenticates the tenant and holds no credential of its own for the backend, so
      anything before an `@` is dropped rather than carried. Keeping it would put a password in
      `address` and from there into every connection error that names it.
    */
    #[test]
    fn credentials_in_the_url_are_not_carried_into_the_address() {
        let backend = parse_backend("rediss://someone:hunter2@cache.example.com:6379").unwrap();

        assert_eq!(backend.address, "cache.example.com:6379");
        assert!(!backend.address.contains("hunter2"));
        assert!(!backend.host.contains("hunter2"));
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
