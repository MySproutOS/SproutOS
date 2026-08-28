//! Proxy Protocol v2 prelude for the public tenant HTTP/TLS edge.
//!
//! The dual-stack NLB translates IPv6 clients to the router's IPv4 instance target, so the socket
//! peer is the load balancer rather than the viewer. AWS prepends this header to both traffic and
//! health checks when it is enabled on a target group. No other router listener uses this module.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use axum::serve::Listener;
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, BufReader};
use tokio::net::{TcpListener, TcpStream};

const SIGNATURE: [u8; 12] = *b"\r\n\r\n\0\r\nQUIT\n";
const MAX_PAYLOAD_BYTES: usize = 4_096;
const HEADER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Addresses {
    pub source: SocketAddr,
    pub destination: SocketAddr,
}

/// The buffered reader is the contract: bytes coalesced after the header remain available to TLS
/// or HTTP exactly as they arrived.
pub async fn read<T>(stream: T) -> io::Result<(BufReader<T>, Option<Addresses>)>
where
    T: AsyncRead + AsyncWrite + Unpin,
{
    let mut stream = BufReader::new(stream);
    let mut signature = [0_u8; SIGNATURE.len()];
    stream.read_exact(&mut signature).await?;
    if signature != SIGNATURE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "missing Proxy Protocol v2 signature",
        ));
    }

    let mut fixed = [0_u8; 4];
    stream.read_exact(&mut fixed).await?;
    let version = fixed[0] >> 4;
    let command = fixed[0] & 0x0f;
    if version != 2 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported Proxy Protocol version",
        ));
    }
    let length = u16::from_be_bytes([fixed[2], fixed[3]]) as usize;
    if length > MAX_PAYLOAD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Proxy Protocol v2 payload is too large",
        ));
    }
    let mut payload = vec![0_u8; length];
    stream.read_exact(&mut payload).await?;

    if command == 0 {
        return Ok((stream, None));
    }
    if command != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported Proxy Protocol command",
        ));
    }

    let family = fixed[1] >> 4;
    let protocol = fixed[1] & 0x0f;
    if protocol != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Proxy Protocol edge connection is not a byte stream",
        ));
    }
    let addresses = match family {
        1 if payload.len() >= 12 => Addresses {
            source: SocketAddr::new(
                IpAddr::V4(Ipv4Addr::new(
                    payload[0], payload[1], payload[2], payload[3],
                )),
                u16::from_be_bytes([payload[8], payload[9]]),
            ),
            destination: SocketAddr::new(
                IpAddr::V4(Ipv4Addr::new(
                    payload[4], payload[5], payload[6], payload[7],
                )),
                u16::from_be_bytes([payload[10], payload[11]]),
            ),
        },
        2 if payload.len() >= 36 => {
            let source: [u8; 16] = payload[0..16].try_into().expect("slice length checked");
            let destination: [u8; 16] = payload[16..32].try_into().expect("slice length checked");
            Addresses {
                source: SocketAddr::new(
                    IpAddr::V6(Ipv6Addr::from(source)),
                    u16::from_be_bytes([payload[32], payload[33]]),
                ),
                destination: SocketAddr::new(
                    IpAddr::V6(Ipv6Addr::from(destination)),
                    u16::from_be_bytes([payload[34], payload[35]]),
                ),
            }
        }
        1 | 2 => {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "truncated Proxy Protocol address block",
            ));
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unsupported Proxy Protocol address family",
            ));
        }
    };
    Ok((stream, Some(addresses)))
}

/// Axum listener which refuses connections that did not arrive through a Proxy-Protocol-enabled
/// edge target group. LOCAL health connections retain the NLB socket peer as their non-authoritative
/// address; ordinary PROXY connections expose the declared viewer address.
pub struct ProxyProtocolListener {
    inner: TcpListener,
    required: bool,
}

impl ProxyProtocolListener {
    pub fn new(inner: TcpListener, required: bool) -> Self {
        Self { inner, required }
    }
}

pub fn required_from_env() -> anyhow::Result<bool> {
    match std::env::var("ROUTER_EDGE_PROXY_PROTOCOL") {
        Ok(value) if value == "1" => Ok(true),
        Ok(value) if value == "0" => Ok(false),
        Ok(_) => anyhow::bail!("ROUTER_EDGE_PROXY_PROTOCOL must be 0 or 1"),
        Err(std::env::VarError::NotPresent) => {
            anyhow::bail!("ROUTER_EDGE_PROXY_PROTOCOL must be set explicitly to 0 or 1")
        }
        Err(cause) => Err(cause.into()),
    }
}

impl Listener for ProxyProtocolListener {
    type Io = BufReader<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let (stream, peer) = match self.inner.accept().await {
                Ok(value) => value,
                Err(cause) => {
                    tracing::error!(%cause, "tenant edge accept failed");
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    continue;
                }
            };
            if !self.required {
                return (BufReader::new(stream), peer);
            }
            match tokio::time::timeout(HEADER_TIMEOUT, read(stream)).await {
                Ok(Ok((stream, addresses))) => {
                    return (stream, addresses.map_or(peer, |value| value.source));
                }
                Ok(Err(cause)) => {
                    tracing::warn!(%peer, %cause, "invalid tenant edge proxy prelude")
                }
                Err(_) => tracing::warn!(%peer, "tenant edge proxy prelude timed out"),
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _, duplex};

    use super::*;

    fn header(command: u8, family_protocol: u8, payload: &[u8]) -> Vec<u8> {
        let mut bytes = SIGNATURE.to_vec();
        bytes.extend([0x20 | command, family_protocol]);
        bytes.extend(u16::try_from(payload.len()).unwrap().to_be_bytes());
        bytes.extend(payload);
        bytes
    }

    #[tokio::test]
    async fn parses_fragmented_ipv4_and_preserves_coalesced_payload() {
        let mut addresses = vec![192, 0, 2, 10, 198, 51, 100, 20];
        addresses.extend(50000_u16.to_be_bytes());
        addresses.extend(443_u16.to_be_bytes());
        let mut bytes = header(1, 0x11, &addresses);
        bytes.extend(b"client hello");
        let (mut writer, reader) = duplex(128);
        let sending = tokio::spawn(async move {
            for chunk in bytes.chunks(3) {
                writer.write_all(chunk).await.unwrap();
            }
        });

        let (mut stream, parsed) = read(reader).await.unwrap();
        let parsed = parsed.unwrap();
        assert_eq!(parsed.source, "192.0.2.10:50000".parse().unwrap());
        assert_eq!(parsed.destination, "198.51.100.20:443".parse().unwrap());
        let mut remaining = String::new();
        stream.read_to_string(&mut remaining).await.unwrap();
        assert_eq!(remaining, "client hello");
        sending.await.unwrap();
    }

    #[tokio::test]
    async fn parses_ipv6_with_tlvs() {
        let source: Ipv6Addr = "2001:db8::10".parse().unwrap();
        let destination: Ipv6Addr = "2001:db8::20".parse().unwrap();
        let mut addresses = source.octets().to_vec();
        addresses.extend(destination.octets());
        addresses.extend(50000_u16.to_be_bytes());
        addresses.extend(443_u16.to_be_bytes());
        addresses.extend([0x01, 0x00, 0x01, 0x02]);

        let bytes = header(1, 0x21, &addresses);
        let (mut writer, reader) = duplex(128);
        writer.write_all(&bytes).await.unwrap();
        drop(writer);
        let (_, parsed) = read(reader).await.unwrap();
        assert_eq!(
            parsed.unwrap().source,
            "[2001:db8::10]:50000".parse().unwrap()
        );
    }

    #[tokio::test]
    async fn accepts_local_and_consumes_its_payload() {
        let mut bytes = header(0, 0x00, b"local metadata");
        bytes.extend(b"GET /");
        let (mut writer, reader) = duplex(128);
        writer.write_all(&bytes).await.unwrap();
        drop(writer);
        let (mut stream, parsed) = read(reader).await.unwrap();
        assert_eq!(parsed, None);
        let mut remaining = String::new();
        stream.read_to_string(&mut remaining).await.unwrap();
        assert_eq!(remaining, "GET /");
    }

    #[tokio::test]
    async fn rejects_missing_malformed_truncated_and_oversized_headers() {
        for bytes in [
            b"not a proxy header".to_vec(),
            header(2, 0x11, &[0; 12]),
            header(1, 0x12, &[0; 12]),
            header(1, 0x11, &[0; 11]),
        ] {
            let (mut writer, reader) = duplex(8192);
            writer.write_all(&bytes).await.unwrap();
            drop(writer);
            assert!(read(reader).await.is_err());
        }

        let mut oversized = SIGNATURE.to_vec();
        oversized.extend([0x21, 0x11]);
        oversized.extend(u16::try_from(MAX_PAYLOAD_BYTES + 1).unwrap().to_be_bytes());
        let (mut writer, reader) = duplex(128);
        writer.write_all(&oversized).await.unwrap();
        drop(writer);
        assert!(read(reader).await.is_err());
    }
}
