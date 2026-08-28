//! The on-premises half of SproutOS Android distribution.
//!
//! This crate deliberately owns no database or AWS credential. It polls the public control-plane
//! API with one bearer token and transfers artifacts only through narrowly-scoped, versioned S3
//! presigned URLs. The master key used to decrypt app keystores never leaves this machine.

pub mod api;
pub mod apk;
pub mod crypto;
pub mod developer_console;
pub mod process;
pub mod state;

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context as _, bail};
use api::{ClaimedJob, CompleteRequest, DeveloperConsoleState, SignerApi};
use crypto::MasterIdentity;
use process::{AndroidTools, CommandAndroidTools};
use reqwest::header::CONTENT_TYPE;
use sha2::{Digest as _, Sha256};
use state::{ProvisionCheckpoint, SignCheckpoint, StateStore};
use tracing::{info, warn};
use zeroize::Zeroize as _;

pub const APK_MIME: &str = "application/vnd.android.package-archive";

#[derive(Clone)]
pub struct SignerConfig {
    pub max_apk_bytes: u64,
    pub poll_interval: Duration,
}

impl Default for SignerConfig {
    fn default() -> Self {
        Self {
            max_apk_bytes: 512 * 1024 * 1024,
            poll_interval: Duration::from_secs(30),
        }
    }
}

pub struct Signer<A = SignerApi, T = CommandAndroidTools> {
    api: A,
    tools: T,
    identity: MasterIdentity,
    state: StateStore,
    config: SignerConfig,
}

impl<A, T> Signer<A, T>
where
    A: api::ControlPlane,
    T: AndroidTools,
{
    pub fn new(
        api: A,
        tools: T,
        identity: MasterIdentity,
        state: StateStore,
        config: SignerConfig,
    ) -> Self {
        Self {
            api,
            tools,
            identity,
            state,
            config,
        }
    }

    /// Process at most one job. `false` is the normal idle answer.
    pub async fn run_once(&self) -> anyhow::Result<bool> {
        let Some(job) = self.api.claim().await? else {
            return Ok(false);
        };
        let job_id = job.job_id().to_owned();
        let kind = job.kind();

        let result = match job {
            ClaimedJob::ProvisionKey(job) => self.provision_key(job).await,
            ClaimedJob::SignRelease(job) => self.sign_release(*job).await,
        };

        match result {
            Ok(completion) => {
                self.api.complete(&completion).await?;
                self.state.mark_complete(&job_id)?;
                info!(%job_id, %kind, "signer job completed");
                Ok(true)
            }
            Err(cause) => {
                // Never send paths, command output, tokens, URLs, or key material to the platform.
                let public_error = public_error(&cause);
                warn!(%job_id, %kind, error = %public_error, "signer job failed");
                self.api.fail(&job_id, &public_error).await?;
                Ok(true)
            }
        }
    }

    pub async fn run(&self) -> anyhow::Result<()> {
        loop {
            if !self.run_once().await? {
                tokio::time::sleep(self.config.poll_interval).await;
            }
        }
    }

    async fn provision_key(&self, job: api::ProvisionKeyJob) -> anyhow::Result<CompleteRequest> {
        let checkpoint = if let Some(saved) = self.state.load_provision(&job.job_id)? {
            if saved.package_name != job.package_name {
                bail!("the package name changed while a key-provision job was in flight")
            }
            saved
        } else {
            let secret = self
                .tools
                .generate_key(&job.package_name)
                .context("could not create the app signing identity")?;
            let mut encoded = secret.encoded();
            let encrypted = self.identity.encrypt(&encoded);
            encoded.zeroize();
            let encrypted = encrypted.context("could not protect the app signing identity")?;
            let checkpoint = ProvisionCheckpoint {
                package_name: job.package_name.clone(),
                certificate_sha256: secret.certificate_sha256.clone(),
                encrypted,
            };
            // Persist before upload: a crash must resume with this same app identity.
            self.state.save_provision(&job.job_id, &checkpoint)?;
            checkpoint
        };

        let uploaded = self
            .api
            .put_bytes(
                &job.encrypted_key_upload_url,
                "application/octet-stream",
                checkpoint.encrypted.clone(),
            )
            .await
            .context("could not store the protected app signing identity")?;

        let version = uploaded.version_id.context(
            "the private key bucket did not return x-amz-version-id; versioning is required",
        )?;

        Ok(CompleteRequest::ProvisionKey {
            job_id: job.job_id,
            signer_id: self.api.signer_id().to_owned(),
            encrypted_key_object_key: job.encrypted_key_object_key,
            encrypted_key_object_version: version,
            certificate_sha256: checkpoint.certificate_sha256,
            // Registration is deliberately not fabricated. The API contract must add the official
            // Android Developer Console operation before this can become `registered`.
            developer_console_state: DeveloperConsoleState::PendingRegistration,
        })
    }

    async fn sign_release(&self, job: api::SignReleaseJob) -> anyhow::Result<CompleteRequest> {
        if job.input_mime != APK_MIME {
            bail!("input_mime is not {APK_MIME}")
        }
        if job.version_code <= job.previous_version_code {
            bail!("versionCode is not greater than the last accepted release")
        }

        if let Some(saved) = self.state.load_sign(&job.job_id)? {
            saved.assert_matches(&job)?;
            let uploaded = self
                .api
                .put_file(&job.upload_url, APK_MIME, &saved.signed_apk)
                .await
                .context("could not resume signed APK upload")?;
            let version = uploaded.version_id.context(
                "the signed APK bucket did not return x-amz-version-id; versioning is required",
            )?;
            return Ok(saved.completion(self.api.signer_id(), &job, version));
        }

        let temp = tempfile::Builder::new()
            .prefix("sproutos-android-sign-")
            .tempdir()
            .context("could not create the restricted signing directory")?;
        restrict_directory(temp.path())?;
        let unsigned = temp.path().join("unsigned.apk");
        self.api
            .download_file(
                &job.download_url,
                APK_MIME,
                &job.unsigned_digest,
                self.config.max_apk_bytes,
                &unsigned,
            )
            .await
            .context("could not download and authenticate the unsigned APK")?;

        apk::validate_unsigned_zip_structure(&unsigned)?;
        self.tools.assert_unsigned(&unsigned)?;
        let manifest = self.tools.manifest(&unsigned)?;
        manifest.assert_expected(&job.package_name, job.version_code)?;

        let encrypted_key = self
            .api
            .get_bytes(&job.key_download_url, 32 * 1024 * 1024)
            .await
            .context("could not download the protected app signing identity")?;
        let encrypted_digest = hex::encode(Sha256::digest(&encrypted_key));
        // The object version is included in the signed URL by the platform. Recording it here makes
        // the otherwise easy-to-miss dependency explicit in logs without printing the URL.
        info!(
            job_id = %job.job_id,
            key_version = %job.encrypted_key_object_version,
            key_digest = %encrypted_digest,
            "downloaded versioned app identity"
        );
        let mut decoded = self
            .identity
            .decrypt(&encrypted_key)
            .context("could not unlock the app signing identity")?;
        let key = crypto::AppSigningSecret::decode(&decoded);
        decoded.zeroize();
        let key = key?;
        if key.certificate_sha256 != job.expected_certificate_sha256 {
            bail!("the protected key certificate does not match the app record")
        }

        let signed = temp.path().join("signed.apk");
        self.tools.sign(&unsigned, &signed, &key)?;
        apk::validate_zip_structure(&signed)?;
        let signed_manifest = self.tools.manifest(&signed)?;
        signed_manifest.assert_expected(&job.package_name, job.version_code)?;
        let certificate_sha256 = self.tools.verify_signed(&signed)?;
        if certificate_sha256 != job.expected_certificate_sha256 {
            bail!("the signed APK certificate does not match the app record")
        }

        let signed_digest = apk::sha256_file(&signed)?;
        let size_bytes = std::fs::metadata(&signed)?.len();
        let checkpoint = self.state.save_sign(
            &job,
            &signed,
            SignCheckpoint {
                package_name: manifest.package_name,
                version_code: manifest.version_code,
                version_name: manifest.version_name,
                certificate_sha256,
                signed_digest,
                size_bytes,
                signed_apk: PathBuf::new(),
            },
        )?;

        let uploaded = self
            .api
            .put_file(&job.upload_url, APK_MIME, &checkpoint.signed_apk)
            .await
            .context("could not upload the signed APK")?;
        let version = uploaded.version_id.context(
            "the signed APK bucket did not return x-amz-version-id; versioning is required",
        )?;
        Ok(checkpoint.completion(self.api.signer_id(), &job, version))
    }
}

fn public_error(cause: &anyhow::Error) -> String {
    let message = cause
        .chain()
        .last()
        .map(ToString::to_string)
        .unwrap_or_else(|| "signing failed".to_owned());
    let scrubbed = if message.contains("http://") || message.contains("https://") {
        "artifact transfer failed".to_owned()
    } else {
        message
    };
    scrubbed.chars().take(1000).collect()
}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_directory(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

/// Require the response's actual MIME, not only the claim's assertion.
pub(crate) fn response_is_apk(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case(APK_MIME))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_errors_do_not_echo_presigned_urls() {
        let error = anyhow::anyhow!("GET https://bucket/?X-Amz-Signature=secret failed");
        assert_eq!(public_error(&error), "artifact transfer failed");
    }
}
