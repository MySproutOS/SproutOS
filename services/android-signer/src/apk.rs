use std::fs::File;
use std::io::{Read, Seek};
use std::path::Path;

use anyhow::{Context as _, bail};
use sha2::{Digest as _, Sha256};
use zip::ZipArchive;

/// Parse enough of the ZIP container to reject archives wrapped around an APK, traversal entries,
/// symlinks, and already-signed JAR metadata before any Android tool sees customer bytes.
pub fn validate_zip_structure(path: &Path) -> anyhow::Result<()> {
    let file = File::open(path).context("could not open APK")?;
    validate_zip(file, false)
}

pub fn validate_unsigned_zip_structure(path: &Path) -> anyhow::Result<()> {
    let file = File::open(path).context("could not open APK")?;
    validate_zip(file, true)
}

fn validate_zip<R: Read + Seek>(reader: R, reject_signing_metadata: bool) -> anyhow::Result<()> {
    let mut archive = ZipArchive::new(reader).context("APK is not a ZIP container")?;
    if archive.is_empty() {
        bail!("APK contains no entries")
    }
    let mut manifest = false;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .context("APK ZIP directory is malformed")?;
        let raw = entry.name();
        let Some(path) = entry.enclosed_name() else {
            bail!("APK contains a path traversal entry")
        };
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            bail!("APK contains a symbolic link")
        }
        if path == Path::new("AndroidManifest.xml") {
            manifest = true;
        }
        let upper = raw.to_ascii_uppercase();
        if reject_signing_metadata
            && upper.starts_with("META-INF/")
            && [".RSA", ".DSA", ".EC", ".SF"]
                .iter()
                .any(|suffix| upper.ends_with(suffix))
        {
            bail!("APK already contains signing metadata")
        }
        if upper.ends_with(".APK") {
            bail!("received a ZIP containing an APK instead of one raw APK")
        }
    }
    if !manifest {
        bail!("APK has no AndroidManifest.xml")
    }
    Ok(())
}

pub fn sha256_file(path: &Path) -> anyhow::Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write as _};

    use super::*;

    fn apk(entries: &[(&str, &[u8])]) -> Cursor<Vec<u8>> {
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut bytes);
            for (name, value) in entries {
                zip.start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                zip.write_all(value).unwrap();
            }
            zip.finish().unwrap();
        }
        bytes.set_position(0);
        bytes
    }

    #[test]
    fn accepts_an_unsigned_raw_apk_shape() {
        validate_zip(
            apk(&[("AndroidManifest.xml", b"binary"), ("classes.dex", b"dex")]),
            true,
        )
        .unwrap();
    }

    #[test]
    fn rejects_zip_wrappers_and_signed_inputs() {
        assert!(
            validate_zip(
                apk(&[
                    ("AndroidManifest.xml", b"binary"),
                    ("release.apk", b"nested"),
                ]),
                true
            )
            .unwrap_err()
            .to_string()
            .contains("raw APK")
        );
        assert!(
            validate_zip(
                apk(&[
                    ("AndroidManifest.xml", b"binary"),
                    ("META-INF/CERT.RSA", b"signed"),
                ]),
                true
            )
            .unwrap_err()
            .to_string()
            .contains("signing metadata")
        );
    }
}
