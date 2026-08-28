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
            let source = if let Some(id) = &args.source.store {
                serde_json::json!({"type": "store", "storeListingId": id})
            } else if let Some(id) = &args.source.repository_id {
                serde_json::json!({"type": "repository", "repositoryId": id})
            } else if let Some(id) = &args.source.github_repo_id {
                serde_json::json!({"type": "repository", "githubRepoId": id})
            } else {
                let mut source =
                    serde_json::json!({"type": "blank", "private": args.source.private});
                insert_option(&mut source, "ownerLogin", args.source.owner.clone());
                insert_option(
                    &mut source,
                    "repositoryName",
                    args.source.repository_name.clone(),
                );
                source
            };
            let mut body = serde_json::json!({
                "name": args.name,
                "kind": enum_name(args.kind),
                "rootDir": args.root_dir,
                "dockerfilePath": args.dockerfile_path,
                "source": source,
            });
            insert_option(&mut body, "slug", args.slug.clone());
            insert_option(
                &mut body,
                "productionBranch",
                args.production_branch.clone(),
            );
            insert_option(&mut body, "parentProjectId", args.parent_project.clone());
            api(Method::Post, org_path(org, "/projects")?, Some(body))
        }
        Command::Project(ProjectArgs {
            command: ProjectCommand::Update(args),
        }) => {
            let mut body = serde_json::json!({});
            insert_option(&mut body, "name", args.name.clone());
            insert_option(&mut body, "slug", args.slug.clone());
            insert_option(&mut body, "rootDir", args.root_dir.clone());
            insert_option(&mut body, "dockerfilePath", args.dockerfile_path.clone());
            insert_option(
                &mut body,
                "productionBranch",
                args.production_branch.clone(),
            );
            insert_option(&mut body, "scaleMode", args.scale.map(enum_name));
            if args.no_parent {
                body["parentProjectId"] = Value::Null;
            } else {
                insert_option(&mut body, "parentProjectId", args.parent_project.clone());
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
                "slug": "blog",
                "kind": "site",
                "rootDir": ".",
                "dockerfilePath": "Dockerfile",
                "source": {"type": "store", "storeListingId": "01a-listing"}
            })
        );
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
