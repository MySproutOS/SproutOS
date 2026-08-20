//! Tenant identification from connection credentials.
//!
//! The Postgres, valkey and search wire protocols hand a proxy exactly two things at connect time:
//! a username and a secret. There is no room for a header, a token or a routing hint. So the
//! username *is* the routing information — it encodes which tenant resource the connection is for
//! and which organization owns it:
//!
//! ```text
//! <kind>_<resource-short-id>.<organization-short-id>
//! db_01j4pm0000e008000000000051.01j4pkz2hbfh6sw7sa7d65tvkz
//! ```
//!
//! ```
//! use sproutos_tenant_auth::{ResourceKind, TenantIdentity};
//! use uuid::Uuid;
//!
//! let identity = TenantIdentity::new(
//!     Uuid::parse_str("01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f").unwrap(),
//!     ResourceKind::Database,
//!     Uuid::parse_str("01912d40-0000-7000-8000-0000000000a1").unwrap(),
//! );
//!
//! let username = identity.username();
//! assert_eq!(username.parse::<TenantIdentity>().unwrap(), identity);
//! assert_eq!(
//!     identity.srn().to_string(),
//!     "srn:sproutos:db:01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f:database/01912d40-0000-7000-8000-0000000000a1"
//! );
//! ```
//!
//! Parsing a username is *identification*, never authentication. It says who the connection claims
//! to be. [`verify_secret`] against the stored Argon2id hash is what makes the claim true.

use std::fmt;
use std::str::FromStr;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use sproutos_srn::Srn;
use uuid::Uuid;

/// Longest username the proxies will look at.
///
/// Postgres truncates role names at `NAMEDATALEN - 1` = 63 bytes, so anything longer cannot round
/// trip through a startup packet. Every username this crate produces is exactly
/// [`USERNAME_LEN`] bytes, comfortably inside the limit.
pub const MAX_USERNAME_LEN: usize = 63;

/// Length of every username this crate produces: `2 + 1 + 26 + 1 + 26`.
pub const USERNAME_LEN: usize = 56;

/// Number of characters in a short id.
pub const SHORT_ID_LEN: usize = 26;

/// Crockford base32, lowercased, in canonical order.
const ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

/// What kind of tenant resource a connection is addressing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum ResourceKind {
    /// A tenant Postgres database, reached through pg-proxy.
    Database,
    /// A tenant valkey queue, reached through valkey-proxy.
    Queue,
    /// A tenant search index, reached through search-proxy.
    SearchIndex,
}

impl ResourceKind {
    /// Every kind, in declaration order.
    pub const ALL: &'static [Self] = &[Self::Database, Self::Queue, Self::SearchIndex];

    /// The two-character prefix used in usernames.
    pub fn prefix(&self) -> &'static str {
        match self {
            Self::Database => "db",
            Self::Queue => "kv",
            Self::SearchIndex => "ix",
        }
    }

    /// The SRN service this kind lives under.
    pub fn srn_service(&self) -> &'static str {
        match self {
            Self::Database => "db",
            Self::Queue => "store",
            Self::SearchIndex => "search",
        }
    }

    /// The SRN resource type for this kind.
    pub fn srn_resource_type(&self) -> &'static str {
        match self {
            Self::Database => "database",
            Self::Queue => "queue",
            Self::SearchIndex => "index",
        }
    }
}

impl fmt::Display for ResourceKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.prefix())
    }
}

impl FromStr for ResourceKind {
    type Err = UsernameError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .iter()
            .copied()
            .find(|kind| kind.prefix() == s)
            .ok_or_else(|| UsernameError::UnknownKind { kind: s.to_owned() })
    }
}

/// Which short id an error is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IdPart {
    /// The `<resource-short-id>` before the `.`.
    Resource,
    /// The `<organization-short-id>` after the `.`.
    Organization,
}

impl fmt::Display for IdPart {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Resource => "resource",
            Self::Organization => "organization",
        })
    }
}

/// Why a username is not a tenant identity.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UsernameError {
    /// The username exceeds [`MAX_USERNAME_LEN`].
    #[error("username is {len} bytes, which exceeds the {max} byte limit")]
    TooLong {
        /// Length of the offending username, in bytes.
        len: usize,
        /// The limit that was exceeded.
        max: usize,
    },

    /// The username is not `<kind>_<resource>.<organization>`.
    #[error("username must be `<kind>_<resource-short-id>.<organization-short-id>`")]
    Malformed,

    /// The `<kind>` prefix is not one this build knows about.
    #[error("unknown resource kind `{kind}`")]
    UnknownKind {
        /// The prefix as written.
        kind: String,
    },

    /// A short id is not [`SHORT_ID_LEN`] characters long.
    #[error("the {part} short id must be {expected} characters, found {found}")]
    ShortIdLength {
        /// Which short id.
        part: IdPart,
        /// The required length.
        expected: usize,
        /// The length as written.
        found: usize,
    },

    /// A short id contains a character outside the lowercase Crockford base32 alphabet.
    #[error("the {part} short id contains the illegal character {ch:?}")]
    ShortIdCharacter {
        /// Which short id.
        part: IdPart,
        /// The first offending character.
        ch: char,
    },

    /// A short id decodes to more than 128 bits, so it is not the encoding of any UUID.
    #[error("the {part} short id is not canonical: its first character must be `0`-`7`")]
    ShortIdNotCanonical {
        /// Which short id.
        part: IdPart,
    },
}

/// Who a connection claims to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TenantIdentity {
    /// The organization that owns the resource and pays for it.
    pub organization_id: Uuid,
    /// What kind of resource the connection is addressing.
    pub resource_kind: ResourceKind,
    /// Which resource of that kind.
    pub resource_id: Uuid,
}

impl TenantIdentity {
    /// Builds an identity.
    pub fn new(organization_id: Uuid, resource_kind: ResourceKind, resource_id: Uuid) -> Self {
        Self {
            organization_id,
            resource_kind,
            resource_id,
        }
    }

    /// Formats the connection username for this identity.
    ///
    /// Always [`USERNAME_LEN`] bytes, and always drawn from `[a-z0-9._]`.
    pub fn username(&self) -> String {
        format!(
            "{}_{}.{}",
            self.resource_kind.prefix(),
            encode_short_id(self.resource_id),
            encode_short_id(self.organization_id)
        )
    }

    /// Parses a connection username.
    ///
    /// This identifies, it does not authenticate: see [`verify_secret`].
    pub fn parse_username(username: &str) -> Result<Self, UsernameError> {
        if username.len() > MAX_USERNAME_LEN {
            return Err(UsernameError::TooLong {
                len: username.len(),
                max: MAX_USERNAME_LEN,
            });
        }

        let (local, organization) = split_once_exact(username, '.')?;
        let (kind, resource) = split_once_exact(local, '_')?;

        let resource_kind: ResourceKind = kind.parse()?;
        let resource_id = decode_short_id(resource, IdPart::Resource)?;
        let organization_id = decode_short_id(organization, IdPart::Organization)?;

        Ok(Self::new(organization_id, resource_kind, resource_id))
    }

    /// The SRN this identity names.
    pub fn srn(&self) -> Srn {
        Srn::for_organization(
            self.resource_kind.srn_service(),
            self.organization_id,
            self.resource_kind.srn_resource_type(),
            self.resource_id.to_string(),
        )
        .expect("a UUID is always a valid SRN segment")
    }
}

impl fmt::Display for TenantIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.username())
    }
}

impl FromStr for TenantIdentity {
    type Err = UsernameError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse_username(s)
    }
}

/// Splits on the first `separator`, refusing a second one.
fn split_once_exact(input: &str, separator: char) -> Result<(&str, &str), UsernameError> {
    let (before, after) = input
        .split_once(separator)
        .ok_or(UsernameError::Malformed)?;
    if after.contains(separator) {
        return Err(UsernameError::Malformed);
    }
    Ok((before, after))
}

/// Encodes a UUID as 26 characters of lowercase Crockford base32, most significant digit first.
///
/// This is the ULID text encoding: 26 digits hold 130 bits, so the leading digit only ever carries
/// the top three bits of the UUID and is always `0`-`7`.
pub fn encode_short_id(id: Uuid) -> String {
    let mut value = id.as_u128();
    let mut buffer = [0u8; SHORT_ID_LEN];
    for slot in buffer.iter_mut().rev() {
        *slot = ALPHABET[(value & 0x1f) as usize];
        value >>= 5;
    }
    String::from_utf8(buffer.to_vec()).expect("the alphabet is ASCII")
}

/// Decodes a short id produced by [`encode_short_id`].
///
/// Only the canonical spelling is accepted. Crockford's decoder normally folds `i` and `l` onto
/// `1`, `o` onto `0`, and uppercase onto lowercase; this one does not. A tenant has exactly one
/// username, so that a rate limiter, an audit log and a connection pool keyed on the string all
/// agree about which tenant they are looking at.
pub fn decode_short_id(short_id: &str, part: IdPart) -> Result<Uuid, UsernameError> {
    if short_id.len() != SHORT_ID_LEN {
        return Err(UsernameError::ShortIdLength {
            part,
            expected: SHORT_ID_LEN,
            found: short_id.chars().count(),
        });
    }

    let mut value: u128 = 0;
    for (index, ch) in short_id.chars().enumerate() {
        let digit = digit_value(ch).ok_or(UsernameError::ShortIdCharacter { part, ch })?;
        if index == 0 && digit > 7 {
            return Err(UsernameError::ShortIdNotCanonical { part });
        }
        value = (value << 5) | u128::from(digit);
    }
    Ok(Uuid::from_u128(value))
}

fn digit_value(ch: char) -> Option<u8> {
    let byte = u8::try_from(u32::from(ch)).ok()?;
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'h' => Some(byte - b'a' + 10),
        b'j'..=b'k' => Some(byte - b'j' + 18),
        b'm'..=b'n' => Some(byte - b'm' + 20),
        b'p'..=b't' => Some(byte - b'p' + 22),
        b'v'..=b'z' => Some(byte - b'v' + 27),
        _ => None,
    }
}

/// Argon2id memory cost, in KiB.
pub const ARGON2_MEMORY_KIB: u32 = 19 * 1024;

/// Argon2id time cost, in passes.
pub const ARGON2_ITERATIONS: u32 = 2;

/// Argon2id parallelism, in lanes.
pub const ARGON2_PARALLELISM: u32 = 1;

/// Something went wrong with a stored credential.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SecretError {
    /// The stored credential is not a PHC string this build can read.
    #[error("the stored credential is not a readable Argon2 PHC string: {reason}")]
    MalformedHash {
        /// What the parser objected to.
        reason: String,
    },

    /// Hashing failed, which in practice means the machine is out of memory.
    #[error("could not hash the secret: {reason}")]
    Hashing {
        /// What the hasher objected to.
        reason: String,
    },
}

fn hasher() -> Argon2<'static> {
    let params = Params::new(
        ARGON2_MEMORY_KIB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
        None,
    )
    .expect("the compiled-in Argon2 parameters are valid");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// Hashes a connection secret for storage, with a fresh random salt.
///
/// Returns a PHC string (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`) that carries its own
/// parameters, so raising the cost later does not invalidate credentials already stored.
pub fn hash_secret(secret: &[u8]) -> Result<String, SecretError> {
    let salt = SaltString::generate(&mut OsRng);
    hasher()
        .hash_password(secret, &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| SecretError::Hashing {
            reason: error.to_string(),
        })
}

/// Checks a presented secret against a stored PHC hash.
///
/// The comparison is constant time: the candidate is hashed with the salt and parameters recorded
/// in `stored`, and the two digests are compared with `subtle`'s constant-time equality (via
/// `password_hash::Output`), so a wrong secret takes the same time to reject whatever prefix it
/// shares with the real one.
///
/// `Ok(false)` means the secret is wrong. `Err` means the *stored* credential is unusable, which
/// is an operational fault and not a failed login — the caller should log it loudly rather than
/// telling the client its password was wrong.
///
/// Because the cost parameters come from `stored`, only ever pass hashes from our own storage.
///
/// A verification costs ~19 MiB and tens of milliseconds by design. The proxies run it once per
/// connection, not once per query; hot paths must cache the resulting [`TenantIdentity`] for the
/// lifetime of the connection.
pub fn verify_secret(secret: &[u8], stored: &str) -> Result<bool, SecretError> {
    let parsed = PasswordHash::new(stored).map_err(|error| SecretError::MalformedHash {
        reason: error.to_string(),
    })?;

    match Argon2::default().verify_password(secret, &parsed) {
        Ok(()) => Ok(true),
        Err(argon2::password_hash::Error::Password) => Ok(false),
        Err(error) => Err(SecretError::MalformedHash {
            reason: error.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f";
    const RESOURCE: &str = "01912d40-0000-7000-8000-0000000000a1";

    fn identity(kind: ResourceKind) -> TenantIdentity {
        TenantIdentity::new(
            Uuid::parse_str(ORG).unwrap(),
            kind,
            Uuid::parse_str(RESOURCE).unwrap(),
        )
    }

    #[test]
    fn usernames_round_trip() {
        for kind in ResourceKind::ALL {
            let identity = identity(*kind);
            let username = identity.username();
            assert_eq!(TenantIdentity::parse_username(&username).unwrap(), identity);
            assert_eq!(username.parse::<TenantIdentity>().unwrap(), identity);
            assert_eq!(identity.to_string(), username);
        }
    }

    #[test]
    fn usernames_have_the_documented_shape() {
        let username = identity(ResourceKind::Database).username();
        assert_eq!(username.len(), USERNAME_LEN);
        assert!(username.len() <= MAX_USERNAME_LEN);
        assert!(username.starts_with("db_"));

        let (local, organization) = username.split_once('.').unwrap();
        assert_eq!(local.len(), 2 + 1 + SHORT_ID_LEN);
        assert_eq!(organization.len(), SHORT_ID_LEN);
        assert_eq!(organization, encode_short_id(Uuid::parse_str(ORG).unwrap()));
    }

    #[test]
    fn usernames_only_use_wire_safe_characters() {
        for kind in ResourceKind::ALL {
            let username = identity(*kind).username();
            assert!(
                username.bytes().all(|b| b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || b == b'.'
                    || b == b'_'),
                "{username}"
            );
        }
    }

    #[test]
    fn every_kind_has_a_distinct_prefix_and_srn_mapping() {
        let mut prefixes: Vec<&str> = ResourceKind::ALL.iter().map(|k| k.prefix()).collect();
        prefixes.sort_unstable();
        prefixes.dedup();
        assert_eq!(prefixes.len(), ResourceKind::ALL.len());

        for kind in ResourceKind::ALL {
            assert_eq!(kind.prefix().len(), 2);
            assert_eq!(kind.prefix().parse::<ResourceKind>().unwrap(), *kind);
            assert_eq!(kind.to_string(), kind.prefix());
        }
    }

    #[test]
    fn identities_map_onto_srns() {
        assert_eq!(
            identity(ResourceKind::Database).srn().to_string(),
            format!("srn:sproutos:db:{ORG}:database/{RESOURCE}")
        );
        assert_eq!(
            identity(ResourceKind::Queue).srn().to_string(),
            format!("srn:sproutos:store:{ORG}:queue/{RESOURCE}")
        );
        assert_eq!(
            identity(ResourceKind::SearchIndex).srn().to_string(),
            format!("srn:sproutos:search:{ORG}:index/{RESOURCE}")
        );

        let srn = identity(ResourceKind::Database).srn();
        assert_eq!(srn.organization_uuid(), Some(Uuid::parse_str(ORG).unwrap()));
        assert!(!srn.contains_wildcard());
    }

    #[test]
    fn short_ids_round_trip_for_extreme_values() {
        for id in [
            Uuid::nil(),
            Uuid::max(),
            Uuid::from_u128(1),
            Uuid::parse_str(ORG).unwrap(),
            Uuid::parse_str(RESOURCE).unwrap(),
        ] {
            let encoded = encode_short_id(id);
            assert_eq!(encoded.len(), SHORT_ID_LEN);
            assert_eq!(decode_short_id(&encoded, IdPart::Resource).unwrap(), id);
        }
    }

    #[test]
    fn short_ids_are_stable() {
        assert_eq!(encode_short_id(Uuid::nil()), "0".repeat(SHORT_ID_LEN));
        assert_eq!(encode_short_id(Uuid::max()), "7zzzzzzzzzzzzzzzzzzzzzzzzz");
        assert_eq!(
            encode_short_id(Uuid::from_u128(31)),
            "0000000000000000000000000z"
        );
        assert_eq!(
            encode_short_id(Uuid::parse_str(ORG).unwrap()),
            "01j4pkz2hbfh6sw7sa7d65tvkz"
        );
    }

    #[test]
    fn short_ids_reject_non_canonical_spellings() {
        let canonical = encode_short_id(Uuid::parse_str(ORG).unwrap());
        assert!(canonical.contains('b'));

        assert_eq!(
            decode_short_id(&canonical.to_uppercase(), IdPart::Resource).unwrap_err(),
            UsernameError::ShortIdCharacter {
                part: IdPart::Resource,
                ch: 'J'
            }
        );
        for ambiguous in ['i', 'l', 'o', 'u'] {
            let spelled = format!("0{}", ambiguous.to_string().repeat(SHORT_ID_LEN - 1));
            assert_eq!(
                decode_short_id(&spelled, IdPart::Organization).unwrap_err(),
                UsernameError::ShortIdCharacter {
                    part: IdPart::Organization,
                    ch: ambiguous
                }
            );
        }
        assert_eq!(
            decode_short_id("8zzzzzzzzzzzzzzzzzzzzzzzzz", IdPart::Resource).unwrap_err(),
            UsernameError::ShortIdNotCanonical {
                part: IdPart::Resource
            }
        );
        assert_eq!(
            decode_short_id("zzzzzzzzzzzzzzzzzzzzzzzzzz", IdPart::Resource).unwrap_err(),
            UsernameError::ShortIdNotCanonical {
                part: IdPart::Resource
            }
        );
    }

    #[test]
    fn short_ids_reject_wrong_lengths() {
        assert_eq!(
            decode_short_id("", IdPart::Resource).unwrap_err(),
            UsernameError::ShortIdLength {
                part: IdPart::Resource,
                expected: 26,
                found: 0
            }
        );
        assert_eq!(
            decode_short_id("0123456789", IdPart::Organization).unwrap_err(),
            UsernameError::ShortIdLength {
                part: IdPart::Organization,
                expected: 26,
                found: 10
            }
        );
    }

    #[test]
    fn malformed_usernames_are_rejected() {
        let good = identity(ResourceKind::Database).username();
        let (local, organization) = good.split_once('.').unwrap();
        let resource = local.strip_prefix("db_").unwrap();

        for bad in [
            String::new(),
            "db".to_owned(),
            local.to_owned(),
            format!("db_{resource}"),
            format!("{resource}.{organization}"),
            format!("db{resource}.{organization}"),
            format!("db_{resource}.{organization}.{organization}"),
            format!("db_{resource}_{resource}.{organization}"),
            format!("DB_{resource}.{organization}"),
            format!("pg_{resource}.{organization}"),
            good.to_uppercase(),
            format!("db_{resource}. {organization}"),
            format!("db_{resource}.{organization} "),
            format!(" db_{resource}.{organization}"),
            format!("db_{resource}.{organization}\n"),
            format!("db_{}.{organization}", &resource[..25]),
            format!("db_{resource}z.{organization}"),
            format!("db_{resource}.{}", &organization[..25]),
        ] {
            assert!(
                TenantIdentity::parse_username(&bad).is_err(),
                "`{bad}` must not parse as a tenant username"
            );
        }
    }

    #[test]
    fn overlong_usernames_are_rejected_before_parsing() {
        let username = format!("db_{}", "0".repeat(MAX_USERNAME_LEN));
        let len = username.len();
        assert_eq!(
            TenantIdentity::parse_username(&username).unwrap_err(),
            UsernameError::TooLong {
                len,
                max: MAX_USERNAME_LEN
            }
        );
    }

    #[test]
    fn unknown_kinds_are_named_in_the_error() {
        let good = identity(ResourceKind::Database).username();
        let bad = good.replacen("db_", "zz_", 1);
        assert_eq!(
            TenantIdentity::parse_username(&bad).unwrap_err(),
            UsernameError::UnknownKind {
                kind: "zz".to_owned()
            }
        );
    }

    #[test]
    fn distinct_resources_get_distinct_usernames() {
        let a = identity(ResourceKind::Database);
        let mut b = a;
        b.resource_id = Uuid::from_u128(a.resource_id.as_u128() + 1);
        assert_ne!(a.username(), b.username());

        let mut c = a;
        c.resource_kind = ResourceKind::Queue;
        assert_ne!(a.username(), c.username());
        assert_ne!(a.srn(), c.srn());
    }

    #[test]
    fn hash_and_verify_a_secret() {
        let stored = hash_secret(b"correct horse battery staple").unwrap();
        assert!(stored.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"));
        assert!(verify_secret(b"correct horse battery staple", &stored).unwrap());
        assert!(!verify_secret(b"correct horse battery stapl", &stored).unwrap());
        assert!(!verify_secret(b"", &stored).unwrap());
        assert!(!verify_secret(b"Correct horse battery staple", &stored).unwrap());
    }

    #[test]
    fn each_hash_uses_a_fresh_salt() {
        let first = hash_secret(b"same secret").unwrap();
        let second = hash_secret(b"same secret").unwrap();
        assert_ne!(
            first, second,
            "identical secrets must not produce identical hashes"
        );
        assert!(verify_secret(b"same secret", &first).unwrap());
        assert!(verify_secret(b"same secret", &second).unwrap());
    }

    #[test]
    fn secrets_may_be_arbitrary_bytes() {
        let secret = b"\x00\xff binary \xc3\xa9 secret";
        let stored = hash_secret(secret).unwrap();
        assert!(verify_secret(secret, &stored).unwrap());
        assert!(!verify_secret(b"\x00\xff binary \xc3\xa9 secrey", &stored).unwrap());
    }

    #[test]
    fn a_broken_stored_hash_is_an_error_not_a_rejection() {
        for stored in [
            "",
            "not-a-phc-string",
            "$argon2id$v=19$m=19456,t=2,p=1$",
            "$bcrypt$x",
        ] {
            assert!(
                matches!(
                    verify_secret(b"secret", stored),
                    Err(SecretError::MalformedHash { .. })
                ),
                "`{stored}` must be reported as an operational fault"
            );
        }
    }

    #[test]
    fn hashes_carry_their_own_parameters() {
        let cheap = Argon2::new(
            Algorithm::Argon2id,
            Version::V0x13,
            Params::new(8, 1, 1, None).unwrap(),
        );
        let salt = SaltString::generate(&mut OsRng);
        let stored = cheap
            .hash_password(b"legacy secret", &salt)
            .unwrap()
            .to_string();
        assert!(stored.contains("m=8,t=1,p=1"));
        assert!(verify_secret(b"legacy secret", &stored).unwrap());
        assert!(!verify_secret(b"other secret", &stored).unwrap());
    }
}
