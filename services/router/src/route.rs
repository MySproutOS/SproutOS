//! Resolving a `Host` header to the Lambda that serves it.
//!
//! This runs on every request, so it is the one piece of platform state that had to leave Postgres.
//! The control plane writes `route:<hostname>` into the platform Valkey (ElastiCache) when a
//! deployment goes live; this only ever reads.
//!
//! The wire format is one string key holding JSON, matching `lib/typescript/lambda/src/routes.ts`.
//! It is deliberately dumb because two languages parse it and every cleverness on one side is a
//! divergence waiting on the other.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Where a hostname goes. Field names match the TypeScript writer exactly.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Route {
    /// The alias ARN, so we invoke whatever `live` currently points at.
    pub arn: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "organizationId")]
    pub organization_id: String,
    #[serde(rename = "deploymentId")]
    pub deployment_id: String,
}

/// How long a resolved route may be served from memory before Valkey is asked again.
///
/// Short, because this is the window in which a suspended project keeps serving. Withdrawing the
/// key is the enforcement point for suspension, and a cache that outlived the withdrawal by minutes
/// would mean a customer with no credit still costing money.
pub const POSITIVE_TTL: Duration = Duration::from_secs(10);

/// How long an *absent* route is remembered.
///
/// Without this, a scan of a thousand hostnames is a thousand Valkey round trips, and the cheapest
/// way to hurt the platform is to ask it about hosts that do not exist. Shorter than the positive
/// TTL because it is the delay a customer sees on a first deploy — the window where their app is
/// live and the router still says it is not.
pub const NEGATIVE_TTL: Duration = Duration::from_secs(2);

/// The key the control plane writes. Lowercased: DNS is case-insensitive, `Host` is whatever the
/// client typed, and writing one case while reading another is a 404 nobody can reproduce.
pub fn route_key(hostname: &str) -> String {
    format!("route:{}", normalise_host(hostname))
}

/// The hostname a `Host` header means, with the port and trailing dot removed.
///
/// A `Host` of `myapp.sproutos.me:443` is the same host as `myapp.sproutos.me`, and a
/// fully-qualified `myapp.sproutos.me.` is too. All three have to hit one key or a route resolves
/// for some clients and not others.
pub fn normalise_host(hostname: &str) -> String {
    let without_port = hostname.split(':').next().unwrap_or(hostname);
    without_port.trim_end_matches('.').to_ascii_lowercase()
}

/// Parse what Valkey held. An unparseable value is *absent*, not an error.
///
/// Something that is not the control plane wrote the key. A 404 is recoverable; a 500 on every
/// request to that host until somebody notices is not — and the TypeScript reader makes the same
/// choice, so the two agree about what a corrupt key means.
pub fn parse_route(raw: &str) -> Option<Route> {
    serde_json::from_str(raw).ok()
}

#[derive(Debug, Clone)]
struct Entry {
    route: Option<Route>,
    expires: Instant,
}

/// A per-process cache in front of Valkey, holding hits and misses alike.
///
/// A `Mutex<HashMap>` rather than anything cleverer: entries are read far more than written, the
/// critical section is a hash lookup, and a lock-free structure here would be optimising the part
/// of the request that is already nanoseconds next to a Lambda invocation.
#[derive(Debug)]
pub struct RouteCache {
    entries: Mutex<HashMap<String, Entry>>,
}

impl Default for RouteCache {
    fn default() -> Self {
        Self::new()
    }
}

impl RouteCache {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// What we believe about this host, or `None` if we have to ask Valkey.
    ///
    /// The two-level option is load-bearing: the outer says whether the cache knows, the inner says
    /// whether a route exists. Collapsing them would make a cached miss indistinguishable from a
    /// cache miss, and the negative cache would never be consulted.
    pub fn get(&self, hostname: &str, now: Instant) -> Option<Option<Route>> {
        let key = normalise_host(hostname);
        let mut entries = self.entries.lock().expect("route cache poisoned");

        match entries.get(&key) {
            Some(entry) if entry.expires > now => Some(entry.route.clone()),
            Some(_) => {
                // Drop it rather than leave it: an expired entry for a host nobody asks about again
                // is a leak, and this is the only moment we are certain it is dead.
                entries.remove(&key);
                None
            }
            None => None,
        }
    }

    /// Record what Valkey said, hit or miss.
    pub fn put(&self, hostname: &str, route: Option<Route>, now: Instant) {
        let ttl = if route.is_some() {
            POSITIVE_TTL
        } else {
            NEGATIVE_TTL
        };
        let mut entries = self.entries.lock().expect("route cache poisoned");
        entries.insert(
            normalise_host(hostname),
            Entry {
                route,
                expires: now + ttl,
            },
        );
    }

    /// Forget a host immediately. The control plane calls this path on suspension and teardown, so
    /// enforcement does not have to wait out the positive TTL.
    pub fn invalidate(&self, hostname: &str) {
        let mut entries = self.entries.lock().expect("route cache poisoned");
        entries.remove(&normalise_host(hostname));
    }

    pub fn len(&self) -> usize {
        self.entries.lock().expect("route cache poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route() -> Route {
        Route {
            arn: "arn:aws:lambda:us-east-1:0:function:sproutos-app-x:live".into(),
            project_id: "p".into(),
            organization_id: "o".into(),
            deployment_id: "d".into(),
        }
    }

    #[test]
    fn parses_what_the_control_plane_writes() {
        // Verbatim from `publishRoute`: camelCase keys, because that is what the TypeScript side
        // emits and a rename here is a route that never resolves in production.
        let raw = r#"{"arn":"arn:aws:lambda:us-east-1:0:function:sproutos-app-x:live",
                      "projectId":"p","organizationId":"o","deploymentId":"d"}"#;

        assert_eq!(parse_route(raw), Some(route()));
    }

    #[test]
    fn treats_an_unparseable_value_as_absent() {
        assert_eq!(parse_route("{not json"), None);
        assert_eq!(parse_route(""), None);
        // Right shape, missing a field: still absent rather than a partial route we would then
        // invoke with an empty ARN.
        assert_eq!(parse_route(r#"{"arn":"a"}"#), None);
    }

    #[test]
    fn one_host_has_one_key_however_it_was_written() {
        let expected = "route:myapp.sproutos.me";

        assert_eq!(route_key("myapp.sproutos.me"), expected);
        assert_eq!(route_key("MyApp.SproutOS.me"), expected);
        // A `Host` header carries the port when it is not the scheme default.
        assert_eq!(route_key("myapp.sproutos.me:443"), expected);
        // And a fully-qualified name has a trailing dot.
        assert_eq!(route_key("myapp.sproutos.me."), expected);
    }

    #[test]
    fn a_cached_miss_is_not_a_cache_miss() {
        let cache = RouteCache::new();
        let now = Instant::now();

        // Nothing known yet: the caller must ask Valkey.
        assert!(cache.get("nope.sproutos.me", now).is_none());

        cache.put("nope.sproutos.me", None, now);

        // Now the cache knows there is no route, and says so without a round trip. If these two
        // states were one, the negative cache would never be consulted and a scan of unknown hosts
        // would be a Valkey read per request.
        assert_eq!(cache.get("nope.sproutos.me", now), Some(None));
    }

    #[test]
    fn a_hit_expires_sooner_than_the_control_planes_own_ttl() {
        let cache = RouteCache::new();
        let now = Instant::now();
        cache.put("myapp.sproutos.me", Some(route()), now);

        assert_eq!(cache.get("myapp.sproutos.me", now), Some(Some(route())));

        // Just inside.
        let inside = now + POSITIVE_TTL - Duration::from_millis(1);
        assert_eq!(cache.get("myapp.sproutos.me", inside), Some(Some(route())));

        // Past it, and the entry is gone rather than merely ignored — an expired route for a host
        // nobody asks about again would otherwise sit in the map forever.
        let outside = now + POSITIVE_TTL + Duration::from_millis(1);
        assert!(cache.get("myapp.sproutos.me", outside).is_none());
        assert!(cache.is_empty());
    }

    #[test]
    fn a_miss_is_forgotten_sooner_than_a_hit() {
        // The asymmetry matters: the negative TTL is the delay a customer sees between their first
        // deploy going live and the router admitting it exists.
        assert!(NEGATIVE_TTL < POSITIVE_TTL);

        let cache = RouteCache::new();
        let now = Instant::now();
        cache.put("nope.sproutos.me", None, now);

        let after = now + NEGATIVE_TTL + Duration::from_millis(1);
        assert!(cache.get("nope.sproutos.me", after).is_none());
    }

    #[test]
    fn invalidation_does_not_wait_out_the_ttl() {
        // Suspension is enforced by withdrawing the route, so a cache that made the operator wait
        // ten seconds would be ten seconds of a customer with no credit still costing money.
        let cache = RouteCache::new();
        let now = Instant::now();
        cache.put("myapp.sproutos.me", Some(route()), now);

        cache.invalidate("MYAPP.SPROUTOS.ME:443");

        assert!(cache.get("myapp.sproutos.me", now).is_none());
    }
}
