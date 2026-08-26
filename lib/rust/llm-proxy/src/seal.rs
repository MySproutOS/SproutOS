//! Opening what the control plane sealed.
//!
//! The counterpart to `lib/typescript/proxy-secret`, and the two are one definition:
//! `fixtures/proxy-secret.json` is asserted by both, for the reason `AGENTS.md` gives about every
//! cross-language seam. A divergence here is not an inconvenience — it is a router that cannot open
//! a credential, or worse, one that opens something it should not.
//!
//! **Why a shared key rather than KMS.** The router runs on a public-facing box. Giving it
//! `kms:Decrypt` on the envelope key would let anything that took that box read every customer
//! credential in the account. This key opens exactly what the control plane handed this router for
//! the session it is already proxying, and nothing else.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

/// Twelve bytes, which is what GCM is specified for and what both implementations default to.
const NONCE_BYTES: usize = 12;
/// Sixteen, the GCM tag. `aes-gcm` expects it appended to the ciphertext, which is the layout the
/// TypeScript half writes.
const TAG_BYTES: usize = 16;

#[derive(Debug, thiserror::Error)]
pub enum SealError {
    #[error("LLM_PROXY_SECRET is not set; this router cannot open a sandbox credential")]
    KeyMissing,
    /// Named rather than surfaced as a generic crypto error: with several secrets in one process,
    /// "invalid key length" is a genuinely hard error to place.
    #[error("LLM_PROXY_SECRET must be 32 bytes of base64, got {0}")]
    KeyLength(usize),
    #[error("the sealed value is not base64: {0}")]
    NotBase64(#[from] base64::DecodeError),
    #[error("the sealed value is too short to contain a nonce and a tag")]
    TooShort,
    /// GCM authenticates, so this is the only outcome for a tampered value — never a plausible
    /// wrong plaintext. That is what stops anyone with database write access redirecting the
    /// proxy's credential.
    #[error("the sealed value did not authenticate")]
    NotAuthentic,
    #[error("the sealed value is not UTF-8")]
    NotUtf8,
}

/// The shared key, from the environment.
pub fn key_from_env() -> Result<Vec<u8>, SealError> {
    let configured = std::env::var("LLM_PROXY_SECRET").map_err(|_| SealError::KeyMissing)?;
    if configured.is_empty() {
        return Err(SealError::KeyMissing);
    }
    let bytes = BASE64.decode(configured)?;
    if bytes.len() != 32 {
        return Err(SealError::KeyLength(bytes.len()));
    }
    Ok(bytes)
}

/// Open a value sealed by `sealForProxy`.
pub fn open(sealed: &str, key: &[u8]) -> Result<String, SealError> {
    if key.len() != 32 {
        return Err(SealError::KeyLength(key.len()));
    }
    let bytes = BASE64.decode(sealed)?;
    if bytes.len() < NONCE_BYTES + TAG_BYTES {
        return Err(SealError::TooShort);
    }

    let (nonce, body) = bytes.split_at(NONCE_BYTES);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: body,
                aad: &[],
            },
        )
        .map_err(|_| SealError::NotAuthentic)?;

    String::from_utf8(plaintext).map_err(|_| SealError::NotUtf8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Fixtures {
        key: String,
        cases: Vec<Case>,
    }

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        plaintext: String,
        sealed: String,
    }

    fn fixtures() -> Fixtures {
        // The *TypeScript* package's fixtures, read directly rather than copied. A copy is a second
        // definition, and two definitions of a wire format drift.
        let raw = include_str!("../../../typescript/proxy-secret/fixtures/proxy-secret.json");
        serde_json::from_str(raw).expect("the fixtures should parse")
    }

    #[test]
    fn opens_every_vector_the_typescript_half_produces() {
        let f = fixtures();
        let key = BASE64.decode(&f.key).unwrap();
        for case in &f.cases {
            assert_eq!(
                open(&case.sealed, &key).unwrap(),
                case.plaintext,
                "vector {}",
                case.name
            );
        }
    }

    #[test]
    fn refuses_a_tampered_value() {
        let f = fixtures();
        let key = BASE64.decode(&f.key).unwrap();
        let mut bytes = BASE64.decode(&f.cases[1].sealed).unwrap();
        let last = bytes.len() - 4;
        bytes[last] ^= 0x01;
        let tampered = BASE64.encode(&bytes);
        assert!(matches!(
            open(&tampered, &key),
            Err(SealError::NotAuthentic)
        ));
    }

    #[test]
    fn refuses_a_key_of_the_wrong_length() {
        assert!(matches!(
            open("AAAA", &[0u8; 16]),
            Err(SealError::KeyLength(16))
        ));
    }

    #[test]
    fn refuses_something_too_short_to_be_sealed() {
        let key = [0u8; 32];
        // Twelve bytes of base64 is a nonce and nothing else — no tag, no ciphertext. Distinguished
        // from a failed authentication so the log says which of the two happened.
        assert!(matches!(
            open(&BASE64.encode([0u8; 12]), &key),
            Err(SealError::TooShort)
        ));
    }
}
