//! SproutOS Resource Names (SRNs): the authorization resource grammar.
//!
//! An SRN names exactly one thing a policy can talk about:
//!
//! ```text
//! srn:sproutos:<service>:<org_id>:<type>/<id>
//! ```
//!
//! [`Srn`] is a *concrete* name. [`SrnPattern`] is the same grammar read as a *pattern*: any
//! segment may be the literal `*`, and [`SrnPattern::matches`] decides whether a pattern covers a
//! target.
//!
//! ```
//! use sproutos_srn::{Srn, SrnPattern};
//!
//! let target: Srn = "srn:sproutos:db:01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f:database/main"
//!     .parse()
//!     .unwrap();
//! let pattern: SrnPattern = "srn:sproutos:db:*:database/*".parse().unwrap();
//! assert!(pattern.matches(&target));
//! ```
//!
//! # Grammar
//!
//! ```text
//! srn      = "srn:sproutos:" service ":" org ":" resource
//! service  = token
//! org      = token                       ; a UUIDv7 in practice, or "*"
//! resource = "*" / type "/" id
//! type     = token
//! id       = token
//! token    = "*" / 1*( %x61-7A / %x30-39 / "." / "_" / "-" )   ; lowercase only
//! ```
//!
//! The grammar is deliberately narrow. Uppercase is rejected outright so that two spellings of the
//! same name can never disagree about who they authorize, and `*` is only ever a whole segment, so
//! a pattern like `database/prod-*` fails loudly instead of silently matching nothing.
//!
//! # Cross-language contract
//!
//! `fixtures/srn-cases.json` is the shared contract with the TypeScript implementation. The tests
//! in this crate are driven from it; see `README.md`.

use std::fmt;
use std::str::FromStr;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use uuid::Uuid;

/// Every SRN starts with this literal.
pub const SRN_PREFIX: &str = "srn:sproutos:";

/// The segment that means "any".
pub const WILDCARD: &str = "*";

/// Longest SRN the parser will look at, in bytes.
///
/// Real SRNs are well under 150 bytes; the cap only exists so that untrusted input cannot make the
/// parser walk an unbounded string.
pub const MAX_SRN_LEN: usize = 512;

/// Which part of an SRN an error refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SegmentKind {
    /// The `<service>` segment.
    Service,
    /// The `<org_id>` segment.
    Organization,
    /// The whole `<type>/<id>` segment.
    Resource,
    /// The `<type>` half of the resource segment.
    ResourceType,
    /// The `<id>` half of the resource segment.
    ResourceId,
}

impl fmt::Display for SegmentKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Service => "service",
            Self::Organization => "organization",
            Self::Resource => "resource",
            Self::ResourceType => "resource type",
            Self::ResourceId => "resource id",
        };
        f.write_str(name)
    }
}

/// Why a string is not an SRN.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ParseError {
    /// The input is longer than [`MAX_SRN_LEN`].
    #[error("SRN is {len} bytes, which exceeds the {max} byte limit")]
    TooLong {
        /// Length of the offending input, in bytes.
        len: usize,
        /// The limit that was exceeded.
        max: usize,
    },

    /// The input does not start with `srn:sproutos:`.
    #[error("SRN must start with `{SRN_PREFIX}`")]
    WrongPrefix,

    /// The input does not have exactly five `:`-separated segments.
    #[error("SRN must have exactly 5 `:`-separated segments, found {found}")]
    SegmentCount {
        /// How many segments the input actually had.
        found: usize,
    },

    /// A segment was present but empty.
    #[error("the {segment} segment is empty")]
    EmptySegment {
        /// The segment that was empty.
        segment: SegmentKind,
    },

    /// A segment contained a character outside the token alphabet.
    #[error("the {segment} segment contains the illegal character {ch:?}")]
    IllegalCharacter {
        /// The segment that contained the character.
        segment: SegmentKind,
        /// The first offending character.
        ch: char,
    },

    /// The resource segment was neither `*` nor exactly one `<type>/<id>` pair.
    #[error("the resource segment must be `<type>/<id>` or `*`, found `{found}`")]
    MalformedResource {
        /// The resource segment as written.
        found: String,
    },
}

/// The `<type>/<id>` tail of an SRN.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Resource {
    /// The bare `*` resource: any type, any id.
    Any,
    /// A `<type>/<id>` pair. Either half may itself be `*`.
    Typed {
        /// The resource type, e.g. `database`.
        resource_type: String,
        /// The resource id, e.g. a UUIDv7 or a slug.
        id: String,
    },
}

impl Resource {
    /// Builds a `<type>/<id>` resource without checking the alphabet.
    ///
    /// Validation happens when the resource is placed into an [`Srn`], which is the only type that
    /// promises its string form round-trips.
    pub fn typed(resource_type: impl Into<String>, id: impl Into<String>) -> Self {
        Self::Typed {
            resource_type: resource_type.into(),
            id: id.into(),
        }
    }

    /// The resource type, or `None` for the bare `*` resource.
    pub fn resource_type(&self) -> Option<&str> {
        match self {
            Self::Any => None,
            Self::Typed { resource_type, .. } => Some(resource_type),
        }
    }

    /// The resource id, or `None` for the bare `*` resource.
    pub fn id(&self) -> Option<&str> {
        match self {
            Self::Any => None,
            Self::Typed { id, .. } => Some(id),
        }
    }

    /// Whether any part of this resource is a wildcard.
    pub fn contains_wildcard(&self) -> bool {
        match self {
            Self::Any => true,
            Self::Typed { resource_type, id } => resource_type == WILDCARD || id == WILDCARD,
        }
    }

    fn parse(raw: &str) -> Result<Self, ParseError> {
        if raw.is_empty() {
            return Err(ParseError::EmptySegment {
                segment: SegmentKind::Resource,
            });
        }
        if raw == WILDCARD {
            return Ok(Self::Any);
        }

        let mut halves = raw.split('/');
        let resource_type = halves.next().unwrap_or_default();
        let Some(id) = halves.next() else {
            return Err(ParseError::MalformedResource {
                found: raw.to_owned(),
            });
        };
        if halves.next().is_some() {
            return Err(ParseError::MalformedResource {
                found: raw.to_owned(),
            });
        }

        validate_segment(resource_type, SegmentKind::ResourceType)?;
        validate_segment(id, SegmentKind::ResourceId)?;
        Ok(Self::typed(resource_type, id))
    }

    fn validate(&self) -> Result<(), ParseError> {
        match self {
            Self::Any => Ok(()),
            Self::Typed { resource_type, id } => {
                validate_segment(resource_type, SegmentKind::ResourceType)?;
                validate_segment(id, SegmentKind::ResourceId)
            }
        }
    }
}

impl fmt::Display for Resource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Any => f.write_str(WILDCARD),
            Self::Typed { resource_type, id } => write!(f, "{resource_type}/{id}"),
        }
    }
}

/// A parsed SproutOS Resource Name.
///
/// Every `Srn` that exists is well-formed: [`Display`](fmt::Display) round-trips back through
/// [`FromStr`] to an equal value.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Srn {
    service: String,
    organization_id: String,
    resource: Resource,
}

impl Srn {
    /// Builds an SRN from its parts, validating each segment.
    pub fn new(
        service: impl Into<String>,
        organization_id: impl Into<String>,
        resource: Resource,
    ) -> Result<Self, ParseError> {
        let service = service.into();
        let organization_id = organization_id.into();
        validate_segment(&service, SegmentKind::Service)?;
        validate_segment(&organization_id, SegmentKind::Organization)?;
        resource.validate()?;
        Ok(Self {
            service,
            organization_id,
            resource,
        })
    }

    /// Builds an SRN naming one concrete `<type>/<id>` resource.
    pub fn typed(
        service: impl Into<String>,
        organization_id: impl Into<String>,
        resource_type: impl Into<String>,
        id: impl Into<String>,
    ) -> Result<Self, ParseError> {
        Self::new(service, organization_id, Resource::typed(resource_type, id))
    }

    /// Builds an SRN for a resource owned by a known organization.
    ///
    /// This is the constructor to reach for from Rust code that already holds UUIDs, since it
    /// cannot produce an organization segment that fails to parse.
    pub fn for_organization(
        service: impl Into<String>,
        organization_id: Uuid,
        resource_type: impl Into<String>,
        id: impl Into<String>,
    ) -> Result<Self, ParseError> {
        Self::typed(service, organization_id.to_string(), resource_type, id)
    }

    /// The `<service>` segment.
    pub fn service(&self) -> &str {
        &self.service
    }

    /// The `<org_id>` segment, which may be `*`.
    pub fn organization_id(&self) -> &str {
        &self.organization_id
    }

    /// The organization segment as a UUID, or `None` if it is `*` or not a UUID.
    ///
    /// The grammar itself is syntactic: it does not require the organization segment to be a UUID,
    /// because callers that care resolve it against the database anyway.
    pub fn organization_uuid(&self) -> Option<Uuid> {
        Uuid::parse_str(&self.organization_id).ok()
    }

    /// The `<type>/<id>` segment.
    pub fn resource(&self) -> &Resource {
        &self.resource
    }

    /// The resource type, or `None` when the resource segment is the bare `*`.
    pub fn resource_type(&self) -> Option<&str> {
        self.resource.resource_type()
    }

    /// The resource id, or `None` when the resource segment is the bare `*`.
    pub fn resource_id(&self) -> Option<&str> {
        self.resource.id()
    }

    /// Whether any segment of this SRN is a wildcard.
    ///
    /// A name that reaches an authorization decision as a *target* should normally have none:
    /// wildcards in a target are matched literally, never expanded.
    pub fn contains_wildcard(&self) -> bool {
        self.service == WILDCARD
            || self.organization_id == WILDCARD
            || self.resource.contains_wildcard()
    }

    /// Reads this name as a pattern.
    pub fn into_pattern(self) -> SrnPattern {
        SrnPattern(self)
    }
}

impl fmt::Display for Srn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{SRN_PREFIX}{}:{}:{}",
            self.service, self.organization_id, self.resource
        )
    }
}

impl FromStr for Srn {
    type Err = ParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if s.len() > MAX_SRN_LEN {
            return Err(ParseError::TooLong {
                len: s.len(),
                max: MAX_SRN_LEN,
            });
        }

        let segments: Vec<&str> = s.split(':').collect();
        if segments.len() != 5 {
            return Err(ParseError::SegmentCount {
                found: segments.len(),
            });
        }
        if segments[0] != "srn" || segments[1] != "sproutos" {
            return Err(ParseError::WrongPrefix);
        }

        validate_segment(segments[2], SegmentKind::Service)?;
        validate_segment(segments[3], SegmentKind::Organization)?;
        let resource = Resource::parse(segments[4])?;

        Ok(Self {
            service: segments[2].to_owned(),
            organization_id: segments[3].to_owned(),
            resource,
        })
    }
}

impl Serialize for Srn {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Srn {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        raw.parse().map_err(D::Error::custom)
    }
}

/// An SRN read as a matching pattern.
///
/// Matching is segment-wise. A `*` segment in the pattern matches exactly one segment of the
/// target, and the bare `*` resource matches any `<type>/<id>` pair. Everything else is compared
/// for equality, so a `*` appearing in the *target* is a literal character and widens nothing.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SrnPattern(Srn);

impl SrnPattern {
    /// Whether this pattern covers `target`.
    pub fn matches(&self, target: &Srn) -> bool {
        if !segment_matches(&self.0.service, &target.service) {
            return false;
        }
        if !segment_matches(&self.0.organization_id, &target.organization_id) {
            return false;
        }
        match (&self.0.resource, &target.resource) {
            (Resource::Any, _) => true,
            (Resource::Typed { .. }, Resource::Any) => false,
            (
                Resource::Typed {
                    resource_type: pattern_type,
                    id: pattern_id,
                },
                Resource::Typed {
                    resource_type: target_type,
                    id: target_id,
                },
            ) => {
                segment_matches(pattern_type, target_type) && segment_matches(pattern_id, target_id)
            }
        }
    }

    /// Whether any pattern in `patterns` covers `target`.
    pub fn any_match<'a>(patterns: impl IntoIterator<Item = &'a SrnPattern>, target: &Srn) -> bool {
        patterns.into_iter().any(|pattern| pattern.matches(target))
    }

    /// The underlying name.
    pub fn as_srn(&self) -> &Srn {
        &self.0
    }

    /// Unwraps the underlying name.
    pub fn into_srn(self) -> Srn {
        self.0
    }
}

impl From<Srn> for SrnPattern {
    fn from(srn: Srn) -> Self {
        Self(srn)
    }
}

impl fmt::Display for SrnPattern {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl FromStr for SrnPattern {
    type Err = ParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse::<Srn>().map(Self)
    }
}

impl Serialize for SrnPattern {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for SrnPattern {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Srn::deserialize(deserializer).map(Self)
    }
}

fn segment_matches(pattern: &str, target: &str) -> bool {
    pattern == WILDCARD || pattern == target
}

fn is_token_char(ch: char) -> bool {
    ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-')
}

fn validate_segment(segment: &str, kind: SegmentKind) -> Result<(), ParseError> {
    if segment.is_empty() {
        return Err(ParseError::EmptySegment { segment: kind });
    }
    if segment == WILDCARD {
        return Ok(());
    }
    match segment.chars().find(|ch| !is_token_char(*ch)) {
        Some(ch) => Err(ParseError::IllegalCharacter { segment: kind, ch }),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG_A: &str = "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f";

    /// The shared cross-language contract; see `fixtures/srn-cases.json`.
    const FIXTURE: &str = include_str!("../fixtures/srn-cases.json");

    #[derive(Deserialize)]
    struct Fixture {
        cases: Vec<Case>,
        invalid: Vec<String>,
    }

    #[derive(Deserialize)]
    struct Case {
        pattern: String,
        target: String,
        matches: bool,
        note: String,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(FIXTURE).expect("fixtures/srn-cases.json is valid JSON")
    }

    #[test]
    fn fixture_is_substantial() {
        let fixture = fixture();
        assert!(
            fixture.cases.len() >= 40,
            "the contract needs at least 40 matching cases"
        );
        assert!(!fixture.invalid.is_empty());
    }

    #[test]
    fn fixture_matching_cases() {
        for case in fixture().cases {
            let pattern: SrnPattern = case
                .pattern
                .parse()
                .unwrap_or_else(|e| panic!("{}: {e}", case.pattern));
            let target: Srn = case
                .target
                .parse()
                .unwrap_or_else(|e| panic!("{}: {e}", case.target));
            assert_eq!(
                pattern.matches(&target),
                case.matches,
                "`{}` vs `{}` ({})",
                case.pattern,
                case.target,
                case.note
            );
        }
    }

    #[test]
    fn fixture_cases_round_trip() {
        for case in fixture().cases {
            for raw in [case.pattern, case.target] {
                let parsed: Srn = raw.parse().unwrap_or_else(|e| panic!("{raw}: {e}"));
                assert_eq!(parsed.to_string(), raw, "Display must round-trip");
                assert_eq!(
                    raw.parse::<Srn>().unwrap(),
                    parsed,
                    "FromStr must be stable"
                );
            }
        }
    }

    #[test]
    fn fixture_invalid_inputs_are_rejected() {
        for raw in fixture().invalid {
            assert!(
                raw.parse::<Srn>().is_err(),
                "`{raw}` must not parse as an SRN"
            );
            assert!(
                raw.parse::<SrnPattern>().is_err(),
                "`{raw}` must not parse as a pattern"
            );
        }
    }

    #[test]
    fn fixture_serde_round_trip() {
        for case in fixture().cases {
            let json = serde_json::to_string(&case.target.parse::<Srn>().unwrap()).unwrap();
            assert_eq!(json, format!("\"{}\"", case.target));
            let back: Srn = serde_json::from_str(&json).unwrap();
            assert_eq!(back.to_string(), case.target);

            let pattern: SrnPattern = serde_json::from_str(&format!("\"{}\"", case.pattern))
                .expect("patterns deserialize from their string form");
            assert_eq!(
                serde_json::to_string(&pattern).unwrap(),
                format!("\"{}\"", case.pattern)
            );
        }
    }

    #[test]
    fn serde_rejects_malformed_strings() {
        let err = serde_json::from_str::<Srn>("\"not-an-srn\"").unwrap_err();
        assert!(err.to_string().contains("exactly 5"), "{err}");

        let err = serde_json::from_str::<Srn>("\"aws:sproutos:db:*:database/main\"").unwrap_err();
        assert!(err.to_string().contains("srn:sproutos:"), "{err}");
    }

    #[test]
    fn serde_rejects_non_strings() {
        assert!(serde_json::from_str::<Srn>("42").is_err());
    }

    #[test]
    fn accessors_expose_every_segment() {
        let srn: Srn = format!("srn:sproutos:db:{ORG_A}:database/main")
            .parse()
            .unwrap();
        assert_eq!(srn.service(), "db");
        assert_eq!(srn.organization_id(), ORG_A);
        assert_eq!(srn.resource_type(), Some("database"));
        assert_eq!(srn.resource_id(), Some("main"));
        assert_eq!(
            srn.organization_uuid(),
            Some(Uuid::parse_str(ORG_A).unwrap())
        );
        assert!(!srn.contains_wildcard());
    }

    #[test]
    fn bare_star_resource_has_no_type_or_id() {
        let srn: Srn = format!("srn:sproutos:db:{ORG_A}:*").parse().unwrap();
        assert_eq!(srn.resource(), &Resource::Any);
        assert_eq!(srn.resource_type(), None);
        assert_eq!(srn.resource_id(), None);
        assert!(srn.contains_wildcard());
    }

    #[test]
    fn wildcard_organization_has_no_uuid() {
        let srn: Srn = "srn:sproutos:db:*:database/main".parse().unwrap();
        assert_eq!(srn.organization_uuid(), None);
        assert!(srn.contains_wildcard());
    }

    #[test]
    fn constructors_validate_and_match_the_parser() {
        let org = Uuid::parse_str(ORG_A).unwrap();
        let built = Srn::for_organization("db", org, "database", "main").unwrap();
        let parsed: Srn = format!("srn:sproutos:db:{ORG_A}:database/main")
            .parse()
            .unwrap();
        assert_eq!(built, parsed);

        let any = Srn::new("db", ORG_A, Resource::Any).unwrap();
        assert_eq!(any.to_string(), format!("srn:sproutos:db:{ORG_A}:*"));
    }

    #[test]
    fn constructors_reject_segments_that_would_not_round_trip() {
        assert_eq!(
            Srn::typed("db", ORG_A, "data:base", "main").unwrap_err(),
            ParseError::IllegalCharacter {
                segment: SegmentKind::ResourceType,
                ch: ':'
            }
        );
        assert_eq!(
            Srn::typed("db", ORG_A, "database", "ma/in").unwrap_err(),
            ParseError::IllegalCharacter {
                segment: SegmentKind::ResourceId,
                ch: '/'
            }
        );
        assert_eq!(
            Srn::typed("", ORG_A, "database", "main").unwrap_err(),
            ParseError::EmptySegment {
                segment: SegmentKind::Service
            }
        );
    }

    #[test]
    fn parse_error_variants_are_precise() {
        assert_eq!(
            "srn:sproutos:db".parse::<Srn>().unwrap_err(),
            ParseError::SegmentCount { found: 3 }
        );
        assert_eq!(
            format!("srn:sproutos:db:{ORG_A}:database/main:extra")
                .parse::<Srn>()
                .unwrap_err(),
            ParseError::SegmentCount { found: 6 }
        );
        assert_eq!(
            format!("aws:sproutos:db:{ORG_A}:database/main")
                .parse::<Srn>()
                .unwrap_err(),
            ParseError::WrongPrefix
        );
        assert_eq!(
            format!("srn:sproutos::{ORG_A}:database/main")
                .parse::<Srn>()
                .unwrap_err(),
            ParseError::EmptySegment {
                segment: SegmentKind::Service
            }
        );
        assert_eq!(
            "srn:sproutos:db::database/main".parse::<Srn>().unwrap_err(),
            ParseError::EmptySegment {
                segment: SegmentKind::Organization
            }
        );
        assert_eq!(
            format!("srn:sproutos:db:{ORG_A}:")
                .parse::<Srn>()
                .unwrap_err(),
            ParseError::EmptySegment {
                segment: SegmentKind::Resource
            }
        );
        assert_eq!(
            format!("srn:sproutos:db:{ORG_A}:database")
                .parse::<Srn>()
                .unwrap_err(),
            ParseError::MalformedResource {
                found: "database".to_owned()
            }
        );
        assert_eq!(
            format!("srn:sproutos:db:{ORG_A}:database/main/extra")
                .parse::<Srn>()
                .unwrap_err(),
            ParseError::MalformedResource {
                found: "database/main/extra".to_owned()
            }
        );
        assert_eq!(
            format!("srn:sproutos:DB:{ORG_A}:database/main")
                .parse::<Srn>()
                .unwrap_err(),
            ParseError::IllegalCharacter {
                segment: SegmentKind::Service,
                ch: 'D'
            }
        );
        assert_eq!(
            format!("srn:sproutos:db:{ORG_A}:database/prod-*")
                .parse::<Srn>()
                .unwrap_err(),
            ParseError::IllegalCharacter {
                segment: SegmentKind::ResourceId,
                ch: '*'
            }
        );
    }

    #[test]
    fn over_long_input_is_rejected_before_parsing() {
        let raw = format!(
            "srn:sproutos:db:{ORG_A}:database/{}",
            "x".repeat(MAX_SRN_LEN)
        );
        let len = raw.len();
        assert_eq!(
            raw.parse::<Srn>().unwrap_err(),
            ParseError::TooLong {
                len,
                max: MAX_SRN_LEN
            }
        );
    }

    #[test]
    fn any_match_scans_a_policy_set() {
        let target: Srn = format!("srn:sproutos:db:{ORG_A}:database/main")
            .parse()
            .unwrap();
        let grants: Vec<SrnPattern> = ["srn:sproutos:store:*:*", "srn:sproutos:db:*:database/*"]
            .iter()
            .map(|raw| raw.parse().unwrap())
            .collect();
        assert!(SrnPattern::any_match(&grants, &target));

        let denials: Vec<SrnPattern> = ["srn:sproutos:store:*:*"]
            .iter()
            .map(|raw| raw.parse().unwrap())
            .collect();
        assert!(!SrnPattern::any_match(&denials, &target));
    }

    #[test]
    fn patterns_display_exactly_as_written() {
        let raw = "srn:sproutos:*:*:*";
        let pattern: SrnPattern = raw.parse().unwrap();
        assert_eq!(pattern.to_string(), raw);
        assert_eq!(pattern.as_srn().service(), WILDCARD);
        assert_eq!(pattern.clone().into_srn().to_string(), raw);
    }
}
