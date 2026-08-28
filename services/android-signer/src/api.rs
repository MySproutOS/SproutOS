use std::path::Path;

use anyhow::{Context as _, bail};
use futures_util::StreamExt as _;
use reqwest::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::io::AsyncWriteExt as _;
use tokio_util::io::ReaderStream;

use crate::{APK_MIME, response_is_apk};

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClaimedJob {
    ProvisionKey(ProvisionKeyJob),
    SignRelease(Box<SignReleaseJob>),
}

impl ClaimedJob {
    pub fn job_id(&self) -> &str {
        match self {
            Self::ProvisionKey(job) => &job.job_id,
            Self::SignRelease(job) => &job.job_id,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::ProvisionKey(_) => "provision_key",
            Self::SignRelease(_) => "sign_release",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProvisionKeyJob {
    pub job_id: String,
    pub android_app_id: String,
    pub package_name: String,
    pub encrypted_key_upload_url: String,
    pub encrypted_key_object_key: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SignReleaseJob {
    pub job_id: String,
    pub android_app_id: String,
    pub package_name: String,
    pub project_id: String,
    pub deployment_id: String,
    pub download_url: String,
    pub unsigned_digest: String,
    pub input_mime: String,
    pub version_code: u64,
    pub previous_version_code: u64,
    pub expected_certificate_sha256: String,
    pub key_download_url: String,
    pub encrypted_key_object_key: String,
    pub encrypted_key_object_version: String,
    pub upload_url: String,
    pub signed_key: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeveloperConsoleState {
    PendingRegistration,
    Registered,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CompleteRequest {
    ProvisionKey {
        job_id: String,
        signer_id: String,
        encrypted_key_object_key: String,
        encrypted_key_object_version: String,
        certificate_sha256: String,
        developer_console_state: DeveloperConsoleState,
    },
    SignRelease {
        job_id: String,
        signer_id: String,
        signed_key: String,
        signed_object_version: String,
        signed_digest: String,
        size_bytes: u64,
        package_name: String,
        version_code: u64,
        version_name: String,
        certificate_sha256: String,
    },
}

#[derive(Debug, Serialize)]
struct ClaimRequest<'a> {
    signer_id: &'a str,
}

#[derive(Debug, Serialize)]
struct FailRequest<'a> {
    job_id: &'a str,
    signer_id: &'a str,
    error: &'a str,
}

#[derive(Debug, Clone)]
pub struct UploadResult {
    pub version_id: Option<String>,
}

#[allow(async_fn_in_trait)]
pub trait ControlPlane: Send + Sync {
    fn signer_id(&self) -> &str;
    async fn claim(&self) -> anyhow::Result<Option<ClaimedJob>>;
    async fn complete(&self, request: &CompleteRequest) -> anyhow::Result<()>;
    async fn fail(&self, job_id: &str, error: &str) -> anyhow::Result<()>;
    async fn get_bytes(&self, url: &str, max_bytes: u64) -> anyhow::Result<Vec<u8>>;
    async fn download_file(
        &self,
        url: &str,
        expected_mime: &str,
        expected_sha256: &str,
        max_bytes: u64,
        destination: &Path,
    ) -> anyhow::Result<()>;
    async fn put_bytes(
        &self,
        url: &str,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> anyhow::Result<UploadResult>;
    async fn put_file(
        &self,
        url: &str,
        content_type: &str,
        path: &Path,
    ) -> anyhow::Result<UploadResult>;
}

pub struct SignerApi {
    client: reqwest::Client,
    base_url: String,
    token: String,
    signer_id: String,
}

impl SignerApi {
    pub fn new(
        base_url: impl Into<String>,
        token: impl Into<String>,
        signer_id: impl Into<String>,
    ) -> anyhow::Result<Self> {
        let base_url = base_url.into().trim_end_matches('/').to_owned();
        let parsed = url::Url::parse(&base_url).context("APK_SIGNER_API_URL is not a URL")?;
        if parsed.scheme() != "https" && !is_loopback(&parsed) {
            bail!("APK_SIGNER_API_URL must use HTTPS except on loopback")
        }
        let token = token.into();
        if token.is_empty() {
            bail!("APK_SIGNER_TOKEN must not be empty")
        }
        let signer_id = signer_id.into();
        if signer_id.is_empty() || signer_id.len() > 200 {
            bail!("APK_SIGNER_ID must be between 1 and 200 bytes")
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(15 * 60))
                // Neither control-plane credentials nor an on-prem network client follow a URL
                // chosen by an HTTP response. S3 presigned URLs are already region-specific.
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            base_url,
            token,
            signer_id,
        })
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}/v1/apk-signing/{path}", self.base_url)
    }

    fn authorized(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request.header(AUTHORIZATION, format!("Bearer {}", self.token))
    }

    async fn require_success(response: reqwest::Response, operation: &str) -> anyhow::Result<()> {
        if response.status().is_success() {
            return Ok(());
        }
        let status = response.status();
        // Bodies may contain platform diagnostics. Bound them and never include request URLs.
        let body = response.text().await.unwrap_or_default();
        let body: String = body.chars().take(1000).collect();
        bail!("{operation} was refused: {status} {body}")
    }
}

impl ControlPlane for SignerApi {
    fn signer_id(&self) -> &str {
        &self.signer_id
    }

    async fn claim(&self) -> anyhow::Result<Option<ClaimedJob>> {
        let response = self
            .authorized(self.client.post(self.endpoint("claim")))
            .json(&ClaimRequest {
                signer_id: &self.signer_id,
            })
            .send()
            .await
            .context("could not reach the signer claim endpoint")?;
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        if !response.status().is_success() {
            Self::require_success(response, "job claim").await?;
            unreachable!();
        }
        Ok(Some(response.json().await.context(
            "job claim was not the normalized signer protocol",
        )?))
    }

    async fn complete(&self, request: &CompleteRequest) -> anyhow::Result<()> {
        let response = self
            .authorized(self.client.post(self.endpoint("complete")))
            .header("Idempotency-Key", idempotency_key(request)?)
            .json(request)
            .send()
            .await
            .context("could not reach the signer completion endpoint")?;
        Self::require_success(response, "job completion").await
    }

    async fn fail(&self, job_id: &str, error: &str) -> anyhow::Result<()> {
        let request = FailRequest {
            job_id,
            signer_id: &self.signer_id,
            error,
        };
        let response = self
            .authorized(self.client.post(self.endpoint("fail")))
            .header(
                "Idempotency-Key",
                hex::encode(Sha256::digest(serde_json::to_vec(&request)?)),
            )
            .json(&request)
            .send()
            .await
            .context("could not reach the signer failure endpoint")?;
        Self::require_success(response, "job failure report").await
    }

    async fn get_bytes(&self, url: &str, max_bytes: u64) -> anyhow::Result<Vec<u8>> {
        validate_artifact_url(url)?;
        let response = self.client.get(url).send().await.context("GET failed")?;
        if !response.status().is_success() {
            bail!("GET was refused with {}", response.status())
        }
        if response
            .content_length()
            .is_some_and(|size| size > max_bytes)
        {
            bail!("download exceeds the configured size limit")
        }
        let mut stream = response.bytes_stream();
        let mut result = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("download body failed")?;
            if result.len() as u64 + chunk.len() as u64 > max_bytes {
                bail!("download exceeds the configured size limit")
            }
            result.extend_from_slice(&chunk);
        }
        Ok(result)
    }

    async fn download_file(
        &self,
        url: &str,
        expected_mime: &str,
        expected_sha256: &str,
        max_bytes: u64,
        destination: &Path,
    ) -> anyhow::Result<()> {
        validate_artifact_url(url)?;
        if expected_mime != APK_MIME {
            bail!("only raw Android APK downloads are accepted")
        }
        let response = self.client.get(url).send().await.context("GET failed")?;
        if !response.status().is_success() {
            bail!("GET was refused with {}", response.status())
        }
        if !response_is_apk(&response) {
            bail!("download response is not {APK_MIME}")
        }
        if response
            .content_length()
            .is_some_and(|size| size > max_bytes)
        {
            bail!("APK exceeds the configured size limit")
        }

        let mut file = tokio::fs::File::create(destination).await?;
        let mut stream = response.bytes_stream();
        let mut digest = Sha256::new();
        let mut size = 0_u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("download body failed")?;
            size = size
                .checked_add(chunk.len() as u64)
                .context("APK size overflow")?;
            if size > max_bytes {
                bail!("APK exceeds the configured size limit")
            }
            digest.update(&chunk);
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        let actual = hex::encode(digest.finalize());
        if !actual.eq_ignore_ascii_case(expected_sha256) {
            bail!("unsigned APK digest does not match the release")
        }
        Ok(())
    }

    async fn put_bytes(
        &self,
        url: &str,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> anyhow::Result<UploadResult> {
        validate_artifact_url(url)?;
        let response = self
            .client
            .put(url)
            .header(CONTENT_TYPE, content_type)
            .header(CONTENT_LENGTH, bytes.len())
            .body(bytes)
            .send()
            .await
            .context("PUT failed")?;
        upload_result(response).await
    }

    async fn put_file(
        &self,
        url: &str,
        content_type: &str,
        path: &Path,
    ) -> anyhow::Result<UploadResult> {
        validate_artifact_url(url)?;
        let file = tokio::fs::File::open(path).await?;
        let size = file.metadata().await?.len();
        let response = self
            .client
            .put(url)
            .header(CONTENT_TYPE, content_type)
            .header(CONTENT_LENGTH, size)
            .body(reqwest::Body::wrap_stream(ReaderStream::new(file)))
            .send()
            .await
            .context("PUT failed")?;
        upload_result(response).await
    }
}

async fn upload_result(response: reqwest::Response) -> anyhow::Result<UploadResult> {
    if !response.status().is_success() {
        bail!("PUT was refused with {}", response.status())
    }
    Ok(UploadResult {
        version_id: response
            .headers()
            .get("x-amz-version-id")
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned),
    })
}

fn idempotency_key(request: &CompleteRequest) -> anyhow::Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(request)?)))
}

fn is_loopback(url: &url::Url) -> bool {
    matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    )
}

fn validate_artifact_url(raw: &str) -> anyhow::Result<()> {
    let url = url::Url::parse(raw).context("artifact URL is malformed")?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        bail!("artifact URL contains forbidden authority or fragment data")
    }
    if is_loopback(&url) {
        if matches!(url.scheme(), "http" | "https") {
            return Ok(());
        }
        bail!("local artifact URL must use HTTP")
    }
    let host = url.host_str().unwrap_or_default();
    let aws_s3 = host.ends_with(".amazonaws.com") || host.ends_with(".amazonaws.com.cn");
    if url.scheme() != "https" || !aws_s3 {
        bail!("artifact URL must be an HTTPS AWS S3 presigned URL")
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_plaintext_remote_control_plane() {
        let error = match SignerApi::new("http://api.example.com", "token", "signer") {
            Ok(_) => panic!("plaintext remote API was accepted"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("HTTPS"));
        assert!(SignerApi::new("http://127.0.0.1:3001", "token", "signer").is_ok());
    }

    #[test]
    fn completion_idempotency_key_is_stable() {
        let request = CompleteRequest::SignRelease {
            job_id: "job".into(),
            signer_id: "signer".into(),
            signed_key: "key".into(),
            signed_object_version: "version".into(),
            signed_digest: "d".repeat(64),
            size_bytes: 1,
            package_name: "me.sproutos.app.pabc".into(),
            version_code: 2,
            version_name: "2.0".into(),
            certificate_sha256: "c".repeat(64),
        };
        assert_eq!(
            idempotency_key(&request).unwrap(),
            idempotency_key(&request).unwrap()
        );
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["kind"], "sign_release");
        assert_eq!(json["signed_object_version"], "version");
        assert_eq!(json["version_name"], "2.0");
        assert!(json.get("SignRelease").is_none());
    }

    #[test]
    fn claim_protocol_is_a_flat_discriminated_union() {
        let provision: ClaimedJob = serde_json::from_value(serde_json::json!({
            "kind": "provision_key",
            "job_id": "019d0000-0000-7000-8000-000000000001",
            "android_app_id": "019d0000-0000-7000-8000-000000000002",
            "package_name": "me.sproutos.app.pabc",
            "encrypted_key_upload_url": "https://bucket.s3.us-east-1.amazonaws.com/key",
            "encrypted_key_object_key": "keys/app.envelope"
        }))
        .unwrap();
        assert!(matches!(provision, ClaimedJob::ProvisionKey(_)));

        let sign: ClaimedJob = serde_json::from_value(serde_json::json!({
            "kind": "sign_release",
            "job_id": "019d0000-0000-7000-8000-000000000003",
            "android_app_id": "019d0000-0000-7000-8000-000000000002",
            "package_name": "me.sproutos.app.pabc",
            "project_id": "019d0000-0000-7000-8000-000000000004",
            "deployment_id": "019d0000-0000-7000-8000-000000000005",
            "download_url": "https://bucket.s3.us-east-1.amazonaws.com/unsigned",
            "unsigned_digest": "aa",
            "input_mime": "application/vnd.android.package-archive",
            "version_code": 2,
            "previous_version_code": 1,
            "expected_certificate_sha256": "bb",
            "key_download_url": "https://bucket.s3.us-east-1.amazonaws.com/key?versionId=one",
            "encrypted_key_object_key": "keys/app.envelope",
            "encrypted_key_object_version": "one",
            "upload_url": "https://bucket.s3.us-east-1.amazonaws.com/signed",
            "signed_key": "signed/app/job.apk"
        }))
        .unwrap();
        assert!(matches!(sign, ClaimedJob::SignRelease(_)));
    }

    #[test]
    fn artifact_urls_cannot_turn_the_signer_into_an_internal_network_client() {
        assert!(
            validate_artifact_url("https://bucket.s3.us-east-1.amazonaws.com/key?sig=x").is_ok()
        );
        assert!(validate_artifact_url("http://127.0.0.1:4566/bucket/key").is_ok());
        assert!(validate_artifact_url("http://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_artifact_url("https://example.com/file.apk").is_err());
    }
}
