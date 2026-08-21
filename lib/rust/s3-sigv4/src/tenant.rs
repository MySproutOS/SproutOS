//! Tenant credentials for the storage proxy, derived rather than stored.
//!
//! ## Why not envelope-encrypted, as first planned
//!
//! Verifying a SigV4 signature needs the secret — the client presents an HMAC, not the secret, and
//! the only way to check it is to recompute the same HMAC. The first plan was therefore to store
//! each tenant's secret sealed with KMS and open it in the proxy, and that plan is worse than this
//! one in every way that matters.
//!
//! **The proxy has to be able to obtain every tenant's secret regardless** — that is inherent to
//! SigV4 and no storage choice changes it. What a storage choice decides is what a *database* leak
//! is worth. Sealed secrets put a reversible ciphertext in `service_credential` for every tenant;
//! derivation puts nothing there at all.
//!
//! So the proxy holds one root key and derives:
//!
//! ```text
//! secret = base32(HMAC-SHA256(root_key, access_key_id || ":" || version))
//! ```
//!
//! The database keeps the access key id and a hash, exactly like every other credential here, and a
//! leak of it yields nothing replayable. Rotation bumps `version`, which changes the secret without
//! changing the identifier — so a rotated credential is the same tenant with a new key, and the old
//! signature stops verifying on the next request.
//!
//! The cost is that the root key is a single point of compromise. It already was: a process that can
//! verify any tenant's signature can forge any tenant's signature, whether it derives the secret or
//! decrypts it. This moves nothing into the proxy that was not already there, and takes a reversible
//! copy out of the database.
//!
//! The derivation is mirrored in `lib/typescript/services`, and `fixtures/tenant-secret.json` is the
//! contract both sides assert against. A divergence here is a tenant who cannot authenticate at all,
//! which is loud — unlike the SRN seam, where a divergence is a security bug.

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Crockford's alphabet, as used by [`crate::tenant::encode_secret`].
///
/// No `i`, `l`, `o` or `u`: a secret goes into a connection string, a shell, and a YAML file, and
/// none of those should be able to read anything into it. It also cannot be confused when read
/// aloud or typed from a screenshot, which is how a customer will move it into Obsidian.
const ALPHABET: &[u8] = b"0123456789abcdefghjkmnpqrstvwxyz";

/// The prefix marking an access key id as this platform's.
///
/// S3 clients treat the id as opaque, and AWS's own begin `AKIA`/`ASIA`. A distinct prefix means a
/// key pasted into the wrong field produces "unknown access key" from us rather than a confusing
/// failure inside an AWS SDK that thought it recognised the shape.
pub const ACCESS_KEY_PREFIX: &str = "SPROUT";

/// The access key id for one service and credential version.
///
/// Uppercase, because that is the shape every S3 client and every piece of documentation shows, and
/// a lowercase id gets "corrected" by somebody eventually.
pub fn access_key_id(short_id: &str, version: u32) -> String {
    format!("{ACCESS_KEY_PREFIX}{}{version:02}", short_id.to_uppercase())
}

/// Encode 32 bytes as 52 characters of Crockford base32.
fn encode_secret(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(52);
    let mut accumulator: u16 = 0;
    let mut bits = 0u8;

    for byte in bytes {
        accumulator = (accumulator << 8) | u16::from(*byte);
        bits += 8;
        while bits >= 5 {
            let index = ((accumulator >> (bits - 5)) & 0x1f) as usize;
            out.push(ALPHABET[index] as char);
            bits -= 5;
        }
    }

    if bits > 0 {
        let index = ((accumulator << (5 - bits)) & 0x1f) as usize;
        out.push(ALPHABET[index] as char);
    }

    out
}

/// The secret for an access key id, derived from the root key.
///
/// The id is bound into the derivation rather than only the service's uuid, so a credential's
/// version is covered too — bumping it produces a different secret and invalidates the old one
/// without any state to delete.
pub fn derive_secret(root_key: &[u8], access_key_id: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(root_key).expect("HMAC accepts any key length");
    mac.update(access_key_id.as_bytes());
    encode_secret(&mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_access_key_id_carries_the_service_and_the_version() {
        let id = access_key_id("01m0jn5za9egavhscng5vkywbm", 1);

        assert_eq!(id, "SPROUT01M0JN5ZA9EGAVHSCNG5VKYWBM01");
        assert!(id.starts_with(ACCESS_KEY_PREFIX));
        // S3 clients accept an opaque id; AWS's own are 20 characters and others are longer. What
        // matters is that it is alphanumeric, because some clients validate that much.
        assert!(id.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn rotation_changes_the_secret_and_not_the_tenant() {
        let root = b"root-key-for-tests";
        let first = access_key_id("01m0jn5za9egavhscng5vkywbm", 1);
        let second = access_key_id("01m0jn5za9egavhscng5vkywbm", 2);

        assert_ne!(derive_secret(root, &first), derive_secret(root, &second));
        // Same service, so the identifier still resolves to the same tenant.
        assert!(second.contains("01M0JN5ZA9EGAVHSCNG5VKYWBM"));
    }

    #[test]
    fn a_different_root_key_derives_a_different_secret() {
        let id = access_key_id("01m0jn5za9egavhscng5vkywbm", 1);

        assert_ne!(derive_secret(b"one", &id), derive_secret(b"two", &id));
    }

    #[test]
    fn a_secret_is_52_characters_of_an_alphabet_with_no_ambiguous_letters() {
        // It goes into a connection string, a shell and a YAML file, and is read off a screen into
        // Obsidian by hand. `i`, `l`, `o` and `u` are absent for that reason.
        let secret = derive_secret(b"root", &access_key_id("01m0jn5za9egavhscng5vkywbm", 1));

        assert_eq!(secret.len(), 52);
        assert!(secret.chars().all(|c| ALPHABET.contains(&(c as u8))));
        assert!(!secret.contains(['i', 'l', 'o', 'u']));
    }

    #[test]
    fn matches_the_shared_fixture() {
        // The contract `lib/typescript/services` asserts against too. A divergence is a tenant who
        // cannot authenticate, which is loud — but only if both sides read the same file.
        let raw = include_str!("../fixtures/tenant-secret.json");
        let fixture: serde_json::Value = serde_json::from_str(raw).expect("fixture parses");

        for case in fixture["cases"].as_array().expect("cases is an array") {
            let root = case["rootKey"].as_str().expect("rootKey");
            let short = case["shortId"].as_str().expect("shortId");
            let version = case["version"].as_u64().expect("version") as u32;

            let id = access_key_id(short, version);
            assert_eq!(id, case["accessKeyId"].as_str().expect("accessKeyId"));
            assert_eq!(
                derive_secret(root.as_bytes(), &id),
                case["secret"].as_str().expect("secret"),
            );
        }
    }
}
