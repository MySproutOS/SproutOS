use std::{env, fmt};

use crate::{CliError, Result};
use zeroize::Zeroize;

const SERVICE: &str = "me.sproutos.cli";

pub trait CredentialStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>>;
    fn set(&self, account: &str, token: &str) -> Result<()>;
    fn delete(&self, account: &str) -> Result<()>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct OsCredentialStore;

impl OsCredentialStore {
    fn entry(account: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, account)
            .map_err(|error| CliError::CredentialStore(error.to_string()))
    }
}

impl CredentialStore for OsCredentialStore {
    fn get(&self, account: &str) -> Result<Option<String>> {
        match Self::entry(account)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(CliError::CredentialStore(format!(
                "could not read the OS credential store ({error}); set SPROUTOS_TOKEN for CI/headless use"
            ))),
        }
    }

    fn set(&self, account: &str, token: &str) -> Result<()> {
        if token.is_empty() {
            return Err(CliError::CredentialStore(
                "refusing to store an empty credential".into(),
            ));
        }
        Self::entry(account)?
            .set_password(token)
            .map_err(|error| CliError::CredentialStore(error.to_string()))
    }

    fn delete(&self, account: &str) -> Result<()> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(CliError::CredentialStore(error.to_string())),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialSource {
    Environment,
    OsCredentialStore,
}

/// A token container whose Debug output is always safe.
pub struct ResolvedCredential {
    token: String,
    pub source: CredentialSource,
}

impl ResolvedCredential {
    pub fn expose(&self) -> &str {
        &self.token
    }
}

impl fmt::Debug for ResolvedCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedCredential")
            .field("token", &"[REDACTED]")
            .field("source", &self.source)
            .finish()
    }
}

impl Drop for ResolvedCredential {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

pub fn account_for(api_url: &url::Url) -> String {
    format!(
        "{}://{}{}",
        api_url.scheme(),
        api_url.host_str().unwrap_or("invalid-host"),
        api_url
            .port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default()
    )
}

pub fn resolve(store: &dyn CredentialStore, account: &str) -> Result<ResolvedCredential> {
    if let Ok(token) = env::var("SPROUTOS_TOKEN")
        && !token.is_empty()
    {
        return Ok(ResolvedCredential {
            token,
            source: CredentialSource::Environment,
        });
    }
    let token = store
        .get(account)?
        .ok_or(CliError::AuthenticationRequired)?;
    if token.is_empty() {
        return Err(CliError::AuthenticationRequired);
    }
    Ok(ResolvedCredential {
        token,
        source: CredentialSource::OsCredentialStore,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};

    #[derive(Default)]
    struct MemoryStore(Mutex<HashMap<String, String>>);

    impl CredentialStore for MemoryStore {
        fn get(&self, account: &str) -> Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, token: &str) -> Result<()> {
            self.0.lock().unwrap().insert(account.into(), token.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<()> {
            self.0.lock().unwrap().remove(account);
            Ok(())
        }
    }

    #[test]
    fn memory_store_models_round_trip_and_idempotent_delete() {
        let store = MemoryStore::default();
        store.set("api", "canary-secret").unwrap();
        assert_eq!(store.get("api").unwrap().as_deref(), Some("canary-secret"));
        store.delete("api").unwrap();
        store.delete("api").unwrap();
        assert_eq!(store.get("api").unwrap(), None);
    }

    #[test]
    fn debug_never_reveals_the_token() {
        let credential = ResolvedCredential {
            token: "canary-secret".into(),
            source: CredentialSource::OsCredentialStore,
        };
        let debug = format!("{credential:?}");
        assert!(!debug.contains("canary-secret"));
        assert!(debug.contains("[REDACTED]"));
    }

    #[test]
    fn account_is_origin_scoped_not_path_scoped() {
        let url = url::Url::parse("https://api.example.test:8443/v1/").unwrap();
        assert_eq!(account_for(&url), "https://api.example.test:8443");
    }
}
