//! The master queue: TASK 20's second half.
//!
//! > We use a proxy that receives valkey commands and adds it to a master valkey queue such that
//! > this proxy consumer continuously receives jobs from all projects and spins up services as
//! > needed.
//!
//! The proxy is the only thing in the system that sees every tenant's enqueues, so it is the only
//! thing that can say "this queue has work" without polling every tenant's keyspace — which on a
//! shared instance would mean scanning, the one operation this proxy refuses on principle.
//!
//! # What is recorded, and what is not
//!
//! Not the job. A job belongs to the tenant and copying it into a shared structure would put one
//! customer's payload somewhere another customer's dispatcher could read. What goes in is the
//! smallest fact that lets the control plane act: **this resource's queue was written to, at this
//! time.**
//!
//! ```text
//! ZADD sproutos:master:wake GT <epoch_ms> "<resource-short-id>/<queue>"
//! ```
//!
//! A sorted set rather than a list, and this is the whole design:
//!
//! - The member is the queue, so a thousand enqueues in a second collapse to one entry. A list
//!   would grow at the rate the busiest tenant enqueues, and the dispatcher would spend its life
//!   reading duplicates of a fact it already acted on.
//! - The score is the last time work arrived, which is exactly what a scale-to-zero decision needs.
//!   `GT` keeps the newest, so an entry never goes backwards when two proxy replicas report the
//!   same queue.
//! - The dispatcher reads with `ZRANGEBYSCORE` and removes what it has handled. Nothing here has to
//!   know whether a dispatcher exists.
//!
//! # Why a separate connection
//!
//! RESP has no request ids, so the proxy tracks replies by position in a FIFO. Writing an extra
//! command onto a client's backend connection would put a reply in that stream that no client
//! command is waiting for, and every reply after it would be attributed to the wrong request.
//!
//! So the master queue owns one connection of its own, fed by a channel. A per-connection handler
//! sends a `Wake` and moves on; it never blocks on the master queue and never fails because of it.
//!
//! # Failing open
//!
//! Every failure here — a full channel, a backend that will not connect, a write that errors — is
//! logged and dropped. **A tenant's command must never fail because the platform's own bookkeeping
//! did.** The cost of a dropped wake is that a worker starts late; the cost of the alternative is a
//! customer's queue rejecting jobs because a dispatcher they have never heard of is unwell.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tracing::{debug, warn};

/// The sorted set every proxy replica reports into.
pub const MASTER_WAKE_KEY: &str = "sproutos:master:wake";

/// How long wakes are batched before a write.
///
/// A busy queue produces thousands of commands a second and one useful fact. Coalescing for a
/// second turns that into one `ZADD` and costs a dispatcher, at worst, a second of latency on a
/// decision whose whole point is that it happens on a human timescale.
const FLUSH_INTERVAL: Duration = Duration::from_secs(1);

/// Queue depth before wakes are dropped.
///
/// Bounded because the alternative is letting a burst of enqueues grow the proxy's memory. At this
/// size a drop means several thousand distinct queues went active inside one flush interval, which
/// is a fleet-sized event rather than a tenant-sized one.
const CHANNEL_CAPACITY: usize = 4096;

/// One queue became active.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Wake {
    /// The tenant resource's Crockford short id — the same one the key prefix carries.
    pub resource: String,
    /// The queue name as the tenant wrote it, without the namespace or the `bull:` prefix.
    pub queue: String,
}

impl Wake {
    /// The sorted-set member. `<resource>/<queue>`, which the dispatcher splits on the first slash.
    ///
    /// A queue name may itself contain a slash, so the split is on the *first* one and the resource
    /// short id — which is Crockford base32 and cannot contain one — is what makes that safe.
    pub fn member(&self) -> String {
        format!("{}/{}", self.resource, self.queue)
    }
}

/// A handle the connection handlers report to. Cloning is cheap; it is a channel sender.
#[derive(Clone)]
pub struct MasterQueue {
    sender: Option<mpsc::Sender<Wake>>,
}

impl MasterQueue {
    /// A master queue that discards everything, for tests and for a deployment that has no
    /// dispatcher. Named rather than an `Option<MasterQueue>` at every call site.
    pub fn disabled() -> Self {
        Self { sender: None }
    }

    /// Start the writer task and return a handle.
    ///
    /// The backend address is resolved on each reconnect rather than once, matching how `serve`
    /// treats it: a service address behind a cluster DNS name can move.
    pub fn spawn(backend: String) -> Self {
        let (sender, receiver) = mpsc::channel(CHANNEL_CAPACITY);
        tokio::spawn(run(backend, receiver));
        Self {
            sender: Some(sender),
        }
    }

    /// Report that a queue became active. Never blocks, never fails.
    pub fn wake(&self, wake: Wake) {
        let Some(sender) = &self.sender else { return };

        // `try_send`, not `send`. A tenant's command is not going to wait on the platform's
        // bookkeeping, and a full channel already means the dispatcher has more to do than it can
        // possibly be behind on.
        if sender.try_send(wake).is_err() {
            debug!("master queue is full; dropping a wake");
        }
    }
}

/// The writer task: batch, deduplicate, write, repeat.
async fn run(backend: String, mut receiver: mpsc::Receiver<Wake>) {
    let mut pending: HashMap<String, u64> = HashMap::new();
    let mut connection: Option<TcpStream> = None;
    let mut ticker = tokio::time::interval(FLUSH_INTERVAL);

    loop {
        tokio::select! {
            received = receiver.recv() => {
                match received {
                    // The last handle went away, which happens only at shutdown. Flush what is held
                    // rather than losing it.
                    None => {
                        flush(&backend, &mut connection, &mut pending).await;
                        return
                    }
                    Some(wake) => {
                        // Newest wins, matching the `GT` the write uses.
                        let entry = pending.entry(wake.member()).or_insert(0);
                        *entry = (*entry).max(now_ms());
                    }
                }
            }
            _ = ticker.tick() => flush(&backend, &mut connection, &mut pending).await,
        }
    }
}

async fn flush(
    backend: &str,
    connection: &mut Option<TcpStream>,
    pending: &mut HashMap<String, u64>,
) {
    if pending.is_empty() {
        return;
    }

    if connection.is_none() {
        match TcpStream::connect(backend).await {
            Ok(stream) => *connection = Some(stream),
            Err(cause) => {
                /*
                  Dropped, not retained.

                  Holding wakes across a failed connection would mean an outage produces a burst of
                  stale ones when it ends, every score long past. The fact being reported is "there
                  is work now", and a tenant with work will enqueue again.
                */
                warn!(%cause, "master queue backend unreachable; dropping wakes");
                pending.clear();
                return;
            }
        }
    }

    let Some(stream) = connection.as_mut() else {
        return;
    };

    let command = zadd_gt(pending);
    if let Err(cause) = stream.write_all(&command).await {
        warn!(%cause, "master queue write failed; reconnecting");
        *connection = None;
    }

    /*
      The reply is never read.

      Nothing here branches on it, and reading would mean a second failure mode — a blocked read on
      a backend that is slow — in the one task that must not block. The kernel buffers the replies
      and they are discarded when the connection is replaced. That is deliberate rather than
      overlooked: this connection only ever issues one command shape, and the shape either arrives
      or the write errors.
    */
    pending.clear();
}

/// One `ZADD ... GT` carrying every pending member, encoded as a RESP array.
///
/// Sorted by member so the encoding is deterministic — which is what makes it assertable in a test
/// rather than merely runnable.
pub fn zadd_gt(pending: &HashMap<String, u64>) -> Vec<u8> {
    let mut members: Vec<(&String, &u64)> = pending.iter().collect();
    members.sort_by(|a, b| a.0.cmp(b.0));

    let mut args: Vec<Vec<u8>> = Vec::with_capacity(3 + members.len() * 2);
    args.push(b"ZADD".to_vec());
    args.push(MASTER_WAKE_KEY.as_bytes().to_vec());
    // `GT` so a score never goes backwards. Two proxy replicas reporting the same queue must not
    // let the slower one's clock make a queue look staler than it is.
    args.push(b"GT".to_vec());
    for (member, score) in members {
        args.push(score.to_string().into_bytes());
        args.push(member.as_bytes().to_vec());
    }

    let mut out = format!("*{}\r\n", args.len()).into_bytes();
    for arg in args {
        out.extend_from_slice(format!("${}\r\n", arg.len()).as_bytes());
        out.extend_from_slice(&arg);
        out.extend_from_slice(b"\r\n");
    }
    out
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_member_joins_the_resource_and_the_queue() {
        let wake = Wake {
            resource: "01j4pkz2hbfh6sw7sa7d65tvkz".into(),
            queue: "emails".into(),
        };
        assert_eq!(wake.member(), "01j4pkz2hbfh6sw7sa7d65tvkz/emails");
    }

    /// A queue name may contain a slash; a Crockford short id may not. The dispatcher splits on the
    /// first one, so the name survives intact.
    #[test]
    fn a_queue_name_may_contain_a_slash() {
        let wake = Wake {
            resource: "01j4pkz2hbfh6sw7sa7d65tvkz".into(),
            queue: "media/transcode".into(),
        };
        let member = wake.member();
        let (resource, queue) = member.split_once('/').unwrap();
        assert_eq!(resource, "01j4pkz2hbfh6sw7sa7d65tvkz");
        assert_eq!(queue, "media/transcode");
    }

    #[test]
    fn one_zadd_carries_every_pending_queue() {
        let mut pending = HashMap::new();
        pending.insert("res/b".to_string(), 200u64);
        pending.insert("res/a".to_string(), 100u64);

        let encoded = String::from_utf8(zadd_gt(&pending)).unwrap();

        // 3 fixed arguments plus a score and a member each.
        assert!(encoded.starts_with("*7\r\n"));
        assert!(encoded.contains("ZADD"));
        assert!(encoded.contains(MASTER_WAKE_KEY));
        assert!(encoded.contains("GT"));
        // Sorted by member, so the bytes are the same every run.
        assert!(encoded.find("res/a").unwrap() < encoded.find("res/b").unwrap());
        assert!(encoded.contains("100"));
        assert!(encoded.contains("200"));
    }

    /// The disabled handle is the one a deployment without a dispatcher uses. It must be silent
    /// rather than merely harmless — an error per enqueue would drown the log.
    #[test]
    fn a_disabled_queue_accepts_and_discards() {
        let queue = MasterQueue::disabled();
        queue.wake(Wake {
            resource: "res".into(),
            queue: "q".into(),
        });
    }
}
