use std::{fmt, str::FromStr};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::{Result, SproutError};

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Sha256Digest(String);

impl Sha256Digest {
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Self(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn hex(&self) -> &str {
        &self.0["sha256:".len()..]
    }

    pub fn verify(&self, bytes: &[u8]) -> Result<()> {
        let actual = Self::from_bytes(bytes);
        if self == &actual {
            Ok(())
        } else {
            Err(SproutError::DigestMismatch {
                expected: self.to_string(),
                actual: actual.to_string(),
            })
        }
    }
}

impl FromStr for Sha256Digest {
    type Err = SproutError;

    fn from_str(value: &str) -> Result<Self> {
        let Some(hex) = value.strip_prefix("sha256:") else {
            return Err(SproutError::InvalidInput(
                "digest must use the sha256:<64 lowercase hex> form".into(),
            ));
        };
        if hex.len() != 64
            || !hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(SproutError::InvalidInput(
                "digest must use the sha256:<64 lowercase hex> form".into(),
            ));
        }
        Ok(Self(value.to_owned()))
    }
}

impl fmt::Display for Sha256Digest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::Sha256Digest;

    #[test]
    fn digest_form_is_canonical() {
        assert!(
            Sha256Digest::from_str(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            )
            .is_ok()
        );
        assert!(
            Sha256Digest::from_str(
                "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            )
            .is_err()
        );
        assert!(Sha256Digest::from_str("aaaaaaaa").is_err());
    }

    #[test]
    fn verifies_bytes() {
        let digest = Sha256Digest::from_bytes(b"plugin");
        digest.verify(b"plugin").unwrap();
        assert!(digest.verify(b"other").is_err());
    }
}
