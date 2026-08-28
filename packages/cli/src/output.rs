use serde::Serialize;
use serde_json::Value;

use crate::{CliError, Result};

/// Stable machine-readable success envelope. Fields may only be added compatibly.
#[derive(Debug, Serialize)]
pub struct SuccessEnvelope<'a, T: Serialize> {
    pub schema_version: u8,
    pub ok: bool,
    pub command: &'a str,
    pub data: T,
}

pub fn json_success(command: &str, data: impl Serialize) -> Result<String> {
    serde_json::to_string(&SuccessEnvelope {
        schema_version: 1,
        ok: true,
        command,
        data,
    })
    .map_err(|error| CliError::Configuration(format!("could not encode output: {error}")))
}

pub fn json_error(error: &CliError) -> String {
    serde_json::to_string(&error.envelope()).expect("the fixed error envelope is serializable")
}

/// Redact diagnostic values. Result data does not pass through this function because a one-time
/// credential returned by `service create` must remain available to its caller.
pub fn redact_diagnostic(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
                if [
                    "authorization",
                    "accesstoken",
                    "refreshtoken",
                    "token",
                    "password",
                    "clientsecret",
                    "codeverifier",
                    "connectionuri",
                ]
                .contains(&normalized.as_str())
                {
                    *child = Value::String("[REDACTED]".into());
                } else {
                    redact_diagnostic(child);
                }
            }
        }
        Value::Array(values) => values.iter_mut().for_each(redact_diagnostic),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn success_schema_is_versioned_and_stable() {
        assert_eq!(
            json_success("org.list", json!({"data": []})).unwrap(),
            r#"{"schema_version":1,"ok":true,"command":"org.list","data":{"data":[]}}"#
        );
    }

    #[test]
    fn diagnostic_redaction_walks_nested_values() {
        let mut value = json!({
            "authorization": "Bearer secret",
            "nested": [{"refresh_token": "refresh", "safe": "yes"}],
            "connectionUri": "postgres://user:pass@host/db"
        });
        redact_diagnostic(&mut value);
        assert_eq!(value["authorization"], "[REDACTED]");
        assert_eq!(value["nested"][0]["refresh_token"], "[REDACTED]");
        assert_eq!(value["nested"][0]["safe"], "yes");
        assert_eq!(value["connectionUri"], "[REDACTED]");
    }

    #[test]
    fn errors_never_include_debug_fields() {
        assert_eq!(
            json_error(&CliError::AuthenticationRequired),
            r#"{"schema_version":1,"ok":false,"error":{"code":"authentication_required","message":"authentication required; run `sprout auth login` or set SPROUTOS_TOKEN","retryable":false}}"#
        );
    }
}
