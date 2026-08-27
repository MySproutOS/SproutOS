//! Tenant Valkey ACL credentials and the exact rule set installed for them.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use sproutos_tenant_auth::TenantIdentity;

use crate::commands::FORWARDED_COMMANDS;
use crate::keyspace::prefix_for;
use crate::upstream::Credentials;

type HmacSha256 = Hmac<Sha256>;
const ALPHABET: &[u8] = b"0123456789abcdefghjkmnpqrstvwxyz";

pub const DENIED_COMMANDS: &[&str] = &[
    "ACL",
    "CLIENT",
    "CLUSTER",
    "CONFIG",
    "DEBUG",
    "DBSIZE",
    "FLUSHALL",
    "FLUSHDB",
    "FUNCTION",
    "INFO",
    "KEYS",
    "MIGRATE",
    "MEMORY",
    "MONITOR",
    "RANDOMKEY",
    "REPLICAOF",
    "RESET",
    "SCAN",
    "SCRIPT",
    "SELECT",
    "SHUTDOWN",
    "SLAVEOF",
    "SLOWLOG",
    "SORT",
    "SWAPDB",
    "OBJECT",
    "LATENCY",
    "WAIT",
];

pub fn credentials(root_key: &[u8], identity: &TenantIdentity) -> Credentials {
    let username = identity.username();
    let mut mac = HmacSha256::new_from_slice(root_key).expect("HMAC accepts any key length");
    mac.update(username.as_bytes());
    Credentials {
        username,
        password: encode(&mac.finalize().into_bytes()),
    }
}

pub fn setuser_args(root_key: &[u8], identity: &TenantIdentity) -> Vec<Vec<u8>> {
    let credential = credentials(root_key, identity);
    let prefix = String::from_utf8(prefix_for(identity)).expect("tenant prefix is ASCII");
    let mut args = vec![
        b"ACL".to_vec(),
        b"SETUSER".to_vec(),
        credential.username.into_bytes(),
        b"reset".to_vec(),
        b"on".to_vec(),
        format!(">{}", credential.password).into_bytes(),
        format!("~{prefix}*").into_bytes(),
        format!("&{prefix}*").into_bytes(),
    ];
    args.extend(
        FORWARDED_COMMANDS
            .iter()
            .map(|command| format!("+{command}").into_bytes()),
    );
    // These are deliberately last. ACL rules are evaluated left-to-right and a later broad grant
    // must never accidentally restore one of the no-key administrative commands.
    args.extend(
        DENIED_COMMANDS
            .iter()
            .map(|command| format!("-{command}").into_bytes()),
    );
    args
}

fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(52);
    let mut accumulator: u16 = 0;
    let mut bits = 0u8;
    for byte in bytes {
        accumulator = (accumulator << 8) | u16::from(*byte);
        bits += 8;
        while bits >= 5 {
            out.push(ALPHABET[((accumulator >> (bits - 5)) & 0x1f) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((accumulator << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use sproutos_tenant_auth::ResourceKind;
    use uuid::Uuid;

    fn identity() -> TenantIdentity {
        TenantIdentity::new(Uuid::nil(), ResourceKind::Queue, Uuid::from_u128(1))
    }

    #[test]
    fn credential_is_stable_and_safe_for_a_uri() {
        let first = credentials(b"root", &identity());
        assert_eq!(first, credentials(b"root", &identity()));
        assert_eq!(first.password.len(), 52);
        assert!(first.password.bytes().all(|byte| ALPHABET.contains(&byte)));
    }

    #[test]
    fn setuser_is_scoped_and_ends_with_explicit_denials() {
        let args = setuser_args(b"root", &identity());
        let text: Vec<_> = args
            .iter()
            .map(|arg| String::from_utf8_lossy(arg))
            .collect();
        assert!(
            text.iter()
                .any(|rule| rule.starts_with("~{kv:") && rule.ends_with(":*"))
        );
        assert!(
            text.iter()
                .any(|rule| rule.starts_with("&{kv:") && rule.ends_with(":*"))
        );
        let prefix = String::from_utf8(prefix_for(&identity())).unwrap();
        assert!(!prefix.contains(['*', '?', '[', '\\']));
        let tail = &text[text.len() - DENIED_COMMANDS.len()..];
        for command in DENIED_COMMANDS {
            assert!(tail.contains(&format!("-{command}").into()));
        }
        assert!(!text.contains(&"+AUTH".into()));
        assert!(!text.contains(&"+HELLO".into()));
    }

    #[test]
    fn control_plane_reconciliation_uses_the_same_command_policy() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../lib/typescript/services/src/valkey-acl-policy.json"
        ))
        .unwrap();
        let strings = |name: &str| {
            fixture[name]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item.as_str().unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(strings("forwardedCommands"), FORWARDED_COMMANDS);
        assert_eq!(strings("deniedCommands"), DENIED_COMMANDS);
        let vector = &fixture["credentialVector"];
        let identity = TenantIdentity::new(
            Uuid::parse_str(vector["organizationId"].as_str().unwrap()).unwrap(),
            ResourceKind::Queue,
            Uuid::parse_str(vector["resourceId"].as_str().unwrap()).unwrap(),
        );
        let credential = credentials(vector["rootKey"].as_str().unwrap().as_bytes(), &identity);
        assert_eq!(credential.username, vector["username"].as_str().unwrap());
        assert_eq!(credential.password, vector["password"].as_str().unwrap());
    }
}
