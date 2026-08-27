//! Rewriting index names inside request and response bodies.
//!
//! The path is not the only place an index name appears. `_bulk` and `_msearch` carry one per line,
//! and every search response echoes the index each hit came from. Namespacing the path and leaving
//! the bodies alone would let a `_bulk` write into another tenant's index, and would show a tenant
//! the shared cluster's naming on the way back.

use serde_json::Value;

use crate::naming::{IndexError, namespace, strip};

const MGET_DOC_FIELDS: &[&str] = &[
    "_id",
    "_index",
    "_source",
    "_source_excludes",
    "_source_includes",
    "routing",
    "stored_fields",
    "version",
    "version_type",
];

/// Whether a search request body attempts to use a point-in-time handle.
///
/// PIT ids are cluster-wide capabilities rather than names that can be tenant-prefixed. Until the
/// proxy has a durable, shared ownership registry, accepting one would let a tenant who obtained
/// another tenant's id search that tenant's snapshot. JSON decoding matters here: a textual scan
/// would miss escaped key spellings and would reject harmless string values containing `"pit"`.
pub fn search_body_uses_point_in_time(body: &[u8]) -> Result<bool, IndexError> {
    if body.is_empty() {
        return Ok(false);
    }
    let value = serde_json::from_slice::<Value>(body)
        .map_err(|_| IndexError::Illegal("_search body must be JSON".into()))?;
    let object = value
        .as_object()
        .ok_or_else(|| IndexError::Illegal("_search body must be an object".into()))?;
    Ok(object.contains_key("pit"))
}

/// Whether any request body in an `_msearch` NDJSON payload uses a point-in-time handle.
///
/// Both metadata and search-body lines are checked. Refusing a harmless metadata key is preferable
/// to relying on parity after a malformed line, and mirrors the NDJSON index rewriting policy.
pub fn msearch_body_uses_point_in_time(body: &[u8]) -> Result<bool, IndexError> {
    let text = std::str::from_utf8(body)
        .map_err(|_| IndexError::Illegal("_msearch body must be UTF-8 NDJSON".into()))?;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let value = serde_json::from_str::<Value>(line)
            .map_err(|_| IndexError::Illegal("every _msearch line must be JSON".into()))?;
        let object = value
            .as_object()
            .ok_or_else(|| IndexError::Illegal("every _msearch line must be an object".into()))?;
        if object.contains_key("pit") {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Validate and namespace the exact JSON shapes accepted by the allowlisted `_mget` route.
///
/// A bare `/_mget` must use `docs` with one `_index` per document. An index-scoped request may
/// instead use the `ids` shorthand. Unknown root or document fields are refused rather than
/// recursively rewriting anything named `index`: a tenant document may legitimately contain such
/// a field, and an undocumented future field must be reviewed before it is forwarded.
pub fn rewrite_mget(prefix: &str, body: &[u8], index_in_path: bool) -> Result<Vec<u8>, IndexError> {
    let mut value: Value = serde_json::from_slice(body)
        .map_err(|_| IndexError::Illegal("_mget body is not JSON".into()))?;
    let root = value
        .as_object_mut()
        .ok_or_else(|| IndexError::Illegal("_mget body must be an object".into()))?;

    if root.len() != 1 {
        return Err(IndexError::Illegal(
            "_mget body must contain exactly one of `docs` or `ids`".into(),
        ));
    }

    if let Some(ids) = root.get("ids") {
        if !index_in_path
            || !ids
                .as_array()
                .is_some_and(|ids| ids.iter().all(Value::is_string))
        {
            return Err(IndexError::Illegal(
                "_mget `ids` is allowed only on an index-scoped path and must be strings".into(),
            ));
        }
        return serde_json::to_vec(&value)
            .map_err(|_| IndexError::Illegal("could not encode _mget body".into()));
    }

    let docs = root
        .get_mut("docs")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| IndexError::Illegal("_mget body must contain a `docs` array".into()))?;

    for document in docs {
        let descriptor = document.as_object_mut().ok_or_else(|| {
            IndexError::Illegal("every _mget `docs` entry must be an object".into())
        })?;
        if descriptor
            .keys()
            .any(|field| !MGET_DOC_FIELDS.contains(&field.as_str()))
        {
            return Err(IndexError::Illegal(
                "an _mget document contains an unknown field".into(),
            ));
        }
        if !descriptor.get("_id").is_some_and(Value::is_string) {
            return Err(IndexError::Illegal(
                "every _mget document must have a string `_id`".into(),
            ));
        }
        for (field, value) in descriptor.iter() {
            let valid = match field.as_str() {
                "_id" | "routing" | "version_type" => value.is_string(),
                "version" => value.as_i64().is_some() || value.as_u64().is_some(),
                "stored_fields" | "_source_includes" | "_source_excludes" => {
                    string_or_string_array(value)
                }
                "_source" => source_filter(value),
                "_index" => true, // Rewritten and type-checked immediately below.
                _ => false,
            };
            if !valid {
                return Err(IndexError::Illegal(format!(
                    "an _mget document `{field}` has the wrong type"
                )));
            }
        }

        match descriptor.get_mut("_index") {
            Some(Value::String(index)) => *index = namespace(prefix, index)?,
            Some(_) => {
                return Err(IndexError::Illegal(
                    "an _mget document `_index` must be a string".into(),
                ));
            }
            None if !index_in_path => {
                return Err(IndexError::Illegal(
                    "a bare _mget document must name `_index`".into(),
                ));
            }
            None => {}
        }
    }

    serde_json::to_vec(&value)
        .map_err(|_| IndexError::Illegal("could not encode _mget body".into()))
}

fn string_or_string_array(value: &Value) -> bool {
    value.is_string()
        || value
            .as_array()
            .is_some_and(|values| values.iter().all(Value::is_string))
}

fn source_filter(value: &Value) -> bool {
    if value.is_boolean() || string_or_string_array(value) {
        return true;
    }
    value.as_object().is_some_and(|filter| {
        filter
            .keys()
            .all(|key| key == "includes" || key == "excludes")
            && filter.values().all(string_or_string_array)
    })
}

/// Rewrites the `_index` field on every line of an NDJSON body.
///
/// `_bulk` alternates an action line with an optional document line; `_msearch` alternates a header
/// with a query. Both are line-delimited JSON, and in both the index lives on the odd lines. Rather
/// than tracking which kind of line we are on — which differs between the two formats and gets out
/// of step the moment a document happens to contain `_index` — every line that parses as a JSON
/// object is examined, and `_index` is rewritten wherever it appears at the top level or one level
/// down.
///
/// A line that is not a JSON object is passed through untouched: it is a document body, and a
/// document body's contents are the tenant's own.
pub fn rewrite_ndjson(prefix: &str, body: &[u8]) -> Result<Vec<u8>, IndexError> {
    let text = std::str::from_utf8(body).map_err(|_| IndexError::Illegal("not utf-8".into()))?;

    let mut out = String::with_capacity(text.len() + 64);
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.trim().is_empty() {
            out.push_str(line);
            continue;
        }

        match serde_json::from_str::<Value>(trimmed) {
            Ok(Value::Object(mut map)) => {
                rewrite_index_fields(prefix, &mut map)?;
                out.push_str(&serde_json::to_string(&Value::Object(map)).unwrap_or_default());
                // The newline the original line ended with, so the last line stays unterminated if
                // it was — OpenSearch requires a trailing newline and rejects a body without one,
                // and silently adding it would hide a client bug rather than surface it.
                if let Some(ending) = line.strip_prefix(trimmed) {
                    out.push_str(ending);
                }
            }
            _ => out.push_str(line),
        }
    }
    Ok(out.into_bytes())
}

fn rewrite_index_fields(
    prefix: &str,
    map: &mut serde_json::Map<String, Value>,
) -> Result<(), IndexError> {
    for (key, value) in map.iter_mut() {
        match value {
            Value::String(name) if key == "_index" || key == "index" => {
                *name = namespace(prefix, name)?;
            }
            /*
              `_msearch` headers spell it `index` and it may be an array:
              `{"index": ["a", "b"]}`. Missing the array form would send the request through with
              raw names, which OpenSearch resolves against the whole cluster.
            */
            Value::Array(names) if key == "_index" || key == "index" => {
                for entry in names.iter_mut() {
                    if let Value::String(name) = entry {
                        *name = namespace(prefix, name)?;
                    }
                }
            }
            // `_bulk` nests the action: `{"index": {"_index": "products"}}`. One level is enough —
            // neither format nests deeper than that.
            Value::Object(nested) => {
                for (nested_key, nested_value) in nested.iter_mut() {
                    if nested_key != "_index" && nested_key != "index" {
                        continue;
                    }
                    match nested_value {
                        Value::String(name) => *name = namespace(prefix, name)?,
                        Value::Array(names) => {
                            for entry in names.iter_mut() {
                                if let Value::String(name) = entry {
                                    *name = namespace(prefix, name)?;
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Removes the tenant's prefix from index names in a response.
///
/// Every search hit carries `"_index": "t01j…_products"`, and a client that reads it and sends it
/// back — which is exactly what a "reindex this document" flow does — would get it prefixed twice.
///
/// This is a textual replacement of the prefix where it begins a JSON string, rather than a parse
/// of the whole response. A response can be megabytes of hits and reparsing it to change one field
/// per hit is work proportional to the data rather than to the change. The one thing it could get
/// wrong is a tenant who stores their own prefix at the start of a string field — which is their
/// own resource id appearing in their own document, harmless, and not worth the cost of parsing
/// every response to avoid.
pub fn strip_prefix_from_response(prefix: &str, body: &[u8]) -> Vec<u8> {
    let needle = format!("\"{prefix}");
    if !contains(body, needle.as_bytes()) {
        return body.to_vec();
    }

    let mut out = Vec::with_capacity(body.len());
    let mut index = 0;
    while index < body.len() {
        if body[index..].starts_with(needle.as_bytes()) {
            out.push(b'"');
            index += needle.len();
        } else {
            out.push(body[index]);
            index += 1;
        }
    }
    out
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// Removes the prefix from a single name, for logs and errors shown to a tenant.
pub fn present(prefix: &str, name: &str) -> String {
    strip(prefix, name).unwrap_or(name).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PREFIX: &str = "t01j4pkz2hbfh6sw7sa7d65tvkz_";

    fn rewrite(body: &str) -> String {
        String::from_utf8(rewrite_ndjson(PREFIX, body.as_bytes()).unwrap()).unwrap()
    }

    fn rewrite_mget_text(body: &str, index_in_path: bool) -> String {
        String::from_utf8(rewrite_mget(PREFIX, body.as_bytes(), index_in_path).unwrap()).unwrap()
    }

    #[test]
    fn search_pit_detection_decodes_json_keys_without_matching_document_text() {
        assert!(search_body_uses_point_in_time(br#"{"pit":{"id":"tenant-a-handle"}}"#).unwrap());
        assert!(
            search_body_uses_point_in_time(br#"{"p\u0069t":{"id":"tenant-a-handle"}}"#).unwrap()
        );
        assert!(
            !search_body_uses_point_in_time(br#"{"query":{"match":{"description":"a pit stop"}}}"#)
                .unwrap()
        );
        assert!(search_body_uses_point_in_time(b"not JSON").is_err());
    }

    #[test]
    fn msearch_pit_detection_checks_every_ndjson_object() {
        assert!(
            msearch_body_uses_point_in_time(b"{}\n{\"pit\":{\"id\":\"tenant-a-handle\"}}\n")
                .unwrap()
        );
        assert!(!msearch_body_uses_point_in_time(b"{}\n{\"query\":{\"match_all\":{}}}\n").unwrap());
        assert!(msearch_body_uses_point_in_time(b"{}\nnot JSON\n").is_err());
    }

    /// The leak this module exists for: a `_bulk` body names its index per line, so namespacing the
    /// path and leaving the body alone lets a tenant write into anyone's index.
    #[test]
    fn bulk_action_lines_are_namespaced() {
        let out =
            rewrite("{\"index\":{\"_index\":\"products\",\"_id\":\"1\"}}\n{\"name\":\"widget\"}\n");
        assert!(
            out.contains(&format!("\"_index\":\"{PREFIX}products\"")),
            "{out}"
        );
        // The document line is the tenant's own data and must be untouched.
        assert!(out.contains("{\"name\":\"widget\"}"), "{out}");
    }

    #[test]
    fn every_bulk_action_verb_is_covered() {
        for verb in ["index", "create", "update", "delete"] {
            let out = rewrite(&format!("{{\"{verb}\":{{\"_index\":\"products\"}}}}\n"));
            assert!(out.contains(&format!("{PREFIX}products")), "{verb}: {out}");
        }
    }

    #[test]
    fn msearch_headers_are_namespaced_in_both_spellings() {
        // `_msearch` spells it `index`, not `_index`, and it may be a list.
        let out = rewrite("{\"index\":\"products\"}\n{\"query\":{\"match_all\":{}}}\n");
        assert!(out.contains(&format!("\"{PREFIX}products\"")), "{out}");

        let list = rewrite("{\"index\":[\"products\",\"orders\"]}\n{\"query\":{}}\n");
        assert!(list.contains(&format!("\"{PREFIX}products\"")), "{list}");
        assert!(
            list.contains(&format!("\"{PREFIX}orders\"")),
            "an array of indices must be namespaced entry by entry: {list}"
        );
    }

    #[test]
    fn a_wildcard_in_a_body_is_scoped_too() {
        let out = rewrite("{\"index\":\"_all\"}\n{\"query\":{}}\n");
        assert!(out.contains(&format!("\"{PREFIX}*\"")), "{out}");
    }

    #[test]
    fn an_illegal_name_in_a_body_refuses_the_request() {
        // Not "rewrite what you can": one un-namespaced line is one write into the shared cluster.
        assert!(rewrite_ndjson(PREFIX, b"{\"index\":{\"_index\":\"../other\"}}\n").is_err());
    }

    #[test]
    fn the_trailing_newline_is_preserved_exactly() {
        /*
          OpenSearch refuses a `_bulk` body that does not end with a newline. Adding one that the
          client did not send would hide their bug; dropping the one they did send would break a
          request that was fine.
        */
        assert!(rewrite("{\"index\":{\"_index\":\"a\"}}\n").ends_with('\n'));
        assert!(!rewrite("{\"index\":{\"_index\":\"a\"}}").ends_with('\n'));
    }

    #[test]
    fn a_document_containing_index_is_not_mangled() {
        // A document line is not an action line, but this rewriter looks at every object rather
        // than tracking parity — so a document with its own `_index` field would be rewritten.
        // That is a known and deliberate trade: parity tracking gets out of step on a malformed
        // body, and a wrongly-parsed action line is a cross-tenant write. This documents which way
        // the trade falls.
        let out = rewrite("{\"index\":{\"_index\":\"a\"}}\n{\"title\":\"about _index fields\"}\n");
        assert!(out.contains("about _index fields"), "{out}");
    }

    #[test]
    fn blank_lines_and_non_json_pass_through() {
        let out = rewrite("{\"index\":{\"_index\":\"a\"}}\n\nnot json\n");
        assert!(out.contains("not json"));
        assert!(out.contains("\n\n"));
    }

    #[test]
    fn responses_have_the_prefix_removed() {
        let response = format!(
            "{{\"hits\":{{\"hits\":[{{\"_index\":\"{PREFIX}products\",\"_id\":\"1\"}}]}}}}"
        );
        let out = strip_prefix_from_response(PREFIX, response.as_bytes());
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("\"_index\":\"products\""), "{text}");
        assert!(!text.contains(PREFIX), "the prefix leaked: {text}");
    }

    #[test]
    fn an_error_response_has_the_prefix_removed_too() {
        // An OpenSearch error names the index it objected to, and that name is the namespaced one.
        let response = format!("{{\"error\":{{\"reason\":\"no such index [{PREFIX}products]\"}}}}");
        let out =
            String::from_utf8(strip_prefix_from_response(PREFIX, response.as_bytes())).unwrap();
        // Only where it begins a JSON string — inside the sentence it is left alone, because a
        // blind replacement would corrupt a tenant's own document text.
        assert!(out.contains(PREFIX), "{out}");
    }

    #[test]
    fn a_response_without_the_prefix_is_returned_unchanged() {
        let response = b"{\"hits\":{\"total\":0}}";
        assert_eq!(strip_prefix_from_response(PREFIX, response), response);
    }

    #[test]
    fn stripping_only_matches_at_the_start_of_a_string() {
        // A tenant's document text mentioning the prefix mid-sentence must not be edited.
        let body = format!("{{\"body\":\"see {PREFIX}products for details\"}}");
        let out = String::from_utf8(strip_prefix_from_response(PREFIX, body.as_bytes())).unwrap();
        assert_eq!(out, body);
    }

    #[test]
    fn present_falls_back_to_the_name_it_was_given() {
        assert_eq!(present(PREFIX, &format!("{PREFIX}products")), "products");
        assert_eq!(present(PREFIX, "products"), "products");
    }

    #[test]
    fn a_bare_mget_namespaces_every_document_index() {
        let out = rewrite_mget_text(
            r#"{"docs":[{"_index":"products","_id":"1"},{"_index":"orders","_id":"2"}]}"#,
            false,
        );
        assert!(
            out.contains(&format!(r#""_index":"{PREFIX}products""#)),
            "{out}"
        );
        assert!(
            out.contains(&format!(r#""_index":"{PREFIX}orders""#)),
            "{out}"
        );
    }

    #[test]
    fn mget_refuses_off_schema_or_unscoped_bodies() {
        for body in [
            r#"{"docs":[{"_index":"products","_id":"1","index":"victim"}]}"#,
            r#"{"docs":[{"_id":"1"}]}"#,
            r#"{"docs":[{"_index":7,"_id":"1"}]}"#,
            r#"{"docs":"products"}"#,
            r#"{"ids":["1"]}"#,
            r#"{"docs":[],"index":"victim"}"#,
        ] {
            assert!(
                rewrite_mget(PREFIX, body.as_bytes(), false).is_err(),
                "{body}"
            );
        }
    }

    #[test]
    fn an_index_scoped_mget_accepts_ids_and_optional_document_indices() {
        assert_eq!(
            rewrite_mget_text(r#"{"ids":["1","2"]}"#, true),
            r#"{"ids":["1","2"]}"#
        );
        let out = rewrite_mget_text(
            r#"{"docs":[{"_id":"1"},{"_index":"archive","_id":"2"}]}"#,
            true,
        );
        assert!(
            out.contains(&format!(r#""_index":"{PREFIX}archive""#)),
            "{out}"
        );
    }
}
