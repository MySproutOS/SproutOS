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
use tracing::{error, info, warn};

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

/// A live object-storage credential and what it belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedService {
    pub credential_id: uuid::Uuid,
    pub backend_service_id: uuid::Uuid,
    pub organization_id: uuid::Uuid,
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
        let config: tokio_postgres::Config = normalise_url(url).parse()?;
        let manager = Manager::from_config(
            config,
            tls_connector()?,
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
        ";

        let rows = tokio::time::timeout(LOOKUP_TIMEOUT, client.query(statement, &[&username]))
            .await
            .map_err(|_| StoreError::Unavailable("the credential lookup timed out".into()))?
            .map_err(|cause| StoreError::Unavailable(cause.to_string()))?;

        if rows.is_empty() {
            return Ok(Authentication::Denied);
        }

        /*
          Every live credential for the username, not the first.

          One service can now hold two: the `tenant` credential a customer connects with, and a
          `worker` credential the platform issues to a workload it runs on their behalf. They share a
          username — it is derived from the resource, and the wire protocol gives a proxy nothing
          else to route on — and are told apart by which secret is presented.

          There was a `limit 1` here, which is why a second credential was impossible and why a
          platform-started worker had no way to authenticate. See the
          `service_credential_purpose` migration.

          Every row is examined even after a match. Returning early would make the time this takes
          depend on which credential was presented, which over enough attempts says which of a
          service's credentials a secret is closest to — a small leak, and the cost of not having it
          is one hash comparison against a list that is two long.
        */
        let mut matched: Option<uuid::Uuid> = None;
        for row in &rows {
            let credential_id: uuid::Uuid = row.get(0);
            let stored: &str = row.get(1);

            match verify_secret(secret, stored) {
                Ok(true) => matched = matched.or(Some(credential_id)),
                Ok(false) => {}
                // A hash we cannot read is our fault, not the client's. Reporting it as a wrong
                // password would send an operator chasing the tenant instead of the row.
                Err(cause) => {
                    return Err(StoreError::BrokenCredential {
                        username: username.to_owned(),
                        cause,
                    });
                }
            }
        }

        match matched {
            Some(credential_id) => {
                self.stamp_used(credential_id).await;
                Ok(Authentication::Ok(Box::new(identity)))
            }
            None => Ok(Authentication::Denied),
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

    /// Resolves an S3 access key id to the service it belongs to.
    ///
    /// **Identification only — this proves nothing about the caller.** SigV4 never presents the
    /// secret, so there is nothing here to compare a hash against; the caller derives the secret
    /// from the platform's root key and checks the request's signature itself. What this answers is
    /// the question that has to be answered *before* a signature can be checked at all: which
    /// tenant is this key, and is that tenant still allowed in.
    ///
    /// That makes the liveness joins do more work here than in [`Self::authenticate`], not less.
    /// A revoked, expired, suspended, deleted-service or deleted-organization credential resolves to
    /// nothing — and because a derived secret cannot be deleted, this lookup *is* the revocation.
    /// The customer's client still holds a key that signs correctly forever; it stops meaning
    /// anything the moment no row answers.
    ///
    /// `suspended` is absent from the status list on purpose, and that is the difference from the
    /// connection-oriented proxies: they revoke the credential to suspend, whereas object storage
    /// suspends by writing `backend_service.status` — so the status is the check.
    pub async fn resolve_access_key(
        &self,
        access_key_id: &str,
    ) -> Result<Option<ResolvedService>, StoreError> {
        // Bounded before the query, as in `authenticate`: a client should not be able to make us
        // send a megabyte to Postgres.
        if access_key_id.len() > MAX_USERNAME_LEN {
            return Ok(None);
        }

        let client = tokio::time::timeout(LOOKUP_TIMEOUT, self.pool.get())
            .await
            .map_err(|_| StoreError::Unavailable("timed out waiting for a connection".into()))?
            .map_err(|cause| StoreError::Unavailable(cause.to_string()))?;

        let statement = "
            select c.id, s.id, s.organization_id
              from service_credential c
              join backend_service s on s.id = c.backend_service_id
              join organization o on o.id = s.organization_id
             where c.username = $1
               and c.revoked_at is null
               and (c.expires_at is null or c.expires_at > now())
               and s.deleted_at is null
               and s.status = 'active'
               and o.deleted_at is null
        ";

        let rows = tokio::time::timeout(LOOKUP_TIMEOUT, client.query(statement, &[&access_key_id]))
            .await
            .map_err(|_| StoreError::Unavailable("the credential lookup timed out".into()))?
            .map_err(|cause| StoreError::Unavailable(cause.to_string()))?;

        let Some(row) = rows.first() else {
            return Ok(None);
        };

        Ok(Some(ResolvedService {
            credential_id: row.get(0),
            backend_service_id: row.get(1),
            organization_id: row.get(2),
        }))
    }

    /// Records that a credential was used. See [`Self::stamp_used`].
    ///
    /// Public because the storage proxy verifies the signature itself and so is the only thing that
    /// knows whether a resolved credential was actually used correctly.
    pub async fn mark_used(&self, credential_id: uuid::Uuid) {
        self.stamp_used(credential_id).await;
    }

    /// Checks the connection at startup, so a misconfigured URL fails loudly at boot rather than on
    /// the first tenant's connection attempt.
    pub async fn check(&self) -> anyhow::Result<()> {
        let client = self.pool.get().await?;
        client.query_one("select 1", &[]).await?;
        Ok(())
    }
}

/// Drop connection-string parameters `tokio-postgres` refuses but every other client ignores.
///
/// **Found by a proxy that would not start.** `DATABASE_URL` in this repository ends
/// `?schema=public` — a Prisma-ism the Node `pg` driver silently ignores and Kysely never sees.
/// `tokio-postgres` parses the query string strictly and answers `unknown option \`schema\``, so
/// every Rust proxy here fails at boot the moment it falls back to `DATABASE_URL` rather than a
/// `*_PROXY_DATABASE_URL` of its own. That fallback exists precisely so a proxy works without extra
/// configuration, and it worked nowhere.
///
/// `public` is already the default search path, so dropping it changes nothing. A *different*
/// schema is a different matter — it would silently point the proxy at the wrong tables — so that
/// one is left in place to fail loudly rather than quietly succeed against the wrong rows.
pub fn normalise_url(url: &str) -> String {
    let Some((base, query)) = url.split_once('?') else {
        return url.to_owned();
    };

    let kept: Vec<&str> = query
        .split('&')
        .filter(|pair| *pair != "schema=public")
        .collect();

    if kept.is_empty() {
        base.to_owned()
    } else {
        format!("{base}?{}", kept.join("&"))
    }
}

/// Where a private certificate authority is read from, when the database has one.
///
/// `PGSSLROOTCERT` is libpq's own name for this and `psql` on the same host already honours it,
/// which is worth more than a name of our own: somebody debugging a refused connection reaches for
/// `psql` first, and a variable both tools read means the two agree about what they trust.
const CA_FILE_VARIABLE: &str = "PGSSLROOTCERT";

/// Where `user-data.sh.tftpl` puts Amazon's RDS bundle, used when nothing names a file.
const DEFAULT_CA_FILE: &str = "/etc/sproutos/rds-ca.pem";

/*
  TLS, and why this is not `NoTls`.

  It was `NoTls`, and that was not a simplification — it was a proxy that could not connect to the
  control plane at all. The RDS instance runs on `default.postgres17`, where **`rds.force_ssl` is
  `1`**, so an unencrypted connection is refused by the server before authentication. Every proxy
  built on this store would have exited at boot, and `check()` is deliberately fatal, so the router
  carrying these listeners would have exited with it. The front door, taken down by a credential
  lookup that never happened.

  It was invisible because nothing had connected: the proxies run against the compose Postgres in
  tests, which has no such setting, and the deployment had never been given `DATABASE_URL` for the
  splits to start with. Precisely the shape `docs/findings/0015` describes — and the same mistake it
  records making about `valkey-proxy`'s missing TLS, one crate over.

  ## Which roots

  Webpki's bundle **and** a private CA file, not one or the other. RDS certificates chain to
  "Amazon RDS Root 2019 CA", which is not a public root and is in no browser's store; a webpki-only
  trust anchor fails every RDS handshake. Equally, a bundle-only store would fail against a Postgres
  fronted by an ordinary public certificate. Loading both costs one file read at startup.

  A named file that cannot be read is fatal. A *default* file that is not there is not: the default
  is a guess about the host, and a developer running this against compose has no RDS bundle and
  should not be made to invent one.
*/
fn tls_connector() -> anyhow::Result<tokio_postgres_rustls::MakeRustlsConnect> {
    use tokio_rustls::rustls::{ClientConfig, RootCertStore};

    let mut roots = RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };

    let named = std::env::var(CA_FILE_VARIABLE)
        .ok()
        .filter(|v| !v.is_empty());
    let path = named.clone().unwrap_or_else(|| DEFAULT_CA_FILE.to_owned());

    match std::fs::read(&path) {
        Ok(bytes) => {
            let mut added = 0usize;
            for certificate in rustls_pemfile::certs(&mut bytes.as_slice()) {
                roots.add(certificate?)?;
                added += 1;
            }
            info!(path, added, "loaded private certificate authorities");
        }
        Err(cause) if named.is_some() => {
            return Err(anyhow::anyhow!(
                "{CA_FILE_VARIABLE} names {path}, which cannot be read: {cause}"
            ));
        }
        Err(_) => {
            info!(
                path,
                "no private certificate authority; using the public roots only"
            );
        }
    }

    /*
      An explicit provider rather than the process default.

      `ClientConfig::builder()` reads a process-wide provider and **panics** when two are compiled
      in and none has been installed — and two are, in the router: the AWS SDK brings `aws-lc-rs`
      and this graph brings `ring`. The router installs one in `main` before anything serves, but a
      library that only works when its caller remembered to do that is a library with a trap in it.
      Naming the provider here makes this correct in every binary that links it.
    */
    let config = ClientConfig::builder_with_provider(std::sync::Arc::new(
        tokio_rustls::rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth();

    Ok(tokio_postgres_rustls::MakeRustlsConnect::new(config))
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

#[cfg(test)]
mod tests {
    use super::{CA_FILE_VARIABLE, normalise_url, tls_connector};

    /*
      One test, and it is about the failure rather than the success.

      A connector that builds proves very little — the interesting property is that a *named* CA
      file which cannot be read stops the process instead of quietly falling back to the public
      roots. Falling back would produce a proxy that starts, reports healthy, and fails every RDS
      handshake with a certificate error naming nothing that led to it.

      `PGSSLROOTCERT` is process-global, so this restores it rather than assuming it was unset.
    */
    #[test]
    fn a_named_certificate_authority_that_is_missing_is_fatal() {
        let previous = std::env::var(CA_FILE_VARIABLE).ok();

        // SAFETY: single-threaded test, and the variable is restored below.
        unsafe { std::env::set_var(CA_FILE_VARIABLE, "/nonexistent/rds-ca.pem") };
        let refused = tls_connector();

        unsafe {
            match &previous {
                Some(value) => std::env::set_var(CA_FILE_VARIABLE, value),
                None => std::env::remove_var(CA_FILE_VARIABLE),
            }
        }

        // `MakeRustlsConnect` is not `Debug`, so `expect_err` is unavailable.
        let Err(cause) = refused else {
            panic!("a named CA file that cannot be read must fail")
        };
        let cause = cause.to_string();
        assert!(cause.contains("/nonexistent/rds-ca.pem"), "{cause}");
    }

    #[test]
    fn drops_the_schema_parameter_tokio_postgres_refuses() {
        // The repository's own `DATABASE_URL`. Without this every Rust proxy exits at boot with
        // "unknown option `schema`", which says nothing about where the option came from.
        assert_eq!(
            normalise_url("postgresql://u:p@localhost:25281/main?schema=public"),
            "postgresql://u:p@localhost:25281/main"
        );
    }

    #[test]
    fn keeps_a_schema_that_is_not_public() {
        // Dropping it would point the proxy at a different schema's tables without saying so. Better
        // to fail at boot than to authenticate against the wrong `service_credential`.
        let url = "postgresql://u:p@localhost/main?schema=tenant";

        assert_eq!(normalise_url(url), url);
    }

    #[test]
    fn leaves_every_other_parameter_alone() {
        assert_eq!(
            normalise_url("postgresql://u:p@localhost/main?sslmode=require&schema=public"),
            "postgresql://u:p@localhost/main?sslmode=require"
        );
    }

    #[test]
    fn leaves_a_url_without_a_query_string_untouched() {
        let url = "postgresql://u:p@localhost/main";

        assert_eq!(normalise_url(url), url);
    }
}
