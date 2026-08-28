use assert_cmd::cargo::cargo_bin_cmd;
use predicates::prelude::*;

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
fn template_failure_is_structured_and_does_not_leak_token() {
    let directory = tempfile::tempdir().unwrap();
    let mut command = cargo_bin_cmd!("sprout");
    command
        .env("SPROUTOS_TOKEN", "canary-secret-never-print")
        .env("SPROUTOS_CONFIG", directory.path().join("config.json"))
        .args([
            "--json",
            "template",
            "verify",
            "starter",
            "--upstream-commit",
            "0123456789012345678901234567890123456789",
        ])
        .assert()
        .code(1)
        .stdout(
            predicate::str::contains(r#""code":"isolation_unavailable""#)
                .and(predicate::str::contains("canary-secret-never-print").not()),
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
