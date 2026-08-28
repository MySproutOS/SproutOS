use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

use crate::{CliError, Result};

const DEFAULT_API_URL: &str = "https://api.sproutos.me";
const DEFAULT_WEBSITE_URL: &str = "https://sproutos.me";

#[derive(Debug, Parser)]
#[command(
    name = "sprout",
    version,
    about = "Build and operate SproutOS projects"
)]
pub struct Cli {
    /// Emit the versioned machine-readable output envelope.
    #[arg(long, global = true)]
    pub json: bool,

    /// Skip a destructive command's interactive confirmation.
    #[arg(long, global = true)]
    pub yes: bool,

    /// Organization slug. Defaults to the organization selected by `sprout org use`.
    #[arg(long, global = true, env = "SPROUTOS_ORG")]
    pub org: Option<String>,

    #[arg(long, global = true, env = "SPROUTOS_API_URL", default_value = DEFAULT_API_URL)]
    pub api_url: String,

    #[arg(
        long,
        global = true,
        env = "SPROUTOS_WEBSITE_URL",
        default_value = DEFAULT_WEBSITE_URL
    )]
    pub website_url: String,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    Auth(AuthArgs),
    Org(OrgArgs),
    Project(ProjectArgs),
    Env(EnvArgs),
    Service(ServiceArgs),
    Deploy(DeployArgs),
    Deployment(DeploymentArgs),
    Logs(LogsArgs),
    Android(AndroidArgs),
    Api(ApiArgs),
    Template(TemplateArgs),
}

#[derive(Debug, Args)]
pub struct AuthArgs {
    #[command(subcommand)]
    pub command: AuthCommand,
}

#[derive(Debug, Subcommand)]
pub enum AuthCommand {
    /// Authenticate in a browser using PKCE and save the resulting scoped API key.
    Login {
        /// Print the authorization URL instead of opening the browser.
        #[arg(long)]
        no_open: bool,
        #[arg(long, default_value_t = 300, value_parser = clap::value_parser!(u64).range(1..=900))]
        timeout_seconds: u64,
    },
    /// Remove the saved API key. SPROUTOS_TOKEN, if set, is never modified.
    Logout,
    /// Show the credential source and authenticated identity, never the credential.
    Status,
}

#[derive(Debug, Args)]
pub struct OrgArgs {
    #[command(subcommand)]
    pub command: OrgCommand,
}

#[derive(Debug, Subcommand)]
pub enum OrgCommand {
    List,
    Use { slug: String },
}

#[derive(Debug, Args)]
pub struct ProjectArgs {
    #[command(subcommand)]
    pub command: ProjectCommand,
}

#[derive(Debug, Subcommand)]
pub enum ProjectCommand {
    List {
        #[arg(long)]
        repository_id: Option<String>,
        #[arg(long)]
        cursor: Option<String>,
        #[arg(long, default_value_t = 25, value_parser = clap::value_parser!(u16).range(1..=100))]
        limit: u16,
    },
    Get {
        project: String,
    },
    Create(ProjectCreateArgs),
    Update(ProjectUpdateArgs),
    Delete {
        project: String,
    },
}

#[derive(Debug, Args)]
pub struct ProjectCreateArgs {
    #[arg(long)]
    pub name: String,
    #[arg(long)]
    pub slug: Option<String>,
    #[arg(long, value_enum, default_value_t = ProjectKind::Site)]
    pub kind: ProjectKind,
    #[arg(long, default_value = ".")]
    pub root_dir: String,
    #[arg(long, default_value = "Dockerfile")]
    pub dockerfile_path: String,
    #[arg(long)]
    pub production_branch: Option<String>,
    #[arg(long)]
    pub parent_project: Option<String>,
    #[command(flatten)]
    pub source: ProjectSourceArgs,
}

#[derive(Debug, Args)]
#[group(required = true, multiple = false)]
pub struct ProjectSourceArgs {
    /// Create from a signed App Store listing id.
    #[arg(long, group = "source")]
    pub store: Option<String>,
    /// Create from a repository already known to SproutOS.
    #[arg(long, group = "source")]
    pub repository_id: Option<String>,
    /// Create from a GitHub repository id visible to the installed GitHub App.
    #[arg(long, group = "source")]
    pub github_repo_id: Option<String>,
    /// Create a blank repository.
    #[arg(long, group = "source")]
    pub blank: bool,
    #[arg(long, requires = "blank")]
    pub owner: Option<String>,
    #[arg(long, requires = "blank")]
    pub repository_name: Option<String>,
    #[arg(long, requires = "blank")]
    pub private: bool,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum ProjectKind {
    Site,
    Workflow,
}

#[derive(Debug, Args)]
pub struct ProjectUpdateArgs {
    pub project: String,
    #[arg(long)]
    pub name: Option<String>,
    #[arg(long)]
    pub slug: Option<String>,
    #[arg(long)]
    pub root_dir: Option<String>,
    #[arg(long)]
    pub dockerfile_path: Option<String>,
    #[arg(long)]
    pub production_branch: Option<String>,
    #[arg(long, value_enum)]
    pub scale: Option<ScaleMode>,
    #[arg(long)]
    pub parent_project: Option<String>,
    #[arg(long, conflicts_with = "parent_project")]
    pub no_parent: bool,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum ScaleMode {
    Cold,
    Warm,
}

#[derive(Debug, Args)]
pub struct EnvArgs {
    #[command(subcommand)]
    pub command: EnvCommand,
}

#[derive(Debug, Subcommand)]
pub enum EnvCommand {
    List {
        project: String,
    },
    Set {
        project: String,
        key: String,
        /// Value to save. Omit with --stdin to keep it out of shell history.
        value: Option<String>,
        #[arg(long, conflicts_with = "value")]
        stdin: bool,
        #[arg(long, value_enum, default_value_t = EnvironmentTarget::All)]
        target: EnvironmentTarget,
        #[arg(long)]
        public: bool,
    },
    Unset {
        project: String,
        /// Environment-variable id from `sprout env list`.
        env_id: String,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum EnvironmentTarget {
    Production,
    Preview,
    Development,
    All,
}

#[derive(Debug, Args)]
pub struct ServiceArgs {
    #[command(subcommand)]
    pub command: ServiceCommand,
}

#[derive(Debug, Subcommand)]
pub enum ServiceCommand {
    List,
    Create {
        #[arg(long)]
        name: String,
        #[arg(long, value_enum)]
        kind: ServiceKind,
        #[arg(long)]
        project: Option<String>,
    },
    Get {
        service: String,
    },
    Delete {
        service: String,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
#[value(rename_all = "snake_case")]
pub enum ServiceKind {
    Postgres,
    Valkey,
    Elasticsearch,
    ObjectStorage,
}

#[derive(Debug, Args)]
pub struct DeployArgs {
    /// Project id or unique slug. May be omitted only with a repository-bound Action token.
    pub project: Option<String>,
    /// Built site directory, migration directory, or one raw unsigned APK.
    #[arg(long, default_value = ".")]
    pub path: PathBuf,
    #[arg(long, value_enum)]
    pub preset: DeployPreset,
    #[arg(long)]
    pub migration_path: Option<PathBuf>,
    #[arg(long)]
    pub migration_handler: Option<String>,
    /// Static asset mapping as SOURCE:PREFIX. Repeat for multiple source trees.
    #[arg(long = "static-path")]
    pub static_paths: Vec<String>,
    #[arg(long, value_enum, default_value_t = DeployEnvironment::Production)]
    pub environment: DeployEnvironment,
    #[arg(long)]
    pub git_sha: Option<String>,
    #[arg(long)]
    pub git_ref: Option<String>,
    #[arg(long)]
    pub message: Option<String>,
    #[arg(long)]
    pub runtime: Option<String>,
    #[arg(long)]
    pub handler: Option<String>,
    /// Monotonic Android manifest versionCode. Required for the android preset.
    #[arg(long)]
    pub version_code: Option<u64>,
    #[arg(long, default_value_t = 900, value_parser = clap::value_parser!(u64).range(1..=3600))]
    pub timeout_seconds: u64,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
#[value(rename_all = "snake_case")]
pub enum DeployPreset {
    Next,
    Hono,
    Web,
    Static,
    Android,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum DeployEnvironment {
    Production,
    Preview,
    /// Compatibility alias for preview deployments used by earlier Action releases.
    Development,
}

#[derive(Debug, Args)]
pub struct DeploymentArgs {
    #[command(subcommand)]
    pub command: DeploymentCommand,
}

#[derive(Debug, Subcommand)]
pub enum DeploymentCommand {
    List {
        project: String,
    },
    Get {
        deployment: String,
    },
    Wait {
        deployment: String,
        #[arg(long, default_value_t = 900, value_parser = clap::value_parser!(u64).range(1..=3600))]
        timeout_seconds: u64,
    },
}

#[derive(Debug, Args)]
pub struct LogsArgs {
    pub project: String,
    #[arg(long)]
    pub follow: bool,
    #[arg(long)]
    pub since: Option<String>,
    #[arg(long)]
    pub search: Option<String>,
    #[arg(long)]
    pub level: Option<String>,
    #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u16).range(1..=500))]
    pub limit: u16,
}

#[derive(Debug, Args)]
pub struct AndroidArgs {
    #[command(subcommand)]
    pub command: AndroidCommand,
}

#[derive(Debug, Subcommand)]
pub enum AndroidCommand {
    Setup {
        project: String,
    },
    Status {
        project: String,
    },
    Verify {
        project: String,
        /// Connected repository production-branch commit to verify.
        #[arg(long)]
        commit: String,
    },
}

#[derive(Debug, Args)]
pub struct ApiArgs {
    #[arg(value_enum)]
    pub method: ApiMethod,
    /// A relative path under the configured API origin. Absolute and scheme-relative URLs fail.
    pub path: String,
    /// JSON request body.
    #[arg(long)]
    pub data: Option<String>,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum ApiMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

#[derive(Debug, Args)]
pub struct TemplateArgs {
    #[command(subcommand)]
    pub command: TemplateCommand,
}

#[derive(Debug, Subcommand)]
pub enum TemplateCommand {
    Resolve {
        template: String,
        #[arg(long)]
        upstream_commit: String,
        #[arg(long, value_enum)]
        target: Option<TemplateTarget>,
    },
    Apply {
        template: String,
        #[arg(long)]
        upstream_commit: String,
        #[arg(long, value_enum)]
        target: Option<TemplateTarget>,
        #[arg(long, default_value = ".")]
        workspace: PathBuf,
        /// Non-secret structural JSON passed to the isolated plugin.
        #[arg(long, default_value = "{}")]
        input: String,
    },
    Verify {
        template: String,
        #[arg(long)]
        upstream_commit: String,
        #[arg(long, value_enum)]
        target: Option<TemplateTarget>,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
#[value(rename_all = "kebab-case")]
pub enum TemplateTarget {
    LinuxAmd64Musl,
    LinuxArm64Musl,
    DarwinAmd64,
    DarwinArm64,
    WindowsAmd64,
}

pub fn validate(cli: &Cli) -> Result<()> {
    validate_base_url("--api-url", &cli.api_url)?;
    validate_base_url("--website-url", &cli.website_url)?;
    if matches!(
        cli.command,
        Command::Auth(AuthArgs {
            command: AuthCommand::Login { .. }
        })
    ) {
        validate_login_origin_pair(&cli.api_url, &cli.website_url)?;
    }

    if cli.json && destructive(&cli.command) && !cli.yes {
        return Err(CliError::InvalidInput(
            "destructive commands in --json mode require --yes and never prompt".into(),
        ));
    }
    if let Command::Api(args) = &cli.command {
        crate::request::validate_relative_api_path(&args.path)?;
        if let Some(data) = &args.data {
            serde_json::from_str::<serde_json::Value>(data)
                .map_err(|error| CliError::InvalidInput(format!("--data is not JSON: {error}")))?;
        }
    }
    if let Command::Env(EnvArgs {
        command: EnvCommand::Set { value, stdin, .. },
    }) = &cli.command
        && value.is_none()
        && !stdin
    {
        return Err(CliError::InvalidInput(
            "env set needs a VALUE or --stdin".into(),
        ));
    }
    if let Command::Project(ProjectArgs {
        command: ProjectCommand::Update(args),
    }) = &cli.command
        && args.name.is_none()
        && args.slug.is_none()
        && args.root_dir.is_none()
        && args.dockerfile_path.is_none()
        && args.production_branch.is_none()
        && args.scale.is_none()
        && args.parent_project.is_none()
        && !args.no_parent
    {
        return Err(CliError::InvalidInput(
            "project update needs at least one changed field".into(),
        ));
    }
    if let Command::Deploy(args) = &cli.command {
        if matches!(args.preset, DeployPreset::Android) != args.version_code.is_some()
            || args.version_code == Some(0)
        {
            return Err(CliError::InvalidInput(
                "--version-code >= 1 is required only for the android preset".into(),
            ));
        }
        if matches!(args.preset, DeployPreset::Android)
            && (!args.static_paths.is_empty() || args.migration_path.is_some())
        {
            return Err(CliError::InvalidInput(
                "Android deploys upload exactly one raw APK and cannot include static or migration archives"
                    .into(),
            ));
        }
    }
    if let Command::Android(AndroidArgs {
        command: AndroidCommand::Verify { commit, .. },
    }) = &cli.command
        && (commit.len() != 40
            || !commit
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
    {
        return Err(CliError::InvalidInput(
            "android verify --commit must be a 40-character lowercase Git SHA".into(),
        ));
    }
    if let Command::Template(TemplateArgs {
        command: TemplateCommand::Apply { input, .. },
    }) = &cli.command
    {
        let value: serde_json::Value = serde_json::from_str(input)
            .map_err(|error| CliError::InvalidInput(format!("--input is not JSON: {error}")))?;
        if !value.is_object() {
            return Err(CliError::InvalidInput(
                "template --input must be a JSON object".into(),
            ));
        }
    }
    Ok(())
}

fn validate_base_url(name: &str, value: &str) -> Result<()> {
    let url = url::Url::parse(value)
        .map_err(|error| CliError::InvalidInput(format!("invalid {name}: {error}")))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CliError::InvalidInput(format!(
            "{name} must be an HTTP(S) origin without credentials, query, or fragment"
        )));
    }
    if url.scheme() == "http" && !is_loopback_host(url.host_str().unwrap_or_default()) {
        return Err(CliError::InvalidInput(format!(
            "{name} must use HTTPS unless it is a local loopback URL"
        )));
    }
    Ok(())
}

fn validate_login_origin_pair(api_value: &str, website_value: &str) -> Result<()> {
    let api = url::Url::parse(api_value).expect("base URL was validated");
    let website = url::Url::parse(website_value).expect("base URL was validated");
    let api_host = api.host_str().expect("base URL has a host");
    let website_host = website.host_str().expect("base URL has a host");
    let api_is_loopback = is_loopback_host(api_host);
    let website_is_loopback = is_loopback_host(website_host);

    if api_is_loopback && website_is_loopback {
        return Ok(());
    }
    if api_is_loopback
        || website_is_loopback
        || (api_host != website_host && api_host != format!("api.{website_host}"))
    {
        return Err(CliError::InvalidInput(
            "--api-url and --website-url must be the same HTTPS host pair so an authorization code and PKCE verifier cannot be sent to another operator"
                .into(),
        ));
    }
    Ok(())
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

pub fn destructive(command: &Command) -> bool {
    matches!(
        command,
        Command::Auth(AuthArgs {
            command: AuthCommand::Logout
        }) | Command::Project(ProjectArgs {
            command: ProjectCommand::Delete { .. }
        }) | Command::Env(EnvArgs {
            command: EnvCommand::Unset { .. }
        }) | Command::Service(ServiceArgs {
            command: ServiceCommand::Delete { .. }
        })
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::{CommandFactory, Parser};

    #[test]
    fn command_tree_is_complete() {
        Cli::command().debug_assert();
        let help = Cli::command().render_long_help().to_string();
        for command in [
            "auth",
            "org",
            "project",
            "env",
            "service",
            "deploy",
            "deployment",
            "logs",
            "android",
            "api",
            "template",
        ] {
            assert!(help.contains(command), "missing {command} from root help");
        }
    }

    #[test]
    fn production_defaults_target_the_live_control_plane() {
        let cli = Cli::parse_from(["sprout", "auth", "login"]);

        assert_eq!(cli.api_url, "https://api.sproutos.me");
        assert_eq!(cli.website_url, "https://sproutos.me");
    }

    #[test]
    fn all_required_leaf_commands_parse() {
        let cases: &[&[&str]] = &[
            &["sprout", "auth", "login"],
            &["sprout", "auth", "logout"],
            &["sprout", "auth", "status"],
            &["sprout", "org", "list"],
            &["sprout", "org", "use", "example"],
            &["sprout", "project", "list"],
            &["sprout", "project", "get", "p"],
            &["sprout", "project", "create", "--name", "n", "--blank"],
            &["sprout", "project", "update", "p", "--name", "n"],
            &["sprout", "project", "delete", "p"],
            &["sprout", "env", "list", "p"],
            &["sprout", "env", "set", "p", "KEY", "value"],
            &["sprout", "env", "unset", "p", "e"],
            &["sprout", "service", "list"],
            &[
                "sprout", "service", "create", "--name", "db", "--kind", "postgres",
            ],
            &["sprout", "service", "get", "s"],
            &["sprout", "service", "delete", "s"],
            &["sprout", "deploy", "p", "--preset", "web"],
            &["sprout", "deployment", "list", "p"],
            &["sprout", "deployment", "get", "d"],
            &["sprout", "deployment", "wait", "d"],
            &["sprout", "logs", "p"],
            &["sprout", "android", "setup", "p"],
            &["sprout", "android", "status", "p"],
            &[
                "sprout",
                "android",
                "verify",
                "p",
                "--commit",
                "0123456789abcdef0123456789abcdef01234567",
            ],
            &["sprout", "api", "get", "/v1/orgs"],
            &[
                "sprout",
                "template",
                "resolve",
                "t",
                "--upstream-commit",
                "c",
            ],
            &["sprout", "template", "apply", "t", "--upstream-commit", "c"],
            &[
                "sprout",
                "template",
                "verify",
                "t",
                "--upstream-commit",
                "c",
            ],
        ];
        for case in cases {
            let parsed =
                Cli::try_parse_from(*case).unwrap_or_else(|error| panic!("{case:?}: {error}"));
            validate(&parsed).unwrap_or_else(|error| panic!("{case:?}: {error}"));
        }
    }

    #[test]
    fn json_destructive_commands_fail_closed_without_yes() {
        let cli = Cli::parse_from(["sprout", "--json", "project", "delete", "p"]);
        assert!(
            validate(&cli)
                .unwrap_err()
                .to_string()
                .contains("require --yes")
        );
    }

    #[test]
    fn env_set_requires_exactly_one_value_source() {
        let cli = Cli::parse_from(["sprout", "env", "set", "p", "KEY"]);
        assert!(validate(&cli).is_err());
        assert!(Cli::try_parse_from(["sprout", "env", "set", "p", "KEY", "v", "--stdin"]).is_err());
    }

    #[test]
    fn base_urls_cannot_smuggle_credentials() {
        for url in [
            "file:///tmp/api",
            "https://token@example.test",
            "https://example.test?redirect=https://evil.test",
            "https://example.test/#secret",
        ] {
            let cli = Cli::parse_from(["sprout", "--api-url", url, "org", "list"]);
            assert!(validate(&cli).is_err(), "accepted {url}");
        }
    }

    #[test]
    fn login_refuses_an_api_origin_that_could_capture_the_pkce_exchange() {
        for args in [
            [
                "sprout",
                "--api-url",
                "https://api.attacker.test",
                "auth",
                "login",
            ],
            [
                "sprout",
                "--api-url",
                "http://api.sproutos.me",
                "auth",
                "login",
            ],
        ] {
            let cli = Cli::parse_from(args);
            assert!(validate(&cli).is_err());
        }

        let local = Cli::parse_from([
            "sprout",
            "--api-url",
            "http://127.0.0.1:3001",
            "--website-url",
            "http://localhost:3000",
            "auth",
            "login",
        ]);
        validate(&local).unwrap();
    }
}
