//! Which database to connect onward to, for this tenant.
//!
//! The customer authenticates to this proxy with a SproutOS credential. What sits behind it is a
//! Neon endpoint with a Neon role and password the customer must never see — sealed under KMS in
//! `database_role`, which means TypeScript's `@lib/envelope` is the only thing that can open them.
//!
//! So the proxy asks. `POST /v1/internal/pg/resolve` returns the backend for a service, or 404 if
//! the service is suspended or gone. **That 404 is what makes suspension work**: Neon wakes a
//! compute on connection, so refusing to make the connection is the only thing that stops a
//! suspended database from costing money.
//!
//! ## Why this is cached and authentication is not
//!
//! `lib/rust/service-credentials` refuses to cache: a cached credential is one that keeps working
//! after a rotation, which is the single thing rotation exists to prevent. That reasoning does not
//! transfer here, and the difference is worth being precise about.
//!
//! What is cached is the **backend's** address and password, not the tenant's. Rotating a customer's
//! secret does not change Neon's password, so a stale entry cannot let a revoked customer in — the
//! authentication above has already happened against the live table by the time this is consulted.
//! What a stale entry *can* do is briefly let a just-suspended service connect, which is why the
//! TTL is seconds rather than minutes.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::{BackendConfig, SessionError};

/// How long a resolved backend is reused.
///
/// Short on purpose. The upper bound on this number is how long a suspended service may still
/// accept connections; the lower bound is how much load the control plane should take on a busy
/// proxy. Fifteen seconds is a connection-rate problem, not a per-query one — this is consulted
/// once per connection, and tenant connections are long-lived.
const CACHE_TTL: Duration = Duration::from_secs(15);

/// How long to wait for the control plane before giving up on a connection.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct ResolveConfig {
    /// e.g. `http://internal-api:3001/v1/internal/pg/resolve`.
    pub url: String,
}

/// Read the resolver endpoint from the environment, if there is one.
///
/// `None` means this deployment has no per-tenant backends and every connection goes to the shared
/// cluster configured by `PG_PROXY_BACKEND_*`. That is what keeps `provider = 'sprout'` databases
/// working while `neon` is rolled out, and it is a deliberate default: a proxy that refused to start
/// without a resolver would take every existing tenant down the day it shipped.
pub fn resolve_config_from_env() -> Option<ResolveConfig> {
    let url = std::env::var("PG_PROXY_RESOLVE_URL").ok()?;
    if url.is_empty() {
        None
    } else {
        Some(ResolveConfig { url })
    }
}

#[derive(Serialize)]
struct ResolveRequest<'a> {
    backend_service_id: &'a str,
    /// Omitted for an ordinary credential, which the control plane reads as "the primary branch".
    #[serde(skip_serializing_if = "Option::is_none")]
    database_branch_id: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ResolvedBackend {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub role: String,
    pub password: String,
}

/// The key one resolved backend is remembered under.
///
/// Extracted so the property that matters can be asserted directly: a branch credential and an
/// ordinary one for the same service must never share an entry. Inlined, that invariant was a
/// `format!` in the middle of a function that only runs against a live control plane, which is to
/// say it was untested.
fn cache_key(backend_service_id: &str, database_branch_id: Option<uuid::Uuid>) -> String {
    match database_branch_id {
        Some(branch) => format!("{backend_service_id}:{branch}"),
        None => backend_service_id.to_owned(),
    }
}

struct CacheEntry {
    backend: Option<ResolvedBackend>,
    fetched: Instant,
}

/// Resolves and caches tenant backends.
#[derive(Clone)]
pub struct Resolver {
    client: reqwest::Client,
    config: ResolveConfig,
    cache: Arc<RwLock<HashMap<String, CacheEntry>>>,
}

impl Resolver {
    pub fn new(client: reqwest::Client, config: ResolveConfig) -> Self {
        Self {
            client,
            config,
            cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// The backend for a service, or `None` when the control plane has none.
    ///
    /// `None` is cached as well as `Some`. A service with no Neon database is the common case
    /// during the rollout, and re-asking on every connection to a `sprout` tenant would put a round
    /// trip on the path of every connection that does not need one.
    pub async fn resolve(
        &self,
        backend_service_id: &str,
        database_branch_id: Option<uuid::Uuid>,
    ) -> Result<Option<ResolvedBackend>, SessionError> {
        /*
          **The branch is part of the cache key, not just the request.**

          This cache was keyed on the service alone, which was correct while a service had exactly
          one reachable backend. It stops being correct the moment a credential can name a branch:
          a developer connecting to their ephemeral branch would be handed whatever backend the last
          lookup for that service cached — the primary — and would read and write production while
          believing they were on a branch. That is a data leak that leaves no trace, because every
          component involved behaves exactly as designed.
        */
        let cache_key = cache_key(backend_service_id, database_branch_id);

        if let Some(entry) = self.cache.read().await.get(&cache_key)
            && entry.fetched.elapsed() < CACHE_TTL
        {
            return Ok(entry.backend.clone());
        }

        let response = self
            .client
            .post(&self.config.url)
            .timeout(RESOLVE_TIMEOUT)
            .json(&ResolveRequest {
                backend_service_id,
                database_branch_id: database_branch_id.map(|id| id.to_string()),
            })
            .send()
            .await
            .map_err(|error| {
                SessionError::Backend(format!("could not reach the control plane: {error}"))
            })?;

        let backend = if response.status() == reqwest::StatusCode::NOT_FOUND {
            // Suspended, deleted, or not a Neon database. All three mean "do not connect to a
            // per-tenant backend", and the proxy must not be able to tell them apart.
            None
        } else if response.status().is_success() {
            Some(response.json::<ResolvedBackend>().await.map_err(|error| {
                SessionError::Backend(format!("unreadable resolve response: {error}"))
            })?)
        } else {
            /*
                Reported as a backend problem rather than an authentication one.

                Every Postgres driver treats an authentication error as fatal and stops; a server
                error is retried. A control plane that is briefly down should produce reconnecting
                clients, not clients that give up and page someone.
            */
            return Err(SessionError::Backend(format!(
                "the control plane could not resolve a backend: {}",
                response.status()
            )));
        };

        self.cache.write().await.insert(
            cache_key,
            CacheEntry {
                backend: backend.clone(),
                fetched: Instant::now(),
            },
        );

        Ok(backend)
    }
}

impl ResolvedBackend {
    /// The proxy's backend configuration for this tenant.
    pub fn as_backend_config(&self) -> BackendConfig {
        BackendConfig {
            host: self.host.clone(),
            port: self.port,
            user: self.role.clone(),
            password: self.password.clone(),
            // A resolved backend is managed Postgres over the internet. Plaintext there is every
            // tenant's rows on the wire, and Neon refuses it outright in any case.
            require_tls: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_absent_unless_configured() {
        // The default has to be "do nothing": a proxy that refused to start without a resolver
        // would take every `sprout` tenant down the day it shipped.
        unsafe { std::env::remove_var("PG_PROXY_RESOLVE_URL") };
        assert!(resolve_config_from_env().is_none());

        unsafe { std::env::set_var("PG_PROXY_RESOLVE_URL", "") };
        // An empty value is how an unset variable arrives through most deployment tooling.
        assert!(resolve_config_from_env().is_none());

        unsafe { std::env::set_var("PG_PROXY_RESOLVE_URL", "http://api/v1/internal/pg/resolve") };
        assert!(resolve_config_from_env().is_some());
    }

    /// A branch credential must not be served the primary's cached backend.
    ///
    /// This is the whole reason the branch is in the key. Without it a developer on an ephemeral
    /// branch reads and writes production, every component behaves as designed, and nothing logs
    /// anything unusual.
    #[test]
    fn branch_and_primary_do_not_share_a_cache_entry() {
        let service = "6f1c3a2e-0000-7000-8000-000000000001";
        let branch = uuid::Uuid::parse_str("6f1c3a2e-0000-7000-8000-0000000000bb").unwrap();

        assert_ne!(cache_key(service, None), cache_key(service, Some(branch)));
    }

    /// Two different branches of one service are also distinct.
    #[test]
    fn two_branches_do_not_share_a_cache_entry() {
        let service = "6f1c3a2e-0000-7000-8000-000000000001";
        let one = uuid::Uuid::parse_str("6f1c3a2e-0000-7000-8000-0000000000b1").unwrap();
        let two = uuid::Uuid::parse_str("6f1c3a2e-0000-7000-8000-0000000000b2").unwrap();

        assert_ne!(cache_key(service, Some(one)), cache_key(service, Some(two)));
    }

    /// No branch keeps the key it always had, so existing entries are not invalidated.
    #[test]
    fn primary_key_is_the_bare_service_id() {
        let service = "6f1c3a2e-0000-7000-8000-000000000001";
        assert_eq!(cache_key(service, None), service);
        unsafe { std::env::remove_var("PG_PROXY_RESOLVE_URL") };
    }

    #[test]
    fn the_cache_is_short_enough_to_bound_a_suspension() {
        // The upper bound on this number is how long a suspended service may still accept
        // connections. Minutes would make `suspend` a suggestion.
        assert!(CACHE_TTL <= Duration::from_secs(30));
    }
}
