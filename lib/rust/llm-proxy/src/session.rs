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
    /// Anthropic, reached with a Claude subscription's OAuth token rather than an API key.
    ///
    /// The same wire format and the same usage shape — what differs is entirely how the credential
    /// is presented, which is why it is a variant here rather than a flag somewhere else. Sent as
    /// `x-api-key`, an OAuth token is a 401 that reads like an invalid key, and every turn on a
    /// customer's Claude subscription would have failed that way.
    AnthropicOauth,
    Openai,
}

impl Upstream {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "anthropic" => Some(Self::Anthropic),
            "anthropic_oauth" => Some(Self::AnthropicOauth),
            "openai" => Some(Self::Openai),
            _ => None,
        }
    }

    /// Headers the provider needs beyond the credential.
    ///
    /// Anthropic requires the OAuth beta opt-in on a subscription token, and the CLI in a sandbox
    /// does not send it: it is configured with `ANTHROPIC_AUTH_TOKEN`, so as far as it knows it is
    /// talking to an ordinary API-key endpoint. The proxy knows better, because the *credential*
    /// is what makes it a subscription, and the credential is on this side.
    pub fn extra_headers(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Self::AnthropicOauth => &[("anthropic-beta", "oauth-2025-04-20")],
            Self::Anthropic | Self::Openai => &[],
        }
    }

    /// The default endpoint for a session that did not name one.
    pub fn default_base_url(self) -> &'static str {
        match self {
            Self::Anthropic | Self::AnthropicOauth => "https://api.anthropic.com",
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
            Self::AnthropicOauth | Self::Openai => "authorization",
        }
    }

    pub fn auth_value(self, secret: &str) -> String {
        match self {
            Self::Anthropic => secret.to_string(),
            Self::AnthropicOauth | Self::Openai => format!("Bearer {secret}"),
        }
    }
}

/// A live session, resolved from an access token.
#[derive(Debug, Clone)]
pub struct Session {
    pub token_id: String,
    pub organization_id: String,
    pub project_id: Option<String>,
    /// True when `agent_proxy_token.agent_credential_id` names a customer-provided credential.
    pub charged_externally: bool,
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
    fn a_subscription_is_a_bearer_with_the_oauth_opt_in() {
        /*
          A Claude subscription token is an OAuth token. Presented as `x-api-key` it is a 401 that
          reads like an invalid key — and the beta header is not optional either: the sandbox's CLI
          is configured with `ANTHROPIC_AUTH_TOKEN` and believes it is talking to an ordinary
          API-key endpoint, so it never sends the opt-in itself.
        */
        assert_eq!(Upstream::AnthropicOauth.auth_header(), "authorization");
        assert_eq!(
            Upstream::AnthropicOauth.auth_value("sk-oat"),
            "Bearer sk-oat"
        );
        assert_eq!(
            Upstream::AnthropicOauth.extra_headers(),
            &[("anthropic-beta", "oauth-2025-04-20")]
        );
        // The API-key path is untouched, and takes no beta header it did not ask for.
        assert_eq!(Upstream::Anthropic.extra_headers(), &[]);
        assert_eq!(
            Upstream::AnthropicOauth.default_base_url(),
            Upstream::Anthropic.default_base_url()
        );
    }

    #[test]
    fn an_unknown_upstream_is_none_rather_than_a_default() {
        // Defaulting would send a customer's Anthropic key to OpenAI, or parse usage with the wrong
        // shape and bill zero. Refusing is the only safe answer to a value we do not recognise.
        assert_eq!(Upstream::parse("anthropic"), Some(Upstream::Anthropic));
        assert_eq!(Upstream::parse("openai"), Some(Upstream::Openai));
        assert_eq!(
            Upstream::parse("anthropic_oauth"),
            Some(Upstream::AnthropicOauth)
        );
        assert_eq!(Upstream::parse("gemini"), None);
        assert_eq!(Upstream::parse(""), None);
    }
}
