//! Lazy, bounded installation of per-tenant Valkey ACL users.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use anyhow::{Context, Result};
use sproutos_tenant_auth::TenantIdentity;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::acl;
use crate::reply::frame;
use crate::resp::Command;
use crate::scan::{self, ScanRequest};
use crate::upstream::{self, Upstream};

const DEFAULT_CACHE_CAPACITY: usize = 4096;

#[derive(Default)]
struct State {
    believed: HashSet<String>,
    order: VecDeque<String>,
    guards: HashMap<String, Arc<Mutex<()>>>,
}

pub struct AclProvisioner {
    backend: String,
    pub(crate) root_key: Vec<u8>,
    capacity: usize,
    state: Mutex<State>,
}

impl AclProvisioner {
    pub fn new(backend: String, root_key: impl Into<Vec<u8>>) -> Result<Self> {
        let root_key = root_key.into();
        anyhow::ensure!(
            root_key.len() >= 32,
            "VALKEY_PROXY_ACL_ROOT_KEY must contain at least 32 bytes"
        );
        Ok(Self {
            backend,
            root_key,
            capacity: DEFAULT_CACHE_CAPACITY,
            state: Mutex::new(State::default()),
        })
    }

    pub async fn self_check(&self) -> Result<()> {
        let name = "sproutos-acl-self-check";
        self.admin(&["ACL", "SETUSER", name, "reset", "off"])
            .await
            .context("Valkey ACL SETUSER self-check failed")?;
        self.admin(&["ACL", "DELUSER", name])
            .await
            .context("Valkey ACL DELUSER self-check failed")?;
        Ok(())
    }

    pub async fn connect(&self, identity: &TenantIdentity) -> Result<Upstream> {
        let credential = acl::credentials(&self.root_key, identity);
        let guard = {
            let mut state = self.state.lock().await;
            state
                .guards
                .entry(credential.username.clone())
                .or_default()
                .clone()
        };
        let _guard = guard.lock().await;

        let believed = self
            .state
            .lock()
            .await
            .believed
            .contains(&credential.username);
        if !believed {
            self.provision(identity).await?;
        }

        match upstream::connect_as(&self.backend, Some(&credential)).await {
            Ok(stream) => Ok(stream),
            Err(cause) if believed && upstream::is_wrongpass(&cause) => {
                tracing::warn!(username = %credential.username, "cached tenant ACL user was missing or stale; provisioning it once");
                self.forget(&credential.username).await;
                self.provision(identity).await?;
                upstream::connect_as(&self.backend, Some(&credential))
                    .await
                    .context("tenant ACL authentication still failed after one recovery")
            }
            Err(cause) => Err(cause),
        }
    }

    /// Runs the proxy-owned, tenant-filtered SCAN on a fresh administrator connection.
    pub async fn scan(&self, request: &ScanRequest, prefix: &[u8]) -> Result<Vec<u8>> {
        scan::execute(&self.backend, request, prefix).await
    }

    /// Grant exact tenant-scoped glob patterns before PSUBSCRIBE/PUNSUBSCRIBE.
    ///
    /// Valkey does not infer that a requested `tenant:news*` pattern is contained by the static
    /// `&tenant:*` ACL rule. It requires the subscription glob itself as a channel rule. The proxy
    /// has already prepended the immutable tenant prefix before this method is called, so adding
    /// these rules preserves the engine boundary while allowing useful pattern subscriptions.
    pub async fn allow_channel_patterns(
        &self,
        identity: &TenantIdentity,
        patterns: &[Vec<u8>],
    ) -> Result<()> {
        if patterns.is_empty() {
            return Ok(());
        }
        let prefix = crate::keyspace::prefix_for(identity);
        anyhow::ensure!(
            patterns.iter().all(|pattern| pattern.starts_with(&prefix)),
            "refusing a channel pattern outside the tenant namespace"
        );
        let mut args = vec![
            b"ACL".to_vec(),
            b"SETUSER".to_vec(),
            identity.username().into_bytes(),
        ];
        args.extend(patterns.iter().map(|pattern| {
            let mut rule = Vec::with_capacity(pattern.len() + 1);
            rule.push(b'&');
            rule.extend_from_slice(pattern);
            rule
        }));
        self.admin_bytes(args, 64 * 1024)
            .await
            .map(|_| ())
            .context("could not grant a tenant Valkey channel pattern")
    }

    pub(crate) async fn provision(&self, identity: &TenantIdentity) -> Result<()> {
        let args = acl::setuser_args(&self.root_key, identity);
        if let Err(cause) = self.admin_bytes(args, 64 * 1024).await {
            tracing::error!(username = %identity.username(), %cause, "tenant ACL provisioning failed closed");
            return Err(cause).context("could not provision the tenant Valkey ACL user");
        }
        let username = identity.username();
        let mut state = self.state.lock().await;
        if state.believed.insert(username.clone()) {
            state.order.push_back(username.clone());
        }
        while state.order.len() > self.capacity {
            if let Some(old) = state.order.pop_front() {
                state.believed.remove(&old);
                if state
                    .guards
                    .get(&old)
                    .is_some_and(|guard| Arc::strong_count(guard) == 1)
                {
                    state.guards.remove(&old);
                }
            }
        }
        Ok(())
    }

    async fn forget(&self, username: &str) {
        let mut state = self.state.lock().await;
        state.believed.remove(username);
        state.order.retain(|entry| entry != username);
    }

    async fn admin(&self, args: &[&str]) -> Result<()> {
        self.admin_reply(args, 64 * 1024).await.map(|_| ())
    }

    pub(crate) async fn admin_reply(&self, args: &[&str], maximum: usize) -> Result<Vec<u8>> {
        self.admin_bytes(
            args.iter().map(|arg| arg.as_bytes().to_vec()).collect(),
            maximum,
        )
        .await
    }

    async fn admin_bytes(&self, args: Vec<Vec<u8>>, maximum: usize) -> Result<Vec<u8>> {
        let mut stream = upstream::connect(&self.backend).await?;
        stream.write_all(&Command::new(args).encode()).await?;
        stream.flush().await?;
        let mut reply = Vec::with_capacity(128);
        let mut bulk_array_progress = None;
        loop {
            // ACL LIST is roughly 1.5 KiB per tenant. A tiny read buffer would repeatedly rescan a
            // growing multi-megabyte RESP frame during reconciliation.
            let mut bytes = [0; 64 * 1024];
            let read = stream.read(&mut bytes).await?;
            anyhow::ensure!(read > 0, "Valkey closed before answering ACL command");
            reply.extend_from_slice(&bytes[..read]);
            let complete = if reply.starts_with(b"*") {
                bulk_array_complete(&reply, &mut bulk_array_progress)?
            } else {
                frame(&reply)?.is_some()
            };
            if complete {
                break;
            }
            anyhow::ensure!(
                reply.len() < maximum,
                "Valkey ACL reply was unexpectedly large"
            );
        }
        anyhow::ensure!(
            !reply.starts_with(b"-"),
            "Valkey refused ACL command: {}",
            String::from_utf8_lossy(&reply).trim_end()
        );
        Ok(reply)
    }
}

/// Incrementally recognizes the RESP2 bulk-string array returned by `ACL LIST`.
///
/// Calling the generic frame parser after every socket read rescans the complete prefix each time;
/// at 100k measured users that turns a 152 MiB reply into quadratic work. This retains the cursor
/// after every complete item, so each byte is traversed once.
fn bulk_array_complete(bytes: &[u8], progress: &mut Option<(usize, usize)>) -> Result<bool> {
    if progress.is_none() {
        let Some(end) = find_crlf(bytes, 1) else {
            return Ok(false);
        };
        let count: usize = std::str::from_utf8(&bytes[1..end])?.parse()?;
        *progress = Some((count, end + 2));
    }
    let (remaining, cursor) = progress.as_mut().expect("progress was initialized");
    while *remaining > 0 {
        if bytes.get(*cursor) != Some(&b'$') {
            return Ok(false);
        }
        let Some(header_end) = find_crlf(bytes, *cursor + 1) else {
            return Ok(false);
        };
        let length: usize = std::str::from_utf8(&bytes[*cursor + 1..header_end])?.parse()?;
        let item_end = header_end + 2 + length;
        if item_end + 2 > bytes.len() {
            return Ok(false);
        }
        anyhow::ensure!(
            &bytes[item_end..item_end + 2] == b"\r\n",
            "ACL LIST item lacked a terminator"
        );
        *cursor = item_end + 2;
        *remaining -= 1;
    }
    Ok(true)
}

fn find_crlf(bytes: &[u8], from: usize) -> Option<usize> {
    bytes[from..]
        .windows(2)
        .position(|pair| pair == b"\r\n")
        .map(|relative| from + relative)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bulk_array_progress_survives_partial_items() {
        let mut progress = None;
        assert!(!bulk_array_complete(b"*2\r\n$5\r\nhel", &mut progress).unwrap());
        assert_eq!(progress, Some((2, 4)));
        assert!(
            bulk_array_complete(b"*2\r\n$5\r\nhello\r\n$5\r\nworld\r\n", &mut progress).unwrap()
        );
        assert_eq!(progress, Some((0, 26)));
    }
}
