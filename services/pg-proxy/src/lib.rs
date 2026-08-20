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

pub mod protocol;
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
            Startup::Cancel { .. } => {
                /*
                    Cancellation arrives on a fresh connection carrying a key the *backend* issued,
                    and this proxy does not keep a map from those keys to their sessions. Closing
                    silently is what Postgres itself does with a key it does not recognise — a
                    cancel is advisory, and a client that sent one carries on regardless.

                    Making this work means holding backend keys per session and reissuing our own,
                    which is real work and is noted in the README rather than half-done here.
                */
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

    // Everything past here is the backend half: connect, drop privileges, splice. It is separated so
    // the authentication path above can be read on its own.
    let backend_session = connect_backend(&backend, &database, &role).await?;
    let mut server = backend_session.stream;

    /*
        Finish the client's handshake, in the order libpq expects.

        `AuthenticationOk` alone is not enough and the first version of this stopped there: a client
        that receives it then waits for `ParameterStatus`, `BackendKeyData` and `ReadyForQuery`
        before it considers the connection usable, and waits forever if they do not come. They were
        already consumed from the backend while waiting for *its* `ReadyForQuery`, so they are
        replayed here as the backend sent them.

        Only the trailing `ReadyForQuery` is ours, because the backend's was spent on `SET ROLE`.
    */
    send_authentication_ok(&mut client).await?;
    client.write_all(&backend_session.handshake).await?;
    send_ready_for_query(&mut client).await?;

    let (mut client_read, mut client_write) = client.into_split();
    let (mut server_read, mut server_write) = server.split();

    /*
        Copy both ways until either side stops.

        `tokio::select!` rather than joining: when the client hangs up, the backend connection must
        be dropped rather than left waiting for a query that will never come. A leaked backend
        session holds a connection slot on a shared cluster, which is the resource that runs out.
    */
    tokio::select! {
        result = tokio::io::copy(&mut client_read, &mut server_write) => { result?; }
        result = tokio::io::copy(&mut server_read, &mut client_write) => { result?; }
    }

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
