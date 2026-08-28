use std::path::Path;

use aes_gcm::aead::{Aead as _, KeyInit as _, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Context as _, bail};
use base64::Engine as _;
use rand::RngCore as _;
use rsa::pkcs8::{DecodePrivateKey as _, EncodePrivateKey as _, LineEnding};
use rsa::traits::PublicKeyParts as _;
use rsa::{Oaep, RsaPrivateKey, RsaPublicKey};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const AAD: &[u8] = b"sproutos/android-keystore/v1";

#[derive(Serialize, Deserialize)]
struct Envelope {
    version: u8,
    algorithm: String,
    wrapped_data_key: String,
    nonce: String,
    ciphertext: String,
}

/// The machine-local identity. Only its public half participates in encryption; AWS receives
/// neither half, only an opaque envelope encrypted to it.
pub struct MasterIdentity(RsaPrivateKey);

impl MasterIdentity {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        assert_private_permissions(path)?;
        let pem =
            Zeroizing::new(std::fs::read_to_string(path).with_context(|| {
                format!("could not read master identity at {}", path.display())
            })?);
        let key = RsaPrivateKey::from_pkcs8_pem(&pem)
            .context("master identity is not an RSA PKCS#8 private key")?;
        if key.size() < 384 {
            bail!("master identity must be at least 3072-bit RSA")
        }
        Ok(Self(key))
    }

    pub fn create(path: &Path) -> anyhow::Result<()> {
        let mut file = reserve_secret(path)?;
        let result = (|| -> anyhow::Result<()> {
            let key = RsaPrivateKey::new(&mut OsRng, 3072)
                .context("could not generate the on-prem master identity")?;
            let pem = key.to_pkcs8_pem(LineEnding::LF)?;
            use std::io::Write as _;
            file.write_all(pem.as_bytes())?;
            file.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            drop(file);
            let _ = std::fs::remove_file(path);
        }
        result
    }

    pub fn encrypt(&self, plaintext: &[u8]) -> anyhow::Result<Vec<u8>> {
        let mut data_key = [0_u8; 32];
        OsRng.fill_bytes(&mut data_key);
        let cipher = Aes256Gcm::new_from_slice(&data_key).expect("32 byte AES key");
        let mut nonce = [0_u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                aes_gcm::aead::Payload {
                    msg: plaintext,
                    aad: AAD,
                },
            )
            .map_err(|_| anyhow::anyhow!("keystore encryption failed"))?;
        let wrapped = RsaPublicKey::from(&self.0)
            .encrypt(&mut OsRng, Oaep::new::<Sha256>(), &data_key)
            .context("could not wrap the per-app data key")?;
        data_key.zeroize();

        let b64 = base64::engine::general_purpose::STANDARD;
        Ok(serde_json::to_vec(&Envelope {
            version: 1,
            algorithm: "RSA-OAEP-SHA256+A256GCM".to_owned(),
            wrapped_data_key: b64.encode(wrapped),
            nonce: b64.encode(nonce),
            ciphertext: b64.encode(ciphertext),
        })?)
    }

    pub fn decrypt(&self, encoded: &[u8]) -> anyhow::Result<Vec<u8>> {
        let envelope: Envelope =
            serde_json::from_slice(encoded).context("protected keystore envelope is malformed")?;
        if envelope.version != 1 || envelope.algorithm != "RSA-OAEP-SHA256+A256GCM" {
            bail!("protected keystore envelope uses an unsupported format")
        }
        let b64 = base64::engine::general_purpose::STANDARD;
        let wrapped = b64
            .decode(envelope.wrapped_data_key)
            .context("wrapped data key is malformed")?;
        let mut data_key = self
            .0
            .decrypt(Oaep::new::<Sha256>(), &wrapped)
            .context("could not unwrap the per-app data key")?;
        if data_key.len() != 32 {
            data_key.zeroize();
            bail!("unwrapped app data key has the wrong length")
        }
        let nonce = b64.decode(envelope.nonce).context("nonce is malformed")?;
        if nonce.len() != 12 {
            data_key.zeroize();
            bail!("protected keystore nonce has the wrong length")
        }
        let ciphertext = b64
            .decode(envelope.ciphertext)
            .context("protected keystore ciphertext is malformed")?;
        let cipher = Aes256Gcm::new_from_slice(&data_key).expect("validated AES key");
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                aes_gcm::aead::Payload {
                    msg: &ciphertext,
                    aad: AAD,
                },
            )
            .map_err(|_| anyhow::anyhow!("protected keystore authentication failed"));
        data_key.zeroize();
        plaintext
    }

    #[cfg(test)]
    fn test_identity() -> Self {
        Self(RsaPrivateKey::new(&mut OsRng, 2048).unwrap())
    }
}

#[cfg(unix)]
fn assert_private_permissions(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    let mode = std::fs::metadata(path)?.permissions().mode();
    if mode & 0o077 != 0 {
        bail!("master identity must not be readable or writable by group or other users")
    }
    Ok(())
}

#[cfg(not(unix))]
fn assert_private_permissions(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct AppSigningSecret {
    pub pkcs12_base64: String,
    pub password: String,
    pub alias: String,
    pub certificate_sha256: String,
    /// DER X.509 certificate. Public, but kept beside the key so registration can use the exact
    /// certificate whose digest was recorded without invoking another parser.
    #[serde(default)]
    pub certificate_der_base64: String,
}

impl AppSigningSecret {
    pub fn encoded(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("serializable app signing secret")
    }

    pub fn decode(bytes: &[u8]) -> anyhow::Result<Self> {
        let result: Self =
            serde_json::from_slice(bytes).context("app signing secret is malformed")?;
        let digest = result.certificate_sha256.as_bytes();
        if digest.len() != 64 || !digest.iter().all(u8::is_ascii_hexdigit) {
            bail!("app signing secret certificate digest is malformed")
        }
        if result.password.is_empty() || result.alias.is_empty() {
            bail!("app signing secret is incomplete")
        }
        Ok(result)
    }
}

#[cfg(unix)]
fn reserve_secret(path: &Path) -> anyhow::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt as _;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("refusing to replace master identity at {}", path.display()))
}

#[cfg(not(unix))]
fn reserve_secret(path: &Path) -> anyhow::Result<std::fs::File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("refusing to replace master identity at {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelopes_use_a_fresh_data_key_and_authenticate_contents() {
        let identity = MasterIdentity::test_identity();
        let one = identity.encrypt(b"secret").unwrap();
        let two = identity.encrypt(b"secret").unwrap();
        assert_ne!(one, two);
        assert_eq!(identity.decrypt(&one).unwrap(), b"secret");

        let mut tampered: Envelope = serde_json::from_slice(&one).unwrap();
        tampered.ciphertext.push('A');
        assert!(
            identity
                .decrypt(&serde_json::to_vec(&tampered).unwrap())
                .is_err()
        );
    }
}
