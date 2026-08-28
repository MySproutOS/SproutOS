use std::path::PathBuf;
use std::time::Duration;

use android_signer::api::SignerApi;
use android_signer::crypto::MasterIdentity;
use android_signer::developer_console::{
    DEFAULT_TOKEN_URL, DeveloperConsoleConfig, GoogleDeveloperConsole, write_refresh_token,
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
    /// Print the one-time Google consent URL. The URL contains no client secret.
    GoogleOauthUrl {
        #[arg(long, env = "APK_SIGNER_GOOGLE_OAUTH_CLIENT_ID")]
        client_id: String,
        #[arg(long, env = "APK_SIGNER_GOOGLE_OAUTH_REDIRECT_URI")]
        redirect_uri: String,
        #[arg(long, env = "APK_SIGNER_GOOGLE_OAUTH_STATE_FILE")]
        state_file: PathBuf,
    },
    /// Read an authorization code from stdin and save the offline refresh token mode 0600.
    GoogleOauthExchange {
        #[arg(long, env = "APK_SIGNER_GOOGLE_OAUTH_CLIENT_ID")]
        client_id: String,
        #[arg(long, env = "APK_SIGNER_GOOGLE_OAUTH_REDIRECT_URI")]
        redirect_uri: String,
        #[arg(long, env = "APK_SIGNER_GOOGLE_OAUTH_REFRESH_TOKEN_FILE")]
        output: PathBuf,
        #[arg(long, env = "APK_SIGNER_GOOGLE_OAUTH_STATE_FILE")]
        state_file: PathBuf,
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
        Command::GoogleOauthUrl {
            client_id,
            redirect_uri,
            state_file,
        } => {
            println!(
                "{}",
                DeveloperConsoleConfig::begin_authorization(
                    &client_id,
                    &redirect_uri,
                    &state_file,
                    std::time::SystemTime::now(),
                )?
            );
            Ok(())
        }
        Command::GoogleOauthExchange {
            client_id,
            redirect_uri,
            output,
            state_file,
        } => {
            let client_secret = std::env::var("APK_SIGNER_GOOGLE_OAUTH_CLIENT_SECRET")
                .context("APK_SIGNER_GOOGLE_OAUTH_CLIENT_SECRET is not set")?;
            let mut callback_url = String::new();
            std::io::stdin().read_line(&mut callback_url)?;
            let code = DeveloperConsoleConfig::consume_authorization_callback(
                &state_file,
                &client_id,
                &redirect_uri,
                callback_url.trim(),
                std::time::SystemTime::now(),
            )?;
            let token = DeveloperConsoleConfig::exchange_authorization_code(
                &client_id,
                &client_secret,
                &code,
                &redirect_uri,
                &std::env::var("APK_SIGNER_GOOGLE_OAUTH_TOKEN_URL")
                    .unwrap_or_else(|_| DEFAULT_TOKEN_URL.to_owned()),
            )
            .await?;
            write_refresh_token(&output, &token)?;
            println!("stored Google OAuth refresh token at {}", output.display());
            Ok(())
        }
    }
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
    // Validate custody configuration before claiming anything. A signer without registration
    // authority must stay down instead of consuming release attempts that can never be published.
    let _developer_console = GoogleDeveloperConsole::new(DeveloperConsoleConfig::from_env()?)?;
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
