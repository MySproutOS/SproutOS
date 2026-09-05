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
    ApiCatalogueResolver, ApiClient, ApiClientConfig, ApplyLimits, ArtifactLimits,
    ArtifactPackager, CosignProvenanceVerifier, DeployArtifactInput, DeployEvent, DeployHttpApi,
    DeployRequest, Deployer, NativeIsolationProvider, PackageKind, PackagingLimits, PluginTarget,
    PollConfig, SproutError, StaticPath, TemplateSelector, apply_template, resolve_template,
    verify_template,
};
use url::Url;

use crate::{
    Backend, CliError, LogStreamEvent, Result,
    cli::{DeployArgs, DeployEnvironment, DeployPreset, TemplateCommand, TemplateTarget},
    request::{ApiRequest, Method as CliMethod},
};

const API_TIMEOUT: Duration = Duration::from_secs(30);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_API_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SSE_FRAME_BYTES: usize = 512 * 1024;
const MAX_STREAM_FAILURES: u8 = 8;
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(5);
const STREAM_FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(15);
const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(35);
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(10);

pub struct CoreBackend {
    base_url: Url,
    json: bool,
    stream_client: reqwest::Client,
}

impl CoreBackend {
    pub fn new(base_url: &str, json: bool) -> Result<Self> {
        let base_url = Url::parse(base_url)
            .map_err(|error| CliError::InvalidInput(format!("invalid --api-url: {error}")))?;
        // Make core perform the definitive origin/path validation now rather than after login.
        Self::client_for(&base_url, None)?;
        let stream_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            // No whole-request timeout: a healthy SSE response is intentionally long-lived.
            .build()
            .map_err(|error| CliError::Configuration(error.to_string()))?;
        Ok(Self {
            base_url,
            json,
            stream_client,
        })
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

    async fn template(&self, command: &TemplateCommand, token: &str) -> Result<Value> {
        let (template, upstream_commit, selected_target) = match command {
            TemplateCommand::Resolve {
                template,
                upstream_commit,
                target,
            }
            | TemplateCommand::Verify {
                template,
                upstream_commit,
                target,
            }
            | TemplateCommand::Apply {
                template,
                upstream_commit,
                target,
                ..
            } => (template, upstream_commit, *target),
        };
        let target = selected_target
            .map(plugin_target)
            .map_or_else(PluginTarget::current, Ok)
            .map_err(map_core_error)?;
        let selector = TemplateSelector {
            template_id: template.clone(),
            upstream_commit: upstream_commit.clone(),
            target,
        };
        let resolver = ApiCatalogueResolver::new(self.client(Some(token))?);
        let resolved = resolve_template(&resolver, &selector)
            .await
            .map_err(map_core_error)?;

        match command {
            TemplateCommand::Resolve { .. } => serde_json::to_value(resolved).map_err(|error| {
                CliError::Configuration(format!("could not encode template resolution: {error}"))
            }),
            TemplateCommand::Verify { .. } => {
                let verifier = CosignProvenanceVerifier::detect().map_err(map_core_error)?;
                let verification = verify_template(&resolved, verifier, ArtifactLimits::default())
                    .await
                    .map_err(map_core_error)?;
                serde_json::to_value(verification).map_err(|error| {
                    CliError::Configuration(format!(
                        "could not encode template verification: {error}"
                    ))
                })
            }
            TemplateCommand::Apply {
                workspace, input, ..
            } => {
                validate_template_input(&resolved, input)?;
                if !workspace.join(".git").exists() {
                    return Err(CliError::InvalidInput(
                        "template workspace must be a checked-out Git repository".into(),
                    ));
                }
                if target != PluginTarget::current().map_err(map_core_error)? {
                    return Err(map_core_error(SproutError::ArtifactRejected(format!(
                        "cannot execute a {target} plugin on this platform"
                    ))));
                }
                // Detect both mandatory local boundaries before any artifact bytes are fetched.
                let isolation = NativeIsolationProvider::detect().map_err(map_core_error)?;
                let verifier = CosignProvenanceVerifier::detect().map_err(map_core_error)?;
                let applied = apply_template(
                    &resolved,
                    workspace,
                    verifier,
                    isolation,
                    ArtifactLimits::default(),
                    ApplyLimits::default(),
                )
                .await
                .map_err(map_core_error)?;
                serde_json::to_value(applied).map_err(|error| {
                    CliError::Configuration(format!("could not encode template result: {error}"))
                })
            }
        }
    }

    async fn follow_logs(
        &self,
        request: ApiRequest,
        token: &str,
        emit: &mut (dyn FnMut(LogStreamEvent) -> Result<()> + Send),
    ) -> Result<()> {
        if request.method != CliMethod::Get || request.body.is_some() {
            return Err(CliError::InvalidInput(
                "log streams must be bodyless GET requests".into(),
            ));
        }
        let path = request.path.strip_prefix('/').ok_or_else(|| {
            CliError::InvalidInput("internal API path must start with `/`".into())
        })?;
        let base_url = self.base_url.clone();
        let mut cursor: Option<String> = None;
        let mut failures = 0_u8;
        let mut delay = Duration::from_millis(250);

        loop {
            let mut url = base_url
                .join(path)
                .map_err(|error| CliError::InvalidInput(format!("invalid API path: {error}")))?;
            if url.origin() != base_url.origin() || !url.path().starts_with(base_url.path()) {
                return Err(CliError::InvalidInput(
                    "log stream path must remain on the configured API origin".into(),
                ));
            }
            if let Some(value) = cursor.as_deref() {
                url.query_pairs_mut().append_pair("cursor", value);
            }

            let mut builder = self
                .stream_client
                .get(url)
                .bearer_auth(token)
                .header(reqwest::header::ACCEPT, "text/event-stream")
                .header(reqwest::header::CACHE_CONTROL, "no-cache");
            if let Some(value) = cursor.as_deref() {
                builder = builder.header("Last-Event-ID", value);
            }

            let response =
                match tokio::time::timeout(STREAM_FIRST_BYTE_TIMEOUT, builder.send()).await {
                    Ok(Ok(response)) => response,
                    Ok(Err(_)) => {
                        // reqwest's Display includes the complete request URL. That URL carries
                        // user-provided search filters and resume cursors, so transport failures
                        // must never surface the library diagnostic (or any request metadata).
                        let error = retryable_stream_error(
                            "log stream transport failed before response headers".into(),
                        );
                        failures = failures.saturating_add(1);
                        if failures >= MAX_STREAM_FAILURES {
                            return Err(error);
                        }
                        tokio::time::sleep(delay).await;
                        delay = (delay * 2).min(MAX_RECONNECT_DELAY);
                        continue;
                    }
                    Err(_) => {
                        let error = retryable_stream_error(
                            "log stream did not return response headers before the \
                             first-byte deadline"
                                .into(),
                        );
                        failures = failures.saturating_add(1);
                        if failures >= MAX_STREAM_FAILURES {
                            return Err(error);
                        }
                        tokio::time::sleep(delay).await;
                        delay = (delay * 2).min(MAX_RECONNECT_DELAY);
                        continue;
                    }
                };

            if !response.status().is_success() {
                let status = response.status();
                let body = bounded_response_body(response).await?;
                let message = serde_json::from_slice::<Value>(&body)
                    .ok()
                    .and_then(|value| value.get("message")?.as_str().map(ToOwned::to_owned))
                    .unwrap_or_else(|| "log stream request failed".into());
                let error = CliError::Backend {
                    code: "log_stream_http".into(),
                    message: redact_token(&format!("HTTP {}: {message}", status.as_u16()), token),
                    retryable: status.is_server_error() || status.as_u16() == 429,
                };
                if !error.retryable() {
                    return Err(error);
                }
                failures = failures.saturating_add(1);
                if failures >= MAX_STREAM_FAILURES {
                    return Err(error);
                }
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(MAX_RECONNECT_DELAY);
                continue;
            }

            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default();
            if !content_type
                .split(';')
                .next()
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"))
            {
                return Err(CliError::Api(
                    "log stream returned an unexpected content type".into(),
                ));
            }

            match consume_sse(response, token, emit, &mut cursor).await {
                Ok(outcome) => {
                    if outcome.reconnect_requested {
                        failures = 0;
                    } else {
                        failures = failures.saturating_add(1);
                        if failures >= MAX_STREAM_FAILURES {
                            return Err(retryable_stream_error(
                                "log stream closed without a reconnect checkpoint".into(),
                            ));
                        }
                    }
                    delay = Duration::from_millis(outcome.retry_after_ms.clamp(100, 5_000));
                    tokio::time::sleep(delay).await;
                }
                Err(error) if error.retryable() => {
                    failures = failures.saturating_add(1);
                    if failures >= MAX_STREAM_FAILURES {
                        return Err(error);
                    }
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(MAX_RECONNECT_DELAY);
                }
                Err(error) => return Err(error),
            }
        }
    }
}

#[derive(Default)]
struct StreamOutcome {
    retry_after_ms: u64,
    reconnect_requested: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamControl {
    schema_version: u8,
    #[serde(rename = "type")]
    kind: String,
    retry_after_ms: Option<u64>,
    code: Option<String>,
    message: Option<String>,
    retryable: Option<bool>,
}

async fn consume_sse(
    mut response: reqwest::Response,
    token: &str,
    emit: &mut (dyn FnMut(LogStreamEvent) -> Result<()> + Send),
    checkpoint: &mut Option<String>,
) -> Result<StreamOutcome> {
    let mut buffer = Vec::new();
    let mut outcome = StreamOutcome {
        retry_after_ms: 1_000,
        ..Default::default()
    };
    let read_deadline = tokio::time::Instant::now() + STREAM_READ_TIMEOUT;

    loop {
        let remaining = read_deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(retryable_stream_error(
                "log stream exceeded the connection read deadline".into(),
            ));
        }
        let chunk = tokio::time::timeout(STREAM_IDLE_TIMEOUT.min(remaining), response.chunk())
            .await
            .map_err(|_| retryable_stream_error("log stream exceeded the idle deadline".into()))?
            // A body error can also retain reqwest's credentialed request URL. Keep surfaced
            // transport diagnostics independent of the request, its query, and its headers.
            .map_err(|_| {
                retryable_stream_error("log stream transport failed while reading".into())
            })?;
        let Some(chunk) = chunk else { break };
        buffer.extend_from_slice(&chunk);
        while let Some((end, delimiter)) = frame_boundary(&buffer) {
            if end > MAX_SSE_FRAME_BYTES {
                return Err(CliError::Api(
                    "log stream event exceeded the 512 KiB limit".into(),
                ));
            }
            let frame = buffer[..end].to_vec();
            buffer.drain(..end + delimiter);
            if frame.is_empty() {
                continue;
            }
            let Some(parsed) = parse_sse_frame(&frame)? else {
                continue;
            };
            match parsed.event.as_str() {
                "log" => {
                    let id = parsed.id.ok_or_else(|| {
                        CliError::Api("log stream event did not carry a resume id".into())
                    })?;
                    validate_stream_cursor(&id)?;
                    let event: LogStreamEvent =
                        serde_json::from_str(&parsed.data).map_err(|_| {
                            CliError::Api("log stream returned an invalid version-1 event".into())
                        })?;
                    if event.schema_version != 1
                        || event.kind != "log"
                        || event.cursor != id
                        || event.line.cursor != id
                    {
                        return Err(CliError::Api(
                            "log stream event did not match its version-1 resume id".into(),
                        ));
                    }
                    emit(event)?;
                    // Advance only after stdout accepted the complete record. A broken pipe or
                    // disk error therefore never acknowledges a line the caller did not receive.
                    *checkpoint = Some(id);
                }
                "ready" => {
                    let control = parse_control(&parsed.data)?;
                    if control.kind != "ready" {
                        return Err(CliError::Api("invalid log stream ready event".into()));
                    }
                    if let Some(retry) = parsed.retry {
                        outcome.retry_after_ms = retry.clamp(100, 5_000);
                    }
                }
                "reconnect" => {
                    let control = parse_control(&parsed.data)?;
                    if control.kind != "reconnect" {
                        return Err(CliError::Api("invalid log stream reconnect event".into()));
                    }
                    outcome.retry_after_ms =
                        control.retry_after_ms.unwrap_or(1_000).clamp(100, 5_000);
                    outcome.reconnect_requested = true;
                }
                "error" => {
                    let control = parse_control(&parsed.data)?;
                    if control.kind != "error" {
                        return Err(CliError::Api("invalid log stream error event".into()));
                    }
                    return Err(CliError::Backend {
                        code: control.code.unwrap_or_else(|| "log_stream_error".into()),
                        message: redact_token(
                            &control
                                .message
                                .unwrap_or_else(|| "the log stream stopped".into()),
                            token,
                        ),
                        retryable: control.retryable.unwrap_or(false),
                    });
                }
                // Additive control events in a later compatible contract are ignored. Log events
                // themselves remain strict because silently accepting a changed row shape would
                // make `--json` unstable.
                _ => {}
            }
        }
        if buffer.len() > MAX_SSE_FRAME_BYTES {
            return Err(CliError::Api(
                "log stream event exceeded the 512 KiB limit".into(),
            ));
        }
    }
    Ok(outcome)
}

fn parse_control(data: &str) -> Result<StreamControl> {
    let control: StreamControl = serde_json::from_str(data)
        .map_err(|_| CliError::Api("log stream returned invalid control JSON".into()))?;
    if control.schema_version != 1 {
        return Err(CliError::Api(
            "log stream returned an unsupported schema version".into(),
        ));
    }
    Ok(control)
}

struct ParsedSse {
    event: String,
    id: Option<String>,
    data: String,
    retry: Option<u64>,
}

fn parse_sse_frame(frame: &[u8]) -> Result<Option<ParsedSse>> {
    let text = std::str::from_utf8(frame)
        .map_err(|_| CliError::Api("log stream returned non-UTF-8 data".into()))?;
    let mut event = "message".to_owned();
    let mut id = None;
    let mut data = Vec::new();
    let mut retry = None;
    for raw_line in text.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.starts_with(':') {
            continue;
        }
        let (field, value) = line.split_once(':').map_or((line, ""), |(field, value)| {
            (field, value.strip_prefix(' ').unwrap_or(value))
        });
        match field {
            "event" => event = value.to_owned(),
            "id" if !value.contains('\0') => id = Some(value.to_owned()),
            "data" => data.push(value),
            "retry" => retry = value.parse().ok(),
            _ => {}
        }
    }
    if data.is_empty() {
        return Ok(None);
    }
    Ok(Some(ParsedSse {
        event,
        id,
        data: data.join("\n"),
        retry,
    }))
}

fn frame_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|end| (end, 2));
    let crlf = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|end| (end, 4));
    match (lf, crlf) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(found), None) | (None, Some(found)) => Some(found),
        (None, None) => None,
    }
}

fn validate_stream_cursor(value: &str) -> Result<()> {
    let mut parts = value.split(':');
    let valid = parts.next() == Some("1")
        && parts.next().is_some_and(|part| {
            !part.is_empty() && part.len() <= 5 && part.bytes().all(|byte| byte.is_ascii_digit())
        })
        && parts.next().is_some_and(|part| {
            !part.is_empty() && part.len() <= 20 && part.bytes().all(|byte| byte.is_ascii_digit())
        })
        && parts.next().is_some_and(|part| {
            (32..=64).contains(&part.len())
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
        })
        && parts.next().is_none();
    if valid {
        Ok(())
    } else {
        Err(CliError::Api(
            "log stream returned an invalid resume id".into(),
        ))
    }
}

async fn bounded_response_body(mut response: reqwest::Response) -> Result<Vec<u8>> {
    let mut body = Vec::new();
    let deadline = tokio::time::Instant::now() + STREAM_FIRST_BYTE_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(retryable_stream_error(
                "log stream error response exceeded the read deadline".into(),
            ));
        }
        let chunk = tokio::time::timeout(STREAM_IDLE_TIMEOUT.min(remaining), response.chunk())
            .await
            .map_err(|_| {
                retryable_stream_error(
                    "log stream error response exceeded the idle deadline".into(),
                )
            })?
            .map_err(|_| {
                retryable_stream_error("log stream transport failed while reading an error".into())
            })?;
        let Some(chunk) = chunk else { break };
        if body.len().saturating_add(chunk.len()) > 64 * 1024 {
            return Err(CliError::Api(
                "log stream error response was too large".into(),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn redact_token(message: &str, token: &str) -> String {
    if token.is_empty() {
        message.to_owned()
    } else {
        message.replace(token, "[REDACTED]")
    }
}

fn retryable_stream_error(message: String) -> CliError {
    CliError::Backend {
        code: "log_stream_transport".into(),
        message,
        retryable: true,
    }
}

fn plugin_target(target: TemplateTarget) -> PluginTarget {
    match target {
        TemplateTarget::LinuxAmd64Musl => PluginTarget::LinuxAmd64Musl,
        TemplateTarget::LinuxArm64Musl => PluginTarget::LinuxArm64Musl,
        TemplateTarget::DarwinAmd64 => PluginTarget::DarwinAmd64,
        TemplateTarget::DarwinArm64 => PluginTarget::DarwinArm64,
        TemplateTarget::WindowsAmd64 => PluginTarget::WindowsAmd64,
    }
}

fn validate_template_input(resolved: &sprout_core::ResolvedTemplate, input: &str) -> Result<()> {
    let expected = serde_json::to_value(&resolved.request).map_err(|error| {
        CliError::Configuration(format!(
            "could not inspect resolved template request: {error}"
        ))
    })?;
    let supplied: Value = serde_json::from_str(input)
        .map_err(|error| CliError::InvalidInput(format!("--input is not JSON: {error}")))?;
    let supplied = supplied
        .as_object()
        .ok_or_else(|| CliError::InvalidInput("template --input must be a JSON object".into()))?;
    for (key, value) in supplied {
        let expected_value = expected.get(key).ok_or_else(|| {
            CliError::InvalidInput(format!(
                "template --input contains unsupported structural field `{key}`"
            ))
        })?;
        if value != expected_value {
            return Err(CliError::InvalidInput(format!(
                "template --input field `{key}` differs from the authoritative signed catalogue"
            )));
        }
    }
    Ok(())
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
        DeployPreset::Function => "function",
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
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

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

    #[test]
    fn parses_fragment_safe_sse_fields_and_rejects_bad_resume_ids() {
        let cursor = format!("1:2:1787918400000:{}", "A".repeat(32));
        let frame = format!(
            "event: log\r\nid: {cursor}\r\ndata: {{\"schemaVersion\":1,\"type\":\"log\"}}\r\n"
        );
        let parsed = parse_sse_frame(frame.as_bytes()).unwrap().unwrap();
        assert_eq!(parsed.event, "log");
        assert_eq!(parsed.id.as_deref(), Some(cursor.as_str()));
        assert_eq!(parsed.data, r#"{"schemaVersion":1,"type":"log"}"#);
        assert!(validate_stream_cursor(&cursor).is_ok());
        assert!(validate_stream_cursor("1:2:1787918400000:not-a-digest").is_err());
        assert_eq!(
            frame_boundary(format!("{frame}\r\nnext").as_bytes()),
            Some((frame.len() - 2, 4))
        );
    }

    #[test]
    fn stream_diagnostics_redact_the_bearer_value() {
        assert_eq!(
            redact_token("server echoed bearer-canary", "bearer-canary"),
            "server echoed [REDACTED]"
        );
    }

    #[tokio::test]
    async fn follow_sends_auth_and_resumes_only_after_a_complete_jsonl_record() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let cursor = format!("1:2:1787918400000:{}", "C".repeat(32));
        let server_cursor = cursor.clone();
        let server = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.unwrap();
            let first_request = read_http_headers(&mut first).await;
            assert!(
                first_request.starts_with("GET /v1/orgs/acme/projects/p/logs/follow?limit=100 ")
            );
            assert!(first_request.contains("authorization: Bearer bearer-canary\r\n"));
            assert!(!first_request.contains("last-event-id:"));

            let data = serde_json::json!({
                "schemaVersion": 1,
                "type": "log",
                "cursor": server_cursor,
                "line": {
                    "timestamp": "2026-08-28T12:00:00.000Z",
                    "cursor": server_cursor,
                    "level": "info",
                    "message": "live",
                    "requestId": "r",
                    "deploymentId": "d",
                    "durationMs": null,
                    "billedMs": null,
                    "memoryMb": null,
                    "initMs": null,
                    "coldStart": null
                }
            });
            let body = format!(
                "event: ready\ndata: {{\"schemaVersion\":1,\"type\":\"ready\"}}\n\n\
                 event: log\nid: {server_cursor}\ndata: {data}\n\n"
            );
            first
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n{:X}\r\n{body}\r\n",
                        body.len(),
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            // A broken chunk after one complete log reproduces a network failure after stdout
            // flushed. The next request must carry that record's checkpoint, not replay it.
            first.write_all(b"not-a-chunk-size\r\n").await.unwrap();
            first.shutdown().await.unwrap();

            let (mut second, _) = listener.accept().await.unwrap();
            let second_request = read_http_headers(&mut second).await;
            assert!(second_request.contains("authorization: Bearer bearer-canary\r\n"));
            assert!(second_request.contains(&format!("last-event-id: {server_cursor}\r\n")));
            assert!(second_request.contains(&format!(
                "cursor=1%3A2%3A1787918400000%3A{}",
                "C".repeat(32)
            )));
            let body = r#"{"message":"credential bearer-canary is no longer accepted"}"#;
            second
                .write_all(
                    format!(
                        "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let backend = CoreBackend::new(&format!("http://{address}"), true).unwrap();
        let mut events = Vec::new();
        let error = backend
            .follow_logs(
                ApiRequest {
                    method: CliMethod::Get,
                    path: "/v1/orgs/acme/projects/p/logs/follow?limit=100".into(),
                    body: None,
                },
                "bearer-canary",
                &mut |event| {
                    events.push(event);
                    Ok(())
                },
            )
            .await
            .unwrap_err();
        server.await.unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].cursor, cursor);
        assert!(!error.to_string().contains("bearer-canary"));
        assert!(error.to_string().contains("[REDACTED]"));
    }

    async fn read_http_headers(stream: &mut tokio::net::TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut byte = [0_u8; 1];
        while !bytes.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).await.unwrap();
            bytes.push(byte[0]);
            assert!(bytes.len() < 32 * 1024);
        }
        String::from_utf8(bytes).unwrap()
    }
}
