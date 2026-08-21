//! Where one tenant's keys live, and why they cannot reach another's.
//!
//! Valkey offers numbered databases and they are the obvious answer. They are also the wrong one:
//! Valkey Cluster supports database 0 only, so a tenancy design built on `SELECT` cannot be
//! sharded — and the point of running a shared instance is that it eventually will not fit on one.
//!
//! So tenancy is a key prefix, and the prefix carries a **hash tag**:
//!
//! ```text
//! {kv:01hb...}:bull:emails:wait
//!  ^^^^^^^^^ the tag
//! ```
//!
//! Cluster hashes only what is between the braces, so every key for one queue lands on one shard.
//! That is not a performance nicety — BullMQ's Lua scripts touch several keys at once, and Cluster
//! refuses a script whose keys live on different shards. Without the tag, BullMQ does not work at
//! all past a single node.

use sproutos_tenant_auth::{TenantIdentity, encode_short_id};

/// Builds the prefix for one tenant resource, hash tag included.
pub fn prefix_for(identity: &TenantIdentity) -> Vec<u8> {
    format!(
        "{{{}:{}}}:",
        identity.resource_kind.prefix(),
        encode_short_id(identity.resource_id)
    )
    .into_bytes()
}

/// Namespaces a key.
pub fn namespace(prefix: &[u8], key: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(prefix.len() + key.len());
    out.extend_from_slice(prefix);
    out.extend_from_slice(key);
    out
}

/// Strips the namespace from a key, for anything the proxy shows back to a tenant.
///
/// A tenant sent `bull:emails:wait` and must be told about `bull:emails:wait`. Leaking the prefix
/// tells them the shape of the shared keyspace, and — worse — a client that reads a key name out
/// of a reply and sends it back would get it namespaced twice.
pub fn strip(prefix: &[u8], key: &[u8]) -> Option<Vec<u8>> {
    key.strip_prefix(prefix).map(<[u8]>::to_vec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sproutos_tenant_auth::ResourceKind;
    use uuid::Uuid;

    /// The key prefix is a cross-language contract, and it had no vector.
    ///
    /// It is built in three places: here, `tenantQueuePrefix` in `@lib/queue`, and
    /// `tenantKeyPrefix` in `@lib/reaper`. This one writes every tenant key; the last one deletes
    /// by it when a service is destroyed. A divergence does not fail loudly — the reaper matches
    /// nothing, reports success, and a deleted customer's queue stays in the shared instance.
    ///
    /// The vectors live with the rest of the tenant-naming contract, and the TypeScript side
    /// asserts the same file. `include_str!` rather than a copy, for the reason the fixture's own
    /// comment gives.
    #[test]
    fn every_vector_gets_the_prefix_typescript_expects() {
        const FIXTURE: &str =
            include_str!("../../../lib/rust/tenant-auth/fixtures/naming-vectors.json");

        let parsed: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture parses");
        let cases = parsed["cases"].as_array().expect("cases is an array");
        // An empty array would make the loop vacuous, which is the shape of the bug being prevented.
        assert!(cases.len() > 2, "expected vectors, found {}", cases.len());

        for case in cases {
            let kind = match case["kind"].as_str().unwrap() {
                "database" => sproutos_tenant_auth::ResourceKind::Database,
                "queue" => sproutos_tenant_auth::ResourceKind::Queue,
                "searchIndex" => sproutos_tenant_auth::ResourceKind::SearchIndex,
                other => panic!("unknown kind in the vectors: {other}"),
            };

            let identity = TenantIdentity::new(
                uuid::Uuid::parse_str(case["organizationId"].as_str().unwrap()).unwrap(),
                kind,
                uuid::Uuid::parse_str(case["resourceId"].as_str().unwrap()).unwrap(),
            );

            assert_eq!(
                String::from_utf8(prefix_for(&identity)).unwrap(),
                case["keyPrefix"].as_str().unwrap(),
                "key prefix for {}",
                case["resourceId"]
            );
        }
    }

    #[test]
    fn a_prefix_carries_exactly_one_hash_tag() {
        let identity = TenantIdentity {
            organization_id: Uuid::nil(),
            resource_kind: ResourceKind::Queue,
            resource_id: Uuid::from_u128(1),
        };
        let prefix = String::from_utf8(prefix_for(&identity)).unwrap();

        // Cluster hashes what is between the first `{` and the next `}`. A second pair, or none,
        // and BullMQ's multi-key Lua scripts are refused as cross-slot.
        assert_eq!(prefix.matches('{').count(), 1);
        assert_eq!(prefix.matches('}').count(), 1);
        assert!(prefix.starts_with("{kv:"));
        assert!(prefix.ends_with("}:"));
    }

    #[test]
    fn two_resources_get_two_prefixes() {
        let one = TenantIdentity {
            organization_id: Uuid::nil(),
            resource_kind: ResourceKind::Queue,
            resource_id: Uuid::from_u128(1),
        };
        let two = TenantIdentity {
            resource_id: Uuid::from_u128(2),
            ..one
        };
        assert_ne!(prefix_for(&one), prefix_for(&two));
    }

    #[test]
    fn namespace_and_strip_are_inverses() {
        let prefix = b"{kv:01hb}:";
        let key = b"bull:emails:wait";
        assert_eq!(strip(prefix, &namespace(prefix, key)).unwrap(), key);
    }

    #[test]
    fn strip_refuses_a_key_from_another_namespace() {
        // The proxy must never hand a tenant a key it did not own, even by accident of prefix
        // arithmetic. `None` forces the caller to decide rather than silently truncating.
        assert_eq!(strip(b"{kv:01hb}:", b"{kv:other}:jobs"), None);
        assert_eq!(strip(b"{kv:01hb}:", b"jobs"), None);
    }

    #[test]
    fn namespacing_is_binary_safe() {
        assert_eq!(
            namespace(b"p:", &[0xff, 0x00]),
            vec![b'p', b':', 0xff, 0x00]
        );
    }
}
