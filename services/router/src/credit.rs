//! Not spending a customer's credit past the point they have any.
//!
//! §5. Two separate mechanisms, because they answer two different questions.
//!
//! **Before the invocation** — does this organization have credit at all? A project whose balance
//! is gone should not be invoked, and refusing here is the only thing that actually stops spend:
//! once Lambda is running, we are paying for it.
//!
//! **During the invocation** — has this one request run long enough to be a problem for a customer
//! who is nearly out? The router stops waiting and answers the client.
//!
//! ## What "kill" can and cannot mean
//!
//! AWS gives no API to abort a Lambda invocation in flight. Stopping the wait returns an error to
//! the HTTP client; **the function keeps running and keeps billing us** until it finishes or hits
//! its own configured timeout. So the real controls are that timeout and reserved concurrency, both
//! set at publish. This module cuts the client off and records why — it does not recover the cost
//! of the invocation already running, and saying otherwise would be inventing a capability.

use std::time::Duration;

use redis::AsyncCommands;
use redis::aio::ConnectionManager;

/// What the billing side says about an organization's balance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Credit {
    /// Funded, or unknown. Both are served.
    Ok,
    /// The balance is gone. Refuse before spending anything.
    Exhausted,
    /// Low enough that a long invocation is worth cutting short.
    Low,
}

/// The key the control plane writes when an organization's balance changes state.
///
/// Absent means funded. That default is deliberate: a Valkey that is down, or a key that expired,
/// must not take every customer's application offline — the failure mode of serving a request we
/// cannot bill is a rounding error, and the failure mode of a platform-wide 402 is not.
pub fn credit_key(organization_id: &str) -> String {
    format!("credit:{organization_id}")
}

pub fn parse_credit(raw: Option<&str>) -> Credit {
    match raw {
        Some("exhausted") => Credit::Exhausted,
        Some("low") => Credit::Low,
        _ => Credit::Ok,
    }
}

pub async fn read_credit(valkey: &ConnectionManager, organization_id: &str) -> Credit {
    let mut connection = valkey.clone();
    let raw: Result<Option<String>, redis::RedisError> =
        connection.get(credit_key(organization_id)).await;

    match raw {
        Ok(value) => parse_credit(value.as_deref()),
        Err(error) => {
            // Served, and logged. See `credit_key`: a cache failure must not be a billing decision.
            tracing::warn!(%error, organization_id, "could not read credit state");
            Credit::Ok
        }
    }
}

/// How long to wait for one invocation before answering the client without it.
///
/// A well-funded customer gets the function's own timeout, however long that is — **a long
/// invocation is not a fault**, and §5 says both conditions must hold. A customer who is nearly out
/// gets a short ceiling, because for them the next thirty seconds is the difference between a slow
/// request and a balance that cannot cover it.
pub fn deadline(credit: Credit, function_timeout: Duration) -> Duration {
    match credit {
        Credit::Ok => function_timeout,
        // Not zero: a request that would have finished in a second should finish. This is the
        // point past which waiting costs more than the answer is worth to someone with no cushion.
        Credit::Low => Duration::from_secs(10).min(function_timeout),
        // Never invoked, so the deadline is not reached.
        Credit::Exhausted => Duration::ZERO,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_key_means_funded() {
        /*
          The most important default here.

          A Valkey that is down, or a key that expired, must not turn into a platform-wide 402. The
          cost of serving a request we cannot bill is a rounding error; the cost of refusing every
          customer because a cache blinked is the platform being down.
        */
        assert_eq!(parse_credit(None), Credit::Ok);
        assert_eq!(parse_credit(Some("")), Credit::Ok);
        assert_eq!(parse_credit(Some("something-else")), Credit::Ok);
    }

    #[test]
    fn reads_the_two_states_the_control_plane_writes() {
        assert_eq!(parse_credit(Some("exhausted")), Credit::Exhausted);
        assert_eq!(parse_credit(Some("low")), Credit::Low);
    }

    #[test]
    fn a_well_funded_customer_is_not_cut_off_for_being_slow() {
        // §5 says both conditions: long *and* out of credit. A long invocation by somebody who can
        // pay for it is not a fault, and cutting it off would be the platform breaking a working
        // application to save the customer money they had not asked to save.
        let timeout = Duration::from_secs(300);

        assert_eq!(deadline(Credit::Ok, timeout), timeout);
    }

    #[test]
    fn a_customer_who_is_nearly_out_gets_a_short_ceiling() {
        let timeout = Duration::from_secs(300);

        let cut = deadline(Credit::Low, timeout);
        assert!(cut < timeout);
        // Not zero: a request that would have finished quickly should finish.
        assert!(cut > Duration::ZERO);
    }

    #[test]
    fn never_waits_longer_than_the_function_could_run() {
        // A function configured for three seconds should not have a ten-second ceiling imposed on
        // it — the wait would outlast the invocation and report a timeout that never happened.
        let short = Duration::from_secs(3);

        assert_eq!(deadline(Credit::Low, short), short);
    }

    #[test]
    fn an_exhausted_balance_is_refused_rather_than_timed_out() {
        // Zero, because the invocation never starts. Refusing before spending is the only thing
        // that actually stops spend: once Lambda is running, we are paying for it.
        assert_eq!(
            deadline(Credit::Exhausted, Duration::from_secs(300)),
            Duration::ZERO
        );
    }
}
