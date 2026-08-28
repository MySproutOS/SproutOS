use clap::Parser;
use sprout_cli::cli::Cli;

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    if let Err(error) = sprout_cli::cli::validate(&cli) {
        eprintln!("{error}");
        std::process::exit(2);
    }
}
