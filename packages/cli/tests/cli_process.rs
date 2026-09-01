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

fn published_umami_platform_manifest() -> &'static str {
    match current_target() {
        "darwin_arm64" => "sha256:50415a8248652404d151f03d89d5b747668c13c9b8ebf2376a7be55b51547b8a",
        "darwin_amd64" => "sha256:c67a3c14042f8cef6f071e2407e216fb1dbde3359a49e0a7f31fe70e6dbb9a04",
        "linux_arm64_musl" => {
            "sha256:a7d10f0a0142b2669c81d419473a7c569a168e7b93b8492f25011305edf5e2e2"
        }
        "linux_amd64_musl" => {
            "sha256:83fce5a39a3bf2d806d5315503a4b74483833e77ec52e2eff76aab2c77dbf5d1"
        }
        "windows_amd64" => {
            "sha256:387371c24249692b5a603c15f8e13e3b30aac7377152b1533634aeb34d04b87b"
        }
        target => panic!("unsupported published target: {target}"),
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

fn published_umami_resolution() -> Value {
    let plugin_digest = "sha256:ef4b3edd3fba984e95a6cde3508168f01f9a6dcd8820a097d990ef0d82902357";
    json!({
        "template_id": "umami",
        "upstream_commit": "ca661c7057984aa98ed4f7083d84dae2f65bfcb0",
        "plugin_reference": format!("ghcr.io/mysproutos/umami-plugin@{plugin_digest}"),
        "plugin_digest": plugin_digest,
        "target": current_target(),
        "provenance": {
            "repository": "MySproutOS/Deployment-Templates",
            "workflow": ".github/workflows/publish.yml",
            "git_ref": "refs/heads/main",
            "source_commit": "f1e3c82321527059ae6e76f464494f1b6c89a9d0",
            "oidc_issuer": "https://token.actions.githubusercontent.com",
            "workflow_identity": "MySproutOS/Deployment-Templates/.github/workflows/publish.yml@refs/heads/main",
            "github_hosted_runner": true
        },
        "request": {
            "protocol_version": 1,
            "workspace": "/workspace",
            "template": {
                "id": "umami",
                "catalogue_digest": "sha256:3d680af294507bcac03df5d3eb4c28c4c2c74e34413444db7609c75d20d58694",
                "manifest_digest": "sha256:13936900135adfc54914f84eca8f25d90cab72052fbfe48133eed48c3b22f3c4",
                "plugin_digest": plugin_digest,
                "upstream_repository": "https://github.com/umami-software/umami",
                "upstream_commit": "ca661c7057984aa98ed4f7083d84dae2f65bfcb0"
            },
            "deployment": {"preset": "next", "capabilities": ["controlled_migrations", "next_standalone"]},
            "services": [{
                "key": "postgres",
                "kind": "postgres",
                "bindings": [{"environment": "DATABASE_URL", "output": "connection_url"}]
            }],
            "user_inputs": [],
            "generated_inputs": [{
                "key": "app_secret",
                "generator": "random_base64url",
                "bytes": 32,
                "environment": "APP_SECRET"
            }]
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

#[test]
#[ignore = "downloads and verifies the immutable published OCI plugin under native isolation"]
fn published_oci_attestation_isolation_and_plugin_apply_end_to_end() {
    if std::env::var_os("SPROUT_CLI_RUN_SIGNED_TEMPLATE_E2E").is_none() {
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join(".git")).unwrap();
    let config = directory.path().join("config.json");
    let upstream = "ca661c7057984aa98ed4f7083d84dae2f65bfcb0";

    for expected_change_count in [7, 0] {
        let (api_url, _) = serve_once(published_umami_resolution());
        let mut command = cargo_bin_cmd!("sprout");
        let output = command
            .env("SPROUTOS_TOKEN", "signed-e2e-redaction-canary")
            .env("SPROUTOS_CONFIG", &config)
            .args([
                "--json",
                "--yes",
                "--api-url",
                &api_url,
                "template",
                "apply",
                "umami",
                "--upstream-commit",
                upstream,
                "--workspace",
                directory.path().to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "template apply failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let document: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            document
                .pointer("/data/result/changes")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            expected_change_count
        );
        let selected = document
            .pointer("/data/verification/manifest_digest")
            .unwrap()
            .as_str()
            .unwrap();
        assert_eq!(
            selected,
            published_umami_platform_manifest(),
            "the result must store the exact selected platform manifest, not the root index"
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains("signed-e2e-redaction-canary"));
    }
    assert!(directory.path().join(".config/sproutos.toml").is_file());
    assert!(
        directory
            .path()
            .join(".github/workflows/sproutos-deploy.yml")
            .is_file()
    );
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

#[test]
fn log_transport_failure_does_not_leak_request_query_or_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        use std::io::Write as _;

        // Send malformed response headers on every bounded retry. This deterministically
        // exercises reqwest's real request error without waiting for a network timeout.
        for _ in 0..8 {
            let (mut stream, _) = listener.accept().unwrap();
            stream.write_all(b"HTTP/1.1 nope\r\n\r\n").unwrap();
        }
    });
    let mut command = cargo_bin_cmd!("sprout");
    command
        .env("SPROUTOS_TOKEN", "PRIVATE-BEARER-CANARY")
        .env("SPROUTOS_ORG", "acme")
        .env("SPROUTOS_CONFIG", directory.path().join("config.json"))
        .args([
            "--api-url",
            &format!("http://{address}"),
            "logs",
            "project-1",
            "--follow",
            "--search",
            "PRIVATE-SEARCH-CANARY",
        ])
        .assert()
        .code(1)
        .stdout(predicate::str::is_empty())
        .stderr(
            predicate::str::contains("transport failed before response headers")
                .and(predicate::str::contains("PRIVATE-SEARCH-CANARY").not())
                .and(predicate::str::contains("PRIVATE-BEARER-CANARY").not())
                .and(predicate::str::contains("127.0.0.1").not())
                .and(predicate::str::contains("search=").not())
                .and(predicate::str::contains("authorization").not()),
        );
    server.join().unwrap();
}
