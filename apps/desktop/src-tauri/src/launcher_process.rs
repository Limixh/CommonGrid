//! Only the supervisor calls this module; no executable/argument IPC exists.
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
};

pub(crate) struct OwnedWorker {
    pub child: Child,
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}
#[cfg(windows)]
unsafe impl Send for OwnedWorker {}

pub(crate) fn regular(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file() || reparse(&metadata) {
        return false;
    }
    true
}
fn reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}
pub(crate) fn safe_ancestors(path: &Path) -> bool {
    path.is_absolute()
        && path.components().all(|part| {
            !matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
        && path.ancestors().all(|ancestor| {
            fs::symlink_metadata(ancestor)
                .is_ok_and(|metadata| metadata.is_dir() && !reparse(&metadata))
        })
}
fn create_home(path: &Path) -> io::Result<()> {
    if !path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err(io::Error::other("unsafe_worker_home"));
    }
    let mut ancestors = path.ancestors().collect::<Vec<_>>();
    ancestors.reverse();
    for ancestor in ancestors {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.is_dir() && !reparse(&metadata) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(ancestor)?;
                if !safe_ancestors(ancestor) {
                    return Err(io::Error::other("unsafe_worker_home"));
                }
            }
            _ => return Err(io::Error::other("unsafe_worker_home")),
        }
    }
    Ok(())
}

fn docker_directory() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "docker.exe"
    } else {
        "docker"
    };
    std::env::var_os("PATH").and_then(|value| {
        std::env::split_paths(&value)
            .filter(|directory| directory.is_absolute())
            .find_map(|directory| {
                let source = directory.join(name);
                let resolved = fs::canonicalize(source).ok()?;
                (regular(&resolved) && resolved.parent().is_some_and(safe_ancestors))
                    .then(|| resolved.parent().unwrap().to_path_buf())
            })
    })
}

impl OwnedWorker {
    pub fn spawn(node: &Path, worker: &Path, home: &Path) -> io::Result<Self> {
        if !node.parent().is_some_and(safe_ancestors)
            || !worker.parent().is_some_and(safe_ancestors)
        {
            return Err(io::Error::other("unsafe_worker_resources"));
        }
        // Preflight all existing children before creating any new directories.
        for name in ["docker", "tmp", "config", "data", "cache"] {
            let target = home.join(name);
            if let Ok(metadata) = fs::symlink_metadata(target) {
                if !metadata.is_dir() || reparse(&metadata) {
                    return Err(io::Error::other("unsafe_worker_home"));
                }
            }
        }
        create_home(home)?;
        for name in ["docker", "tmp", "config", "data", "cache"] {
            create_home(&home.join(name))?;
        }
        // This version-only lane needs the daemon's default endpoint, not host
        // Docker contexts, credential helpers or account configuration. Reject
        // preexisting entries without opening their contents (including links).
        if fs::read_dir(home.join("docker"))?.next().is_some() {
            return Err(io::Error::other("worker_docker_config_not_empty"));
        }
        let mut command = Command::new(node);
        command
            .arg(worker)
            .current_dir(home)
            .env_clear()
            .env("HOME", home)
            .env("USERPROFILE", home)
            .env("XDG_CONFIG_HOME", home.join("config"))
            .env("XDG_DATA_HOME", home.join("data"))
            .env("XDG_CACHE_HOME", home.join("cache"))
            .env("DOCKER_CONFIG", home.join("docker"))
            .env("TEMP", home.join("tmp"))
            .env("TMP", home.join("tmp"))
            .env("TMPDIR", home.join("tmp"))
            .env("CG_NATIVE_SUPERVISED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut paths = Vec::new();
        if let Some(directory) = docker_directory() {
            paths.push(directory);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
            let system = std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .ok_or_else(|| io::Error::other("system_root_unavailable"))?;
            command.env("SystemRoot", &system).env("WINDIR", &system);
            paths.push(system.join("System32"));
            paths.push(system);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
            paths.extend([PathBuf::from("/usr/bin"), PathBuf::from("/bin")]);
            command.env("LANG", "C.UTF-8");
        }
        command.env(
            "PATH",
            std::env::join_paths(paths).map_err(io::Error::other)?,
        );
        let mut child = command.spawn()?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
            // The trusted worker performs no work until its boot frame. Assign
            // its existing process handle before that frame, never a PID lookup.
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let assigned = !job.is_null()
                && unsafe {
                    SetInformationJobObject(
                        job,
                        JobObjectExtendedLimitInformation,
                        &limits as *const _ as *const _,
                        std::mem::size_of_val(&limits) as u32,
                    ) != 0
                        && AssignProcessToJobObject(job, child.as_raw_handle() as _) != 0
                };
            if !assigned {
                let error = io::Error::last_os_error();
                let _ = child.kill();
                let _ = child.wait();
                if !job.is_null() {
                    unsafe {
                        CloseHandle(job);
                    }
                }
                return Err(error);
            }
            Ok(Self { child, job })
        }
        #[cfg(not(windows))]
        {
            Ok(Self { child })
        }
    }
    pub fn terminate(&mut self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
        }
        #[cfg(unix)]
        {
            // Call only before observing/reaping root exit. Never retry a saved
            // numeric PID after exit; descendants may keep output pipes open.
            unsafe {
                libc::kill(-(self.child.id() as i32), libc::SIGKILL);
            }
        }
        let _ = self.child.kill();
    }
    pub fn poll(&mut self) -> io::Result<Option<ExitStatus>> {
        #[cfg(unix)]
        {
            // Observe exit without reaping: the zombie root still reserves its
            // process-group identity while we terminate inherited descendants.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let status = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.child.id(),
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if status != 0 {
                return Err(io::Error::last_os_error());
            }
            if unsafe { info.si_pid() } == 0 {
                return Ok(None);
            }
            self.terminate();
        }
        self.child.try_wait()
    }
}
impl Drop for OwnedWorker {
    fn drop(&mut self) {
        if matches!(self.poll(), Ok(None)) {
            self.terminate();
        }
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}
