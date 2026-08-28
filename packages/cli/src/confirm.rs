use std::io::{self, IsTerminal, Write};

use crate::{CliError, Result};

pub trait Confirmation: Send + Sync {
    fn confirm(&self, prompt: &str) -> Result<bool>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct TerminalConfirmation;

impl Confirmation for TerminalConfirmation {
    fn confirm(&self, prompt: &str) -> Result<bool> {
        if !io::stdin().is_terminal() || !io::stderr().is_terminal() {
            return Err(CliError::InvalidInput(
                "confirmation requires an interactive terminal; pass --yes to continue".into(),
            ));
        }
        eprint!("{prompt} [y/N] ");
        io::stderr()
            .flush()
            .map_err(|error| CliError::Configuration(error.to_string()))?;
        let mut answer = String::new();
        io::stdin()
            .read_line(&mut answer)
            .map_err(|error| CliError::Configuration(error.to_string()))?;
        Ok(matches!(
            answer.trim().to_ascii_lowercase().as_str(),
            "y" | "yes"
        ))
    }
}

pub fn require(yes: bool, confirmation: &dyn Confirmation, prompt: &str) -> Result<()> {
    if yes || confirmation.confirm(prompt)? {
        Ok(())
    } else {
        Err(CliError::Cancelled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(bool);
    impl Confirmation for Fixed {
        fn confirm(&self, _: &str) -> Result<bool> {
            Ok(self.0)
        }
    }

    #[test]
    fn explicit_yes_never_prompts() {
        assert!(require(true, &Fixed(false), "delete?").is_ok());
    }

    #[test]
    fn negative_confirmation_cancels() {
        assert!(matches!(
            require(false, &Fixed(false), "delete?"),
            Err(CliError::Cancelled)
        ));
    }
}
