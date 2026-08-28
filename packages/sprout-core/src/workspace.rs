use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use walkdir::WalkDir;

use crate::{Result, SproutError};

#[derive(Clone, Copy, Debug)]
pub struct DiffLimits {
    pub max_workspace_files: usize,
    pub max_workspace_bytes: u64,
    pub max_changed_files: usize,
    pub max_changed_bytes: u64,
    pub max_file_bytes: u64,
}

impl Default for DiffLimits {
    fn default() -> Self {
        Self {
            max_workspace_files: 200_000,
            max_workspace_bytes: 4 * 1024 * 1024 * 1024,
            max_changed_files: 10_000,
            max_changed_bytes: 512 * 1024 * 1024,
            max_file_bytes: 128 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Create,
    Modify,
    Delete,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DeclaredChange {
    pub path: String,
    pub kind: ChangeKind,
    pub before_sha256: Option<String>,
    pub after_sha256: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct WorkspaceChange {
    pub path: String,
    pub kind: ChangeKind,
    pub size: u64,
    pub before_sha256: Option<String>,
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum EntryKind {
    File,
    Symlink,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct EntryState {
    kind: EntryKind,
    size: u64,
    digest: String,
    executable: bool,
    hard_link_count: u64,
}

pub(crate) struct WorkspaceSnapshot {
    entries: BTreeMap<String, EntryState>,
}

impl WorkspaceSnapshot {
    pub(crate) fn capture(root: &Path, limits: DiffLimits) -> Result<Self> {
        let metadata = std::fs::symlink_metadata(root).map_err(|source| SproutError::Io {
            operation: "inspect template workspace",
            source,
        })?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(SproutError::WorkspaceRejected {
                path: root.to_owned(),
                reason: "workspace root must be a real directory".into(),
            });
        }

        let mut entries = BTreeMap::new();
        let mut total_bytes = 0_u64;
        for entry in WalkDir::new(root).follow_links(false).sort_by_file_name() {
            let entry = entry.map_err(|error| SproutError::WorkspaceRejected {
                path: error.path().unwrap_or(root).to_owned(),
                reason: error.to_string(),
            })?;
            if entry.depth() == 0 || entry.file_type().is_dir() {
                continue;
            }
            let relative =
                entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|_| SproutError::WorkspaceRejected {
                        path: entry.path().to_owned(),
                        reason: "entry escaped workspace root".into(),
                    })?;
            let normalized = normalize_relative_path(relative)?;
            let metadata =
                std::fs::symlink_metadata(entry.path()).map_err(|source| SproutError::Io {
                    operation: "inspect workspace entry",
                    source,
                })?;
            let (kind, bytes) = if metadata.file_type().is_symlink() {
                let target =
                    std::fs::read_link(entry.path()).map_err(|source| SproutError::Io {
                        operation: "read workspace symlink",
                        source,
                    })?;
                (
                    EntryKind::Symlink,
                    target.as_os_str().as_encoded_bytes().to_vec(),
                )
            } else if metadata.is_file() {
                if metadata.len() > limits.max_file_bytes {
                    return Err(SproutError::WorkspaceRejected {
                        path: relative.to_owned(),
                        reason: format!(
                            "file is {} bytes; per-file limit is {}",
                            metadata.len(),
                            limits.max_file_bytes
                        ),
                    });
                }
                let bytes = std::fs::read(entry.path()).map_err(|source| SproutError::Io {
                    operation: "hash workspace file",
                    source,
                })?;
                (EntryKind::File, bytes)
            } else {
                return Err(SproutError::WorkspaceRejected {
                    path: relative.to_owned(),
                    reason: "only regular files, directories, and symlinks are allowed".into(),
                });
            };
            total_bytes = total_bytes.saturating_add(bytes.len() as u64);
            if total_bytes > limits.max_workspace_bytes {
                return Err(SproutError::WorkspaceRejected {
                    path: root.to_owned(),
                    reason: format!(
                        "workspace exceeds {} scanned bytes",
                        limits.max_workspace_bytes
                    ),
                });
            }
            if entries.len() >= limits.max_workspace_files {
                return Err(SproutError::WorkspaceRejected {
                    path: root.to_owned(),
                    reason: format!("workspace exceeds {} entries", limits.max_workspace_files),
                });
            }
            entries.insert(
                normalized,
                EntryState {
                    kind,
                    size: bytes.len() as u64,
                    digest: hex::encode(Sha256::digest(&bytes)),
                    executable: is_executable(&metadata),
                    hard_link_count: hard_link_count(&metadata),
                },
            );
        }
        Ok(Self { entries })
    }

    /// Rejects files whose inode is also reachable outside the workspace before plugin execution.
    /// Post-execution diff validation is too late: mutating a pre-existing hardlink has already
    /// changed its external peer. `.git` is excluded because the isolation provider mounts it
    /// read-only and local clones may legitimately hardlink object storage.
    pub(crate) fn reject_preexisting_hard_links(&self) -> Result<()> {
        if let Some((path, _)) = self.entries.iter().find(|(path, entry)| {
            entry.kind == EntryKind::File
                && entry.hard_link_count > 1
                && path.as_str() != ".git"
                && !path.starts_with(".git/")
        }) {
            return Err(SproutError::WorkspaceRejected {
                path: PathBuf::from(path),
                reason: "pre-existing hard-linked files cannot be exposed to a template plugin"
                    .into(),
            });
        }
        Ok(())
    }

    pub(crate) fn validate_diff(
        &self,
        after: &Self,
        declared: &[DeclaredChange],
        limits: DiffLimits,
    ) -> Result<Vec<WorkspaceChange>> {
        let paths: BTreeSet<_> = self
            .entries
            .keys()
            .chain(after.entries.keys())
            .cloned()
            .collect();
        let mut actual = BTreeMap::new();
        let mut changed_bytes = 0_u64;
        for path in paths {
            let before = self.entries.get(&path);
            let after = after.entries.get(&path);
            let kind = match (before, after) {
                (None, Some(_)) => ChangeKind::Create,
                (Some(_), None) => ChangeKind::Delete,
                (Some(before), Some(after)) if before != after => ChangeKind::Modify,
                _ => continue,
            };
            if path == ".git" || path.starts_with(".git/") {
                return Err(SproutError::WorkspaceRejected {
                    path: PathBuf::from(path),
                    reason: "template plugins may not modify Git metadata".into(),
                });
            }
            if after.is_some_and(|entry| entry.kind == EntryKind::Symlink) && before != after {
                return Err(SproutError::WorkspaceRejected {
                    path: PathBuf::from(path),
                    reason: "template plugins may not create or modify symlinks".into(),
                });
            }
            if after.is_some_and(|entry| entry.kind == EntryKind::File && entry.hard_link_count > 1)
                && before != after
            {
                return Err(SproutError::WorkspaceRejected {
                    path: PathBuf::from(path),
                    reason: "template plugins may not create or modify hard-linked files".into(),
                });
            }
            let size = after.map_or(0, |entry| entry.size);
            changed_bytes = changed_bytes.saturating_add(size);
            actual.insert(
                path.clone(),
                WorkspaceChange {
                    path,
                    kind,
                    size,
                    before_sha256: before.map(|entry| format!("sha256:{}", entry.digest)),
                    sha256: after.map(|entry| format!("sha256:{}", entry.digest)),
                },
            );
        }
        if actual.len() > limits.max_changed_files {
            return Err(SproutError::WorkspaceRejected {
                path: PathBuf::new(),
                reason: format!(
                    "plugin changed {} files; limit is {}",
                    actual.len(),
                    limits.max_changed_files
                ),
            });
        }
        if changed_bytes > limits.max_changed_bytes {
            return Err(SproutError::WorkspaceRejected {
                path: PathBuf::new(),
                reason: format!(
                    "plugin produced {changed_bytes} changed bytes; limit is {}",
                    limits.max_changed_bytes
                ),
            });
        }

        let mut expected = BTreeMap::new();
        for change in declared {
            let path = normalize_relative_path(Path::new(&change.path))?;
            if path == ".git" || path.starts_with(".git/") {
                return Err(SproutError::DiffMismatch(
                    "plugin declared a change to Git metadata".into(),
                ));
            }
            validate_declared_digests(change)?;
            if expected
                .insert(
                    path.clone(),
                    (
                        change.kind,
                        change.before_sha256.clone(),
                        change.after_sha256.clone(),
                    ),
                )
                .is_some()
            {
                return Err(SproutError::DiffMismatch(format!(
                    "plugin declared {path} more than once"
                )));
            }
        }
        let actual_kinds: BTreeMap<_, _> = actual
            .iter()
            .map(|(path, change)| {
                (
                    path.clone(),
                    (
                        change.kind,
                        change.before_sha256.clone(),
                        change.sha256.clone(),
                    ),
                )
            })
            .collect();
        if expected != actual_kinds {
            let missing: Vec<_> = actual_kinds
                .iter()
                .filter(|(path, kind)| expected.get(*path) != Some(kind))
                .map(|(path, (kind, _, _))| format!("{kind:?} {path}"))
                .collect();
            let extra: Vec<_> = expected
                .iter()
                .filter(|(path, kind)| actual_kinds.get(*path) != Some(kind))
                .map(|(path, (kind, _, _))| format!("{kind:?} {path}"))
                .collect();
            return Err(SproutError::DiffMismatch(format!(
                "unreported or mismatched changes: [{}]; declared but absent: [{}]",
                missing.join(", "),
                extra.join(", ")
            )));
        }
        Ok(actual.into_values().collect())
    }
}

fn validate_declared_digests(change: &DeclaredChange) -> Result<()> {
    let valid = match change.kind {
        ChangeKind::Create => change.before_sha256.is_none() && change.after_sha256.is_some(),
        ChangeKind::Modify => change.before_sha256.is_some() && change.after_sha256.is_some(),
        ChangeKind::Delete => change.before_sha256.is_some() && change.after_sha256.is_none(),
    };
    if !valid {
        return Err(SproutError::DiffMismatch(format!(
            "declared {:?} digests are incomplete for {}",
            change.kind, change.path
        )));
    }
    for digest in [
        change.before_sha256.as_deref(),
        change.after_sha256.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        digest.parse::<crate::Sha256Digest>().map_err(|_| {
            SproutError::DiffMismatch(format!(
                "declared digest is not canonical for {}",
                change.path
            ))
        })?;
    }
    Ok(())
}

fn normalize_relative_path(path: &Path) -> Result<String> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(SproutError::DiffMismatch(format!(
            "path must be non-empty and relative: {}",
            path.display()
        )));
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            _ => {
                return Err(SproutError::DiffMismatch(format!(
                    "path is not normalized: {}",
                    path.display()
                )));
            }
        }
    }
    Ok(parts.join("/"))
}

#[cfg(unix)]
fn is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(unix)]
fn hard_link_count(metadata: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.nlink()
}

#[cfg(not(unix))]
fn is_executable(_metadata: &std::fs::Metadata) -> bool {
    false
}

#[cfg(not(unix))]
fn hard_link_count(_metadata: &std::fs::Metadata) -> u64 {
    1
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::{ChangeKind, DeclaredChange, DiffLimits, WorkspaceSnapshot};

    fn sha(bytes: &[u8]) -> String {
        crate::Sha256Digest::from_bytes(bytes).to_string()
    }

    #[test]
    fn exact_declared_diff_is_accepted() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("existing"), "before").unwrap();
        let before = WorkspaceSnapshot::capture(root.path(), DiffLimits::default()).unwrap();
        fs::write(root.path().join("existing"), "after").unwrap();
        fs::write(root.path().join("new"), "created").unwrap();
        let after = WorkspaceSnapshot::capture(root.path(), DiffLimits::default()).unwrap();
        let changes = before
            .validate_diff(
                &after,
                &[
                    DeclaredChange {
                        path: "new".into(),
                        kind: ChangeKind::Create,
                        before_sha256: None,
                        after_sha256: Some(sha(b"created")),
                    },
                    DeclaredChange {
                        path: "existing".into(),
                        kind: ChangeKind::Modify,
                        before_sha256: Some(sha(b"before")),
                        after_sha256: Some(sha(b"after")),
                    },
                ],
                DiffLimits::default(),
            )
            .unwrap();
        assert_eq!(changes.len(), 2);
    }

    #[test]
    fn undeclared_change_is_rejected() {
        let root = tempdir().unwrap();
        let before = WorkspaceSnapshot::capture(root.path(), DiffLimits::default()).unwrap();
        fs::write(root.path().join("surprise"), "bad").unwrap();
        let after = WorkspaceSnapshot::capture(root.path(), DiffLimits::default()).unwrap();
        assert!(
            before
                .validate_diff(&after, &[], DiffLimits::default())
                .is_err()
        );
    }

    #[test]
    fn declared_digest_must_match_the_actual_bytes() {
        let root = tempdir().unwrap();
        let before = WorkspaceSnapshot::capture(root.path(), DiffLimits::default()).unwrap();
        fs::write(root.path().join("file"), "actual").unwrap();
        let after = WorkspaceSnapshot::capture(root.path(), DiffLimits::default()).unwrap();
        assert!(
            before
                .validate_diff(
                    &after,
                    &[DeclaredChange {
                        path: "file".into(),
                        kind: ChangeKind::Create,
                        before_sha256: None,
                        after_sha256: Some(sha(b"claimed")),
                    }],
                    DiffLimits::default(),
                )
                .is_err()
        );
    }

    #[test]
    fn traversal_declaration_is_rejected() {
        let root = tempdir().unwrap();
        let snapshot = WorkspaceSnapshot::capture(root.path(), DiffLimits::default()).unwrap();
        assert!(
            snapshot
                .validate_diff(
                    &snapshot,
                    &[DeclaredChange {
                        path: "../outside".into(),
                        kind: ChangeKind::Create,
                        before_sha256: None,
                        after_sha256: Some(sha(b"irrelevant")),
                    }],
                    DiffLimits::default(),
                )
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn new_symlink_is_rejected_even_when_declared() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let before = WorkspaceSnapshot::capture(root.path(), DiffLimits::default()).unwrap();
        symlink("target", root.path().join("link")).unwrap();
        let after = WorkspaceSnapshot::capture(root.path(), DiffLimits::default()).unwrap();
        assert!(
            before
                .validate_diff(
                    &after,
                    &[DeclaredChange {
                        path: "link".into(),
                        kind: ChangeKind::Create,
                        before_sha256: None,
                        after_sha256: Some(sha(b"target")),
                    }],
                    DiffLimits::default(),
                )
                .is_err()
        );
    }

    #[test]
    fn git_metadata_change_is_rejected() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::write(root.path().join(".git/config"), "before").unwrap();
        let before = WorkspaceSnapshot::capture(root.path(), DiffLimits::default()).unwrap();
        fs::write(root.path().join(".git/config"), "after").unwrap();
        let after = WorkspaceSnapshot::capture(root.path(), DiffLimits::default()).unwrap();
        assert!(
            before
                .validate_diff(&after, &[], DiffLimits::default())
                .is_err()
        );
    }
}
