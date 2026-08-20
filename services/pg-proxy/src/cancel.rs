//! Routing a query cancellation to the right backend session.
//!
//! Cancellation is the one part of the Postgres protocol that does not happen on the connection it
//! affects. A client that wants to stop a running query opens a **second** connection and sends a
//! `CancelRequest` carrying the `(process_id, secret_key)` pair it was given during startup. There
//! is no authentication beyond knowing the pair.
//!
//! That creates a problem for a proxy. The pair the backend issued identifies a session on the
//! *backend*, and the cancel arrives at the *proxy*, on a connection with no memory of anything.
//! Forwarding the backend's pair to the client — which is what this did before — means the client
//! holds a key that only the backend can act on, and sends it somewhere that cannot.
//!
//! So the proxy issues its own pair, keeps a map from it to the backend's, and when a cancel
//! arrives it opens a connection to the backend and replays the *backend's* pair.
//!
//! ## Why the key is random rather than sequential
//!
//! A `CancelRequest` is unauthenticated by design: possession of the pair is the authorization. A
//! sequential or predictable secret would let anyone who can reach the proxy cancel any tenant's
//! queries by guessing — which is a denial of service against every customer at once, from an
//! unauthenticated endpoint.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

/// What the backend told us about one of its sessions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackendKey {
    pub process_id: i32,
    pub secret_key: i32,
}

/// The pair we hand the client, and what it maps to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ClientKey {
    pub process_id: i32,
    pub secret_key: i32,
}

/// Live sessions, keyed by the pair their client holds.
///
/// A `Mutex` rather than a lock-free map: this is touched twice per connection — once at startup,
/// once at teardown — plus once per cancellation, which is rare. Contention is not the problem here;
/// forgetting to remove an entry is.
#[derive(Debug, Clone, Default)]
pub struct Registry {
    sessions: Arc<Mutex<HashMap<ClientKey, BackendKey>>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a session and return the pair to give the client.
    ///
    /// The `process_id` is ours and is deliberately not the backend's: leaking the backend's PID
    /// tells a tenant something true about the shared cluster's internals, and it is not needed —
    /// the client never uses it for anything except handing it back.
    pub async fn register(&self, backend: BackendKey, client: ClientKey) {
        self.sessions.lock().await.insert(client, backend);
    }

    /// Look up which backend session a cancel is for.
    ///
    /// Returns `None` for a pair we never issued or have already forgotten. That is the ordinary
    /// case for a cancel arriving after its query finished, and it is also what an attacker
    /// guessing pairs sees — the two are indistinguishable on purpose.
    pub async fn lookup(&self, client: ClientKey) -> Option<BackendKey> {
        self.sessions.lock().await.get(&client).copied()
    }

    /// Forget a session.
    ///
    /// Called when the connection ends, whatever the reason. Without this the map grows for the
    /// life of the process — and worse, a `ClientKey` could eventually be reissued while an old
    /// entry still claims it, routing a cancel to a session that belongs to somebody else.
    pub async fn forget(&self, client: ClientKey) {
        self.sessions.lock().await.remove(&client);
    }

    /// How many sessions are registered. For tests: the invariant that matters is that this
    /// returns to zero, and a `len` on something that is not a collection invites `is_empty`.
    #[cfg(test)]
    pub async fn tracked(&self) -> usize {
        self.sessions.lock().await.len()
    }
}

/// Mint a pair for a client.
///
/// Both halves are random. The protocol treats the `process_id` as an opaque token in this
/// direction — nothing requires it to be a real PID — so making it random costs nothing and reveals
/// nothing about the cluster.
pub fn generate_client_key() -> ClientKey {
    // `RngCore::next_u32` rather than `Rng::gen`: `gen` is a reserved keyword in edition 2024 and
    // only usable as `r#gen`, which is not worth reading twice.
    //
    // `OsRng`, not `thread_rng`. A thread-local PRNG is seeded once and is fine for simulation; this
    // is an unauthenticated capability, and predicting a stream of these lets someone cancel other
    // tenants' queries.
    use rand::RngCore as _;
    let mut rng = rand::rngs::OsRng;
    ClientKey {
        process_id: rng.next_u32() as i32,
        secret_key: rng.next_u32() as i32,
    }
}

/// Read the backend's `BackendKeyData` payload.
///
/// `K` carries two big-endian `int32`s and nothing else.
pub fn parse_backend_key(payload: &[u8]) -> Option<BackendKey> {
    if payload.len() < 8 {
        return None;
    }
    Some(BackendKey {
        process_id: i32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]),
        secret_key: i32::from_be_bytes([payload[4], payload[5], payload[6], payload[7]]),
    })
}

/// Build the `BackendKeyData` message to send the client, carrying *our* pair.
pub fn backend_key_data(client: ClientKey) -> Vec<u8> {
    let mut message = Vec::with_capacity(13);
    message.push(b'K');
    message.extend_from_slice(&12i32.to_be_bytes());
    message.extend_from_slice(&client.process_id.to_be_bytes());
    message.extend_from_slice(&client.secret_key.to_be_bytes());
    message
}

/// Build a `CancelRequest` for the backend.
///
/// No type byte — it is a startup-shaped message: length, magic, then the pair.
pub fn cancel_request(backend: BackendKey) -> Vec<u8> {
    let mut message = Vec::with_capacity(16);
    message.extend_from_slice(&16i32.to_be_bytes());
    message.extend_from_slice(&crate::protocol::CANCEL_REQUEST.to_be_bytes());
    message.extend_from_slice(&backend.process_id.to_be_bytes());
    message.extend_from_slice(&backend.secret_key.to_be_bytes());
    message
}

/// Send a `CancelRequest` to the backend on a fresh connection.
///
/// A new connection because that is what the protocol requires: a cancel cannot travel on the
/// session it cancels — that session is busy, which is the entire reason for cancelling it.
///
/// No reply is read. Postgres closes the connection without answering, whether or not it recognised
/// the pair, so there is nothing to wait for and nothing to report.
pub async fn send(
    backend: &crate::BackendConfig,
    target: BackendKey,
) -> Result<(), std::io::Error> {
    use tokio::io::AsyncWriteExt as _;

    let mut stream = tokio::net::TcpStream::connect((backend.host.as_str(), backend.port)).await?;
    stream.write_all(&cancel_request(target)).await?;
    stream.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BACKEND: BackendKey = BackendKey {
        process_id: 4242,
        secret_key: 987_654_321,
    };

    #[tokio::test]
    async fn a_registered_session_can_be_found_and_then_forgotten() {
        let registry = Registry::new();
        let client = generate_client_key();

        registry.register(BACKEND, client).await;
        assert_eq!(registry.lookup(client).await, Some(BACKEND));

        registry.forget(client).await;
        assert_eq!(registry.lookup(client).await, None);
        // Without this the map grows for the life of the process, and a reissued pair could route a
        // cancel into somebody else's session.
        assert_eq!(registry.tracked().await, 0);
    }

    #[tokio::test]
    async fn a_pair_we_never_issued_finds_nothing() {
        let registry = Registry::new();
        registry.register(BACKEND, generate_client_key()).await;

        /*
            A `CancelRequest` is unauthenticated: possession of the pair is the authorization. So a
            guessed pair must find nothing, and must be indistinguishable from a cancel that arrived
            after its query already finished.
        */
        let guessed = ClientKey {
            process_id: 1,
            secret_key: 2,
        };
        assert_eq!(registry.lookup(guessed).await, None);
    }

    #[test]
    fn the_client_never_sees_the_backends_pair() {
        let client = generate_client_key();
        let message = backend_key_data(client);

        // Leaking the backend's PID tells a tenant something true about the shared cluster, and the
        // client never needs it — it only ever hands the pair back.
        let carried = parse_backend_key(&message[5..]).expect("parses");
        assert_eq!(carried.process_id, client.process_id);
        assert_ne!(carried.process_id, BACKEND.process_id);
    }

    #[test]
    fn generated_keys_differ() {
        // A predictable secret would let anyone who can reach the proxy cancel any tenant's queries
        // by guessing — a denial of service against every customer at once, unauthenticated.
        let keys: std::collections::HashSet<_> = (0..64).map(|_| generate_client_key()).collect();
        assert_eq!(keys.len(), 64);
    }

    #[test]
    fn a_backend_key_round_trips_through_the_wire_form() {
        let message = backend_key_data(ClientKey {
            process_id: BACKEND.process_id,
            secret_key: BACKEND.secret_key,
        });
        assert_eq!(message[0], b'K');
        // Length counts itself: 4 + 4 + 4.
        assert_eq!(&message[1..5], &12i32.to_be_bytes());
        assert_eq!(parse_backend_key(&message[5..]), Some(BACKEND));
    }

    #[test]
    fn a_truncated_backend_key_is_refused_rather_than_read_as_zeros() {
        // Reading a short payload as zeros would register a session under a pair nobody holds, and
        // every cancel for it would silently do nothing.
        assert_eq!(parse_backend_key(&[0, 0, 1]), None);
    }

    #[test]
    fn a_cancel_request_has_no_type_byte() {
        let message = cancel_request(BACKEND);
        assert_eq!(message.len(), 16);
        // Startup-shaped: length, magic, pair. A type byte here would make Postgres read the length
        // one byte late and hang.
        assert_eq!(&message[0..4], &16i32.to_be_bytes());
        assert_eq!(
            &message[4..8],
            &crate::protocol::CANCEL_REQUEST.to_be_bytes()
        );
        assert_eq!(&message[8..12], &BACKEND.process_id.to_be_bytes());
    }
}
