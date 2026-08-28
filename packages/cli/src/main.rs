use clap::Parser;
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
    let cli = Cli::parse();
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
