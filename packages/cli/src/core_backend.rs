use std::{
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use async_trait::async_trait;
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use sprout_core::{
    ApiClient, ApiClientConfig, ArtifactPackager, DeployArtifactInput, DeployEvent, DeployHttpApi,
    DeployRequest, Deployer, PackageKind, PackagingLimits, PollConfig, SproutError, StaticPath,
};
use url::Url;

use crate::{
    Backend, CliError, Result,
    cli::{DeployArgs, DeployEnvironment, DeployPreset, TemplateCommand},
    request::{ApiRequest, Method as CliMethod},
};

const API_TIMEOUT: Duration = Duration::from_secs(30);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_API_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

pub struct CoreBackend {
    base_url: Url,
    json: bool,
}

impl CoreBackend {
    pub fn new(base_url: &str, json: bool) -> Result<Self> {
        let base_url = Url::parse(base_url)
            .map_err(|error| CliError::InvalidInput(format!("invalid --api-url: {error}")))?;
        // Make core perform the definitive origin/path validation now rather than after login.
        Self::client_for(&base_url, None)?;
        Ok(Self { base_url, json })
    }

    fn client(&self, token: Option<&str>) -> Result<ApiClient> {
        Self::client_for(&self.base_url, token)
    }

    fn client_for(base_url: &Url, token: Option<&str>) -> Result<ApiClient> {
        ApiClient::new(ApiClientConfig {
            base_url: base_url.clone(),
            token: token.map(str::to_owned),
            timeout: API_TIMEOUT,
            max_response_bytes: MAX_API_RESPONSE_BYTES,
        })
        .map_err(map_core_error)
    }

    async fn authorize_deploy(
        &self,
        token: &str,
        organization: Option<&str>,
        project: Option<&str>,
        repository_bound: bool,
    ) -> Result<String> {
        if repository_bound {
            return Ok(token.to_owned());
        }
        let organization = organization.ok_or_else(|| {
            CliError::InvalidInput(
                "deploy needs --org or an organization selected by `sprout org use`".into(),
            )
        })?;
        let project = project.ok_or_else(|| {
            CliError::InvalidInput(
                "local deploy needs an explicit PROJECT; only repository-bound Action tokens may omit it"
                    .into(),
            )
        })?;
        let path = format!(
            "v1/orgs/{}/projects/{}/deploy-token",
            segment(organization),
            segment(project)
        );
        let response = self
            .client(Some(token))?
            .request_json::<_, DeployTokenResponse>(Method::POST, &path, Some(&json!({})))
            .await
            .map_err(map_core_error)?;
        if response.token.is_empty() {
            return Err(CliError::Api(
                "deploy authorization returned an empty token".into(),
            ));
        }
        Ok(response.token)
    }
}

#[derive(Deserialize)]
struct DeployTokenResponse {
    token: String,
}

#[async_trait]
impl Backend for CoreBackend {
    async fn request(&self, request: ApiRequest, token: Option<&str>) -> Result<Value> {
        let method = match request.method {
            CliMethod::Get => Method::GET,
            CliMethod::Post => Method::POST,
            CliMethod::Put => Method::PUT,
            CliMethod::Patch => Method::PATCH,
            CliMethod::Delete => Method::DELETE,
        };
        let path = request.path.strip_prefix('/').ok_or_else(|| {
            CliError::InvalidInput("internal API path must start with `/`".into())
        })?;
        let response = self
            .client(token)?
            .send_json(method, path, request.body.as_ref())
            .await
            .map_err(map_core_error)?;
        if response.body.is_empty() {
            Ok(json!({}))
        } else {
            serde_json::from_slice(&response.body)
                .map_err(|error| CliError::Api(format!("API returned invalid JSON: {error}")))
        }
    }

    async fn deploy(
        &self,
        args: &DeployArgs,
        token: &str,
        organization: Option<&str>,
        repository_bound_token: bool,
    ) -> Result<Value> {
        let deploy_token = self
            .authorize_deploy(
                token,
                organization,
                args.project.as_deref(),
                repository_bound_token,
            )
            .await?;
        let api = DeployHttpApi::new(self.client(Some(&deploy_token))?, UPLOAD_TIMEOUT)
            .map_err(map_core_error)?;
        let deployer = Deployer::new(
            api,
            ArtifactPackager::new(PackagingLimits::default()),
            PollConfig {
                interval: Duration::from_secs(5),
                timeout: Duration::from_secs(args.timeout_seconds),
            },
        );
        let preset = preset_name(args.preset).to_owned();
        let request = DeployRequest {
            project: args.project.clone(),
            preset,
            environment: environment_name(args.environment).to_owned(),
            commit: git_value(
                args.git_sha.as_deref(),
                "GITHUB_SHA",
                &["rev-parse", "HEAD"],
                "--git-sha",
            )?,
            git_ref: git_value(
                args.git_ref.as_deref(),
                "GITHUB_REF",
                &["symbolic-ref", "--quiet", "--short", "HEAD"],
                "--git-ref",
            )?,
            message: args.message.clone().or_else(git_subject),
            runtime: args.runtime.clone(),
            handler: args.handler.clone(),
            migration_handler: args.migration_handler.clone(),
            version_code: args.version_code,
            primary: if matches!(args.preset, DeployPreset::Android) {
                DeployArtifactInput::AndroidApk {
                    path: args.path.clone(),
                }
            } else {
                DeployArtifactInput::Directory {
                    path: args.path.clone(),
                    kind: PackageKind::SiteZip,
                }
            },
            static_assets: static_asset_input(args.preset, &args.path, &args.static_paths)?,
            migration: args
                .migration_path
                .as_ref()
                .map(|path| DeployArtifactInput::Directory {
                    path: path.clone(),
                    kind: PackageKind::MigrationZip,
                }),
        };
        let show_progress = !self.json;
        let observer = move |event: DeployEvent| {
            if show_progress {
                eprintln!("{}", progress_message(&event));
            }
        };
        let result = deployer
            .deploy(&request, &observer)
            .await
            .map_err(map_core_error)?;
        serde_json::to_value(result).map_err(|error| {
            CliError::Configuration(format!("could not encode deploy result: {error}"))
        })
    }

    async fn template(&self, _command: &TemplateCommand, _token: &str) -> Result<Value> {
        // Native isolation now exists in sprout-core, but no production catalogue resolver or
        // Sigstore policy is wired into the CLI yet. Failing closed is part of the contract;
        // direct or unverified execution is never a fallback.
        Err(map_core_error(SproutError::IsolationUnavailable(
            "verified template execution is not available in this release".into(),
        )))
    }
}

fn static_asset_input(
    preset: DeployPreset,
    primary_path: &Path,
    values: &[String],
) -> Result<Option<DeployArtifactInput>> {
    if values.is_empty() && matches!(preset, DeployPreset::Static) {
        // Static releases still carry the protocol's required primary archive, but their files
        // are served from the independently identified asset archive. Match the deploy action's
        // default by publishing the selected build directory at the URL root as well.
        return Ok(Some(DeployArtifactInput::StaticPaths {
            paths: vec![StaticPath {
                source: primary_path.to_owned(),
                prefix: String::new(),
            }],
        }));
    }
    if values.is_empty() {
        return Ok(None);
    }
    let paths = values
        .iter()
        .map(|value| {
            let (source, prefix) = value.rsplit_once(':').ok_or_else(|| {
                CliError::InvalidInput(format!("--static-path `{value}` must use SOURCE:PREFIX"))
            })?;
            if source.is_empty() {
                return Err(CliError::InvalidInput(
                    "--static-path source cannot be empty".into(),
                ));
            }
            Ok(StaticPath {
                source: PathBuf::from(source),
                prefix: prefix.to_owned(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Some(DeployArtifactInput::StaticPaths { paths }))
}

fn git_value(
    explicit: Option<&str>,
    environment: &str,
    args: &[&str],
    flag: &str,
) -> Result<String> {
    if let Some(value) = explicit.filter(|value| !value.trim().is_empty()) {
        return Ok(value.to_owned());
    }
    if let Ok(value) = std::env::var(environment)
        && !value.trim().is_empty()
    {
        return Ok(value);
    }
    git_output(args).ok_or_else(|| {
        CliError::InvalidInput(format!(
            "could not infer git metadata; pass {flag} explicitly"
        ))
    })
}

fn git_subject() -> Option<String> {
    git_output(&["log", "-1", "--pretty=%s"])
}

fn git_output(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn preset_name(value: DeployPreset) -> &'static str {
    match value {
        DeployPreset::Next => "next",
        DeployPreset::Hono => "hono",
        DeployPreset::Web => "web",
        DeployPreset::Static => "static",
        DeployPreset::Android => "android",
    }
}

fn environment_name(value: DeployEnvironment) -> &'static str {
    match value {
        DeployEnvironment::Production => "production",
        DeployEnvironment::Preview => "preview",
        DeployEnvironment::Development => "preview",
    }
}

fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn progress_message(event: &DeployEvent) -> String {
    match event {
        DeployEvent::Packaging { kind } => format!("Packaging {kind:?}..."),
        DeployEvent::Uploading { kind, bytes, .. } => {
            format!("Uploading {kind:?} ({bytes} bytes)...")
        }
        DeployEvent::ReleaseQueued { deployment_id } => {
            format!("Deployment queued: {deployment_id}")
        }
        DeployEvent::StateChanged {
            deployment_id,
            state,
        } => format!("Deployment {deployment_id}: {state:?}"),
    }
}

fn map_core_error(error: SproutError) -> CliError {
    let envelope = error.envelope();
    let code = serde_json::to_value(envelope.code)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "core_error".into());
    CliError::Backend {
        code,
        message: envelope.message,
        retryable: envelope.retryable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_mapping_splits_from_the_right_for_windows_drive_letters() {
        let input = vec![r"C:\build\public:assets".to_owned()];
        let Some(DeployArtifactInput::StaticPaths { paths }) =
            static_asset_input(DeployPreset::Next, Path::new("ignored"), &input).unwrap()
        else {
            panic!("expected static paths")
        };
        assert_eq!(paths[0].source, PathBuf::from(r"C:\build\public"));
        assert_eq!(paths[0].prefix, "assets");
    }

    #[test]
    fn static_preset_publishes_the_primary_directory_at_the_root_by_default() {
        let Some(DeployArtifactInput::StaticPaths { paths }) =
            static_asset_input(DeployPreset::Static, Path::new("custom-output"), &[]).unwrap()
        else {
            panic!("expected the static preset to publish its primary directory")
        };
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].source, PathBuf::from("custom-output"));
        assert_eq!(paths[0].prefix, "");
    }

    #[test]
    fn explicit_static_paths_override_the_static_preset_default() {
        let input = vec!["public:assets".to_owned()];
        let Some(DeployArtifactInput::StaticPaths { paths }) =
            static_asset_input(DeployPreset::Static, Path::new("dist"), &input).unwrap()
        else {
            panic!("expected explicit static paths")
        };
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].source, PathBuf::from("public"));
        assert_eq!(paths[0].prefix, "assets");
    }

    #[test]
    fn runtime_presets_do_not_gain_implicit_static_assets() {
        assert!(
            static_asset_input(DeployPreset::Hono, Path::new("dist"), &[])
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn legacy_development_environment_maps_to_preview() {
        assert_eq!(environment_name(DeployEnvironment::Development), "preview");
    }
}
