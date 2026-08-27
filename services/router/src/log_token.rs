//! Verifying the token a Lambda extension presents when it ships a customer's logs.
//!
//! ## Why a token at all, and why one per project
//!
//! The extension used to hold a Kafka SASL credential and produce straight to the broker. That
//! credential sat in the function's environment, which means **the customer's own code could read
//! it** — `process.env` is not a boundary against the process it belongs to. Worse than the leak:
//! the credential was authorized to `Write` the shared `runtime-logs` topic, and Kafka cannot
//! validate a message's contents, so anyone holding it could publish records carrying *another*
//! tenant's `project_id`. Those records carry `billed_ms`. Forged logs were forged bills.
//!
//! This token is still readable by the customer's code, and that is fine, because it says only one
//! thing: *this is project X in organization Y*. The router derives both identities from the token
//! and stamps them onto every record, ignoring whatever the payload claimed. Organization became
//! part of the claim when verified `platform.report` records became billable usage; the extension
//! must never be allowed to choose who pays.
//!
//! That is the whole shape of the fix: not "hide the credential better", but "make holding it
//! useless for anything but the thing its holder is already entitled to do".
//!
//! ## The format
//!
//! `<project-id>.<organization-id>.<expires-at>.<hmac-sha256-base64url>`. One format, one set of
//! fixtures, minted in TypeScript and verified here — a divergence would be a tenant's logs
//! silently refused, or worse, accepted under the wrong billing owner.

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, PartialEq, Eq)]
pub enum TokenError {
    Malformed,
    BadSignature,
    Expired,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Claims {
    pub project_id: String,
    /// Absent only for the pre-metering token shape. It may still write project logs, but cannot
    /// produce a bill until the project is redeployed with an organization-bound token.
    pub organization_id: Option<String>,
}

/// The project a token proves, or why it proves nothing.
///
/// `now` is seconds since the epoch, passed in rather than read here so the expiry boundary is
/// testable without sleeping.
pub fn claims_of(token: &str, secret: &[u8], now: u64) -> Result<Claims, TokenError> {
    let parts: Vec<_> = token.split('.').collect();
    let (project, organization, expiry, mac) = match parts.as_slice() {
        [project, organization, expiry, mac] => (*project, Some(*organization), *expiry, *mac),
        // Existing function versions retain their environment until the next deploy. Keep their
        // logs working during the rollout, but never infer an organization or bill from this shape.
        [project, expiry, mac] => (*project, None, *expiry, *mac),
        _ => return Err(TokenError::Malformed),
    };

    if project.is_empty() || organization.is_some_and(str::is_empty) {
        return Err(TokenError::Malformed);
    }

    let body = match organization {
        Some(organization) => format!("{project}.{organization}.{expiry}"),
        None => format!("{project}.{expiry}"),
    };

    /*
      `verify_slice` rather than computing a digest and comparing it.

      The comparison is against a value the caller chooses and can vary one byte at a time, which is
      the exact shape a timing attack needs. `Mac::verify_slice` is constant time; `==` on two byte
      slices is not, and the TypeScript side uses `timingSafeEqual` for the same reason.
    */
    let mut hasher = HmacSha256::new_from_slice(secret).map_err(|_| TokenError::BadSignature)?;
    hasher.update(body.as_bytes());

    let presented = base64_url_decode(mac).ok_or(TokenError::Malformed)?;
    hasher
        .verify_slice(&presented)
        .map_err(|_| TokenError::BadSignature)?;

    // Parsed *after* the signature is checked. An unsigned token's expiry is not a fact about
    // anything, and parsing it first would answer "expired" for a forgery — telling a forger which
    // half of their guess was wrong.
    let expires_at: u64 = expiry.parse().map_err(|_| TokenError::Malformed)?;
    if expires_at <= now {
        return Err(TokenError::Expired);
    }

    Ok(Claims {
        project_id: project.to_owned(),
        organization_id: organization.map(str::to_owned),
    })
}

/// base64url without padding, which is what Node's `digest("base64url")` produces.
fn base64_url_decode(value: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value.as_bytes())
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same secret and vectors the TypeScript side asserts against. See
    /// `fixtures/log-token.json` — both languages read that file rather than hard-coding a token,
    /// because a fixture only proves agreement if neither side can quietly change it alone.
    fn fixtures() -> serde_json::Value {
        let raw = include_str!("../fixtures/log-token.json");
        serde_json::from_str(raw).expect("fixtures parse")
    }

    #[test]
    fn accepts_the_shared_vector() {
        let f = fixtures();
        let secret = f["secret"].as_str().unwrap().as_bytes();
        let token = f["valid"]["token"].as_str().unwrap();
        let project = f["valid"]["projectId"].as_str().unwrap();
        let organization = f["valid"]["organizationId"].as_str().unwrap();

        assert_eq!(
            claims_of(token, secret, 0),
            Ok(Claims {
                project_id: project.to_owned(),
                organization_id: Some(organization.to_owned()),
            })
        );
    }

    #[test]
    fn legacy_project_only_token_keeps_logging_but_cannot_bill() {
        let claims = claims_of(
            "01a03b00-0000-7000-8000-00000000beef.4102444800.jTDkl8aIbYWyGHES0nTYkS2kG20q7vtB0zkpCK1k8cc",
            b"log-token-fixture-secret",
            0,
        )
        .unwrap();

        assert_eq!(claims.project_id, "01a03b00-0000-7000-8000-00000000beef");
        assert_eq!(claims.organization_id, None);
    }

    #[test]
    fn refuses_a_token_signed_with_another_secret() {
        let f = fixtures();
        let token = f["valid"]["token"].as_str().unwrap();

        assert_eq!(
            claims_of(token, b"not-the-secret", 0),
            Err(TokenError::BadSignature)
        );
    }

    /// The attack this whole module exists to stop: taking a real token and editing the project id.
    #[test]
    fn refuses_a_token_whose_project_was_swapped() {
        let f = fixtures();
        let secret = f["secret"].as_str().unwrap().as_bytes();
        let token = f["valid"]["token"].as_str().unwrap();

        let mut parts = token.split('.');
        let _ = parts.next();
        let rest: Vec<&str> = parts.collect();
        let forged = format!("01a03b00-0000-7000-8000-00000000dead.{}", rest.join("."));

        assert_eq!(claims_of(&forged, secret, 0), Err(TokenError::BadSignature));
    }

    #[test]
    fn refuses_a_token_whose_organization_was_swapped() {
        let f = fixtures();
        let secret = f["secret"].as_str().unwrap().as_bytes();
        let token = f["valid"]["token"].as_str().unwrap();
        let mut parts: Vec<&str> = token.split('.').collect();
        parts[1] = "01912d3f-8a2b-7c4d-9e1f-2a3b4c5ddead";

        assert_eq!(
            claims_of(&parts.join("."), secret, 0),
            Err(TokenError::BadSignature)
        );
    }

    #[test]
    fn refuses_an_expired_token() {
        let f = fixtures();
        let secret = f["secret"].as_str().unwrap().as_bytes();
        let token = f["valid"]["token"].as_str().unwrap();
        let expires_at = f["valid"]["expiresAt"].as_u64().unwrap();

        assert_eq!(
            claims_of(token, secret, expires_at),
            Err(TokenError::Expired)
        );
        assert!(claims_of(token, secret, expires_at - 1).is_ok());
    }

    #[test]
    fn refuses_a_shape_that_is_not_a_token() {
        let secret = b"s";
        for bad in ["", "a", "a.b", "a.b.c.d.e", ".o.1.x"] {
            assert!(
                matches!(
                    claims_of(bad, secret, 0),
                    Err(TokenError::Malformed) | Err(TokenError::BadSignature)
                ),
                "{bad:?} was accepted"
            );
        }
    }
}
