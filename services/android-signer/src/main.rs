use std::path::PathBuf;
use std::time::Duration;

use android_signer::api::{ClientIdentityStatus, SignerApi};
use android_signer::crypto::MasterIdentity;
use android_signer::process::{AndroidTools as _, CommandAndroidTools};
use android_signer::state::StateStore;
use android_signer::{CLIENT_PACKAGE_NAME, Signer, SignerConfig, apk};
use anyhow::Context as _;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "android-signer", version, about)]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Create the offline-backed master identity. Refuses to overwrite an existing identity.
    InitMaster {
        #[arg(long, env = "APK_SIGNER_MASTER_IDENTITY_PATH")]
        output: PathBuf,
    },
    /// Poll forever, sleeping when the queue is empty.
    Run(RuntimeArgs),
    /// Claim and process at most one job. Useful for installation smoke tests.
    Once(RuntimeArgs),
    /// Print the catalogue-client fingerprint for Play Console's manual Add key flow.
    ClientIdentity(ClientApiArgs),
    /// Validate and durably queue an unsigned catalogue-client APK for the on-prem signer.
    QueueClientRelease {
        #[command(flatten)]
        api: ClientApiArgs,
        #[arg(long)]
        apk: PathBuf,
        #[arg(long, env = "APK_SIGNER_ANDROID_SDK_ROOT")]
        android_sdk_root: Option<PathBuf>,
        #[arg(long, env = "APK_SIGNER_MAX_APK_BYTES", default_value_t = 536_870_912)]
        max_apk_bytes: u64,
    },
}

#[derive(clap::Args)]
struct ClientApiArgs {
    #[arg(
        long,
        env = "APK_SIGNER_API_URL",
        default_value = "https://api.sproutos.me"
    )]
    api_url: String,
    #[arg(long, env = "APK_SIGNER_ID")]
    signer_id: String,
}

#[derive(clap::Args)]
struct RuntimeArgs {
    #[arg(
        long,
        env = "APK_SIGNER_API_URL",
        default_value = "https://api.sproutos.me"
    )]
    api_url: String,
    #[arg(long, env = "APK_SIGNER_ID")]
    signer_id: String,
    #[arg(long, env = "APK_SIGNER_MASTER_IDENTITY_PATH")]
    master_identity: PathBuf,
    #[arg(long, env = "APK_SIGNER_STATE_DIR")]
    state_dir: PathBuf,
    #[arg(long, env = "APK_SIGNER_ANDROID_SDK_ROOT")]
    android_sdk_root: Option<PathBuf>,
    #[arg(long, env = "APK_SIGNER_POLL_SECONDS", default_value_t = 30)]
    poll_seconds: u64,
    #[arg(long, env = "APK_SIGNER_MAX_APK_BYTES", default_value_t = 536_870_912)]
    max_apk_bytes: u64,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "android_signer=info".into()),
        )
        .init();

    match Args::parse().command {
        Command::InitMaster { output } => {
            MasterIdentity::create(&output)?;
            println!("created master identity at {}", output.display());
            Ok(())
        }
        Command::Run(args) => runtime(args).await?.run().await,
        Command::Once(args) => {
            runtime(args).await?.run_once().await?;
            Ok(())
        }
        Command::ClientIdentity(args) => {
            let api = client_api(args)?;
            let identity = api.ensure_client_identity().await?;
            for line in client_identity_lines(&identity) {
                println!("{line}");
            }
            Ok(())
        }
        Command::QueueClientRelease {
            api,
            apk: unsigned_apk,
            android_sdk_root,
            max_apk_bytes,
        } => {
            if max_apk_bytes == 0 {
                anyhow::bail!("APK limit must be positive")
            }
            let size_bytes = std::fs::metadata(&unsigned_apk)?.len();
            if size_bytes == 0 || size_bytes > max_apk_bytes {
                anyhow::bail!("catalogue-client APK is empty or exceeds the configured limit")
            }
            apk::validate_unsigned_zip_structure(&unsigned_apk)?;
            let tools = CommandAndroidTools::discover(android_sdk_root.as_deref())?;
            tools.assert_unsigned(&unsigned_apk)?;
            let manifest = tools.manifest(&unsigned_apk)?;
            manifest.assert_expected(CLIENT_PACKAGE_NAME, manifest.version_code)?;
            if manifest.version_code > 2_100_000_000 {
                anyhow::bail!("catalogue-client APK versionCode exceeds Android's maximum")
            }
            if manifest.version_name.len() > 100 {
                anyhow::bail!("catalogue-client APK versionName exceeds 100 bytes")
            }
            let digest = apk::sha256_file(&unsigned_apk)?;
            let api = client_api(api)?;
            let prepared = api
                .prepare_client_release(
                    CLIENT_PACKAGE_NAME,
                    &digest,
                    size_bytes,
                    manifest.version_code,
                )
                .await?;
            if prepared.state != "awaiting_upload" {
                if !matches!(prepared.state.as_str(), "queued" | "running" | "succeeded") {
                    anyhow::bail!("control plane returned an unknown catalogue-client job state")
                }
                println!("queued_client_release_job={}", prepared.job_id);
                println!("client_release_job_state={}", prepared.state);
                println!("unsigned_sha256={digest}");
                return Ok(());
            }
            let upload_url = prepared
                .upload_url
                .as_deref()
                .context("awaiting-upload response omitted its presigned URL")?;
            let uploaded = api.upload_local_apk(upload_url, &unsigned_apk).await?;
            let version = uploaded.version_id.context(
                "the private artifact bucket did not return x-amz-version-id; versioning is required",
            )?;
            api.finalize_client_upload(&prepared, &version, &digest, size_bytes)
                .await?;
            println!("queued_client_release_job={}", prepared.job_id);
            println!("unsigned_sha256={digest}");
            Ok(())
        }
    }
}

fn client_identity_lines(identity: &ClientIdentityStatus) -> Vec<String> {
    let mut lines = vec![
        format!("package_name={}", identity.package_name),
        format!("state={}", identity.state),
        format!("registration_state={}", identity.registration_state),
    ];
    if let Some(provider_state) = &identity.registration_provider_state {
        lines.push(format!("registration_provider_state={provider_state}"));
    }
    if let Some(error) = &identity.registration_error {
        lines.push(format!("registration_error={}", error.escape_default()));
    }
    if let Some(fingerprint) = &identity.certificate_sha256 {
        lines.push(format!("play_console_add_key_fingerprint={fingerprint}"));
        lines.push(format!("certificate_sha256={fingerprint}"));
    }
    lines
}

fn client_api(args: ClientApiArgs) -> anyhow::Result<SignerApi> {
    let token = std::env::var("APK_SIGNER_OPERATOR_TOKEN")
        .context("APK_SIGNER_OPERATOR_TOKEN is not set")?;
    SignerApi::new(args.api_url, token, args.signer_id)
}

async fn runtime(args: RuntimeArgs) -> anyhow::Result<Signer<SignerApi, CommandAndroidTools>> {
    if args.poll_seconds == 0 || args.max_apk_bytes == 0 {
        anyhow::bail!("poll interval and APK limit must be positive")
    }
    // Read the credential here rather than through clap so it is never represented in help output
    // or a command line visible to another local user.
    let token = std::env::var("APK_SIGNER_TOKEN").context("APK_SIGNER_TOKEN is not set")?;
    let api = SignerApi::new(args.api_url, token, args.signer_id)?;
    let identity = MasterIdentity::load(&args.master_identity)?;
    let state = StateStore::open(args.state_dir)?;
    let tools = CommandAndroidTools::discover(args.android_sdk_root.as_deref())?;
    Ok(Signer::new(
        api,
        tools,
        identity,
        state,
        SignerConfig {
            max_apk_bytes: args.max_apk_bytes,
            poll_interval: Duration::from_secs(args.poll_seconds),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(
        registration_state: &str,
        provider_state: Option<&str>,
        error: Option<&str>,
        certificate: Option<&str>,
    ) -> ClientIdentityStatus {
        ClientIdentityStatus {
            package_name: CLIENT_PACKAGE_NAME.into(),
            state: "ready".into(),
            registration_state: registration_state.into(),
            registration_provider_state: provider_state.map(str::to_owned),
            registration_error: error.map(str::to_owned),
            certificate_sha256: certificate.map(str::to_owned),
        }
    }

    #[test]
    fn pending_identity_does_not_print_a_play_fingerprint_before_provisioning() {
        let lines = client_identity_lines(&identity("pending_registration", None, None, None));
        assert!(lines.contains(&"registration_state=pending_registration".into()));
        assert!(
            !lines
                .iter()
                .any(|line| line.starts_with("play_console_add_key_fingerprint="))
        );
    }

    #[test]
    fn registered_identity_prints_provider_proof_and_the_per_app_fingerprint() {
        let fingerprint = "a".repeat(64);
        let lines = client_identity_lines(&identity(
            "registered",
            Some("REGISTERED"),
            None,
            Some(&fingerprint),
        ));
        assert!(lines.contains(&"registration_provider_state=REGISTERED".into()));
        assert!(lines.contains(&format!("play_console_add_key_fingerprint={fingerprint}")));
    }

    #[test]
    fn wrong_certificate_state_exposes_bounded_provider_error_safely() {
        let fingerprint = "b".repeat(64);
        let lines = client_identity_lines(&identity(
            "pending_registration",
            Some("REGISTERED_WITH_ANOTHER_CERTIFICATE_FINGERPRINT"),
            Some("wrong certificate\nstop"),
            Some(&fingerprint),
        ));
        assert!(lines.contains(
            &"registration_provider_state=REGISTERED_WITH_ANOTHER_CERTIFICATE_FINGERPRINT".into()
        ));
        assert!(lines.contains(&"registration_error=wrong certificate\\nstop".into()));
    }
}
