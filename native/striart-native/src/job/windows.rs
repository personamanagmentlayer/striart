//! `job run` sous Windows : Job Object `KILL_ON_JOB_CLOSE`.
//!
//! Le programme est créé suspendu (`CREATE_SUSPENDED`), affecté au job, puis
//! repris : il ne peut rien engendrer hors du job. `striart-native` lui-même
//! reste HORS du job — `TerminateJobObject` ne le frappe pas — mais détient
//! le seul handle : s'il meurt (tué par l'appelant, crash), le noyau ferme le
//! handle et tue tout le job.

use super::{GRACE_POLL_MS, POLL_MS, Report};
use crate::cli::JobSpec;
use crate::protocol::{NativeError, exit};
use crate::sys::job_object::{active_processes, create_job, terminate_job};
use crate::sys::{self, OwnedHandle};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};
use windows_sys::Win32::System::Console::{
    CTRL_BREAK_EVENT, CTRL_C_EVENT, CTRL_CLOSE_EVENT, SetConsoleCtrlHandler,
};
use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;

/// Événement console reçu (0 = aucun), +1 pour distinguer CTRL_C_EVENT (0).
static INTERRUPTED: AtomicU32 = AtomicU32::new(0);

/// Vrai une fois le rapport écrit (voir `report_written`).
static REPORT_WRITTEN: AtomicBool = AtomicBool::new(false);
/// Windows termine le process quand le gestionnaire de `CTRL_CLOSE_EVENT`
/// rend la main, et au plus tard ~5 s après : on attend donc, sans dépasser
/// ce budget, que la boucle principale ait tué le job ET écrit le rapport.
const CLOSE_EVENT_WAIT: Duration = Duration::from_millis(4_500);

/// Signale au gestionnaire console que le rapport est sur disque.
pub fn report_written() {
    REPORT_WRITTEN.store(true, Ordering::SeqCst);
}

unsafe extern "system" fn on_console_event(event: u32) -> windows_sys::core::BOOL {
    match event {
        CTRL_C_EVENT | CTRL_BREAK_EVENT => {
            INTERRUPTED.store(event + 1, Ordering::SeqCst);
            1 // traité : la boucle principale tue le job puis sort
        }
        CTRL_CLOSE_EVENT => {
            INTERRUPTED.store(event + 1, Ordering::SeqCst);
            // Fermeture de la console : ne pas rendre la main avant que le
            // rapport soit écrit, sinon Windows tue le process avant qu'il
            // ait pu dire ce qu'il a fait du job.
            let deadline = Instant::now() + CLOSE_EVENT_WAIT;
            while !REPORT_WRITTEN.load(Ordering::SeqCst) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            1
        }
        _ => 0,
    }
}

fn interruption() -> Option<(&'static str, i32)> {
    match INTERRUPTED.load(Ordering::SeqCst) {
        0 => None,
        v if v == CTRL_C_EVENT + 1 => Some(("CTRL_C", exit::SIGNAL_BASE + 2)),
        v if v == CTRL_BREAK_EVENT + 1 => Some(("CTRL_BREAK", exit::SIGNAL_BASE + 3)),
        _ => Some(("CTRL_CLOSE", exit::SIGNAL_BASE + 1)),
    }
}

fn spawn_in_job(spec: &JobSpec, job: &OwnedHandle) -> Result<Child, NativeError> {
    let mut command = Command::new(&spec.argv[0]);
    for arg in &spec.argv[1..] {
        if spec.verbatim_args {
            command.raw_arg(arg);
        } else {
            command.arg(arg);
        }
    }
    command
        .creation_flags(CREATE_SUSPENDED)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let mut child = command.spawn().map_err(|e| {
        NativeError::failure(
            "SPAWN_FAILED",
            format!("cannot start {}: {e}", spec.argv[0].to_string_lossy()),
        )
    })?;
    let abort = |child: &mut Child, error: NativeError| {
        let _ = child.kill();
        let _ = child.wait();
        Err(error)
    };
    // SAFETY: job et handle de process valides (le process est suspendu).
    if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle()) } == 0 {
        let error = NativeError::os("JOB_ASSIGN_FAILED", "AssignProcessToJobObject");
        return abort(&mut child, error);
    }
    match sys::resume_process_threads(child.id()) {
        Ok(0) => abort(
            &mut child,
            NativeError::failure("SPAWN_FAILED", "no thread to resume in the new process"),
        ),
        Ok(_) => Ok(child),
        Err(error) => abort(&mut child, error),
    }
}

pub fn run_job(spec: &JobSpec) -> Result<(Report, i32), NativeError> {
    let job = create_job()?;
    // SAFETY: gestionnaire `extern "system"` statique, valide toute la vie du process.
    unsafe { SetConsoleCtrlHandler(Some(on_console_event), 1) };
    let started = Instant::now();
    let mut child = spawn_in_job(spec, &job)?;
    let pid = child.id();
    let deadline = spec
        .timeout_ms
        .map(|ms| started + Duration::from_millis(ms));

    let mut report = Report {
        pid,
        exit_code: None,
        signal: None,
        timed_out: false,
        interrupted: None,
        orphan_pids: Vec::new(),
        killed_pids: Vec::new(),
        survivor_pids: Vec::new(),
        grace_ms: spec.grace_ms,
        duration_ms: 0,
    };
    let mut code = exit::OK;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| NativeError::failure("WAIT_FAILED", format!("wait: {e}")))?
        {
            report.exit_code = status.code().map(|c| i64::from(c as u32));
            break;
        }
        if let Some((event, exit_code)) = interruption() {
            report.interrupted = Some(event.to_string());
            code = exit_code;
            break;
        }
        if deadline.is_some_and(|d| Instant::now() >= d) {
            report.timed_out = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(POLL_MS));
    }

    if report.exit_code.is_some() {
        // Délai de grâce : les descendants qui finissent seuls ne sont pas des
        // orphelins.
        let grace_end = Instant::now() + Duration::from_millis(spec.grace_ms);
        while active_processes(&job) != 0 && Instant::now() < grace_end {
            std::thread::sleep(Duration::from_millis(GRACE_POLL_MS));
        }
        let ended = terminate_job(&job)?;
        report.orphan_pids = ended.killed;
        report.survivor_pids = ended.survivors;
    } else {
        let ended = terminate_job(&job)?;
        report.killed_pids = ended.killed;
        report.survivor_pids = ended.survivors;
        if let Ok(status) = child.wait() {
            report.exit_code = status.code().map(|c| i64::from(c as u32));
        }
    }
    report.duration_ms = started.elapsed().as_millis() as u64;
    Ok((report, code))
}
