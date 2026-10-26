//! `job run` sous POSIX : nouveau groupe de process pour le programme ; sous
//! Linux, `striart-native` devient « child subreaper » (les orphelins du job
//! sont reparentés sous lui, même s'ils quittent le groupe par `setsid`) et
//! le programme reçoit `PR_SET_PDEATHSIG = SIGKILL` (tué si `striart-native`
//! meurt sans avoir pu nettoyer).
//!
//! Membres du conteneur, à chaque instant : le programme, les membres de son
//! groupe et de sa session, et tous les descendants (par parent, ordre des
//! créations vérifié) du programme, de ces membres et — sous Linux — du
//! process courant. Sous macOS, faute de subreaper, les descendants observés
//! pendant l'exécution (échantillonnés) restent suivis après la mort de leur
//! parent : un orphelin qui aurait quitté le groupe est encore retrouvé.

use super::{GRACE_POLL_MS, POLL_MS, Report};
use crate::cli::JobSpec;
use crate::protocol::{NativeError, exit};
use crate::sys::{self, Entry, KillOutcome, unix};
use crate::tree_kill::{self, Member};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// Passes maximales de nettoyage (un job qui engendre plus vite qu'on ne tue).
const MAX_KILL_ROUNDS: usize = 8;
/// Intervalle d'échantillonnage des descendants (macOS).
#[cfg(target_os = "macos")]
const TRACK_EVERY: Duration = Duration::from_millis(100);

struct Container {
    self_pid: u32,
    self_start: Option<u64>,
    child_pid: u32,
    child_start: Option<u64>,
    /// Descendants déjà observés (macOS) — parents connus même morts.
    tracked: Vec<Member>,
}

impl Container {
    /// Membres vivants du conteneur dans `table` (programme compris s'il vit).
    fn members(&self, table: &[Entry]) -> Vec<Entry> {
        let mut parents = vec![Member {
            pid: self.self_pid,
            start_ms: self.self_start,
        }];
        parents.extend(self.tracked.iter().copied());
        let (_, mut selected) = tree_kill::select(
            table,
            self.child_pid,
            self.child_start,
            &parents,
            self.self_pid,
            true,
        );
        // Suivis encore vivants (même numéro, même heure de création) : un
        // orphelin sorti du groupe reste un membre.
        for member in &self.tracked {
            let alive = table
                .iter()
                .find(|e| e.pid == member.pid && !e.zombie && e.start_ms == member.start_ms);
            if let Some(entry) = alive
                && !selected.iter().any(|s| s.pid == entry.pid)
            {
                selected.push(entry.clone());
            }
        }
        selected
    }

    #[cfg(target_os = "macos")]
    fn track(&mut self) {
        let Ok(table) = sys::snapshot() else { return };
        for entry in self.members(&table) {
            if entry.pid == self.child_pid {
                continue;
            }
            let member = Member {
                pid: entry.pid,
                start_ms: entry.start_ms,
            };
            if !self.tracked.contains(&member) {
                self.tracked.push(member);
            }
        }
    }

    /// Membres vivants hors programme direct (les orphelins potentiels).
    fn descendants_alive(&self) -> Result<Vec<Entry>, NativeError> {
        let table = sys::snapshot()?;
        reap(&table, self);
        Ok(self
            .members(&table)
            .into_iter()
            .filter(|e| e.pid != self.child_pid)
            .collect())
    }

    /// Tue tous les membres vivants, en plusieurs passes ; rend les PID tués
    /// et les survivants (membres encore vivants après la dernière passe).
    fn kill_all(&self) -> Result<(Vec<u32>, Vec<u32>), NativeError> {
        let mut killed: Vec<u32> = Vec::new();
        for _ in 0..MAX_KILL_ROUNDS {
            let table = sys::snapshot()?;
            reap(&table, self);
            let targets: Vec<Entry> = self
                .members(&table)
                .into_iter()
                .filter(|e| !killed.contains(&e.pid))
                .collect();
            if targets.is_empty() {
                break;
            }
            // Descendants AVANT leurs ancêtres : tuer le parent d'un descendant
            // arrêté (SIGSTOP) orpheline son groupe, et le noyau lui envoie alors
            // SIGHUP+SIGCONT (règle POSIX des groupes orphelins) — il meurt avant
            // notre SIGKILL, répond `Gone` et n'est jamais compté (observé sous macOS).
            for target in targets.iter().rev() {
                unix::stop_verified(target.pid, target.start_ms);
            }
            let mut progressed = false;
            for target in targets.iter().rev() {
                if sys::kill_verified(target.pid, target.start_ms) == KillOutcome::Killed {
                    killed.push(target.pid);
                    progressed = true;
                }
            }
            if !progressed {
                break;
            }
        }
        // Relecture finale : ce qui est encore membre a survécu. Table
        // illisible → erreur franche, jamais « aucun survivant ».
        let table = sys::snapshot()?;
        reap(&table, self);
        let survivors = self
            .members(&table)
            .into_iter()
            .map(|e| e.pid)
            .filter(|pid| *pid != self.self_pid)
            .collect();
        Ok((killed, survivors))
    }
}

/// Collecte les zombies reparentés sous nous (Linux subreaper), jamais le
/// programme direct (collecté par `Child`).
fn reap(table: &[Entry], container: &Container) {
    unix::reap_zombie_children(table, container.self_pid, Some(container.child_pid));
}

fn spawn(spec: &JobSpec) -> Result<Child, NativeError> {
    let mut command = Command::new(&spec.argv[0]);
    command
        .args(&spec.argv[1..])
        .process_group(0)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(target_os = "linux")]
    {
        // SAFETY: getpid sans pointeur.
        let parent = unsafe { libc::getpid() };
        // SAFETY: la fermeture n'appelle que des fonctions async-signal-safe
        // (prctl, getppid, pthread_sigmask) entre fork et exec.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // Le parent est mort avant le prctl : le signal ne viendra
                // jamais, on n'exécute pas un orphelin.
                if libc::getppid() != parent {
                    return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
                }
                unix::unblock_all_signals()
            })
        };
    }
    command.spawn().map_err(|e| {
        NativeError::failure(
            "SPAWN_FAILED",
            format!("cannot start {}: {e}", spec.argv[0].to_string_lossy()),
        )
    })
}

fn start_of(pid: u32) -> Option<u64> {
    sys::snapshot()
        .ok()?
        .into_iter()
        .find(|e| e.pid == pid)
        .and_then(|e| e.start_ms)
}

fn record_status(report: &mut Report, status: ExitStatus) {
    report.exit_code = status.code().map(i64::from);
    report.signal = status.signal().map(unix::signal_name);
}

pub fn run_job(spec: &JobSpec) -> Result<(Report, i32), NativeError> {
    unix::watch_interruptions()?;
    #[cfg(target_os = "linux")]
    sys::become_subreaper()?;

    let started = Instant::now();
    let self_pid = std::process::id();
    let mut child = spawn(spec)?;
    let child_pid = child.id();
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut container = Container {
        self_pid,
        self_start: start_of(self_pid),
        child_pid,
        child_start: start_of(child_pid),
        tracked: Vec::new(),
    };
    let deadline = spec
        .timeout_ms
        .map(|ms| started + Duration::from_millis(ms));
    let mut report = Report {
        pid: child_pid,
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
    #[cfg(target_os = "macos")]
    let mut last_track = Instant::now();

    let exited = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| NativeError::failure("WAIT_FAILED", format!("wait: {e}")))?
        {
            record_status(&mut report, status);
            break true;
        }
        if let Some(signal) = unix::interruption() {
            report.interrupted = Some(unix::signal_name(signal));
            code = exit::SIGNAL_BASE + signal;
            break false;
        }
        if deadline.is_some_and(|d| Instant::now() >= d) {
            report.timed_out = true;
            break false;
        }
        #[cfg(target_os = "macos")]
        if last_track.elapsed() >= TRACK_EVERY {
            container.track();
            last_track = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(POLL_MS));
    };

    if exited {
        let grace_end = Instant::now() + Duration::from_millis(spec.grace_ms);
        while !container.descendants_alive()?.is_empty() && Instant::now() < grace_end {
            if unix::interruption().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(GRACE_POLL_MS));
        }
        let (killed, survivors) = container.kill_all()?;
        report.orphan_pids = killed;
        report.survivor_pids = survivors;
    } else {
        let (killed, survivors) = container.kill_all()?;
        report.killed_pids = killed;
        report.survivor_pids = survivors;
        // Le programme est mort (tué ci-dessus) ou mourra du SIGKILL de son
        // groupe : sa collecte est immédiate.
        let _ = child.kill();
        if let Ok(status) = child.wait() {
            record_status(&mut report, status);
        }
    }
    if report.interrupted.is_none()
        && let Some(signal) = unix::interruption()
    {
        report.interrupted = Some(unix::signal_name(signal));
        code = exit::SIGNAL_BASE + signal;
    }
    report.duration_ms = started.elapsed().as_millis() as u64;
    Ok((report, code))
}
