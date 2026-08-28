use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Context as _, bail};
use serde::{Deserialize, Serialize};

use crate::api::{CompleteRequest, SignReleaseJob};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvisionCheckpoint {
    pub android_app_id: String,
    pub package_name: String,
    pub encrypted_key_object_key: String,
    pub certificate_sha256: String,
    pub encrypted: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignCheckpoint {
    pub android_app_id: String,
    pub project_id: String,
    pub deployment_id: String,
    pub package_name: String,
    pub version_code: u64,
    pub version_name: String,
    pub certificate_sha256: String,
    pub unsigned_digest: String,
    pub encrypted_key_object_key: String,
    pub encrypted_key_object_version: String,
    pub signed_key: String,
    pub signed_digest: String,
    pub size_bytes: u64,
    #[serde(skip)]
    pub signed_apk: PathBuf,
}

impl SignCheckpoint {
    pub fn assert_matches(&self, job: &SignReleaseJob) -> anyhow::Result<()> {
        if self.package_name != job.package_name
            || self.android_app_id != job.android_app_id
            || self.project_id != job.project_id
            || self.deployment_id != job.deployment_id
            || self.version_code != job.version_code
            || self.certificate_sha256 != job.expected_certificate_sha256
            || self.unsigned_digest != job.unsigned_digest
            || self.encrypted_key_object_key != job.encrypted_key_object_key
            || self.encrypted_key_object_version != job.encrypted_key_object_version
            || self.signed_key != job.signed_key
        {
            bail!("the release changed while a signing job was in flight")
        }
        if crate::apk::sha256_file(&self.signed_apk)? != self.signed_digest {
            bail!("the durable signed APK checkpoint was modified")
        }
        Ok(())
    }

    pub fn completion(
        &self,
        signer_id: &str,
        job: &SignReleaseJob,
        signed_object_version: String,
    ) -> CompleteRequest {
        CompleteRequest::SignRelease {
            job_id: job.job_id.clone(),
            signer_id: signer_id.to_owned(),
            signed_key: job.signed_key.clone(),
            signed_object_version,
            signed_digest: self.signed_digest.clone(),
            size_bytes: self.size_bytes,
            package_name: self.package_name.clone(),
            version_code: self.version_code,
            version_name: self.version_name.clone(),
            certificate_sha256: self.certificate_sha256.clone(),
        }
    }
}

#[derive(Clone)]
pub struct StateStore {
    root: PathBuf,
}

impl StateStore {
    pub fn open(root: PathBuf) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&root)?;
        restrict_directory(&root)?;
        Ok(Self { root })
    }

    pub fn load_provision(&self, job_id: &str) -> anyhow::Result<Option<ProvisionCheckpoint>> {
        self.load(job_id, "provision.json")
    }

    pub fn save_provision(
        &self,
        job_id: &str,
        checkpoint: &ProvisionCheckpoint,
    ) -> anyhow::Result<()> {
        self.save(job_id, "provision.json", checkpoint)
    }

    pub fn load_sign(&self, job_id: &str) -> anyhow::Result<Option<SignCheckpoint>> {
        let mut checkpoint: Option<SignCheckpoint> = self.load(job_id, "sign.json")?;
        if let Some(checkpoint) = checkpoint.as_mut() {
            checkpoint.signed_apk = self.job_dir(job_id)?.join("signed.apk");
        }
        Ok(checkpoint)
    }

    pub fn save_sign(
        &self,
        job: &SignReleaseJob,
        apk: &Path,
        mut checkpoint: SignCheckpoint,
    ) -> anyhow::Result<SignCheckpoint> {
        let directory = self.job_dir(&job.job_id)?;
        std::fs::create_dir_all(&directory)?;
        restrict_directory(&directory)?;
        let destination = directory.join("signed.apk");
        atomic_copy(apk, &destination)?;
        checkpoint.signed_apk = destination;
        self.save(&job.job_id, "sign.json", &checkpoint)?;
        Ok(checkpoint)
    }

    pub fn mark_complete(&self, job_id: &str) -> anyhow::Result<()> {
        let directory = self.job_dir(job_id)?;
        if !directory.exists() {
            return Ok(());
        }
        for name in ["provision.json", "sign.json", "signed.apk"] {
            let path = directory.join(name);
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
                Err(cause) => return Err(cause.into()),
            }
        }
        match std::fs::remove_dir(&directory) {
            Ok(()) => Ok(()),
            Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(cause) => Err(cause.into()),
        }
    }

    fn load<T: for<'de> Deserialize<'de>>(
        &self,
        job_id: &str,
        name: &str,
    ) -> anyhow::Result<Option<T>> {
        let path = self.job_dir(job_id)?.join(name);
        match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).with_context(|| {
                format!("checkpoint {} is malformed", path.display())
            })?)),
            Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(cause) => Err(cause.into()),
        }
    }

    fn save<T: Serialize>(&self, job_id: &str, name: &str, value: &T) -> anyhow::Result<()> {
        let directory = self.job_dir(job_id)?;
        std::fs::create_dir_all(&directory)?;
        restrict_directory(&directory)?;
        let destination = directory.join(name);
        let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
        temporary.write_all(&serde_json::to_vec(value)?)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&destination)
            .map_err(|error| error.error)?;
        restrict_file(&destination)?;
        Ok(())
    }

    fn job_dir(&self, job_id: &str) -> anyhow::Result<PathBuf> {
        let id = uuid::Uuid::parse_str(job_id).context("signer job id is not a UUID")?;
        Ok(self.root.join(id.to_string()))
    }
}

fn atomic_copy(source: &Path, destination: &Path) -> anyhow::Result<()> {
    let parent = destination.parent().context("checkpoint has no parent")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    let mut input = std::fs::File::open(source)?;
    std::io::copy(&mut input, &mut temporary)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(destination)
        .map_err(|error| error.error)?;
    restrict_file(destination)?;
    Ok(())
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

#[cfg(unix)]
fn restrict_file(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_file(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provision_checkpoint_survives_restart_and_is_removed_after_completion() {
        let temp = tempfile::tempdir().unwrap();
        let job = uuid::Uuid::now_v7().to_string();
        let store = StateStore::open(temp.path().join("state")).unwrap();
        let checkpoint = ProvisionCheckpoint {
            android_app_id: "019d0000-0000-7000-8000-000000000001".into(),
            package_name: "me.sproutos.app.pabc".into(),
            encrypted_key_object_key:
                "keys/019d0000-0000-7000-8000-000000000001/signing.keystore.enc".into(),
            certificate_sha256: "a".repeat(64),
            encrypted: vec![1, 2, 3],
        };
        store.save_provision(&job, &checkpoint).unwrap();

        let reopened = StateStore::open(temp.path().join("state")).unwrap();
        let loaded = reopened.load_provision(&job).unwrap().unwrap();
        assert_eq!(loaded.encrypted, checkpoint.encrypted);
        reopened.mark_complete(&job).unwrap();
        assert!(reopened.load_provision(&job).unwrap().is_none());
    }

    #[test]
    fn signed_checkpoint_is_bound_to_every_immutable_claim_field() {
        let temp = tempfile::tempdir().unwrap();
        let signed_apk = temp.path().join("signed.apk");
        std::fs::write(&signed_apk, b"signed bytes").unwrap();
        let mut job = SignReleaseJob {
            job_id: uuid::Uuid::now_v7().to_string(),
            android_app_id: uuid::Uuid::now_v7().to_string(),
            package_name: "com.sproutos.store".into(),
            project_id: "platform".into(),
            deployment_id: "platform".into(),
            download_url: "https://bucket.s3.us-east-1.amazonaws.com/raw?X-Amz-Signature=x".into(),
            unsigned_digest: "a".repeat(64),
            input_mime: crate::APK_MIME.into(),
            version_code: 2,
            previous_version_code: 1,
            expected_certificate_sha256: "b".repeat(64),
            key_download_url: "https://bucket.s3.us-east-1.amazonaws.com/key?X-Amz-Signature=x"
                .into(),
            encrypted_key_object_key: "keys/client/signing.keystore.enc".into(),
            encrypted_key_object_version: "key-version".into(),
            upload_url: "https://bucket.s3.us-east-1.amazonaws.com/signed?X-Amz-Signature=x".into(),
            signed_key: "signed/client/job.apk".into(),
        };
        let checkpoint = SignCheckpoint {
            android_app_id: job.android_app_id.clone(),
            project_id: job.project_id.clone(),
            deployment_id: job.deployment_id.clone(),
            package_name: job.package_name.clone(),
            version_code: job.version_code,
            version_name: "1.0".into(),
            certificate_sha256: job.expected_certificate_sha256.clone(),
            unsigned_digest: job.unsigned_digest.clone(),
            encrypted_key_object_key: job.encrypted_key_object_key.clone(),
            encrypted_key_object_version: job.encrypted_key_object_version.clone(),
            signed_key: job.signed_key.clone(),
            signed_digest: crate::apk::sha256_file(&signed_apk).unwrap(),
            size_bytes: 12,
            signed_apk,
        };
        checkpoint.assert_matches(&job).unwrap();
        job.encrypted_key_object_version = "different-version".into();
        assert!(checkpoint.assert_matches(&job).is_err());
    }
}
