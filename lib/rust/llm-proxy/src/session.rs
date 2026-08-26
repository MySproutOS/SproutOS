//! Who a proxy token belongs to, and what the proxy should do with it.
//!
//! One indexed lookup per request against the control-plane database. That is deliberate: a signed
//! token would let this skip the read, and the property worth more than the read is that revoking a
//! sandbox stops it **now** rather than when a claim expires.

use serde::Serialize;

/// Which provider's wire format this session speaks.
///
/// Decided at mint time and carried on the row rather than sniffed from the request, because the
/// answer changes how usage is parsed and a wrong guess silently mis-bills instead of failing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Upstream {
    Anthropic,
    Openai,
}

impl Upstream {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "anthropic" => Some(Self::Anthropic),
            "openai" => Some(Self::Openai),
            _ => None,
        }
    }

    /// The default endpoint for a session that did not name one.
    pub fn default_base_url(self) -> &'static str {
        match self {
            Self::Anthropic => "https://api.anthropic.com",
            Self::Openai => "https://api.openai.com/v1",
        }
    }

    /// How the provider expects its credential.
    ///
    /// Anthropic takes `x-api-key` and OpenAI takes a bearer. Sending the wrong one is a 401 that
    /// reads like an invalid key, which is a genuinely misleading place to end up.
    pub fn auth_header(self) -> &'static str {
        match self {
            Self::Anthropic => "x-api-key",
            Self::Openai => "authorization",
        }
    }

    pub fn auth_value(self, secret: &str) -> String {
        match self {
            Self::Anthropic => secret.to_string(),
            Self::Openai => format!("Bearer {secret}"),
        }
    }
}

/// A live session, resolved from an access token.
#[derive(Debug, Clone)]
pub struct Session {
    pub token_id: String,
    pub organization_id: String,
    pub project_id: Option<String>,
    pub upstream: Upstream,
    pub base_url: String,
    /// The upstream credential, already opened. Never leaves this process.
    pub secret: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_provider_gets_the_header_it_expects() {
        // Swapping these is a 401 that reads like an invalid key rather than a misplaced one.
        assert_eq!(Upstream::Anthropic.auth_header(), "x-api-key");
        assert_eq!(Upstream::Anthropic.auth_value("sk-x"), "sk-x");
        assert_eq!(Upstream::Openai.auth_header(), "authorization");
        assert_eq!(Upstream::Openai.auth_value("sk-x"), "Bearer sk-x");
    }

    #[test]
    fn an_unknown_upstream_is_none_rather_than_a_default() {
        // Defaulting would send a customer's Anthropic key to OpenAI, or parse usage with the wrong
        // shape and bill zero. Refusing is the only safe answer to a value we do not recognise.
        assert_eq!(Upstream::parse("anthropic"), Some(Upstream::Anthropic));
        assert_eq!(Upstream::parse("openai"), Some(Upstream::Openai));
        assert_eq!(Upstream::parse("gemini"), None);
        assert_eq!(Upstream::parse(""), None);
    }
}
