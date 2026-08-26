//! Resolving an access token to a session, against the control-plane database.
//!
//! The second connection this process makes — to the control plane, not to a model provider — and
//! it must be TLS for the same reason `service-credentials` says so: `rds.force_ssl` is `1`, and a
//! proxy that gets this wrong stops the router. The TLS connector is shared with that crate rather
//! than rebuilt here, so there is one place to get the root store wrong instead of two.

use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use sha2::{Digest, Sha256};

use crate::seal;
use crate::session::{Session, Upstream};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("the control-plane database is unreachable: {0}")]
    Unreachable(String),
    /// One outcome for "no such token", "expired" and "revoked".
    ///
    /// Distinguishing them for the caller would tell whoever is holding a token whether it was ever
    /// real, which is the one thing an attacker probing tokens wants to learn. The *log* is allowed
    /// to know; the response is not.
    #[error("no live session for that token")]
    NoSession,
    #[error("the session names an upstream this proxy does not speak: {0}")]
    UnknownUpstream(String),
    #[error("the session's credential could not be opened: {0}")]
    Unsealable(#[from] seal::SealError),
}

pub struct SessionStore {
    pool: Pool,
    key: Vec<u8>,
    /// The platform's own key, for sessions minted with no customer credential.
    platform_secret: Option<String>,
}

impl SessionStore {
    pub fn connect(
        database_url: &str,
        size: usize,
        key: Vec<u8>,
        platform_secret: Option<String>,
    ) -> anyhow::Result<Self> {
        let config: tokio_postgres::Config =
            sproutos_service_credentials::normalise_url(database_url).parse()?;
        let manager = Manager::from_config(
            config,
            sproutos_service_credentials::tls_connector()?,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        Ok(Self {
            pool: Pool::builder(manager).max_size(size).build()?,
            key,
            platform_secret,
        })
    }

    /// Fail at boot rather than on the first agent turn.
    pub async fn check(&self) -> anyhow::Result<()> {
        let client = self.pool.get().await?;
        client.query_one("select 1", &[]).await?;
        Ok(())
    }

    /// The session an access token names, if it is live.
    ///
    /// Expiry and revocation are in the `WHERE` clause, not in the caller. A lookup that returned
    /// dead rows and trusted every caller to check two timestamps is one forgotten branch away from
    /// a token that never stops working.
    pub async fn resolve(&self, access_token: &str) -> Result<Session, StoreError> {
        let hash = hex_sha256(access_token);

        let client = self
            .pool
            .get()
            .await
            .map_err(|cause| StoreError::Unreachable(cause.to_string()))?;

        let row = client
            .query_opt(
                "select id::text, organization_id::text, project_id::text, \
                 upstream_kind, upstream_base_url, upstream_secret \
                 from agent_proxy_token \
                 where access_token_hash = $1 \
                   and revoked_at is null \
                   and access_expires_at > now()",
                &[&hash],
            )
            .await
            .map_err(|cause| StoreError::Unreachable(cause.to_string()))?
            .ok_or(StoreError::NoSession)?;

        let kind: Option<String> = row.get(3);
        let sealed: Option<String> = row.get(5);

        /*
          No upstream on the row means the platform's own key.

          Read from this process's environment rather than stored per token: it is one credential
          for the whole platform, and copying it into every token row would multiply the number of
          places a rotation has to reach by the number of live sandboxes.
        */
        let (upstream, secret) = match (kind.as_deref(), sealed.as_deref()) {
            (Some(kind), Some(sealed)) => {
                let upstream = Upstream::parse(kind)
                    .ok_or_else(|| StoreError::UnknownUpstream(kind.into()))?;
                (upstream, seal::open(sealed, &self.key)?)
            }
            _ => {
                let secret = self
                    .platform_secret
                    .clone()
                    .ok_or_else(|| StoreError::UnknownUpstream("platform (no key here)".into()))?;
                (Upstream::Openai, secret)
            }
        };

        let base_url: Option<String> = row.get(4);

        Ok(Session {
            token_id: row.get(0),
            organization_id: row.get(1),
            project_id: row.get(2),
            upstream,
            base_url: base_url.unwrap_or_else(|| upstream.default_base_url().to_string()),
            secret,
        })
    }
}

/// The stored form of a token: lowercase hex SHA-256, matching what the control plane writes.
pub fn hex_sha256(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_the_way_the_control_plane_does() {
        // `encodeHexLowerCase(await sha256Utf8(token))` in `@lib/agent`. Pinned to a known vector
        // rather than to the other implementation's output, so both are wrong only if the vector is.
        assert_eq!(
            hex_sha256("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex_sha256(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
