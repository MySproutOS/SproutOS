//! Fail-closed native isolation for verified deployment-template plugins.
//!
//! A platform is supported only when this module can enforce the complete
//! boundary. There is deliberately no "best effort" fallback.

use std::path::Path;

#[cfg(target_os = "macos")]
use std::path::PathBuf;

#[cfg(target_os = "linux")]
use std::{
    fs,
    io::{Seek, SeekFrom, Write},
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    path::PathBuf,
};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use tokio::process::Command;

use crate::{IsolatedCommand, IsolationProvider, Result, SproutError, VerifiedExecutable};

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
    MacOs { sandbox_exec: PathBuf },
    #[cfg(windows)]
    WindowsAppContainer,
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
            let sandbox_exec = PathBuf::from("/usr/bin/sandbox-exec");
            if !sandbox_exec.is_file() {
                return Err(SproutError::IsolationUnavailable(
                    "trusted macOS sandbox-exec was not found".into(),
                ));
            }
            Ok(Self {
                backend: Backend::MacOs { sandbox_exec },
            })
        }
        #[cfg(windows)]
        {
            Ok(Self {
                backend: Backend::WindowsAppContainer,
            })
        }
    }
}

impl IsolationProvider for NativeIsolationProvider {
    fn command(
        &self,
        executable: &VerifiedExecutable,
        workspace: &Path,
    ) -> Result<IsolatedCommand> {
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
            Backend::MacOs { sandbox_exec } => macos_command(sandbox_exec, &executable, &workspace),
            #[cfg(windows)]
            Backend::WindowsAppContainer => Ok(IsolatedCommand::appcontainer(
                crate::windows_isolation::WindowsAppContainerCommand::stage(
                    &executable,
                    &workspace,
                )?,
            )),
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_command(
    sandbox_exec: &Path,
    executable: &Path,
    workspace: &Path,
) -> Result<IsolatedCommand> {
    let quote = |path: &Path| {
        path.to_str()
            .ok_or_else(|| {
                SproutError::IsolationUnavailable("macOS sandbox paths must be UTF-8".into())
            })
            .map(|value| value.replace('\\', "\\\\").replace('"', "\\\""))
    };
    let executable_path = quote(executable)?;
    let plugin_directory = quote(executable.parent().ok_or_else(|| {
        SproutError::IsolationUnavailable("plugin has no parent directory".into())
    })?)?;
    let workspace = quote(workspace)?;
    let git = format!("{workspace}/.git");
    // Apple's system.sb is the OS-owned minimal runtime policy: dyld shared caches, libSystem,
    // required syscalls, read-metadata traversal, and an enumerated set of bootstrap services.
    // It does not grant home-directory reads. Our explicit deny keeps even its syslog socket from
    // becoming a network escape, and the only mutable tree is the selected workspace minus .git.
    let profile = format!(
        r#"(version 1)
(deny default)
(import "system.sb")
(deny network*)
(allow process*)
(allow file-read-metadata)
(allow file-read* file-map-executable (subpath "{plugin_directory}"))
(allow file-read* (subpath "{workspace}"))
(allow file-write* (subpath "{workspace}"))
(deny file-write* (subpath "{git}"))"#
    );
    let mut command = Command::new(sandbox_exec);
    command.args(["-p", &profile, "--", &executable_path]);
    Ok(IsolatedCommand::new(command))
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
fn linux_command(
    bubblewrap: &Path,
    executable: &Path,
    workspace: &Path,
) -> Result<IsolatedCommand> {
    ensure_static_elf(executable)?;
    let seccomp = plugin_seccomp_filter()?;
    let seccomp_fd = seccomp.as_raw_fd();
    let mut command = Command::new(bubblewrap);
    command.args([
        "--die-with-parent",
        "--new-session",
        "--unshare-all",
        // Hosted kernels can permit an unprivileged user namespace while forbidding loopback
        // configuration in a new network namespace. Share it here and deny both socket creation
        // primitives in the sealed child seccomp policy; no network descriptor is inherited.
        "--share-net",
        "--unshare-user",
        "--unshare-pid",
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
    command.arg("--seccomp").arg(seccomp_fd.to_string());
    command.args([
        "--remount-ro",
        "/",
        "--chdir",
        "/workspace",
        "--",
        "/plugin",
    ]);
    Ok(IsolatedCommand::new(command).with_inherited_fd(seccomp))
}

#[cfg(target_os = "linux")]
fn plugin_seccomp_filter() -> Result<OwnedFd> {
    let name = std::ffi::CString::new("sprout-plugin-seccomp").expect("static memfd name");
    let descriptor =
        unsafe { libc::memfd_create(name.as_ptr(), libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING) };
    if descriptor < 0 {
        return Err(SproutError::IsolationUnavailable(format!(
            "could not create plugin seccomp filter: {}",
            std::io::Error::last_os_error()
        )));
    }
    let descriptor = unsafe { OwnedFd::from_raw_fd(descriptor) };
    let mut file = fs::File::from(descriptor);
    file.write_all(&plugin_seccomp_program()).map_err(|error| {
        SproutError::IsolationUnavailable(format!("could not write plugin seccomp filter: {error}"))
    })?;
    file.flush().map_err(|error| {
        SproutError::IsolationUnavailable(format!("could not flush plugin seccomp filter: {error}"))
    })?;
    let seals = libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, seals) } < 0 {
        return Err(SproutError::IsolationUnavailable(format!(
            "could not seal plugin seccomp filter: {}",
            std::io::Error::last_os_error()
        )));
    }
    let read_only_path = format!("/proc/self/fd/{}", file.as_raw_fd());
    let mut read_only = fs::File::open(read_only_path).map_err(|error| {
        SproutError::IsolationUnavailable(format!(
            "could not reopen plugin seccomp filter read-only: {error}"
        ))
    })?;
    read_only.seek(SeekFrom::Start(0)).map_err(|error| {
        SproutError::IsolationUnavailable(format!(
            "could not rewind plugin seccomp filter: {error}"
        ))
    })?;
    drop(file);
    let descriptor: OwnedFd = read_only.into();
    if descriptor.as_raw_fd() >= 3 {
        return Ok(descriptor);
    }
    let duplicate = unsafe { libc::fcntl(descriptor.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
    if duplicate < 0 {
        return Err(SproutError::IsolationUnavailable(format!(
            "could not reserve plugin seccomp descriptor: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(duplicate) })
}

#[cfg(target_os = "linux")]
fn plugin_seccomp_program() -> Vec<u8> {
    const BPF_LD_W_ABS: u16 = 0x20;
    const BPF_JMP_JEQ_K: u16 = 0x15;
    #[cfg(target_arch = "x86_64")]
    const BPF_JMP_JGE_K: u16 = 0x35;
    const BPF_RET_K: u16 = 0x06;
    const SECCOMP_DATA_NR_OFFSET: u32 = 0;
    const SECCOMP_DATA_ARCH_OFFSET: u32 = 4;
    const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
    const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;

    #[cfg(target_arch = "aarch64")]
    const AUDIT_ARCH_NATIVE: u32 = 0xc000_00b7;
    #[cfg(target_arch = "x86_64")]
    const AUDIT_ARCH_NATIVE: u32 = 0xc000_003e;
    // x86-64 and x32 intentionally share AUDIT_ARCH_X86_64. A deny-list that compares only the
    // native syscall numbers is bypassable by setting bit 30, so reject the complete x32 ABI before
    // evaluating any syscall-specific rule.
    #[cfg(target_arch = "x86_64")]
    const X32_SYSCALL_BIT: u32 = 0x4000_0000;

    #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
    compile_error!("native plugin seccomp is implemented only for Linux arm64 and amd64");

    #[repr(C)]
    struct Instruction {
        code: u16,
        jt: u8,
        jf: u8,
        value: u32,
    }

    let mut instructions = vec![
        Instruction {
            code: BPF_LD_W_ABS,
            jt: 0,
            jf: 0,
            value: SECCOMP_DATA_ARCH_OFFSET,
        },
        Instruction {
            code: BPF_JMP_JEQ_K,
            jt: 1,
            jf: 0,
            value: AUDIT_ARCH_NATIVE,
        },
        Instruction {
            code: BPF_RET_K,
            jt: 0,
            jf: 0,
            value: SECCOMP_RET_KILL_PROCESS,
        },
        Instruction {
            code: BPF_LD_W_ABS,
            jt: 0,
            jf: 0,
            value: SECCOMP_DATA_NR_OFFSET,
        },
    ];
    #[cfg(target_arch = "x86_64")]
    instructions.extend([
        Instruction {
            code: BPF_JMP_JGE_K,
            jt: 0,
            jf: 1,
            value: X32_SYSCALL_BIT,
        },
        Instruction {
            code: BPF_RET_K,
            jt: 0,
            jf: 0,
            value: SECCOMP_RET_ERRNO | libc::EPERM as u32,
        },
    ]);
    for syscall in [
        libc::SYS_clone,
        libc::SYS_clone3,
        libc::SYS_unshare,
        libc::SYS_setns,
        libc::SYS_socket,
        libc::SYS_socketpair,
    ] {
        instructions.push(Instruction {
            code: BPF_JMP_JEQ_K,
            jt: 0,
            jf: 1,
            value: syscall as u32,
        });
        instructions.push(Instruction {
            code: BPF_RET_K,
            jt: 0,
            jf: 0,
            value: SECCOMP_RET_ERRNO | libc::EPERM as u32,
        });
    }
    instructions.push(Instruction {
        code: BPF_RET_K,
        jt: 0,
        jf: 0,
        value: SECCOMP_RET_ALLOW,
    });

    let mut bytes = Vec::with_capacity(instructions.len() * 8);
    for instruction in instructions {
        bytes.extend_from_slice(&instruction.code.to_ne_bytes());
        bytes.push(instruction.jt);
        bytes.push(instruction.jf);
        bytes.extend_from_slice(&instruction.value.to_ne_bytes());
    }
    bytes
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

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
mod tests {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    use std::fs;

    #[cfg(target_os = "linux")]
    use std::os::unix::fs::PermissionsExt;

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
            .command()
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args.iter().any(|arg| arg == "--unshare-all"));
        assert!(args.iter().any(|arg| arg == "--share-net"));
        assert!(args.iter().any(|arg| arg == "--unshare-user"));
        assert!(args.iter().any(|arg| arg == "--unshare-pid"));
        assert!(!args.iter().any(|arg| arg == "--disable-userns"));
        assert!(!args.iter().any(|arg| arg == "--assert-userns-disabled"));
        assert!(args.iter().any(|arg| arg == "--seccomp"));
        let inherited = command.inherited_raw_fds();
        assert_eq!(inherited.len(), 1);
        assert!(
            args.windows(2)
                .any(|args| { args[0] == "--seccomp" && args[1] == inherited[0].to_string() })
        );
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
    fn plugin_seccomp_filter_is_sealed_and_denies_namespace_and_network_syscalls() {
        let descriptor = plugin_seccomp_filter().unwrap();
        let seals = unsafe { libc::fcntl(descriptor.as_raw_fd(), libc::F_GET_SEALS) };
        assert_eq!(
            seals,
            libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE
        );
        let flags = unsafe { libc::fcntl(descriptor.as_raw_fd(), libc::F_GETFL) };
        assert_eq!(flags & libc::O_ACCMODE, libc::O_RDONLY);
        let byte = [0_u8];
        assert_eq!(
            unsafe { libc::write(descriptor.as_raw_fd(), byte.as_ptr().cast(), byte.len()) },
            -1
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EBADF)
        );

        let bytes = plugin_seccomp_program();
        assert_eq!(bytes.len() % 8, 0);
        for syscall in [
            libc::SYS_clone,
            libc::SYS_clone3,
            libc::SYS_unshare,
            libc::SYS_setns,
            libc::SYS_socket,
            libc::SYS_socketpair,
        ] {
            assert!(bytes.chunks_exact(8).any(|instruction| {
                u16::from_ne_bytes([instruction[0], instruction[1]]) == 0x15
                    && u32::from_ne_bytes([
                        instruction[4],
                        instruction[5],
                        instruction[6],
                        instruction[7],
                    ]) == syscall as u32
            }));
        }
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[test]
    fn plugin_seccomp_filter_rejects_x32_namespace_syscall_aliases() {
        const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
        const X32_SYSCALL_BIT: u32 = 0x4000_0000;
        const SECCOMP_RET_ERRNO_EPERM: u32 = 0x0005_0000 | libc::EPERM as u32;
        const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;

        let program = plugin_seccomp_program();
        for syscall in [
            libc::SYS_clone,
            libc::SYS_clone3,
            libc::SYS_unshare,
            libc::SYS_setns,
        ] {
            assert_eq!(
                evaluate_classic_bpf(&program, AUDIT_ARCH_X86_64, syscall as u32),
                SECCOMP_RET_ERRNO_EPERM,
            );
            assert_eq!(
                evaluate_classic_bpf(
                    &program,
                    AUDIT_ARCH_X86_64,
                    syscall as u32 | X32_SYSCALL_BIT,
                ),
                SECCOMP_RET_ERRNO_EPERM,
                "x32 alias bypassed syscall {syscall}",
            );
        }
        assert_eq!(
            evaluate_classic_bpf(&program, AUDIT_ARCH_X86_64, libc::SYS_getpid as u32),
            SECCOMP_RET_ALLOW,
        );
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    fn evaluate_classic_bpf(program: &[u8], architecture: u32, syscall: u32) -> u32 {
        let instructions = program.chunks_exact(8).collect::<Vec<_>>();
        assert_eq!(instructions.len() * 8, program.len());
        let mut accumulator = 0_u32;
        let mut index = 0_usize;
        loop {
            let instruction = instructions[index];
            let code = u16::from_ne_bytes([instruction[0], instruction[1]]);
            let jump_true = instruction[2] as usize;
            let jump_false = instruction[3] as usize;
            let value = u32::from_ne_bytes([
                instruction[4],
                instruction[5],
                instruction[6],
                instruction[7],
            ]);
            match code {
                0x20 => {
                    accumulator = match value {
                        0 => syscall,
                        4 => architecture,
                        _ => panic!("unexpected seccomp data offset {value}"),
                    };
                    index += 1;
                }
                0x15 => {
                    index += 1 + if accumulator == value {
                        jump_true
                    } else {
                        jump_false
                    };
                }
                0x35 => {
                    index += 1 + if accumulator >= value {
                        jump_true
                    } else {
                        jump_false
                    };
                }
                0x06 => return value,
                _ => panic!("unexpected classic-BPF opcode {code:#x}"),
            }
        }
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
            .command()
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(!args.iter().any(|arg| arg == "/workspace/.git"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn macos_profile_denies_credentials_network_and_git_but_allows_workspace() {
        use std::{net::TcpListener, process::Command as StdCommand};

        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let plugin_dir = root.path().join("plugin");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(workspace.join(".git")).unwrap();
        fs::create_dir(&plugin_dir).unwrap();
        let credential = root.path().join("credential");
        let outside_write = root.path().join("outside-write");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let listener_port = listener.local_addr().unwrap().port();
        fs::write(&credential, b"secret").unwrap();
        let source = plugin_dir.join("probe.c");
        let plugin = plugin_dir.join("plugin");
        let credential = credential.to_str().unwrap();
        let outside_write = outside_write.to_str().unwrap();
        fs::write(
            &source,
            format!(
                r#"#include <fcntl.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
int main(void) {{
 int out=open("allowed",O_CREAT|O_WRONLY,0600); if(out<0||write(out,"ok",2)!=2)return 10;
 if(open(".git/denied",O_CREAT|O_WRONLY,0600)>=0)return 11;
 if(open("{credential}",O_RDONLY)>=0)return 12;
 if(open("{outside_write}",O_CREAT|O_WRONLY,0600)>=0)return 13;
 int s=socket(AF_INET,SOCK_STREAM,0); struct sockaddr_in a={{.sin_family=AF_INET,.sin_port=htons({listener_port}),.sin_addr={{.s_addr=htonl(INADDR_LOOPBACK)}}}};
 if(s>=0&&connect(s,(struct sockaddr*)&a,sizeof(a))==0)return 14; return 0;
}}"#
            ),
        )
        .unwrap();
        let compile = StdCommand::new("/usr/bin/cc")
            .args([source.as_os_str(), "-o".as_ref(), plugin.as_os_str()])
            .output()
            .unwrap();
        assert!(
            compile.status.success(),
            "{}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let executable = VerifiedExecutable::for_test(plugin);
        let provider = NativeIsolationProvider::detect().unwrap();
        let mut command = provider.command(&executable, &workspace).unwrap();
        command.command_mut().current_dir(&workspace).env_clear();
        let output = command.command_mut().output().await.unwrap();
        assert!(
            output.status.success(),
            "sandbox probe exited {}",
            output.status
        );
        assert_eq!(fs::read(workspace.join("allowed")).unwrap(), b"ok");
        assert!(!workspace.join(".git/denied").exists());
        assert!(!Path::new(outside_write).exists());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn macos_deadline_kills_the_complete_sandboxed_child_tree() {
        use std::process::Command as StdCommand;

        struct TimeoutProtocol;
        impl crate::TemplateProtocol<()> for TimeoutProtocol {
            fn encode_request(&self, _: &()) -> Result<Vec<u8>> {
                Ok(vec![0])
            }

            fn decode_response(&self, _: &[u8]) -> Result<crate::ProtocolOutcome> {
                unreachable!("the timeout probe never returns a protocol response")
            }
        }

        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let plugin_dir = root.path().join("plugin");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir(&plugin_dir).unwrap();
        let source = plugin_dir.join("probe.c");
        let plugin = plugin_dir.join("plugin");
        fs::write(
            &source,
            r#"#include <fcntl.h>
#include <unistd.h>
int main(void) {
 char request; if(read(0,&request,1)!=1)return 10;
 pid_t child=fork(); if(child<0)return 11;
 if(child==0){sleep(2);int out=open("descendant",O_CREAT|O_WRONLY,0600);if(out>=0)write(out,"bad",3);return 0;}
 sleep(10); return 0;
}"#,
        )
        .unwrap();
        let compile = StdCommand::new("/usr/bin/cc")
            .args([source.as_os_str(), "-o".as_ref(), plugin.as_os_str()])
            .output()
            .unwrap();
        assert!(
            compile.status.success(),
            "{}",
            String::from_utf8_lossy(&compile.stderr)
        );
        let executable = VerifiedExecutable::for_test(plugin);
        let error = crate::PluginRunner::new(
            NativeIsolationProvider::detect().unwrap(),
            crate::ApplyLimits {
                timeout: std::time::Duration::from_millis(500),
                ..crate::ApplyLimits::default()
            },
        )
        .apply(&executable, &workspace, &TimeoutProtocol, &())
        .await
        .unwrap_err();
        assert_eq!(error.code(), crate::ErrorCode::PluginTimeout);
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        assert!(!workspace.join("descendant").exists());
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
        run_linux_isolation_probe().await;
    }

    /// This is the production ECS shape: a non-root process with no capabilities, under Docker's
    /// argument-scoped outer seccomp profile. The static probe also asserts that the inner filter
    /// denies clone/clone3/unshare/setns and that Bubblewrap consumed its only inherited FD.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "requires trusted bwrap and a precompiled static probe"]
    async fn nonroot_linux_provider_enforces_the_complete_boundary() {
        assert_ne!(unsafe { libc::geteuid() }, 0, "probe must start non-root");
        run_linux_isolation_probe().await;
    }

    #[cfg(target_os = "linux")]
    async fn run_linux_isolation_probe() {
        let probe = std::env::var_os("SPROUT_CORE_LINUX_ISOLATION_PROBE")
            .map(PathBuf::from)
            .expect("SPROUT_CORE_LINUX_ISOLATION_PROBE is required");
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir(workspace.path().join(".git")).unwrap();
        let executable = VerifiedExecutable::for_test(probe);
        let provider = NativeIsolationProvider::detect().unwrap();
        let mut command = provider.command(&executable, workspace.path()).unwrap();
        command.inherit_fds_for_test().unwrap();
        command
            .command_mut()
            .env_clear()
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .current_dir(workspace.path());
        let output = command.command_mut().output().await.unwrap();
        assert!(
            output.status.success(),
            "probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(workspace.path().join("allowed")).unwrap(), b"ok");
        assert!(!workspace.path().join(".git/denied").exists());
    }
}
