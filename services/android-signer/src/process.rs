use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context as _, bail};
use base64::Engine as _;
use rand::RngCore as _;
use regex::Regex;
use sha2::{Digest as _, Sha256};

use crate::crypto::AppSigningSecret;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApkManifest {
    pub package_name: String,
    pub version_code: u64,
    pub version_name: String,
}

impl ApkManifest {
    pub fn assert_expected(&self, package_name: &str, version_code: u64) -> anyhow::Result<()> {
        if self.package_name != package_name {
            bail!("APK package name does not match the generated project package")
        }
        if self.version_code != version_code {
            bail!("APK versionCode does not match the declared release")
        }
        if self.version_name.is_empty() {
            bail!("APK has no versionName")
        }
        Ok(())
    }
}

pub trait AndroidTools: Send + Sync {
    fn generate_key(&self, package_name: &str) -> anyhow::Result<AppSigningSecret>;
    fn assert_unsigned(&self, apk: &Path) -> anyhow::Result<()>;
    fn manifest(&self, apk: &Path) -> anyhow::Result<ApkManifest>;
    fn sign(
        &self,
        unsigned_apk: &Path,
        signed_apk: &Path,
        key: &AppSigningSecret,
    ) -> anyhow::Result<()>;
    fn verify_signed(&self, apk: &Path) -> anyhow::Result<String>;
}

#[derive(Debug, Clone)]
pub struct CommandAndroidTools {
    pub keytool: PathBuf,
    pub aapt2: PathBuf,
    pub zipalign: PathBuf,
    pub apksigner: PathBuf,
}

impl CommandAndroidTools {
    pub fn discover(sdk_root: Option<&Path>) -> anyhow::Result<Self> {
        let keytool = executable_from_env("APK_SIGNER_KEYTOOL").unwrap_or_else(|| "keytool".into());
        let aapt2 = executable_from_env("APK_SIGNER_AAPT2")
            .or_else(|| newest_build_tool(sdk_root, "aapt2"));
        let zipalign = executable_from_env("APK_SIGNER_ZIPALIGN")
            .or_else(|| newest_build_tool(sdk_root, "zipalign"));
        let apksigner = executable_from_env("APK_SIGNER_APKSIGNER")
            .or_else(|| newest_build_tool(sdk_root, "apksigner"));
        Ok(Self {
            keytool,
            aapt2: aapt2.context("aapt2 not found; set APK_SIGNER_ANDROID_SDK_ROOT")?,
            zipalign: zipalign.context("zipalign not found; set APK_SIGNER_ANDROID_SDK_ROOT")?,
            apksigner: apksigner.context("apksigner not found; set APK_SIGNER_ANDROID_SDK_ROOT")?,
        })
    }
}

impl AndroidTools for CommandAndroidTools {
    fn generate_key(&self, package_name: &str) -> anyhow::Result<AppSigningSecret> {
        validate_package_name(package_name)?;
        let temp = tempfile::Builder::new().prefix("sproutos-key-").tempdir()?;
        restrict_directory(temp.path())?;
        let keystore = temp.path().join("app.p12");
        let certificate = temp.path().join("certificate.der");
        let password = random_password();
        let password_file = temp.path().join("password");
        std::fs::write(&password_file, format!("{password}\n"))?;
        restrict_file(&password_file)?;
        let alias = "sproutos".to_owned();
        let args = vec![
            "-genkeypair".into(),
            "-noprompt".into(),
            "-storetype".into(),
            "PKCS12".into(),
            "-keystore".into(),
            keystore.as_os_str().to_owned(),
            "-storepass:file".into(),
            password_file.as_os_str().to_owned(),
            "-keypass:file".into(),
            password_file.as_os_str().to_owned(),
            "-alias".into(),
            alias.clone().into(),
            "-keyalg".into(),
            "RSA".into(),
            "-keysize".into(),
            "3072".into(),
            "-sigalg".into(),
            "SHA256withRSA".into(),
            "-validity".into(),
            "9125".into(),
            "-dname".into(),
            format!("CN={package_name},O=SproutOS,C=US").into(),
        ];
        run_checked(&self.keytool, &args)?;
        run_checked(
            &self.keytool,
            &[
                "-exportcert".into(),
                "-keystore".into(),
                keystore.as_os_str().to_owned(),
                "-storepass:file".into(),
                password_file.as_os_str().to_owned(),
                "-alias".into(),
                alias.clone().into(),
                "-file".into(),
                certificate.as_os_str().to_owned(),
            ],
        )?;
        let pkcs12 = std::fs::read(&keystore)?;
        let cert = std::fs::read(&certificate)?;
        Ok(AppSigningSecret {
            pkcs12_base64: base64::engine::general_purpose::STANDARD.encode(pkcs12),
            password,
            alias,
            certificate_sha256: hex::encode(Sha256::digest(cert)),
        })
    }

    fn assert_unsigned(&self, apk: &Path) -> anyhow::Result<()> {
        let result = run(
            &self.apksigner,
            &["verify".into(), apk.as_os_str().to_owned()],
        )?;
        if result.success {
            bail!("APK is already signed")
        }
        Ok(())
    }

    fn manifest(&self, apk: &Path) -> anyhow::Result<ApkManifest> {
        let output = run_checked(
            &self.aapt2,
            &["dump".into(), "badging".into(), apk.as_os_str().to_owned()],
        )?;
        parse_badging(&output.stdout)
    }

    fn sign(
        &self,
        unsigned_apk: &Path,
        signed_apk: &Path,
        key: &AppSigningSecret,
    ) -> anyhow::Result<()> {
        let temp = tempfile::Builder::new()
            .prefix("sproutos-key-use-")
            .tempdir()?;
        restrict_directory(temp.path())?;
        let keystore = temp.path().join("app.p12");
        let password_file = temp.path().join("password");
        let aligned = temp.path().join("aligned.apk");
        let mut pkcs12 = base64::engine::general_purpose::STANDARD
            .decode(&key.pkcs12_base64)
            .context("keystore payload is malformed")?;
        std::fs::write(&keystore, &pkcs12)?;
        zeroize::Zeroize::zeroize(&mut pkcs12);
        restrict_file(&keystore)?;
        // apksigner reads the file once per password option, sequentially rather than reopening it.
        std::fs::write(
            &password_file,
            format!("{}\n{}\n", key.password, key.password),
        )?;
        restrict_file(&password_file)?;
        run_checked(
            &self.zipalign,
            &[
                "-p".into(),
                "-f".into(),
                "4".into(),
                unsigned_apk.as_os_str().to_owned(),
                aligned.as_os_str().to_owned(),
            ],
        )?;
        run_checked(
            &self.apksigner,
            &[
                "sign".into(),
                "--ks".into(),
                keystore.as_os_str().to_owned(),
                "--ks-type".into(),
                "PKCS12".into(),
                "--ks-key-alias".into(),
                key.alias.clone().into(),
                "--ks-pass".into(),
                format!("file:{}", password_file.display()).into(),
                "--key-pass".into(),
                format!("file:{}", password_file.display()).into(),
                "--out".into(),
                signed_apk.as_os_str().to_owned(),
                aligned.as_os_str().to_owned(),
            ],
        )?;
        Ok(())
    }

    fn verify_signed(&self, apk: &Path) -> anyhow::Result<String> {
        let output = run_checked(
            &self.apksigner,
            &[
                "verify".into(),
                "--verbose".into(),
                "--print-certs".into(),
                apk.as_os_str().to_owned(),
            ],
        )?;
        parse_certificate_sha256(&output.stdout)
    }
}

fn parse_badging(bytes: &[u8]) -> anyhow::Result<ApkManifest> {
    let output = std::str::from_utf8(bytes).context("aapt2 output was not UTF-8")?;
    let line = output
        .lines()
        .find(|line| line.starts_with("package: "))
        .context("aapt2 reported no package metadata")?;
    let capture = |name: &str| -> anyhow::Result<String> {
        let regex = Regex::new(&format!(r#"(?:^|\s){name}='([^']*)'"#)).expect("fixed regex");
        Ok(regex
            .captures(line)
            .and_then(|captures| captures.get(1))
            .with_context(|| format!("aapt2 reported no {name}"))?
            .as_str()
            .to_owned())
    };
    Ok(ApkManifest {
        package_name: capture("name")?,
        version_code: capture("versionCode")?
            .parse()
            .context("APK versionCode is not an integer")?,
        version_name: capture("versionName")?,
    })
}

fn parse_certificate_sha256(bytes: &[u8]) -> anyhow::Result<String> {
    let output = std::str::from_utf8(bytes).context("apksigner output was not UTF-8")?;
    let prefix = "Signer #1 certificate SHA-256 digest:";
    let value = output
        .lines()
        .find_map(|line| line.trim().strip_prefix(prefix))
        .context("apksigner reported no signer certificate")?;
    let normalized: String = value
        .chars()
        .filter(|character| character.is_ascii_hexdigit())
        .map(|character| character.to_ascii_lowercase())
        .collect();
    if normalized.len() != 64 {
        bail!("apksigner certificate digest is malformed")
    }
    Ok(normalized)
}

struct ToolOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    overflow: bool,
}

fn run_checked(executable: &Path, args: &[OsString]) -> anyhow::Result<ToolOutput> {
    let result = run(executable, args)?;
    if result.overflow {
        bail!("Android tool output exceeded {OUTPUT_LIMIT} bytes")
    }
    if !result.success {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let stderr: String = stderr.chars().take(1000).collect();
        bail!("Android tool failed: {stderr}")
    }
    Ok(result)
}

fn run(executable: &Path, args: &[OsString]) -> anyhow::Result<ToolOutput> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // A parser bug in an Android tool must not inherit the control-plane bearer token or the
        // path to the master identity. Re-add only what the Java launchers need.
        .env_clear()
        .env("LANG", "C");
    for name in ["PATH", "JAVA_HOME", "SystemRoot", "WINDIR", "PATHEXT"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("could not start {}", executable.display()))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let stdout_reader = std::thread::spawn(move || read_bounded(stdout));
    let stderr_reader = std::thread::spawn(move || read_bounded(stderr));
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if start.elapsed() >= COMMAND_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "Android tool timed out after {} seconds",
                COMMAND_TIMEOUT.as_secs()
            )
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let (stdout, stdout_overflow) = stdout_reader
        .join()
        .map_err(|_| anyhow::anyhow!("stdout reader stopped"))??;
    let (stderr, stderr_overflow) = stderr_reader
        .join()
        .map_err(|_| anyhow::anyhow!("stderr reader stopped"))??;
    Ok(ToolOutput {
        success: status.success(),
        stdout,
        stderr,
        overflow: stdout_overflow || stderr_overflow,
    })
}

fn read_bounded(mut reader: impl Read) -> std::io::Result<(Vec<u8>, bool)> {
    let mut kept = Vec::new();
    let mut overflow = false;
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = OUTPUT_LIMIT.saturating_sub(kept.len());
        kept.extend_from_slice(&buffer[..read.min(remaining)]);
        overflow |= read > remaining;
    }
    Ok((kept, overflow))
}

fn executable_from_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(Into::into)
}

fn newest_build_tool(sdk_root: Option<&Path>, executable: &str) -> Option<PathBuf> {
    let root = sdk_root?.join("build-tools");
    let mut versions: Vec<PathBuf> = std::fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    versions.sort();
    versions.reverse();
    versions
        .into_iter()
        .map(|version| version.join(executable))
        .find(|path| path.is_file())
}

fn random_password() -> String {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn validate_package_name(package_name: &str) -> anyhow::Result<()> {
    let valid = package_name.len() <= 255
        && package_name.split('.').count() >= 2
        && package_name.split('.').all(|segment| {
            !segment.is_empty()
                && segment
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic())
                && segment
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
        });
    if !valid {
        bail!("generated Android package name is malformed")
    }
    Ok(())
}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_directory(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn restrict_file(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_file(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_manifest_metadata_without_trusting_field_order() {
        let parsed = parse_badging(
            b"package: versionName='1.2.3' name='me.sproutos.app.pabc' versionCode='42'\n",
        )
        .unwrap();
        assert_eq!(
            parsed,
            ApkManifest {
                package_name: "me.sproutos.app.pabc".into(),
                version_code: 42,
                version_name: "1.2.3".into(),
            }
        );
    }

    #[test]
    fn validates_package_segments() {
        assert!(validate_package_name("me.sproutos.app.p0123").is_ok());
        assert!(validate_package_name("me.sproutos.bad-name").is_err());
        assert!(validate_package_name("single").is_err());
    }

    #[test]
    fn parses_apksigner_fingerprint() {
        assert_eq!(
            parse_certificate_sha256(
                b"Signer #1 certificate SHA-256 digest: aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99\n"
            )
            .unwrap(),
            "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
        );
    }
}
