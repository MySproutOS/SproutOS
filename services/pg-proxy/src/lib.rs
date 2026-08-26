//! The Postgres front door.
//!
//! A tenant points `psql`, or Prisma, or SQLAlchemy at this and gets what looks like a Postgres
//! server holding exactly their database. What is actually behind it is one shared cluster with a
//! database and a role per tenant, and this is the thing that makes those two facts consistent.
//!
//! ## Why it terminates the connection rather than forwarding it
//!
//! The alternative — read the startup packet, then splice the sockets and let the backend
//! authenticate — cannot work, because the tenant's credential is not the backend's credential. The
//! tenant presents a secret we store as `sha256$…`; the backend expects a role password we hold
//! separately. Something has to sit between those two facts, and that means being both a server and
//! a client.
//!
//! ## What it does, in order
//!
//! 1. Answer `SSLRequest` (currently: no).
//! 2. Read the startup packet, take the username, parse it into a tenant identity.
//! 3. Ask for a password, verify it against `service_credential`.
//! 4. Connect to the backend as the proxy's own administrative role, into *the tenant's* database.
//! 5. `SET ROLE` to the tenant's role, so the session has their privileges and not ours.
//! 6. Copy bytes in both directions until one side hangs up.
//!
//! Step 5 is the one that matters. Without it every tenant would be connected as an administrator
//! to a cluster holding every other tenant's data.

pub mod cancel;
pub mod protocol;
pub mod resolve;
pub mod routing;
pub mod scram;

use std::sync::Arc;

use sproutos_service_credentials::{Authentication, CredentialStore};
use sproutos_tenant_auth::{ResourceKind, TenantIdentity};
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

use protocol::{ProtocolError, Startup};

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Protocol(#[from] ProtocolError),

    #[error("the username `{0}` is not a tenant credential")]
    Username(String),

    #[error("authentication failed")]
    Unauthenticated,

    #[error("the backend refused the connection: {0}")]
    Backend(String),

    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// The proxy's own connection to the shared cluster.
#[derive(Debug, Clone)]
pub struct BackendConfig {
    pub host: String,
    pub port: u16,
    /// An administrative role, because reaching any tenant's database requires one. The session
    /// drops to the tenant's role immediately after connecting.
    pub user: String,
    pub password: String,
    /*
      Whether an unencrypted backend connection is acceptable.

      TLS is always *offered* — `backend::connect` sends `SSLRequest` and upgrades if the server
      answers `S`. This decides what happens when it answers `N`.

      `true` for anything the resolver returns, because that is a managed Postgres reached across
      the internet and a plaintext session there would carry every tenant's rows in the clear.
      `false` for the configured shared cluster, which in development is the compose Postgres on
      loopback with no certificate at all.

      This field exists because the proxy had no TLS whatsoever: it opened the backend with a bare
      `TcpStream::connect`, and Neon refused every session with "connection is insecure (try using
      `sslmode=require`)". The customer-facing half worked perfectly — the tenant authenticated,
      the database was resolved — and then the backend hung up.
    */
    pub require_tls: bool,
}

/// Decide who is connecting, without touching the network.
///
/// The store owns parsing, lookup and verification — it is shared with the other two proxies, and a
/// second implementation here is how the three would come to disagree about who a credential
/// belongs to. What this adds is the one check the store cannot make, because the store does not
/// know which proxy is asking.
pub async fn authenticate(
    store: &CredentialStore,
    username: &str,
    password: &str,
) -> Result<TenantIdentity, SessionError> {
    let identity = match store.authenticate(username, password.as_bytes()).await {
        Ok(Authentication::Ok(identity)) => *identity,
        Ok(Authentication::Denied) => return Err(SessionError::Unauthenticated),
        Err(error) => return Err(SessionError::Backend(error.to_string())),
    };

    /*
        A queue credential must not open a database connection.

        The username grammar is shared across all three proxies, so `kv_…` parses and authenticates
        perfectly well here — the store has no reason to refuse it. This is what stops a tenant's
        Valkey secret, which they legitimately hold, from being presented to Postgres and routed to
        a database derived from the same resource id.
    */
    if identity.resource_kind != ResourceKind::Database {
        return Err(SessionError::Username(username.to_owned()));
    }

    Ok(identity)
}

/// Handle one client connection from the first byte to the last.
pub async fn serve_connection(
    mut client: TcpStream,
    store: Arc<CredentialStore>,
    backend: BackendConfig,
    cancels: cancel::Registry,
    resolver: Option<resolve::Resolver>,
) -> Result<(), SessionError> {
    let parameters = loop {
        match protocol::read_startup(&mut client).await? {
            Startup::Ssl => {
                /*
                    `N`: no TLS here.

                    Every client then either continues in the clear or gives up, depending on its
                    `sslmode`. In production this proxy is behind a TLS terminator and the honest
                    answer changes; saying `S` without being able to complete a handshake would be
                    worse than saying no, because the client would wait for a ServerHello that never
                    comes.
                */
                client.write_all(b"N").await?;
                client.flush().await?;
            }
            Startup::Cancel {
                process_id,
                secret_key,
            } => {
                /*
                    A cancellation, on its own connection, carrying a pair this proxy issued.

                    Looked up and replayed against the backend with *its* pair. A pair we never
                    issued — or already forgot, because the query finished — finds nothing and the
                    connection closes silently, which is what Postgres itself does with a key it does
                    not recognise. The two cases are deliberately indistinguishable: a
                    `CancelRequest` is unauthenticated, so telling a caller which of the two happened
                    would let them probe for live sessions.
                */
                let key = cancel::ClientKey {
                    process_id,
                    secret_key,
                };
                if let Some(target) = cancels.lookup(key).await {
                    // Best effort, and never surfaced. A cancel is advisory — the client carries on
                    // regardless — so a backend that refuses the connection is not worth an error
                    // path the caller has no way to see.
                    let _ = cancel::send(&backend, target).await;
                }
                return Ok(());
            }
            Startup::Connect(parameters) => break parameters,
        }
    };

    protocol::request_password(&mut client).await?;
    let password = protocol::read_password(&mut client).await?;

    let identity = match authenticate(&store, &parameters.user, &password).await {
        Ok(identity) => identity,
        Err(error) => {
            /*
                One message for every failure, and deliberately so.

                "No such user" and "wrong password" are different facts, and telling them apart lets
                somebody enumerate which tenants exist. Postgres's own message for both is this one.
            */
            protocol::send_error(
                &mut client,
                "28P01",
                "password authentication failed for user",
            )
            .await?;
            return Err(error);
        }
    };

    let database = routing::database_for(&identity);
    let role = routing::role_for(&identity);

    // Both are derived from a UUID and cannot contain anything that needs escaping. Checked anyway,
    // because `role` reaches `SET ROLE`, which cannot be parameterized.
    if !routing::is_safe_identifier(&database) || !routing::is_safe_identifier(&role) {
        protocol::send_error(&mut client, "28000", "this credential cannot be routed").await?;
        return Err(SessionError::Username(parameters.user));
    }

    tracing::info!(user = %parameters.user, %database, "authenticated");

    /*
        Wake the compute, if this is a service that has one.

        After authentication and never before: starting a compute costs real resources, and doing it
        for an unauthenticated connection would let anyone who can reach the port spend the
        platform's money by opening sockets.

        `None` means the control plane has no Neon endpoint for this service, which is the normal
        answer for every `sprout` database — the shared cluster below is where it belongs.
    */
    /*
        Which database to connect onward to.

        After authentication and never before: resolving costs a control-plane round trip, and doing
        it for an unauthenticated connection would let anyone who can reach the port generate load
        on the control plane by opening sockets.

        `None` means the control plane has no per-tenant backend for this service — either it is a
        `sprout` database on the shared cluster, or it is suspended. Both fall through to the
        configured backend below, and a suspended tenant then fails to find its database there,
        which is the outcome suspension is for.
    */
    /*
        The database and role come from the resolver too, not only the address.

        `as_backend_config()` carried host, port, user and password and dropped `database` and
        `role`, so a resolved session connected to Neon and then asked for the `sprout_db_…` name
        this proxy derives from the credential. Neon answered, correctly:

            database "sprout_db_01m0ych7yte79aebatsqngqp1w" does not exist

        Those two names are both right and describe different things. `sprout_db_…` is what a
        customer is *told* their database is called — a name this platform owns, so Neon's default
        `neondb` never leaks into a URI. The resolver returns what Neon actually called it. The
        proxy is the thing that maps one to the other, and it was using the customer-facing name on
        the backend side.

        `SET ROLE` to the resolved role is then a no-op, because the connection is already that
        role. That is fine here and worth being explicit about: on the shared cluster the `SET ROLE`
        is the isolation, and on Neon the isolation is the project — one per customer database, so
        there is no other tenant on the far side of this connection to be separated from.
    */
    let (backend, database, role) = match &resolver {
        Some(resolver) => match resolver.resolve(&identity.resource_id.to_string()).await? {
            Some(resolved) => (
                resolved.as_backend_config(),
                resolved.database.clone(),
                resolved.role.clone(),
            ),
            None => (backend, database, role),
        },
        None => (backend, database, role),
    };

    // Re-checked after resolution, because these now come from the control plane rather than from a
    // UUID this proxy derived — and `role` still reaches `SET ROLE`, which cannot be parameterized.
    if !routing::is_safe_identifier(&database) || !routing::is_safe_identifier(&role) {
        return Err(SessionError::Backend(
            "the resolved database or role is not a safe identifier".to_owned(),
        ));
    }

    // Everything past here is the backend half: connect, drop privileges, splice. It is separated so
    // the authentication path above can be read on its own.
    let backend_session = connect_backend(&backend, &database, &role).await?;
    let server = backend_session.stream;

    /*
        Finish the client's handshake, in the order libpq expects.

        `AuthenticationOk` alone is not enough and the first version of this stopped there: a client
        that receives it then waits for `ParameterStatus`, `BackendKeyData` and `ReadyForQuery`
        before it considers the connection usable, and waits forever if they do not come. They were
        already consumed from the backend while waiting for *its* `ReadyForQuery`, so they are
        replayed here as the backend sent them.

        Only the trailing `ReadyForQuery` is ours, because the backend's was spent on `SET ROLE`.
    */
    /*
        Our own cancellation pair, not the backend's.

        Registered before the client is told it is connected, so a cancel that arrives immediately
        after the first query finds it. Leaking the backend's pair would also leak a real PID on the
        shared cluster, which is true information a tenant has no use for.
    */
    let client_key = cancel::generate_client_key();
    if let Some(backend_key) = backend_session.key {
        cancels.register(backend_key, client_key).await;
    }

    send_authentication_ok(&mut client).await?;
    client.write_all(&backend_session.handshake).await?;
    client
        .write_all(&cancel::backend_key_data(client_key))
        .await?;
    send_ready_for_query(&mut client).await?;

    let (mut client_read, mut client_write) = client.into_split();
    // `tokio::io::split`, not the borrowed `TcpStream::split`: the backend may now be a TLS
    // session rather than a socket, so the halves come from the generic split.
    let (mut server_read, mut server_write) = tokio::io::split(server);

    /*
        Copy both ways until either side stops.

        `tokio::select!` rather than joining: when the client hangs up, the backend connection must
        be dropped rather than left waiting for a query that will never come. A leaked backend
        session holds a connection slot on a shared cluster, which is the resource that runs out.
    */
    let outcome = tokio::select! {
        result = tokio::io::copy(&mut client_read, &mut server_write) => result.map(|_| ()),
        result = tokio::io::copy(&mut server_read, &mut client_write) => result.map(|_| ()),
    };

    /*
        Forget the session however it ended.

        Not in a `?` path: an error on the splice must still drop the registration, or the map grows
        for the life of the process and a reissued pair could eventually route a cancel into a
        session belonging to somebody else.
    */
    cancels.forget(client_key).await;

    outcome?;
    Ok(())
}

async fn send_authentication_ok<W>(stream: &mut W) -> Result<(), ProtocolError>
where
    W: AsyncWrite + Unpin + AsyncWriteExt,
{
    stream.write_all(b"R").await?;
    stream.write_all(&8i32.to_be_bytes()).await?;
    stream.write_all(&0i32.to_be_bytes()).await?;
    Ok(())
}

/// `ReadyForQuery`, status `I` for idle.
///
/// Ours rather than the backend's: the backend's was consumed answering `SET ROLE`, and forwarding
/// a `ReadyForQuery` that belonged to a statement the client never sent would leave the two sides
/// disagreeing about how many replies are outstanding.
async fn send_ready_for_query<W>(stream: &mut W) -> Result<(), ProtocolError>
where
    W: AsyncWrite + Unpin + AsyncWriteExt,
{
    stream.write_all(b"Z").await?;
    stream.write_all(&5i32.to_be_bytes()).await?;
    stream.write_all(b"I").await?;
    stream.flush().await?;
    Ok(())
}

/// Open the backend half of the session.
///
/// Declared here and implemented in `backend.rs` so this file reads as the session's story.
async fn connect_backend(
    backend: &BackendConfig,
    database: &str,
    role: &str,
) -> Result<backend::Backend, SessionError> {
    crate::backend::connect(backend, database, role).await
}

pub mod backend;

/// Re-exported so `main.rs` and the tests share one way of reading configuration.
pub use backend::backend_config_from_env;

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_send_sync<T: Send + Sync>() {}

    /// A session is moved onto a task per connection; if either of these stopped being `Send` the
    /// accept loop would stop compiling somewhere far from the cause.
    #[test]
    fn a_session_can_cross_a_task_boundary() {
        assert_send_sync::<BackendConfig>();
        assert_send_sync::<SessionError>();
    }
}
