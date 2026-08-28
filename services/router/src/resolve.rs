//! The cache in front of Valkey, and the durable read behind it.

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use redis::AsyncCommands;
use redis::aio::ConnectionManager;

use crate::route::{Route, RouteCache, normalise_host, route_key};

const ROUTE_TTL: u64 = 24 * 60 * 60;
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);

#[async_trait]
pub trait DurableRoutes: Send + Sync {
    /// Resolve one normalized or normalizable hostname from the durable control plane.
    async fn lookup(&self, hostname: &str) -> anyhow::Result<Option<Route>>;
}

#[async_trait]
pub trait CachedRoutes: Send + Sync {
    /// Read the serialized route for a hostname.
    async fn get(&self, hostname: &str) -> anyhow::Result<Option<String>>;
    /// Restore a durable route into the hot cache.
    async fn put(&self, hostname: &str, route: &Route) -> anyhow::Result<()>;
}

#[async_trait]
impl CachedRoutes for ConnectionManager {
    async fn get(&self, hostname: &str) -> anyhow::Result<Option<String>> {
        let mut connection = self.clone();
        let raw = AsyncCommands::get(&mut connection, route_key(hostname)).await?;
        Ok(raw)
    }

    async fn put(&self, hostname: &str, route: &Route) -> anyhow::Result<()> {
        let mut connection = self.clone();
        let encoded = serde_json::to_string(route)?;
        connection
            .set_ex::<_, _, ()>(route_key(hostname), encoded, ROUTE_TTL)
            .await?;
        Ok(())
    }
}

/// Reads the route that owns a hostname from the control-plane database.
pub struct PostgresRoutes {
    pool: Pool,
    region: String,
    account_id: String,
}

impl PostgresRoutes {
    pub fn connect(
        url: &str,
        size: usize,
        region: String,
        account_id: String,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(size > 0, "ROUTER_ROUTE_DB_POOL must be positive");
        anyhow::ensure!(
            !region.is_empty(),
            "AWS_REGION is required for route fallback"
        );
        anyhow::ensure!(
            !account_id.is_empty(),
            "AWS_ACCOUNT_ID is required for route fallback"
        );
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
            region,
            account_id,
        })
    }

    /// Check the durable half at boot. A router without it would pass health checks and quietly
    /// reintroduce the 24-hour expiry whenever the refresher missed enough runs.
    pub async fn check(&self) -> anyhow::Result<()> {
        let client = tokio::time::timeout(LOOKUP_TIMEOUT, self.pool.get()).await??;
        tokio::time::timeout(LOOKUP_TIMEOUT, client.query_one("select 1", &[])).await??;
        Ok(())
    }

    pub fn pool(&self) -> Pool {
        self.pool.clone()
    }
}

const LOOKUP_SQL: &str = r#"
    select p.id::text as project_id,
           p.organization_id::text as organization_id,
           d.id::text as deployment_id
      from project p
      join organization o on o.id = p.organization_id
      join deployment d on d.id = p.live_deployment_id
     where p.deleted_at is null
       and p.is_group = false
       and o.deleted_at is null
       and d.deleted_at is null
       and d.status = 'ready'
       and d.kind = 'production'
       and d.lambda_version is not null
       and (
         d.hostname = $1
         or exists (
           select 1
             from custom_domain cd
            where cd.project_id = p.id
              and cd.organization_id = p.organization_id
              and cd.status = 'active'
              and cd.deleted_at is null
              and (
                cd.hostname = $1
                or (cd.is_apex and ('www.' || cd.hostname) = $1)
              )
         )
       )
     limit 2
"#;

#[async_trait]
impl DurableRoutes for PostgresRoutes {
    async fn lookup(&self, hostname: &str) -> anyhow::Result<Option<Route>> {
        let hostname = normalise_host(hostname);
        let client = tokio::time::timeout(LOOKUP_TIMEOUT, self.pool.get()).await??;
        let rows =
            tokio::time::timeout(LOOKUP_TIMEOUT, client.query(LOOKUP_SQL, &[&hostname])).await??;

        anyhow::ensure!(
            rows.len() <= 1,
            "hostname {hostname} belongs to more than one live project"
        );
        Ok(rows.first().map(|row| {
            let project_id: String = row.get("project_id");
            Route {
                arn: format!(
                    "arn:aws:lambda:{}:{}:function:sproutos-app-{}:live",
                    self.region, self.account_id, project_id
                ),
                project_id,
                organization_id: row.get("organization_id"),
                deployment_id: row.get("deployment_id"),
            }
        }))
    }
}

/// Resolves hostnames, remembering both answers.
pub struct Resolver<C = ConnectionManager, D = PostgresRoutes> {
    valkey: C,
    durable: Arc<D>,
    cache: RouteCache,
}

impl Resolver {
    pub fn new(valkey: ConnectionManager, durable: Arc<PostgresRoutes>) -> Self {
        Self {
            valkey,
            durable,
            cache: RouteCache::new(),
        }
    }

    /// The Valkey behind this resolver, for callers that need to read another key.
    pub fn valkey(&self) -> &ConnectionManager {
        &self.valkey
    }
}

impl<C, D> Resolver<C, D>
where
    C: CachedRoutes,
    D: DurableRoutes,
{
    #[cfg(test)]
    fn with_stores(valkey: C, durable: Arc<D>) -> Self {
        Self {
            valkey,
            durable,
            cache: RouteCache::new(),
        }
    }

    /// Where this host goes, or `None` if nowhere.
    ///
    /// A Valkey error still fails open to 404 and deliberately does not touch Postgres: otherwise a
    /// cache outage moves the full request rate onto the control plane. Only a clean cache miss
    /// reads through. A durable lookup error also fails closed and is not negatively cached, so the
    /// next request can recover immediately.
    pub async fn resolve(&self, hostname: &str) -> Option<Route> {
        let now = Instant::now();

        if let Some(known) = self.cache.get(hostname, now) {
            return known;
        }

        match self.valkey.get(hostname).await {
            Ok(Some(raw)) => {
                if let Some(route) = crate::route::parse_route(&raw) {
                    self.cache.put(hostname, Some(route.clone()), now);
                    return Some(route);
                }
                tracing::warn!(
                    hostname,
                    "cached route was malformed; reading durable route"
                );
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%error, hostname, "route cache lookup failed");
                return None;
            }
        }

        let route = match self.durable.lookup(hostname).await {
            Ok(route) => route,
            Err(error) => {
                tracing::error!(%error, hostname, "durable route lookup failed");
                return None;
            }
        };

        if let Some(found) = route.as_ref()
            && let Err(error) = self.valkey.put(hostname, found).await
        {
            tracing::warn!(%error, hostname, "route cache backfill failed");
        }
        self.cache.put(hostname, route.clone(), now);
        route
    }

    pub fn invalidate(&self, hostname: &str) {
        self.cache.invalidate(hostname);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct FakeCache {
        values: Mutex<HashMap<String, String>>,
        read_unavailable: bool,
        write_unavailable: bool,
    }

    #[async_trait]
    impl CachedRoutes for FakeCache {
        async fn get(&self, hostname: &str) -> anyhow::Result<Option<String>> {
            anyhow::ensure!(!self.read_unavailable, "cache unavailable");
            Ok(self
                .values
                .lock()
                .unwrap()
                .get(&normalise_host(hostname))
                .cloned())
        }

        async fn put(&self, hostname: &str, route: &Route) -> anyhow::Result<()> {
            anyhow::ensure!(!self.write_unavailable, "cache unavailable");
            self.values
                .lock()
                .unwrap()
                .insert(normalise_host(hostname), serde_json::to_string(route)?);
            Ok(())
        }
    }

    struct FakeDurable {
        values: HashMap<String, Route>,
        unavailable: bool,
        lookups: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl DurableRoutes for FakeDurable {
        async fn lookup(&self, hostname: &str) -> anyhow::Result<Option<Route>> {
            self.lookups.lock().unwrap().push(normalise_host(hostname));
            anyhow::ensure!(!self.unavailable, "database unavailable");
            Ok(self.values.get(&normalise_host(hostname)).cloned())
        }
    }

    fn route(project: &str, organization: &str) -> Route {
        Route {
            arn: format!("arn:aws:lambda:us-east-1:1:function:sproutos-app-{project}:live"),
            project_id: project.into(),
            organization_id: organization.into(),
            deployment_id: format!("deployment-{project}"),
        }
    }

    fn durable(entries: &[(&str, Route)]) -> Arc<FakeDurable> {
        Arc::new(FakeDurable {
            values: entries
                .iter()
                .map(|(host, route)| ((*host).into(), route.clone()))
                .collect(),
            unavailable: false,
            lookups: Mutex::new(Vec::new()),
        })
    }

    #[tokio::test]
    async fn a_clean_cache_miss_reads_postgres_and_backfills() {
        let expected = route("project-a", "org-a");
        let durable = durable(&[("a.sproutos.run", expected.clone())]);
        let resolver = Resolver::with_stores(FakeCache::default(), Arc::clone(&durable));

        assert_eq!(
            resolver.resolve("A.SPROUTOS.RUN:443").await,
            Some(expected.clone())
        );
        assert_eq!(
            durable.lookups.lock().unwrap().as_slice(),
            ["a.sproutos.run"]
        );
        let backfilled = resolver
            .valkey
            .values
            .lock()
            .unwrap()
            .get("a.sproutos.run")
            .cloned()
            .unwrap();
        assert_eq!(crate::route::parse_route(&backfilled), Some(expected));
    }

    #[tokio::test]
    async fn an_unknown_host_is_negative_cached_without_cross_tenant_fallback() {
        let tenant_a = route("project-a", "org-a");
        let durable = durable(&[("a.sproutos.run", tenant_a)]);
        let resolver = Resolver::with_stores(FakeCache::default(), Arc::clone(&durable));

        assert_eq!(resolver.resolve("b.sproutos.run").await, None);
        assert_eq!(resolver.resolve("b.sproutos.run").await, None);
        assert_eq!(
            durable.lookups.lock().unwrap().as_slice(),
            ["b.sproutos.run"]
        );
        assert!(
            !resolver
                .valkey
                .values
                .lock()
                .unwrap()
                .contains_key("b.sproutos.run")
        );
    }

    #[tokio::test]
    async fn database_failure_fails_closed_and_is_not_cached() {
        let durable = Arc::new(FakeDurable {
            values: HashMap::new(),
            unavailable: true,
            lookups: Mutex::new(Vec::new()),
        });
        let resolver = Resolver::with_stores(FakeCache::default(), Arc::clone(&durable));

        assert_eq!(resolver.resolve("a.sproutos.run").await, None);
        assert_eq!(resolver.resolve("a.sproutos.run").await, None);
        assert_eq!(durable.lookups.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn valkey_failure_does_not_stampede_postgres() {
        let durable = durable(&[("a.sproutos.run", route("project-a", "org-a"))]);
        let resolver = Resolver::with_stores(
            FakeCache {
                read_unavailable: true,
                ..FakeCache::default()
            },
            Arc::clone(&durable),
        );

        assert_eq!(resolver.resolve("a.sproutos.run").await, None);
        assert!(durable.lookups.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn failed_backfill_does_not_discard_the_durable_answer() {
        let expected = route("project-a", "org-a");
        let durable = durable(&[("a.sproutos.run", expected.clone())]);
        let resolver = Resolver::with_stores(
            FakeCache {
                write_unavailable: true,
                ..FakeCache::default()
            },
            durable,
        );

        assert_eq!(resolver.resolve("a.sproutos.run").await, Some(expected));
    }

    #[tokio::test]
    async fn malformed_cache_content_is_repaired_from_postgres() {
        let expected = route("project-a", "org-a");
        let durable = durable(&[("a.sproutos.run", expected.clone())]);
        let cache = FakeCache::default();
        cache
            .values
            .lock()
            .unwrap()
            .insert("a.sproutos.run".into(), "not-json".into());
        let resolver = Resolver::with_stores(cache, durable);

        assert_eq!(
            resolver.resolve("a.sproutos.run").await,
            Some(expected.clone())
        );
        let repaired = resolver
            .valkey
            .values
            .lock()
            .unwrap()
            .get("a.sproutos.run")
            .cloned()
            .unwrap();
        assert_eq!(crate::route::parse_route(&repaired), Some(expected));
    }

    #[test]
    fn postgres_lookup_binds_hostname_to_one_live_owned_deployment() {
        for predicate in [
            "join organization o on o.id = p.organization_id",
            "join deployment d on d.id = p.live_deployment_id",
            "where cd.project_id = p.id",
            "cd.organization_id = p.organization_id",
            "cd.status = 'active'",
            "p.deleted_at is null",
            "p.is_group = false",
            "o.deleted_at is null",
            "d.deleted_at is null",
            "d.status = 'ready'",
            "d.kind = 'production'",
            "d.lambda_version is not null",
            "d.hostname = $1",
            "cd.hostname = $1",
            "limit 2",
        ] {
            assert!(
                LOOKUP_SQL.contains(predicate),
                "missing isolation predicate: {predicate}"
            );
        }
    }
}
