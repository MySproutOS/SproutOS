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
use std::time::Duration;

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

    /*
      One round trip, and the read must come back typed.

      `.ignore()` on the `DEL` drops its reply, so the pipeline's result is the `ZRANGE` alone —
      but redis-rs still hands back a one-element tuple for an atomic pipeline, and asking for a
      bare `Vec<String>` deserialises the *outer* array into nothing. The symptom is an empty drain
      against a set that visibly has members, which reads as "no queues are active".
    */
    let members: Result<(Vec<String>,), redis::RedisError> = redis::pipe()
        .atomic()
        .zrange(MASTER_WAKE_KEY, 0, -1)
        .del(MASTER_WAKE_KEY)
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

/// What the control plane published about a queue.
#[derive(Debug, serde::Deserialize)]
pub struct QueueBinding {
    #[serde(rename = "functionArn")]
    pub function_arn: Option<String>,
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
pub async fn run(valkey: ConnectionManager, lambda: LambdaClient) {
    loop {
        for pending in drain_master(&valkey).await {
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

            /*
              Credit before starting work, the same as a web request.

              A background job is the easier place to overspend: nobody is watching it, and a queue
              that keeps filling would keep invoking. This is the same check `serve` makes, for the
              same reason.
            */
            if crate::credit::read_credit(&valkey, &binding.organization_id).await
                == crate::credit::Credit::Exhausted
            {
                tracing::info!(
                    organization = binding.organization_id,
                    "not dispatching a queue for an organization out of credit"
                );
                continue;
            }

            let Some(arn) = binding.function_arn.as_deref() else {
                // A standalone queue with no project has no function to run a worker in. Not an
                // error: a customer can use a Valkey without deploying anything to consume it.
                continue;
            };

            if let Err(cause) = invoke_worker(&lambda, arn, &pending).await {
                tracing::error!(%cause, queue = pending.queue, "could not start a worker");
            }
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
