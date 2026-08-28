use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

use crate::{CliError, Result};

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub organization: Option<String>,
}

pub fn default_path() -> Result<PathBuf> {
    ProjectDirs::from("me", "SproutOS", "sprout")
        .map(|dirs| dirs.config_dir().join("config.json"))
        .ok_or_else(|| {
            CliError::Configuration("the operating system has no config directory".into())
        })
}

pub fn read(path: &Path) -> Result<Config> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| CliError::Configuration(format!("{}: {error}", path.display()))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(error) => Err(CliError::Configuration(format!(
            "{}: {error}",
            path.display()
        ))),
    }
}

pub fn write(path: &Path, config: &Config) -> Result<()> {
    let parent = path.parent().ok_or_else(|| {
        CliError::Configuration(format!("{} has no parent directory", path.display()))
    })?;
    fs::create_dir_all(parent)
        .map_err(|error| CliError::Configuration(format!("{}: {error}", parent.display())))?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&temporary)?;
        serde_json::to_writer_pretty(&mut file, config)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok::<(), Box<dyn std::error::Error>>(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(CliError::Configuration(format!(
            "{}: {error}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_round_trips_without_a_secret_field() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        write(
            &path,
            &Config {
                organization: Some("acme".into()),
            },
        )
        .unwrap();
        assert_eq!(read(&path).unwrap().organization.as_deref(), Some("acme"));
        let bytes = fs::read_to_string(path).unwrap();
        assert!(!bytes.to_ascii_lowercase().contains("token"));
    }

    #[test]
    fn missing_config_is_empty() {
        assert_eq!(
            read(Path::new("/definitely/not/a/sprout/config")).unwrap(),
            Config::default()
        );
    }
}
