use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use async_trait::async_trait;
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use tokio_util::io::ReaderStream;

use crate::{
    ApiClient, ArtifactPackager, PackageKind, PackagedArtifact, Result, Sha256Digest, SproutError,
    StaticPath,
};

#[derive(Clone, Debug)]
pub enum DeployArtifactInput {
    Directory { path: PathBuf, kind: PackageKind },
    AndroidApk { path: PathBuf },
    StaticPaths { paths: Vec<StaticPath> },
}

#[derive(Clone, Debug)]
pub struct DeployRequest {
    pub project: Option<String>,
    pub preset: String,
    pub environment: String,
    pub commit: String,
    pub git_ref: String,
    pub message: Option<String>,
    pub runtime: Option<String>,
    pub handler: Option<String>,
    pub migration_handler: Option<String>,
    pub version_code: Option<u64>,
    pub primary: DeployArtifactInput,
    pub static_assets: Option<DeployArtifactInput>,
    pub migration: Option<DeployArtifactInput>,
}

#[derive(Clone, Copy, Debug)]
pub struct PollConfig {
    pub interval: Duration,
    pub timeout: Duration,
}

impl Default for PollConfig {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(5),
            timeout: Duration::from_secs(20 * 60),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum DeployEvent {
    Packaging {
        kind: PackageKind,
    },
    Uploading {
        kind: PackageKind,
        digest: Sha256Digest,
        bytes: u64,
    },
    ReleaseQueued {
        deployment_id: String,
    },
    StateChanged {
        deployment_id: String,
        state: DeploymentState,
    },
}

pub trait DeployObserver: Send + Sync {
    fn event(&self, event: DeployEvent);
}

impl<F> DeployObserver for F
where
    F: Fn(DeployEvent) + Send + Sync,
{
    fn event(&self, event: DeployEvent) {
        self(event);
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentState {
    Queued,
    Building,
    Deploying,
    Ready,
    Error,
    TornDown,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DeploymentStatus {
    pub deployment_id: String,
    pub status: String,
    pub failure_reason: Option<String>,
    pub migration_status: Option<String>,
    pub migration_output: Option<String>,
    pub url: Option<String>,
}

impl DeploymentStatus {
    pub fn state(&self) -> Result<DeploymentState> {
        match self.status.as_str() {
            "queued" => Ok(DeploymentState::Queued),
            "building" => Ok(DeploymentState::Building),
            "deploying" => Ok(DeploymentState::Deploying),
            "ready" => Ok(DeploymentState::Ready),
            "error" => Ok(DeploymentState::Error),
            "torn_down" => Ok(DeploymentState::TornDown),
            state => Err(SproutError::UnknownDeploymentState {
                deployment_id: self.deployment_id.clone(),
                state: state.to_owned(),
            }),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct DeployResult {
    pub deployment_id: String,
    pub url: Option<String>,
    pub status: DeploymentStatus,
    pub primary_digest: Sha256Digest,
    pub static_digest: Option<Sha256Digest>,
    pub migration_digest: Option<Sha256Digest>,
}

#[derive(Clone, Debug)]
pub struct UploadRequest {
    pub project: Option<String>,
    pub preset: String,
    pub digest: Sha256Digest,
    pub static_assets: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct UploadTarget {
    pub url: String,
    pub key: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ReleaseRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub key: String,
    pub digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub static_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub static_digest: Option<String>,
    pub preset: String,
    pub environment: String,
    pub commit: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handler: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migration_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migration_handler: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_code: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct QueuedDeployment {
    pub deployment_id: String,
    pub url: Option<String>,
}

#[async_trait]
pub trait DeploymentApi: Send + Sync {
    async fn negotiate_upload(&self, request: &UploadRequest) -> Result<UploadTarget>;
    async fn upload(&self, target: &UploadTarget, artifact: &PackagedArtifact) -> Result<()>;
    async fn create_release(&self, request: &ReleaseRequest) -> Result<QueuedDeployment>;
    async fn deployment_status(&self, deployment_id: &str) -> Result<DeploymentStatus>;
}

pub struct DeployHttpApi {
    api: ApiClient,
    upload_client: reqwest::Client,
}

impl DeployHttpApi {
    pub fn new(api: ApiClient, upload_timeout: Duration) -> Result<Self> {
        let upload_client = reqwest::Client::builder()
            .timeout(upload_timeout)
            .build()
            .map_err(|error| SproutError::ApiTransport(error.to_string()))?;
        Ok(Self { api, upload_client })
    }
}

#[async_trait]
impl DeploymentApi for DeployHttpApi {
    async fn negotiate_upload(&self, request: &UploadRequest) -> Result<UploadTarget> {
        if request.static_assets {
            self.api
                .request_json(
                    Method::POST,
                    "v1/deploy/static-upload-url",
                    Some(&serde_json::json!({ "digest": request.digest.hex() })),
                )
                .await
        } else {
            let mut body = serde_json::json!({
                "digest": request.digest.hex(),
                "preset": request.preset,
            });
            if let Some(project) = &request.project {
                body["project"] = serde_json::Value::String(project.clone());
            }
            self.api
                .request_json(Method::POST, "v1/deploy/upload-url", Some(&body))
                .await
        }
    }

    async fn upload(&self, target: &UploadTarget, artifact: &PackagedArtifact) -> Result<()> {
        let url = Url::parse(&target.url).map_err(|error| SproutError::ApiResponse {
            status: 0,
            message: format!("invalid upload URL: {error}"),
        })?;
        if !matches!(url.scheme(), "https" | "http") {
            return Err(SproutError::ApiResponse {
                status: 0,
                message: "upload URL must use HTTP or HTTPS".into(),
            });
        }
        let file = tokio::fs::File::open(&artifact.path)
            .await
            .map_err(|source| SproutError::Io {
                operation: "open artifact for upload",
                source,
            })?;
        let response = self
            .upload_client
            .put(url)
            .header(reqwest::header::CONTENT_TYPE, artifact.media_type())
            .header(reqwest::header::CONTENT_LENGTH, artifact.size)
            .body(reqwest::Body::wrap_stream(ReaderStream::new(file)))
            .send()
            .await
            .map_err(|error| {
                let message = if error.is_timeout() {
                    "artifact upload timed out"
                } else if error.is_connect() {
                    "could not connect to artifact storage"
                } else {
                    "artifact upload transport failed"
                };
                SproutError::ApiTransport(message.into())
            })?;
        if !response.status().is_success() {
            return Err(SproutError::ApiResponse {
                status: response.status().as_u16(),
                message: "artifact upload failed".into(),
            });
        }
        Ok(())
    }

    async fn create_release(&self, request: &ReleaseRequest) -> Result<QueuedDeployment> {
        self.api
            .request_json(Method::POST, "v1/deploy/release", Some(request))
            .await
    }

    async fn deployment_status(&self, deployment_id: &str) -> Result<DeploymentStatus> {
        if deployment_id.is_empty()
            || !deployment_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(SproutError::InvalidInput("invalid deployment id".into()));
        }
        self.api
            .request_json::<(), _>(
                Method::GET,
                &format!("v1/deploy/deployments/{deployment_id}"),
                None,
            )
            .await
    }
}

pub struct Deployer<A> {
    api: A,
    packager: ArtifactPackager,
    polling: PollConfig,
}

impl<A: DeploymentApi> Deployer<A> {
    pub fn new(api: A, packager: ArtifactPackager, polling: PollConfig) -> Self {
        Self {
            api,
            packager,
            polling,
        }
    }

    pub async fn deploy<O: DeployObserver>(
        &self,
        request: &DeployRequest,
        observer: &O,
    ) -> Result<DeployResult> {
        validate_request(request)?;
        let scratch = tempfile::tempdir().map_err(|source| SproutError::Io {
            operation: "create deploy packaging directory",
            source,
        })?;
        let primary = self.package(
            &request.primary,
            &scratch.path().join("primary.zip"),
            Some(&request.preset),
            observer,
        )?;
        let static_assets = match &request.static_assets {
            Some(input) => {
                Some(self.package(input, &scratch.path().join("static.zip"), None, observer)?)
            }
            None => None,
        };
        let migration = match &request.migration {
            Some(input) => {
                Some(self.package(input, &scratch.path().join("migration.zip"), None, observer)?)
            }
            None => None,
        };

        let primary_target = self.upload(request, &primary, false, observer).await?;
        let static_target = match &static_assets {
            Some(artifact) => Some(self.upload(request, artifact, true, observer).await?),
            None => None,
        };
        let migration_target = match &migration {
            Some(artifact) => Some(self.upload(request, artifact, false, observer).await?),
            None => None,
        };
        let release = self
            .api
            .create_release(&ReleaseRequest {
                project: request.project.clone(),
                key: primary_target.key,
                digest: primary.digest.hex().to_owned(),
                static_key: static_target.map(|target| target.key),
                static_digest: static_assets
                    .as_ref()
                    .map(|artifact| artifact.digest.hex().to_owned()),
                preset: request.preset.clone(),
                environment: request.environment.clone(),
                commit: request.commit.clone(),
                git_ref: request.git_ref.clone(),
                runtime: clean_optional(&request.runtime),
                handler: clean_optional(&request.handler),
                migration_key: migration_target.map(|target| target.key),
                migration_handler: clean_optional(&request.migration_handler),
                message: request.message.as_deref().and_then(commit_subject),
                version_code: request.version_code,
            })
            .await?;
        observer.event(DeployEvent::ReleaseQueued {
            deployment_id: release.deployment_id.clone(),
        });
        let status = self.wait(&release.deployment_id, observer).await?;
        Ok(DeployResult {
            deployment_id: release.deployment_id,
            url: status.url.clone().or(release.url),
            status,
            primary_digest: primary.digest,
            static_digest: static_assets.map(|artifact| artifact.digest),
            migration_digest: migration.map(|artifact| artifact.digest),
        })
    }

    fn package<O: DeployObserver>(
        &self,
        input: &DeployArtifactInput,
        destination: &Path,
        preset: Option<&str>,
        observer: &O,
    ) -> Result<PackagedArtifact> {
        let kind = match input {
            DeployArtifactInput::Directory { kind, .. } => *kind,
            DeployArtifactInput::AndroidApk { .. } => PackageKind::AndroidApk,
            DeployArtifactInput::StaticPaths { .. } => PackageKind::StaticZip,
        };
        observer.event(DeployEvent::Packaging { kind });
        match input {
            DeployArtifactInput::Directory { path, kind } => match preset {
                Some(preset) => {
                    self.packager
                        .package_deploy_directory(path, destination, *kind, preset)
                }
                None => self.packager.package_zip(path, destination, *kind),
            },
            DeployArtifactInput::AndroidApk { path } => self.packager.package_apk_input(path),
            DeployArtifactInput::StaticPaths { paths } => {
                self.packager.package_static_paths(paths, destination)
            }
        }
    }

    async fn upload<O: DeployObserver>(
        &self,
        request: &DeployRequest,
        artifact: &PackagedArtifact,
        static_assets: bool,
        observer: &O,
    ) -> Result<UploadTarget> {
        let target = self
            .api
            .negotiate_upload(&UploadRequest {
                project: request.project.clone(),
                preset: request.preset.clone(),
                digest: artifact.digest.clone(),
                static_assets,
            })
            .await?;
        observer.event(DeployEvent::Uploading {
            kind: artifact.kind,
            digest: artifact.digest.clone(),
            bytes: artifact.size,
        });
        self.api.upload(&target, artifact).await?;
        Ok(target)
    }

    async fn wait<O: DeployObserver>(
        &self,
        deployment_id: &str,
        observer: &O,
    ) -> Result<DeploymentStatus> {
        let deadline = tokio::time::Instant::now() + self.polling.timeout;
        let mut previous = None;
        loop {
            let status = self.api.deployment_status(deployment_id).await?;
            let state = status.state()?;
            if previous.as_ref() != Some(&state) {
                observer.event(DeployEvent::StateChanged {
                    deployment_id: deployment_id.to_owned(),
                    state: state.clone(),
                });
                previous = Some(state.clone());
            }
            match state {
                DeploymentState::Ready => return Ok(status),
                DeploymentState::Error | DeploymentState::TornDown => {
                    return Err(SproutError::DeploymentFailed {
                        deployment_id: deployment_id.to_owned(),
                        state: status.status,
                        reason: status
                            .failure_reason
                            .unwrap_or_else(|| "deployment ended without a failure reason".into()),
                        migration_output: status.migration_output,
                    });
                }
                DeploymentState::Queued
                | DeploymentState::Building
                | DeploymentState::Deploying => {}
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Err(SproutError::DeployTimeout {
                    deployment_id: deployment_id.to_owned(),
                    timeout_ms: self
                        .polling
                        .timeout
                        .as_millis()
                        .try_into()
                        .unwrap_or(u64::MAX),
                    last_state: status.status,
                });
            }
            tokio::time::sleep(self.polling.interval.min(deadline - now)).await;
        }
    }
}

fn validate_request(request: &DeployRequest) -> Result<()> {
    for (name, value) in [
        ("preset", request.preset.as_str()),
        ("environment", request.environment.as_str()),
        ("commit", request.commit.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(SproutError::InvalidInput(format!("{name} cannot be empty")));
        }
    }
    if request
        .project
        .as_deref()
        .is_some_and(|project| project.trim().is_empty())
    {
        return Err(SproutError::InvalidInput(
            "project must be omitted rather than empty".into(),
        ));
    }
    let android = request.preset == "android";
    if android != matches!(request.primary, DeployArtifactInput::AndroidApk { .. }) {
        return Err(SproutError::InvalidInput(
            "the android preset requires exactly one raw APK; other presets require a directory"
                .into(),
        ));
    }
    if !android && !matches!(request.primary, DeployArtifactInput::Directory { .. }) {
        return Err(SproutError::InvalidInput(
            "the primary non-Android artifact must be a build directory".into(),
        ));
    }
    if android != request.version_code.is_some() || request.version_code == Some(0) {
        return Err(SproutError::InvalidInput(
            "version_code must be >= 1 for Android and absent for other presets".into(),
        ));
    }
    if android && (request.static_assets.is_some() || request.migration.is_some()) {
        return Err(SproutError::InvalidInput(
            "Android deploys upload only the raw APK".into(),
        ));
    }
    if request.static_assets.as_ref().is_some_and(|input| {
        !matches!(
            input,
            DeployArtifactInput::Directory {
                kind: PackageKind::StaticZip,
                ..
            } | DeployArtifactInput::StaticPaths { .. }
        )
    }) {
        return Err(SproutError::InvalidInput(
            "static_assets must use PackageKind::StaticZip".into(),
        ));
    }
    if request.migration.as_ref().is_some_and(|input| {
        !matches!(
            input,
            DeployArtifactInput::Directory {
                kind: PackageKind::MigrationZip,
                ..
            }
        )
    }) {
        return Err(SproutError::InvalidInput(
            "migration must use PackageKind::MigrationZip".into(),
        ));
    }
    Ok(())
}

fn clean_optional(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn commit_subject(value: &str) -> Option<String> {
    let subject: String = value.lines().next()?.trim().chars().take(500).collect();
    (!subject.is_empty()).then_some(subject)
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, fs, sync::Mutex};

    use tempfile::tempdir;

    use super::*;
    use crate::{ApiClientConfig, ErrorCode, PackagingLimits};

    struct FakeApi {
        statuses: Mutex<VecDeque<DeploymentStatus>>,
        uploads: Mutex<Vec<PackageKind>>,
        releases: Mutex<Vec<ReleaseRequest>>,
    }

    #[async_trait]
    impl DeploymentApi for FakeApi {
        async fn negotiate_upload(&self, request: &UploadRequest) -> Result<UploadTarget> {
            let extension = if request.preset == "android" {
                "apk"
            } else {
                "zip"
            };
            Ok(UploadTarget {
                url: "https://uploads.invalid/object".into(),
                key: format!("artifact.{extension}"),
            })
        }

        async fn upload(&self, _target: &UploadTarget, artifact: &PackagedArtifact) -> Result<()> {
            self.uploads.lock().unwrap().push(artifact.kind);
            Ok(())
        }

        async fn create_release(&self, request: &ReleaseRequest) -> Result<QueuedDeployment> {
            self.releases.lock().unwrap().push(request.clone());
            Ok(QueuedDeployment {
                deployment_id: "019d0000-0000-7000-8000-000000000000".into(),
                url: None,
            })
        }

        async fn deployment_status(&self, _deployment_id: &str) -> Result<DeploymentStatus> {
            self.statuses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| SproutError::ApiTransport("no status".into()))
        }
    }

    fn status(state: &str) -> DeploymentStatus {
        DeploymentStatus {
            deployment_id: "019d0000-0000-7000-8000-000000000000".into(),
            status: state.into(),
            failure_reason: None,
            migration_status: Some("skipped".into()),
            migration_output: None,
            url: (state == "ready").then(|| "https://app.example".into()),
        }
    }

    fn request(path: PathBuf) -> DeployRequest {
        DeployRequest {
            project: Some("demo".into()),
            preset: "static".into(),
            environment: "production".into(),
            commit: "abc123".into(),
            git_ref: "refs/heads/main".into(),
            message: Some("subject\nbody".into()),
            runtime: None,
            handler: None,
            migration_handler: None,
            version_code: None,
            primary: DeployArtifactInput::Directory {
                path,
                kind: PackageKind::SiteZip,
            },
            static_assets: None,
            migration: None,
        }
    }

    #[tokio::test]
    async fn packages_uploads_releases_and_polls_to_ready() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("index.html"), "hello").unwrap();
        let api = FakeApi {
            statuses: Mutex::new(VecDeque::from([
                status("queued"),
                status("deploying"),
                status("ready"),
            ])),
            uploads: Mutex::new(Vec::new()),
            releases: Mutex::new(Vec::new()),
        };
        let events = Mutex::new(Vec::new());
        let observer = |event| events.lock().unwrap().push(event);
        let deployer = Deployer::new(
            api,
            ArtifactPackager::new(PackagingLimits::default()),
            PollConfig {
                interval: Duration::ZERO,
                timeout: Duration::from_secs(1),
            },
        );
        let result = deployer
            .deploy(&request(root.path().to_owned()), &observer)
            .await
            .unwrap();
        assert_eq!(result.url.as_deref(), Some("https://app.example"));
        assert_eq!(
            deployer.api.uploads.lock().unwrap().as_slice(),
            &[PackageKind::SiteZip]
        );
        assert_eq!(
            deployer.api.releases.lock().unwrap()[0].message.as_deref(),
            Some("subject")
        );
    }

    #[tokio::test]
    async fn terminal_failure_preserves_reason_and_migration_output() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("index.html"), "hello").unwrap();
        let mut failed = status("error");
        failed.failure_reason = Some("migration failed".into());
        failed.migration_output = Some("SQL error".into());
        let api = FakeApi {
            statuses: Mutex::new(VecDeque::from([failed])),
            uploads: Mutex::new(Vec::new()),
            releases: Mutex::new(Vec::new()),
        };
        let deployer = Deployer::new(
            api,
            ArtifactPackager::new(PackagingLimits::default()),
            PollConfig::default(),
        );
        let error = deployer
            .deploy(&request(root.path().to_owned()), &|_| {})
            .await
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::DeploymentFailed);
        assert!(error.to_string().contains("migration failed"));
    }

    #[test]
    fn android_requires_raw_apk_and_version_code() {
        let root = tempdir().unwrap();
        let mut request = request(root.path().to_owned());
        request.preset = "android".into();
        assert!(validate_request(&request).is_err());
    }

    #[tokio::test]
    async fn presigned_upload_secret_is_never_retained_in_errors() {
        let root = tempdir().unwrap();
        let path = root.path().join("artifact");
        fs::write(&path, "artifact").unwrap();
        let api = ApiClient::new(ApiClientConfig {
            base_url: "https://api.example/v1".parse().unwrap(),
            token: Some("api-secret".into()),
            timeout: Duration::from_secs(1),
            max_response_bytes: 1024,
        })
        .unwrap();
        let transport = DeployHttpApi::new(api, Duration::from_millis(100)).unwrap();
        let artifact = PackagedArtifact {
            path,
            kind: PackageKind::BuildZip,
            digest: Sha256Digest::from_bytes(b"artifact"),
            size: 8,
        };
        let error = transport
            .upload(
                &UploadTarget {
                    url: "http://127.0.0.1:1/object?X-Amz-Signature=canary-secret".into(),
                    key: "object".into(),
                },
                &artifact,
            )
            .await
            .unwrap_err();
        let envelope = serde_json::to_string(&error.envelope()).unwrap();
        assert!(!envelope.contains("canary-secret"));
        assert!(!envelope.contains("X-Amz"));
        assert!(!envelope.contains("api-secret"));
    }
}
