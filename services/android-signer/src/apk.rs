use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write as _};
use std::path::Path;

use anyhow::{Context as _, bail};
use sha2::{Digest as _, Sha256};
use zip::ZipArchive;

const REGISTRATION_ASSET: &str = "assets/adi-registration.properties";

/// Parse enough of the ZIP container to reject archives wrapped around an APK, traversal entries,
/// symlinks, and already-signed JAR metadata before any Android tool sees customer bytes.
pub fn validate_zip_structure(path: &Path) -> anyhow::Result<()> {
    let file = File::open(path).context("could not open APK")?;
    validate_zip(file, false)
}

pub fn validate_unsigned_zip_structure(path: &Path) -> anyhow::Result<()> {
    let mut file = File::open(path).context("could not open APK")?;
    if contains_apk_signing_block(&mut file)? {
        bail!("APK already contains an APK Signing Block")
    }
    file.rewind()?;
    validate_zip(file, true)
}

fn contains_apk_signing_block(file: &mut File) -> anyhow::Result<bool> {
    const EOCD_MIN: u64 = 22;
    const EOCD_MAX: u64 = EOCD_MIN + u16::MAX as u64;
    const SIGNING_BLOCK_FOOTER: u64 = 24;
    const MAGIC: &[u8; 16] = b"APK Sig Block 42";

    let length = file.metadata()?.len();
    if length < EOCD_MIN {
        return Ok(false);
    }
    let tail_length = length.min(EOCD_MAX) as usize;
    file.seek(SeekFrom::End(-(tail_length as i64)))?;
    let mut tail = vec![0_u8; tail_length];
    file.read_exact(&mut tail)?;
    let eocd = (0..=tail.len() - EOCD_MIN as usize)
        .rfind(|&index| {
            tail[index..].starts_with(b"PK\x05\x06")
                && u16::from_le_bytes([tail[index + 20], tail[index + 21]]) as usize
                    == tail.len() - index - EOCD_MIN as usize
        })
        .context("APK ZIP end-of-central-directory record is missing")?;
    if eocd + 20 > tail.len() {
        bail!("APK ZIP end-of-central-directory record is truncated")
    }
    let central_offset = u32::from_le_bytes(
        tail[eocd + 16..eocd + 20]
            .try_into()
            .expect("four-byte central directory offset"),
    ) as u64;
    if central_offset < SIGNING_BLOCK_FOOTER {
        return Ok(false);
    }
    file.seek(SeekFrom::Start(central_offset - SIGNING_BLOCK_FOOTER))?;
    let mut footer = [0_u8; SIGNING_BLOCK_FOOTER as usize];
    file.read_exact(&mut footer)?;
    Ok(&footer[8..] == MAGIC)
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

/// Copy an unsigned APK while adding Google's opaque ownership token as the exact asset required
/// by Android developer verification. The token is intentionally not persisted by this helper.
pub fn add_registration_token(
    source: &Path,
    destination: &Path,
    token: &str,
) -> anyhow::Result<()> {
    if token.is_empty() || token.contains(['\r', '\n']) {
        bail!("Android Developer Console ownership token is malformed")
    }
    validate_unsigned_zip_structure(source)?;
    let mut archive = ZipArchive::new(File::open(source)?)?;
    let mut output = zip::ZipWriter::new(File::create(destination)?);
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        if entry.name() == REGISTRATION_ASSET {
            continue;
        }
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(entry.compression())
            .unix_permissions(entry.unix_mode().unwrap_or(0o644));
        if entry.is_dir() {
            output.add_directory(entry.name(), options)?;
        } else {
            output.start_file(entry.name(), options)?;
            std::io::copy(&mut entry, &mut output)?;
        }
    }
    output.start_file(
        REGISTRATION_ASSET,
        zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored)
            .unix_permissions(0o644),
    )?;
    // The official sample is the opaque snippet alone: no property name and no trailing newline.
    output.write_all(token.as_bytes())?;
    output.finish()?.sync_all()?;
    validate_unsigned_zip_structure(destination)
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

    #[test]
    fn rejects_an_apk_signing_block_even_when_jar_metadata_is_absent() {
        let mut bytes =
            apk(&[("AndroidManifest.xml", b"binary"), ("classes.dex", b"dex")]).into_inner();
        let eocd = bytes
            .windows(4)
            .rposition(|window| window == b"PK\x05\x06")
            .unwrap();
        let central_offset = u32::from_le_bytes(bytes[eocd + 16..eocd + 20].try_into().unwrap());
        let mut footer = vec![0_u8; 8];
        footer.extend_from_slice(b"APK Sig Block 42");
        bytes.splice(central_offset as usize..central_offset as usize, footer);
        let moved_eocd = eocd + 24;
        bytes[moved_eocd + 16..moved_eocd + 20]
            .copy_from_slice(&(central_offset + 24).to_le_bytes());

        let temp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(temp.path(), bytes).unwrap();
        assert!(
            validate_unsigned_zip_structure(temp.path())
                .unwrap_err()
                .to_string()
                .contains("APK Signing Block")
        );
    }

    #[test]
    fn ownership_apk_contains_only_the_exact_opaque_token() {
        let source = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(
            source.path(),
            apk(&[("AndroidManifest.xml", b"binary"), ("classes.dex", b"dex")]).into_inner(),
        )
        .unwrap();
        let destination = tempfile::NamedTempFile::new().unwrap();
        add_registration_token(source.path(), destination.path(), "OPAQUE-TOKEN").unwrap();
        let mut archive = ZipArchive::new(File::open(destination.path()).unwrap()).unwrap();
        let mut token = String::new();
        archive
            .by_name(REGISTRATION_ASSET)
            .unwrap()
            .read_to_string(&mut token)
            .unwrap();
        assert_eq!(token, "OPAQUE-TOKEN");
    }
}
