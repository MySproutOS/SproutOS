//! The client half: this proxy talking to the real Postgres.
//!
//! It connects as an administrative role, because reaching an arbitrary tenant's database requires
//! one, and then immediately gives that privilege away with `SET ROLE`. The window between those
//! two facts is the whole risk in this file, and it is why `SET ROLE` happens here rather than being
//! left to the tenant's first statement — a session that reached the splice still administrative
//! would let one customer read every other customer's tables.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::{BackendConfig, SessionError};

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
    })
}

/// A backend session, plus the handshake the client still needs to see.
pub struct Backend {
    pub stream: TcpStream,
    /// `ParameterStatus` and `BackendKeyData` as the backend sent them.
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
}

/// Connect, authenticate, and drop to the tenant's role.
pub async fn connect(
    backend: &BackendConfig,
    database: &str,
    role: &str,
) -> Result<Backend, SessionError> {
    let mut server = TcpStream::connect((backend.host.as_str(), backend.port))
        .await
        .map_err(|error| SessionError::Backend(format!("could not reach the cluster: {error}")))?;
    // The tenant's queries are request/response; a delayed ACK on a small packet is latency added
    // to every one of them.
    let _ = server.set_nodelay(true);

    send_startup(&mut server, &backend.user, database).await?;
    let handshake = complete_authentication(&mut server, &backend.password).await?;
    set_role(&mut server, role).await?;

    Ok(Backend {
        stream: server,
        handshake,
    })
}

async fn send_startup(
    server: &mut TcpStream,
    user: &str,
    database: &str,
) -> Result<(), SessionError> {
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
async fn complete_authentication(
    server: &mut TcpStream,
    password: &str,
) -> Result<Vec<u8>, SessionError> {
    // Everything the client will need to be told, kept in the bytes the backend used to say it.
    let mut handshake = Vec::new();

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
            b'Z' => return Ok(handshake),
            b'E' => {
                return Err(SessionError::Backend(error_message(&body)));
            }
            // `ParameterStatus` and `BackendKeyData` are the client's to receive.
            //
            // `BackendKeyData` is forwarded as the backend's own, which means a client's cancel
            // request carries a key this proxy cannot route — see the note on `Startup::Cancel`.
            // Rewriting it needs a key map per session, and forwarding the backend's is the honest
            // half-measure: the key is real, it just does not reach us.
            b'S' | b'K' => {
                handshake.push(tag[0]);
                handshake.extend_from_slice(&length_bytes);
                handshake.extend_from_slice(&body);
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
    server: &mut TcpStream,
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
async fn read_auth_payload(server: &mut TcpStream, expected: i32) -> Result<String, SessionError> {
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
    server: &mut TcpStream,
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

async fn send_sasl_response(server: &mut TcpStream, message: &str) -> Result<(), SessionError> {
    // No null terminator and no inner length: a SASLResponse is the raw payload.
    let length = i32::try_from(4 + message.len()).unwrap_or(i32::MAX);
    server.write_all(b"p").await?;
    server.write_all(&length.to_be_bytes()).await?;
    server.write_all(message.as_bytes()).await?;
    server.flush().await?;
    Ok(())
}

async fn send_password(server: &mut TcpStream, password: &str) -> Result<(), SessionError> {
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
async fn set_role(server: &mut TcpStream, role: &str) -> Result<(), SessionError> {
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
