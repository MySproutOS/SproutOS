use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{CliError, Result, cli::*};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ApiRequest {
    pub method: Method,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<Value>,
}

pub fn validate_relative_api_path(path: &str) -> Result<()> {
    if path.is_empty() {
        return Err(CliError::InvalidInput("API path cannot be empty".into()));
    }
    if path.starts_with("//") || url::Url::parse(path).is_ok() {
        return Err(CliError::InvalidInput(
            "API path must be relative to the configured API origin".into(),
        ));
    }
    if !path.starts_with('/') {
        return Err(CliError::InvalidInput(
            "API path must start with `/`".into(),
        ));
    }
    if path.chars().any(char::is_control) {
        return Err(CliError::InvalidInput(
            "API path contains a control character".into(),
        ));
    }
    Ok(())
}

pub fn command_name(command: &Command) -> &'static str {
    match command {
        Command::Auth(AuthArgs {
            command: AuthCommand::Login { .. },
        }) => "auth.login",
        Command::Auth(AuthArgs {
            command: AuthCommand::Logout,
        }) => "auth.logout",
        Command::Auth(AuthArgs {
            command: AuthCommand::Status,
        }) => "auth.status",
        Command::Org(OrgArgs {
            command: OrgCommand::List,
        }) => "org.list",
        Command::Org(OrgArgs {
            command: OrgCommand::Use { .. },
        }) => "org.use",
        Command::Region(RegionArgs {
            command: RegionCommand::List,
        }) => "region.list",
        Command::Project(ProjectArgs {
            command: ProjectCommand::List { .. },
        }) => "project.list",
        Command::Project(ProjectArgs {
            command: ProjectCommand::Get { .. },
        }) => "project.get",
        Command::Project(ProjectArgs {
            command: ProjectCommand::Create(_),
        }) => "project.create",
        Command::Project(ProjectArgs {
            command: ProjectCommand::Update(_),
        }) => "project.update",
        Command::Project(ProjectArgs {
            command: ProjectCommand::Delete { .. },
        }) => "project.delete",
        Command::Env(EnvArgs {
            command: EnvCommand::List { .. },
        }) => "env.list",
        Command::Env(EnvArgs {
            command: EnvCommand::Set { .. },
        }) => "env.set",
        Command::Env(EnvArgs {
            command: EnvCommand::Unset { .. },
        }) => "env.unset",
        Command::Service(ServiceArgs {
            command: ServiceCommand::List,
        }) => "service.list",
        Command::Service(ServiceArgs {
            command: ServiceCommand::Create { .. },
        }) => "service.create",
        Command::Service(ServiceArgs {
            command: ServiceCommand::Get { .. },
        }) => "service.get",
        Command::Service(ServiceArgs {
            command: ServiceCommand::Delete { .. },
        }) => "service.delete",
        Command::Deploy(_) => "deploy",
        Command::Deployment(DeploymentArgs {
            command: DeploymentCommand::List { .. },
        }) => "deployment.list",
        Command::Deployment(DeploymentArgs {
            command: DeploymentCommand::Get { .. },
        }) => "deployment.get",
        Command::Deployment(DeploymentArgs {
            command: DeploymentCommand::Wait { .. },
        }) => "deployment.wait",
        Command::Logs(_) => "logs",
        Command::Android(AndroidArgs {
            command: AndroidCommand::Setup { .. },
        }) => "android.setup",
        Command::Android(AndroidArgs {
            command: AndroidCommand::Status { .. },
        }) => "android.status",
        Command::Android(AndroidArgs {
            command: AndroidCommand::Verify { .. },
        }) => "android.verify",
        Command::Api(_) => "api",
        Command::Template(TemplateArgs {
            command: TemplateCommand::Resolve { .. },
        }) => "template.resolve",
        Command::Template(TemplateArgs {
            command: TemplateCommand::Apply { .. },
        }) => "template.apply",
        Command::Template(TemplateArgs {
            command: TemplateCommand::Verify { .. },
        }) => "template.verify",
    }
}

pub fn plan(
    command: &Command,
    org: Option<&str>,
    stdin_value: Option<String>,
) -> Result<Option<ApiRequest>> {
    let request = match command {
        Command::Auth(AuthArgs {
            command: AuthCommand::Status,
        }) => api(Method::Get, "/v1/auth/me", None),
        Command::Auth(AuthArgs {
            command: AuthCommand::Logout,
        }) => api(
            Method::Post,
            "/v1/auth/cli/revoke",
            Some(serde_json::json!({})),
        ),
        Command::Org(OrgArgs {
            command: OrgCommand::List,
        }) => api(Method::Get, "/v1/orgs", None),
        Command::Region(RegionArgs {
            command: RegionCommand::List,
        }) => api(Method::Get, "/v1/regions", None),
        Command::Project(ProjectArgs {
            command:
                ProjectCommand::List {
                    repository_id,
                    cursor,
                    limit,
                },
        }) => {
            let mut path = org_path(org, "/projects")?;
            add_query(
                &mut path,
                [
                    ("repositoryId", repository_id.as_deref()),
                    ("cursor", cursor.as_deref()),
                    ("limit", Some(limit.to_string()).as_deref()),
                ],
            );
            api(Method::Get, path, None)
        }
        Command::Project(ProjectArgs {
            command: ProjectCommand::Get { project },
        }) => api(
            Method::Get,
            format!("{}/projects/{}", org_path(org, "")?, segment(project)),
            None,
        ),
        Command::Project(ProjectArgs {
            command: ProjectCommand::Create(args),
        }) => {
            let visibility = if args.source.private {
                Some(true)
            } else if args.source.public {
                Some(false)
            } else {
                None
            };
            let mut source = if let Some(id) = &args.source.store {
                let mut source = serde_json::json!({"type": "store", "storeListingId": id});
                insert_option(&mut source, "ownerLogin", args.source.owner.clone());
                insert_option(
                    &mut source,
                    "repositoryName",
                    args.source.repository_name.clone(),
                );
                insert_option(&mut source, "private", visibility);
                source
            } else if let Some(id) = &args.source.repository_id {
                serde_json::json!({"type": "repository", "repositoryId": id})
            } else if let Some(id) = &args.source.github_repo_id {
                serde_json::json!({"type": "repository", "githubRepoId": id})
            } else {
                let mut source = serde_json::json!({"type": "blank"});
                insert_option(&mut source, "ownerLogin", args.source.owner.clone());
                insert_option(
                    &mut source,
                    "repositoryName",
                    args.source.repository_name.clone(),
                );
                insert_option(&mut source, "private", visibility);
                insert_option(
                    &mut source,
                    "templateOwner",
                    args.source.template_owner.clone(),
                );
                insert_option(
                    &mut source,
                    "templateRepo",
                    args.source.template_repo.clone(),
                );
                source
            };
            insert_option(
                &mut source,
                "upstreamFullName",
                args.source.upstream.clone(),
            );
            let mut body = serde_json::json!({
                "name": args.name,
                "region": args.region,
                "kind": enum_name(args.kind),
                "source": source,
            });
            insert_option(&mut body, "description", args.description.clone());
            insert_option(&mut body, "slug", args.slug.clone());
            insert_option(&mut body, "rootDir", args.root_dir.clone());
            insert_option(&mut body, "dockerfilePath", args.dockerfile_path.clone());
            insert_option(
                &mut body,
                "productionBranch",
                args.production_branch.clone(),
            );
            insert_option(
                &mut body,
                "agentCredentialId",
                args.agent_credential.clone(),
            );
            if args.auto_update {
                body["autoUpdateEnabled"] = Value::Bool(true);
            } else if args.no_auto_update {
                body["autoUpdateEnabled"] = Value::Bool(false);
            }
            insert_option(
                &mut body,
                "autoUpdateCadence",
                args.auto_update_cadence.map(enum_name),
            );
            insert_option(
                &mut body,
                "autoUpdateMode",
                args.auto_update_mode.map(enum_name),
            );
            if args.sync_upstream_now {
                body["syncUpstreamNow"] = Value::Bool(true);
            }
            insert_option(&mut body, "scaleMode", args.scale.map(enum_name));
            insert_option(&mut body, "idempotencyKey", args.idempotency_key.clone());
            if args.group {
                body["isGroup"] = Value::Bool(true);
            }
            insert_option(&mut body, "parentProjectId", args.parent_project.clone());
            if let Some(path) = &args.template_input_file {
                let input = if path.as_os_str() == "-" {
                    stdin_value.clone().ok_or_else(|| {
                        CliError::InvalidInput(
                            "--template-input-file - did not receive JSON on stdin".into(),
                        )
                    })?
                } else {
                    // The file contents can contain customer secrets. Never include them in an
                    // error, human output, or the request URL.
                    std::fs::read_to_string(path).map_err(|error| {
                        CliError::Configuration(format!(
                            "could not read template input file {}: {error}",
                            path.display()
                        ))
                    })?
                };
                let inputs: Value = serde_json::from_str(&input).map_err(|error| {
                    CliError::InvalidInput(format!("template input file is not JSON: {error}"))
                })?;
                if !inputs.is_array() {
                    return Err(CliError::InvalidInput(
                        "template input file must contain a JSON array".into(),
                    ));
                }
                body["templateInputs"] = inputs;
            }
            api(Method::Post, org_path(org, "/projects")?, Some(body))
        }
        Command::Project(ProjectArgs {
            command: ProjectCommand::Update(args),
        }) => {
            let mut body = serde_json::json!({});
            insert_option(&mut body, "name", args.name.clone());
            if args.clear_description {
                body["description"] = Value::Null;
            } else {
                insert_option(&mut body, "description", args.description.clone());
            }
            insert_option(&mut body, "region", args.region.clone());
            insert_option(&mut body, "slug", args.slug.clone());
            insert_option(&mut body, "rootDir", args.root_dir.clone());
            insert_option(&mut body, "dockerfilePath", args.dockerfile_path.clone());
            insert_option(
                &mut body,
                "productionBranch",
                args.production_branch.clone(),
            );
            insert_option(&mut body, "scaleMode", args.scale.map(enum_name));
            if args.no_agent_credential {
                body["agentCredentialId"] = Value::Null;
            } else {
                insert_option(
                    &mut body,
                    "agentCredentialId",
                    args.agent_credential.clone(),
                );
            }
            if args.auto_update {
                body["autoUpdateEnabled"] = Value::Bool(true);
            } else if args.no_auto_update {
                body["autoUpdateEnabled"] = Value::Bool(false);
            }
            insert_option(
                &mut body,
                "autoUpdateCadence",
                args.auto_update_cadence.map(enum_name),
            );
            insert_option(
                &mut body,
                "autoUpdateMode",
                args.auto_update_mode.map(enum_name),
            );
            if args.no_parent {
                body["parentProjectId"] = Value::Null;
            } else {
                insert_option(&mut body, "parentProjectId", args.parent_project.clone());
            }
            if args.group {
                body["isGroup"] = Value::Bool(true);
            } else if args.no_group {
                body["isGroup"] = Value::Bool(false);
            }
            if args.no_primary_child {
                body["primaryChildProjectId"] = Value::Null;
            } else {
                insert_option(
                    &mut body,
                    "primaryChildProjectId",
                    args.primary_child.clone(),
                );
            }
            api(
                Method::Patch,
                format!("{}/projects/{}", org_path(org, "")?, segment(&args.project)),
                Some(body),
            )
        }
        Command::Project(ProjectArgs {
            command: ProjectCommand::Delete { project },
        }) => api(
            Method::Delete,
            format!("{}/projects/{}", org_path(org, "")?, segment(project)),
            None,
        ),
        Command::Env(EnvArgs {
            command: EnvCommand::List { project },
        }) => api(
            Method::Get,
            format!("{}/projects/{}/env", org_path(org, "")?, segment(project)),
            None,
        ),
        Command::Env(EnvArgs {
            command:
                EnvCommand::Set {
                    project,
                    key,
                    value,
                    stdin,
                    target,
                    public,
                },
        }) => {
            let value = if *stdin { stdin_value } else { value.clone() }
                .ok_or_else(|| CliError::InvalidInput("env set did not receive a value".into()))?;
            api(
                Method::Put,
                format!("{}/projects/{}/env", org_path(org, "")?, segment(project)),
                Some(serde_json::json!({
                    "key": key, "value": value, "target": enum_name(*target), "isSecret": !public,
                })),
            )
        }
        Command::Env(EnvArgs {
            command: EnvCommand::Unset { project, env_id },
        }) => api(
            Method::Delete,
            format!(
                "{}/projects/{}/env/{}",
                org_path(org, "")?,
                segment(project),
                segment(env_id)
            ),
            None,
        ),
        Command::Service(ServiceArgs {
            command: ServiceCommand::List | ServiceCommand::Get { .. },
        }) => {
            // There is no singular service endpoint. `get` intentionally filters this safe list
            // client-side rather than calling a route that does not exist.
            api(Method::Get, org_path(org, "/services")?, None)
        }
        Command::Service(ServiceArgs {
            command:
                ServiceCommand::Create {
                    name,
                    kind,
                    project,
                },
        }) => {
            let mut body = serde_json::json!({"name": name, "kind": enum_name(*kind)});
            insert_option(&mut body, "projectId", project.clone());
            api(Method::Post, org_path(org, "/services")?, Some(body))
        }
        Command::Service(ServiceArgs {
            command: ServiceCommand::Delete { service },
        }) => api(
            Method::Delete,
            format!("{}/services/{}", org_path(org, "")?, segment(service)),
            None,
        ),
        Command::Deployment(DeploymentArgs {
            command: DeploymentCommand::List { project },
        }) => api(
            Method::Get,
            format!(
                "{}/projects/{}/deployments",
                org_path(org, "")?,
                segment(project)
            ),
            None,
        ),
        Command::Deployment(DeploymentArgs {
            command:
                DeploymentCommand::Get { deployment } | DeploymentCommand::Wait { deployment, .. },
        }) => api(
            Method::Get,
            format!("{}/deployments/{}", org_path(org, "")?, segment(deployment)),
            None,
        ),
        Command::Logs(args) => {
            let mut path = format!(
                "{}/projects/{}/logs",
                org_path(org, "")?,
                segment(&args.project)
            );
            add_query(
                &mut path,
                [
                    ("since", args.since.as_deref()),
                    ("search", args.search.as_deref()),
                    ("level", args.level.as_deref()),
                    ("limit", Some(args.limit.to_string()).as_deref()),
                ],
            );
            api(Method::Get, path, None)
        }
        Command::Android(AndroidArgs { command }) => {
            let (verb, project) = match command {
                AndroidCommand::Setup { project } => ("setup", project),
                AndroidCommand::Status { project } => ("status", project),
                AndroidCommand::Verify { project, .. } => ("verify", project),
            };
            let method = if verb == "status" {
                Method::Get
            } else {
                Method::Post
            };
            let body = match command {
                AndroidCommand::Verify { commit, .. } => {
                    Some(serde_json::json!({"commit": commit}))
                }
                AndroidCommand::Setup { .. } => Some(serde_json::json!({})),
                AndroidCommand::Status { .. } => None,
            };
            api(
                method,
                format!(
                    "{}/projects/{}/android/{verb}",
                    org_path(org, "")?,
                    segment(project)
                ),
                body,
            )
        }
        Command::Api(args) => {
            validate_relative_api_path(&args.path)?;
            let body = args
                .data
                .as_ref()
                .map(|data| serde_json::from_str(data))
                .transpose()
                .map_err(|error| CliError::InvalidInput(format!("--data is not JSON: {error}")))?;
            api(
                match args.method {
                    ApiMethod::Get => Method::Get,
                    ApiMethod::Post => Method::Post,
                    ApiMethod::Put => Method::Put,
                    ApiMethod::Patch => Method::Patch,
                    ApiMethod::Delete => Method::Delete,
                },
                args.path.clone(),
                body,
            )
        }
        Command::Auth(AuthArgs {
            command: AuthCommand::Login { .. },
        })
        | Command::Org(OrgArgs {
            command: OrgCommand::Use { .. },
        })
        | Command::Deploy(_)
        | Command::Template(_) => return Ok(None),
    };
    Ok(Some(request))
}

fn api(method: Method, path: impl Into<String>, body: Option<Value>) -> ApiRequest {
    ApiRequest {
        method,
        path: path.into(),
        body,
    }
}

fn org_path(org: Option<&str>, suffix: &str) -> Result<String> {
    let org = org.filter(|value| !value.is_empty()).ok_or_else(|| {
        CliError::InvalidInput("select an organization with --org or `sprout org use`".into())
    })?;
    Ok(format!("/v1/orgs/{}{suffix}", segment(org)))
}

fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn add_query<'a, const N: usize>(path: &mut String, values: [(&'a str, Option<&'a str>); N]) {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in values {
        if let Some(value) = value {
            serializer.append_pair(key, value);
        }
    }
    let query = serializer.finish();
    if !query.is_empty() {
        path.push('?');
        path.push_str(&query);
    }
}

fn insert_option<T: serde::Serialize>(value: &mut Value, key: &str, option: Option<T>) {
    if let Some(option) = option {
        value[key] = serde_json::to_value(option).expect("CLI values serialize");
    }
}

fn enum_name(value: impl std::fmt::Debug) -> String {
    format!("{value:?}")
        .to_ascii_lowercase()
        .replace("objectstorage", "object_storage")
        .replace("automerge", "auto_merge")
        .replace("oneweek", "one_week")
        .replace("onemonth", "one_month")
        .replace("threemonths", "three_months")
        .replace("sixmonths", "six_months")
        .replace("ninemonths", "nine_months")
        .replace("oneyear", "one_year")
        .replace("twoyears", "two_years")
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::*;

    #[test]
    fn rejects_paths_that_could_exfiltrate_a_bearer_token() {
        for path in [
            "https://attacker.test/v1/orgs",
            "http://attacker.test",
            "//attacker.test/v1/orgs",
            "v1/orgs",
            "",
            "/v1/orgs\nHost: attacker.test",
        ] {
            assert!(
                validate_relative_api_path(path).is_err(),
                "accepted {path:?}"
            );
        }
        validate_relative_api_path("/v1/orgs?cursor=a%2Fb").unwrap();
    }

    #[test]
    fn project_create_maps_to_the_current_server_contract() {
        let cli = Cli::parse_from([
            "sprout",
            "--org",
            "acme",
            "project",
            "create",
            "--name",
            "Blog",
            "--region",
            "us-east-1",
            "--slug",
            "blog",
            "--store",
            "01a-listing",
        ]);
        let request = plan(&cli.command, cli.org.as_deref(), None)
            .unwrap()
            .unwrap();
        assert_eq!(request.method, Method::Post);
        assert_eq!(request.path, "/v1/orgs/acme/projects");
        assert_eq!(
            request.body.unwrap(),
            serde_json::json!({
                "name": "Blog",
                "region": "us-east-1",
                "slug": "blog",
                "kind": "site",
                "source": {"type": "store", "storeListingId": "01a-listing"}
            })
        );
    }

    #[test]
    fn blank_projects_preserve_server_private_and_build_defaults() {
        let cli = Cli::parse_from([
            "sprout",
            "--org",
            "acme",
            "project",
            "create",
            "--name",
            "Worker",
            "--region",
            "us-east-1",
            "--blank",
        ]);
        let body = plan(&cli.command, cli.org.as_deref(), None)
            .unwrap()
            .unwrap()
            .body
            .unwrap();
        assert_eq!(body["region"], "us-east-1");
        assert!(body["source"].get("private").is_none());
        assert!(body.get("rootDir").is_none());
        assert!(body.get("dockerfilePath").is_none());
    }

    #[test]
    fn region_list_uses_the_active_region_endpoint() {
        let cli = Cli::parse_from(["sprout", "region", "list"]);
        assert_eq!(
            plan(&cli.command, None, None).unwrap().unwrap(),
            ApiRequest {
                method: Method::Get,
                path: "/v1/regions".into(),
                body: None,
            }
        );
    }

    #[test]
    fn project_create_serializes_current_update_and_template_contract() {
        let directory = tempfile::tempdir().unwrap();
        let inputs = directory.path().join("inputs.json");
        std::fs::write(
            &inputs,
            r#"[{"key":"admin_password","value":"redaction-canary","secret":true},{"key":"port","value":3000,"secret":false}]"#,
        )
        .unwrap();
        let cli = Cli::parse_from([
            "sprout",
            "--org",
            "acme",
            "project",
            "create",
            "--name",
            "App",
            "--description",
            "Useful app",
            "--region",
            "us-east-1",
            "--store",
            "01a-listing",
            "--owner",
            "MySproutOS",
            "--repository-name",
            "app",
            "--public",
            "--auto-update",
            "--auto-update-cadence",
            "one_month",
            "--auto-update-mode",
            "auto_merge",
            "--sync-upstream-now",
            "--scale",
            "warm",
            "--idempotency-key",
            "acceptance-1",
            "--template-input-file",
            inputs.to_str().unwrap(),
        ]);
        let request = plan(&cli.command, cli.org.as_deref(), None)
            .unwrap()
            .unwrap();
        assert!(!request.path.contains("redaction-canary"));
        let body = request.body.unwrap();
        assert_eq!(body["region"], "us-east-1");
        assert_eq!(body["source"]["private"], false);
        assert_eq!(body["autoUpdateCadence"], "one_month");
        assert_eq!(body["autoUpdateMode"], "auto_merge");
        assert_eq!(body["syncUpstreamNow"], true);
        assert_eq!(body["templateInputs"][0]["secret"], true);
        assert_eq!(body["templateInputs"][1]["value"], 3000);
    }

    #[test]
    fn env_value_is_present_only_in_request_body() {
        let cli = Cli::parse_from([
            "sprout",
            "--org",
            "acme",
            "env",
            "set",
            "project",
            "DATABASE_URL",
            "canary-secret",
        ]);
        let request = plan(&cli.command, cli.org.as_deref(), None)
            .unwrap()
            .unwrap();
        assert!(!request.path.contains("canary-secret"));
        assert_eq!(request.body.unwrap()["value"], "canary-secret");
    }

    #[test]
    fn service_get_uses_secret_free_list_contract() {
        let cli = Cli::parse_from(["sprout", "--org", "acme", "service", "get", "service-id"]);
        let request = plan(&cli.command, cli.org.as_deref(), None)
            .unwrap()
            .unwrap();
        assert_eq!(
            request,
            ApiRequest {
                method: Method::Get,
                path: "/v1/orgs/acme/services".into(),
                body: None,
            }
        );
    }
}
