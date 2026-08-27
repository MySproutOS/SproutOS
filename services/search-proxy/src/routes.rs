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

use std::collections::HashSet;

use axum::http::Method;
use percent_encoding::percent_decode_str;

use crate::naming::{IndexError, namespace_list};

/// What a request needs done to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Forward with this path; the body needs no rewriting.
    Path(String),
    /// Forward with this path, and rewrite `_index` fields in the NDJSON body.
    PathAndNdjson(String),
    /// Forward with this path, and validate/rewrite the exact `_mget` JSON shape.
    PathAndMget {
        path: String,
        /// A bare `/_mget` requires every document to name an index; an index-scoped request may
        /// use the `ids` shorthand or omit `_index` from a document descriptor.
        index_in_path: bool,
    },
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RouteError {
    #[error("`{0}` is not an endpoint this proxy allows")]
    Refused(String),

    #[error(transparent)]
    Index(#[from] IndexError),

    #[error("`{0}` is not a query parameter this proxy allows")]
    Query(String),

    #[error("duplicate query parameter `{0}` is ambiguous and is not allowed")]
    DuplicateQuery(String),

    #[error("the request target is not valid UTF-8 percent encoding")]
    Encoding,
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
];

/// Endpoints whose body is NDJSON carrying `_index` per line.
const NDJSON_ENDPOINTS: &[&str] = &["_bulk", "_msearch"];

/// Cluster-wide endpoints, allowed with no index at all.
///
/// Deliberately tiny. `/` is the version banner every client hits on connect and refusing it makes
/// well-behaved clients fail at startup.
const ROOT_ALLOWED: &[&str] = &["", "_search", "_count", "_bulk", "_msearch", "_mget"];

/// Documented, index-local query parameters used by the allowlisted APIs.
///
/// This is intentionally a union rather than a silently forwarded bag. OpenSearch resolves some
/// REST parameters before the handler sees the path: `index` can override path scoping and
/// `source` can replace a body we already inspected. Both are absent, as are future parameters
/// until they are reviewed here.
const QUERY_ALLOWED: &[&str] = &[
    "_source",
    "_source_excludes",
    "_source_includes",
    "allow_no_indices",
    "allow_partial_search_results",
    "analyze_wildcard",
    "analyzer",
    "batched_reduce_size",
    "ccs_minimize_roundtrips",
    "completion_fields",
    "default_operator",
    "df",
    "error_trace",
    "expand_wildcards",
    "explain",
    "fielddata_fields",
    "fields",
    "filter_path",
    "flat_settings",
    "from",
    "groups",
    "human",
    "if_primary_term",
    "if_seq_no",
    "ignore_throttled",
    "ignore_unavailable",
    "include_defaults",
    "include_named_queries_score",
    "lenient",
    "level",
    "local",
    "master_timeout",
    "max_concurrent_shard_requests",
    "max_num_segments",
    "metric",
    "min_compatible_shard_node",
    "only_expunge_deletes",
    "op_type",
    "pipeline",
    "pre_filter_shard_size",
    "preference",
    "pretty",
    "q",
    "refresh",
    "request_cache",
    "require_alias",
    "rest_total_hits_as_int",
    "routing",
    "search_type",
    "size",
    "sort",
    "stats",
    "stored_fields",
    "suggest_field",
    "suggest_mode",
    "suggest_size",
    "suggest_text",
    "terminate_after",
    "timeout",
    "track_scores",
    "track_total_hits",
    "typed_keys",
    "version",
    "version_type",
    "wait_for_active_shards",
];

/// Plans one request.
///
/// `path` is the raw request path without its query string, e.g. `/products,orders/_search`.
pub fn plan(prefix: &str, method: &Method, path: &str) -> Result<Plan, RouteError> {
    let segments = decoded_segments(path)?;
    let first = segments.first().map(String::as_str).unwrap_or("");
    let rest = segments.get(1..).unwrap_or_default();

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
            allow_method(method, &[Method::GET, Method::HEAD], "/")?;
            if !rest.is_empty() {
                return Err(RouteError::Refused(path.to_owned()));
            }
            return Ok(Plan::Path("/".to_owned()));
        }
        if !rest.is_empty() {
            // In particular, `/_search/scroll` must not silently become a tenant-wide search.
            return Err(RouteError::Refused(path.to_owned()));
        }
        allow_endpoint_method(method, first)?;
        // `POST /_search` means every index in the cluster. Scoped to `<prefix>*`, it means every
        // index this tenant has — which is what they actually meant, and all they may have.
        let scoped = format!("/{prefix}*/{first}");
        return Ok(if NDJSON_ENDPOINTS.contains(&first) {
            // `_bulk` with no index in the path takes it per line instead, so the path scoping is
            // cosmetic and the body rewrite is what matters. `<prefix>*` is not a real index, so
            // send it to the bare endpoint and let every line carry its own.
            Plan::PathAndNdjson(format!("/{first}"))
        } else if first == "_mget" {
            Plan::PathAndMget {
                path: format!("/{first}"),
                index_in_path: false,
            }
        } else {
            Plan::Path(scoped)
        });
    }

    let namespaced = encode_index_spec(&namespace_list(prefix, first)?);

    // `GET /products` and `HEAD /products` — index metadata, create, delete.
    if rest.is_empty() {
        allow_method(
            method,
            &[Method::GET, Method::HEAD, Method::PUT, Method::DELETE],
            path,
        )?;
        return Ok(Plan::Path(format!("/{namespaced}")));
    }

    let endpoint = rest[0].as_str();
    let tail = &rest[1..];

    // OpenSearch creates a point-in-time handle at `/<index>/_search/point_in_time`. No `_search`
    // subroute has been reviewed as an index-local operation, so refuse every tail rather than
    // teaching the parser only today's dangerous spelling and forwarding tomorrow's by default.
    // Elasticsearch's alternate `/<index>/_pit` spelling is absent from INDEX_ENDPOINTS above.
    if endpoint == "_search" && !tail.is_empty() {
        return Err(RouteError::Refused(path.to_owned()));
    }

    if NDJSON_ENDPOINTS.contains(&endpoint) {
        if !tail.is_empty() {
            return Err(RouteError::Refused(path.to_owned()));
        }
        allow_endpoint_method(method, endpoint)?;
        return Ok(Plan::PathAndNdjson(format!("/{namespaced}/{endpoint}")));
    }
    if !INDEX_ENDPOINTS.contains(&endpoint) {
        return Err(RouteError::Refused(format!("/{endpoint}")));
    }
    allow_endpoint_method(method, endpoint)?;

    if endpoint == "_mget" {
        if !tail.is_empty() {
            return Err(RouteError::Refused(path.to_owned()));
        }
        return Ok(Plan::PathAndMget {
            path: format!("/{namespaced}/{endpoint}"),
            index_in_path: true,
        });
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
        format!(
            "/{namespaced}/{endpoint}/{}",
            tail.iter()
                .map(|segment| encode_segment(segment))
                .collect::<Vec<_>>()
                .join("/")
        )
    }))
}

/// Reject any query parameter not reviewed as index-local, including duplicate spellings.
pub fn validate_query(query: Option<&str>) -> Result<(), RouteError> {
    let Some(query) = query else { return Ok(()) };
    let mut seen = HashSet::new();
    for pair in query.split('&') {
        if !valid_percent_encoding(pair) {
            return Err(RouteError::Encoding);
        }
        let raw = pair.split_once('=').map(|(key, _)| key).unwrap_or(pair);
        let key = decode_query_key(raw)?;
        if !seen.insert(key.clone()) {
            return Err(RouteError::DuplicateQuery(key));
        }
        if !QUERY_ALLOWED.contains(&key.as_str()) {
            return Err(RouteError::Query(key));
        }
    }
    Ok(())
}

fn decoded_segments(path: &str) -> Result<Vec<String>, RouteError> {
    let trimmed = path.strip_prefix('/').unwrap_or(path);
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let mut decoded = Vec::new();
    for raw in trimmed.split('/') {
        if !valid_percent_encoding(raw) {
            return Err(RouteError::Encoding);
        }
        let segment = percent_decode_str(raw)
            .decode_utf8()
            .map_err(|_| RouteError::Encoding)?
            .into_owned();
        if segment == "." || segment == ".." || segment.is_empty() {
            return Err(RouteError::Refused(path.to_owned()));
        }
        decoded.push(segment);
    }
    Ok(decoded)
}

fn decode_query_key(raw: &str) -> Result<String, RouteError> {
    let plus = raw.replace('+', " ");
    percent_decode_str(&plus)
        .decode_utf8()
        .map(|value| value.into_owned())
        .map_err(|_| RouteError::Encoding)
}

fn encode_segment(segment: &str) -> String {
    encode_bytes(segment, false)
}

fn encode_index_spec(spec: &str) -> String {
    encode_bytes(spec, true)
}

fn encode_bytes(value: &str, index_syntax: bool) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'.' | b'_' | b'~')
            || (index_syntax && matches!(byte, b',' | b'*'))
        {
            out.push(char::from(byte));
        } else {
            use std::fmt::Write;
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

fn valid_percent_encoding(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            index += 1;
            continue;
        }
        if index + 2 >= bytes.len()
            || !bytes[index + 1].is_ascii_hexdigit()
            || !bytes[index + 2].is_ascii_hexdigit()
        {
            return false;
        }
        index += 3;
    }
    true
}

fn allow_endpoint_method(method: &Method, endpoint: &str) -> Result<(), RouteError> {
    let allowed: &[Method] = match endpoint {
        "_search" | "_count" | "_explain" | "_termvectors" | "_analyze" | "_field_caps"
        | "_search_shards" | "_validate" | "_mget" => &[Method::GET, Method::POST],
        "_doc" => &[
            Method::GET,
            Method::HEAD,
            Method::POST,
            Method::PUT,
            Method::DELETE,
        ],
        "_create" => &[Method::POST, Method::PUT],
        "_update" | "_update_by_query" | "_delete_by_query" => &[Method::POST],
        "_mapping" | "_mappings" | "_settings" => &[Method::GET, Method::PUT],
        "_refresh" | "_flush" | "_forcemerge" => &[Method::GET, Method::POST],
        "_stats" => &[Method::GET],
        "_source" => &[Method::GET, Method::HEAD],
        "_bulk" => &[Method::POST, Method::PUT],
        "_msearch" => &[Method::GET, Method::POST],
        _ => return Err(RouteError::Refused(format!("/{endpoint}"))),
    };
    allow_method(method, allowed, endpoint)
}

fn allow_method(method: &Method, allowed: &[Method], path: &str) -> Result<(), RouteError> {
    if allowed.contains(method) {
        Ok(())
    } else {
        Err(RouteError::Refused(format!("{} {path}", method.as_str())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PREFIX: &str = "t01j4pkz2hbfh6sw7sa7d65tvkz_";

    fn path_of(path: &str) -> Result<String, RouteError> {
        match plan(PREFIX, &Method::GET, path)? {
            Plan::Path(path) | Plan::PathAndNdjson(path) | Plan::PathAndMget { path, .. } => {
                Ok(path)
            }
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
                matches!(
                    plan(PREFIX, &Method::GET, path),
                    Err(RouteError::Refused(_))
                ),
                "{path} should be refused"
            );
        }
    }

    /// `_reindex` deserves its own note: its *body* names a source index, so forwarding it would be
    /// a direct read of another tenant's data no matter what the path said.
    #[test]
    fn reindex_is_refused_because_its_body_names_an_index() {
        assert!(matches!(
            plan(PREFIX, &Method::GET, "/_reindex"),
            Err(RouteError::Refused(_))
        ));
    }

    #[test]
    fn every_point_in_time_lifecycle_route_is_refused() {
        for (method, path) in [
            (Method::POST, "/products/_pit"),
            (Method::DELETE, "/products/_pit"),
            (Method::POST, "/products/_search/point_in_time"),
            (Method::POST, "/products/_search/future_subroute"),
            (Method::DELETE, "/_search/point_in_time"),
            (Method::GET, "/_search/point_in_time/_all"),
            (Method::DELETE, "/_search/point_in_time/_all"),
        ] {
            assert!(
                matches!(plan(PREFIX, &method, path), Err(RouteError::Refused(_))),
                "{} {path} should be refused",
                method.as_str()
            );
        }
    }

    #[test]
    fn an_unknown_endpoint_is_refused_rather_than_forwarded() {
        // The default has to be no. Forwarding anything not known to be dangerous is a bet that the
        // next OpenSearch release adds no new way to read across indices.
        assert!(matches!(
            plan(PREFIX, &Method::GET, "/_whatever"),
            Err(RouteError::Refused(_))
        ));
        assert!(matches!(
            plan(PREFIX, &Method::GET, "/products/_whatever"),
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
            plan(PREFIX, &Method::POST, "/products/_bulk"),
            Ok(Plan::PathAndNdjson(_))
        ));
        assert!(matches!(
            plan(PREFIX, &Method::POST, "/_bulk"),
            Ok(Plan::PathAndNdjson(_))
        ));
        assert!(matches!(
            plan(PREFIX, &Method::POST, "/_msearch"),
            Ok(Plan::PathAndNdjson(_))
        ));
    }

    /// A bare `_bulk` takes its index per line, so the path must stay bare — `<prefix>*` is not a
    /// real index and OpenSearch would refuse the request outright.
    #[test]
    fn a_bare_bulk_keeps_a_bare_path() {
        for endpoint in ["_bulk", "_msearch"] {
            let planned = plan(PREFIX, &Method::POST, &format!("/{endpoint}")).unwrap();
            let Plan::PathAndNdjson(path) = planned else {
                panic!("{endpoint} was not planned as NDJSON")
            };
            assert_eq!(path, format!("/{endpoint}"));
        }
    }

    #[test]
    fn an_index_name_that_could_escape_its_path_segment_is_refused() {
        // A `/` in a name would land the rest of it in the *next* path segment, past the namespace.
        for name in ["../other", "a/b", "a\\b", "a,b/c", "a b", "a#b", "a:b"] {
            let path = format!("/{name}/_search");
            assert!(
                plan(PREFIX, &Method::GET, &path).is_err(),
                "{name} should be refused"
            );
        }
    }

    #[test]
    fn a_name_that_looks_like_an_endpoint_is_refused() {
        // `_cluster` as an index name would produce a path this proxy's own router could misread.
        assert!(plan(PREFIX, &Method::GET, "/_cluster/_search").is_err());
        assert!(plan(PREFIX, &Method::GET, "/-leading/_search").is_err());
        assert!(plan(PREFIX, &Method::GET, "/.hidden/_search").is_err());
    }

    #[test]
    fn decoded_dot_segments_are_refused_anywhere() {
        // This is why inspecting only the planned string was insufficient: the forwarding client
        // normalizes the assembled URL and removes the namespaced segments before sending it.
        let unsafe_target =
            format!("http://search.invalid/{PREFIX}products/_doc/../../_cluster/health");
        let assembled = reqwest::Client::new().get(unsafe_target).build().unwrap();
        assert_eq!(assembled.url().path(), "/_cluster/health");

        for path in [
            "/products/_doc/../../_cluster/health",
            "/products/_doc/%2e%2e/%2e%2e/_cat/indices",
            "/%2e%2e/_search",
        ] {
            assert!(
                matches!(
                    plan(PREFIX, &Method::GET, path),
                    Err(RouteError::Refused(_))
                ),
                "{path} must be refused before reqwest can normalize it"
            );
        }
    }

    #[test]
    fn encoded_index_syntax_is_decoded_then_namespaced() {
        assert_eq!(
            path_of("/a%2cb/_search").unwrap(),
            format!("/{PREFIX}a,{PREFIX}b/_search")
        );
        assert_eq!(
            path_of("/a%2c%2a/_search").unwrap(),
            format!("/{PREFIX}a,{PREFIX}*/_search")
        );
        assert!(plan(PREFIX, &Method::GET, "/a%2fb/_search").is_err());
        assert_eq!(
            path_of("/sales%25off/_search").unwrap(),
            format!("/{PREFIX}sales%25off/_search")
        );
        assert!(matches!(
            plan(PREFIX, &Method::GET, "/bad%2/_search"),
            Err(RouteError::Encoding)
        ));
    }

    #[test]
    fn a_document_id_is_decoded_and_safely_reencoded() {
        assert_eq!(
            path_of("/products/_doc/a%2fb").unwrap(),
            format!("/{PREFIX}products/_doc/a%2Fb")
        );
        assert_eq!(
            path_of("/products/_doc/a%20b").unwrap(),
            format!("/{PREFIX}products/_doc/a%20b")
        );
    }

    #[test]
    fn root_endpoint_tails_and_wrong_methods_are_refused() {
        assert!(plan(PREFIX, &Method::POST, "/_search/scroll").is_err());
        assert!(plan(PREFIX, &Method::DELETE, "/products/_search").is_err());
        assert!(plan(PREFIX, &Method::POST, "/products/_bulk/tail").is_err());
    }

    #[test]
    fn unknown_overriding_and_duplicate_query_parameters_are_refused() {
        assert!(validate_query(Some("refresh=true&pretty=true")).is_ok());
        assert!(matches!(
            validate_query(Some("index=someone-elses-index")),
            Err(RouteError::Query(name)) if name == "index"
        ));
        assert!(matches!(
            validate_query(Some("source=%7B%7D")),
            Err(RouteError::Query(name)) if name == "source"
        ));
        assert!(matches!(
            validate_query(Some("source_content_type=application%2Fjson")),
            Err(RouteError::Query(name)) if name == "source_content_type"
        ));
        assert!(matches!(
            validate_query(Some("refresh=true&%72efresh=false")),
            Err(RouteError::DuplicateQuery(name)) if name == "refresh"
        ));
        assert!(matches!(
            validate_query(Some("future_index_escape=x")),
            Err(RouteError::Query(_))
        ));
        assert!(matches!(
            validate_query(Some("refresh=%zz")),
            Err(RouteError::Encoding)
        ));
    }
}
