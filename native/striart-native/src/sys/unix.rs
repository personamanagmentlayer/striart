//! Primitives POSIX communes à Linux et macOS : signaux vérifiés, collecte
//! des zombies, surveillance des signaux d'interruption.

use super::{Entry, KillOutcome};
use crate::protocol::NativeError;
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

/// Attente de la mort effective d'un process tué.
pub const KILL_WAIT: Duration = Duration::from_secs(5);

/// Gèle `pid` (SIGSTOP) si c'est toujours le process attendu.
pub fn stop_verified(pid: u32, expected_start: Option<u64>) -> KillOutcome {
    super::signal_verified(pid, expected_start, libc::SIGSTOP, false)
}

/// Attente bornée de la disparition (ou de l'état zombie) de `pid`, pour les
/// plateformes sans descripteur de process.
pub fn wait_until_dead(pid: u32, is_dead: impl Fn(u32) -> bool) {
    let deadline = Instant::now() + KILL_WAIT;
    while !is_dead(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// `kill(2)` avec traduction de l'erreur.
pub fn send_signal(pid: u32, signal: libc::c_int) -> KillOutcome {
    let Ok(raw) = libc::pid_t::try_from(pid) else {
        return KillOutcome::Gone;
    };
    // SAFETY: appel système sans pointeur ; `raw` > 0 (PID validés en amont).
    if unsafe { libc::kill(raw, signal) } == 0 {
        return KillOutcome::Killed;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => KillOutcome::Gone,
        Some(libc::EPERM) => KillOutcome::Failed("permission denied".into()),
        _ => KillOutcome::Failed(std::io::Error::last_os_error().to_string()),
    }
}

/// Collecte (sans bloquer) les zombies dont le process courant est le
/// parent, sauf `except` — le programme direct, que `std::process::Child`
/// doit collecter lui-même.
pub fn reap_zombie_children(table: &[Entry], self_pid: u32, except: Option<u32>) {
    for entry in table {
        if entry.zombie
            && entry.ppid == Some(self_pid)
            && Some(entry.pid) != except
            && let Ok(raw) = libc::pid_t::try_from(entry.pid)
        {
            let mut status = 0;
            // SAFETY: `status` inscriptible ; WNOHANG : jamais bloquant ;
            // `raw` est un enfant du process courant.
            unsafe { libc::waitpid(raw, &mut status, libc::WNOHANG) };
        }
    }
}

/// Nom symbolique d'un signal (rapport `job run`).
pub fn signal_name(signal: libc::c_int) -> String {
    let name = match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGXCPU => "SIGXCPU",
        libc::SIGXFSZ => "SIGXFSZ",
        libc::SIGSYS => "SIGSYS",
        _ => return format!("SIG{signal}"),
    };
    name.to_string()
}

/// Signal d'interruption reçu (0 = aucun).
static INTERRUPTED: AtomicI32 = AtomicI32::new(0);

/// Signaux qui interrompent `job run` : tout le conteneur est tué, le rapport
/// écrit, puis sortie 128+n.
const WATCHED: [libc::c_int; 4] = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP, libc::SIGQUIT];

/// Bloque les signaux d'interruption dans le process (à appeler avant tout
/// autre thread : le masque est hérité) et les reçoit dans un thread dédié
/// par `sigwait` — aucun gestionnaire asynchrone, donc aucune contrainte
/// async-signal-safe sur le code principal. Les process lancés ensuite
/// repartent d'un masque vide (réinitialisé par std et par `pre_exec`).
pub fn watch_interruptions() -> Result<(), NativeError> {
    // SAFETY: sigset_t est une structure C ; sigemptyset l'initialise.
    let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
    // SAFETY: `set` est un sigset_t valide et inscriptible.
    unsafe { libc::sigemptyset(&mut set) };
    for signal in WATCHED {
        // SAFETY: idem, numéros de signal valides.
        unsafe { libc::sigaddset(&mut set, signal) };
    }
    // SAFETY: masque valide ; ancien masque non demandé.
    let rc = unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut()) };
    if rc != 0 {
        return Err(NativeError::failure(
            "SIGNAL_SETUP_FAILED",
            format!("pthread_sigmask: {}", std::io::Error::from_raw_os_error(rc)),
        ));
    }
    std::thread::Builder::new()
        .name("signals".into())
        .spawn(move || {
            loop {
                let mut received: libc::c_int = 0;
                // SAFETY: `set` valide (copie possédée par le thread), `received` inscriptible.
                if unsafe { libc::sigwait(&set, &mut received) } == 0 {
                    INTERRUPTED.store(received, Ordering::SeqCst);
                }
            }
        })
        .map_err(|e| NativeError::failure("SIGNAL_SETUP_FAILED", format!("thread: {e}")))?;
    Ok(())
}

/// Signal d'interruption reçu depuis `watch_interruptions`, s'il y en a un.
pub fn interruption() -> Option<libc::c_int> {
    match INTERRUPTED.load(Ordering::SeqCst) {
        0 => None,
        signal => Some(signal),
    }
}

/// Démasque tous les signaux du thread appelant — dans `pre_exec`, entre
/// fork et exec (async-signal-safe).
///
/// # Safety
/// À n'appeler que dans le process enfant entre fork et exec.
pub unsafe fn unblock_all_signals() -> std::io::Result<()> {
    // SAFETY: sigset_t initialisé par sigemptyset avant usage.
    let mut empty: libc::sigset_t = unsafe { std::mem::zeroed() };
    // SAFETY: `empty` valide et inscriptible.
    unsafe { libc::sigemptyset(&mut empty) };
    // SAFETY: masque valide ; pthread_sigmask est async-signal-safe.
    let rc = unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut()) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::from_raw_os_error(rc))
    }
}

/// Milliseconde courante depuis l'epoch Unix.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noms_de_signaux() {
        assert_eq!(signal_name(libc::SIGKILL), "SIGKILL");
        assert_eq!(signal_name(libc::SIGTERM), "SIGTERM");
        assert_eq!(signal_name(200), "SIG200");
    }
}
