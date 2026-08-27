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
    root_key: Vec<u8>,
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

    async fn provision(&self, identity: &TenantIdentity) -> Result<()> {
        let args = acl::setuser_args(&self.root_key, identity);
        if let Err(cause) = self.admin_bytes(args).await {
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
        self.admin_bytes(args.iter().map(|arg| arg.as_bytes().to_vec()).collect())
            .await
    }

    async fn admin_bytes(&self, args: Vec<Vec<u8>>) -> Result<()> {
        let mut stream = upstream::connect(&self.backend).await?;
        stream.write_all(&Command::new(args).encode()).await?;
        stream.flush().await?;
        let mut reply = Vec::with_capacity(128);
        loop {
            let mut bytes = [0; 256];
            let read = stream.read(&mut bytes).await?;
            anyhow::ensure!(read > 0, "Valkey closed before answering ACL command");
            reply.extend_from_slice(&bytes[..read]);
            if frame(&reply)?.is_some() {
                break;
            }
            anyhow::ensure!(
                reply.len() < 64 * 1024,
                "Valkey ACL reply was unexpectedly large"
            );
        }
        anyhow::ensure!(
            !reply.starts_with(b"-"),
            "Valkey refused ACL command: {}",
            String::from_utf8_lossy(&reply).trim_end()
        );
        Ok(())
    }
}
