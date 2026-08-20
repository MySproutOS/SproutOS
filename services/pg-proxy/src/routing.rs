//! Which database a connection lands in, and as whom.
//!
//! The tenant's username carries its own routing information — `db_<resource>.<organization>` — and
//! the real Postgres identifiers are derived from the resource id, never from anything a customer
//! typed. That derivation is duplicated in `lib/typescript/services/src/naming.ts`, which is what
//! actually creates the database and the role. A divergence between the two means this proxy
//! connects a tenant to a database that does not exist, or worse, to one that does and is not
//! theirs.

use sproutos_tenant_auth::{TenantIdentity, encode_short_id};

/// Prefix on every generated identifier. Mirrors `PREFIX` in the TypeScript.
const PREFIX: &str = "sprout";

/// The database this tenant's connections belong in.
///
/// 39 characters, well inside Postgres's 63-byte identifier limit, and containing nothing that
/// would need escaping — a short id is 26 characters of lowercase base32 and nothing else.
pub fn database_for(identity: &TenantIdentity) -> String {
    format!("{PREFIX}_db_{}", encode_short_id(identity.resource_id))
}

/// The role a session runs as once connected.
///
/// The proxy connects to the backend with an administrative credential of its own — it has to, in
/// order to reach any tenant's database — and then immediately drops to this. A session that stayed
/// administrative would let one tenant read every other tenant's tables, which is the whole
/// property this proxy exists to provide.
pub fn role_for(identity: &TenantIdentity) -> String {
    format!("{PREFIX}_r_{}", encode_short_id(identity.resource_id))
}

/// Refuse anything that is not a bare lowercase identifier.
///
/// Asserted rather than assumed even though both functions above can only produce safe output,
/// because the value ends up in `SET ROLE`, which cannot be parameterized. If the derivation ever
/// changes shape, this is what turns a SQL injection into a refused connection.
pub fn is_safe_identifier(identifier: &str) -> bool {
    !identifier.is_empty()
        && identifier.len() <= 63
        && identifier
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_lowercase())
        && identifier.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sproutos_tenant_auth::ResourceKind;
    use uuid::Uuid;

    fn identity(resource: &str) -> TenantIdentity {
        TenantIdentity::new(
            Uuid::nil(),
            ResourceKind::Database,
            Uuid::parse_str(resource).unwrap(),
        )
    }

    /// The same fixture `naming.test.ts` asserts against `databaseNameFor` and `roleNameFor`.
    ///
    /// The TypeScript creates the database and the role; this connects to them. Nothing is shared
    /// but the algorithm, so a change on one side that is not made on the other has to turn a test
    /// red on both — otherwise the failure is a tenant connected to a database that is not theirs.
    #[test]
    fn the_names_match_the_control_plane() {
        let identity = identity("01912d40-0000-7000-8000-0000000000a1");
        assert_eq!(
            database_for(&identity),
            "sprout_db_01j4pm0000e008000000000051"
        );
        assert_eq!(role_for(&identity), "sprout_r_01j4pm0000e008000000000051");
    }

    #[test]
    fn generated_names_are_safe_to_interpolate() {
        let identity = identity("01912d40-0000-7000-8000-0000000000a1");
        assert!(is_safe_identifier(&database_for(&identity)));
        assert!(is_safe_identifier(&role_for(&identity)));
        // 63 bytes is Postgres's limit; both are comfortably inside it.
        assert!(database_for(&identity).len() < 63);
    }

    #[test]
    fn anything_that_could_escape_a_statement_is_refused() {
        for candidate in [
            "",
            "Sprout_db",          // uppercase
            "1sprout",            // leading digit
            "sprout; drop table", // the obvious one
            "sprout'db",
            "sprout\"db",
            "sprout-db",
            "sprout db",
            "sprout\ndb",
        ] {
            assert!(
                !is_safe_identifier(candidate),
                "{candidate:?} should be refused"
            );
        }
    }
}
