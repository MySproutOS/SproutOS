use std::path::PathBuf;
use std::time::Duration;

use android_signer::api::SignerApi;
use android_signer::crypto::MasterIdentity;
use android_signer::process::CommandAndroidTools;
use android_signer::state::StateStore;
use android_signer::{Signer, SignerConfig};
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
    }
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
