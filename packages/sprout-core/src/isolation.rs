//! Fail-closed native isolation for verified deployment-template plugins.
//!
//! A platform is supported only when this module can enforce the complete
//! boundary. There is deliberately no "best effort" fallback.

use std::path::Path;

#[cfg(target_os = "linux")]
use std::{fs, path::PathBuf};

use tokio::process::Command;

use crate::{IsolationProvider, Result, SproutError, VerifiedExecutable};

/// The production isolation provider for the current operating system.
#[derive(Clone, Debug)]
pub struct NativeIsolationProvider {
    backend: Backend,
}

#[derive(Clone, Debug)]
enum Backend {
    #[cfg(target_os = "linux")]
    Linux { bubblewrap: PathBuf },
}

impl NativeIsolationProvider {
    /// Detects an enforceable provider. Unsupported or incompletely configured
    /// hosts return `IsolationUnavailable`; they never run a plugin directly.
    pub fn detect() -> Result<Self> {
        #[cfg(target_os = "linux")]
        {
            let bubblewrap = find_trusted_tool(
                &[Path::new("/usr/bin/bwrap"), Path::new("/bin/bwrap")],
                "bubblewrap",
            )?;
            Ok(Self {
                backend: Backend::Linux { bubblewrap },
            })
        }
        #[cfg(not(target_os = "linux"))]
        {
            Err(SproutError::IsolationUnavailable(format!(
                "native plugin isolation is not implemented for {}",
                std::env::consts::OS
            )))
        }
    }
}

impl IsolationProvider for NativeIsolationProvider {
    fn command(&self, executable: &VerifiedExecutable, workspace: &Path) -> Result<Command> {
        let executable = executable.path().canonicalize().map_err(|error| {
            SproutError::IsolationUnavailable(format!(
                "verified plugin path could not be resolved: {error}"
            ))
        })?;
        let workspace = workspace.canonicalize().map_err(|error| {
            SproutError::IsolationUnavailable(format!(
                "plugin workspace could not be resolved: {error}"
            ))
        })?;
        if !workspace.is_dir() {
            return Err(SproutError::IsolationUnavailable(
                "plugin workspace is not a directory".into(),
            ));
        }
        #[cfg(not(target_os = "linux"))]
        let _ = (&executable, &workspace);

        match &self.backend {
            #[cfg(target_os = "linux")]
            Backend::Linux { bubblewrap } => linux_command(bubblewrap, &executable, &workspace),
            #[cfg(not(target_os = "linux"))]
            _ => Err(SproutError::IsolationUnavailable(format!(
                "native plugin isolation is not implemented for {}",
                std::env::consts::OS
            ))),
        }
    }
}

#[cfg(target_os = "linux")]
fn find_trusted_tool(candidates: &[&Path], name: &str) -> Result<PathBuf> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    for candidate in candidates {
        let Ok(path) = candidate.canonicalize() else {
            continue;
        };
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let mode = metadata.permissions().mode();
        if metadata.is_file() && metadata.uid() == 0 && mode & 0o022 == 0 {
            return Ok(path);
        }
    }
    Err(SproutError::IsolationUnavailable(format!(
        "trusted {name} executable was not found at an approved system path"
    )))
}

#[cfg(target_os = "linux")]
fn linux_command(bubblewrap: &Path, executable: &Path, workspace: &Path) -> Result<Command> {
    ensure_static_elf(executable)?;
    let mut command = Command::new(bubblewrap);
    command.args([
        "--die-with-parent",
        "--new-session",
        "--unshare-all",
        "--unshare-user",
        "--unshare-pid",
        "--disable-userns",
        "--assert-userns-disabled",
        "--cap-drop",
        "ALL",
        "--clearenv",
        "--setenv",
        "LANG",
        "C",
        "--setenv",
        "LC_ALL",
        "C",
        "--tmpfs",
        "/",
        "--dir",
        "/dev",
        "--dev-bind",
        "/dev/null",
        "/dev/null",
        "--ro-bind",
    ]);
    command.arg(executable).arg("/plugin");
    command.arg("--bind").arg(workspace).arg("/workspace");
    let git = workspace.join(".git");
    if git.exists() {
        command.arg("--ro-bind").arg(&git).arg("/workspace/.git");
    }
    command.args([
        "--remount-ro",
        "/",
        "--chdir",
        "/workspace",
        "--",
        "/plugin",
    ]);
    Ok(command)
}

#[cfg(target_os = "linux")]
fn ensure_static_elf(executable: &Path) -> Result<()> {
    use std::io::Read;

    let file = fs::File::open(executable).map_err(|error| {
        SproutError::IsolationUnavailable(format!("verified plugin could not be opened: {error}"))
    })?;
    let mut bytes = Vec::new();
    file.take(1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            SproutError::IsolationUnavailable(format!(
                "verified plugin header could not be read: {error}"
            ))
        })?;
    if bytes.get(..4) != Some(b"\x7fELF") {
        return Err(SproutError::IsolationUnavailable(
            "Linux template plugins must be static ELF executables".into(),
        ));
    }
    let class = bytes.get(4).copied();
    let little = bytes.get(5) == Some(&1);
    if !little {
        return Err(SproutError::IsolationUnavailable(
            "only little-endian ELF plugins are supported".into(),
        ));
    }
    let (program_offset, entry_size, entry_count) = match class {
        Some(1) => (
            read_u32(&bytes, 28)? as usize,
            read_u16(&bytes, 42)? as usize,
            read_u16(&bytes, 44)? as usize,
        ),
        Some(2) => (
            read_u64(&bytes, 32)? as usize,
            read_u16(&bytes, 54)? as usize,
            read_u16(&bytes, 56)? as usize,
        ),
        _ => {
            return Err(SproutError::IsolationUnavailable(
                "unsupported ELF class".into(),
            ));
        }
    };
    if entry_size < 4 || entry_count > 4096 {
        return Err(SproutError::IsolationUnavailable(
            "invalid ELF program-header table".into(),
        ));
    }
    for index in 0..entry_count {
        let offset = program_offset
            .checked_add(index.checked_mul(entry_size).ok_or_else(|| {
                SproutError::IsolationUnavailable("invalid ELF program-header table".into())
            })?)
            .ok_or_else(|| {
                SproutError::IsolationUnavailable("invalid ELF program-header table".into())
            })?;
        if read_u32(&bytes, offset)? == 3 {
            // PT_INTERP
            return Err(SproutError::IsolationUnavailable(
                "Linux template plugins must be statically linked".into(),
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn read_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let raw: [u8; 2] = bytes
        .get(offset..offset + 2)
        .and_then(|value| value.try_into().ok())
        .ok_or_else(|| SproutError::IsolationUnavailable("truncated ELF header".into()))?;
    Ok(u16::from_le_bytes(raw))
}

#[cfg(target_os = "linux")]
fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let raw: [u8; 4] = bytes
        .get(offset..offset + 4)
        .and_then(|value| value.try_into().ok())
        .ok_or_else(|| SproutError::IsolationUnavailable("truncated ELF header".into()))?;
    Ok(u32::from_le_bytes(raw))
}

#[cfg(target_os = "linux")]
fn read_u64(bytes: &[u8], offset: usize) -> Result<u64> {
    let raw: [u8; 8] = bytes
        .get(offset..offset + 8)
        .and_then(|value| value.try_into().ok())
        .ok_or_else(|| SproutError::IsolationUnavailable("truncated ELF header".into()))?;
    Ok(u64::from_le_bytes(raw))
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    use std::fs;

    #[cfg(target_os = "linux")]
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn native_provider_is_explicitly_unsupported() {
        assert!(matches!(
            NativeIsolationProvider::detect(),
            Err(SproutError::IsolationUnavailable(_))
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn dynamic_and_truncated_elf_plugins_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let truncated = directory.path().join("truncated");
        fs::write(&truncated, b"\x7fELF\x02\x01").unwrap();
        fs::set_permissions(&truncated, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(
            ensure_static_elf(&truncated),
            Err(SproutError::IsolationUnavailable(_))
        ));

        let dynamic = directory.path().join("dynamic");
        let mut elf = vec![0_u8; 128];
        elf[..6].copy_from_slice(b"\x7fELF\x02\x01");
        elf[32..40].copy_from_slice(&64_u64.to_le_bytes());
        elf[54..56].copy_from_slice(&56_u16.to_le_bytes());
        elf[56..58].copy_from_slice(&1_u16.to_le_bytes());
        elf[64..68].copy_from_slice(&3_u32.to_le_bytes());
        fs::write(&dynamic, elf).unwrap();
        fs::set_permissions(&dynamic, fs::Permissions::from_mode(0o700)).unwrap();
        let error = ensure_static_elf(&dynamic).unwrap_err();
        assert!(error.to_string().contains("statically linked"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_command_uses_private_namespaces_and_minimal_mounts() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let plugin = directory.path().join("plugin");
        let mut elf = vec![0_u8; 64];
        elf[..6].copy_from_slice(b"\x7fELF\x02\x01");
        elf[54..56].copy_from_slice(&56_u16.to_le_bytes());
        fs::write(&plugin, elf).unwrap();
        fs::set_permissions(&plugin, fs::Permissions::from_mode(0o700)).unwrap();
        let executable = VerifiedExecutable::for_test(plugin);
        let provider = NativeIsolationProvider {
            backend: Backend::Linux {
                bubblewrap: PathBuf::from("/usr/bin/bwrap"),
            },
        };
        let command = provider.command(&executable, &workspace).unwrap();
        let args = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args.iter().any(|arg| arg == "--unshare-all"));
        assert!(args.iter().any(|arg| arg == "--unshare-user"));
        assert!(args.iter().any(|arg| arg == "--unshare-pid"));
        assert!(args.iter().any(|arg| arg == "--disable-userns"));
        assert!(args.iter().any(|arg| arg == "--assert-userns-disabled"));
        assert!(args.windows(2).any(|args| args == ["--cap-drop", "ALL"]));
        assert!(args.iter().any(|arg| arg == "--remount-ro"));
        assert!(args.iter().any(|arg| arg == "/dev/null"));
        assert!(args.iter().any(|arg| arg == "/workspace/.git"));
        assert!(!args.iter().any(|arg| arg == "--proc"));
        assert!(
            !args
                .iter()
                .any(|arg| arg == "/usr" || arg == "/etc" || arg == "/home")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_command_accepts_workspace_without_git_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let plugin = directory.path().join("plugin");
        let mut elf = vec![0_u8; 64];
        elf[..6].copy_from_slice(b"\x7fELF\x02\x01");
        elf[54..56].copy_from_slice(&56_u16.to_le_bytes());
        fs::write(&plugin, elf).unwrap();
        fs::set_permissions(&plugin, fs::Permissions::from_mode(0o700)).unwrap();
        let command = linux_command(Path::new("/usr/bin/bwrap"), &plugin, &workspace).unwrap();
        let args = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(!args.iter().any(|arg| arg == "/workspace/.git"));
    }

    /// Compile `tests/fixtures/linux_isolation_probe.c` as a static executable and set
    /// `SPROUT_CORE_LINUX_ISOLATION_PROBE` to run this inside a UID-0, capable Linux container.
    /// This is ignored in ordinary CI because its purpose is to prove that the exact root caller
    /// loses mount capability at the real Bubblewrap boundary.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "requires root, trusted bwrap, and a precompiled static probe"]
    async fn privileged_linux_provider_drops_root_capabilities() {
        assert_eq!(unsafe { libc::geteuid() }, 0, "probe must start as UID 0");
        let probe = std::env::var_os("SPROUT_CORE_LINUX_ISOLATION_PROBE")
            .map(PathBuf::from)
            .expect("SPROUT_CORE_LINUX_ISOLATION_PROBE is required");
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir(workspace.path().join(".git")).unwrap();
        let executable = VerifiedExecutable::for_test(probe);
        let provider = NativeIsolationProvider::detect().unwrap();
        let mut command = provider.command(&executable, workspace.path()).unwrap();
        command
            .env_clear()
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .current_dir(workspace.path());
        let output = command.output().await.unwrap();
        assert!(
            output.status.success(),
            "probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(workspace.path().join("allowed")).unwrap(), b"ok");
        assert!(!workspace.path().join(".git/denied").exists());
    }
}
