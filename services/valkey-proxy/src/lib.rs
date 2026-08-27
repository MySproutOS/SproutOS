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

pub mod acl;
pub mod commands;
pub mod keyspace;
pub mod master;
pub mod provision;
pub mod reply;
pub mod resp;
pub mod scan;
pub mod upstream;

use std::collections::VecDeque;

use bytes::BytesMut;
use sproutos_tenant_auth::{ResourceKind, TenantIdentity, encode_short_id};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tracing::{info, warn};

use crate::commands::{adds_work, namespace_command, queue_of};
use crate::keyspace::{prefix_for, strip};
use crate::master::{MasterQueue, Wake};
use crate::provision::AclProvisioner;
use crate::reply::{echoes_key, frame};
use crate::resp::{Command, RespError, error, parse_command, simple_string};
use crate::scan::ScanRequest;
pub use sproutos_service_credentials::CredentialStore;
use sproutos_service_credentials::{Authentication, report};

/// Read buffer per connection. Large enough for a typical BullMQ payload in one syscall.
const READ_BUFFER: usize = 16 * 1024;

/// One client, from AUTH to hang-up.
/// `backend` is a host:port string, resolved on each connection — see the note in `main.rs`.
pub async fn serve(
    mut client: TcpStream,
    store: &CredentialStore,
    provisioner: &AclProvisioner,
    /*
      Where enqueues are reported, so a dispatcher can start a worker — TASK 20's second half.

      Passed in rather than reached for, because the alternative is a global and because a test
      wants `MasterQueue::disabled()`. Reporting never blocks this loop and never fails it: see the
      note on failing open in `master.rs`.
    */
    master: &MasterQueue,
) -> anyhow::Result<()> {
    let mut buffer = BytesMut::with_capacity(READ_BUFFER);

    // Authenticate before connecting to the backend. A client that never authenticates should
    // never cost us a backend connection — otherwise an unauthenticated flood exhausts the pool.
    let identity = match authenticate(&mut client, &mut buffer, store).await? {
        Some(identity) => identity,
        None => return Ok(()),
    };

    let prefix = prefix_for(&identity);
    let upstream = provisioner.connect(&identity).await?;
    info!(tenant = %identity, "authenticated");

    /*
      `tokio::io::split`, not the borrowed `TcpStream::split`.

      The upstream may now be a TLS session rather than a socket, so the halves come from the
      generic split over `AsyncRead + AsyncWrite`. It costs a lock per half and buys a proxy that
      can reach a backend with transit encryption enabled — which is every ElastiCache this
      platform would point it at.
    */
    let (mut upstream_read, mut upstream_write) = tokio::io::split(upstream);
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
    let mut pending: VecDeque<Pending> = VecDeque::new();
    const MAX_PENDING: usize = 8192;
    let mut mode = ConnectionMode::Normal;

    loop {
        tokio::select! {
            // Commands from the tenant: parsed, namespaced, forwarded.
            read = client_read.read_buf(&mut buffer) => {
                if read? == 0 { return Ok(()) }

                loop {
                    match parse_command(&mut buffer) {
                        Ok(Some(mut command)) => {
                            if pending.len() >= MAX_PENDING {
                                // There is no free FIFO slot for a local error, and writing it now
                                // would attach it to an earlier request. Disconnect rather than
                                // violate RESP's only request/reply correlation mechanism.
                                return Ok(())
                            }
                            let verb = command.verb();

                            if verb == "AUTH" {
                                pending.push_back(Pending::Local(error("AUTH is not allowed after authentication")));
                                drain_local(&mut pending, &mut client_write).await?;
                                continue;
                            }
                            if verb == "HELLO" {
                                let reply = match command.args.get(1).map(Vec::as_slice) {
                                    Some(b"2") => hello_two(),
                                    Some(b"3") => error("RESP3 is not supported by this proxy"),
                                    _ => error("HELLO requires protocol version 2"),
                                };
                                pending.push_back(Pending::Local(reply));
                                drain_local(&mut pending, &mut client_write).await?;
                                continue;
                            }

                            if verb == "SCAN" {
                                if let Some(reason) = scan_refusal(mode) {
                                    pending.push_back(Pending::Local(error(&format!(
                                        "SCAN is not allowed in {reason}"
                                    ))));
                                    drain_local(&mut pending, &mut client_write).await?;
                                    continue;
                                }

                                let request = match ScanRequest::parse(&command, &prefix) {
                                    Ok(request) => request,
                                    Err(reason) => {
                                        pending.push_back(Pending::Local(error(reason)));
                                        drain_local(&mut pending, &mut client_write).await?;
                                        continue;
                                    }
                                };

                                /*
                                  SCAN uses a separate administrator connection because ACL key
                                  patterns do not constrain it. That connection would otherwise
                                  race the tenant connection: `SET x 1; SCAN 0` could scan before
                                  SET. Finish every earlier reply before opening it, and do not
                                  parse the next buffered command until its reply is emitted.

                                  MATCH limits what is returned, but Valkey still walks the shared
                                  keyspace. The capped COUNT in `scan.rs` bounds each turn; it does
                                  not make scanning free.
                                */
                                drain_pending(
                                    &mut upstream_read,
                                    &mut upstream_buffer,
                                    &mut pending,
                                    &mut client_write,
                                    &prefix,
                                )
                                .await?;
                                match provisioner.scan(&request, &prefix).await {
                                    Ok(reply) => client_write.write_all(&reply).await?,
                                    Err(cause) => {
                                        warn!(tenant = %identity, %cause, "privileged SCAN failed closed");
                                        client_write
                                            .write_all(&error("SCAN is temporarily unavailable"))
                                            .await?;
                                    }
                                }
                                continue;
                            }

                            match namespace_command(&mut command.args, &prefix) {
                                Ok(namespaced_keys) => {
                                    // Use the command table's first actual key, not blindly
                                    // `args[1]`: for EVAL that argument is the script and the first
                                    // key follows `numkeys`. `queue_of` accepts both the published
                                    // BullMQ form and a Celery key the proxy just prefixed.
                                    let queue = if adds_work(&verb) {
                                        namespaced_keys.first().and_then(|key| {
                                            queue_of(&command.args[key.index], &prefix)
                                        })
                                    } else {
                                        None
                                    };
                                    upstream_write.write_all(&command.encode()).await?;
                                    let rewrite = if echoes_key(&verb) {
                                        ReplyRewrite::FirstKey {
                                            newly_prefixed: namespaced_keys
                                                .into_iter()
                                                .filter(|key| key.added_prefix)
                                                .map(|key| command.args[key.index].clone())
                                                .collect(),
                                        }
                                    } else {
                                        ReplyRewrite::None
                                    };
                                    pending.push_back(Pending::Upstream { rewrite });

                                    match verb.as_str() {
                                        "MULTI" => mode = ConnectionMode::Multi,
                                        "EXEC" | "DISCARD" => mode = ConnectionMode::Normal,
                                        // These commands are still refused by the command table.
                                        // This transition is intentionally adjacent to the
                                        // forwarding decision so admitting pub/sub later cannot
                                        // accidentally make privileged SCAN available there.
                                        "SUBSCRIBE" | "PSUBSCRIBE" => {
                                            mode = ConnectionMode::Subscribed
                                        }
                                        _ => {}
                                    }

                                    // After the forward, not before. A wake for a command the
                                    // backend never received would start a worker for a job that
                                    // does not exist.
                                    if let Some(queue) = queue {
                                        master.wake(Wake {
                                            resource: encode_short_id(identity.resource_id),
                                            queue,
                                        });
                                    }
                                }
                                Err(reason) => {
                                    // Refused, not dropped: the tenant gets an error they can act
                                    // on and the connection stays usable. Nothing is queued,
                                    // because nothing was sent.
                                    warn!(tenant = %identity, %verb, reason, "refused");
                                    pending.push_back(Pending::Local(error(reason)));
                                    drain_local(&mut pending, &mut client_write).await?;
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
                            forward_reply(
                                framed,
                                &mut upstream_buffer,
                                &mut pending,
                                &mut client_write,
                                &prefix,
                            ).await?;
                            drain_local(&mut pending, &mut client_write).await?;
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

async fn drain_pending<R, W>(
    upstream: &mut R,
    buffer: &mut BytesMut,
    pending: &mut VecDeque<Pending>,
    client: &mut W,
    prefix: &[u8],
) -> anyhow::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    drain_local(pending, client).await?;
    while !pending.is_empty() {
        match frame(buffer)? {
            Some(framed) => {
                forward_reply(framed, buffer, pending, client, prefix).await?;
                drain_local(pending, client).await?;
            }
            None => {
                anyhow::ensure!(
                    upstream.read_buf(buffer).await? > 0,
                    "backend closed while waiting at SCAN barrier"
                );
            }
        }
    }
    Ok(())
}

async fn forward_reply<W: tokio::io::AsyncWrite + Unpin>(
    framed: reply::Framed,
    buffer: &mut BytesMut,
    pending: &mut VecDeque<Pending>,
    client: &mut W,
    prefix: &[u8],
) -> anyhow::Result<()> {
    let raw = buffer.split_to(framed.len);
    let rewrite = match pending.pop_front() {
        Some(Pending::Upstream { rewrite }) => rewrite,
        _ => {
            return Err(anyhow::anyhow!(
                "backend replied without a pending upstream command"
            ));
        }
    };

    let first_bulk = framed.first_bulk.filter(|(start, end)| match &rewrite {
        ReplyRewrite::None => false,
        ReplyRewrite::FirstKey { newly_prefixed } => newly_prefixed
            .iter()
            .any(|key| key.as_slice() == &raw[*start..*end]),
    });

    match first_bulk {
        Some((start, end)) => {
            let key = &raw[start..end];
            match strip(prefix, key) {
                Some(bare) => {
                    let mut out = Vec::with_capacity(raw.len());
                    out.extend_from_slice(&raw[..start - header_len(key.len())]);
                    out.extend_from_slice(format!("${}\r\n", bare.len()).as_bytes());
                    out.extend_from_slice(&bare);
                    out.extend_from_slice(&raw[end..]);
                    client.write_all(&out).await?;
                }
                None => client.write_all(&raw).await?,
            }
        }
        None => client.write_all(&raw).await?,
    }
    Ok(())
}

#[derive(Debug)]
enum Pending {
    Upstream { rewrite: ReplyRewrite },
    Local(Vec<u8>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectionMode {
    Normal,
    Multi,
    Subscribed,
}

fn scan_refusal(mode: ConnectionMode) -> Option<&'static str> {
    match mode {
        ConnectionMode::Normal => None,
        ConnectionMode::Multi => Some("MULTI"),
        ConnectionMode::Subscribed => Some("subscribed mode"),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ReplyRewrite {
    None,
    FirstKey { newly_prefixed: Vec<Vec<u8>> },
}

async fn drain_local<W: tokio::io::AsyncWrite + Unpin>(
    pending: &mut VecDeque<Pending>,
    writer: &mut W,
) -> std::io::Result<()> {
    while matches!(pending.front(), Some(Pending::Local(_))) {
        let Some(Pending::Local(reply)) = pending.pop_front() else {
            unreachable!()
        };
        writer.write_all(&reply).await?;
    }
    Ok(())
}

fn hello_two() -> Vec<u8> {
    b"*4\r\n$6\r\nserver\r\n$6\r\nvalkey\r\n$5\r\nproto\r\n:2\r\n".to_vec()
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
                        Ok(Authentication::Ok(tenant))
                            if tenant.identity.resource_kind == ResourceKind::Queue =>
                        {
                            client.write_all(&simple_string("OK")).await?;
                            return Ok(Some(tenant.identity));
                        }
                        Ok(Authentication::Ok(_)) => {
                            warn!(username, "authentication denied for non-queue credential");
                            client
                                .write_all(&error("WRONGPASS invalid username or password"))
                                .await?;
                            return Ok(None);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_is_only_available_in_normal_protocol_mode() {
        assert_eq!(scan_refusal(ConnectionMode::Normal), None);
        assert_eq!(scan_refusal(ConnectionMode::Multi), Some("MULTI"));
        assert_eq!(
            scan_refusal(ConnectionMode::Subscribed),
            Some("subscribed mode")
        );
    }
}
