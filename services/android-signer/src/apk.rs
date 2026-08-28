use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use anyhow::{Context as _, bail};
use sha2::{Digest as _, Sha256};
use zip::ZipArchive;

const MAX_APK_ENTRIES: usize = 100_000;

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
    validate_zip_with_limit(reader, reject_signing_metadata, MAX_APK_ENTRIES)
}

fn validate_zip_with_limit<R: Read + Seek>(
    mut reader: R,
    reject_signing_metadata: bool,
    max_entries: usize,
) -> anyhow::Result<()> {
    let declared_entries = declared_zip_entries(&mut reader)?;
    if declared_entries > max_entries as u64 {
        bail!("APK contains too many ZIP entries")
    }
    reader.rewind()?;
    let mut archive = ZipArchive::new(reader).context("APK is not a ZIP container")?;
    if archive.is_empty() {
        bail!("APK contains no entries")
    }
    if archive.len() as u64 != declared_entries {
        bail!("APK contains duplicate ZIP entry names")
    }
    let mut manifest = false;
    let mut names = HashSet::with_capacity(archive.len());
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .context("APK ZIP directory is malformed")?;
        if !names.insert(entry.name_raw().to_owned()) {
            bail!("APK contains duplicate ZIP entry names")
        }
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

/// Read the central-directory entry count independently of `zip::ZipArchive`. The crate indexes
/// entries by name and therefore collapses duplicate names; comparing its length with the on-disk
/// count closes that parser differential and also lets us reject a ZIP64 entry-count bomb before
/// allocating or iterating per-entry state.
fn declared_zip_entries<R: Read + Seek>(reader: &mut R) -> anyhow::Result<u64> {
    const EOCD_MIN: u64 = 22;
    const EOCD_MAX: u64 = EOCD_MIN + u16::MAX as u64;
    const ZIP64_LOCATOR_SIZE: u64 = 20;

    let length = reader.seek(SeekFrom::End(0))?;
    if length < EOCD_MIN {
        bail!("APK ZIP end-of-central-directory record is missing")
    }
    let tail_length = length.min(EOCD_MAX) as usize;
    reader.seek(SeekFrom::End(-(tail_length as i64)))?;
    let mut tail = vec![0_u8; tail_length];
    reader.read_exact(&mut tail)?;
    let eocd = (0..=tail.len() - EOCD_MIN as usize)
        .rfind(|&index| {
            tail[index..].starts_with(b"PK\x05\x06")
                && u16::from_le_bytes([tail[index + 20], tail[index + 21]]) as usize
                    == tail.len() - index - EOCD_MIN as usize
        })
        .context("APK ZIP end-of-central-directory record is missing")?;
    let disk = u16::from_le_bytes([tail[eocd + 4], tail[eocd + 5]]);
    let central_disk = u16::from_le_bytes([tail[eocd + 6], tail[eocd + 7]]);
    let entries_on_disk = u16::from_le_bytes([tail[eocd + 8], tail[eocd + 9]]);
    let total_entries = u16::from_le_bytes([tail[eocd + 10], tail[eocd + 11]]);
    if disk != 0 || central_disk != 0 || entries_on_disk != total_entries {
        bail!("multi-disk APK ZIPs are not supported")
    }
    if total_entries != u16::MAX {
        return Ok(u64::from(total_entries));
    }

    let eocd_offset = length - tail_length as u64 + eocd as u64;
    if eocd_offset < ZIP64_LOCATOR_SIZE {
        bail!("APK ZIP64 locator is missing")
    }
    reader.seek(SeekFrom::Start(eocd_offset - ZIP64_LOCATOR_SIZE))?;
    let mut locator = [0_u8; ZIP64_LOCATOR_SIZE as usize];
    reader.read_exact(&mut locator)?;
    if !locator.starts_with(b"PK\x06\x07") {
        bail!("APK ZIP64 locator is missing")
    }
    if u32::from_le_bytes(locator[4..8].try_into().expect("four-byte disk")) != 0
        || u32::from_le_bytes(locator[16..20].try_into().expect("four-byte disk count")) != 1
    {
        bail!("multi-disk APK ZIPs are not supported")
    }
    let zip64_offset = u64::from_le_bytes(
        locator[8..16]
            .try_into()
            .expect("eight-byte ZIP64 EOCD offset"),
    );
    reader.seek(SeekFrom::Start(zip64_offset))?;
    let mut zip64 = [0_u8; 56];
    reader.read_exact(&mut zip64)?;
    if !zip64.starts_with(b"PK\x06\x06") {
        bail!("APK ZIP64 end-of-central-directory record is missing")
    }
    let zip64_entries_on_disk =
        u64::from_le_bytes(zip64[24..32].try_into().expect("eight-byte entry count"));
    let zip64_total_entries =
        u64::from_le_bytes(zip64[32..40].try_into().expect("eight-byte entry count"));
    if zip64_entries_on_disk != zip64_total_entries {
        bail!("multi-disk APK ZIPs are not supported")
    }
    Ok(zip64_total_entries)
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

    #[test]
    fn rejects_duplicate_names_before_zip_consumers_can_choose_different_entries() {
        let mut bytes = apk(&[
            ("AndroidManifest.xml", b"first manifest"),
            ("classes1.dex", b"first dex"),
            ("classes2.dex", b"second dex"),
        ])
        .into_inner();
        for offset in 0..=bytes.len() - b"classes2.dex".len() {
            if &bytes[offset..offset + b"classes2.dex".len()] == b"classes2.dex" {
                bytes[offset..offset + b"classes1.dex".len()].copy_from_slice(b"classes1.dex");
            }
        }
        let parsed = ZipArchive::new(Cursor::new(bytes.clone())).unwrap();
        assert_eq!(
            parsed.len(),
            2,
            "the downstream parser collapses the duplicate"
        );
        assert_eq!(declared_zip_entries(&mut Cursor::new(&bytes)).unwrap(), 3);
        assert!(
            validate_zip(Cursor::new(bytes), true)
                .unwrap_err()
                .to_string()
                .contains("duplicate ZIP entry names")
        );
    }

    #[test]
    fn rejects_entry_count_bombs_before_iterating_archive_contents() {
        assert!(
            validate_zip_with_limit(
                apk(&[
                    ("AndroidManifest.xml", b"binary"),
                    ("classes.dex", b"dex"),
                    ("resources.arsc", b"resources"),
                ]),
                true,
                2,
            )
            .unwrap_err()
            .to_string()
            .contains("too many ZIP entries")
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
}
