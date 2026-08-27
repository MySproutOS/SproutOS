//! Control-plane authorization for the Daytona forward proxy.
//!
//! The password proves that SproutOS created the sandbox. This lookup proves that the sandbox is
//! still live. Deliberately uncached: stop and delete are security boundaries, not hints.

use async_trait::async_trait;
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use sproutos_sandbox_forward_proxy::{Authorizer, AuthzError, SandboxAuthorization, SandboxState};
use std::io;
use std::net::IpAddr;
use uuid::Uuid;

pub struct SandboxAuthorizer {
    pool: Pool,
}

/// Resolves destinations while refusing the proxy's own public addresses.
pub struct EgressResolver {
    proxy_host: String,
}

impl EgressResolver {
    pub fn new(proxy_url: &str) -> anyhow::Result<Self> {
        let url = reqwest::Url::parse(proxy_url)?;
        let proxy_host = url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("SANDBOX_FORWARD_PROXY_URL has no host"))?;
        Ok(Self {
            proxy_host: proxy_host.to_owned(),
        })
    }
}

#[async_trait]
impl sproutos_sandbox_forward_proxy::Resolver for EgressResolver {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<IpAddr>> {
        let destinations = tokio::net::lookup_host((host, port))
            .await?
            .map(|address| address.ip())
            .collect::<Vec<_>>();
        let proxy_addresses = tokio::net::lookup_host((self.proxy_host.as_str(), 443))
            .await?
            .map(|address| address.ip())
            .collect::<std::collections::BTreeSet<_>>();
        if destinations
            .iter()
            .any(|address| proxy_addresses.contains(address))
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the forward proxy cannot be its own destination",
            ));
        }
        Ok(destinations)
    }
}

impl SandboxAuthorizer {
    pub fn connect(url: &str, size: usize) -> anyhow::Result<Self> {
        let config: tokio_postgres::Config =
            sproutos_service_credentials::normalise_url(url).parse()?;
        let manager = Manager::from_config(
            config,
            sproutos_service_credentials::tls_connector()?,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        Ok(Self {
            pool: Pool::builder(manager).max_size(size).build()?,
        })
    }

    pub async fn check(&self) -> anyhow::Result<()> {
        self.pool.get().await?.query_one("select 1", &[]).await?;
        Ok(())
    }
}

#[async_trait]
impl Authorizer for SandboxAuthorizer {
    async fn lookup(&self, sandbox_id: Uuid) -> Result<Option<SandboxAuthorization>, AuthzError> {
        let client = self.pool.get().await.map_err(|_| AuthzError)?;
        let row = client
            .query_opt(
                r#"
                select s.id, s.project_id, p.organization_id, s.state
                from sandbox s
                join project p on p.id = s.project_id
                where s.id = $1
                "#,
                &[&sandbox_id],
            )
            .await
            .map_err(|_| AuthzError)?;
        let Some(row) = row else { return Ok(None) };
        let state = match row.get::<_, &str>("state") {
            "starting" => SandboxState::Starting,
            "running" => SandboxState::Running,
            "idle" => SandboxState::Idle,
            "stopped" => SandboxState::Stopped,
            "failed" => SandboxState::Failed,
            _ => return Ok(None),
        };
        Ok(Some(SandboxAuthorization {
            sandbox_id: row.get("id"),
            project_id: row.get("project_id"),
            organization_id: row.get("organization_id"),
            state,
        }))
    }
}
