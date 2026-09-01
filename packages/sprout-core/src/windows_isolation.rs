use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rappct::{
    AppContainerProfile, JobLimits, LaunchOptions, SecurityCapabilities,
    SecurityCapabilitiesBuilder, StdioConfig, launch_in_container_with_io,
};
use tempfile::TempDir;
use walkdir::WalkDir;
use windows_sys::Win32::System::JobObjects::{
    JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_JOB_TIME, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows_sys::Win32::{
    Foundation::CloseHandle,
    System::Threading::{OpenProcess, PROCESS_SUSPEND_RESUME},
};

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtResumeProcess(process: windows_sys::Win32::Foundation::HANDLE) -> i32;
}

use crate::{ApplyLimits, Result, SproutError};

const WINDOWS_MEMORY_LIMIT: usize = 256 * 1024 * 1024;
const WINDOWS_CPU_PERCENT: u32 = 50;
const WINDOWS_PROCESS_LIMIT: u32 = 16;
const FILE_GENERIC_READ_EXECUTE: u32 = 0x0012_00A9;
const FILE_ALL_ACCESS: u32 = 0x001f_01ff;

pub(crate) struct WindowsAppContainerCommand {
    temporary: Option<TempDir>,
    profile: Option<AppContainerProfile>,
    capabilities: SecurityCapabilities,
    staged_workspace: PathBuf,
    runtime_temporary: PathBuf,
    executable: PathBuf,
    original_workspace: PathBuf,
}

#[derive(Debug)]
pub(crate) struct WindowsOutput {
    pub(crate) success: bool,
    pub(crate) exit_code: u32,
    pub(crate) status: String,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

impl WindowsAppContainerCommand {
    pub(crate) fn stage(executable: &Path, workspace: &Path) -> Result<Self> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let identity = format!("sprout.template.{}.{}", std::process::id(), nonce);
        let profile = AppContainerProfile::ensure(&identity, &identity, Some("Sprout template"))
            .map_err(|error| SproutError::IsolationUnavailable(error.to_string()))?;
        let profile_folder = match profile.folder_path() {
            Ok(folder) => folder,
            Err(error) => {
                let message = error.to_string();
                let _ = profile.delete();
                return Err(SproutError::IsolationUnavailable(message));
            }
        };
        // GetAppContainerFolderPath returns the package root, while Windows exposes the writable
        // profile to the child at its `AC` descendant. Hosted runners do not materialize either
        // directory merely by registering the profile, so create the documented LocalAppData
        // root before staging below it.
        let profile_local_app_data = profile_folder.join("AC");
        if let Err(source) = fs::create_dir_all(&profile_local_app_data) {
            let _ = profile.delete();
            return Err(SproutError::Io {
                operation: "create Windows AppContainer profile directory",
                source,
            });
        }
        // The host created this profile tree, so explicitly give the package SID traversal on
        // the package root and ownership of its documented LocalAppData subtree.
        if let Err(error) = rappct::acl::grant_to_package(
            rappct::acl::ResourcePath::Directory(profile_folder.clone()),
            &profile.sid,
            rappct::acl::AccessMask(FILE_GENERIC_READ_EXECUTE),
        ) {
            let message = error.to_string();
            let _ = profile.delete();
            return Err(SproutError::IsolationUnavailable(message));
        }
        if let Err(error) = rappct::acl::grant_to_package(
            rappct::acl::ResourcePath::Directory(profile_local_app_data.clone()),
            &profile.sid,
            rappct::acl::AccessMask(FILE_ALL_ACCESS),
        ) {
            let message = error.to_string();
            let _ = profile.delete();
            return Err(SproutError::IsolationUnavailable(message));
        }
        let temporary = match tempfile::Builder::new()
            .prefix("sprout-stage-")
            .tempdir_in(&profile_local_app_data)
        {
            Ok(temporary) => temporary,
            Err(source) => {
                let _ = profile.delete();
                return Err(SproutError::Io {
                    operation: "create Windows AppContainer staging directory",
                    source,
                });
            }
        };
        let staged_workspace = temporary.path().join("workspace");
        let plugin_directory = temporary.path().join("plugin");
        let runtime_temporary = temporary.path().join("temp");
        fs::create_dir(&staged_workspace).map_err(|source| SproutError::Io {
            operation: "create staged Windows workspace",
            source,
        })?;
        fs::create_dir(&plugin_directory).map_err(|source| SproutError::Io {
            operation: "create staged Windows plugin directory",
            source,
        })?;
        fs::create_dir(&runtime_temporary).map_err(|source| SproutError::Io {
            operation: "create staged Windows runtime temporary directory",
            source,
        })?;
        let staged_executable = plugin_directory.join("plugin.exe");

        let setup = (|| {
            // Add inheritable ACEs before creating staged descendants. Setting an inheritable
            // ACE after files already exist does not retroactively grant the package access.
            rappct::acl::grant_to_package(
                rappct::acl::ResourcePath::Directory(temporary.path().to_owned()),
                &profile.sid,
                rappct::acl::AccessMask(FILE_GENERIC_READ_EXECUTE),
            )
            .map_err(|error| SproutError::IsolationUnavailable(error.to_string()))?;
            rappct::acl::grant_to_package(
                rappct::acl::ResourcePath::Directory(plugin_directory),
                &profile.sid,
                rappct::acl::AccessMask(FILE_GENERIC_READ_EXECUTE),
            )
            .map_err(|error| SproutError::IsolationUnavailable(error.to_string()))?;
            rappct::acl::grant_to_package(
                rappct::acl::ResourcePath::Directory(staged_workspace.clone()),
                &profile.sid,
                rappct::acl::AccessMask(FILE_ALL_ACCESS),
            )
            .map_err(|error| SproutError::IsolationUnavailable(error.to_string()))?;
            rappct::acl::grant_to_package(
                rappct::acl::ResourcePath::Directory(runtime_temporary.clone()),
                &profile.sid,
                rappct::acl::AccessMask(FILE_ALL_ACCESS),
            )
            .map_err(|error| SproutError::IsolationUnavailable(error.to_string()))?;
            let capabilities = SecurityCapabilitiesBuilder::new(&profile.sid)
                // No capabilities means AppContainer has no network authority.
                .build()
                .map_err(|error| SproutError::IsolationUnavailable(error.to_string()))?;
            copy_workspace(workspace, &staged_workspace)?;
            fs::copy(executable, &staged_executable).map_err(|source| SproutError::Io {
                operation: "stage verified Windows plugin",
                source,
            })?;
            Ok(capabilities)
        })();
        let capabilities = match setup {
            Ok(capabilities) => capabilities,
            Err(error) => {
                let _ = profile.delete();
                return Err(error);
            }
        };
        Ok(Self {
            temporary: Some(temporary),
            profile: Some(profile),
            capabilities,
            staged_workspace,
            runtime_temporary,
            executable: staged_executable,
            original_workspace: workspace.to_owned(),
        })
    }

    pub(crate) fn workspace(&self) -> &Path {
        &self.staged_workspace
    }

    pub(crate) fn original_workspace(&self) -> &Path {
        &self.original_workspace
    }

    pub(crate) async fn run(&self, request: Vec<u8>, limits: ApplyLimits) -> Result<WindowsOutput> {
        let capabilities = self.capabilities.clone();
        let executable = self.executable.clone();
        let workspace = self.staged_workspace.clone();
        let runtime_temporary = self.runtime_temporary.clone();
        tokio::task::spawn_blocking(move || {
            let profile_local_app_data = workspace
                .ancestors()
                .nth(2)
                .expect("staged workspace is nested below AppContainer LocalAppData");
            let environment = allowlisted_environment(&runtime_temporary, profile_local_app_data);
            let options = LaunchOptions {
                exe: executable,
                cwd: Some(workspace),
                env: Some(environment),
                stdio: StdioConfig::Pipe,
                suspended: true,
                join_job: Some(JobLimits {
                    memory_bytes: Some(WINDOWS_MEMORY_LIMIT),
                    cpu_rate_percent: Some(WINDOWS_CPU_PERCENT),
                    kill_on_job_close: true,
                }),
                ..LaunchOptions::default()
            };
            let mut child = launch_in_container_with_io(&capabilities, &options)
                .map_err(|error| SproutError::PluginSpawn(error_chain(&error)))?;
            apply_process_limit(&child, limits.timeout)?;
            resume_suspended(&child)?;
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| SproutError::PluginSpawn("AppContainer stdin missing".into()))?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| SproutError::PluginSpawn("AppContainer stdout missing".into()))?;
            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| SproutError::PluginSpawn("AppContainer stderr missing".into()))?;
            let writer = std::thread::spawn(move || -> std::io::Result<()> {
                stdin.write_all(&request)?;
                stdin.flush()
            });
            let stdout_limit = limits.max_stdout_bytes;
            let stderr_limit = limits.max_stderr_bytes;
            let stdout_reader = std::thread::spawn(move || read_limited(stdout, stdout_limit));
            let stderr_reader = std::thread::spawn(move || read_limited(stderr, stderr_limit));
            let code =
                child
                    .wait(Some(limits.timeout))
                    .map_err(|_| SproutError::PluginTimeout {
                        timeout_ms: limits.timeout.as_millis().try_into().unwrap_or(u64::MAX),
                    })?;
            writer
                .join()
                .map_err(|_| SproutError::PluginSpawn("AppContainer stdin thread failed".into()))?
                .map_err(|error| SproutError::PluginSpawn(error.to_string()))?;
            let stdout = join_reader(stdout_reader, "stdout", stdout_limit)?;
            let stderr = join_reader(stderr_reader, "stderr", stderr_limit)?;
            Ok(WindowsOutput {
                success: code == 0,
                exit_code: code,
                status: format!("exit code {code}"),
                stdout,
                stderr,
            })
        })
        .await
        .map_err(|error| SproutError::PluginSpawn(error.to_string()))?
    }
}

fn error_chain(error: &(dyn std::error::Error + 'static)) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(error) = source {
        message.push_str(": ");
        message.push_str(&error.to_string());
        source = error.source();
    }
    message
}

fn allowlisted_environment(
    runtime_temporary: &Path,
    profile_local_app_data: &Path,
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let mut environment: Vec<(std::ffi::OsString, std::ffi::OsString)> =
        vec![("LANG".into(), "C".into()), ("LC_ALL".into(), "C".into())];
    // CreateProcess and the Windows runtime require this narrow system environment even when the
    // child is launched by absolute path. CreateProcess still requires PATH when its environment is
    // fully replaced, so synthesize a system-only value instead of inheriting the user's PATH.
    // TEMP/TMP and LOCALAPPDATA point inside the AppContainer-owned tree; no host user profile,
    // credential, or proxy value crosses the boundary.
    for name in ["SystemRoot", "windir", "ComSpec", "PATHEXT"] {
        if let Some(value) = std::env::var_os(name) {
            environment.push((name.into(), value));
        }
    }
    environment.push((
        "LOCALAPPDATA".into(),
        profile_local_app_data.as_os_str().to_owned(),
    ));
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        let system_root = PathBuf::from(system_root);
        let path = std::env::join_paths([system_root.join("System32"), system_root])
            .expect("Windows system paths do not contain the PATH separator");
        environment.push(("PATH".into(), path));
    }
    environment.push(("TEMP".into(), runtime_temporary.as_os_str().to_owned()));
    environment.push(("TMP".into(), runtime_temporary.as_os_str().to_owned()));
    environment.sort_by(|left, right| {
        left.0
            .to_string_lossy()
            .to_ascii_lowercase()
            .cmp(&right.0.to_string_lossy().to_ascii_lowercase())
    });
    environment
}

fn resume_suspended(child: &rappct::LaunchedIo) -> Result<()> {
    let process = unsafe { OpenProcess(PROCESS_SUSPEND_RESUME, 0, child.pid) };
    if process.is_null() {
        return Err(SproutError::IsolationUnavailable(
            std::io::Error::last_os_error().to_string(),
        ));
    }
    let status = unsafe { NtResumeProcess(process) };
    unsafe {
        CloseHandle(process);
    }
    if status < 0 {
        return Err(SproutError::IsolationUnavailable(format!(
            "NtResumeProcess failed with NTSTATUS {status:#x}"
        )));
    }
    Ok(())
}

impl Drop for WindowsAppContainerCommand {
    fn drop(&mut self) {
        // The only ACLs were placed below `temporary`; TempDir removes that entire tree after the
        // run. Remove it before deleting its parent AppContainer profile. Windows unregisters the
        // profile identity but leaves the LocalAppData root it created, so remove that unique
        // per-run folder explicitly after unregistering it.
        let _ = self.temporary.take();
        if let Some(profile) = self.profile.take() {
            let profile_folder = profile.folder_path().ok();
            let _ = profile.delete();
            if let Some(profile_folder) = profile_folder {
                let _ = fs::remove_dir_all(profile_folder);
            }
        }
    }
}

fn apply_process_limit(child: &rappct::LaunchedIo, timeout: Duration) -> Result<()> {
    let job = child
        .job_guard
        .as_ref()
        .ok_or_else(|| SproutError::IsolationUnavailable("AppContainer job missing".into()))?;
    let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    information.BasicLimitInformation.ActiveProcessLimit = WINDOWS_PROCESS_LIMIT;
    information.BasicLimitInformation.PerJobUserTimeLimit = timeout
        .as_nanos()
        .saturating_div(100)
        .try_into()
        .unwrap_or(i64::MAX);
    information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_JOB_TIME
        | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    information.ProcessMemoryLimit = WINDOWS_MEMORY_LIMIT;
    let handle = job.as_handle().0 as windows_sys::Win32::Foundation::HANDLE;
    let ok = unsafe {
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            (&raw const information).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if ok == 0 {
        return Err(SproutError::IsolationUnavailable(
            std::io::Error::last_os_error().to_string(),
        ));
    }
    Ok(())
}

fn read_limited(mut reader: impl Read, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn join_reader(
    reader: std::thread::JoinHandle<std::io::Result<Vec<u8>>>,
    stream: &'static str,
    limit: usize,
) -> Result<Vec<u8>> {
    let bytes = reader
        .join()
        .map_err(|_| SproutError::PluginSpawn(format!("AppContainer {stream} thread failed")))?
        .map_err(|error| SproutError::PluginSpawn(error.to_string()))?;
    if bytes.len() > limit {
        return Err(SproutError::PluginOutputLimit { stream, limit });
    }
    Ok(bytes)
}

fn copy_workspace(source: &Path, destination: &Path) -> Result<()> {
    for entry in WalkDir::new(source)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| entry.depth() == 0 || entry.file_name() != ".git")
    {
        let entry = entry.map_err(|error| SproutError::WorkspaceRejected {
            path: error.path().unwrap_or(source).to_owned(),
            reason: error.to_string(),
        })?;
        if entry.depth() == 0 {
            continue;
        }
        let relative =
            entry
                .path()
                .strip_prefix(source)
                .map_err(|_| SproutError::WorkspaceRejected {
                    path: entry.path().to_owned(),
                    reason: "workspace entry escaped its root".into(),
                })?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir(&target).map_err(|source| SproutError::Io {
                operation: "stage Windows workspace directory",
                source,
            })?;
        } else if entry.file_type().is_file() {
            fs::copy(entry.path(), &target).map_err(|source| SproutError::Io {
                operation: "stage Windows workspace file",
                source,
            })?;
        } else {
            return Err(SproutError::WorkspaceRejected {
                path: relative.to_owned(),
                reason: "Windows AppContainer staging does not accept workspace symlinks".into(),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{net::TcpListener, process::Command};

    use super::*;

    #[tokio::test]
    async fn appcontainer_denies_outside_and_network_and_cleans_up() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let credential = root.path().join("credential");
        let outside_write = root.path().join("outside-write");
        // Holding a listening socket makes a successful connect the unsandboxed baseline. A
        // closed port could only prove that no server happened to be listening.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let listener_address = listener.local_addr().unwrap();
        fs::write(&credential, b"secret").unwrap();
        let source = root.path().join("probe.rs");
        let executable = root.path().join("probe.exe");
        let credential_literal = format!("{:?}", credential.to_string_lossy());
        let outside_literal = format!("{:?}", outside_write.to_string_lossy());
        let listener_literal = format!("{:?}", listener_address.to_string());
        fs::write(
            &source,
            format!(
                r#"use std::io::Read;
fn main() {{
 if std::env::args().nth(1).as_deref()==Some("child") {{ std::thread::sleep(std::time::Duration::from_secs(2)); let _=std::fs::write("descendant",b"bad"); return; }}
 let mut input=Vec::new(); std::io::stdin().read_to_end(&mut input).unwrap();
 if std::env::current_dir().unwrap().file_name().and_then(|name| name.to_str())!=Some("workspace") {{ std::process::exit(9); }}
 if input==b"slow" {{ std::process::Command::new(std::env::current_exe().unwrap()).arg("child").spawn().unwrap(); std::thread::sleep(std::time::Duration::from_secs(10)); return; }}
 std::fs::write("allowed", b"ok").unwrap();
 if std::fs::read({credential_literal}).is_ok() {{ std::process::exit(10); }}
 if std::fs::write({outside_literal}, b"bad").is_ok() {{ std::process::exit(11); }}
 if std::net::TcpStream::connect_timeout(&{listener_literal}.parse().unwrap(), std::time::Duration::from_millis(250)).is_ok() {{ std::process::exit(12); }}
}}"#
            ),
        )
        .unwrap();
        let compilation = Command::new("rustc")
            .args([source.as_os_str(), "-o".as_ref(), executable.as_os_str()])
            .output()
            .unwrap();
        assert!(
            compilation.status.success(),
            "{}",
            String::from_utf8_lossy(&compilation.stderr)
        );
        let command = WindowsAppContainerCommand::stage(&executable, &workspace).unwrap();
        let staging_root = command.temporary.as_ref().unwrap().path().to_owned();
        let profile_folder = command.profile.as_ref().unwrap().folder_path().unwrap();
        let output = command
            .run(
                Vec::new(),
                ApplyLimits {
                    timeout: Duration::from_secs(10),
                    ..ApplyLimits::default()
                },
            )
            .await
            .unwrap();
        assert!(
            output.success,
            "{}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read(command.workspace().join("allowed")).unwrap(),
            b"ok"
        );
        assert!(!outside_write.exists());
        let timeout = command
            .run(
                b"slow".to_vec(),
                ApplyLimits {
                    timeout: Duration::from_millis(100),
                    ..ApplyLimits::default()
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(timeout, SproutError::PluginTimeout { .. }));
        std::thread::sleep(Duration::from_secs(3));
        assert!(!command.workspace().join("descendant").exists());
        drop(command);
        assert!(
            !staging_root.exists(),
            "AppContainer staging ACL tree survived cleanup"
        );
        assert!(
            !profile_folder.exists(),
            "AppContainer profile folder survived cleanup"
        );
    }
}
