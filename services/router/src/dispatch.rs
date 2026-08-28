//! Starting a worker when a tenant's queue goes active.
//!
//! §4.6. `valkey-proxy` reports every queue that saw an enqueue into one sorted set — the master
//! queue — and this is the other half: read that set, and invoke the project's own Lambda to drain
//! what is waiting.
//!
//! ## Why the customer's own function
//!
//! A workflow worker runs the customer's code. It could run in a function of ours with their code
//! fetched in, and that would be a second deployment path to build, secure and keep in step with
//! the first. Their function is already deployed, already carries their environment, and is already
//! the thing their web requests run in — so a background job runs the same code as a request, which
//! is what a customer expects and what makes a bug reproducible.
//!
//! ## Batch, not per job
//!
//! One invocation drains up to `MAX_JOBS_PER_INVOCATION`. Per-job would be simpler to bill and
//! roughly the right answer for a queue that sees one job a minute; for a queue that sees a
//! thousand, it is a thousand cold-start-eligible invocations to do work that fits in one. The cap
//! is what stops the other failure — a single invocation trying to drain a backlog and hitting the
//! function's timeout with the queue no shorter than it started.

use std::collections::HashSet;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use aws_sdk_lambda::Client as LambdaClient;
use aws_sdk_lambda::primitives::Blob;
use aws_sdk_lambda::types::InvocationType;
use redis::aio::ConnectionManager;

/// The sorted set `valkey-proxy` reports into. Must match `valkey_proxy::master::MASTER_WAKE_KEY`.
pub const MASTER_WAKE_KEY: &str = valkey_proxy::master::MASTER_WAKE_KEY;

/// How many jobs one worker invocation is asked to drain.
pub const MAX_JOBS_PER_INVOCATION: u32 = 25;

/// How often the master queue is read.
///
/// The proxy coalesces wakes for a second before writing, so reading faster than that finds the
/// same entries again. A background job's first-run latency after a lull is what this trades
/// against, and a second or two is not what anyone notices about a background job.
pub const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// A transient refusal must not hot-loop, but it also must not require another customer enqueue.
pub const RETRY_DELAY: Duration = Duration::from_secs(30);

/// One queue that needs a worker.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Pending {
    /// The tenant resource's Crockford short id.
    pub resource: String,
    pub queue: String,
}

/// Split a master-queue member back into its parts.
///
/// On the **first** slash: a queue name may contain one, and the resource short id is Crockford
/// base32, which cannot. Splitting on the last slash would give a queue called `a/b` a resource of
/// `<id>/a`, which resolves to nothing and silently never runs.
pub fn parse_member(member: &str) -> Option<Pending> {
    let (resource, queue) = member.split_once('/')?;
    if resource.is_empty() || queue.is_empty() {
        return None;
    }
    Some(Pending {
        resource: resource.to_owned(),
        queue: queue.to_owned(),
    })
}

/// The event a worker invocation receives.
///
/// The same `sproutos` envelope a workflow node gets, so a customer's handler has one place to look
/// for "this is not a web request" rather than two shapes to tell apart.
pub fn worker_event(pending: &Pending) -> serde_json::Value {
    serde_json::json!({
        "sproutos": {
            "kind": "queue.drain",
            "queue": pending.queue,
            "resource": pending.resource,
            "maxJobs": MAX_JOBS_PER_INVOCATION,
        }
    })
}

/// Take everything currently in the master queue, and clear what was taken.
///
/// Read and remove in one round trip. Reading and then deleting separately drops any wake written
/// between the two — a queue that went active in that window would wait for its next enqueue to be
/// noticed, which for a queue that just went quiet is forever.
pub async fn drain_master(valkey: &ConnectionManager) -> Vec<Pending> {
    let mut connection = valkey.clone();
    // One cutoff for both commands. Re-reading the clock before removal could delete a wake that
    // became due between the range and remove without ever returning it to the dispatcher.
    let cutoff = now_ms();

    /*
      One round trip, and the read must come back typed.

      `.ignore()` on the `DEL` drops its reply, so the pipeline's result is the `ZRANGE` alone —
      but redis-rs still hands back a one-element tuple for an atomic pipeline, and asking for a
      bare `Vec<String>` deserialises the *outer* array into nothing. The symptom is an empty drain
      against a set that visibly has members, which reads as "no queues are active".
    */
    let members: Result<(Vec<String>,), redis::RedisError> = redis::pipe()
        .atomic()
        // Future scores are delayed-job alarms. Taking them here would invoke early and erase the
        // only fact that can wake the queue when the job becomes due.
        .zrangebyscore(MASTER_WAKE_KEY, "-inf", cutoff)
        .zrembyscore(MASTER_WAKE_KEY, "-inf", cutoff)
        .ignore()
        .query_async(&mut connection)
        .await;
    let members = members.map(|(members,)| members);

    match members {
        Ok(members) => members
            .iter()
            .filter_map(|member| parse_member(member))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect(),
        Err(error) => {
            tracing::warn!(%error, "could not read the master queue");
            Vec::new()
        }
    }
}

fn delayed_key(pending: &Pending) -> String {
    format!("{{kv:{}}}:bull:{}:delayed", pending.resource, pending.queue)
}

fn bullmq_due_ms(score: f64) -> Option<u64> {
    if !score.is_finite() || score < 0.0 {
        return None;
    }
    // BullMQ reserves the low 12 bits for ordering jobs with the same millisecond timestamp.
    Some((score / 4096.0).floor() as u64)
}

/// Preserve an alarm for the earliest BullMQ delayed job after the initial enqueue wake.
async fn preserve_delayed_wake(valkey: &ConnectionManager, pending: &Pending) {
    let mut connection = valkey.clone();
    let rows: Result<Vec<(String, f64)>, redis::RedisError> = redis::cmd("ZRANGE")
        .arg(delayed_key(pending))
        .arg(0)
        .arg(0)
        .arg("WITHSCORES")
        .query_async(&mut connection)
        .await;
    let Some(due_ms) = rows
        .ok()
        .and_then(|rows| rows.first().and_then(|(_, score)| bullmq_due_ms(*score)))
    else {
        return;
    };

    // A due job may still be present while the async Lambda starts. Recheck after a bounded grace
    // period rather than writing a past score that would hot-loop invocations every two seconds.
    let wake_ms = due_ms.max(now_ms().saturating_add(30_000));
    let mut connection = valkey.clone();
    let result: Result<(), redis::RedisError> = redis::cmd("ZADD")
        .arg(MASTER_WAKE_KEY)
        .arg("GT")
        .arg(wake_ms)
        .arg(format!("{}/{}", pending.resource, pending.queue))
        .query_async(&mut connection)
        .await;
    if let Err(error) = result {
        tracing::warn!(%error, queue = pending.queue, "could not preserve delayed queue wake");
    }
}

async fn rearm_wake(valkey: &ConnectionManager, pending: &Pending) {
    let retry_at = now_ms().saturating_add(RETRY_DELAY.as_millis() as u64);
    let mut connection = valkey.clone();
    let result: Result<(), redis::RedisError> = redis::cmd("ZADD")
        .arg(MASTER_WAKE_KEY)
        .arg("GT")
        .arg(retry_at)
        .arg(format!("{}/{}", pending.resource, pending.queue))
        .query_async(&mut connection)
        .await;
    if let Err(error) = result {
        tracing::warn!(%error, queue = pending.queue, "could not rearm queue wake");
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Ask a project's function to drain one queue.
///
/// `Event`, not `RequestResponse`: nothing is waiting for the answer, and a synchronous invoke
/// would hold a dispatcher task for the length of the work. Lambda retries a failed asynchronous
/// invocation twice on its own, which is the behaviour a queue drain wants — and is another reason
/// the batch is capped, since a retry redoes the whole batch.
pub async fn invoke_worker(
    lambda: &LambdaClient,
    function_arn: &str,
    pending: &Pending,
) -> anyhow::Result<()> {
    let payload = serde_json::to_vec(&worker_event(pending))?;

    lambda
        .invoke()
        .function_name(function_arn)
        .invocation_type(InvocationType::Event)
        .payload(Blob::new(payload))
        .send()
        .await?;

    Ok(())
}

#[async_trait]
pub trait WorkerInvoker: Send + Sync {
    async fn invoke(&self, function_arn: &str, pending: &Pending) -> anyhow::Result<()>;
}

#[async_trait]
impl WorkerInvoker for LambdaClient {
    async fn invoke(&self, function_arn: &str, pending: &Pending) -> anyhow::Result<()> {
        invoke_worker(self, function_arn, pending).await
    }
}

/// What the control plane published about a queue.
#[derive(Debug, serde::Deserialize)]
pub struct QueueBinding {
    #[serde(rename = "functionArn")]
    pub function_arn: Option<String>,
    #[serde(rename = "projectId")]
    pub project_id: Option<String>,
    #[serde(rename = "organizationId")]
    pub organization_id: String,
}

pub fn binding_key(resource_short_id: &str) -> String {
    format!("queue:{resource_short_id}")
}

/// Run the dispatcher until the process ends.
///
/// One loop, not a task per queue. The master queue is already coalesced by the proxy, so the work
/// per pass is proportional to how many *distinct* queues went active — a number bounded by the
/// number of tenants, not by how busy they are.
pub async fn dispatch_once<I: WorkerInvoker>(valkey: &ConnectionManager, invoker: &I) {
    for pending in drain_master(valkey).await {
        let mut connection = valkey.clone();
        let raw: Result<Option<String>, redis::RedisError> =
            redis::AsyncCommands::get(&mut connection, binding_key(&pending.resource)).await;

        let Ok(Some(raw)) = raw else {
            // A wake for a queue with no binding: the service was destroyed between the enqueue
            // and this pass, or was never published. Dropped rather than retried — there is
            // nothing to invoke and the next enqueue will wake it again if it comes back.
            tracing::debug!(resource = pending.resource, "no binding for a woken queue");
            continue;
        };

        let Ok(binding) = serde_json::from_str::<QueueBinding>(&raw) else {
            tracing::warn!(resource = pending.resource, "unreadable queue binding");
            continue;
        };

        // Preserve the alarm before any credit/function early return. Credit can recover and a
        // deployment can appear; neither should require the customer to enqueue another job.
        preserve_delayed_wake(valkey, &pending).await;

        let Some(arn) = binding.function_arn.as_deref() else {
            // An attached service can exist before its first production deployment, or while a
            // failed release rolls back. Keep its wake until a live alias appears. A standalone
            // queue intentionally has no worker target and should not poll forever.
            if binding.project_id.is_some() {
                rearm_wake(valkey, &pending).await;
            }
            continue;
        };

        /*
          Credit before starting work, the same as a web request.

          A background job is the easier place to overspend: nobody is watching it, and a queue
          that keeps filling would keep invoking. This is the same check `serve` makes, for the
          same reason.
        */
        if crate::credit::read_credit(valkey, &binding.organization_id).await
            == crate::credit::Credit::Exhausted
        {
            tracing::info!(
                organization = binding.organization_id,
                "not dispatching a queue for an organization out of credit"
            );
            rearm_wake(valkey, &pending).await;
            continue;
        }

        if let Err(cause) = invoker.invoke(arn, &pending).await {
            tracing::error!(%cause, queue = pending.queue, "could not start a worker");
            rearm_wake(valkey, &pending).await;
        }
    }
}

pub async fn run(valkey: ConnectionManager, lambda: LambdaClient) {
    loop {
        dispatch_once(&valkey, &lambda).await;

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn dispatcher_test_lock() -> &'static tokio::sync::Mutex<()> {
        static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
    }

    #[derive(Default)]
    struct RecordingInvoker(Mutex<Vec<(String, Pending)>>);

    #[async_trait]
    impl WorkerInvoker for RecordingInvoker {
        async fn invoke(&self, function_arn: &str, pending: &Pending) -> anyhow::Result<()> {
            self.0
                .lock()
                .expect("recording invoker")
                .push((function_arn.to_owned(), pending.clone()));
            Ok(())
        }
    }

    struct FailingInvoker;

    #[async_trait]
    impl WorkerInvoker for FailingInvoker {
        async fn invoke(&self, _function_arn: &str, _pending: &Pending) -> anyhow::Result<()> {
            anyhow::bail!("deterministic invocation failure")
        }
    }

    #[test]
    fn splits_a_member_on_the_first_slash() {
        // A queue name may contain a slash; a Crockford short id cannot. Splitting on the last one
        // would give a queue called `emails/urgent` a resource of `<id>/emails`, which resolves to
        // nothing and never runs — with no error anywhere.
        let parsed = parse_member("01m0j8dfg4/emails/urgent").expect("a pending queue");

        assert_eq!(parsed.resource, "01m0j8dfg4");
        assert_eq!(parsed.queue, "emails/urgent");
    }

    #[test]
    fn refuses_a_member_that_names_nothing() {
        assert_eq!(parse_member("no-slash"), None);
        assert_eq!(parse_member("/queue"), None);
        assert_eq!(parse_member("resource/"), None);
        assert_eq!(parse_member(""), None);
    }

    #[test]
    fn agrees_with_the_proxy_about_the_key() {
        // The proxy writes and this reads. Two constants that drift is a dispatcher polling a set
        // nothing writes to, which looks exactly like a platform where no queue ever runs.
        assert_eq!(MASTER_WAKE_KEY, "sproutos:master:wake");
    }

    #[test]
    fn round_trips_what_the_proxy_would_have_written() {
        let wake = valkey_proxy::master::Wake {
            resource: "01m0j8dfg4".into(),
            queue: "emails".into(),
        };

        // The one seam between the two halves, asserted against the proxy's own encoder rather
        // than against a string this file also wrote.
        assert_eq!(
            parse_member(&wake.member()),
            Some(Pending {
                resource: "01m0j8dfg4".into(),
                queue: "emails".into()
            })
        );
    }

    #[test]
    fn tells_the_worker_what_to_drain_and_how_much() {
        let event = worker_event(&Pending {
            resource: "01m0j8dfg4".into(),
            queue: "emails".into(),
        });

        assert_eq!(event["sproutos"]["kind"], "queue.drain");
        assert_eq!(event["sproutos"]["queue"], "emails");
        // Capped, so one invocation cannot try to drain a backlog and hit the function's timeout
        // with the queue no shorter than it started.
        assert_eq!(event["sproutos"]["maxJobs"], MAX_JOBS_PER_INVOCATION);
    }

    #[test]
    fn uses_the_same_envelope_a_workflow_node_gets() {
        // One place a customer's handler looks for "this is not a web request", not two shapes to
        // tell apart.
        let event = worker_event(&Pending {
            resource: "r".into(),
            queue: "q".into(),
        });

        assert!(event.get("sproutos").is_some());
        assert!(event["sproutos"].get("kind").is_some());
    }

    #[test]
    fn decodes_bullmq_delayed_scores_without_losing_the_timestamp() {
        let timestamp = 1_787_844_000_123_u64;
        assert_eq!(
            bullmq_due_ms((timestamp * 4096 + 37) as f64),
            Some(timestamp)
        );
        assert_eq!(bullmq_due_ms(f64::NAN), None);
    }

    #[test]
    fn delayed_key_is_the_same_namespaced_bullmq_key_the_proxy_writes() {
        assert_eq!(
            delayed_key(&Pending {
                resource: "01hb".into(),
                queue: "emails".into()
            }),
            "{kv:01hb}:bull:emails:delayed"
        );
    }

    #[tokio::test]
    async fn a_real_valkey_binding_dispatches_exactly_the_live_alias() {
        let _guard = dispatcher_test_lock().lock().await;
        // Database 15 keeps this master queue independent from the proxy integration suite, whose
        // producers intentionally use the same key name in database 0.
        let url = std::env::var("ROUTER_DISPATCH_TEST_VALKEY_URL")
            .unwrap_or_else(|_| "redis://localhost:41023/15".into());
        let Ok(client) = redis::Client::open(url) else {
            panic!("ROUTER_DISPATCH_TEST_VALKEY_URL is invalid")
        };
        let manager =
            tokio::time::timeout(Duration::from_secs(1), ConnectionManager::new(client)).await;
        let Ok(Ok(manager)) = manager else {
            assert!(
                std::env::var("CI").is_err(),
                "the real Valkey dispatcher acceptance is required in CI"
            );
            eprintln!("skipping real dispatcher acceptance: Valkey is unavailable");
            return;
        };

        let resource = format!("dispatch{}", uuid::Uuid::now_v7().simple());
        let queue = format!("celery-{}", uuid::Uuid::now_v7().simple());
        let arn = "arn:aws:lambda:us-east-1:123456789012:function:sproutos-app:live";
        let binding = binding_key(&resource);
        let member = format!("{resource}/{queue}");
        let mut connection = manager.clone();
        let _: () = redis::pipe()
            .atomic()
            .set(
                &binding,
                serde_json::json!({
                    "uri": "rediss://tenant:redacted@example.test:6379/0",
                    "backendServiceId": uuid::Uuid::now_v7(),
                    "projectId": uuid::Uuid::now_v7(),
                    "organizationId": uuid::Uuid::now_v7(),
                    "functionArn": arn,
                })
                .to_string(),
            )
            .zadd(MASTER_WAKE_KEY, &member, now_ms())
            .query_async(&mut connection)
            .await
            .expect("seed a real queue binding and wake");

        let invoker = RecordingInvoker::default();
        let seeded: Vec<(String, f64)> = redis::cmd("ZRANGE")
            .arg(MASTER_WAKE_KEY)
            .arg(0)
            .arg(-1)
            .arg("WITHSCORES")
            .query_async(&mut connection)
            .await
            .expect("read seeded wake");
        assert_eq!(seeded.len(), 1, "the real master wake was not seeded");
        assert!(seeded[0].1 <= now_ms() as f64, "the wake is not due");
        dispatch_once(&manager, &invoker).await;

        assert_eq!(
            invoker.0.lock().expect("recorded invocation").as_slice(),
            &[(
                arn.to_owned(),
                Pending {
                    resource: resource.clone(),
                    queue,
                },
            )]
        );
        let mut connection = manager.clone();
        let remaining: Vec<String> = redis::cmd("ZRANGE")
            .arg(MASTER_WAKE_KEY)
            .arg(0)
            .arg(-1)
            .query_async(&mut connection)
            .await
            .expect("read drained master queue");
        assert!(remaining.is_empty());
        let _: () = redis::cmd("DEL")
            .arg(binding)
            .query_async(&mut connection)
            .await
            .expect("remove fixture binding");
    }

    #[tokio::test]
    async fn transient_dispatch_refusals_rearm_the_exact_wake() {
        let _guard = dispatcher_test_lock().lock().await;
        let url = std::env::var("ROUTER_DISPATCH_TEST_VALKEY_URL")
            .unwrap_or_else(|_| "redis://localhost:41023/15".into());
        let client = redis::Client::open(url).expect("ROUTER_DISPATCH_TEST_VALKEY_URL is invalid");
        let manager =
            tokio::time::timeout(Duration::from_secs(1), ConnectionManager::new(client)).await;
        let Ok(Ok(manager)) = manager else {
            assert!(
                std::env::var("CI").is_err(),
                "the real Valkey dispatcher recovery test is required in CI"
            );
            eprintln!("skipping real dispatcher recovery: Valkey is unavailable");
            return;
        };

        let resource = format!("rearm{}", uuid::Uuid::now_v7().simple());
        let queue = format!("celery-{}", uuid::Uuid::now_v7().simple());
        let member = format!("{resource}/{queue}");
        let binding = binding_key(&resource);
        let project_id = uuid::Uuid::now_v7().to_string();
        let organization_id = uuid::Uuid::now_v7().to_string();
        let mut connection = manager.clone();
        let seed = |function_arn: Option<&str>| {
            serde_json::json!({
                "uri": "rediss://tenant:redacted@example.test:6379/0",
                "backendServiceId": uuid::Uuid::now_v7(),
                "projectId": project_id,
                "organizationId": organization_id,
                "functionArn": function_arn,
            })
            .to_string()
        };

        let _: () = redis::pipe()
            .atomic()
            .set(&binding, seed(None))
            .zadd(MASTER_WAKE_KEY, &member, now_ms())
            .query_async(&mut connection)
            .await
            .expect("seed an attached queue without a live target");
        dispatch_once(&manager, &RecordingInvoker::default()).await;
        let absent_target_retry: Option<u64> = redis::cmd("ZSCORE")
            .arg(MASTER_WAKE_KEY)
            .arg(&member)
            .query_async(&mut connection)
            .await
            .expect("read absent-target retry");
        assert!(
            absent_target_retry.is_some_and(|score| score > now_ms()),
            "an attached queue without a function lost its wake"
        );

        let _: () = redis::pipe()
            .atomic()
            .set(
                &binding,
                seed(Some(
                    "arn:aws:lambda:us-east-1:123456789012:function:sproutos-app:live",
                )),
            )
            .zadd(MASTER_WAKE_KEY, &member, now_ms())
            .query_async(&mut connection)
            .await
            .expect("make the invocation-failure wake due");
        dispatch_once(&manager, &FailingInvoker).await;
        let invocation_retry: Option<u64> = redis::cmd("ZSCORE")
            .arg(MASTER_WAKE_KEY)
            .arg(&member)
            .query_async(&mut connection)
            .await
            .expect("read invocation retry");
        assert!(
            invocation_retry.is_some_and(|score| score > now_ms()),
            "a failed invocation lost its wake"
        );

        let _: () = redis::pipe()
            .atomic()
            .set(crate::credit::credit_key(&organization_id), "exhausted")
            .zadd(MASTER_WAKE_KEY, &member, now_ms())
            .query_async(&mut connection)
            .await
            .expect("make the credit-refusal wake due");
        let invoker = RecordingInvoker::default();
        dispatch_once(&manager, &invoker).await;
        assert!(
            invoker.0.lock().expect("recorded invocation").is_empty(),
            "an exhausted tenant was invoked"
        );
        let credit_retry: Option<u64> = redis::cmd("ZSCORE")
            .arg(MASTER_WAKE_KEY)
            .arg(&member)
            .query_async(&mut connection)
            .await
            .expect("read credit retry");
        assert!(
            credit_retry.is_some_and(|score| score > now_ms()),
            "an out-of-credit refusal lost its wake"
        );

        let _: () = redis::cmd("DEL")
            .arg(&binding)
            .arg(crate::credit::credit_key(&organization_id))
            .query_async(&mut connection)
            .await
            .expect("remove recovery fixture keys");
        let _: () = redis::cmd("ZREM")
            .arg(MASTER_WAKE_KEY)
            .arg(member)
            .query_async(&mut connection)
            .await
            .expect("remove recovery fixture wake");
    }
}
