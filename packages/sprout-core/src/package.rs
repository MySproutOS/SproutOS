use std::{
    fs::File,
    io::{Read, Seek},
    path::{Component, Path, PathBuf},
};

use serde::Serialize;
use sha2::{Digest as _, Sha256};
use walkdir::WalkDir;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter, write::SimpleFileOptions};

use crate::{Result, Sha256Digest, SproutError};

pub const ZIP_MEDIA_TYPE: &str = "application/zip";
pub const APK_MEDIA_TYPE: &str = "application/vnd.android.package-archive";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageKind {
    BuildZip,
    SiteZip,
    StaticZip,
    MigrationZip,
    AndroidApk,
}

impl PackageKind {
    pub fn media_type(self) -> &'static str {
        match self {
            Self::AndroidApk => APK_MEDIA_TYPE,
            Self::BuildZip | Self::SiteZip | Self::StaticZip | Self::MigrationZip => ZIP_MEDIA_TYPE,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PackagingLimits {
    pub max_entries: usize,
    pub max_source_bytes: u64,
    pub max_archive_bytes: u64,
    pub max_apk_bytes: u64,
}

impl Default for PackagingLimits {
    fn default() -> Self {
        Self {
            max_entries: 200_000,
            max_source_bytes: 1024 * 1024 * 1024,
            max_archive_bytes: 200 * 1024 * 1024,
            max_apk_bytes: 500 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct PackagedArtifact {
    pub path: PathBuf,
    pub kind: PackageKind,
    pub digest: Sha256Digest,
    pub size: u64,
}

#[derive(Clone, Debug)]
pub struct StaticPath {
    pub source: PathBuf,
    /// Relative URL prefix inside the static archive; empty means the archive root.
    pub prefix: String,
}

impl PackagedArtifact {
    pub fn media_type(&self) -> &'static str {
        self.kind.media_type()
    }
}

pub struct ArtifactPackager {
    limits: PackagingLimits,
}

impl ArtifactPackager {
    pub fn new(limits: PackagingLimits) -> Self {
        Self { limits }
    }

    pub fn package_zip(
        &self,
        source: &Path,
        destination: &Path,
        kind: PackageKind,
    ) -> Result<PackagedArtifact> {
        if matches!(kind, PackageKind::AndroidApk) {
            return Err(SproutError::InvalidInput(
                "Android APKs must be uploaded raw, never packaged as ZIP".into(),
            ));
        }
        let source = source.canonicalize().map_err(|source| SproutError::Io {
            operation: "resolve package source",
            source,
        })?;
        if !source.is_dir() {
            return Err(SproutError::PackagingRejected(
                "ZIP package source must be a directory".into(),
            ));
        }
        if destination.exists() {
            return Err(SproutError::PackagingRejected(format!(
                "package destination already exists: {}",
                destination.display()
            )));
        }
        let destination_parent = destination.parent().ok_or_else(|| {
            SproutError::InvalidInput("package destination must have a parent directory".into())
        })?;
        std::fs::create_dir_all(destination_parent).map_err(|source| SproutError::Io {
            operation: "create package directory",
            source,
        })?;
        let destination_parent =
            destination_parent
                .canonicalize()
                .map_err(|source| SproutError::Io {
                    operation: "resolve package directory",
                    source,
                })?;
        if destination_parent.starts_with(&source) {
            return Err(SproutError::PackagingRejected(
                "package destination must be outside the source tree".into(),
            ));
        }

        let mut entries = Vec::new();
        let mut source_bytes = 0_u64;
        for entry in WalkDir::new(&source)
            .follow_links(false)
            .sort_by_file_name()
        {
            let entry = entry.map_err(|error| {
                SproutError::PackagingRejected(format!("could not scan package: {error}"))
            })?;
            if entry.depth() == 0 || entry.file_type().is_dir() {
                continue;
            }
            if entries.len() >= self.limits.max_entries {
                return Err(SproutError::PackagingRejected(format!(
                    "package exceeds {} entries",
                    self.limits.max_entries
                )));
            }
            let relative = entry.path().strip_prefix(&source).map_err(|_| {
                SproutError::PackagingRejected("package entry escaped source tree".into())
            })?;
            let name = archive_name(relative)?;
            let metadata =
                std::fs::symlink_metadata(entry.path()).map_err(|source| SproutError::Io {
                    operation: "inspect package entry",
                    source,
                })?;
            if !metadata.is_file() && !metadata.file_type().is_symlink() {
                return Err(SproutError::PackagingRejected(format!(
                    "unsupported package entry: {name}"
                )));
            }
            let size = if metadata.file_type().is_symlink() {
                let target =
                    std::fs::read_link(entry.path()).map_err(|source| SproutError::Io {
                        operation: "read package symlink",
                        source,
                    })?;
                validate_symlink(&source, relative, &target)?;
                target.as_os_str().as_encoded_bytes().len() as u64
            } else {
                metadata.len()
            };
            source_bytes = source_bytes.saturating_add(size);
            if source_bytes > self.limits.max_source_bytes {
                return Err(SproutError::PackagingRejected(format!(
                    "package source exceeds {} bytes",
                    self.limits.max_source_bytes
                )));
            }
            entries.push((entry.path().to_owned(), name, metadata));
        }
        if entries.is_empty() {
            return Err(SproutError::PackagingRejected(
                "package source contains no files".into(),
            ));
        }

        let output = File::options()
            .create_new(true)
            .write(true)
            .read(true)
            .open(destination)
            .map_err(|source| SproutError::Io {
                operation: "create ZIP package",
                source,
            })?;
        let mut zip = ZipWriter::new(output);
        let timestamp = DateTime::from_date_and_time(2020, 1, 1, 0, 0, 0).map_err(|error| {
            SproutError::PackagingRejected(format!("invalid deterministic ZIP timestamp: {error}"))
        })?;
        for (path, name, metadata) in entries {
            if metadata.file_type().is_symlink() {
                let target = std::fs::read_link(&path).map_err(|source| SproutError::Io {
                    operation: "read package symlink",
                    source,
                })?;
                let target = target.to_str().ok_or_else(|| {
                    SproutError::PackagingRejected(format!(
                        "symlink target is not UTF-8: {}",
                        path.display()
                    ))
                })?;
                let options = SimpleFileOptions::default()
                    .compression_method(CompressionMethod::Stored)
                    .last_modified_time(timestamp)
                    .unix_permissions(0o777);
                zip.add_symlink(name, target, options).map_err(zip_error)?;
            } else {
                let permissions = if executable(&metadata) { 0o755 } else { 0o644 };
                let options = SimpleFileOptions::default()
                    .compression_method(CompressionMethod::Deflated)
                    .compression_level(Some(9))
                    .last_modified_time(timestamp)
                    .unix_permissions(permissions)
                    .large_file(metadata.len() >= u32::MAX.into());
                zip.start_file(name, options).map_err(zip_error)?;
                let mut input = File::open(&path).map_err(|source| SproutError::Io {
                    operation: "open package entry",
                    source,
                })?;
                std::io::copy(&mut input, &mut zip).map_err(|source| SproutError::Io {
                    operation: "write package entry",
                    source,
                })?;
            }
        }
        let output = zip.finish().map_err(zip_error)?;
        let size = output
            .metadata()
            .map_err(|source| SproutError::Io {
                operation: "inspect ZIP package",
                source,
            })?
            .len();
        drop(output);
        if size == 0 || size > self.limits.max_archive_bytes {
            let _ = std::fs::remove_file(destination);
            return Err(SproutError::PackagingRejected(format!(
                "ZIP package is {size} bytes; limit is {}",
                self.limits.max_archive_bytes
            )));
        }
        artifact_from_file(destination, kind)
    }

    /// Prepare a runnable preset in a private staging tree, then package it without mutating the
    /// caller's build output. `next` and `hono` receive the Lambda Web Adapter `run.sh`; `web`
    /// supplies that executable and receives a custom-runtime bridge; Next's
    /// standalone output also receives the adjacent static/public trees that Next excludes.
    pub fn package_deploy_directory(
        &self,
        source: &Path,
        destination: &Path,
        kind: PackageKind,
        preset: &str,
    ) -> Result<PackagedArtifact> {
        if !matches!(preset, "next" | "hono" | "web") {
            return self.package_zip(source, destination, kind);
        }
        let source = source.canonicalize().map_err(|source| SproutError::Io {
            operation: "resolve deploy source",
            source,
        })?;
        let staging = tempfile::tempdir().map_err(|source| SproutError::Io {
            operation: "create preset staging directory",
            source,
        })?;
        copy_tree(&source, staging.path())?;
        if preset == "web" {
            let run_path = staging.path().join("run.sh");
            if !run_path.is_file() {
                return Err(SproutError::PackagingRejected(
                    "the web preset requires an executable run.sh at the artifact root".into(),
                ));
            }
            make_executable(&run_path)?;
            let bootstrap = staging.path().join("bootstrap");
            std::fs::write(&bootstrap, "#!/bin/sh\nset -eu\nexec ./run.sh\n").map_err(
                |source| SproutError::Io {
                    operation: "write web custom-runtime bridge",
                    source,
                },
            )?;
            make_executable(&bootstrap)?;
            return self.package_zip(staging.path(), destination, kind);
        }
        let entry = find_server_entry(staging.path())?;
        if preset == "next"
            && let Some(app_root) = next_app_root(&source)
        {
            let entry_dir = entry.parent().unwrap_or(Path::new(""));
            let static_source = app_root.join(".next/static");
            if static_source.is_dir() {
                copy_tree(
                    &static_source,
                    &staging.path().join(entry_dir).join(".next/static"),
                )?;
            }
            let public_source = app_root.join("public");
            if public_source.is_dir() {
                copy_tree(
                    &public_source,
                    &staging.path().join(entry_dir).join("public"),
                )?;
            }
        }
        let entry = archive_name(&entry)?;
        let run_path = staging.path().join("run.sh");
        std::fs::write(
            &run_path,
            format!("#!/bin/sh\nset -eu\nexec node -- {}\n", shell_quote(&entry)),
        )
        .map_err(|source| SproutError::Io {
            operation: "write preset entrypoint",
            source,
        })?;
        make_executable(&run_path)?;
        self.package_zip(staging.path(), destination, kind)
    }

    /// Accept either the direct CLI file form or the legacy action directory form. A directory is
    /// valid only when it contains exactly one regular `.apk`; zero or multiple candidates fail.
    pub fn package_apk_input(&self, input: &Path) -> Result<PackagedArtifact> {
        let metadata = std::fs::symlink_metadata(input).map_err(|source| SproutError::Io {
            operation: "inspect Android input",
            source,
        })?;
        if metadata.is_file() && !metadata.file_type().is_symlink() {
            return self.validate_apk(input);
        }
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(SproutError::PackagingRejected(
                "Android deployment input must be one APK file or a directory containing exactly one APK"
                    .into(),
            ));
        }
        let mut candidates = Vec::new();
        for entry in WalkDir::new(input).follow_links(false).sort_by_file_name() {
            let entry = entry.map_err(|error| {
                SproutError::PackagingRejected(format!("could not scan Android input: {error}"))
            })?;
            if entry.file_type().is_file()
                && entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("apk"))
            {
                candidates.push(entry.path().to_owned());
            }
        }
        if candidates.len() != 1 {
            return Err(SproutError::PackagingRejected(format!(
                "Android input must contain exactly one regular APK; found {}",
                candidates.len()
            )));
        }
        self.validate_apk(&candidates[0])
    }

    pub fn package_static_paths(
        &self,
        paths: &[StaticPath],
        destination: &Path,
    ) -> Result<PackagedArtifact> {
        if paths.is_empty() {
            return Err(SproutError::PackagingRejected(
                "static asset path list cannot be empty".into(),
            ));
        }
        let staging = tempfile::tempdir().map_err(|source| SproutError::Io {
            operation: "create static asset staging directory",
            source,
        })?;
        for mapping in paths {
            let source = mapping
                .source
                .canonicalize()
                .map_err(|source| SproutError::Io {
                    operation: "resolve static asset source",
                    source,
                })?;
            if !source.is_dir() {
                return Err(SproutError::PackagingRejected(format!(
                    "static asset source must be a directory: {}",
                    mapping.source.display()
                )));
            }
            let prefix = static_prefix(&mapping.prefix)?;
            copy_static_tree(&source, &staging.path().join(prefix))?;
        }
        self.package_zip(staging.path(), destination, PackageKind::StaticZip)
    }

    pub fn validate_apk(&self, path: &Path) -> Result<PackagedArtifact> {
        let metadata = std::fs::symlink_metadata(path).map_err(|source| SproutError::Io {
            operation: "inspect Android APK",
            source,
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(SproutError::PackagingRejected(
                "Android deployment must name exactly one raw APK file".into(),
            ));
        }
        if metadata.len() == 0 || metadata.len() > self.limits.max_apk_bytes {
            return Err(SproutError::PackagingRejected(format!(
                "APK is {} bytes; limit is {}",
                metadata.len(),
                self.limits.max_apk_bytes
            )));
        }
        let file = File::open(path).map_err(|source| SproutError::Io {
            operation: "open Android APK",
            source,
        })?;
        let mut archive = ZipArchive::new(file).map_err(|error| {
            SproutError::PackagingRejected(format!("APK is not a valid ZIP: {error}"))
        })?;
        let mut has_manifest = false;
        for index in 0..archive.len() {
            let entry = archive.by_index(index).map_err(|error| {
                SproutError::PackagingRejected(format!("could not inspect APK entry: {error}"))
            })?;
            let Some(enclosed) = entry.enclosed_name() else {
                return Err(SproutError::PackagingRejected(format!(
                    "APK contains an unsafe path: {}",
                    entry.name()
                )));
            };
            let name = enclosed.to_string_lossy().replace('\\', "/");
            has_manifest |= name == "AndroidManifest.xml";
            let upper = name.to_ascii_uppercase();
            if upper.starts_with("META-INF/")
                && [".SF", ".RSA", ".DSA", ".EC"]
                    .iter()
                    .any(|suffix| upper.ends_with(suffix))
            {
                return Err(SproutError::PackagingRejected(
                    "APK is already signed; upload the raw unsigned build".into(),
                ));
            }
        }
        if !has_manifest {
            return Err(SproutError::PackagingRejected(
                "APK does not contain AndroidManifest.xml (a ZIP-wrapped directory is not a raw APK)"
                    .into(),
            ));
        }
        if contains_apk_signing_block(path)? {
            return Err(SproutError::PackagingRejected(
                "APK contains an APK Signing Block; upload the raw unsigned build".into(),
            ));
        }
        artifact_from_file(path, PackageKind::AndroidApk)
    }
}

fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    std::fs::create_dir_all(destination).map_err(|source| SproutError::Io {
        operation: "create preset staging tree",
        source,
    })?;
    for entry in WalkDir::new(source).follow_links(false).sort_by_file_name() {
        let entry = entry.map_err(|error| {
            SproutError::PackagingRejected(format!("could not stage deploy output: {error}"))
        })?;
        if entry.depth() == 0 {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|_| SproutError::PackagingRejected("staged entry escaped source".into()))?;
        archive_name(relative)?;
        let target = destination.join(relative);
        let metadata =
            std::fs::symlink_metadata(entry.path()).map_err(|source| SproutError::Io {
                operation: "inspect staged entry",
                source,
            })?;
        if metadata.is_dir() {
            std::fs::create_dir_all(&target).map_err(|source| SproutError::Io {
                operation: "create staged directory",
                source,
            })?;
        } else if metadata.file_type().is_symlink() {
            let link = std::fs::read_link(entry.path()).map_err(|source| SproutError::Io {
                operation: "read staged symlink",
                source,
            })?;
            validate_symlink(source, relative, &link)?;
            if target.exists() || std::fs::symlink_metadata(&target).is_ok() {
                std::fs::remove_file(&target).map_err(|source| SproutError::Io {
                    operation: "replace staged symlink",
                    source,
                })?;
            }
            create_symlink(entry.path(), &link, &target)?;
        } else if metadata.is_file() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|source| SproutError::Io {
                    operation: "create staged file parent",
                    source,
                })?;
            }
            std::fs::copy(entry.path(), &target).map_err(|source| SproutError::Io {
                operation: "copy staged file",
                source,
            })?;
            std::fs::set_permissions(&target, metadata.permissions()).map_err(|source| {
                SproutError::Io {
                    operation: "preserve staged permissions",
                    source,
                }
            })?;
        } else {
            return Err(SproutError::PackagingRejected(format!(
                "unsupported staged entry: {}",
                relative.display()
            )));
        }
    }
    Ok(())
}

fn copy_static_tree(source: &Path, destination: &Path) -> Result<()> {
    for entry in WalkDir::new(source).follow_links(false).sort_by_file_name() {
        let entry = entry.map_err(|error| {
            SproutError::PackagingRejected(format!("could not stage static assets: {error}"))
        })?;
        if entry.depth() == 0 || entry.file_type().is_dir() {
            continue;
        }
        let relative = entry.path().strip_prefix(source).map_err(|_| {
            SproutError::PackagingRejected("static asset escaped its source".into())
        })?;
        let target = destination.join(relative);
        if std::fs::symlink_metadata(&target).is_ok() {
            return Err(SproutError::PackagingRejected(format!(
                "static mappings collide at {}",
                target.display()
            )));
        }
    }
    copy_tree(source, destination)
}

fn static_prefix(prefix: &str) -> Result<PathBuf> {
    if prefix.is_empty() {
        return Ok(PathBuf::new());
    }
    let path = Path::new(prefix);
    if path.is_absolute() {
        return Err(SproutError::PackagingRejected(format!(
            "static prefix must be relative: {prefix}"
        )));
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(SproutError::PackagingRejected(format!(
                "static prefix must be normalized and may not contain '..': {prefix}"
            )));
        }
    }
    Ok(path.to_owned())
}

fn find_server_entry(root: &Path) -> Result<PathBuf> {
    for candidate in ["server.js", "index.js", "index.mjs", "dist/index.js"] {
        if root.join(candidate).is_file() {
            return Ok(PathBuf::from(candidate));
        }
    }
    let mut matches = Vec::new();
    for entry in WalkDir::new(root).follow_links(false).sort_by_file_name() {
        let entry = entry.map_err(|error| {
            SproutError::PackagingRejected(format!("could not find server entry: {error}"))
        })?;
        let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
        if entry.file_type().is_file()
            && entry.file_name() == "server.js"
            && !relative
                .components()
                .any(|part| part.as_os_str() == "node_modules")
        {
            matches.push(relative.to_owned());
        }
    }
    match matches.as_slice() {
        [entry] => Ok(entry.clone()),
        [] => Err(SproutError::PackagingRejected(
            "no server entry found; expected server.js, index.js, index.mjs, or dist/index.js"
                .into(),
        )),
        _ => Err(SproutError::PackagingRejected(format!(
            "found {} server.js files and cannot choose a server entry",
            matches.len()
        ))),
    }
}

fn next_app_root(standalone: &Path) -> Option<PathBuf> {
    if standalone.file_name()? != "standalone" || standalone.parent()?.file_name()? != ".next" {
        return None;
    }
    standalone.parent()?.parent().map(Path::to_owned)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(unix)]
fn create_symlink(_source: &Path, link: &Path, target: &Path) -> Result<()> {
    std::os::unix::fs::symlink(link, target).map_err(|source| SproutError::Io {
        operation: "create staged symlink",
        source,
    })
}

#[cfg(windows)]
fn create_symlink(source: &Path, link: &Path, target: &Path) -> Result<()> {
    let resolved = source.canonicalize().map_err(|source| SproutError::Io {
        operation: "resolve staged symlink target",
        source,
    })?;
    let result = if resolved.is_dir() {
        std::os::windows::fs::symlink_dir(link, target)
    } else {
        std::os::windows::fs::symlink_file(link, target)
    };
    result.map_err(|source| SproutError::Io {
        operation: "create staged symlink (enable Windows Developer Mode if permission is denied)",
        source,
    })
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).map_err(|source| {
        SproutError::Io {
            operation: "make preset entrypoint executable",
            source,
        }
    })
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<()> {
    Ok(())
}

fn archive_name(path: &Path) -> Result<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str().ok_or_else(|| {
                SproutError::PackagingRejected(format!(
                    "package path is not UTF-8: {}",
                    path.display()
                ))
            })?),
            _ => {
                return Err(SproutError::PackagingRejected(format!(
                    "package path is not normalized: {}",
                    path.display()
                )));
            }
        }
    }
    Ok(parts.join("/"))
}

fn validate_symlink(root: &Path, relative: &Path, target: &Path) -> Result<()> {
    if target.is_absolute() {
        return Err(SproutError::PackagingRejected(format!(
            "symlink {} has an absolute target",
            relative.display()
        )));
    }
    let parent = relative.parent().unwrap_or(Path::new(""));
    let resolved = root.join(parent).join(target).canonicalize().map_err(|_| {
        SproutError::PackagingRejected(format!(
            "symlink {} has a missing or unreadable target",
            relative.display()
        ))
    })?;
    if !resolved.starts_with(root) {
        return Err(SproutError::PackagingRejected(format!(
            "symlink {} escapes the package root",
            relative.display()
        )));
    }
    Ok(())
}

fn artifact_from_file(path: &Path, kind: PackageKind) -> Result<PackagedArtifact> {
    let mut file = File::open(path).map_err(|source| SproutError::Io {
        operation: "open packaged artifact",
        source,
    })?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash).map_err(|source| SproutError::Io {
        operation: "hash packaged artifact",
        source,
    })?;
    let size = file.stream_position().map_err(|source| SproutError::Io {
        operation: "measure packaged artifact",
        source,
    })?;
    Ok(PackagedArtifact {
        path: path.to_owned(),
        kind,
        digest: format!("sha256:{}", hex::encode(hash.finalize())).parse()?,
        size,
    })
}

fn contains_apk_signing_block(path: &Path) -> Result<bool> {
    const MAGIC: &[u8] = b"APK Sig Block 42";
    let mut file = File::open(path).map_err(|source| SproutError::Io {
        operation: "scan APK signatures",
        source,
    })?;
    let mut overlap = Vec::new();
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut chunk).map_err(|source| SproutError::Io {
            operation: "scan APK signatures",
            source,
        })?;
        if count == 0 {
            return Ok(false);
        }
        overlap.extend_from_slice(&chunk[..count]);
        if overlap.windows(MAGIC.len()).any(|window| window == MAGIC) {
            return Ok(true);
        }
        if overlap.len() >= MAGIC.len() {
            overlap.drain(..overlap.len() - (MAGIC.len() - 1));
        }
    }
}

fn zip_error(error: zip::result::ZipError) -> SproutError {
    SproutError::PackagingRejected(format!("could not create deterministic ZIP: {error}"))
}

#[cfg(unix)]
fn executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable(_metadata: &std::fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Write as _};

    use tempfile::tempdir;
    use zip::{ZipWriter, write::SimpleFileOptions};

    use super::{ArtifactPackager, PackageKind, PackagingLimits};

    #[test]
    fn zip_is_reproducible_across_mtime_and_creation_order() {
        let root = tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        fs::write(first.join("b"), "two").unwrap();
        fs::write(first.join("a"), "one").unwrap();
        fs::write(second.join("a"), "one").unwrap();
        fs::write(second.join("b"), "two").unwrap();
        let packager = ArtifactPackager::new(PackagingLimits::default());
        let a = packager
            .package_zip(&first, &root.path().join("a.zip"), PackageKind::SiteZip)
            .unwrap();
        let b = packager
            .package_zip(&second, &root.path().join("b.zip"), PackageKind::SiteZip)
            .unwrap();
        assert_eq!(a.digest, b.digest);
        assert_eq!(fs::read(a.path).unwrap(), fs::read(b.path).unwrap());
    }

    fn apk(path: &std::path::Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        for (name, bytes) in entries {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn raw_unsigned_apk_is_accepted() {
        let root = tempdir().unwrap();
        let path = root.path().join("app.apk");
        apk(
            &path,
            &[
                ("AndroidManifest.xml", b"manifest"),
                ("classes.dex", b"dex"),
            ],
        );
        let artifact = ArtifactPackager::new(PackagingLimits::default())
            .validate_apk(&path)
            .unwrap();
        assert_eq!(artifact.kind, PackageKind::AndroidApk);
    }

    #[test]
    fn zip_wrapped_apk_and_signed_apk_are_rejected() {
        let root = tempdir().unwrap();
        let wrapped = root.path().join("wrapped.zip");
        apk(&wrapped, &[("app-release.apk", b"not raw")]);
        let signed = root.path().join("signed.apk");
        apk(
            &signed,
            &[
                ("AndroidManifest.xml", b"manifest"),
                ("META-INF/CERT.RSA", b"signature"),
            ],
        );
        let packager = ArtifactPackager::new(PackagingLimits::default());
        assert!(packager.validate_apk(&wrapped).is_err());
        assert!(packager.validate_apk(&signed).is_err());
    }

    #[test]
    fn directory_is_not_an_apk() {
        let root = tempdir().unwrap();
        assert!(
            ArtifactPackager::new(PackagingLimits::default())
                .validate_apk(root.path())
                .is_err()
        );
    }

    #[test]
    fn legacy_android_directory_requires_exactly_one_apk() {
        let root = tempdir().unwrap();
        apk(
            &root.path().join("one.apk"),
            &[("AndroidManifest.xml", b"manifest")],
        );
        let packager = ArtifactPackager::new(PackagingLimits::default());
        assert!(packager.package_apk_input(root.path()).is_ok());
        apk(
            &root.path().join("two.apk"),
            &[("AndroidManifest.xml", b"manifest")],
        );
        assert!(packager.package_apk_input(root.path()).is_err());
    }

    #[test]
    fn next_preparation_is_staged_and_includes_entrypoint_and_assets() {
        let root = tempdir().unwrap();
        let standalone = root.path().join("app/.next/standalone");
        fs::create_dir_all(&standalone).unwrap();
        fs::write(standalone.join("server.js"), "server").unwrap();
        fs::create_dir_all(root.path().join("app/.next/static")).unwrap();
        fs::write(root.path().join("app/.next/static/chunk.js"), "chunk").unwrap();
        fs::create_dir_all(root.path().join("app/public")).unwrap();
        fs::write(root.path().join("app/public/icon.svg"), "icon").unwrap();
        let output = root.path().join("next.zip");
        ArtifactPackager::new(PackagingLimits::default())
            .package_deploy_directory(&standalone, &output, PackageKind::BuildZip, "next")
            .unwrap();
        assert!(!standalone.join("run.sh").exists());
        let file = fs::File::open(output).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        assert!(zip.by_name("run.sh").is_ok());
        assert!(zip.by_name(".next/static/chunk.js").is_ok());
        assert!(zip.by_name("public/icon.svg").is_ok());
    }

    #[test]
    fn web_preparation_requires_run_script_and_adds_custom_runtime_bridge() {
        let root = tempdir().unwrap();
        let web = root.path().join("web");
        fs::create_dir(&web).unwrap();
        fs::write(web.join("run.sh"), "#!/bin/sh\nexec ./server\n").unwrap();
        fs::write(web.join("server"), "binary").unwrap();
        let output = root.path().join("web.zip");
        ArtifactPackager::new(PackagingLimits::default())
            .package_deploy_directory(&web, &output, PackageKind::BuildZip, "web")
            .unwrap();
        assert!(!web.join("bootstrap").exists());
        let file = fs::File::open(output).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        assert!(zip.by_name("run.sh").is_ok());
        assert!(zip.by_name("bootstrap").is_ok());

        let missing = root.path().join("missing");
        fs::create_dir(&missing).unwrap();
        assert!(
            ArtifactPackager::new(PackagingLimits::default())
                .package_deploy_directory(
                    &missing,
                    &root.path().join("missing.zip"),
                    PackageKind::BuildZip,
                    "web",
                )
                .is_err()
        );
    }

    #[test]
    fn static_paths_are_mapped_to_url_prefixes() {
        let root = tempdir().unwrap();
        let public = root.path().join("public");
        let next = root.path().join("next-static");
        fs::create_dir(&public).unwrap();
        fs::create_dir(&next).unwrap();
        fs::write(public.join("icon.svg"), "icon").unwrap();
        fs::write(next.join("chunk.js"), "chunk").unwrap();
        let output = root.path().join("static.zip");
        ArtifactPackager::new(PackagingLimits::default())
            .package_static_paths(
                &[
                    super::StaticPath {
                        source: public,
                        prefix: String::new(),
                    },
                    super::StaticPath {
                        source: next,
                        prefix: "_next/static".into(),
                    },
                ],
                &output,
            )
            .unwrap();
        let mut zip = zip::ZipArchive::new(fs::File::open(output).unwrap()).unwrap();
        assert!(zip.by_name("icon.svg").is_ok());
        assert!(zip.by_name("_next/static/chunk.js").is_ok());
    }
}
