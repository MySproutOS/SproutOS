//! Which requests are allowed through, and where the index names are in them.
//!
//! OpenSearch's API is a large surface and most of it is cluster-wide. `_cat/indices` lists every
//! tenant's indices; `_cluster/settings` reconfigures the cluster for everyone on it; `_snapshot`
//! can restore over it; and `_reindex` takes a **source index in its body**, which is a direct read
//! of another tenant's data if the body is not rewritten.
//!
//! So this is an allowlist, and an unrecognised endpoint is refused. The alternative — forwarding
//! anything not explicitly known to be dangerous — is a bet that the next OpenSearch release adds
//! no new way to read across indices, and that bet only has to lose once.

use crate::naming::{IndexError, namespace_list};

/// What a request needs done to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Forward with this path; the body needs no rewriting.
    Path(String),
    /// Forward with this path, and rewrite `_index` fields in the NDJSON body.
    PathAndNdjson(String),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RouteError {
    #[error("`{0}` is not an endpoint this proxy allows")]
    Refused(String),

    #[error(transparent)]
    Index(#[from] IndexError),
}

/// Endpoints that operate on indices and are safe once the index is namespaced.
///
/// Everything here reads or writes documents, mappings or settings *of a named index*. Nothing here
/// can name a second index, which is the property that makes namespacing the path sufficient.
const INDEX_ENDPOINTS: &[&str] = &[
    "_search",
    "_count",
    "_doc",
    "_create",
    "_update",
    "_update_by_query",
    "_delete_by_query",
    "_explain",
    "_termvectors",
    "_mapping",
    "_mappings",
    "_settings",
    "_refresh",
    "_flush",
    "_forcemerge",
    "_stats",
    "_analyze",
    "_field_caps",
    "_search_shards",
    "_validate",
    "_source",
    "_mget",
    "_pit",
];

/// Endpoints whose body is NDJSON carrying `_index` per line.
const NDJSON_ENDPOINTS: &[&str] = &["_bulk", "_msearch"];

/// Cluster-wide endpoints, allowed with no index at all.
///
/// Deliberately tiny. `/` is the version banner every client hits on connect and refusing it makes
/// well-behaved clients fail at startup.
const ROOT_ALLOWED: &[&str] = &["", "_search", "_count", "_bulk", "_msearch", "_mget"];

/// Plans one request.
///
/// `path` is the raw request path without its query string, e.g. `/products,orders/_search`.
pub fn plan(prefix: &str, path: &str) -> Result<Plan, RouteError> {
    let trimmed = path.trim_start_matches('/');
    let (first, rest) = match trimmed.split_once('/') {
        Some((first, rest)) => (first, rest),
        None => (trimmed, ""),
    };

    /*
      `_all` is the one segment that starts with `_` and is *not* an endpoint — it is OpenSearch's
      spelling of "every index", so it belongs on the index path below where it becomes
      `<prefix>*`. Reaching the endpoint branch would refuse a perfectly ordinary query, and a
      version of this that special-cased it later would have every other `_`-leading segment fall
      through into `namespace_list` and be refused for the wrong reason.
    */
    let is_index_spec = first == "_all";

    // Otherwise a path whose first segment starts with `_` is a cluster-wide endpoint: there is no
    // index in it to namespace, so it is scoped to the tenant's own indices or refused outright.
    if !is_index_spec && (first.is_empty() || first.starts_with('_')) {
        if !ROOT_ALLOWED.contains(&first) {
            return Err(RouteError::Refused(format!("/{first}")));
        }
        if first.is_empty() {
            return Ok(Plan::Path("/".to_owned()));
        }
        // `POST /_search` means every index in the cluster. Scoped to `<prefix>*`, it means every
        // index this tenant has — which is what they actually meant, and all they may have.
        let scoped = format!("/{prefix}*/{first}");
        return Ok(if NDJSON_ENDPOINTS.contains(&first) {
            // `_bulk` with no index in the path takes it per line instead, so the path scoping is
            // cosmetic and the body rewrite is what matters. `<prefix>*` is not a real index, so
            // send it to the bare endpoint and let every line carry its own.
            Plan::PathAndNdjson(format!("/{first}"))
        } else {
            Plan::Path(scoped)
        });
    }

    let namespaced = namespace_list(prefix, first)?;

    // `GET /products` and `HEAD /products` — index metadata, create, delete.
    if rest.is_empty() {
        return Ok(Plan::Path(format!("/{namespaced}")));
    }

    let (endpoint, tail) = match rest.split_once('/') {
        Some((endpoint, tail)) => (endpoint, tail),
        None => (rest, ""),
    };

    if NDJSON_ENDPOINTS.contains(&endpoint) {
        return Ok(Plan::PathAndNdjson(format!("/{namespaced}/{endpoint}")));
    }
    if !INDEX_ENDPOINTS.contains(&endpoint) {
        return Err(RouteError::Refused(format!("/{endpoint}")));
    }

    /*
      The tail is a document id or a mapping field name, and it is passed through unchanged.

      It cannot be a second index: it is already inside a path whose first segment is namespaced, so
      OpenSearch reads it as an id. What it *could* carry is a `/`, which is why the tenant's
      document ids reach here percent-encoded and are left that way rather than being decoded and
      re-joined.
    */
    Ok(Plan::Path(if tail.is_empty() {
        format!("/{namespaced}/{endpoint}")
    } else {
        format!("/{namespaced}/{endpoint}/{tail}")
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PREFIX: &str = "t01j4pkz2hbfh6sw7sa7d65tvkz_";

    fn path_of(path: &str) -> Result<String, RouteError> {
        match plan(PREFIX, path)? {
            Plan::Path(path) | Plan::PathAndNdjson(path) => Ok(path),
        }
    }

    /// Each of these is a way for one tenant to read past its own indices, or to reconfigure the
    /// cluster for everyone sharing it.
    #[test]
    fn cluster_wide_endpoints_are_refused() {
        for path in [
            "/_cat/indices",
            "/_cluster/health",
            "/_cluster/settings",
            "/_nodes",
            "/_nodes/stats",
            "/_snapshot/my-repo",
            "/_reindex",
            "/_scripts/my-script",
            "/_aliases",
            "/_security/user",
            "/_ingest/pipeline/p",
            "/_tasks",
            "/_settings",
            "/_template/t",
            "/_index_template/t",
            "/_component_template/t",
            "/_plugins/_security",
        ] {
            assert!(
                matches!(plan(PREFIX, path), Err(RouteError::Refused(_))),
                "{path} should be refused"
            );
        }
    }

    /// `_reindex` deserves its own note: its *body* names a source index, so forwarding it would be
    /// a direct read of another tenant's data no matter what the path said.
    #[test]
    fn reindex_is_refused_because_its_body_names_an_index() {
        assert!(matches!(
            plan(PREFIX, "/_reindex"),
            Err(RouteError::Refused(_))
        ));
    }

    #[test]
    fn an_unknown_endpoint_is_refused_rather_than_forwarded() {
        // The default has to be no. Forwarding anything not known to be dangerous is a bet that the
        // next OpenSearch release adds no new way to read across indices.
        assert!(matches!(
            plan(PREFIX, "/_whatever"),
            Err(RouteError::Refused(_))
        ));
        assert!(matches!(
            plan(PREFIX, "/products/_whatever"),
            Err(RouteError::Refused(_))
        ));
    }

    #[test]
    fn the_version_banner_is_allowed() {
        // Every client hits `/` on connect; refusing it makes well-behaved clients fail at startup.
        assert_eq!(path_of("/").unwrap(), "/");
        assert_eq!(path_of("").unwrap(), "/");
    }

    #[test]
    fn a_search_names_the_tenants_index() {
        assert_eq!(
            path_of("/products/_search").unwrap(),
            format!("/{PREFIX}products/_search")
        );
    }

    #[test]
    fn a_cluster_wide_search_is_scoped_to_the_tenant() {
        // `POST /_search` means every index in the cluster. It has to mean every index this tenant
        // has, which is what they meant and all they may have.
        assert_eq!(path_of("/_search").unwrap(), format!("/{PREFIX}*/_search"));
        assert_eq!(path_of("/_count").unwrap(), format!("/{PREFIX}*/_count"));
    }

    #[test]
    fn wildcards_and_all_are_scoped_rather_than_passed_through() {
        assert_eq!(
            path_of("/*/_search").unwrap(),
            format!("/{PREFIX}*/_search")
        );
        assert_eq!(
            path_of("/_all/_search").unwrap(),
            format!("/{PREFIX}*/_search")
        );
        // A trailing wildcard is a legitimate pattern and still lands inside the namespace.
        assert_eq!(
            path_of("/logs-*/_search").unwrap(),
            format!("/{PREFIX}logs-*/_search")
        );
    }

    #[test]
    fn a_multi_index_search_namespaces_every_name() {
        assert_eq!(
            path_of("/products,orders/_search").unwrap(),
            format!("/{PREFIX}products,{PREFIX}orders/_search")
        );
    }

    #[test]
    fn index_management_paths_are_namespaced() {
        assert_eq!(path_of("/products").unwrap(), format!("/{PREFIX}products"));
        assert_eq!(
            path_of("/products/_mapping").unwrap(),
            format!("/{PREFIX}products/_mapping")
        );
        assert_eq!(
            path_of("/products/_settings").unwrap(),
            format!("/{PREFIX}products/_settings")
        );
    }

    #[test]
    fn a_document_id_is_left_alone() {
        // The tail is an id, not a second index — it is already inside a namespaced path, so
        // OpenSearch reads it as one. Rewriting it would corrupt the tenant's own keys.
        assert_eq!(
            path_of("/products/_doc/sku-42").unwrap(),
            format!("/{PREFIX}products/_doc/sku-42")
        );
        assert_eq!(
            path_of("/products/_doc/a%2Fb").unwrap(),
            format!("/{PREFIX}products/_doc/a%2Fb"),
            "an encoded slash must stay encoded, or the id escapes its path segment"
        );
    }

    #[test]
    fn bulk_and_msearch_are_marked_for_body_rewriting() {
        assert!(matches!(
            plan(PREFIX, "/products/_bulk"),
            Ok(Plan::PathAndNdjson(_))
        ));
        assert!(matches!(plan(PREFIX, "/_bulk"), Ok(Plan::PathAndNdjson(_))));
        assert!(matches!(
            plan(PREFIX, "/_msearch"),
            Ok(Plan::PathAndNdjson(_))
        ));
    }

    /// A bare `_bulk` takes its index per line, so the path must stay bare — `<prefix>*` is not a
    /// real index and OpenSearch would refuse the request outright.
    #[test]
    fn a_bare_bulk_keeps_a_bare_path() {
        assert_eq!(path_of("/_bulk").unwrap(), "/_bulk");
        assert_eq!(path_of("/_msearch").unwrap(), "/_msearch");
    }

    #[test]
    fn an_index_name_that_could_escape_its_path_segment_is_refused() {
        // A `/` in a name would land the rest of it in the *next* path segment, past the namespace.
        for name in ["../other", "a/b", "a\\b", "a,b/c", "a b", "a#b", "a:b"] {
            let path = format!("/{name}/_search");
            assert!(plan(PREFIX, &path).is_err(), "{name} should be refused");
        }
    }

    #[test]
    fn a_name_that_looks_like_an_endpoint_is_refused() {
        // `_cluster` as an index name would produce a path this proxy's own router could misread.
        assert!(plan(PREFIX, "/_cluster/_search").is_err());
        assert!(plan(PREFIX, "/-leading/_search").is_err());
        assert!(plan(PREFIX, "/.hidden/_search").is_err());
    }
}
