//! Just enough of the Postgres wire protocol to terminate a client connection.
//!
//! Not a full implementation and deliberately not: this proxy reads the startup exchange, decides
//! who is connecting, and then gets out of the way. Everything after `ReadyForQuery` is bytes it
//! copies without looking at. Parsing the query stream would mean re-implementing a parser whose
//! bugs are indistinguishable from data corruption, for no benefit — the authorization decision was
//! already made at connect time.
//!
//! The startup exchange is the exception, and it has three shapes rather than one, which is the
//! part people get wrong:
//!
//! - **`SSLRequest`** — eight bytes, magic `80877103`. Sent *before* any startup message by every
//!   modern client with `sslmode` set to anything but `disable`. It has no type byte.
//! - **`CancelRequest`** — magic `80877102`. Arrives on a *separate connection* mid-session, which
//!   is why it cannot be handled by the session state machine.
//! - **`StartupMessage`** — protocol `196608`, then null-terminated key/value pairs.
//!
//! None of the three carries a leading type byte. Every message after them does.

use std::collections::HashMap;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// `1234 << 16 | 5679`. Sent instead of a protocol version to ask for TLS.
pub const SSL_REQUEST: i32 = 80_877_103;

/// `1234 << 16 | 5678`. A request to cancel a running query, on its own connection.
pub const CANCEL_REQUEST: i32 = 80_877_102;

/// Protocol 3.0, which every Postgres since 7.4 speaks and every client still sends.
pub const PROTOCOL_3_0: i32 = 196_608;

/// The largest startup packet we will read.
///
/// Postgres itself caps this at 10,000 bytes. Matching it means a client that would be refused by
/// the server is refused here, at a point where the error can say why — rather than being copied
/// through so the server can drop it.
const MAX_STARTUP_LEN: usize = 10_000;

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("the connection closed during the startup exchange")]
    Closed,

    #[error("a startup packet claimed {0} bytes; the limit is {MAX_STARTUP_LEN}")]
    TooLong(usize),

    #[error("a startup packet claimed {0} bytes, which is shorter than its own header")]
    TooShort(i32),

    #[error("unsupported protocol version {0}; this proxy speaks 3.0")]
    UnsupportedVersion(i32),

    #[error("a startup parameter was not valid UTF-8")]
    NotUtf8,

    #[error("the startup message named no user")]
    NoUser,

    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// What a client sent before any authentication happened.
#[derive(Debug, PartialEq, Eq)]
pub enum Startup {
    /// Asking whether we speak TLS. Answered with a single byte, then the client starts over.
    Ssl,
    /// Cancel a query on another connection. Carries the key the backend issued.
    Cancel { process_id: i32, secret_key: i32 },
    /// A real connection attempt.
    Connect(StartupParameters),
}

#[derive(Debug, PartialEq, Eq)]
pub struct StartupParameters {
    /// The tenant username. Required — Postgres has no concept of an anonymous connection.
    pub user: String,
    /// Defaults to the user, as libpq does.
    pub database: String,
    /// Everything else: `application_name`, `client_encoding`, options. Forwarded verbatim.
    pub options: HashMap<String, String>,
}

/// Read one startup packet.
///
/// The length prefix includes itself, which is the off-by-four every implementation of this makes
/// once — a 300-byte packet declares 300 and has 296 bytes of payload left to read.
pub async fn read_startup<R>(stream: &mut R) -> Result<Startup, ProtocolError>
where
    R: AsyncReadExt + Unpin,
{
    let length = read_i32(stream).await?;

    if length < 8 {
        return Err(ProtocolError::TooShort(length));
    }
    let remaining = usize::try_from(length).unwrap_or(usize::MAX) - 4;
    if remaining > MAX_STARTUP_LEN {
        return Err(ProtocolError::TooLong(remaining));
    }

    let mut body = vec![0u8; remaining];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|_| ProtocolError::Closed)?;

    let code = i32::from_be_bytes([body[0], body[1], body[2], body[3]]);

    match code {
        SSL_REQUEST => Ok(Startup::Ssl),
        CANCEL_REQUEST => {
            if body.len() < 12 {
                return Err(ProtocolError::TooShort(length));
            }
            Ok(Startup::Cancel {
                process_id: i32::from_be_bytes([body[4], body[5], body[6], body[7]]),
                secret_key: i32::from_be_bytes([body[8], body[9], body[10], body[11]]),
            })
        }
        PROTOCOL_3_0 => Ok(Startup::Connect(parse_parameters(&body[4..])?)),
        other => Err(ProtocolError::UnsupportedVersion(other)),
    }
}

/// Null-terminated key/value pairs, ended by an empty key.
fn parse_parameters(body: &[u8]) -> Result<StartupParameters, ProtocolError> {
    let mut options = HashMap::new();
    let mut parts = body.split(|byte| *byte == 0);

    while let Some(key) = parts.next() {
        // An empty key is the terminator, not a parameter named "".
        if key.is_empty() {
            break;
        }
        let Some(value) = parts.next() else { break };

        let key = std::str::from_utf8(key).map_err(|_| ProtocolError::NotUtf8)?;
        let value = std::str::from_utf8(value).map_err(|_| ProtocolError::NotUtf8)?;
        options.insert(key.to_owned(), value.to_owned());
    }

    let user = options.remove("user").ok_or(ProtocolError::NoUser)?;
    // libpq's own default, and clients rely on it: `psql -U alice` with no database connects to a
    // database named `alice`.
    let database = options.remove("database").unwrap_or_else(|| user.clone());

    Ok(StartupParameters {
        user,
        database,
        options,
    })
}

async fn read_i32<R>(stream: &mut R) -> Result<i32, ProtocolError>
where
    R: AsyncReadExt + Unpin,
{
    let mut buffer = [0u8; 4];
    stream
        .read_exact(&mut buffer)
        .await
        .map_err(|_| ProtocolError::Closed)?;
    Ok(i32::from_be_bytes(buffer))
}

/// `AuthenticationCleartextPassword`.
///
/// Cleartext, not SCRAM, and the reason is the credential store rather than laziness: tenant
/// secrets are held as `sha256$…`, a one-way hash. SCRAM requires the server to hold either the
/// password or a SCRAM verifier derived from it with the client's salt and iteration count, and we
/// hold neither by design — a stolen credential table is worthless, which is the property being
/// bought.
///
/// **The consequence is that this proxy must terminate TLS in production**, because the password
/// crosses the wire in the clear. That is a deployment requirement, not an optional hardening step.
pub async fn request_password<W>(stream: &mut W) -> Result<(), ProtocolError>
where
    W: AsyncWriteExt + Unpin,
{
    // 'R', length 8, auth type 3.
    stream.write_all(b"R").await?;
    stream.write_all(&8i32.to_be_bytes()).await?;
    stream.write_all(&3i32.to_be_bytes()).await?;
    stream.flush().await?;
    Ok(())
}

/// Read the `PasswordMessage` the client sends in reply.
pub async fn read_password<R>(stream: &mut R) -> Result<String, ProtocolError>
where
    R: AsyncReadExt + Unpin,
{
    let mut tag = [0u8; 1];
    stream
        .read_exact(&mut tag)
        .await
        .map_err(|_| ProtocolError::Closed)?;

    if tag[0] != b'p' {
        // Anything else here is a client that did not answer the challenge. Treated as a closed
        // connection rather than parsed: there is no legal alternative message at this point, so
        // whatever it is, this conversation is over.
        return Err(ProtocolError::Closed);
    }

    let length = read_i32(stream).await?;
    if length < 5 {
        return Err(ProtocolError::TooShort(length));
    }
    let remaining = usize::try_from(length).unwrap_or(usize::MAX) - 4;
    if remaining > MAX_STARTUP_LEN {
        return Err(ProtocolError::TooLong(remaining));
    }

    let mut body = vec![0u8; remaining];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|_| ProtocolError::Closed)?;

    // Null-terminated. Trimming rather than asserting, because a client that omits the terminator
    // is wrong in a way that costs nothing to tolerate.
    let end = body
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(body.len());
    std::str::from_utf8(&body[..end])
        .map(str::to_owned)
        .map_err(|_| ProtocolError::NotUtf8)
}

/// `ErrorResponse`, then the connection closes.
///
/// `28P01` is `invalid_password` and `28000` is `invalid_authorization_specification`. Both are what
/// Postgres itself would send, which matters because every client library special-cases them — a
/// made-up code produces "unknown error" in somebody's driver instead of "password authentication
/// failed".
pub async fn send_error<W>(stream: &mut W, code: &str, message: &str) -> Result<(), ProtocolError>
where
    W: AsyncWriteExt + Unpin,
{
    let mut body = Vec::new();
    for (field, value) in [
        (b'S', "FATAL"),
        (b'V', "FATAL"),
        (b'C', code),
        (b'M', message),
    ] {
        body.push(field);
        body.extend_from_slice(value.as_bytes());
        body.push(0);
    }
    body.push(0);

    stream.write_all(b"E").await?;
    // +4 for the length field, which counts itself.
    stream
        .write_all(
            &i32::try_from(body.len() + 4)
                .unwrap_or(i32::MAX)
                .to_be_bytes(),
        )
        .await?;
    stream.write_all(&body).await?;
    stream.flush().await?;
    Ok(())
}
