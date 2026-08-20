//! Where one tenant's indices live, and why they cannot name another's.
//!
//! OpenSearch's open-source tier has **no document- or field-level security**. That is not a gap we
//! are working around — it is the reason this proxy exists at all. Without it, "tenant-split" has
//! to mean split by *index name*, and something has to guarantee a tenant can only ever name its
//! own. That something is this file.
//!
//! ```text
//! t01j4pkz2hbfh6sw7sa7d65tvkz_products
//! ^^^^^^^^^^^^^^^^^^^^^^^^^^^^ the tenant
//! ```
//!
//! Index names are far more constrained than Valkey keys, which is why this is a prefix rather than
//! the hash tag the queue proxy uses.

use sproutos_tenant_auth::{TenantIdentity, encode_short_id};

/// Separator between the tenant prefix and the tenant's own index name.
///
/// `_` rather than `-`, because a customer's index name may legitimately contain `-` and splitting
/// on a character they also use makes `strip` ambiguous. `_` is legal inside a name and illegal as
/// its first character, which is exactly the property that makes it a safe separator.
const SEPARATOR: char = '_';

/// Longest index name OpenSearch will accept, in bytes.
pub const MAX_INDEX_BYTES: usize = 255;

/// The prefix for one tenant, ready to concatenate.
///
/// Leading `t` because an index name may not begin with `-`, `_` or `+`, and a short id begins with
/// a digit `0`-`7`. A digit is legal, but a fixed letter makes the prefix recognisable in an
/// operator's `_cat/indices` output at a glance.
pub fn prefix_for(identity: &TenantIdentity) -> String {
    format!("t{}{}", encode_short_id(identity.resource_id), SEPARATOR)
}

/// Why an index name is not one this proxy will pass on.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum IndexError {
    #[error("an index name cannot be empty")]
    Empty,

    #[error("`{0}` is not a legal index name")]
    Illegal(String),

    #[error(
        "index names are limited to {MAX_INDEX_BYTES} bytes, and this one plus its namespace is {0}"
    )]
    TooLong(usize),
}

/// Characters OpenSearch refuses in an index name.
///
/// Checked here rather than left to the server because several of them — `/` above all — would
/// change which *path segment* the name lands in once it is concatenated, and a name that escapes
/// its segment escapes its tenant.
const ILLEGAL: &[char] = &['\\', '/', '*', '?', '"', '<', '>', '|', ' ', ',', '#', ':'];

/// Checks a name the tenant sent, before it is namespaced.
///
/// Wildcards are handled separately by the caller: `*` is illegal *inside* a name here, and a
/// tenant asking for `*` or `_all` is rewritten to `<prefix>*` rather than passed through.
pub fn validate(name: &str) -> Result<(), IndexError> {
    if name.is_empty() {
        return Err(IndexError::Empty);
    }
    if name.chars().any(|c| ILLEGAL.contains(&c)) {
        return Err(IndexError::Illegal(name.to_owned()));
    }
    // `..` and `.` are how a path traversal would be spelled, and OpenSearch refuses them too.
    if name == "." || name == ".." {
        return Err(IndexError::Illegal(name.to_owned()));
    }
    /*
      A leading `_` is how every OpenSearch *endpoint* is spelled — `_search`, `_cluster`, `_cat`.
      A tenant naming an index `_cluster` would produce a path this proxy's own router could
      misread, so the shape that could cause confusion is refused rather than reasoned about.
    */
    if name.starts_with(['-', '_', '+', '.']) {
        return Err(IndexError::Illegal(name.to_owned()));
    }
    if name.chars().any(char::is_uppercase) {
        // OpenSearch would refuse it anyway, but refusing here means the tenant gets our error
        // rather than one that mentions the namespaced name and leaks the prefix.
        return Err(IndexError::Illegal(name.to_owned()));
    }
    Ok(())
}

/// Namespaces one index name.
pub fn namespace(prefix: &str, name: &str) -> Result<String, IndexError> {
    // `*` and `_all` mean "everything I can see", which after namespacing is everything under the
    // prefix — never everything in the cluster.
    if name == "*" || name == "_all" {
        return Ok(format!("{prefix}*"));
    }

    // A trailing wildcard is a legitimate and common pattern (`logs-*`). It is validated with the
    // wildcard removed, so `*` cannot appear anywhere else.
    let (stem, wildcard) = match name.strip_suffix('*') {
        Some(stem) => (stem, "*"),
        None => (name, ""),
    };
    validate(stem)?;

    let namespaced = format!("{prefix}{stem}{wildcard}");
    if namespaced.len() > MAX_INDEX_BYTES {
        return Err(IndexError::TooLong(namespaced.len()));
    }
    Ok(namespaced)
}

/// Namespaces a comma-separated list, which is how OpenSearch spells multi-index requests.
pub fn namespace_list(prefix: &str, spec: &str) -> Result<String, IndexError> {
    if spec.is_empty() {
        return Err(IndexError::Empty);
    }
    let mut out = Vec::new();
    for name in spec.split(',') {
        out.push(namespace(prefix, name.trim())?);
    }
    Ok(out.join(","))
}

/// Removes the namespace from a name on the way back to the tenant.
///
/// A tenant asked about `products` and must be told about `products`. Leaking the prefix would show
/// them the shape of the shared cluster and — worse — a client that reads `_index` out of a hit and
/// uses it for the next request would get it prefixed twice.
pub fn strip<'a>(prefix: &str, name: &'a str) -> Option<&'a str> {
    name.strip_prefix(prefix)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sproutos_tenant_auth::ResourceKind;
    use uuid::Uuid;

    const PREFIX: &str = "t01j4pkz2hbfh6sw7sa7d65tvkz_";

    fn identity(resource: u128) -> TenantIdentity {
        TenantIdentity::new(
            Uuid::nil(),
            ResourceKind::SearchIndex,
            Uuid::from_u128(resource),
        )
    }

    #[test]
    fn a_prefix_is_a_legal_index_name_start() {
        let prefix = prefix_for(&identity(1));
        // An index name may not begin with `-`, `_` or `+`; the leading letter guarantees it.
        assert!(prefix.starts_with('t'));
        assert!(prefix.ends_with('_'));
        assert!(!prefix.chars().any(char::is_uppercase));
        assert!(validate(&format!("{prefix}products")).is_ok());
    }

    /// The same fixture `tenantIndexPrefix` asserts in
    /// `lib/typescript/services/src/tenant-auth.test.ts`.
    ///
    /// The control plane computes this prefix to delete a destroyed service's indices, and this
    /// proxy computes it to decide which indices a tenant may name. Nothing is shared between
    /// them but the algorithm, so a change on one side that is not made on the other has to turn
    /// a test red on both — the alternative is a reaper that deletes another customer's data.
    #[test]
    fn the_prefix_matches_the_control_plane() {
        let identity = TenantIdentity::new(
            Uuid::nil(),
            ResourceKind::SearchIndex,
            Uuid::parse_str("01912d40-0000-7000-8000-0000000000a1").unwrap(),
        );
        assert_eq!(prefix_for(&identity), "t01j4pm0000e008000000000051_");
    }

    #[test]
    fn two_resources_get_two_prefixes() {
        assert_ne!(prefix_for(&identity(1)), prefix_for(&identity(2)));
    }

    #[test]
    fn a_name_that_would_escape_its_path_segment_is_refused() {
        // `/` is the one that matters: concatenated into a path, the rest of the name lands in the
        // *next* segment, past the namespace entirely.
        for name in [
            "a/b", "..", ".", "a\\b", "a b", "a,b", "a#b", "a:b", "a\"b", "a<b", "a|b",
        ] {
            assert!(validate(name).is_err(), "{name} should be refused");
        }
    }

    #[test]
    fn a_name_that_looks_like_an_endpoint_is_refused() {
        // `_cluster`, `_cat` and friends are how endpoints are spelled. A name shaped like one
        // would produce a path the router could misread.
        for name in ["_cluster", "_search", "-leading", "+plus", ".hidden"] {
            assert!(validate(name).is_err(), "{name} should be refused");
        }
    }

    #[test]
    fn uppercase_is_refused_here_rather_than_upstream() {
        // OpenSearch would refuse it too, but its error names the *namespaced* index — which would
        // show the tenant the prefix.
        assert!(validate("Products").is_err());
    }

    #[test]
    fn ordinary_names_are_accepted() {
        for name in ["products", "logs-2026-08", "a", "orders_v2", "a.b"] {
            assert!(validate(name).is_ok(), "{name} should be accepted");
        }
    }

    #[test]
    fn everything_means_everything_of_mine() {
        assert_eq!(namespace(PREFIX, "*").unwrap(), format!("{PREFIX}*"));
        assert_eq!(namespace(PREFIX, "_all").unwrap(), format!("{PREFIX}*"));
    }

    #[test]
    fn a_trailing_wildcard_stays_inside_the_namespace() {
        assert_eq!(
            namespace(PREFIX, "logs-*").unwrap(),
            format!("{PREFIX}logs-*")
        );
        // But a wildcard anywhere else is refused: `*-logs` namespaced is `t..._*-logs`, which
        // matches nothing, and allowing `*` mid-name is a step towards allowing it leading.
        assert!(namespace(PREFIX, "*-logs").is_err());
        assert!(namespace(PREFIX, "a*b").is_err());
    }

    #[test]
    fn a_list_namespaces_every_entry() {
        assert_eq!(
            namespace_list(PREFIX, "products,orders").unwrap(),
            format!("{PREFIX}products,{PREFIX}orders")
        );
        // Whitespace around a comma is what a hand-written client sends.
        assert_eq!(
            namespace_list(PREFIX, "products, orders").unwrap(),
            format!("{PREFIX}products,{PREFIX}orders")
        );
    }

    #[test]
    fn one_bad_entry_refuses_the_whole_list() {
        // Not "namespace what you can": a partially-namespaced list would send an un-namespaced
        // name to the cluster, which is the failure this file exists to prevent.
        assert!(namespace_list(PREFIX, "products,../other").is_err());
        assert!(namespace_list(PREFIX, "").is_err());
    }

    #[test]
    fn a_name_that_would_exceed_the_limit_is_refused() {
        // The prefix eats 28 of the 255 bytes, so a name that fits alone may not fit namespaced.
        let long = "a".repeat(MAX_INDEX_BYTES);
        assert!(validate(&long).is_ok());
        assert_eq!(
            namespace(PREFIX, &long).unwrap_err(),
            IndexError::TooLong(PREFIX.len() + MAX_INDEX_BYTES)
        );
    }

    #[test]
    fn namespace_and_strip_are_inverses() {
        let namespaced = namespace(PREFIX, "products").unwrap();
        assert_eq!(strip(PREFIX, &namespaced), Some("products"));
    }

    #[test]
    fn strip_refuses_another_tenants_name() {
        // The proxy must never hand a tenant a name it does not own, even by accident of prefix
        // arithmetic. `None` forces the caller to decide rather than silently truncating.
        assert_eq!(strip(PREFIX, "tsomeoneelse_products"), None);
        assert_eq!(strip(PREFIX, "products"), None);
    }
}
