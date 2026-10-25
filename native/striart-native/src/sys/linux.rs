//! Linux : `/proc` (stat, cmdline) et descripteurs de process (`pidfd`,
//! noyau 5.3+) pour un kill sans fenêtre de recyclage.
//!
//! Heure de création : `starttime` de /proc/<pid>/stat (ticks depuis le
//! boot, horloge CLOCK_BOOTTIME depuis Linux 5.3) + heure du boot calculée
//! comme horloge murale − CLOCK_BOOTTIME. Précision : un tick (10 ms).

use super::{Entry, Info, KillOutcome, same_start_time};
use crate::protocol::NativeError;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::OnceLock;

pub const USES_PROCESS_GROUPS: bool = true;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stat {
    pub comm: String,
    pub state: char,
    pub ppid: u32,
    pub pgrp: u32,
    pub session: u32,
    pub start_ticks: u64,
}

/// Analyse /proc/<pid>/stat. Le nom (champ 2) est entre parenthèses et peut
/// en contenir : on coupe à la DERNIÈRE parenthèse fermante.
pub fn parse_stat(text: &str) -> Option<Stat> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    let comm = text.get(open + 1..close)?.to_string();
    let fields: Vec<&str> = text.get(close + 2..)?.split(' ').collect();
    let number = |i: usize| fields.get(i)?.parse::<u64>().ok();
    Some(Stat {
        comm,
        state: fields.first()?.chars().next()?,
        ppid: u32::try_from(number(1)?).ok()?,
        pgrp: u32::try_from(number(2)?).ok()?,
        session: u32::try_from(number(3)?).ok()?,
        start_ticks: number(19)?,
    })
}

fn read_stat(pid: u32) -> Option<Stat> {
    parse_stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

fn clock_ticks_per_second() -> u64 {
    static HZ: OnceLock<u64> = OnceLock::new();
    *HZ.get_or_init(|| {
        // SAFETY: sysconf sans pointeur.
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        u64::try_from(hz).ok().filter(|h| *h > 0).unwrap_or(100)
    })
}

fn clock_ms(clock: libc::clockid_t) -> Option<u64> {
    // SAFETY: timespec est une structure C ; clock_gettime l'écrit.
    let mut ts: libc::timespec = unsafe { std::mem::zeroed() };
    // SAFETY: `ts` inscriptible, horloge valide.
    if unsafe { libc::clock_gettime(clock, &mut ts) } != 0 {
        return None;
    }
    let secs = u64::try_from(ts.tv_sec).ok()?;
    let nanos = u64::try_from(ts.tv_nsec).ok()?;
    Some(secs * 1_000 + nanos / 1_000_000)
}

/// Heure du boot (ms epoch), calculée une fois par exécution : toutes les
/// heures de création d'un même appel partagent la même base.
fn boot_ms() -> Option<u64> {
    static BOOT: OnceLock<Option<u64>> = OnceLock::new();
    *BOOT.get_or_init(|| {
        let wall = clock_ms(libc::CLOCK_REALTIME)?;
        let since_boot = clock_ms(libc::CLOCK_BOOTTIME)?;
        wall.checked_sub(since_boot)
    })
}

pub fn ticks_to_ms(ticks: u64, boot: u64, hz: u64) -> u64 {
    boot + ticks.saturating_mul(1_000) / hz
}

fn start_ms(stat: &Stat) -> Option<u64> {
    Some(ticks_to_ms(
        stat.start_ticks,
        boot_ms()?,
        clock_ticks_per_second(),
    ))
}

fn read_cmdline(pid: u32) -> Vec<String> {
    std::fs::read(format!("/proc/{pid}/cmdline"))
        .map(|bytes| {
            bytes
                .split(|b| *b == 0)
                .filter(|part| !part.is_empty())
                .map(|part| String::from_utf8_lossy(part).into_owned())
                .collect()
        })
        .unwrap_or_default()
}

pub fn snapshot() -> Result<Vec<Entry>, NativeError> {
    let dir = std::fs::read_dir("/proc")
        .map_err(|e| NativeError::failure("SNAPSHOT_FAILED", format!("/proc unreadable: {e}")))?;
    let mut entries = Vec::with_capacity(512);
    for item in dir.flatten() {
        let Some(pid) = item
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        // Process disparu entre la liste et la lecture : simplement absent.
        let Some(stat) = read_stat(pid) else { continue };
        entries.push(Entry {
            pid,
            ppid: (stat.ppid != 0).then_some(stat.ppid),
            start_ms: start_ms(&stat),
            pgid: Some(stat.pgrp),
            sid: Some(stat.session),
            zombie: stat.state == 'Z' || stat.state == 'X',
        });
    }
    Ok(entries)
}

pub fn infos(pids: &[u32]) -> Result<Vec<Info>, NativeError> {
    Ok(pids
        .iter()
        .filter_map(|&pid| {
            let stat = read_stat(pid)?;
            let args = read_cmdline(pid);
            Some(Info {
                pid,
                ppid: (stat.ppid != 0).then_some(stat.ppid),
                // argv[0] tel que lancé (`-bash`, `/usr/bin/node`) ; sans
                // cmdline (thread noyau, zombie), le nom court du noyau.
                name: args.first().cloned().unwrap_or_else(|| stat.comm.clone()),
                command_line: super::join_command_line(&args),
                start_ms: start_ms(&stat),
            })
        })
        .collect())
}

fn pidfd_open(pid: u32) -> Result<OwnedFd, i32> {
    // SAFETY: appel système sans pointeur.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::c_long, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(0));
    }
    let raw = libc::c_int::try_from(fd).map_err(|_| libc::EBADF)?;
    // SAFETY: descripteur fraîchement ouvert, possédé par nous seuls.
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

fn identity(pid: u32, expected_start: Option<u64>) -> Result<(), KillOutcome> {
    let Some(stat) = read_stat(pid) else {
        return Err(KillOutcome::Gone);
    };
    if stat.state == 'Z' || stat.state == 'X' {
        return Err(KillOutcome::Gone);
    }
    if let Some(expected) = expected_start {
        match start_ms(&stat) {
            Some(actual) if same_start_time(actual, expected) => {}
            Some(_) => return Err(KillOutcome::Mismatch),
            None => return Err(KillOutcome::Failed("creation time unreadable".into())),
        }
    }
    Ok(())
}

/// Envoie `signal` à `pid` si c'est toujours le process attendu. Avec un
/// pidfd, le process est épinglé AVANT la vérification : le numéro ne peut
/// plus être recyclé entre la vérification et le signal. Sans pidfd (noyau
/// < 5.3), vérification puis `kill(2)`.
pub fn signal_verified(
    pid: u32,
    expected_start: Option<u64>,
    signal: libc::c_int,
    wait: bool,
) -> KillOutcome {
    if pid <= 1 || pid == std::process::id() {
        return KillOutcome::Failed("refusing to signal init or itself".into());
    }
    match pidfd_open(pid) {
        Ok(fd) => {
            if let Err(outcome) = identity(pid, expected_start) {
                return outcome;
            }
            // SAFETY: descripteur valide ; pas de siginfo (NULL), flags nuls.
            let rc = unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    fd.as_raw_fd(),
                    signal,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                )
            };
            if rc != 0 {
                return match std::io::Error::last_os_error().raw_os_error() {
                    Some(libc::ESRCH) => KillOutcome::Gone,
                    Some(libc::EPERM) => KillOutcome::Failed("permission denied".into()),
                    _ => KillOutcome::Failed(std::io::Error::last_os_error().to_string()),
                };
            }
            if wait {
                let mut poll = libc::pollfd {
                    fd: fd.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                let timeout = super::unix::KILL_WAIT.as_millis() as libc::c_int;
                // SAFETY: un pollfd valide ; le pidfd devient lisible à la mort.
                unsafe { libc::poll(&mut poll, 1, timeout) };
            }
            KillOutcome::Killed
        }
        Err(libc::ESRCH) => KillOutcome::Gone,
        Err(_) => {
            if let Err(outcome) = identity(pid, expected_start) {
                return outcome;
            }
            let outcome = super::unix::send_signal(pid, signal);
            if wait && outcome == KillOutcome::Killed {
                super::unix::wait_until_dead(pid, |p| {
                    read_stat(p).is_none_or(|s| s.state == 'Z' || s.state == 'X')
                });
            }
            outcome
        }
    }
}

pub fn kill_verified(pid: u32, expected_start: Option<u64>) -> KillOutcome {
    signal_verified(pid, expected_start, libc::SIGKILL, true)
}

/// Ce process devient le « subreaper » de ses descendants : un orphelin est
/// reparenté sous lui plutôt que sous init, même s'il quitte le groupe.
pub fn become_subreaper() -> Result<(), NativeError> {
    // SAFETY: prctl sans pointeur.
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        return Err(NativeError::os(
            "SUBREAPER_FAILED",
            "prctl(PR_SET_CHILD_SUBREAPER)",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_avec_parentheses_dans_le_nom() {
        let line = "4242 (a) b (c)) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 98765 1000 10 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0";
        let stat = parse_stat(line).expect("parse");
        assert_eq!(stat.comm, "a) b (c)");
        assert_eq!(stat.state, 'S');
        assert_eq!(stat.ppid, 1);
        assert_eq!(stat.pgrp, 4242);
        assert_eq!(stat.session, 4242);
        assert_eq!(stat.start_ticks, 98765);
        assert_eq!(parse_stat("garbage"), None);
    }

    #[test]
    fn conversion_ticks() {
        assert_eq!(ticks_to_ms(250, 1_000_000, 100), 1_002_500);
    }
}
