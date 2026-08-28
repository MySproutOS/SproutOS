//! OpenSearch's second, server-enforced tenant boundary.
//!
//! The HTTP proxy still rewrites names. This module gives the identity established there a
//! Security-plugin role whose index pattern is the same prefix, so a missed request shape is
//! refused by OpenSearch rather than becoming a cross-tenant read.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use reqwest::StatusCode;
use serde_json::json;
use sha2::{Digest, Sha256};
use sproutos_tenant_auth::TenantIdentity;
use tokio::sync::Mutex;

const MANAGER_USER: &str = "sproutos_search_proxy_manager";
const SECURITY_PUT_MAX_ATTEMPTS: usize = 4;
const SECURITY_PUT_BASE_BACKOFF_MS: u64 = 20;
const ALPHABET: &[u8] = b"0123456789abcdefghjkmnpqrstvwxyz";
type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub struct SecurityManager {
    inner: Arc<Inner>,
}

struct Inner {
    client: reqwest::Client,
    upstream: String,
    root_key: Vec<u8>,
    ready: Mutex<HashSet<String>>,
}

#[derive(Debug, thiserror::Error)]
pub enum SecurityError {
    #[error("SEARCH_PROXY_SECURITY_ROOT_KEY must contain at least 32 bytes")]
    WeakRootKey,
    #[error("OpenSearch security provisioning did not respond")]
    Unreachable(#[source] reqwest::Error),
    #[error("OpenSearch security provisioning refused {resource} with HTTP {status}")]
    Refused {
        resource: &'static str,
        status: StatusCode,
    },
    #[error("OpenSearch security provisioning returned an invalid response")]
    InvalidResponse(#[source] reqwest::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TenantSecurityIdentity {
    pub user: String,
    pub role: String,
    pub password: String,
    pub index_prefix: String,
}

impl SecurityManager {
    pub fn new(
        client: reqwest::Client,
        upstream: String,
        root_key: String,
    ) -> Result<Self, SecurityError> {
        if root_key.len() < 32 {
            return Err(SecurityError::WeakRootKey);
        }
        Ok(Self {
            inner: Arc::new(Inner {
                client,
                upstream,
                root_key: root_key.into_bytes(),
                ready: Mutex::new(HashSet::new()),
            }),
        })
    }

    /// Ensures the exact role, internal user, and role mapping exist before a tenant request is
    /// allowed to reach OpenSearch. PUT is deliberately used: two router instances racing on a
    /// tenant converge on identical documents.
    pub async fn ensure(
        &self,
        tenant: &TenantIdentity,
        prefix: &str,
    ) -> Result<TenantSecurityIdentity, SecurityError> {
        let identity = self.credentials_for(tenant, prefix);

        let mut ready = self.inner.ready.lock().await;
        if ready.contains(prefix) {
            return Ok(identity);
        }

        self.put(
            "role",
            &format!("roles/{}", identity.role),
            json!({
                "cluster_permissions": ["cluster_composite_ops", "cluster:monitor/main"],
                "index_permissions": [{
                    "index_patterns": [format!("{prefix}*")],
                    "allowed_actions": [
                        "read", "write", "create_index", "indices_monitor",
                        "indices:admin/refresh", "indices:admin/flush",
                        "indices:admin/forcemerge", "indices:admin/analyze"
                    ]
                }],
                "tenant_permissions": []
            }),
        )
        .await?;

        self.put(
            "internal user",
            &format!("internalusers/{}", identity.user),
            json!({
                "password": identity.password,
                "backend_roles": [identity.role],
                "attributes": {
                    "sproutos_managed": "search-v1",
                    "sproutos_credential_sha256": format!(
                        "{:x}",
                        Sha256::digest(identity.password.as_bytes())
                    )
                }
            }),
        )
        .await?;

        self.put(
            "role mapping",
            &format!("rolesmapping/{}", identity.role),
            json!({
                "backend_roles": [identity.role],
                "hosts": [],
                "users": [identity.user]
            }),
        )
        .await?;

        ready.insert(prefix.to_owned());
        Ok(identity)
    }

    /// Forget only the local success marker. OpenSearch remains the source of truth: the next
    /// `ensure` idempotently recreates all three documents before another tenant request is sent.
    pub async fn invalidate(&self, prefix: &str) {
        self.inner.ready.lock().await.remove(prefix);
    }

    /// Enumerate only users explicitly marked as ours. The storage meter uses this instead of
    /// trusting index names or tenant input for billing attribution.
    pub async fn managed_tenants(&self) -> Result<Vec<TenantIdentity>, SecurityError> {
        let url = format!(
            "{}/_plugins/_security/api/internalusers",
            self.inner.upstream.trim_end_matches('/')
        );
        let users = self
            .inner
            .client
            .get(url)
            .basic_auth(
                MANAGER_USER,
                Some(String::from_utf8_lossy(&self.inner.root_key)),
            )
            .send()
            .await
            .map_err(SecurityError::Unreachable)?
            .error_for_status()
            .map_err(SecurityError::InvalidResponse)?
            .json::<serde_json::Map<String, serde_json::Value>>()
            .await
            .map_err(SecurityError::InvalidResponse)?;
        Ok(users
            .into_iter()
            .filter(|(_, document)| document["attributes"]["sproutos_managed"] == "search-v1")
            .filter_map(|(username, _)| username.parse::<TenantIdentity>().ok())
            .filter(|tenant| {
                tenant.resource_kind == sproutos_tenant_auth::ResourceKind::SearchIndex
            })
            .collect())
    }

    /// Reconstruct credentials for a user returned by [`Self::managed_tenants`] without mutating
    /// cluster configuration. The hourly storage sampler must not rewrite every Security document
    /// after each router restart merely to issue a scoped stats read.
    pub fn credentials_for(&self, tenant: &TenantIdentity, prefix: &str) -> TenantSecurityIdentity {
        let stem = prefix.trim_end_matches('_');
        TenantSecurityIdentity {
            user: tenant.username(),
            role: format!("tenant_{stem}"),
            password: self.derived_password(&tenant.username()),
            index_prefix: prefix.to_owned(),
        }
    }

    fn derived_password(&self, user: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(&self.inner.root_key)
            .expect("HMAC accepts a key of any length");
        mac.update(b"sproutos:search-internal-user:v1\0");
        mac.update(user.as_bytes());
        encode(&mac.finalize().into_bytes())
    }

    async fn put(
        &self,
        resource: &'static str,
        path: &str,
        body: serde_json::Value,
    ) -> Result<(), SecurityError> {
        let url = format!(
            "{}/_plugins/_security/api/{path}",
            self.inner.upstream.trim_end_matches('/')
        );
        for attempt in 0..SECURITY_PUT_MAX_ATTEMPTS {
            let response = self
                .inner
                .client
                .put(&url)
                .basic_auth(
                    MANAGER_USER,
                    Some(String::from_utf8_lossy(&self.inner.root_key)),
                )
                .json(&body)
                .send()
                .await
                .map_err(SecurityError::Unreachable)?;
            let status = response.status();
            if status.is_success() {
                return Ok(());
            }

            /*
              The Security plugin stores these documents in its own index. Two router instances
              can PUT the same deterministic document at once and one receives a transient 409
              while the other's write advances that index. A process-local mutex cannot serialize
              separate routers, so retry only that conflict, with a bounded exponential delay and
              a small time-derived jitter to keep the losing instances from colliding in lockstep.

              Every other status fails immediately. Four failed conflicts fail closed rather than
              turning an unavailable security index into an unbounded tenant request.
            */
            if status == StatusCode::CONFLICT && attempt + 1 < SECURITY_PUT_MAX_ATTEMPTS {
                tokio::time::sleep(conflict_backoff(attempt)).await;
                continue;
            }
            return Err(SecurityError::Refused { resource, status });
        }

        unreachable!("the bounded provisioning loop always returns")
    }
}

fn conflict_backoff(attempt: usize) -> Duration {
    let jitter = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as u64
        % SECURITY_PUT_BASE_BACKOFF_MS;
    Duration::from_millis(SECURITY_PUT_BASE_BACKOFF_MS * (1 << attempt) + jitter)
}

fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(52);
    let mut accumulator: u16 = 0;
    let mut bits = 0u8;
    for byte in bytes {
        accumulator = (accumulator << 8) | u16::from(*byte);
        bits += 8;
        while bits >= 5 {
            out.push(ALPHABET[((accumulator >> (bits - 5)) & 0x1f) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((accumulator << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Path, State};
    use axum::http::HeaderMap;
    use axum::routing::put;
    use axum::{Json, Router};
    use sproutos_tenant_auth::ResourceKind;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use uuid::Uuid;

    type Seen = Arc<Mutex<Vec<(String, HeaderMap, serde_json::Value)>>>;

    async fn capture(
        State(seen): State<Seen>,
        Path(path): Path<String>,
        headers: HeaderMap,
        Json(body): Json<serde_json::Value>,
    ) -> StatusCode {
        seen.lock().await.push((path, headers, body));
        StatusCode::CREATED
    }

    async fn manager() -> (SecurityManager, Seen) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .route("/_plugins/_security/api/{*path}", put(capture))
            .with_state(Arc::clone(&seen));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (
            SecurityManager::new(
                reqwest::Client::new(),
                format!("http://{address}"),
                "0123456789abcdef0123456789abcdef".into(),
            )
            .unwrap(),
            seen,
        )
    }

    fn tenant(resource: u128) -> TenantIdentity {
        TenantIdentity::new(
            Uuid::nil(),
            ResourceKind::SearchIndex,
            Uuid::from_u128(resource),
        )
    }

    #[test]
    fn weak_root_key_is_refused_at_boot() {
        assert!(matches!(
            SecurityManager::new(
                reqwest::Client::new(),
                "http://unused".into(),
                "short".into()
            ),
            Err(SecurityError::WeakRootKey)
        ));
    }

    #[tokio::test]
    async fn provisions_exact_tenant_boundary_and_caches_only_success() {
        let (manager, seen) = manager().await;
        let tenant = tenant(1);
        let identity = manager
            .ensure(&tenant, "t00000000000000000000000001_")
            .await
            .unwrap();
        assert_eq!(identity.user, tenant.username());
        assert_eq!(identity.role, "tenant_t00000000000000000000000001");
        assert_eq!(identity.password.len(), 52);
        assert_eq!(
            identity.password,
            "cg4vg1275ggawkhs73n4p41eskvy8180w9xsg45f85vpxrgfqza0"
        );

        // A second request for this tenant must not turn three Security API calls into permanent
        // request-path overhead.
        manager
            .ensure(&tenant, "t00000000000000000000000001_")
            .await
            .unwrap();
        let calls = seen.lock().await;
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, "roles/tenant_t00000000000000000000000001");
        assert_eq!(
            calls[0].2["index_permissions"][0]["index_patterns"][0],
            "t00000000000000000000000001_*"
        );
        assert_eq!(calls[1].0, format!("internalusers/{}", tenant.username()));
        assert_eq!(calls[1].2["password"], identity.password);
        assert_eq!(
            calls[2].2["backend_roles"][0],
            "tenant_t00000000000000000000000001"
        );
        for (_, headers, _) in calls.iter() {
            assert!(headers.get("authorization").is_some());
            assert!(headers.get("x-proxy-user").is_none());
        }
    }

    #[tokio::test]
    async fn security_api_failure_is_fail_closed_and_not_cached() {
        async fn refuse() -> StatusCode {
            StatusCode::FORBIDDEN
        }
        let app = Router::new().fallback(refuse);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let manager = SecurityManager::new(
            reqwest::Client::new(),
            format!("http://{address}"),
            "0123456789abcdef0123456789abcdef".into(),
        )
        .unwrap();
        let error = manager
            .ensure(&tenant(2), "t00000000000000000000000002_")
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            SecurityError::Refused {
                status: StatusCode::FORBIDDEN,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn transient_security_index_conflicts_are_retried() {
        async fn conflict_then_create(State(calls): State<Arc<AtomicUsize>>) -> StatusCode {
            if calls.fetch_add(1, Ordering::SeqCst) < 2 {
                StatusCode::CONFLICT
            } else {
                StatusCode::CREATED
            }
        }

        let calls = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .fallback(put(conflict_then_create))
            .with_state(Arc::clone(&calls));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let manager = SecurityManager::new(
            reqwest::Client::new(),
            format!("http://{address}"),
            "0123456789abcdef0123456789abcdef".into(),
        )
        .unwrap();

        manager
            .put("role", "roles/tenant", json!({}))
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn persistent_security_index_conflicts_are_bounded() {
        async fn conflict(State(calls): State<Arc<AtomicUsize>>) -> StatusCode {
            calls.fetch_add(1, Ordering::SeqCst);
            StatusCode::CONFLICT
        }

        let calls = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .fallback(put(conflict))
            .with_state(Arc::clone(&calls));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let manager = SecurityManager::new(
            reqwest::Client::new(),
            format!("http://{address}"),
            "0123456789abcdef0123456789abcdef".into(),
        )
        .unwrap();

        let error = manager
            .put("role", "roles/tenant", json!({}))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            SecurityError::Refused {
                status: StatusCode::CONFLICT,
                ..
            }
        ));
        assert_eq!(calls.load(Ordering::SeqCst), SECURITY_PUT_MAX_ATTEMPTS);
    }

    #[tokio::test]
    async fn invalidation_makes_a_cached_tenant_provision_again() {
        let (manager, seen) = manager().await;
        let tenant = tenant(3);
        let prefix = "t00000000000000000000000003_";
        manager.ensure(&tenant, prefix).await.unwrap();
        manager.ensure(&tenant, prefix).await.unwrap();
        assert_eq!(seen.lock().await.len(), 3);

        manager.invalidate(prefix).await;
        manager.ensure(&tenant, prefix).await.unwrap();
        assert_eq!(seen.lock().await.len(), 6);
    }
}
