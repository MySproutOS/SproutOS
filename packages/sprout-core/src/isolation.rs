//! Fail-closed native isolation for verified deployment-template plugins.
//!
//! A platform is supported only when this module can enforce the complete
//! boundary. There is deliberately no "best effort" fallback.

use std::path::Path;

#[cfg(unix)]
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
    #[cfg(target_os = "macos")]
    MacOs {
        sandbox_exec: PathBuf,
        home: PathBuf,
    },
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
        #[cfg(target_os = "macos")]
        {
            let sandbox_exec =
                find_trusted_tool(&[Path::new("/usr/bin/sandbox-exec")], "sandbox-exec")?;
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .and_then(|path| path.canonicalize().ok())
                .ok_or_else(|| {
                    SproutError::IsolationUnavailable(
                        "the caller home directory could not be resolved for credential denial"
                            .into(),
                    )
                })?;
            Ok(Self {
                backend: Backend::MacOs { sandbox_exec, home },
            })
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
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

        match &self.backend {
            #[cfg(target_os = "linux")]
            Backend::Linux { bubblewrap } => linux_command(bubblewrap, &executable, &workspace),
            #[cfg(target_os = "macos")]
            Backend::MacOs { sandbox_exec, home } => {
                macos_command(sandbox_exec, home, &executable, &workspace)
            }
        }
    }
}

#[cfg(unix)]
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
        "--unshare-pid",
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

#[cfg(target_os = "macos")]
fn macos_command(
    sandbox_exec: &Path,
    home: &Path,
    executable: &Path,
    workspace: &Path,
) -> Result<Command> {
    let profile = macos_profile(home, executable, workspace)?;
    let mut command = Command::new(sandbox_exec);
    command.arg("-p").arg(profile).arg(executable);
    Ok(command)
}

#[cfg(target_os = "macos")]
fn macos_profile(home: &Path, executable: &Path, workspace: &Path) -> Result<String> {
    let executable = seatbelt_path(executable)?;
    let workspace = seatbelt_path(workspace)?;
    let git = workspace_path(workspace.as_str(), ".git");
    let mut rules = vec![
        "(version 1)".to_owned(),
        "(allow default)".to_owned(),
        "(deny network*)".to_owned(),
        "(deny process-fork)".to_owned(),
        "(deny file-write*)".to_owned(),
        format!("(allow file-read* (literal \"{executable}\"))"),
        format!("(allow file-read* (subpath \"{workspace}\"))"),
        format!("(allow file-write* (subpath \"{workspace}\"))"),
        format!("(deny file-write* (subpath \"{git}\"))"),
        // Keep plugins away from the login Keychain service as well as credential files.
        "(deny mach-lookup (global-name \"com.apple.securityd\"))".to_owned(),
        "(deny mach-lookup (global-name \"com.apple.securityd.xpc\"))".to_owned(),
    ];
    let home = seatbelt_path(home)?;
    rules.insert(4, format!("(deny file-read* (subpath \"{home}\"))"));
    Ok(rules.join("\n"))
}

#[cfg(target_os = "macos")]
fn seatbelt_path(path: &Path) -> Result<String> {
    let text = path.to_str().ok_or_else(|| {
        SproutError::IsolationUnavailable("sandbox paths must be valid UTF-8".into())
    })?;
    if text.contains(['\0', '\n', '\r']) {
        return Err(SproutError::IsolationUnavailable(
            "sandbox path contains control characters".into(),
        ));
    }
    Ok(text.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(target_os = "macos")]
fn workspace_path(workspace: &str, child: &str) -> String {
    format!("{}/{child}", workspace.trim_end_matches('/'))
}

#[cfg(test)]
mod tests {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    use std::{fs, os::unix::fs::PermissionsExt};

    #[cfg(target_os = "macos")]
    use tempfile::tempdir;

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    use super::*;

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
        assert!(args.iter().any(|arg| arg == "--unshare-pid"));
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

    #[cfg(target_os = "macos")]
    #[test]
    fn seatbelt_paths_are_escaped_as_data() {
        let path = Path::new("/tmp/a\") (allow default)\n(allow network*)\n;");
        let error = seatbelt_path(path).unwrap_err();
        assert!(matches!(error, SproutError::IsolationUnavailable(_)));

        let escaped = seatbelt_path(Path::new("/tmp/a\") (allow network*)")).unwrap();
        assert_eq!(escaped, "/tmp/a\\\") (allow network*)");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn profile_keeps_executable_and_workspace_specific() {
        let profile = macos_profile(
            Path::new("/Users/person"),
            Path::new("/private/tmp/plugin"),
            Path::new("/private/tmp/work"),
        )
        .unwrap();
        assert!(profile.contains("(deny network*)"));
        assert!(profile.contains("(deny process-fork)"));
        assert!(profile.contains("(deny file-read* (subpath \"/Users/person\"))"));
        assert!(profile.contains("/private/tmp/work/.git"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn native_provider_enforces_workspace_and_git_write_boundary() {
        let root = tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let outside = root.path().join("outside");
        let plugin = root.path().join("plugin");
        fs::write(
            &plugin,
            format!(
                "#!/bin/sh\nprintf allowed > allowed\nprintf denied > '{}'\nprintf denied > .git/denied\n",
                outside.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&plugin, fs::Permissions::from_mode(0o700)).unwrap();
        let executable = VerifiedExecutable::for_test(plugin);
        let provider = NativeIsolationProvider::detect().unwrap();
        let mut command = provider.command(&executable, &workspace).unwrap();
        command.current_dir(&workspace);
        let output = command.output().await.unwrap();

        assert!(!output.status.success());
        assert_eq!(fs::read(workspace.join("allowed")).unwrap(), b"allowed");
        assert!(!outside.exists());
        assert!(!workspace.join(".git/denied").exists());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn seatbelt_denies_loopback_network() {
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let workspace = tempdir().unwrap();
        let sandbox_exec =
            find_trusted_tool(&[Path::new("/usr/bin/sandbox-exec")], "sandbox-exec").unwrap();
        let netcat = Path::new("/usr/bin/nc").canonicalize().unwrap();
        let home = tempdir().unwrap();
        let profile = macos_profile(home.path(), &netcat, workspace.path()).unwrap();
        let status = Command::new(sandbox_exec)
            .arg("-p")
            .arg(profile)
            .arg(netcat)
            .args([
                "-z",
                "-w",
                "1",
                &address.ip().to_string(),
                &address.port().to_string(),
            ])
            .status()
            .await
            .unwrap();
        assert!(!status.success());
        assert!(listener.accept().is_err());
    }
}
