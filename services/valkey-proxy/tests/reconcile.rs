//! Real-engine coverage for bounded ACL reconciliation.

use std::time::Duration;

use sproutos_tenant_auth::{ResourceKind, TenantIdentity};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use uuid::Uuid;
use valkey_proxy::provision::AclProvisioner;

fn backend() -> String {
    std::env::var("VALKEY_PROXY_BACKEND").unwrap_or_else(|_| "127.0.0.1:41023".into())
}

async fn command(args: &[&str]) -> anyhow::Result<Vec<u8>> {
    let mut stream = TcpStream::connect(backend()).await?;
    let mut request = format!("*{}\r\n", args.len()).into_bytes();
    for arg in args {
        request.extend_from_slice(format!("${}\r\n{arg}\r\n", arg.len()).as_bytes());
    }
    stream.write_all(&request).await?;
    let mut reply = Vec::new();
    loop {
        let mut chunk = [0; 4096];
        let read = stream.read(&mut chunk).await?;
        anyhow::ensure!(read > 0, "Valkey closed before replying");
        reply.extend_from_slice(&chunk[..read]);
        if valkey_proxy::reply::frame(&reply)?.is_some() {
            return Ok(reply);
        }
    }
}

#[tokio::test]
async fn repairs_missing_and_drifted_users_but_only_reports_orphans() {
    if tokio::time::timeout(Duration::from_secs(1), TcpStream::connect(backend()))
        .await
        .is_err()
    {
        if std::env::var("CI").is_ok() {
            panic!("Valkey reconciliation integration test cannot silently skip in CI");
        }
        eprintln!("skipping: run `docker compose up -d valkey`");
        return;
    }

    let seed = (u128::from(std::process::id()) << 64)
        | std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
            .wrapping_shl(32)
            .wrapping_shr(32);
    let organization = Uuid::from_u128(seed);
    let missing = TenantIdentity::new(organization, ResourceKind::Queue, Uuid::from_u128(seed + 1));
    let drifted = TenantIdentity::new(organization, ResourceKind::Queue, Uuid::from_u128(seed + 2));
    let orphan = TenantIdentity::new(organization, ResourceKind::Queue, Uuid::from_u128(seed + 3));
    let root = [b'r'; 32];
    let provisioner = AclProvisioner::new(backend(), root).unwrap();

    provisioner
        .reconcile(std::slice::from_ref(&drifted), 10, 10, 1_000)
        .await
        .unwrap();
    provisioner
        .reconcile(std::slice::from_ref(&orphan), 10, 10, 1_000)
        .await
        .unwrap();
    command(&["ACL", "SETUSER", &drifted.username(), "+ACL"])
        .await
        .unwrap();

    let report = provisioner
        .reconcile(&[missing, drifted], 10, 10, 1_000)
        .await
        .unwrap();

    assert_eq!(report.missing, 1);
    assert_eq!(report.drifted, 1);
    assert_eq!(report.repaired, 2);
    assert!(report.orphaned >= 1);
    let auth = command(&[
        "AUTH",
        &valkey_proxy::acl::credentials(&root, &orphan).username,
        &valkey_proxy::acl::credentials(&root, &orphan).password,
    ])
    .await
    .unwrap();
    assert!(auth.starts_with(b"+OK"), "orphan was unexpectedly deleted");

    for identity in [missing, drifted, orphan] {
        command(&["ACL", "DELUSER", &identity.username()])
            .await
            .unwrap();
    }
}
