//! Wake-on-connect.
//!
//! A Neon endpoint's compute can be absent while its timeline is not — that absence is the entire
//! economic argument for separating compute from storage. This is what makes it invisible: a
//! connection arrives, the compute is started if it is not running, and the client's first query
//! answers. The customer sees a slow connection, not an error.
//!
//! ## Why the proxy asks rather than acts
//!
//! Starting a compute means creating a workload — a container here, a pod in a cluster. This process
//! sits on every tenant's connection path and deliberately holds no credential that can do that: a
//! proxy whose compromise creates workloads is a much worse proxy. So it asks the control plane over
//! HTTP and uses the address it is given.
//!
//! ## Why this is not on the fast path
//!
//! It is called on every connection, and on all but the first the control plane answers from one
//! indexed read. A connection to a warm database pays a single round trip on a private network,
//! once, at connect time — not per query.
//!
//! Absent configuration this does nothing at all and the proxy connects to the shared cluster as
//! before. That is what keeps `provider = 'sprout'` working while `neon` is being rolled out, and it
//! is a deliberate default rather than an oversight: a proxy that refused to start without a wake
//! endpoint would take down every existing tenant the day it shipped.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::SessionError;

/// How long to wait for the control plane to bring a compute up.
///
/// Longer than an ordinary HTTP timeout because the work behind it is starting Postgres. Shorter
/// than a client's patience, so a wake that will not finish fails with a message rather than by the
/// client giving up first and leaving this holding a socket.
const WAKE_TIMEOUT: Duration = Duration::from_secs(100);

#[derive(Debug, Clone)]
pub struct WakeConfig {
    /// e.g. `http://internal-api:3001/v1/internal/neon/wake`.
    pub url: String,
}

/// Read the wake endpoint from the environment, if there is one.
///
/// `None` is a valid, common answer: a deployment with no Neon backend has nothing to wake, and the
/// proxy routes to the shared cluster.
pub fn wake_config_from_env() -> Option<WakeConfig> {
    let url = std::env::var("PG_PROXY_WAKE_URL").ok()?;
    if url.is_empty() {
        return None;
    }
    Some(WakeConfig { url })
}

#[derive(Serialize)]
struct WakeRequest<'a> {
    backend_service_id: &'a str,
}

#[derive(Deserialize)]
pub struct ComputeAddress {
    pub host: String,
    pub port: u16,
}

/// Ask the control plane where this service's compute is, starting it if necessary.
///
/// `Ok(None)` means "not a Neon service" — the control plane has no endpoint for it, and the caller
/// should route to the shared cluster. That is a 404 rather than an error because it is the normal
/// answer for every `sprout` database, which is currently all of them.
pub async fn wake(
    client: &reqwest::Client,
    config: &WakeConfig,
    backend_service_id: &str,
) -> Result<Option<ComputeAddress>, SessionError> {
    let response = client
        .post(&config.url)
        .timeout(WAKE_TIMEOUT)
        .json(&WakeRequest { backend_service_id })
        .send()
        .await
        .map_err(|error| {
            SessionError::Backend(format!("could not reach the control plane: {error}"))
        })?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }

    if !response.status().is_success() {
        /*
            A wake that failed is not a bad password.

            Reported as a backend problem so the client sees "the server is unavailable" and its
            driver retries, rather than an authentication error, which every Postgres driver treats
            as fatal and stops on.
        */
        return Err(SessionError::Backend(format!(
            "the control plane could not start a compute: {}",
            response.status()
        )));
    }

    response
        .json::<ComputeAddress>()
        .await
        .map(Some)
        .map_err(|error| SessionError::Backend(format!("unreadable wake response: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_absent_unless_configured() {
        // The default has to be "do nothing": a proxy that refused to start without a wake endpoint
        // would take down every `sprout` tenant the day it shipped.
        unsafe {
            std::env::remove_var("PG_PROXY_WAKE_URL");
        }
        assert!(wake_config_from_env().is_none());

        unsafe {
            std::env::set_var("PG_PROXY_WAKE_URL", "");
        }
        // An empty value is how an unset variable arrives through most deployment tooling, and is
        // not a URL.
        assert!(wake_config_from_env().is_none());

        unsafe {
            std::env::set_var("PG_PROXY_WAKE_URL", "http://api:3001/v1/internal/neon/wake");
        }
        assert!(wake_config_from_env().is_some());
        unsafe {
            std::env::remove_var("PG_PROXY_WAKE_URL");
        }
    }

    #[test]
    fn allows_longer_than_an_http_call_but_less_than_a_client_waits() {
        // The work behind it is starting Postgres. Too short and every cold start fails; too long
        // and the client gives up first, leaving this holding a socket for a compute nobody wants.
        assert!(WAKE_TIMEOUT > Duration::from_secs(30));
        assert!(WAKE_TIMEOUT < Duration::from_secs(120));
    }
}
