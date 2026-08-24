//! The cache in front of Valkey, and the read behind it.

use std::time::Instant;

use redis::AsyncCommands;
use redis::aio::ConnectionManager;

use crate::route::{Route, RouteCache, route_key};

/// Resolves hostnames, remembering both answers.
pub struct Resolver {
    valkey: ConnectionManager,
    cache: RouteCache,
}

impl Resolver {
    pub fn new(valkey: ConnectionManager) -> Self {
        Self {
            valkey,
            cache: RouteCache::new(),
        }
    }

    /// Where this host goes, or `None` if nowhere.
    ///
    /// A Valkey that is down resolves to `None` rather than propagating: the alternative is that a
    /// blip on one small cache takes every customer application offline with a 502. A 404 is also
    /// wrong, but it is wrong for seconds and recovers by itself.
    ///
    /// The failure is deliberately *not* cached. Writing a negative entry on an error would turn a
    /// one-second outage into `NEGATIVE_TTL` of guaranteed 404s after Valkey came back.
    pub async fn resolve(&self, hostname: &str) -> Option<Route> {
        let now = Instant::now();

        if let Some(known) = self.cache.get(hostname, now) {
            return known;
        }

        let mut valkey = self.valkey.clone();
        let raw: Result<Option<String>, redis::RedisError> = valkey.get(route_key(hostname)).await;

        match raw {
            Ok(value) => {
                let route = value.as_deref().and_then(crate::route::parse_route);
                self.cache.put(hostname, route.clone(), now);
                route
            }
            Err(error) => {
                tracing::warn!(%error, hostname, "route lookup failed");
                None
            }
        }
    }

    /// The Valkey behind this resolver, for callers that need to read another key.
    pub fn valkey(&self) -> &ConnectionManager {
        &self.valkey
    }

    /// Drop a host from the local cache. Used when the control plane says a project is suspended,
    /// so enforcement does not wait out the positive TTL.
    pub fn invalidate(&self, hostname: &str) {
        self.cache.invalidate(hostname);
    }
}
