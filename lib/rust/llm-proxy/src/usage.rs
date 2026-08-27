//! Counting tokens out of a model response.
//!
//! This is the part that makes the proxy own billing, and it is the reason this proxy is unlike
//! every other split in the router. The Valkey, search and Postgres splits deliberately never read
//! a payload — they identify a tenant, rewrite, forward. This one has to read the body, because the
//! number it needs is inside it.
//!
//! ## Two wire formats
//!
//! Anthropic reports final usage on `message_delta`; the OpenAI Responses API reports it on
//! `response.completed`. Both stream Server-Sent Events, and in both the terminal event is the only
//! one carrying an output count that is not a running total. Non-streaming responses put the same
//! object at the top level.
//!
//! ## The case to design for is the abandoned stream
//!
//! A client that disconnects halfway has still spent tokens. If billing only happens on a terminal
//! event nobody waited for, that run is free — and "free if you hang up" is a billing system with a
//! hole in it that is trivially reachable by accident and then on purpose. `docs/findings/0011` is
//! this exact failure in a different subsystem.
//!
//! So the accumulator is updated as events arrive and can be read at any point, including from a
//! `Drop`. What it reports for an abandoned stream is what was seen, which is an undercount rather
//! than a zero — and undercounting what we could observe is a defensible answer where billing
//! nothing is not.

use serde::Deserialize;

/// What a turn cost, as far as we have seen.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
}

impl Usage {
    pub fn is_empty(&self) -> bool {
        self.input_tokens == 0 && self.output_tokens == 0 && self.cache_read_tokens == 0
    }
}

/// The usage object, in both providers' spellings.
///
/// One struct with aliases rather than two types and a branch: the fields mean the same thing, and
/// a second type would mean a second place to forget a field when a provider adds one.
#[derive(Debug, Default, Deserialize)]
struct WireUsage {
    #[serde(alias = "prompt_tokens")]
    input_tokens: Option<u64>,
    #[serde(alias = "completion_tokens")]
    output_tokens: Option<u64>,
    #[serde(alias = "cache_read_input_tokens")]
    cached_tokens: Option<u64>,
    /// OpenAI nests the cache count; Anthropic does not.
    input_tokens_details: Option<InputDetails>,
}

#[derive(Debug, Default, Deserialize)]
struct InputDetails {
    cached_tokens: Option<u64>,
}

/// Accumulates usage across a response, streaming or not.
#[derive(Debug, Default)]
pub struct UsageAccumulator {
    usage: Usage,
    buffer: String,
}

impl UsageAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// What has been observed so far. Safe to call at any point, including after a disconnect.
    pub fn usage(&self) -> Usage {
        self.usage
    }

    /// Feed a chunk of the response body.
    ///
    /// Chunk boundaries are arbitrary — a TCP read can split an SSE event anywhere, including
    /// mid-number — so bytes are buffered until a complete line is available. Parsing per chunk
    /// instead would work in every test and lose events under load, which is the worst possible
    /// distribution of failures for a billing path.
    pub fn push(&mut self, chunk: &str) {
        self.buffer.push_str(chunk);

        while let Some(index) = self.buffer.find('\n') {
            let line = self.buffer[..index].trim_end_matches('\r').to_string();
            self.buffer.drain(..=index);
            self.observe_line(&line);
        }
    }

    /// Called when the body ends, for the last line if it had no trailing newline, and for a
    /// non-streaming response whose whole body is one JSON object.
    pub fn finish(&mut self) {
        let rest = std::mem::take(&mut self.buffer);
        if !rest.trim().is_empty() {
            self.observe_line(&rest);
            // A non-streaming body is a bare JSON object with no `data:` prefix.
            self.observe_json(&rest);
        }
    }

    fn observe_line(&mut self, line: &str) {
        let Some(payload) = line.strip_prefix("data:") else {
            return;
        };
        let payload = payload.trim();
        // The SSE terminator, which is not JSON and must not be parsed as if it were.
        if payload.is_empty() || payload == "[DONE]" {
            return;
        }
        self.observe_json(payload);
    }

    fn observe_json(&mut self, payload: &str) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
            return;
        };

        /*
          Usage appears at three depths depending on the provider and the event.

          Searched rather than matched on event type: Anthropic puts it on `message_start` (input)
          and `message_delta` (output), OpenAI nests it under `response`, and a non-streaming reply
          puts it at the top. Keying off the event name means a provider adding a fourth place goes
          silently uncounted, which for a billing path is the wrong direction to fail in.
        */
        for candidate in [
            value.get("usage"),
            value.get("response").and_then(|it| it.get("usage")),
            value.get("message").and_then(|it| it.get("usage")),
        ]
        .into_iter()
        .flatten()
        {
            let Ok(wire) = serde_json::from_value::<WireUsage>(candidate.clone()) else {
                continue;
            };
            self.merge(&wire);
        }
    }

    /// Take the largest value seen for each field, never the sum.
    ///
    /// Both providers report cumulative counts: `message_start` carries the input count and
    /// `message_delta` repeats it alongside the final output count. Adding would double-bill every
    /// turn, and adding *sometimes* — whenever a stream happened to repeat an event — would produce
    /// a bill that is wrong by an amount nobody can reproduce.
    fn merge(&mut self, wire: &WireUsage) {
        if let Some(value) = wire.input_tokens {
            self.usage.input_tokens = self.usage.input_tokens.max(value);
        }
        if let Some(value) = wire.output_tokens {
            self.usage.output_tokens = self.usage.output_tokens.max(value);
        }
        let cached = wire.cached_tokens.or_else(|| {
            wire.input_tokens_details
                .as_ref()
                .and_then(|details| details.cached_tokens)
        });
        if let Some(value) = cached {
            self.usage.cache_read_tokens = self.usage.cache_read_tokens.max(value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use std::io::Write as _;

    #[test]
    fn counts_an_anthropic_stream() {
        let mut acc = UsageAccumulator::new();
        acc.push("event: message_start\n");
        acc.push(
            r#"data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":4}}}"#,
        );
        acc.push("\n\nevent: message_delta\n");
        acc.push(
            r#"data: {"type":"message_delta","usage":{"input_tokens":12,"output_tokens":37}}"#,
        );
        acc.push("\n\ndata: [DONE]\n\n");
        acc.finish();

        assert_eq!(
            acc.usage(),
            Usage {
                input_tokens: 12,
                output_tokens: 37,
                cache_read_tokens: 4,
            }
        );
    }

    #[tokio::test]
    async fn reqwest_decodes_a_real_gzip_response_before_counting() {
        let body = concat!(
            "event: message_start\n",
            r#"data: {"type":"message_start","message":{"usage":{"input_tokens":19}}}"#,
            "\n\nevent: message_delta\n",
            r#"data: {"type":"message_delta","usage":{"output_tokens":23}}"#,
            "\n\n",
        );
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(body.as_bytes()).unwrap();
        let compressed = encoder.finish().unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = axum::Router::new().fallback(|| async move {
            (
                [
                    ("content-type", "text/event-stream"),
                    ("content-encoding", "gzip"),
                ],
                compressed,
            )
        });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let response = reqwest::Client::new().get(url).send().await.unwrap();
        assert_eq!(response.headers().get("content-encoding"), None);
        let decoded = response.text().await.unwrap();
        assert!(decoded.contains("message_start"));

        let mut acc = UsageAccumulator::new();
        acc.push(&decoded);
        acc.finish();
        assert_eq!(acc.usage().input_tokens, 19);
        assert_eq!(acc.usage().output_tokens, 23);
    }

    #[test]
    fn counts_an_openai_responses_stream() {
        let mut acc = UsageAccumulator::new();
        acc.push(r#"data: {"type":"response.created","response":{"usage":null}}"#);
        acc.push("\n\n");
        acc.push(
            r#"data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":250,"input_tokens_details":{"cached_tokens":64}}}}"#,
        );
        acc.push("\n\n");
        acc.finish();

        assert_eq!(
            acc.usage(),
            Usage {
                input_tokens: 100,
                output_tokens: 250,
                cache_read_tokens: 64,
            }
        );
    }

    #[test]
    fn survives_a_split_anywhere() {
        // A TCP read can cut an event mid-number. This is the failure that would pass every test
        // written against whole events and lose usage under load.
        let body =
            r#"data: {"type":"message_delta","usage":{"input_tokens":12,"output_tokens":3700}}"#;
        for split in 1..body.len() {
            let mut acc = UsageAccumulator::new();
            acc.push(&body[..split]);
            acc.push(&body[split..]);
            acc.push("\n");
            acc.finish();
            assert_eq!(acc.usage().output_tokens, 3700, "split at {split}");
        }
    }

    #[test]
    fn reports_what_was_seen_when_the_client_hangs_up() {
        // The abandoned stream. Tokens were spent; billing zero because nobody waited for the
        // terminal event is a hole that is reachable by accident and then on purpose.
        let mut acc = UsageAccumulator::new();
        acc.push(r#"data: {"type":"message_start","message":{"usage":{"input_tokens":900}}}"#);
        acc.push("\n\n");
        // No `message_delta`, no `[DONE]`, no `finish()` — the connection simply ends.
        assert_eq!(acc.usage().input_tokens, 900);
        assert!(!acc.usage().is_empty());
    }

    #[test]
    fn does_not_double_count_a_repeated_field() {
        // Both providers repeat the input count on later events. Summing would double-bill every
        // turn — and summing only sometimes would be worse, because nobody could reproduce it.
        let mut acc = UsageAccumulator::new();
        for _ in 0..5 {
            acc.push(r#"data: {"usage":{"input_tokens":50,"output_tokens":10}}"#);
            acc.push("\n");
        }
        acc.finish();
        assert_eq!(acc.usage().input_tokens, 50);
        assert_eq!(acc.usage().output_tokens, 10);
    }

    #[test]
    fn counts_a_non_streaming_body() {
        let mut acc = UsageAccumulator::new();
        acc.push(r#"{"id":"msg_1","usage":{"input_tokens":7,"output_tokens":11}}"#);
        acc.finish();
        assert_eq!(acc.usage().output_tokens, 11);
    }

    #[test]
    fn ignores_the_sse_terminator_and_junk() {
        let mut acc = UsageAccumulator::new();
        acc.push("data: [DONE]\n\n: a comment\n\ndata: not json\n\n");
        acc.finish();
        assert!(acc.usage().is_empty());
    }
}
