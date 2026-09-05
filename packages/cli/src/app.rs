use std::{io::Read, path::Path, time::Duration};

use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::{
    Backend, CliError, LogStreamEvent, Result, StreamOutput,
    auth::{self, BrowserLauncher},
    cli::{self, *},
    config,
    confirm::{self, Confirmation},
    credential::{self, CredentialSource, CredentialStore},
    output, request,
};

pub struct Dependencies<'a> {
    pub backend: &'a dyn Backend,
    pub credentials: &'a dyn CredentialStore,
    pub browser: &'a dyn BrowserLauncher,
    pub confirmation: &'a dyn Confirmation,
    pub config_path: &'a Path,
    pub stream_output: &'a dyn StreamOutput,
}

pub async fn run(cli: &Cli, dependencies: &Dependencies<'_>) -> Result<String> {
    cli::validate(cli)?;
    let api_url = url::Url::parse(&cli.api_url)
        .map_err(|error| CliError::InvalidInput(format!("invalid --api-url: {error}")))?;
    let account = credential::account_for(&api_url);
    let mut config = config::read(dependencies.config_path)?;

    if let Command::Auth(AuthArgs {
        command: AuthCommand::Login {
            no_open,
            timeout_seconds,
        },
    }) = &cli.command
    {
        let website_url = url::Url::parse(&cli.website_url)
            .map_err(|error| CliError::InvalidInput(format!("invalid --website-url: {error}")))?;
        let organization = auth::login(
            dependencies.backend,
            dependencies.credentials,
            dependencies.browser,
            auth::LoginOptions {
                account: &account,
                website_url: &website_url,
                open_browser: !no_open,
                deadline: Duration::from_secs(*timeout_seconds),
                show_url: &|url| eprintln!("Open this URL to authenticate:\n{url}"),
            },
        )
        .await?;
        config.organization = Some(organization.slug.clone());
        config::write(dependencies.config_path, &config)?;
        return render(
            cli,
            request::command_name(&cli.command),
            json!({"authenticated": true, "organization": organization}),
        );
    }

    if let Command::Org(OrgArgs {
        command: OrgCommand::Use { slug },
    }) = &cli.command
    {
        let credential = credential::resolve(dependencies.credentials, &account)?;
        // Verify membership/visibility before persisting a typo as the default.
        let encoded_slug: String = url::form_urlencoded::byte_serialize(slug.as_bytes()).collect();
        let response = dependencies
            .backend
            .request(
                request::ApiRequest {
                    method: request::Method::Get,
                    path: format!("/v1/orgs/{encoded_slug}"),
                    body: None,
                },
                Some(credential.expose()),
            )
            .await?;
        config.organization = Some(slug.clone());
        config::write(dependencies.config_path, &config)?;
        return render(
            cli,
            request::command_name(&cli.command),
            json!({"organization": slug, "details": response}),
        );
    }

    if let Command::Auth(AuthArgs {
        command: AuthCommand::Logout,
    }) = &cli.command
    {
        confirm::require(
            cli.yes,
            dependencies.confirmation,
            "Revoke the saved SproutOS credential?",
        )?;
        let environment_token_present =
            std::env::var("SPROUTOS_TOKEN").is_ok_and(|token| !token.is_empty());
        match dependencies.credentials.get(&account)? {
            Some(saved_token) if !saved_token.is_empty() => {
                let saved_token = Zeroizing::new(saved_token);
                // Revoke first. If the API is unavailable, retain the local credential so logout
                // can be retried instead of orphaning a still-live key that the user cannot revoke.
                dependencies
                    .backend
                    .request(
                        request::ApiRequest {
                            method: request::Method::Post,
                            path: "/v1/auth/cli/revoke".into(),
                            body: Some(json!({})),
                        },
                        Some(saved_token.as_str()),
                    )
                    .await?;
                dependencies.credentials.delete(&account)?;
                return render(
                    cli,
                    request::command_name(&cli.command),
                    json!({
                        "loggedOut": true,
                        "environmentTokenPresent": environment_token_present
                    }),
                );
            }
            Some(_) => {
                dependencies.credentials.delete(&account)?;
                return render(
                    cli,
                    request::command_name(&cli.command),
                    json!({
                        "loggedOut": true,
                        "environmentTokenPresent": environment_token_present
                    }),
                );
            }
            None => {
                return render(
                    cli,
                    request::command_name(&cli.command),
                    json!({
                        "loggedOut": true,
                        "environmentTokenPresent": environment_token_present
                    }),
                );
            }
        }
    }

    let credential = if matches!(cli.command, Command::Deploy(_)) {
        credential::resolve_deploy(dependencies.credentials, &account)?
    } else {
        credential::resolve(dependencies.credentials, &account)?
    };

    if cli::destructive(&cli.command) {
        confirm::require(
            cli.yes,
            dependencies.confirmation,
            &destructive_prompt(&cli.command),
        )?;
    }

    let organization = cli.org.as_deref().or(config.organization.as_deref());

    let mut data = match &cli.command {
        Command::Deploy(args) => {
            dependencies
                .backend
                .deploy(
                    args,
                    credential.expose(),
                    organization,
                    credential.source == CredentialSource::RepositoryDeployEnvironment,
                )
                .await?
        }
        Command::Template(TemplateArgs { command }) => {
            dependencies
                .backend
                .template(command, credential.expose())
                .await?
        }
        Command::Deployment(DeploymentArgs {
            command:
                DeploymentCommand::Wait {
                    deployment,
                    timeout_seconds,
                },
        }) => {
            wait_for_deployment(
                dependencies.backend,
                credential.expose(),
                organization,
                deployment,
                Duration::from_secs(*timeout_seconds),
            )
            .await?
        }
        Command::Logs(args) => {
            let project = resolve_log_project(
                dependencies.backend,
                credential.expose(),
                organization,
                &args.project,
            )
            .await?;
            let planned = request::plan_logs(args, organization, &project)?;
            if !args.follow {
                dependencies
                    .backend
                    .request(planned, Some(credential.expose()))
                    .await?
            } else {
                let mut emit = |event: LogStreamEvent| {
                    let rendered = if cli.json {
                        output::json_success("logs", event)?
                    } else {
                        format!(
                            "{} {:<8} {}",
                            event.line.timestamp, event.line.level, event.line.message
                        )
                    };
                    dependencies.stream_output.write_line(&rendered)
                };
                dependencies
                    .backend
                    .follow_logs(planned, credential.expose(), &mut emit)
                    .await?;
                return Ok(String::new());
            }
        }
        _ => {
            let stdin_value = read_stdin_value(&cli.command)?;
            let planned =
                request::plan(&cli.command, organization, stdin_value)?.ok_or_else(|| {
                    CliError::Unavailable(format!(
                        "{} has no runtime implementation",
                        request::command_name(&cli.command)
                    ))
                })?;
            dependencies
                .backend
                .request(planned, Some(credential.expose()))
                .await?
        }
    };

    if let Command::Auth(AuthArgs {
        command: AuthCommand::Status,
    }) = &cli.command
    {
        data = json!({
            "authenticated": true,
            "credentialSource": match credential.source {
                CredentialSource::Environment => "environment",
                CredentialSource::RepositoryDeployEnvironment => "repository_deploy_environment",
                CredentialSource::OsCredentialStore => "os_credential_store",
            },
            "identity": data,
        });
    }
    if let Command::Service(ServiceArgs {
        command: ServiceCommand::Get { service },
    }) = &cli.command
    {
        let found = data
            .get("data")
            .and_then(Value::as_array)
            .and_then(|rows| {
                rows.iter().find(|row| {
                    row.get("id").and_then(Value::as_str) == Some(service)
                        || row.get("name").and_then(Value::as_str) == Some(service)
                })
            })
            .cloned()
            .ok_or_else(|| CliError::Api(format!("service `{service}` was not found")))?;
        data = found;
    }
    render(cli, request::command_name(&cli.command), data)
}

async fn resolve_log_project(
    backend: &dyn Backend,
    token: &str,
    organization: Option<&str>,
    project: &str,
) -> Result<String> {
    if uuid::Uuid::parse_str(project).is_ok() {
        return Ok(project.to_owned());
    }

    let mut cursor: Option<String> = None;
    loop {
        let response = backend
            .request(
                request::plan_project_list(organization, None, cursor.as_deref(), 100)?,
                Some(token),
            )
            .await?;
        let rows = response
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| CliError::Api("project list returned an invalid response".into()))?;
        if let Some(row) = rows
            .iter()
            .find(|row| row.get("slug").and_then(Value::as_str) == Some(project))
        {
            return row
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                .map(str::to_owned)
                .ok_or_else(|| {
                    CliError::Api("project list returned an invalid project id".into())
                });
        }

        let next_cursor = match response.get("nextCursor") {
            None | Some(Value::Null) => break,
            Some(Value::String(next)) if !next.is_empty() => next.clone(),
            _ => {
                return Err(CliError::Api(
                    "project list returned an invalid pagination cursor".into(),
                ));
            }
        };
        if cursor.as_deref() == Some(next_cursor.as_str()) {
            return Err(CliError::Api(
                "project list repeated its pagination cursor".into(),
            ));
        }
        cursor = Some(next_cursor);
    }

    Err(CliError::InvalidInput(format!(
        "project `{project}` was not found in the selected organization"
    )))
}

async fn wait_for_deployment(
    backend: &dyn Backend,
    token: &str,
    organization: Option<&str>,
    deployment: &str,
    deadline: Duration,
) -> Result<Value> {
    let started = tokio::time::Instant::now();
    loop {
        let request = request::plan(
            &Command::Deployment(DeploymentArgs {
                command: DeploymentCommand::Get {
                    deployment: deployment.into(),
                },
            }),
            organization,
            None,
        )?
        .expect("deployment get always plans an API request");
        let status = backend.request(request, Some(token)).await?;
        match status.get("status").and_then(Value::as_str) {
            Some("ready") => return Ok(status),
            Some("error" | "torn_down") => {
                let reason = status
                    .get("failureReason")
                    .and_then(Value::as_str)
                    .unwrap_or("deployment ended without a failure reason");
                return Err(CliError::DeploymentFailed(format!(
                    "deployment `{deployment}`: {reason}"
                )));
            }
            Some("queued" | "building" | "deploying") => {}
            Some(other) => {
                return Err(CliError::Api(format!(
                    "deployment `{deployment}` returned unknown status `{other}`"
                )));
            }
            None => {
                return Err(CliError::Api(
                    "deployment response did not contain a status".into(),
                ));
            }
        }
        if started.elapsed() >= deadline {
            return Err(CliError::Timeout(format!(
                "waiting for deployment `{deployment}`"
            )));
        }
        tokio::time::sleep(Duration::from_secs(5).min(deadline.saturating_sub(started.elapsed())))
            .await;
    }
}

fn destructive_prompt(command: &Command) -> String {
    match command {
        Command::Project(ProjectArgs {
            command: ProjectCommand::Delete { project },
        }) => format!("Delete project `{project}` and queue its teardown?"),
        Command::Env(EnvArgs {
            command: EnvCommand::Unset {
                project, env_id, ..
            },
        }) => format!("Unset environment variable `{env_id}` from project `{project}`?"),
        Command::Service(ServiceArgs {
            command: ServiceCommand::Delete { service },
        }) => format!("Delete service `{service}` and its stored data?"),
        Command::Template(TemplateArgs {
            command: TemplateCommand::Apply { workspace, .. },
        }) => format!(
            "Apply the signed deployment template to `{}`?",
            workspace.display()
        ),
        _ => format!("Continue with {}?", request::command_name(command)),
    }
}

fn read_stdin_value(command: &Command) -> Result<Option<String>> {
    let trim_trailing_newline = matches!(
        command,
        Command::Env(EnvArgs {
            command: EnvCommand::Set { stdin: true, .. }
        })
    );
    let reads_stdin = trim_trailing_newline
        || matches!(
            command,
            Command::Project(ProjectArgs {
                command: ProjectCommand::Create(args)
            }) if args
                .template_input_file
                .as_deref()
                .is_some_and(|path| path.as_os_str() == "-")
        );
    if reads_stdin {
        let mut value = String::new();
        std::io::stdin()
            .read_to_string(&mut value)
            .map_err(|error| CliError::Configuration(error.to_string()))?;
        if trim_trailing_newline {
            while value.ends_with(['\n', '\r']) {
                value.pop();
            }
        }
        return Ok(Some(value));
    }
    Ok(None)
}

fn render(cli: &Cli, command: &str, data: Value) -> Result<String> {
    if cli.json {
        output::json_success(command, data)
    } else if let Some(message) = human_summary(command, &data) {
        Ok(message)
    } else {
        serde_json::to_string_pretty(&data)
            .map_err(|error| CliError::Configuration(format!("could not render output: {error}")))
    }
}

fn human_summary(command: &str, data: &Value) -> Option<String> {
    match command {
        "org.use" => Some(format!(
            "Using organization {}",
            data.get("organization")?.as_str()?
        )),
        "auth.login" => Some(format!(
            "Authenticated to organization {}",
            data.pointer("/organization/slug")?.as_str()?
        )),
        "auth.logout" => Some(if data.get("environmentTokenPresent")?.as_bool()? {
            "Removed the saved credential. SPROUTOS_TOKEN is still set and was not modified.".into()
        } else {
            "Logged out.".into()
        }),
        "template.resolve" => Some(format!(
            "Resolved {} at {} to {} for {} (catalogue source {}).",
            data.get("template_id")?.as_str()?,
            data.get("upstream_commit")?.as_str()?,
            data.get("plugin_digest")?.as_str()?,
            data.get("target")?.as_str()?,
            data.pointer("/provenance/source_commit")?.as_str()?
        )),
        "template.verify" => Some(format!(
            "Verified {} at {} as {} for {} (catalogue source {}, platform manifest {}).",
            data.get("template_id")?.as_str()?,
            data.get("upstream_commit")?.as_str()?,
            data.get("plugin_digest")?.as_str()?,
            data.get("target")?.as_str()?,
            data.get("source_commit")?.as_str()?,
            data.get("manifest_digest")?.as_str()?
        )),
        "template.apply" => Some(format!(
            "Applied verified template {} at {}; {} workspace change(s).",
            data.pointer("/verification/template_id")?.as_str()?,
            data.pointer("/verification/upstream_commit")?.as_str()?,
            data.pointer("/result/changes")?.as_array()?.len()
        )),
        _ => None,
    }
}

pub fn default_config_path() -> Result<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("SPROUTOS_CONFIG") {
        Ok(path.into())
    } else {
        config::default_path()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{auth::BrowserLauncher, confirm::Confirmation};
    use async_trait::async_trait;
    use clap::Parser;
    use std::{collections::HashMap, sync::Mutex};

    #[derive(Default)]
    struct FakeStore(Mutex<HashMap<String, String>>);
    impl CredentialStore for FakeStore {
        fn get(&self, account: &str) -> Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, token: &str) -> Result<()> {
            self.0.lock().unwrap().insert(account.into(), token.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<()> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }
    struct NeverBrowser;
    impl BrowserLauncher for NeverBrowser {
        fn open(&self, _: &url::Url) -> Result<()> {
            panic!("unexpected browser")
        }
    }
    struct Yes;
    impl Confirmation for Yes {
        fn confirm(&self, _: &str) -> Result<bool> {
            Ok(true)
        }
    }
    #[derive(Default)]
    struct CapturedStream(Mutex<Vec<String>>);
    impl StreamOutput for CapturedStream {
        fn write_line(&self, line: &str) -> Result<()> {
            self.0.lock().unwrap().push(line.to_owned());
            Ok(())
        }
    }
    struct FakeBackend(Mutex<Vec<request::ApiRequest>>);
    #[async_trait]
    impl Backend for FakeBackend {
        async fn request(
            &self,
            request: request::ApiRequest,
            token: Option<&str>,
        ) -> Result<Value> {
            assert_eq!(token, Some("canary-token"));
            self.0.lock().unwrap().push(request);
            Ok(json!({"data": []}))
        }
    }

    struct FailingBackend;
    #[async_trait]
    impl Backend for FailingBackend {
        async fn request(
            &self,
            _request: request::ApiRequest,
            _token: Option<&str>,
        ) -> Result<Value> {
            Err(CliError::Api("offline".into()))
        }
    }

    struct FollowingBackend;
    #[async_trait]
    impl Backend for FollowingBackend {
        async fn request(
            &self,
            _request: request::ApiRequest,
            _token: Option<&str>,
        ) -> Result<Value> {
            panic!("follow mode must not use the buffered request adapter")
        }

        async fn follow_logs(
            &self,
            request: request::ApiRequest,
            token: &str,
            emit: &mut (dyn FnMut(LogStreamEvent) -> Result<()> + Send),
        ) -> Result<()> {
            assert_eq!(token, "canary-token");
            assert_eq!(request.method, request::Method::Get);
            assert_eq!(
                request.path,
                "/v1/orgs/acme/projects/01a03b96-a3d3-71f5-9f1d-af7569938433/logs/follow?since=2026-08-28T12%3A00%3A00Z&limit=100"
            );
            emit_ready(emit)
        }
    }

    struct SlugFollowingBackend(Mutex<Vec<request::ApiRequest>>);
    #[async_trait]
    impl Backend for SlugFollowingBackend {
        async fn request(
            &self,
            request: request::ApiRequest,
            token: Option<&str>,
        ) -> Result<Value> {
            assert_eq!(token, Some("canary-token"));
            assert_eq!(request.path, "/v1/orgs/acme/projects?limit=100");
            self.0.lock().unwrap().push(request);
            Ok(json!({
                "data": [{
                    "id": "01a03b96-a3d3-71f5-9f1d-af7569938433",
                    "slug": "project-1"
                }],
                "nextCursor": null
            }))
        }

        async fn follow_logs(
            &self,
            request: request::ApiRequest,
            token: &str,
            emit: &mut (dyn FnMut(LogStreamEvent) -> Result<()> + Send),
        ) -> Result<()> {
            assert_eq!(token, "canary-token");
            assert_eq!(
                request.path,
                "/v1/orgs/acme/projects/01a03b96-a3d3-71f5-9f1d-af7569938433/logs/follow?limit=100"
            );
            emit_ready(emit)
        }
    }

    fn emit_ready(emit: &mut (dyn FnMut(LogStreamEvent) -> Result<()> + Send)) -> Result<()> {
        let cursor = format!("1:1787918400000:{}", "A".repeat(64));
        emit(LogStreamEvent {
            schema_version: 1,
            kind: "log".into(),
            cursor: cursor.clone(),
            line: crate::LogLine {
                timestamp: "2026-08-28T12:00:00.000Z".into(),
                cursor,
                level: "info".into(),
                message: "ready".into(),
                request_id: "request-1".into(),
                deployment_id: "deployment-1".into(),
                duration_ms: None,
                billed_ms: None,
                memory_mb: None,
                init_ms: None,
                cold_start: None,
            },
        })
    }

    #[tokio::test]
    async fn json_mode_is_one_versioned_document_and_token_is_absent() {
        let directory = tempfile::tempdir().unwrap();
        let store = FakeStore::default();
        let account = credential::account_for(&url::Url::parse("https://api.sproutos.me").unwrap());
        store.set(&account, "canary-token").unwrap();
        let backend = FakeBackend(Mutex::new(Vec::new()));
        let stream = CapturedStream::default();
        let cli = Cli::parse_from(["sprout", "--json", "org", "list"]);
        let rendered = run(
            &cli,
            &Dependencies {
                backend: &backend,
                credentials: &store,
                browser: &NeverBrowser,
                confirmation: &Yes,
                config_path: &directory.path().join("config.json"),
                stream_output: &stream,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            rendered,
            r#"{"schema_version":1,"ok":true,"command":"org.list","data":{"data":[]}}"#
        );
        assert!(!rendered.contains("canary-token"));
    }

    #[tokio::test]
    async fn org_use_verifies_before_persisting() {
        let directory = tempfile::tempdir().unwrap();
        let store = FakeStore::default();
        let account = credential::account_for(&url::Url::parse("https://api.sproutos.me").unwrap());
        store.set(&account, "canary-token").unwrap();
        let backend = FakeBackend(Mutex::new(Vec::new()));
        let stream = CapturedStream::default();
        let cli = Cli::parse_from(["sprout", "org", "use", "acme"]);
        run(
            &cli,
            &Dependencies {
                backend: &backend,
                credentials: &store,
                browser: &NeverBrowser,
                confirmation: &Yes,
                config_path: &directory.path().join("config.json"),
                stream_output: &stream,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            config::read(&directory.path().join("config.json"))
                .unwrap()
                .organization
                .as_deref(),
            Some("acme")
        );
        assert_eq!(backend.0.lock().unwrap()[0].path, "/v1/orgs/acme");
    }

    #[tokio::test]
    async fn logout_keeps_saved_key_when_revocation_fails() {
        let directory = tempfile::tempdir().unwrap();
        let store = FakeStore::default();
        let account = credential::account_for(&url::Url::parse("https://api.sproutos.me").unwrap());
        store.set(&account, "canary-token").unwrap();
        let cli = Cli::parse_from(["sprout", "--yes", "auth", "logout"]);
        let stream = CapturedStream::default();
        assert!(
            run(
                &cli,
                &Dependencies {
                    backend: &FailingBackend,
                    credentials: &store,
                    browser: &NeverBrowser,
                    confirmation: &Yes,
                    config_path: &directory.path().join("config.json"),
                    stream_output: &stream,
                },
            )
            .await
            .is_err()
        );
        assert_eq!(
            store.get(&account).unwrap().as_deref(),
            Some("canary-token")
        );
    }

    #[tokio::test]
    async fn follow_logs_uses_the_stream_adapter_and_writes_versioned_jsonl() {
        let directory = tempfile::tempdir().unwrap();
        let store = FakeStore::default();
        let account = credential::account_for(&url::Url::parse("https://api.sproutos.me").unwrap());
        store.set(&account, "canary-token").unwrap();
        let stream = CapturedStream::default();
        let cli = Cli::parse_from([
            "sprout",
            "--json",
            "--org",
            "acme",
            "logs",
            "01a03b96-a3d3-71f5-9f1d-af7569938433",
            "--follow",
            "--since",
            "2026-08-28T12:00:00Z",
        ]);

        let rendered = run(
            &cli,
            &Dependencies {
                backend: &FollowingBackend,
                credentials: &store,
                browser: &NeverBrowser,
                confirmation: &Yes,
                config_path: &directory.path().join("config.json"),
                stream_output: &stream,
            },
        )
        .await
        .unwrap();

        assert!(rendered.is_empty());
        let output = stream.0.lock().unwrap();
        assert_eq!(output.len(), 1);
        let line: Value = serde_json::from_str(&output[0]).unwrap();
        assert_eq!(line["schema_version"], 1);
        assert_eq!(line["command"], "logs");
        assert_eq!(line["data"]["type"], "log");
        assert_eq!(line["data"]["line"]["message"], "ready");
        assert!(!output[0].contains("canary-token"));
    }

    #[tokio::test]
    async fn follow_logs_resolves_a_slug_before_opening_the_stream() {
        let directory = tempfile::tempdir().unwrap();
        let store = FakeStore::default();
        let account = credential::account_for(&url::Url::parse("https://api.sproutos.me").unwrap());
        store.set(&account, "canary-token").unwrap();
        let backend = SlugFollowingBackend(Mutex::new(Vec::new()));
        let stream = CapturedStream::default();
        let cli = Cli::parse_from(["sprout", "--org", "acme", "logs", "project-1", "--follow"]);

        let rendered = run(
            &cli,
            &Dependencies {
                backend: &backend,
                credentials: &store,
                browser: &NeverBrowser,
                confirmation: &Yes,
                config_path: &directory.path().join("config.json"),
                stream_output: &stream,
            },
        )
        .await
        .unwrap();

        assert!(rendered.is_empty());
        assert_eq!(backend.0.lock().unwrap().len(), 1);
        assert_eq!(stream.0.lock().unwrap().len(), 1);
    }
}
