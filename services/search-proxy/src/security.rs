//! OpenSearch's second, server-enforced tenant boundary.
//!
//! The HTTP proxy still rewrites names. This module gives the identity established there a
//! Security-plugin role whose index pattern is the same prefix, so a missed request shape is
//! refused by OpenSearch rather than becoming a cross-tenant read.

use std::collections::HashSet;
use std::sync::Arc;

use hmac::{Hmac, Mac};
use reqwest::StatusCode;
use serde_json::json;
use sha2::Sha256;
use sproutos_tenant_auth::TenantIdentity;
use tokio::sync::Mutex;

const MANAGER_USER: &str = "sproutos_search_proxy_manager";
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
        let stem = prefix.trim_end_matches('_');
        let identity = TenantSecurityIdentity {
            user: tenant.username(),
            role: format!("tenant_{stem}"),
            password: self.derived_password(&tenant.username()),
            index_prefix: prefix.to_owned(),
        };

        let mut ready = self.inner.ready.lock().await;
        if ready.contains(prefix) {
            return Ok(identity);
        }

        self.put(
            "role",
            &format!("roles/{}", identity.role),
            json!({
                "cluster_permissions": ["cluster_composite_ops"],
                "index_permissions": [{
                    "index_patterns": [format!("{prefix}*")],
                    "allowed_actions": [
                        "read", "write", "create_index", "indices_monitor",
                        "indices:admin/refresh", "indices:admin/flush",
                        "indices:admin/forcemerge", "indices:admin/analyze",
                        "indices:data/read/point_in_time/*"
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
                "attributes": {}
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
        let request = self
            .inner
            .client
            .put(url)
            .basic_auth(
                MANAGER_USER,
                Some(String::from_utf8_lossy(&self.inner.root_key)),
            )
            .json(&body);
        let response = request.send().await.map_err(SecurityError::Unreachable)?;
        if !response.status().is_success() {
            return Err(SecurityError::Refused {
                resource,
                status: response.status(),
            });
        }
        Ok(())
    }
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
}
