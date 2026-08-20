//! The Valkey proxy (TASK 20).
//!
//! > Workflows use BullMQ or Celery which uses a shared valkey instance. We use a proxy that
//! > receives valkey commands and adds it to a master valkey queue such that this proxy consumer
//! > continuously receives jobs from all projects and spins up services as needed.
//!
//! A tenant points BullMQ or Celery at this as though it were Valkey. It terminates the protocol,
//! identifies who is connecting, rewrites every key into that tenant's namespace, and forwards to
//! the shared backend.
//!
//! **One client connection, one backend connection.** Not multiplexed, deliberately: BullMQ blocks
//! on `BZPOPMIN` and `BRPOPLPUSH`, and a blocking command on a shared backend connection stalls
//! every other tenant on it. Multiplexing also needs request-response correlation, which RESP does
//! not carry — the protocol relies on ordering, so the only safe way to interleave is not to.
//!
//! This is Rust because it is per-command work on every job a tenant enqueues. A Node process
//! between BullMQ and Valkey would pay an event-loop hop and a GC pause for what is byte-shuffling.

pub mod commands;
pub mod credentials;
pub mod keyspace;
pub mod reply;
pub mod resp;

use std::collections::VecDeque;
use std::net::SocketAddr;

use bytes::BytesMut;
use sproutos_tenant_auth::TenantIdentity;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tracing::{info, warn};

use crate::commands::namespace_command;
pub use crate::credentials::CredentialStore;
use crate::credentials::{Authentication, report};
use crate::keyspace::{prefix_for, strip};
use crate::reply::{echoes_key, frame};
use crate::resp::{Command, RespError, error, parse_command, simple_string};

/// Read buffer per connection. Large enough for a typical BullMQ payload in one syscall.
const READ_BUFFER: usize = 16 * 1024;

/// One client, from AUTH to hang-up.
pub async fn serve(
    mut client: TcpStream,
    backend: SocketAddr,
    store: &CredentialStore,
) -> anyhow::Result<()> {
    let mut buffer = BytesMut::with_capacity(READ_BUFFER);

    // Authenticate before connecting to the backend. A client that never authenticates should
    // never cost us a backend connection — otherwise an unauthenticated flood exhausts the pool.
    let identity = match authenticate(&mut client, &mut buffer, store).await? {
        Some(identity) => identity,
        None => return Ok(()),
    };

    let prefix = prefix_for(&identity);
    let mut upstream = TcpStream::connect(backend).await?;
    info!(tenant = %identity, "authenticated");

    let (mut upstream_read, mut upstream_write) = upstream.split();
    let (mut client_read, mut client_write) = client.split();

    let mut upstream_buffer = BytesMut::with_capacity(READ_BUFFER);

    /*
      What we are waiting for a reply to.

      RESP has no request ids — it relies entirely on ordering — which is the other reason this
      proxy is 1:1 rather than multiplexed. A FIFO of verbs is therefore an exact record of which
      reply is arriving next, and the only reason to keep one is the handful of commands that echo
      a key name back.

      Bounded, because a client can pipeline without ever reading: an unbounded queue would let one
      connection grow the proxy's memory without limit.
    */
    let mut pending: VecDeque<String> = VecDeque::new();
    const MAX_PENDING: usize = 8192;

    loop {
        tokio::select! {
            // Commands from the tenant: parsed, namespaced, forwarded.
            read = client_read.read_buf(&mut buffer) => {
                if read? == 0 { return Ok(()) }

                loop {
                    match parse_command(&mut buffer) {
                        Ok(Some(mut command)) => {
                            if pending.len() >= MAX_PENDING {
                                client_write.write_all(&error("too many pipelined commands")).await?;
                                return Ok(())
                            }
                            let verb = command.verb();
                            match namespace_command(&mut command.args, &prefix) {
                                Ok(_) => {
                                    upstream_write.write_all(&command.encode()).await?;
                                    pending.push_back(verb);
                                }
                                Err(reason) => {
                                    // Refused, not dropped: the tenant gets an error they can act
                                    // on and the connection stays usable. Nothing is queued,
                                    // because nothing was sent.
                                    warn!(tenant = %identity, %verb, reason, "refused");
                                    client_write.write_all(&error(reason)).await?;
                                }
                            }
                        }
                        Ok(None) => break,
                        Err(RespError::Io(cause)) => return Err(cause.into()),
                        Err(cause) => {
                            // A malformed stream cannot be resynchronised — the framing is lost —
                            // so the connection ends rather than guessing where the next command
                            // starts.
                            client_write.write_all(&error(&cause.to_string())).await?;
                            return Ok(())
                        }
                    }
                }
            }

            // Replies from the backend. Forwarded byte-for-byte unless the command echoes a key,
            // in which case the namespace is stripped so the tenant sees the name they sent.
            read = upstream_read.read_buf(&mut upstream_buffer) => {
                if read? == 0 { return Ok(()) }

                loop {
                    match frame(&upstream_buffer) {
                        Ok(Some(framed)) => {
                            let raw = upstream_buffer.split_to(framed.len);
                            let verb = pending.pop_front().unwrap_or_default();

                            match framed.first_bulk.filter(|_| echoes_key(&verb)) {
                                Some((start, end)) => {
                                    let key = &raw[start..end];
                                    match strip(&prefix, key) {
                                        Some(bare) => {
                                            // Rebuilt rather than patched in place: the bulk
                                            // string's declared length changes with the key, so a
                                            // byte swap would leave a header that lies.
                                            let mut out = Vec::with_capacity(raw.len());
                                            out.extend_from_slice(&raw[..start - header_len(key.len())]);
                                            out.extend_from_slice(format!("${}\r\n", bare.len()).as_bytes());
                                            out.extend_from_slice(&bare);
                                            out.extend_from_slice(&raw[end..]);
                                            client_write.write_all(&out).await?;
                                        }
                                        // A key without our prefix is not ours to rewrite. It
                                        // should not happen, and passing it through unchanged is
                                        // safer than guessing.
                                        None => client_write.write_all(&raw).await?,
                                    }
                                }
                                None => client_write.write_all(&raw).await?,
                            }
                        }
                        Ok(None) => break,
                        Err(cause) => {
                            warn!(tenant = %identity, %cause, "backend sent a reply we cannot frame");
                            return Ok(())
                        }
                    }
                }
            }
        }
    }
}

/// Bytes a bulk string header occupies for a payload of `len`: `$`, the digits, and CRLF.
fn header_len(len: usize) -> usize {
    1 + len.to_string().len() + 2
}

/// Reads commands until the client authenticates.
///
/// Only `AUTH`, `HELLO`, `PING`, and `QUIT` are answered before that. Everything else is refused
/// without reaching the backend, so an unauthenticated connection can do nothing but authenticate.
async fn authenticate(
    client: &mut TcpStream,
    buffer: &mut BytesMut,
    store: &CredentialStore,
) -> anyhow::Result<Option<TenantIdentity>> {
    loop {
        if client.read_buf(buffer).await? == 0 {
            return Ok(None);
        }

        while let Some(command) = parse_command(buffer)? {
            match command.verb().as_str() {
                "AUTH" => {
                    let Some((username, secret)) = credentials_from(&command) else {
                        client
                            .write_all(&error("invalid username or password"))
                            .await?;
                        return Ok(None);
                    };

                    match store.authenticate(&username, &secret).await {
                        Ok(Authentication::Ok(identity)) => {
                            client.write_all(&simple_string("OK")).await?;
                            return Ok(Some(*identity));
                        }
                        // One message for "no such tenant" and for "wrong secret". Distinguishing
                        // them would let anyone enumerate which tenants exist, one AUTH at a time.
                        Ok(Authentication::Denied) => {
                            warn!(username, "authentication denied");
                            client
                                .write_all(&error("WRONGPASS invalid username or password"))
                                .await?;
                            return Ok(None);
                        }
                        // Our fault, not theirs. Saying "wrong password" here sends an operator to
                        // debug the tenant instead of the control plane.
                        Err(cause) => {
                            report(&cause);
                            client
                                .write_all(&error(
                                    "the service is temporarily unavailable; retry shortly",
                                ))
                                .await?;
                            return Ok(None);
                        }
                    }
                }
                "PING" => client.write_all(&simple_string("PONG")).await?,
                "HELLO" => {
                    // RESP3 negotiation before AUTH is legitimate; the reply is deliberately
                    // minimal rather than a forged server description.
                    client
                        .write_all(&error("NOAUTH Authentication required."))
                        .await?;
                }
                "QUIT" => {
                    client.write_all(&simple_string("OK")).await?;
                    return Ok(None);
                }
                _ => {
                    client
                        .write_all(&error("NOAUTH Authentication required."))
                        .await?;
                    return Ok(None);
                }
            }
        }
    }
}

/// Pulls the username and secret out of `AUTH <username> <password>`.
///
/// The one-argument form (`AUTH <password>`) is refused: without a username there is no tenant to
/// be, and guessing one from the password would be worse. Whether the username *names* anything is
/// not decided here — that is the credential store's job, and answering it early would leak which
/// usernames exist through the difference in how fast we say no.
fn credentials_from(command: &Command) -> Option<(String, Vec<u8>)> {
    if command.args.len() != 3 {
        return None;
    }
    let username = std::str::from_utf8(&command.args[1]).ok()?;
    Some((username.to_owned(), command.args[2].clone()))
}
