//! Bounded reconciliation of proxy-owned Valkey ACL users.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use sproutos_tenant_auth::{ResourceKind, TenantIdentity};

use crate::acl;
use crate::provision::AclProvisioner;

pub const DEFAULT_REPAIR_LIMIT: usize = 100;
pub const DEFAULT_INSPECTION_LIMIT: usize = 1_000;
pub const CARDINALITY_SOFT_LIMIT: usize = 1_000;

#[derive(Debug, Clone, PartialEq)]
pub struct ReconciliationReport {
    pub expected: usize,
    pub observed: usize,
    pub missing: usize,
    pub drifted: usize,
    pub orphaned: usize,
    pub repaired: usize,
    pub inspected: usize,
    pub pending_inspections: usize,
    pub pending_repairs: usize,
    pub list_latency_ms: f64,
    pub repair_latency_ms: f64,
    pub soft_limit: usize,
    pub soft_limit_exceeded: bool,
}

impl AclProvisioner {
    /// Repairs a bounded number of missing/drifted live users and only reports unknown users.
    ///
    /// Reconciliation cannot prove that an unknown user belongs to a deleted service. The service
    /// reaper owns that proof and deletion, so this path never calls `ACL DELUSER`.
    pub async fn reconcile(
        &self,
        identities: &[TenantIdentity],
        repair_limit: usize,
        inspection_limit: usize,
        soft_limit: usize,
    ) -> Result<ReconciliationReport> {
        anyhow::ensure!(repair_limit > 0, "ACL repair limit must be positive");
        anyhow::ensure!(
            inspection_limit > 0,
            "ACL inspection limit must be positive"
        );
        anyhow::ensure!(
            soft_limit > 0,
            "ACL cardinality soft limit must be positive"
        );

        let list_started = Instant::now();
        let lines = parse_bulk_array(
            &self
                // The measured 100k-user response is ~152 MiB. Keep a safety ceiling without
                // turning a measured tier into an accidental hard cardinality limit.
                .admin_reply(&["ACL", "LIST"], 256 * 1024 * 1024)
                .await?,
        )
        .context("could not parse ACL LIST")?;
        let list_latency_ms = list_started.elapsed().as_secs_f64() * 1_000.0;
        let actual: HashMap<String, String> = lines
            .into_iter()
            .filter_map(|line| {
                let username = line
                    .strip_prefix("user ")?
                    .split_ascii_whitespace()
                    .next()?;
                Some((username.to_owned(), line))
            })
            .collect();
        let expected_names: HashSet<String> =
            identities.iter().map(TenantIdentity::username).collect();

        let orphaned = actual
            .keys()
            .filter(|username| {
                TenantIdentity::parse_username(username)
                    .is_ok_and(|identity| identity.resource_kind == ResourceKind::Queue)
                    && !expected_names.contains(*username)
            })
            .count();
        let observed = actual
            .keys()
            .filter(|username| {
                TenantIdentity::parse_username(username)
                    .is_ok_and(|identity| identity.resource_kind == ResourceKind::Queue)
            })
            .count();

        let mut missing = Vec::new();
        let mut drifted = Vec::new();
        let mut inspected = 0;
        for identity in identities {
            let username = identity.username();
            let Some(current) = actual.get(&username) else {
                missing.push(identity);
                continue;
            };
            if inspected >= inspection_limit {
                continue;
            }
            inspected += 1;
            if !equivalent(current, &desired_tokens(&self.root_key, identity)) {
                drifted.push(identity);
            }
        }

        let repair_started = Instant::now();
        let repair_plan = missing.iter().chain(drifted.iter());
        let mut repaired = 0;
        for identity in repair_plan.take(repair_limit) {
            self.provision(identity).await?;
            repaired += 1;
        }
        let repair_latency_ms = repair_started.elapsed().as_secs_f64() * 1_000.0;
        let required_repairs = missing.len() + drifted.len();
        let cardinality = observed.max(identities.len());

        Ok(ReconciliationReport {
            expected: identities.len(),
            observed,
            missing: missing.len(),
            drifted: drifted.len(),
            orphaned,
            repaired,
            inspected,
            pending_inspections: identities.len().saturating_sub(missing.len() + inspected),
            pending_repairs: required_repairs.saturating_sub(repaired),
            list_latency_ms,
            repair_latency_ms,
            soft_limit,
            soft_limit_exceeded: cardinality >= soft_limit,
        })
    }
}

fn desired_tokens(root_key: &[u8], identity: &TenantIdentity) -> HashSet<String> {
    let args = acl::setuser_args(root_key, identity);
    let credential = acl::credentials(root_key, identity);
    let password_hash = format!("#{:x}", Sha256::digest(credential.password.as_bytes()));
    let mut tokens: HashSet<String> = args
        .into_iter()
        .skip(3) // ACL SETUSER username
        .map(|arg| String::from_utf8(arg).expect("ACL policy is ASCII"))
        .filter(|token| token != "reset" && !token.starts_with('>'))
        .map(|token| token.to_ascii_lowercase())
        .collect();
    tokens.insert("sanitize-payload".into());
    tokens.insert("resetchannels".into());
    tokens.insert("-@all".into());
    tokens.insert(password_hash);
    tokens
}

fn equivalent(line: &str, wanted: &HashSet<String>) -> bool {
    let actual: HashSet<String> = line
        .split_ascii_whitespace()
        .skip(2) // user username
        .map(str::to_ascii_lowercase)
        .collect();
    actual == *wanted
}

fn parse_bulk_array(bytes: &[u8]) -> Result<Vec<String>> {
    let mut cursor = 0;
    anyhow::ensure!(
        bytes.get(cursor) == Some(&b'*'),
        "ACL LIST was not an array"
    );
    cursor += 1;
    let count = parse_number_line(bytes, &mut cursor)?;
    anyhow::ensure!(count >= 0, "ACL LIST returned a null array");
    let mut values = Vec::with_capacity(count as usize);
    for _ in 0..count {
        anyhow::ensure!(
            bytes.get(cursor) == Some(&b'$'),
            "ACL LIST item was not bulk text"
        );
        cursor += 1;
        let length = parse_number_line(bytes, &mut cursor)?;
        anyhow::ensure!(length >= 0, "ACL LIST contained null text");
        let end = cursor + length as usize;
        anyhow::ensure!(end + 2 <= bytes.len(), "ACL LIST item was truncated");
        values.push(String::from_utf8(bytes[cursor..end].to_vec())?);
        anyhow::ensure!(
            &bytes[end..end + 2] == b"\r\n",
            "ACL LIST item lacked a terminator"
        );
        cursor = end + 2;
    }
    Ok(values)
}

fn parse_number_line(bytes: &[u8], cursor: &mut usize) -> Result<isize> {
    let relative = bytes[*cursor..]
        .windows(2)
        .position(|pair| pair == b"\r\n")
        .context("RESP number lacked a terminator")?;
    let end = *cursor + relative;
    let value = std::str::from_utf8(&bytes[*cursor..end])?.parse()?;
    *cursor = end + 2;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn parses_acl_list() {
        assert_eq!(
            parse_bulk_array(b"*2\r\n$5\r\nhello\r\n$5\r\nworld\r\n").unwrap(),
            vec!["hello", "world"]
        );
    }

    #[test]
    fn desired_policy_detects_drift() {
        let identity = TenantIdentity::new(Uuid::nil(), ResourceKind::Queue, Uuid::from_u128(1));
        let desired = desired_tokens(&[b'x'; 32], &identity);
        let line = format!(
            "user {} {}",
            identity.username(),
            desired.iter().cloned().collect::<Vec<_>>().join(" ")
        );
        assert!(equivalent(&line, &desired));
        assert!(!equivalent(&format!("{line} +acl"), &desired));
    }
}
