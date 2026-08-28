use std::path::PathBuf;
use std::time::Duration;

use android_signer::api::SignerApi;
use android_signer::crypto::MasterIdentity;
use android_signer::developer_console::{
    DeveloperConsoleOAuth, receive_consent_and_store_refresh_token,
};
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
    /// Complete one-time OAuth consent and save the refresh token without printing it.
    AuthorizeDeveloperConsole {
        #[arg(long, env = "ANDROID_DEVELOPER_CONSOLE_CLIENT_ID")]
        client_id: String,
        #[arg(
            long,
            env = "ANDROID_DEVELOPER_CONSOLE_REDIRECT_URI",
            default_value = "http://127.0.0.1:8787/oauth/callback"
        )]
        redirect_uri: String,
        #[arg(long, env = "ANDROID_DEVELOPER_CONSOLE_REFRESH_TOKEN_PATH")]
        output: PathBuf,
    },
    /// Poll forever, sleeping when the queue is empty.
    Run(RuntimeArgs),
    /// Claim and process at most one job. Useful for installation smoke tests.
    Once(RuntimeArgs),
    /// Idempotently request the one immutable catalogue-client key and print only public state.
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
    #[arg(long, env = "ANDROID_DEVELOPER_CONSOLE_CLIENT_ID")]
    developer_console_client_id: Option<String>,
    #[arg(long, env = "ANDROID_DEVELOPER_CONSOLE_REFRESH_TOKEN_PATH")]
    developer_console_refresh_token: Option<PathBuf>,
    #[arg(long, env = "ANDROID_DEVELOPER_CONSOLE_DEVELOPER_ACCOUNT")]
    developer_console_account: Option<String>,
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
        Command::AuthorizeDeveloperConsole {
            client_id,
            redirect_uri,
            output,
        } => {
            // Keep the confidential Web client secret out of argv and generated help output.
            let client_secret = std::env::var("ANDROID_DEVELOPER_CONSOLE_CLIENT_SECRET")
                .context("ANDROID_DEVELOPER_CONSOLE_CLIENT_SECRET is not set")?;
            receive_consent_and_store_refresh_token(client_id, client_secret, redirect_uri, output)
                .await?;
            println!("saved the refresh token with private permissions");
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
            println!("package_name={}", identity.package_name);
            println!("state={}", identity.state);
            if let Some(fingerprint) = identity.certificate_sha256 {
                println!("certificate_sha256={fingerprint}");
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
            let uploaded = api
                .upload_local_apk(&prepared.upload_url, &unsigned_apk)
                .await?;
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

fn client_api(args: ClientApiArgs) -> anyhow::Result<SignerApi> {
    let token = std::env::var("APK_SIGNER_TOKEN").context("APK_SIGNER_TOKEN is not set")?;
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
    let oauth_secret = std::env::var("ANDROID_DEVELOPER_CONSOLE_CLIENT_SECRET").ok();
    match (
        args.developer_console_client_id,
        oauth_secret,
        args.developer_console_refresh_token,
        args.developer_console_account,
    ) {
        (None, None, None, None) => {}
        (Some(client_id), Some(client_secret), Some(refresh_token), Some(account)) => {
            if !account.starts_with("developerAccounts/")
                || account.len() <= "developerAccounts/".len()
            {
                anyhow::bail!(
                    "ANDROID_DEVELOPER_CONSOLE_DEVELOPER_ACCOUNT must be a developerAccounts/* resource name"
                )
            }
            let oauth = DeveloperConsoleOAuth::new(client_id, client_secret, refresh_token)?;
            let token = oauth.access_token().await?;
            tracing::info!(
                developer_account = %account,
                expires_in_seconds = token.expires_at().saturating_duration_since(std::time::Instant::now()).as_secs(),
                "Android Developer Console OAuth is ready; registration remains pending until Google publishes or authenticated discovery reveals the mutation schema"
            );
        }
        _ => anyhow::bail!(
            "Android Developer Console OAuth requires CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN_PATH, and DEVELOPER_ACCOUNT together"
        ),
    }
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
