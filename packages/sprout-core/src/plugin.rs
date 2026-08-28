use std::{path::Path, process::Stdio, time::Duration};

#[cfg(unix)]
use std::os::fd::{AsRawFd, OwnedFd};
#[cfg(not(unix))]
type OwnedFd = ();

use serde::Serialize;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};

use crate::{
    DeclaredChange, DiffLimits, Result, SproutError, VerifiedExecutable, WorkspaceChange,
    workspace::WorkspaceSnapshot,
};

#[derive(Clone, Copy, Debug)]
pub struct ApplyLimits {
    pub timeout: Duration,
    pub max_request_bytes: usize,
    pub max_stdout_bytes: usize,
    pub max_stderr_bytes: usize,
    pub diff: DiffLimits,
}

impl Default for ApplyLimits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(120),
            max_request_bytes: 1024 * 1024,
            max_stdout_bytes: 4 * 1024 * 1024,
            max_stderr_bytes: 256 * 1024,
            diff: DiffLimits::default(),
        }
    }
}

/// The protocol crate converts its versioned response into this internal diff contract.
#[derive(Clone, Debug, Serialize)]
pub struct ProtocolOutcome {
    pub declared_changes: Vec<DeclaredChange>,
    /// The complete protocol response, retained for the CLI or Node binding without redefining it.
    pub response: serde_json::Value,
}

/// Boundary implemented by `sprout-template-protocol`; wire structs do not live in this crate.
pub trait TemplateProtocol<Request>: Send + Sync {
    fn encode_request(&self, request: &Request) -> Result<Vec<u8>>;
    fn decode_response(&self, response: &[u8]) -> Result<ProtocolOutcome>;
}

/// Strict adapter for the one canonical protocol implementation pinned by this workspace.
#[derive(Clone, Copy, Debug, Default)]
pub struct CanonicalProtocol;

impl TemplateProtocol<sprout_template_protocol::ApplyRequest> for CanonicalProtocol {
    fn encode_request(&self, request: &sprout_template_protocol::ApplyRequest) -> Result<Vec<u8>> {
        use sprout_template_protocol::Validate;

        request
            .validate()
            .map_err(|error| SproutError::ProtocolViolation(error.to_string()))?;
        serde_json::to_vec(request)
            .map_err(|error| SproutError::ProtocolViolation(error.to_string()))
    }

    fn decode_response(&self, response: &[u8]) -> Result<ProtocolOutcome> {
        let parsed = sprout_template_protocol::parse_response(response)
            .map_err(|error| SproutError::ProtocolViolation(error.to_string()))?;
        let declared_changes = match &parsed {
            sprout_template_protocol::ApplyResponse::Ok { changes, .. } => changes
                .iter()
                .map(|change| DeclaredChange {
                    path: change.path.clone(),
                    kind: match change.kind {
                        sprout_template_protocol::ChangeKind::Created => crate::ChangeKind::Create,
                        sprout_template_protocol::ChangeKind::Modified => crate::ChangeKind::Modify,
                        sprout_template_protocol::ChangeKind::Deleted => crate::ChangeKind::Delete,
                    },
                    before_sha256: change.before_sha256.clone(),
                    after_sha256: change.after_sha256.clone(),
                })
                .collect(),
            sprout_template_protocol::ApplyResponse::Error { error, .. } => {
                let code = serde_json::to_value(error.code)
                    .ok()
                    .and_then(|value| value.as_str().map(ToOwned::to_owned))
                    .unwrap_or_else(|| "template_error".into());
                return Err(SproutError::TemplateRejected {
                    code,
                    message: error.message.clone(),
                });
            }
        };
        let response = serde_json::to_value(parsed)
            .map_err(|error| SproutError::ProtocolViolation(error.to_string()))?;
        Ok(ProtocolOutcome {
            declared_changes,
            response,
        })
    }
}

/// Constructs a command inside a fail-closed OS sandbox.
///
/// The provider must deny network access, make only `workspace` writable, keep `.git` read-only,
/// prevent access to caller credentials, and contain descendants so killing the command kills the
/// complete plugin process tree. Core clears the environment and controls all standard streams.
pub trait IsolationProvider: Send + Sync {
    fn command(&self, executable: &VerifiedExecutable, workspace: &Path)
    -> Result<IsolatedCommand>;
}

/// A sandbox command and the narrowly allowlisted descriptors its launcher consumes before the
/// plugin starts. Every other non-stdio descriptor remains close-on-exec.
pub struct IsolatedCommand {
    command: Command,
    inherited_fds: Vec<OwnedFd>,
}

impl IsolatedCommand {
    pub fn new(command: Command) -> Self {
        Self {
            command,
            inherited_fds: Vec::new(),
        }
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn with_inherited_fd(mut self, descriptor: OwnedFd) -> Self {
        self.inherited_fds.push(descriptor);
        self
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(crate) fn command(&self) -> &Command {
        &self.command
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(crate) fn command_mut(&mut self) -> &mut Command {
        &mut self.command
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(crate) fn inherited_raw_fds(&self) -> Vec<libc::c_int> {
        self.inherited_fds.iter().map(AsRawFd::as_raw_fd).collect()
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(crate) fn inherit_fds_for_test(&self) -> std::io::Result<()> {
        for descriptor in &self.inherited_fds {
            clear_close_on_exec(descriptor.as_raw_fd())?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ApplyResult {
    pub protocol: ProtocolOutcome,
    pub changes: Vec<WorkspaceChange>,
}

pub struct PluginRunner<I> {
    isolation: I,
    limits: ApplyLimits,
}

impl<I: IsolationProvider> PluginRunner<I> {
    pub fn new(isolation: I, limits: ApplyLimits) -> Self {
        Self { isolation, limits }
    }

    pub async fn apply<P, Request>(
        &self,
        executable: &VerifiedExecutable,
        workspace: &Path,
        protocol: &P,
        request: &Request,
    ) -> Result<ApplyResult>
    where
        P: TemplateProtocol<Request>,
        Request: Sync,
    {
        let request = protocol.encode_request(request)?;
        if request.len() > self.limits.max_request_bytes {
            return Err(SproutError::ProtocolViolation(format!(
                "encoded request is {} bytes; limit is {}",
                request.len(),
                self.limits.max_request_bytes
            )));
        }
        let before = WorkspaceSnapshot::capture(workspace, self.limits.diff)?;
        before.reject_preexisting_hard_links()?;
        let IsolatedCommand {
            mut command,
            inherited_fds,
        } = self.isolation.command(executable, workspace)?;
        command
            .env_clear()
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        configure_process(&mut command, &inherited_fds)?;
        let mut child = command
            .spawn()
            .map_err(|error| SproutError::PluginSpawn(error.to_string()))?;
        drop(inherited_fds);
        let mut stdin = child.stdin.take().ok_or_else(|| {
            SproutError::PluginSpawn("sandbox did not provide plugin stdin".into())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            SproutError::PluginSpawn("sandbox did not provide plugin stdout".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            SproutError::PluginSpawn("sandbox did not provide plugin stderr".into())
        })?;

        let stdin_task = tokio::spawn(async move {
            stdin.write_all(&request).await?;
            stdin.shutdown().await
        });
        let (limit_sender, mut limit_receiver) = tokio::sync::mpsc::channel(2);
        let stdout_task = tokio::spawn(read_bounded(
            stdout,
            self.limits.max_stdout_bytes,
            "stdout",
            limit_sender.clone(),
        ));
        let stderr_task = tokio::spawn(read_bounded(
            stderr,
            self.limits.max_stderr_bytes,
            "stderr",
            limit_sender,
        ));

        let completed = tokio::time::timeout(self.limits.timeout, async {
            tokio::select! {
                status = child.wait() => Ok(status),
                stream = limit_receiver.recv() => match stream {
                    Some(stream) => Err(stream),
                    None => Ok(child.wait().await),
                },
            }
        })
        .await;
        let status = match completed {
            Ok(Ok(status)) => status,
            Ok(Err(stream)) => {
                terminate_process_tree(&mut child).await;
                let limit = if stream == "stdout" {
                    self.limits.max_stdout_bytes
                } else {
                    self.limits.max_stderr_bytes
                };
                return Err(SproutError::PluginOutputLimit { stream, limit });
            }
            Err(_) => {
                terminate_process_tree(&mut child).await;
                return Err(SproutError::PluginTimeout {
                    timeout_ms: self
                        .limits
                        .timeout
                        .as_millis()
                        .try_into()
                        .unwrap_or(u64::MAX),
                });
            }
        };
        let stdin = stdin_task.await;
        let stdout = stdout_task.await;
        let stderr = stderr_task.await;
        stdin
            .map_err(|error| SproutError::PluginSpawn(error.to_string()))?
            .map_err(|error| SproutError::PluginSpawn(error.to_string()))?;
        let stdout = join_output(stdout, "stdout", self.limits.max_stdout_bytes)?;
        let stderr = join_output(stderr, "stderr", self.limits.max_stderr_bytes)?;
        let status = status.map_err(|error| SproutError::PluginSpawn(error.to_string()))?;
        if !status.success() {
            return Err(SproutError::PluginFailed {
                status: status.to_string(),
                stderr: String::from_utf8_lossy(&stderr.bytes).into_owned(),
            });
        }
        let protocol = protocol.decode_response(&stdout.bytes)?;
        let after = WorkspaceSnapshot::capture(workspace, self.limits.diff)?;
        let changes = before.validate_diff(&after, &protocol.declared_changes, self.limits.diff)?;
        Ok(ApplyResult { protocol, changes })
    }
}

#[cfg(unix)]
fn configure_process(command: &mut Command, inherited_fds: &[OwnedFd]) -> Result<()> {
    use std::os::unix::process::CommandExt;

    command.as_std_mut().process_group(0);
    let inherited_fds = inherited_fds
        .iter()
        .map(AsRawFd::as_raw_fd)
        .collect::<Vec<_>>();
    // Mark every non-stdio descriptor close-on-exec. This includes descriptors a caller may have
    // deliberately made inheritable while preserving Rust's private exec-error pipe until exec.
    unsafe {
        command.pre_exec(move || {
            #[cfg(target_os = "linux")]
            {
                let result = libc::syscall(
                    libc::SYS_close_range,
                    3_u32,
                    u32::MAX,
                    libc::CLOSE_RANGE_CLOEXEC,
                );
                if result == 0 {
                    for descriptor in &inherited_fds {
                        clear_close_on_exec(*descriptor)?;
                    }
                    return Ok(());
                }
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ENOSYS) {
                    return Err(error);
                }
            }

            let maximum = fd_scan_maximum()?;
            for descriptor in 3..maximum {
                if inherited_fds.contains(&(descriptor as libc::c_int)) {
                    clear_close_on_exec(descriptor as libc::c_int)?;
                    continue;
                }
                let flags = libc::fcntl(descriptor as libc::c_int, libc::F_GETFD);
                if flags >= 0
                    && libc::fcntl(
                        descriptor as libc::c_int,
                        libc::F_SETFD,
                        flags | libc::FD_CLOEXEC,
                    ) < 0
                {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    Ok(())
}

#[cfg(unix)]
fn fd_scan_maximum() -> std::io::Result<libc::c_int> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    fd_scan_maximum_from_rlimit(limit.rlim_cur)
}

#[cfg(unix)]
fn fd_scan_maximum_from_rlimit(limit: libc::rlim_t) -> std::io::Result<libc::c_int> {
    if limit == libc::RLIM_INFINITY {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "RLIMIT_NOFILE is infinite; cannot prove descriptor closure",
        ));
    }
    libc::c_int::try_from(limit).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "RLIMIT_NOFILE exceeds the descriptor number range",
        )
    })
}

#[cfg(unix)]
fn clear_close_on_exec(descriptor: libc::c_int) -> std::io::Result<()> {
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(unix))]
fn configure_process(_command: &mut Command, _inherited_fds: &[OwnedFd]) -> Result<()> {
    // NativeIsolationProvider rejects Windows before this point. A future Windows provider must
    // attach the process to a kill-on-close Job Object before this function can return success.
    Err(SproutError::IsolationUnavailable(
        "process-tree containment is unavailable on this platform".into(),
    ))
}

#[cfg(unix)]
async fn terminate_process_tree(child: &mut tokio::process::Child) {
    if let Some(identifier) = child.id()
        && let Ok(group) = i32::try_from(identifier)
    {
        // The child was placed in a fresh process group before exec. A negative PID addresses the
        // complete group; Bubblewrap's PID namespace then tears down even daemonized descendants.
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

#[cfg(not(unix))]
async fn terminate_process_tree(child: &mut tokio::process::Child) {
    let _ = child.start_kill();
    let _ = child.wait().await;
}

struct BoundedOutput {
    bytes: Vec<u8>,
    exceeded: bool,
}

async fn read_bounded(
    mut input: impl AsyncRead + Unpin,
    limit: usize,
    stream: &'static str,
    limit_sender: tokio::sync::mpsc::Sender<&'static str>,
) -> std::io::Result<BoundedOutput> {
    let mut stored = Vec::with_capacity(limit.min(8192));
    let mut buffer = [0_u8; 8192];
    let mut exceeded = false;
    loop {
        let count = input.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(stored.len());
        stored.extend_from_slice(&buffer[..count.min(remaining)]);
        if count > remaining && !exceeded {
            exceeded = true;
            let _ = limit_sender.send(stream).await;
        }
    }
    Ok(BoundedOutput {
        bytes: stored,
        exceeded,
    })
}

fn join_output(
    output: std::result::Result<std::io::Result<BoundedOutput>, tokio::task::JoinError>,
    stream: &'static str,
    limit: usize,
) -> Result<BoundedOutput> {
    let output = output
        .map_err(|error| SproutError::PluginSpawn(error.to_string()))?
        .map_err(|error| SproutError::PluginSpawn(error.to_string()))?;
    if output.exceeded {
        Err(SproutError::PluginOutputLimit { stream, limit })
    } else {
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, time::Duration};

    use tempfile::tempdir;
    use tokio::process::Command;

    #[cfg(unix)]
    use super::fd_scan_maximum_from_rlimit;
    use super::{
        ApplyLimits, IsolatedCommand, IsolationProvider, PluginRunner, ProtocolOutcome,
        TemplateProtocol,
    };

    #[cfg(unix)]
    #[test]
    fn descriptor_fallback_scans_the_complete_finite_rlimit() {
        assert_eq!(fd_scan_maximum_from_rlimit(2_000_000).unwrap(), 2_000_000);
        assert!(fd_scan_maximum_from_rlimit(libc::RLIM_INFINITY).is_err());
    }

    use crate::{ChangeKind, DeclaredChange, ErrorCode, Result, VerifiedExecutable};

    struct TestIsolation;

    impl IsolationProvider for TestIsolation {
        fn command(
            &self,
            executable: &VerifiedExecutable,
            _workspace: &Path,
        ) -> Result<IsolatedCommand> {
            Ok(IsolatedCommand::new(Command::new(executable.path())))
        }
    }

    struct JsonProtocol;

    impl TemplateProtocol<serde_json::Value> for JsonProtocol {
        fn encode_request(&self, request: &serde_json::Value) -> Result<Vec<u8>> {
            serde_json::to_vec(request)
                .map_err(|error| crate::SproutError::ProtocolViolation(error.to_string()))
        }

        fn decode_response(&self, response: &[u8]) -> Result<ProtocolOutcome> {
            let response: serde_json::Value = serde_json::from_slice(response)
                .map_err(|error| crate::SproutError::ProtocolViolation(error.to_string()))?;
            let declared_changes = response["changes"]
                .as_array()
                .ok_or_else(|| {
                    crate::SproutError::ProtocolViolation("changes must be an array".into())
                })?
                .iter()
                .map(|change| {
                    let path = change["path"].as_str().ok_or_else(|| {
                        crate::SproutError::ProtocolViolation("change path missing".into())
                    })?;
                    let kind = match change["kind"].as_str() {
                        Some("create") => ChangeKind::Create,
                        Some("modify") => ChangeKind::Modify,
                        Some("delete") => ChangeKind::Delete,
                        _ => {
                            return Err(crate::SproutError::ProtocolViolation(
                                "change kind invalid".into(),
                            ));
                        }
                    };
                    Ok(DeclaredChange {
                        path: path.to_owned(),
                        kind,
                        before_sha256: None,
                        after_sha256: (kind == ChangeKind::Create)
                            .then(|| crate::Sha256Digest::from_bytes(b"created").to_string()),
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(ProtocolOutcome {
                declared_changes,
                response,
            })
        }
    }

    #[cfg(unix)]
    fn executable(script: &str) -> (tempfile::TempDir, VerifiedExecutable) {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let path = directory.path().join("plugin");
        fs::write(&path, format!("#!/bin/sh\nset -eu\n{script}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        (directory, VerifiedExecutable::for_test(path))
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn applies_and_validates_the_exact_diff() {
        let workspace = tempdir().unwrap();
        let (_plugin_dir, plugin) = executable(
            r#"cat >/dev/null
printf created > generated.txt
printf '{"changes":[{"path":"generated.txt","kind":"create"}]}'"#,
        );
        let result = PluginRunner::new(TestIsolation, ApplyLimits::default())
            .apply(
                &plugin,
                workspace.path(),
                &JsonProtocol,
                &serde_json::json!({"version": 1}),
            )
            .await
            .unwrap();
        assert_eq!(result.changes.len(), 1);
        assert_eq!(result.changes[0].kind, ChangeKind::Create);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unreported_diff_is_rejected() {
        let workspace = tempdir().unwrap();
        let (_plugin_dir, plugin) = executable(
            r#"cat >/dev/null
printf surprise > surprise.txt
printf '{"changes":[]}'"#,
        );
        let error = PluginRunner::new(TestIsolation, ApplyLimits::default())
            .apply(
                &plugin,
                workspace.path(),
                &JsonProtocol,
                &serde_json::json!({}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::DiffMismatch);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn plugin_environment_contains_only_the_locale_allowlist() {
        let workspace = tempdir().unwrap();
        let (_plugin_dir, plugin) = executable(
            r#"cat >/dev/null
test -z "${HOME+x}${AWS_ACCESS_KEY_ID+x}${GITHUB_TOKEN+x}"
test "$LANG" = C
test "$LC_ALL" = C
printf '{"changes":[]}'"#,
        );
        PluginRunner::new(TestIsolation, ApplyLimits::default())
            .apply(
                &plugin,
                workspace.path(),
                &JsonProtocol,
                &serde_json::json!({}),
            )
            .await
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn preexisting_hardlink_is_rejected_before_plugin_execution() {
        let outside = tempdir().unwrap();
        let canary = outside.path().join("credential");
        fs::write(&canary, b"secret").unwrap();
        let workspace = tempdir().unwrap();
        fs::hard_link(&canary, workspace.path().join("linked")).unwrap();
        let (_plugin_dir, plugin) = executable(
            r#"printf mutated > linked
printf ran > ran
printf '{"changes":[]}'"#,
        );
        let error = PluginRunner::new(TestIsolation, ApplyLimits::default())
            .apply(
                &plugin,
                workspace.path(),
                &JsonProtocol,
                &serde_json::json!({}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::WorkspaceRejected);
        assert_eq!(fs::read(canary).unwrap(), b"secret");
        assert!(!workspace.path().join("ran").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn deadline_kills_slow_plugin() {
        let workspace = tempdir().unwrap();
        let (_plugin_dir, plugin) = executable("cat >/dev/null\nsleep 5");
        let limits = ApplyLimits {
            timeout: Duration::from_millis(50),
            ..ApplyLimits::default()
        };
        let error = PluginRunner::new(TestIsolation, limits)
            .apply(
                &plugin,
                workspace.path(),
                &JsonProtocol,
                &serde_json::json!({}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::PluginTimeout);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn deadline_kills_the_plugin_process_group() {
        let workspace = tempdir().unwrap();
        let (_plugin_dir, plugin) = executable("sleep 30 &\necho $! > child.pid\nwait");
        let limits = ApplyLimits {
            timeout: Duration::from_secs(2),
            ..ApplyLimits::default()
        };
        let error = PluginRunner::new(TestIsolation, limits)
            .apply(
                &plugin,
                workspace.path(),
                &JsonProtocol,
                &serde_json::json!({}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::PluginTimeout);
        let process: i32 = fs::read_to_string(workspace.path().join("child.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        for _ in 0..50 {
            if unsafe { libc::kill(process, 0) } < 0
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("plugin descendant {process} survived the deadline");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn output_is_drained_but_rejected_at_limit() {
        let workspace = tempdir().unwrap();
        let (_plugin_dir, plugin) = executable("cat >/dev/null\nyes x | head -c 4096");
        let limits = ApplyLimits {
            max_stdout_bytes: 128,
            ..ApplyLimits::default()
        };
        let error = PluginRunner::new(TestIsolation, limits)
            .apply(
                &plugin,
                workspace.path(),
                &JsonProtocol,
                &serde_json::json!({}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::PluginOutputLimit);
    }

    #[test]
    fn declared_change_shape_is_owned_by_the_protocol_adapter() {
        let outcome = ProtocolOutcome {
            declared_changes: vec![DeclaredChange {
                path: "file".into(),
                kind: ChangeKind::Create,
                before_sha256: None,
                after_sha256: Some(crate::Sha256Digest::from_bytes(b"file").to_string()),
            }],
            response: serde_json::json!({"protocolVersion": 1}),
        };
        assert_eq!(outcome.declared_changes.len(), 1);
    }

    #[test]
    fn canonical_adapter_preserves_reported_digests() {
        let digest = crate::Sha256Digest::from_bytes(b"created").to_string();
        let response = serde_json::json!({
            "status": "ok",
            "protocol_version": 1,
            "changes": [{
                "path": "generated.txt",
                "kind": "created",
                "before_sha256": null,
                "after_sha256": digest,
            }],
            "warnings": [],
        });
        let outcome = super::CanonicalProtocol
            .decode_response(&serde_json::to_vec(&response).unwrap())
            .unwrap();
        assert_eq!(outcome.declared_changes[0].after_sha256, Some(digest));
    }

    #[test]
    fn canonical_structured_plugin_error_is_not_a_successful_empty_diff() {
        let response = serde_json::json!({
            "status": "error",
            "protocol_version": 1,
            "error": {
                "code": "unsupported_upstream",
                "message": "commit is not supported",
            },
        });
        let error = super::CanonicalProtocol
            .decode_response(&serde_json::to_vec(&response).unwrap())
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::TemplateRejected);
    }
}
