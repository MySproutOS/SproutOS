use clap::{Parser, error::ErrorKind};
use sprout_cli::{
    app::{self, Dependencies},
    auth::SystemBrowser,
    cli::Cli,
    confirm::TerminalConfirmation,
    core_backend::CoreBackend,
    credential::OsCredentialStore,
    output,
};

#[tokio::main]
async fn main() {
    let wants_json = std::env::args_os().any(|argument| argument == "--json");
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
            ) =>
        {
            let _ = error.print();
            return;
        }
        Err(error) if wants_json => {
            let error = sprout_cli::CliError::InvalidInput(error.to_string());
            println!("{}", output::json_error(&error));
            std::process::exit(2);
        }
        Err(error) => error.exit(),
    };
    let result = async {
        let backend = CoreBackend::new(&cli.api_url, cli.json)?;
        let config_path = app::default_config_path()?;
        app::run(
            &cli,
            &Dependencies {
                backend: &backend,
                credentials: &OsCredentialStore,
                browser: &SystemBrowser,
                confirmation: &TerminalConfirmation,
                config_path: &config_path,
            },
        )
        .await
    }
    .await;
    match result {
        Ok(rendered) => println!("{rendered}"),
        Err(error) => {
            if cli.json {
                println!("{}", output::json_error(&error));
            } else {
                eprintln!("{error}");
            }
            std::process::exit(error.exit_code().into());
        }
    }
}
