//! The usage-event wire schema and its HMAC signature.
//!
//! Everything that meters a tenant — the cgroup sampler, the valkey proxy, the pg proxy, the
//! search proxy — builds a [`UsageBatch`], signs it with [`sign`], and posts it to the ingest
//! route, which verifies it with the TypeScript mirror of [`verify`].
//!
//! ```
//! use sproutos_metering_proto::{UsageBatch, UsageDimension, UsageEvent, sign, verify};
//! use uuid::Uuid;
//!
//! let org = Uuid::parse_str("01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f").unwrap();
//! let event = UsageEvent::new(
//!     "metering-agent:pod-7:site_gib_second:1723459200",
//!     org,
//!     UsageDimension::SiteGibSecond,
//!     1.5,
//!     1_723_459_200_000,
//! );
//! let batch = UsageBatch::new("metering-agent", vec![event]);
//!
//! let key = b"shared secret";
//! let signature = sign(&batch, key);
//! assert!(verify(&batch, key, &signature));
//! ```
//!
//! # Why this crate exists
//!
//! Usage events are invoices. They are not telemetry, they must not travel a telemetry path, and
//! they must not be reconstructed by two languages that each guess at how to serialize a float.
//! The signature covers a [canonical form](canonical) that this crate defines byte for byte, and
//! `fixtures/signing-vectors.json` pins that definition across implementations.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use uuid::Uuid;

/// Domain separator prefixed to the canonical bytes before signing.
///
/// It pins the signature to *this* schema version. A future v2 canonical form signs different
/// bytes for the same batch, so a v1 signature can never be replayed as a v2 one.
pub const CANONICAL_DOMAIN: &str = "sproutos.metering.v1";

/// Length in bytes of an HMAC-SHA256 signature.
pub const SIGNATURE_LEN: usize = 32;

/// A metered quantity.
///
/// The variant names are the billing dimensions; the serialized names are `snake_case` and are the
/// strings that appear on the wire, in the price book, and in the ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum UsageDimension {
    /// Memory held by a tenant site, in GiB-seconds.
    SiteGibSecond,
    /// Memory provisioned for a tenant site, in GiB-seconds.
    SiteProvisionedGibSecond,
    /// One HTTP request served by a tenant site.
    SiteRequest,
    /// One byte of egress from a tenant site.
    SiteEgressByte,
    /// Database storage, in GiB-hours.
    DbStorageGibHour,
    /// Database compute, in compute-unit seconds.
    DbComputeCuSecond,
    /// Search index storage, in GiB-hours.
    EsStorageGibHour,
    /// One billable search unit.
    EsSearchUnit,
    /// Bytes resident in a tenant's valkey queues, in byte-seconds.
    ValkeyQueueByteSecond,
    /// One workflow job accepted for execution.
    WorkflowJobEnqueued,
    /// Workflow execution CPU, in vCPU-seconds.
    WorkflowExecVcpuSecond,
    /// Workflow execution memory, in GiB-seconds.
    WorkflowExecGibSecond,
    /// One token of AI model input.
    AiInputToken,
    /// One token of AI model output.
    AiOutputToken,
    /// One token read from an AI prompt cache.
    AiCacheReadToken,
    /// One second spent running a coding agent.
    AgentRunSecond,
    /// Sandbox CPU allocation, in vCPU-seconds.
    SandboxCpuSecond,
    /// Sandbox memory allocation, in GiB-seconds.
    SandboxGibSecond,
    /// Sandbox disk allocation, in GiB-seconds.
    SandboxDiskGibSecond,
}

impl UsageDimension {
    /// Every dimension, in declaration order.
    pub const ALL: &'static [Self] = &[
        Self::SiteGibSecond,
        Self::SiteProvisionedGibSecond,
        Self::SiteRequest,
        Self::SiteEgressByte,
        Self::DbStorageGibHour,
        Self::DbComputeCuSecond,
        Self::EsStorageGibHour,
        Self::EsSearchUnit,
        Self::ValkeyQueueByteSecond,
        Self::WorkflowJobEnqueued,
        Self::WorkflowExecVcpuSecond,
        Self::WorkflowExecGibSecond,
        Self::AiInputToken,
        Self::AiOutputToken,
        Self::AiCacheReadToken,
        Self::AgentRunSecond,
        Self::SandboxCpuSecond,
        Self::SandboxGibSecond,
        Self::SandboxDiskGibSecond,
    ];

    /// The wire name, identical to the serde representation.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SiteGibSecond => "site_gib_second",
            Self::SiteProvisionedGibSecond => "site_provisioned_gib_second",
            Self::SiteRequest => "site_request",
            Self::SiteEgressByte => "site_egress_byte",
            Self::DbStorageGibHour => "db_storage_gib_hour",
            Self::DbComputeCuSecond => "db_compute_cu_second",
            Self::EsStorageGibHour => "es_storage_gib_hour",
            Self::EsSearchUnit => "es_search_unit",
            Self::ValkeyQueueByteSecond => "valkey_queue_byte_second",
            Self::WorkflowJobEnqueued => "workflow_job_enqueued",
            Self::WorkflowExecVcpuSecond => "workflow_exec_vcpu_second",
            Self::WorkflowExecGibSecond => "workflow_exec_gib_second",
            Self::AiInputToken => "ai_input_token",
            Self::AiOutputToken => "ai_output_token",
            Self::AiCacheReadToken => "ai_cache_read_token",
            Self::AgentRunSecond => "agent_run_second",
            Self::SandboxCpuSecond => "sandbox_cpu_second",
            Self::SandboxGibSecond => "sandbox_gib_second",
            Self::SandboxDiskGibSecond => "sandbox_disk_gib_second",
        }
    }
}

impl fmt::Display for UsageDimension {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The wire name did not correspond to a known [`UsageDimension`].
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unknown usage dimension `{0}`")]
pub struct UnknownDimension(pub String);

impl FromStr for UsageDimension {
    type Err = UnknownDimension;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .iter()
            .copied()
            .find(|dimension| dimension.as_str() == s)
            .ok_or_else(|| UnknownDimension(s.to_owned()))
    }
}

/// One metered thing that happened.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageEvent {
    /// The idempotency key.
    ///
    /// Ingest is keyed on this string: the same `external_id` posted twice is the same event, and
    /// the second copy is dropped. Emitters must therefore derive it from the *measurement*
    /// (emitter, subject, window) and never from a clock read or a random number, so that a retry
    /// after a timeout produces the identical key. See the README.
    pub external_id: String,

    /// The organization being billed.
    pub organization_id: Uuid,

    /// The project the usage belongs to, when it is attributable to one.
    #[serde(default)]
    pub project_id: Option<Uuid>,

    /// Whether this usage was paid directly to an external provider.
    ///
    /// `None` is the legacy wire shape. It is intentionally distinct from `Some(false)` so a
    /// batch durably spooled before this field existed keeps the exact canonical bytes and remains
    /// verifiable after an ingest upgrade. New emitters that know the answer must set it explicitly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub charged_externally: Option<bool>,

    /// What was measured.
    pub dimension: UsageDimension,

    /// How much of it. Must be finite and non-negative; see [`UsageBatch::validate`].
    pub quantity: f64,

    /// When the measurement window ended, in Unix milliseconds.
    pub occurred_at: i64,

    /// Free-form labels carried through to the ledger for attribution.
    ///
    /// Keys are restricted to `[a-z0-9._-]` (see [`UsageBatch::validate`]) so that their sort
    /// order is identical in every language. Values are arbitrary UTF-8.
    #[serde(default)]
    pub attributes: BTreeMap<String, String>,
}

impl UsageEvent {
    /// Builds an event with no project and no attributes.
    pub fn new(
        external_id: impl Into<String>,
        organization_id: Uuid,
        dimension: UsageDimension,
        quantity: f64,
        occurred_at: i64,
    ) -> Self {
        Self {
            external_id: external_id.into(),
            organization_id,
            project_id: None,
            charged_externally: None,
            dimension,
            quantity,
            occurred_at,
            attributes: BTreeMap::new(),
        }
    }

    /// Attributes the event to a project.
    #[must_use]
    pub fn with_project(mut self, project_id: Uuid) -> Self {
        self.project_id = Some(project_id);
        self
    }

    /// Records whether the usage was paid outside SproutOS.
    #[must_use]
    pub fn with_charged_externally(mut self, charged_externally: bool) -> Self {
        self.charged_externally = Some(charged_externally);
        self
    }

    /// Adds one attribute, replacing any previous value for that key.
    #[must_use]
    pub fn with_attribute(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.attributes.insert(key.into(), value.into());
        self
    }
}

/// A signed shipment of events from one emitter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageBatch {
    /// Which emitter produced this batch, e.g. `metering-agent` or `pg-proxy`.
    pub source: String,
    /// The events. May be empty; an empty batch is a well-formed heartbeat.
    #[serde(default)]
    pub events: Vec<UsageEvent>,
}

impl UsageBatch {
    /// Builds a batch.
    pub fn new(source: impl Into<String>, events: Vec<UsageEvent>) -> Self {
        Self {
            source: source.into(),
            events,
        }
    }

    /// Checks everything that would make this batch unsafe to bill.
    ///
    /// Ingest must call this *after* verifying the signature and before writing to the ledger. A
    /// valid signature only proves the batch came from an emitter that holds the key; it says
    /// nothing about whether the emitter had a bug.
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.source.is_empty() {
            return Err(ValidationError::EmptySource);
        }
        for (index, event) in self.events.iter().enumerate() {
            if event.external_id.is_empty() {
                return Err(ValidationError::EmptyExternalId { index });
            }
            if !event.quantity.is_finite() {
                return Err(ValidationError::NonFiniteQuantity { index });
            }
            if event.quantity < 0.0 {
                return Err(ValidationError::NegativeQuantity {
                    index,
                    quantity: event.quantity,
                });
            }
            for key in event.attributes.keys() {
                if key.is_empty() {
                    return Err(ValidationError::EmptyAttributeKey { index });
                }
                if let Some(ch) = key.chars().find(|ch| !is_attribute_key_char(*ch)) {
                    return Err(ValidationError::IllegalAttributeKey {
                        index,
                        key: key.clone(),
                        ch,
                    });
                }
            }
        }
        Ok(())
    }
}

/// Why a batch must not be billed.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ValidationError {
    /// The batch does not say which emitter produced it.
    #[error("the batch source is empty")]
    EmptySource,

    /// An event has no idempotency key, so it cannot be deduplicated.
    #[error("event {index} has an empty external_id")]
    EmptyExternalId {
        /// Index of the offending event.
        index: usize,
    },

    /// An event's quantity is NaN or infinite.
    #[error("event {index} has a non-finite quantity")]
    NonFiniteQuantity {
        /// Index of the offending event.
        index: usize,
    },

    /// An event's quantity is negative.
    #[error("event {index} has a negative quantity: {quantity}")]
    NegativeQuantity {
        /// Index of the offending event.
        index: usize,
        /// The quantity as submitted.
        quantity: f64,
    },

    /// An event carries an attribute with an empty key.
    #[error("event {index} has an attribute with an empty key")]
    EmptyAttributeKey {
        /// Index of the offending event.
        index: usize,
    },

    /// An attribute key uses a character outside `[a-z0-9._-]`.
    #[error("event {index} has the attribute key `{key}` containing the illegal character {ch:?}")]
    IllegalAttributeKey {
        /// Index of the offending event.
        index: usize,
        /// The offending key.
        key: String,
        /// The first offending character.
        ch: char,
    },
}

fn is_attribute_key_char(ch: char) -> bool {
    ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-')
}

/// The exact bytes that [`sign`] covers.
///
/// The form is `<domain>\n<json>`, where the JSON is deterministic: object keys are written in
/// ascending order, there is no insignificant whitespace, every optional field is present (as
/// `null` when absent), and `quantity` is written as the 16 lowercase hex digits of its IEEE-754
/// big-endian bit pattern.
///
/// The float encoding is the load-bearing part. `1e21`, `0.0078125` and `1e-7` all have different
/// shortest-decimal spellings in Rust and JavaScript, and a decimal round trip can lose the last
/// bit outright. Signing the bits means the two implementations cannot disagree, and a quantity
/// that was altered anywhere in flight fails verification instead of silently rebilling.
///
/// This is not the wire format. The wire format is ordinary JSON produced by serde, in which
/// `quantity` is a number; a verifier parses that, rebuilds this canonical form from the parsed
/// values, and checks the signature against it.
pub fn canonical(batch: &UsageBatch) -> String {
    let mut out = String::with_capacity(128 + batch.events.len() * 256);
    out.push_str(CANONICAL_DOMAIN);
    out.push('\n');
    out.push_str("{\"events\":[");
    for (index, event) in batch.events.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_event(&mut out, event);
    }
    out.push_str("],\"source\":");
    write_json_string(&mut out, &batch.source);
    out.push('}');
    out
}

fn write_event(out: &mut String, event: &UsageEvent) {
    out.push_str("{\"attributes\":{");
    for (index, (key, value)) in event.attributes.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_json_string(out, key);
        out.push(':');
        write_json_string(out, value);
    }
    out.push('}');
    if let Some(charged_externally) = event.charged_externally {
        out.push_str(",\"charged_externally\":");
        out.push_str(if charged_externally { "true" } else { "false" });
    }
    out.push_str(",\"dimension\":");
    write_json_string(out, event.dimension.as_str());
    out.push_str(",\"external_id\":");
    write_json_string(out, &event.external_id);
    out.push_str(",\"occurred_at\":");
    out.push_str(&event.occurred_at.to_string());
    out.push_str(",\"organization_id\":");
    write_json_string(out, &event.organization_id.to_string());
    out.push_str(",\"project_id\":");
    match event.project_id {
        Some(project_id) => write_json_string(out, &project_id.to_string()),
        None => out.push_str("null"),
    }
    out.push_str(",\"quantity\":");
    write_json_string(out, &hex::encode(event.quantity.to_be_bytes()));
    out.push('}');
}

/// Writes `value` as a JSON string literal, escaping exactly what JSON requires and nothing else.
fn write_json_string(out: &mut String, value: &str) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", ch as u32));
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
}

/// Signs a batch, returning a lowercase hex HMAC-SHA256 over [`canonical`].
pub fn sign(batch: &UsageBatch, key: &[u8]) -> String {
    hex::encode(raw_signature(batch, key))
}

/// Checks a signature in constant time with respect to its contents.
///
/// A malformed signature is simply not a match. Exactly one encoding is accepted — 64 lowercase
/// hex digits — so that a signature has a single spelling and a replay cache keyed on the string
/// cannot be walked around by changing its case.
pub fn verify(batch: &UsageBatch, key: &[u8], signature: &str) -> bool {
    if signature.len() != SIGNATURE_LEN * 2
        || !signature
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return false;
    }
    let Ok(provided) = hex::decode(signature) else {
        return false;
    };
    let expected = raw_signature(batch, key);
    expected.ct_eq(provided.as_slice()).into()
}

fn raw_signature(batch: &UsageBatch, key: &[u8]) -> [u8; SIGNATURE_LEN] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts a key of any length");
    mac.update(canonical(batch).as_bytes());
    mac.finalize().into_bytes().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared cross-language contract; see `fixtures/signing-vectors.json`.
    const FIXTURE: &str = include_str!("../fixtures/signing-vectors.json");
    const DIMENSION_FIXTURE: &str = include_str!("../fixtures/billable-dimensions.json");

    const ORG: &str = "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f";

    #[derive(Deserialize)]
    struct Fixture {
        domain: String,
        vectors: Vec<Vector>,
    }

    #[derive(Deserialize)]
    struct Vector {
        name: String,
        key_hex: String,
        batch: UsageBatch,
        canonical: String,
        signature: String,
    }

    #[derive(Deserialize)]
    struct DimensionFixture {
        dimensions: Vec<String>,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(FIXTURE).expect("fixtures/signing-vectors.json is valid JSON")
    }

    fn org() -> Uuid {
        Uuid::parse_str(ORG).unwrap()
    }

    #[test]
    fn fixture_domain_matches() {
        let fixture = fixture();
        assert_eq!(fixture.domain, CANONICAL_DOMAIN);
        assert!(
            fixture.vectors.len() >= 3,
            "the contract needs at least 3 golden vectors"
        );
    }

    #[test]
    fn golden_vectors_canonicalize_identically() {
        for vector in fixture().vectors {
            assert_eq!(
                canonical(&vector.batch),
                vector.canonical,
                "vector `{}`",
                vector.name
            );
        }
    }

    #[test]
    fn golden_vectors_sign_identically() {
        for vector in fixture().vectors {
            let key = hex::decode(&vector.key_hex).expect("key_hex is hex");
            assert_eq!(
                sign(&vector.batch, &key),
                vector.signature,
                "vector `{}`",
                vector.name
            );
            assert!(
                verify(&vector.batch, &key, &vector.signature),
                "vector `{}`",
                vector.name
            );
        }
    }

    #[test]
    fn golden_vectors_reject_a_tampered_quantity() {
        for mut vector in fixture().vectors {
            let key = hex::decode(&vector.key_hex).expect("key_hex is hex");
            let Some(event) = vector.batch.events.first_mut() else {
                continue;
            };
            event.quantity = f64::from_bits(event.quantity.to_bits() + 1);
            assert!(
                !verify(&vector.batch, &key, &vector.signature),
                "vector `{}` accepted a one-bit change to a billed quantity",
                vector.name
            );
        }
    }

    #[test]
    fn golden_vectors_reject_the_wrong_key() {
        for vector in fixture().vectors {
            assert!(
                !verify(&vector.batch, b"not the key", &vector.signature),
                "{}",
                vector.name
            );
        }
    }

    #[test]
    fn golden_vector_batches_survive_the_wire_format() {
        for vector in fixture().vectors {
            let wire = serde_json::to_string(&vector.batch).unwrap();
            let parsed: UsageBatch = serde_json::from_str(&wire).unwrap();
            assert_eq!(parsed, vector.batch, "vector `{}`", vector.name);
            assert_eq!(
                canonical(&parsed),
                vector.canonical,
                "vector `{}`",
                vector.name
            );
        }
    }

    #[test]
    fn golden_vectors_validate() {
        for vector in fixture().vectors {
            vector
                .batch
                .validate()
                .unwrap_or_else(|e| panic!("vector `{}`: {e}", vector.name));
        }
    }

    #[test]
    fn dimension_wire_names_match_serde() {
        for dimension in UsageDimension::ALL {
            let json = serde_json::to_string(dimension).unwrap();
            assert_eq!(json, format!("\"{}\"", dimension.as_str()));
            assert_eq!(
                dimension.as_str().parse::<UsageDimension>().unwrap(),
                *dimension
            );
            assert_eq!(dimension.to_string(), dimension.as_str());
        }
    }

    #[test]
    fn dimensions_exactly_match_the_shared_contract() {
        let fixture: DimensionFixture = serde_json::from_str(DIMENSION_FIXTURE)
            .expect("fixtures/billable-dimensions.json is valid JSON");
        let actual: Vec<&str> = UsageDimension::ALL
            .iter()
            .map(UsageDimension::as_str)
            .collect();

        assert_eq!(actual, fixture.dimensions);
        let unique: std::collections::BTreeSet<_> = actual.iter().copied().collect();
        assert_eq!(unique.len(), actual.len(), "dimension names must be unique");
    }

    #[test]
    fn dimension_names_are_the_documented_ones() {
        assert_eq!(UsageDimension::SiteGibSecond.as_str(), "site_gib_second");
        assert_eq!(
            UsageDimension::ValkeyQueueByteSecond.as_str(),
            "valkey_queue_byte_second"
        );
        assert_eq!(
            UsageDimension::AiCacheReadToken.as_str(),
            "ai_cache_read_token"
        );
        assert_eq!(
            "db_storage_gib_hour".parse(),
            Ok(UsageDimension::DbStorageGibHour)
        );
        assert_eq!(
            "site_cpu_second".parse::<UsageDimension>(),
            Err(UnknownDimension("site_cpu_second".to_owned()))
        );
    }

    #[test]
    fn canonical_form_is_order_independent() {
        let ascending = UsageEvent::new("k", org(), UsageDimension::EsSearchUnit, 1.0, 1)
            .with_attribute("a", "1")
            .with_attribute("b", "2")
            .with_attribute("c", "3");
        let descending = UsageEvent::new("k", org(), UsageDimension::EsSearchUnit, 1.0, 1)
            .with_attribute("c", "3")
            .with_attribute("b", "2")
            .with_attribute("a", "1");
        let key = b"key";
        assert_eq!(
            canonical(&UsageBatch::new("s", vec![ascending.clone()])),
            canonical(&UsageBatch::new("s", vec![descending.clone()]))
        );
        assert_eq!(
            sign(&UsageBatch::new("s", vec![ascending]), key),
            sign(&UsageBatch::new("s", vec![descending]), key)
        );
    }

    #[test]
    fn canonical_form_is_stable_across_runs() {
        let batch = UsageBatch::new(
            "pg-proxy",
            vec![UsageEvent::new(
                "k",
                org(),
                UsageDimension::DbComputeCuSecond,
                0.25,
                7,
            )],
        );
        let once = canonical(&batch);
        for _ in 0..16 {
            assert_eq!(canonical(&batch), once);
        }
    }

    #[test]
    fn event_order_is_significant() {
        let first = UsageEvent::new("a", org(), UsageDimension::EsSearchUnit, 1.0, 1);
        let second = UsageEvent::new("b", org(), UsageDimension::EsSearchUnit, 1.0, 1);
        let key = b"key";
        let forward = UsageBatch::new("s", vec![first.clone(), second.clone()]);
        let reverse = UsageBatch::new("s", vec![second, first]);
        assert_ne!(sign(&forward, key), sign(&reverse, key));
    }

    #[test]
    fn quantities_that_share_a_decimal_spelling_sign_differently() {
        let key = b"key";
        let batch = |quantity: f64| {
            UsageBatch::new(
                "metering-agent",
                vec![UsageEvent::new(
                    "k",
                    org(),
                    UsageDimension::SiteGibSecond,
                    quantity,
                    1,
                )],
            )
        };
        let nudged = f64::from_bits(0.1f64.to_bits() + 1);
        assert_ne!(0.1, nudged);
        assert_ne!(sign(&batch(0.1), key), sign(&batch(nudged), key));
        assert_eq!(sign(&batch(0.1), key), sign(&batch(0.1), key));
    }

    #[test]
    fn json_string_escaping_is_minimal_and_complete() {
        let mut out = String::new();
        write_json_string(&mut out, "quote\" back\\slash\nnewline\ttab\u{1}ctl é 😀");
        assert_eq!(
            out,
            "\"quote\\\" back\\\\slash\\nnewline\\ttab\\u0001ctl é 😀\""
        );
    }

    #[test]
    fn empty_batch_still_signs() {
        let batch = UsageBatch::new("metering-agent", Vec::new());
        assert_eq!(
            canonical(&batch),
            format!("{CANONICAL_DOMAIN}\n{{\"events\":[],\"source\":\"metering-agent\"}}")
        );
        assert!(verify(&batch, b"key", &sign(&batch, b"key")));
    }

    #[test]
    fn verify_rejects_malformed_signatures() {
        let batch = UsageBatch::new("metering-agent", Vec::new());
        let good = sign(&batch, b"key");
        assert!(verify(&batch, b"key", &good));
        assert!(!verify(&batch, b"key", ""));
        assert!(!verify(&batch, b"key", "zz"));
        assert!(!verify(&batch, b"key", &good[..62]));
        assert!(!verify(&batch, b"key", &format!("{good}00")));
        assert!(!verify(&batch, b"key", &good.to_uppercase()));
        let mut flipped: Vec<u8> = hex::decode(&good).unwrap();
        flipped[0] ^= 1;
        assert!(!verify(&batch, b"key", &hex::encode(flipped)));
    }

    #[test]
    fn signature_is_lowercase_hex_of_the_right_length() {
        let batch = UsageBatch::new("metering-agent", Vec::new());
        let signature = sign(&batch, b"key");
        assert_eq!(signature.len(), SIGNATURE_LEN * 2);
        assert!(
            signature
                .chars()
                .all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch))
        );
    }

    #[test]
    fn domain_separation_changes_the_signature() {
        let batch = UsageBatch::new("metering-agent", Vec::new());
        let mut mac = Hmac::<Sha256>::new_from_slice(b"key").unwrap();
        let undomained = canonical(&batch).replace(&format!("{CANONICAL_DOMAIN}\n"), "");
        mac.update(undomained.as_bytes());
        assert_ne!(
            hex::encode(mac.finalize().into_bytes()),
            sign(&batch, b"key")
        );
    }

    #[test]
    fn validate_rejects_unbillable_batches() {
        let good = |quantity: f64| {
            UsageBatch::new(
                "metering-agent",
                vec![UsageEvent::new(
                    "k",
                    org(),
                    UsageDimension::SiteRequest,
                    quantity,
                    1,
                )],
            )
        };
        assert_eq!(
            good(f64::NAN).validate(),
            Err(ValidationError::NonFiniteQuantity { index: 0 })
        );
        assert_eq!(
            good(f64::INFINITY).validate(),
            Err(ValidationError::NonFiniteQuantity { index: 0 })
        );
        assert_eq!(
            good(-1.0).validate(),
            Err(ValidationError::NegativeQuantity {
                index: 0,
                quantity: -1.0
            })
        );
        assert!(good(0.0).validate().is_ok());

        let mut batch = good(1.0);
        batch.source = String::new();
        assert_eq!(batch.validate(), Err(ValidationError::EmptySource));

        let mut batch = good(1.0);
        batch.events[0].external_id = String::new();
        assert_eq!(
            batch.validate(),
            Err(ValidationError::EmptyExternalId { index: 0 })
        );

        let mut batch = good(1.0);
        batch.events[0]
            .attributes
            .insert("Region".to_owned(), "iad".to_owned());
        assert_eq!(
            batch.validate(),
            Err(ValidationError::IllegalAttributeKey {
                index: 0,
                key: "Region".to_owned(),
                ch: 'R'
            })
        );

        let mut batch = good(1.0);
        batch.events[0]
            .attributes
            .insert(String::new(), "iad".to_owned());
        assert_eq!(
            batch.validate(),
            Err(ValidationError::EmptyAttributeKey { index: 0 })
        );
    }

    #[test]
    fn attribute_keys_match_the_shared_cross_language_vectors() {
        #[derive(serde::Deserialize)]
        struct Vectors {
            valid: Vec<String>,
            invalid: Vec<String>,
        }

        let vectors: Vectors =
            serde_json::from_str(include_str!("../fixtures/attribute-key-vectors.json")).unwrap();
        let batch = |key: &str| {
            let event = UsageEvent::new("k", org(), UsageDimension::SiteRequest, 1.0, 1)
                .with_attribute(key, "value");
            UsageBatch::new("metering-agent", vec![event])
        };

        for key in vectors.valid {
            assert!(
                batch(&key).validate().is_ok(),
                "valid key rejected: {key:?}"
            );
        }
        for key in vectors.invalid {
            assert!(
                batch(&key).validate().is_err(),
                "invalid key accepted: {key:?}"
            );
        }
    }

    #[test]
    fn builders_populate_optional_fields() {
        let project = Uuid::parse_str("01912d41-0000-7000-8000-0000000000b1").unwrap();
        let event = UsageEvent::new("k", org(), UsageDimension::SiteRequest, 1.0, 5)
            .with_project(project)
            .with_charged_externally(true)
            .with_attribute("site", "blog")
            .with_attribute("site", "shop");
        assert_eq!(event.project_id, Some(project));
        assert_eq!(event.charged_externally, Some(true));
        assert_eq!(
            event.attributes.get("site").map(String::as_str),
            Some("shop")
        );
    }

    #[test]
    fn absent_optional_fields_deserialize() {
        let wire = format!(
            r#"{{"source":"pg-proxy","events":[{{"external_id":"k","organization_id":"{ORG}","dimension":"db_compute_cu_second","quantity":30.0,"occurred_at":1723459200000}}]}}"#
        );
        let batch: UsageBatch = serde_json::from_str(&wire).unwrap();
        assert_eq!(batch.events[0].project_id, None);
        assert_eq!(batch.events[0].charged_externally, None);
        assert!(batch.events[0].attributes.is_empty());
    }

    #[test]
    fn legacy_and_explicit_billing_shapes_have_distinct_stable_signatures() {
        let legacy = UsageEvent::new("k", org(), UsageDimension::AiInputToken, 1.0, 1);
        let external = legacy.clone().with_charged_externally(true);
        let platform = legacy.clone().with_charged_externally(false);

        let legacy = UsageBatch::new("llm-proxy", vec![legacy]);
        let external = UsageBatch::new("llm-proxy", vec![external]);
        let platform = UsageBatch::new("llm-proxy", vec![platform]);

        assert!(!canonical(&legacy).contains("charged_externally"));
        assert!(canonical(&external).contains("\"charged_externally\":true"));
        assert!(canonical(&platform).contains("\"charged_externally\":false"));
        assert_ne!(sign(&legacy, b"key"), sign(&external, b"key"));
        assert_ne!(sign(&external, b"key"), sign(&platform, b"key"));
    }
}
