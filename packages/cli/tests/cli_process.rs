use assert_cmd::cargo::cargo_bin_cmd;
use predicates::prelude::*;
use serde_json::{Value, json};
use std::{
    io::{Read as _, Write as _},
    net::TcpListener,
    sync::mpsc,
    thread,
};

const UPSTREAM_COMMIT: &str = "0123456789012345678901234567890123456789";
const SOURCE_COMMIT: &str = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";

fn current_target() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux_amd64_musl",
        ("linux", "aarch64") => "linux_arm64_musl",
        ("macos", "x86_64") => "darwin_amd64",
        ("macos", "aarch64") => "darwin_arm64",
        ("windows", "x86_64") => "windows_amd64",
        platform => panic!("unsupported test platform: {platform:?}"),
    }
}

fn resolution(target: &str) -> Value {
    let plugin_digest = format!("sha256:{}", "a".repeat(64));
    json!({
        "template_id": "starter",
        "upstream_commit": UPSTREAM_COMMIT,
        "plugin_reference": format!("ghcr.io/mysproutos/template-starter@{plugin_digest}"),
        "plugin_digest": plugin_digest,
        "target": target,
        "provenance": {
            "repository": "MySproutOS/Deployment-Templates",
            "workflow": ".github/workflows/publish.yml",
            "git_ref": "refs/heads/main",
            "source_commit": SOURCE_COMMIT,
            "oidc_issuer": "https://token.actions.githubusercontent.com",
            "workflow_identity": "MySproutOS/Deployment-Templates/.github/workflows/publish.yml@refs/heads/main",
            "github_hosted_runner": true
        },
        "request": {
            "protocol_version": 1,
            "workspace": "/workspace",
            "template": {
                "id": "starter",
                "catalogue_digest": format!("sha256:{}", "b".repeat(64)),
                "manifest_digest": format!("sha256:{}", "c".repeat(64)),
                "plugin_digest": format!("sha256:{}", "a".repeat(64)),
                "upstream_repository": "https://github.com/MySproutOS/starter",
                "upstream_commit": UPSTREAM_COMMIT
            },
            "deployment": {"preset": "web", "capabilities": []},
            "services": [],
            "user_inputs": [],
            "generated_inputs": []
        }
    })
}

fn serve_once(body: Value) -> (String, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let response = serde_json::to_vec(&body).unwrap();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = [0_u8; 16 * 1024];
        let length = socket.read(&mut request).unwrap();
        let request = String::from_utf8_lossy(&request[..length]).into_owned();
        let _ = sender.send(request);
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            response.len()
        )
        .unwrap();
        socket.write_all(&response).unwrap();
    });
    (format!("http://{address}"), receiver)
}

#[test]
fn json_validation_error_is_one_stdout_document() {
    let mut command = cargo_bin_cmd!("sprout");
    command
        .args(["--json", "project", "delete", "dangerous-project"])
        .assert()
        .code(2)
        .stdout(
            predicate::str::is_match(
                r#"^\{"schema_version":1,"ok":false,"error":\{"code":"invalid_input".*\}\}\n$"#,
            )
            .unwrap(),
        )
        .stderr(predicate::str::is_empty());
}

#[test]
fn human_validation_error_uses_stderr() {
    let mut command = cargo_bin_cmd!("sprout");
    command
        .args(["api", "get", "https://attacker.example/steal"])
        .assert()
        .code(2)
        .stdout(predicate::str::is_empty())
        .stderr(predicate::str::contains(
            "API path must be relative to the configured API origin",
        ));
}

#[test]
fn template_resolve_returns_exact_digest_source_commit_and_provenance_without_leaking_token() {
    let directory = tempfile::tempdir().unwrap();
    let (api_url, request) = serve_once(resolution(current_target()));
    let mut command = cargo_bin_cmd!("sprout");
    command
        .env("SPROUTOS_TOKEN", "canary-secret-never-print")
        .env("SPROUTOS_CONFIG", directory.path().join("config.json"))
        .args([
            "--json",
            "--api-url",
            &api_url,
            "template",
            "resolve",
            "starter",
            "--upstream-commit",
            UPSTREAM_COMMIT,
        ])
        .assert()
        .success()
        .stdout(
            predicate::str::contains(format!(r#""source_commit":"{SOURCE_COMMIT}""#))
                .and(predicate::str::contains(format!(
                    r#""plugin_digest":"sha256:{}""#,
                    "a".repeat(64)
                )))
                .and(predicate::str::contains(
                    r#""workflow_identity":"MySproutOS/Deployment-Templates/.github/workflows/publish.yml@refs/heads/main""#,
                ))
                .and(predicate::str::contains("canary-secret-never-print").not()),
        )
        .stderr(predicate::str::is_empty());
    let request = request.recv().unwrap();
    assert!(request.starts_with("POST /v1/templates/resolve HTTP/1.1"));
    assert!(request.contains("authorization: Bearer canary-secret-never-print"));
    assert!(request.contains(UPSTREAM_COMMIT));
}

#[test]
fn template_resolve_human_output_is_stable_and_includes_immutable_coordinates() {
    let directory = tempfile::tempdir().unwrap();
    let target = current_target();
    let (api_url, _) = serve_once(resolution(target));
    let mut command = cargo_bin_cmd!("sprout");
    command
        .env("SPROUTOS_TOKEN", "secret")
        .env("SPROUTOS_CONFIG", directory.path().join("config.json"))
        .args([
            "--api-url",
            &api_url,
            "template",
            "resolve",
            "starter",
            "--upstream-commit",
            UPSTREAM_COMMIT,
        ])
        .assert()
        .success()
        .stdout(format!(
            "Resolved starter at {UPSTREAM_COMMIT} to sha256:{} for {} (catalogue source {SOURCE_COMMIT}).\n",
            "a".repeat(64),
            target
        ))
        .stderr(predicate::str::is_empty());
}

#[test]
fn template_verify_rejects_wrong_catalogue_provenance_before_running_cosign() {
    let directory = tempfile::tempdir().unwrap();
    let mut response = resolution(current_target());
    response["provenance"]["repository"] = json!("attacker/templates");
    let (api_url, _) = serve_once(response);
    let mut command = cargo_bin_cmd!("sprout");
    command
        .env("SPROUTOS_TOKEN", "redaction-canary")
        .env("SPROUTOS_CONFIG", directory.path().join("config.json"))
        .args([
            "--json",
            "--api-url",
            &api_url,
            "template",
            "verify",
            "starter",
            "--upstream-commit",
            UPSTREAM_COMMIT,
        ])
        .assert()
        .code(1)
        .stdout(
            predicate::str::contains(r#""code":"provenance_rejected""#)
                .and(predicate::str::contains("redaction-canary").not()),
        )
        .stderr(predicate::str::is_empty());
}

#[test]
fn template_apply_rejects_a_non_host_target_before_isolation_or_download() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join(".git")).unwrap();
    let foreign_target = if current_target() == "windows_amd64" {
        "darwin_amd64"
    } else {
        "windows_amd64"
    };
    let (api_url, _) = serve_once(resolution(foreign_target));
    let foreign_target_flag = foreign_target.replace('_', "-");
    let mut command = cargo_bin_cmd!("sprout");
    command
        .env("SPROUTOS_TOKEN", "secret")
        .env("SPROUTOS_CONFIG", directory.path().join("config.json"))
        .args([
            "--json",
            "--yes",
            "--api-url",
            &api_url,
            "template",
            "apply",
            "starter",
            "--upstream-commit",
            UPSTREAM_COMMIT,
            "--target",
            &foreign_target_flag,
            "--workspace",
            directory.path().to_str().unwrap(),
        ])
        .assert()
        .code(1)
        .stdout(predicate::str::contains(r#""code":"artifact_rejected""#))
        .stderr(predicate::str::is_empty());
}

#[test]
fn template_apply_rejects_unsigned_structural_input_without_echoing_values() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join(".git")).unwrap();
    let (api_url, _) = serve_once(resolution(current_target()));
    let mut command = cargo_bin_cmd!("sprout");
    command
        .env("SPROUTOS_TOKEN", "token-canary")
        .env("SPROUTOS_CONFIG", directory.path().join("config.json"))
        .args([
            "--json",
            "--yes",
            "--api-url",
            &api_url,
            "template",
            "apply",
            "starter",
            "--upstream-commit",
            UPSTREAM_COMMIT,
            "--workspace",
            directory.path().to_str().unwrap(),
            "--input",
            r#"{"password":"input-value-canary"}"#,
        ])
        .assert()
        .code(2)
        .stdout(
            predicate::str::contains(r#""code":"invalid_input""#)
                .and(predicate::str::contains("input-value-canary").not())
                .and(predicate::str::contains("token-canary").not()),
        )
        .stderr(predicate::str::is_empty());
}

#[cfg(not(target_os = "linux"))]
#[test]
fn template_apply_fails_closed_when_native_isolation_is_unavailable() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join(".git")).unwrap();
    let (api_url, _) = serve_once(resolution(current_target()));
    let mut command = cargo_bin_cmd!("sprout");
    command
        .env("SPROUTOS_TOKEN", "isolation-redaction-canary")
        .env("SPROUTOS_CONFIG", directory.path().join("config.json"))
        .args([
            "--json",
            "--yes",
            "--api-url",
            &api_url,
            "template",
            "apply",
            "starter",
            "--upstream-commit",
            UPSTREAM_COMMIT,
            "--workspace",
            directory.path().to_str().unwrap(),
        ])
        .assert()
        .code(1)
        .stdout(
            predicate::str::contains(r#""code":"isolation_unavailable""#)
                .and(predicate::str::contains("isolation-redaction-canary").not()),
        )
        .stderr(predicate::str::is_empty());
}

#[test]
fn json_clap_error_is_structured_too() {
    let mut command = cargo_bin_cmd!("sprout");
    command
        .args(["--json", "deploy"])
        .assert()
        .code(2)
        .stdout(predicate::str::contains(r#""code":"invalid_input""#))
        .stderr(predicate::str::is_empty());
}

#[test]
fn blank_repository_modifiers_are_rejected_with_every_nonblank_source() {
    let sources: &[&[&str]] = &[
        &["--store", "listing"],
        &["--repository-id", "repository"],
        &["--github-repo-id", "123"],
    ];
    let modifiers: &[&[&str]] = &[
        &["--owner", "MySproutOS"],
        &["--repository-name", "example"],
        &["--private"],
    ];

    for source in sources {
        for modifier in modifiers {
            let mut command = cargo_bin_cmd!("sprout");
            command
                .args(["--json", "project", "create", "--name", "n"])
                .args(*source)
                .args(*modifier)
                .assert()
                .code(2)
                .stdout(predicate::str::contains(r#""code":"invalid_input""#))
                .stderr(predicate::str::is_empty());
        }
    }
}
