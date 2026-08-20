//! Turning a connection's credentials into a tenant, against the control plane's records.
//!
//! Shared by every data-plane proxy — valkey, search, and pg when it lands. They all face the same
//! problem and the same table, and two implementations of "is this secret right" is one more than
//! can be kept correct: a divergence here is not a bug in one proxy, it is a tenant reading another
//! tenant's data through whichever one drifted.
//!
//!
//! The username says who the connection *claims* to be — `lib/rust/tenant-auth` parses it, and that
//! is identification, not authentication. This is the part that makes the claim true: look up the
//! live credential for that exact username, and check the presented secret against the stored hash.
//!
//! **Postgres directly, not the internal API.** A proxy that authenticates by calling an HTTP
//! service cannot accept a connection while that service is deploying, and a queue is precisely the
//! thing that must keep draining during a deploy. One indexed equality on a table the control plane
//! owns is also cheaper than a round trip through Hono and Kysely.
//!
//! The role this connects as needs `select` on `service_credential` and `update` on its
//! `last_used_at`, and nothing else. It is not the migration role.

use std::time::Duration;

use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use sproutos_tenant_auth::{MAX_USERNAME_LEN, SecretError, TenantIdentity, verify_secret};
use tokio_postgres::NoTls;
use tracing::{error, warn};

/// How long a credential lookup may take before the connection attempt is abandoned.
///
/// A tenant waiting on a wedged database is worse than a tenant told to retry: BullMQ reconnects,
/// and an unbounded wait here holds a client socket and a proxy task open indefinitely.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("could not reach the control plane: {0}")]
    Unavailable(String),

    #[error("the stored credential for {username} is unusable: {cause}")]
    BrokenCredential {
        username: String,
        cause: SecretError,
    },
}

/// The outcome of one authentication attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Authentication {
    /// The secret matched a live credential.
    Ok(Box<TenantIdentity>),
    /// No live credential, or the wrong secret. Deliberately one variant: see [`CredentialStore::authenticate`].
    Denied,
}

/// Reads credentials from the control plane's Postgres.
pub struct CredentialStore {
    pool: Pool,
}

impl CredentialStore {
    /// Connects, lazily — no connection is opened until the first lookup.
    ///
    /// `size` bounds how many control-plane connections this proxy can hold. It is small on
    /// purpose: a lookup happens once per *client connection*, not once per command, so even a busy
    /// proxy makes a handful of queries a second.
    pub fn connect(url: &str, size: usize) -> anyhow::Result<Self> {
        let config: tokio_postgres::Config = url.parse()?;
        let manager = Manager::from_config(
            config,
            NoTls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        Ok(Self {
            pool: Pool::builder(manager).max_size(size).build()?,
        })
    }

    /// Authenticates one `AUTH <username> <secret>`.
    ///
    /// Returns [`Authentication::Denied`] both for a username with no live credential and for a
    /// live credential with the wrong secret. **They are one variant on purpose**: telling a caller
    /// which of the two happened turns this into an oracle for enumerating which tenants exist.
    ///
    /// `Err` means we could not answer — the control plane is unreachable, or a stored hash is
    /// corrupt. That is an operational fault and must not be reported to the client as a bad
    /// password; the caller logs it and refuses the connection.
    ///
    /// There is no cache. A lookup happens once per connection and connections are long-lived, so
    /// the saving would be small — and a cache is exactly what makes a revoked credential keep
    /// working after `rotateCredentials` commits, which is the one thing rotation exists to prevent.
    pub async fn authenticate(
        &self,
        username: &str,
        secret: &[u8],
    ) -> Result<Authentication, StoreError> {
        // Bounded before the query so a client cannot make us send a megabyte to Postgres. Nothing
        // this long is a username, and `parse_username` would refuse it anyway.
        if username.len() > MAX_USERNAME_LEN {
            return Ok(Authentication::Denied);
        }

        // Parsed first: if the username is not a tenant identity there is nothing to look up, and
        // this costs no round trip.
        let Ok(identity) = TenantIdentity::parse_username(username) else {
            return Ok(Authentication::Denied);
        };

        let client = tokio::time::timeout(LOOKUP_TIMEOUT, self.pool.get())
            .await
            .map_err(|_| StoreError::Unavailable("timed out waiting for a connection".into()))?
            .map_err(|cause| StoreError::Unavailable(cause.to_string()))?;

        /*
          The service *and its organization* must still be live, which is why this joins twice.

          Revoking the credential is what suspension does, so `revoked_at is null` alone would very
          nearly do. The rest is the belt: a service deleted by a path that forgot to revoke — a
          cascade, a hand-written fix, a future migration — must not leave a working credential
          behind. Authorization that depends on every writer remembering to do two things is
          authorization that eventually fails open.

          The organization join is that failure, found rather than imagined: deleting an
          organization soft-deletes the row and nothing else, so without this a deleted customer's
          queue and search credentials went on working indefinitely. `deleted_at` on one table is
          not a permission check on another.
        */
        let statement = "
            select c.id, c.secret_hash
              from service_credential c
              join backend_service s on s.id = c.backend_service_id
              join organization o on o.id = s.organization_id
             where c.username = $1
               and c.revoked_at is null
               and (c.expires_at is null or c.expires_at > now())
               and s.deleted_at is null
               and s.status in ('provisioning', 'active')
               and o.deleted_at is null
             limit 1
        ";

        let rows = tokio::time::timeout(LOOKUP_TIMEOUT, client.query(statement, &[&username]))
            .await
            .map_err(|_| StoreError::Unavailable("the credential lookup timed out".into()))?
            .map_err(|cause| StoreError::Unavailable(cause.to_string()))?;

        let Some(row) = rows.first() else {
            return Ok(Authentication::Denied);
        };
        let credential_id: uuid::Uuid = row.get(0);
        let stored: &str = row.get(1);

        match verify_secret(secret, stored) {
            Ok(true) => {
                self.stamp_used(credential_id).await;
                Ok(Authentication::Ok(Box::new(identity)))
            }
            Ok(false) => Ok(Authentication::Denied),
            // A hash we cannot read is our fault, not the client's. Reporting it as a wrong
            // password would send an operator chasing the tenant instead of the row.
            Err(cause) => Err(StoreError::BrokenCredential {
                username: username.to_owned(),
                cause,
            }),
        }
    }

    /// Records that a credential was used, best effort.
    ///
    /// Deliberately not fatal and deliberately not awaited for correctness: this is a convenience
    /// for the dashboard's "last used" column, and refusing a connection because a bookkeeping
    /// write failed would trade a real capability for a cosmetic one.
    async fn stamp_used(&self, credential_id: uuid::Uuid) {
        let Ok(client) = self.pool.get().await else {
            return;
        };
        if let Err(cause) = client
            .execute(
                "update service_credential set last_used_at = now() where id = $1",
                &[&credential_id],
            )
            .await
        {
            warn!(%cause, "could not stamp last_used_at");
        }
    }

    /// Checks the connection at startup, so a misconfigured URL fails loudly at boot rather than on
    /// the first tenant's connection attempt.
    pub async fn check(&self) -> anyhow::Result<()> {
        let client = self.pool.get().await?;
        client.query_one("select 1", &[]).await?;
        Ok(())
    }
}

/// Logs a lookup failure once, in the one place that has the context to describe it.
pub fn report(cause: &StoreError) {
    match cause {
        StoreError::Unavailable(detail) => {
            error!(detail, "credential lookup failed; refusing the connection")
        }
        StoreError::BrokenCredential { username, cause } => {
            error!(username, %cause, "a stored credential is unusable")
        }
    }
}
