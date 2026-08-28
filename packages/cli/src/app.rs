use std::{io::Read, path::Path, time::Duration};

use serde_json::{Value, json};

use crate::{
    Backend, CliError, Result,
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
        let credential = credential::resolve(dependencies.credentials, &account);
        dependencies.credentials.delete(&account)?;
        match credential {
            Ok(credential) if credential.source == CredentialSource::OsCredentialStore => {
                dependencies
                    .backend
                    .request(
                        request::ApiRequest {
                            method: request::Method::Post,
                            path: "/v1/auth/cli/revoke".into(),
                            body: Some(json!({})),
                        },
                        Some(credential.expose()),
                    )
                    .await?;
                return render(
                    cli,
                    request::command_name(&cli.command),
                    json!({"loggedOut": true, "environmentTokenPresent": false}),
                );
            }
            Ok(_) => {
                return render(
                    cli,
                    request::command_name(&cli.command),
                    json!({"loggedOut": false, "environmentTokenPresent": true}),
                );
            }
            Err(CliError::AuthenticationRequired) => {
                return render(
                    cli,
                    request::command_name(&cli.command),
                    json!({"loggedOut": true, "environmentTokenPresent": false}),
                );
            }
            Err(error) => return Err(error),
        }
    }

    let credential = credential::resolve(dependencies.credentials, &account)?;

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
                .deploy(args, credential.expose())
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
        Command::Logs(LogsArgs { follow: true, .. }) => {
            return Err(CliError::Unavailable(
                "continuous log streaming does not have a stable JSONL contract yet; omit --follow"
                    .into(),
            ));
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
        _ => format!("Continue with {}?", request::command_name(command)),
    }
}

fn read_stdin_value(command: &Command) -> Result<Option<String>> {
    if matches!(
        command,
        Command::Env(EnvArgs {
            command: EnvCommand::Set { stdin: true, .. }
        })
    ) {
        let mut value = String::new();
        std::io::stdin()
            .read_to_string(&mut value)
            .map_err(|error| CliError::Configuration(error.to_string()))?;
        while value.ends_with(['\n', '\r']) {
            value.pop();
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

    #[tokio::test]
    async fn json_mode_is_one_versioned_document_and_token_is_absent() {
        let directory = tempfile::tempdir().unwrap();
        let store = FakeStore::default();
        let account =
            credential::account_for(&url::Url::parse("https://api.sproutos.com").unwrap());
        store.set(&account, "canary-token").unwrap();
        let backend = FakeBackend(Mutex::new(Vec::new()));
        let cli = Cli::parse_from(["sprout", "--json", "org", "list"]);
        let rendered = run(
            &cli,
            &Dependencies {
                backend: &backend,
                credentials: &store,
                browser: &NeverBrowser,
                confirmation: &Yes,
                config_path: &directory.path().join("config.json"),
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
        let account =
            credential::account_for(&url::Url::parse("https://api.sproutos.com").unwrap());
        store.set(&account, "canary-token").unwrap();
        let backend = FakeBackend(Mutex::new(Vec::new()));
        let cli = Cli::parse_from(["sprout", "org", "use", "acme"]);
        run(
            &cli,
            &Dependencies {
                backend: &backend,
                credentials: &store,
                browser: &NeverBrowser,
                confirmation: &Yes,
                config_path: &directory.path().join("config.json"),
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
}
