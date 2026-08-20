//! Rewriting index names inside request and response bodies.
//!
//! The path is not the only place an index name appears. `_bulk` and `_msearch` carry one per line,
//! and every search response echoes the index each hit came from. Namespacing the path and leaving
//! the bodies alone would let a `_bulk` write into another tenant's index, and would show a tenant
//! the shared cluster's naming on the way back.

use serde_json::Value;

use crate::naming::{IndexError, namespace, strip};

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
}
