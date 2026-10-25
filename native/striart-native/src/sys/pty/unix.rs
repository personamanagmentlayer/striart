//! Pseudo-terminal POSIX (`openpty`, Linux et macOS).
//!
//! Le programme démarre dans sa propre session (`setsid`) dont l'esclave du
//! pty est le terminal de contrôle (`TIOCSCTTY`) : il est chef de session ET
//! de groupe, son PID désigne donc tout le groupe pour `kill(-pid, …)`.
//! Entre `fork` et `exec`, l'enfant n'exécute que des appels
//! async-signal-safe sur des données préparées avant le `fork` (chemins,
//! argv, environnement). Un échec d'`exec` remonte au parent par un pipe
//! `O_CLOEXEC` (errno), jamais par un enfant qui continuerait à vivre.

use super::{ExitStatus, PtySpec};
use crate::protocol::NativeError;
use crate::sys::unix::unblock_all_signals;
use crate::tree_kill::Member;
use std::ffi::{CString, OsStr, OsString};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

fn cstring(value: &OsStr, what: &str) -> Result<CString, NativeError> {
    CString::new(value.as_bytes())
        .map_err(|_| NativeError::usage(format!("{what}: NUL byte not allowed")))
}

fn set_cloexec(fd: RawFd) -> io::Result<()> {
    // SAFETY: fd valide possédé par l'appelant.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    // SAFETY: idem.
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn winsize(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

/// Environnement du programme : celui de l'hôte, `TERM` remplacé si demandé.
fn environment(term: Option<&str>) -> Result<Vec<CString>, NativeError> {
    let mut vars: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    if let Some(term) = term {
        vars.retain(|(k, _)| k != "TERM");
        vars.push(("TERM".into(), term.into()));
    }
    vars.into_iter()
        .filter(|(k, _)| !k.is_empty())
        .map(|(k, v)| {
            let mut entry = k.as_bytes().to_vec();
            entry.push(b'=');
            entry.extend_from_slice(v.as_bytes());
            CString::new(entry).map_err(|_| NativeError::usage("environment: NUL byte not allowed"))
        })
        .collect()
}

#[derive(Debug)]
pub struct Pty {
    pid: libc::pid_t,
    /// Heure de création du programme (ancre du suivi des descendants).
    start_ms: Option<u64>,
    /// Descendants connus du programme (PID + heure de création) : la liste
    /// qui permet, à l'arrêt, d'atteindre ceux qui ont QUITTÉ le groupe
    /// (`setsid`, double fork) ou dont le parent est mort, sans jamais viser un
    /// process étranger. Rafraîchie par `reap_orphans` et à l'arrêt.
    tracked: Mutex<Vec<Member>>,
    /// Voir `PtySpec::adopt_orphans`.
    adopt_orphans: bool,
    reader: Mutex<Option<File>>,
    writer: Mutex<Option<File>>,
    reaped: Mutex<Option<ExitStatus>>,
    closed: AtomicBool,
}

impl Pty {
    pub fn spawn(spec: &PtySpec<'_>) -> Result<Self, NativeError> {
        let program = cstring(spec.program.as_os_str(), "program")?;
        let mut argv = vec![program.clone()];
        for arg in spec.args {
            argv.push(cstring(arg, "argument")?);
        }
        let mut argv_ptrs: Vec<*const libc::c_char> = argv.iter().map(|a| a.as_ptr()).collect();
        argv_ptrs.push(std::ptr::null());
        let env = environment(spec.term)?;
        let mut env_ptrs: Vec<*const libc::c_char> = env.iter().map(|e| e.as_ptr()).collect();
        env_ptrs.push(std::ptr::null());
        let cwd = cstring(spec.cwd.as_os_str(), "--cwd")?;
        // SAFETY: getpid sans pointeur. Capturé AVANT le fork : l'enfant
        // vérifie qu'il n'est pas déjà orphelin quand il arme PDEATHSIG.
        let host_pid = unsafe { libc::getpid() };

        let mut master: libc::c_int = -1;
        let mut slave: libc::c_int = -1;
        let mut size = winsize(spec.cols, spec.rows);
        // SAFETY: sorties inscriptibles ; pas de nom ni de termios imposés.
        if unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                // Pointeur brut : `*const` sous Linux, `*mut` sous macOS.
                &raw mut size,
            )
        } != 0
        {
            return Err(NativeError::os("PTY_SPAWN_FAILED", "openpty"));
        }
        let close_both = || {
            // SAFETY: fds ouverts ci-dessus, fermés une fois sur ce chemin.
            unsafe {
                libc::close(master);
                libc::close(slave);
            }
        };
        if set_cloexec(master)
            .and_then(|()| set_cloexec(slave))
            .is_err()
        {
            close_both();
            return Err(NativeError::os("PTY_SPAWN_FAILED", "fcntl"));
        }
        let mut report = [-1 as libc::c_int; 2];
        // SAFETY: tableau de deux fds inscriptible.
        if unsafe { libc::pipe(report.as_mut_ptr()) } != 0
            || set_cloexec(report[0])
                .and_then(|()| set_cloexec(report[1]))
                .is_err()
        {
            close_both();
            return Err(NativeError::os("PTY_SPAWN_FAILED", "pipe"));
        }

        // SAFETY: fork(2) ; l'enfant n'exécute que des appels
        // async-signal-safe sur des données préparées ci-dessus.
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            close_both();
            return Err(NativeError::os("PTY_SPAWN_FAILED", "fork"));
        }
        if pid == 0 {
            // SAFETY: process enfant, entre fork et exec.
            unsafe {
                child_exec(&ChildPlan {
                    slave,
                    master,
                    report: report[1],
                    host_pid,
                    cwd: &cwd,
                    program: &program,
                    argv: &argv_ptrs,
                    env: &env_ptrs,
                })
            }
        }
        // Parent.
        // SAFETY: fds du parent devenus inutiles.
        unsafe {
            libc::close(slave);
            libc::close(report[1]);
        }
        let mut errno_bytes = [0u8; 4];
        // SAFETY: fd de lecture du pipe de rapport, possédé.
        let mut report_file = unsafe { File::from_raw_fd(report[0]) };
        let mut read = 0usize;
        loop {
            match report_file.read(&mut errno_bytes[read..]) {
                Ok(0) => break,
                Ok(n) => {
                    read += n;
                    if read == errno_bytes.len() {
                        break;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        if read > 0 {
            let errno = i32::from_ne_bytes(errno_bytes);
            let mut status = 0;
            // SAFETY: enfant à nous, qui sort par _exit(127).
            unsafe { libc::waitpid(pid, &mut status, 0) };
            // SAFETY: fd possédé.
            unsafe { libc::close(master) };
            let error = io::Error::from_raw_os_error(errno);
            return Err(NativeError::failure(
                if errno == libc::ENOENT {
                    "PTY_PROGRAM_NOT_FOUND"
                } else {
                    "PTY_SPAWN_FAILED"
                },
                format!("cannot start the program: {error}"),
            ));
        }
        // SAFETY: duplication d'un fd valide (lecture et écriture séparées).
        let writer_fd = unsafe { libc::dup(master) };
        if writer_fd < 0 || set_cloexec(writer_fd).is_err() {
            // SAFETY: enfant à nous.
            unsafe { libc::kill(-pid, libc::SIGKILL) };
            return Err(NativeError::os("PTY_SPAWN_FAILED", "dup"));
        }
        // SAFETY: fds possédés, transférés à File.
        let (reader, writer) = unsafe { (File::from_raw_fd(master), File::from_raw_fd(writer_fd)) };
        let start_ms = crate::sys::infos(&[pid as u32])
            .ok()
            .and_then(|list| list.first().and_then(|info| info.start_ms));
        Ok(Self {
            pid,
            start_ms,
            tracked: Mutex::new(Vec::new()),
            adopt_orphans: spec.adopt_orphans,
            reader: Mutex::new(Some(reader)),
            writer: Mutex::new(Some(writer)),
            reaped: Mutex::new(None),
            closed: AtomicBool::new(false),
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid as u32
    }

    pub fn take_reader(&self) -> Option<File> {
        self.reader.lock().ok()?.take()
    }

    pub fn write_input(&self, data: &[u8]) -> io::Result<()> {
        let mut guard = self
            .writer
            .lock()
            .map_err(|_| io::Error::other("poisoned"))?;
        match guard.as_mut() {
            Some(file) => file.write_all(data),
            None => Err(io::Error::from(io::ErrorKind::BrokenPipe)),
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        let guard = self
            .writer
            .lock()
            .map_err(|_| io::Error::other("poisoned"))?;
        // Le fd d'écriture (dup du maître) vit jusqu'à `close` : jamais un
        // numéro recyclé, contrairement au fd du lecteur fermé à EOF.
        let Some(file) = guard.as_ref() else {
            return Err(io::Error::from(io::ErrorKind::NotConnected));
        };
        let size = winsize(cols, rows);
        // SAFETY: fd maître ouvert (tenu par le verrou) ; structure valide.
        if unsafe { libc::ioctl(file.as_raw_fd(), libc::TIOCSWINSZ as _, &size) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn try_wait(&self) -> io::Result<Option<ExitStatus>> {
        let mut reaped = self
            .reaped
            .lock()
            .map_err(|_| io::Error::other("poisoned"))?;
        if let Some(status) = *reaped {
            return Ok(Some(status));
        }
        let mut status = 0;
        // SAFETY: enfant à nous ; WNOHANG.
        let rc = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) };
        if rc == 0 {
            return Ok(None);
        }
        if rc < 0 {
            return Err(io::Error::last_os_error());
        }
        let exit = if libc::WIFEXITED(status) {
            ExitStatus {
                code: Some(i64::from(libc::WEXITSTATUS(status))),
                signal: None,
            }
        } else {
            ExitStatus {
                code: None,
                signal: Some(libc::WTERMSIG(status)),
            }
        };
        *reaped = Some(exit);
        Ok(Some(exit))
    }

    /// Raccroche : SIGHUP à tout le groupe du programme (ce que fait le
    /// noyau à la fermeture du maître), et plus aucune entrée acceptée.
    /// Idempotent.
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        // SAFETY: groupe de notre enfant (chef de session).
        unsafe { libc::kill(-self.pid, libc::SIGHUP) };
        // Verrou d'écriture possiblement tenu par un `write_input` bloqué
        // (pty plein) : attente bornée, le fd est fermé à la destruction.
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        loop {
            match self.writer.try_lock() {
                Ok(mut writer) => {
                    writer.take();
                    break;
                }
                Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                    poisoned.into_inner().take();
                    break;
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    if std::time::Instant::now() >= deadline {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
        }
    }

    pub fn tree_alive(&self) -> bool {
        let _ = self.try_wait();
        // SAFETY: signal 0 : test d'existence du groupe.
        unsafe { libc::kill(-self.pid, 0) == 0 }
    }

    /// Tue le groupe du programme puis les descendants SUIVIS qui l'ont quitté
    /// (`setsid`, double fork, parent mort). Seuls les process de l'arbre du
    /// programme sont visés — jamais un autre enfant du process courant.
    /// Rend `true` seulement si plus rien de cet arbre ne vit.
    pub fn terminate(&self) -> bool {
        // Suivi établi AVANT de tuer : après la mort du chef, les orphelins ne
        // se rattachent plus à lui.
        let tracked = self.refresh_tracked();
        // Le groupe n'est visé que s'il vit encore : un numéro de groupe
        // libre pourrait être repris par un tiers.
        if self.tree_alive() {
            // SAFETY: groupe de notre enfant, vérifié vivant ci-dessus.
            unsafe { libc::kill(-self.pid, libc::SIGKILL) };
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while self.tree_alive() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let group_gone = !self.tree_alive();
        let tracked_gone = self.kill_tracked(&tracked);
        self.reap_orphans();
        group_gone && tracked_gone
    }

    /// Met à jour (et rend) la liste des descendants connus : l'arbre vivant du
    /// programme, plus les enfants de tout membre déjà suivi.
    fn refresh_tracked(&self) -> Vec<Member> {
        let Ok(table) = crate::sys::snapshot() else {
            return self.tracked.lock().map(|t| t.clone()).unwrap_or_default();
        };
        let Ok(mut tracked) = self.tracked.lock() else {
            return Vec::new();
        };
        let host = std::process::id();
        let mut parents: Vec<Member> = tracked.clone();
        if self.adopt_orphans {
            // Hôte à enfant unique : les orphelins reparentés sous lui sont les
            // nôtres, même quand le programme est mort avant tout échantillonnage.
            let host_start = table
                .iter()
                .find(|e| e.pid == host && !e.zombie)
                .and_then(|e| e.start_ms);
            parents.push(Member {
                pid: host,
                start_ms: host_start,
            });
        }
        let (_, selected) =
            crate::tree_kill::select(&table, self.pid as u32, self.start_ms, &parents, host, true);
        for entry in selected {
            let member = Member {
                pid: entry.pid,
                start_ms: entry.start_ms,
            };
            if !tracked.contains(&member) {
                tracked.push(member);
            }
        }
        tracked.clone()
    }

    /// Tue les descendants suivis encore vivants, puis leurs propres
    /// descendants ; `true` si plus aucun ne vit.
    fn kill_tracked(&self, tracked: &[Member]) -> bool {
        let host = std::process::id();
        for member in tracked {
            if member.pid != host && member.pid > 1 {
                // `Gone` / `Mismatch` (numéro repris) : rien à faire.
                let _ = crate::sys::kill_verified(member.pid, member.start_ms);
            }
        }
        let swept = crate::tree_kill::sweep(self.pid as u32, self.start_ms, tracked, host);
        let Ok(table) = crate::sys::snapshot() else {
            return false; // table illisible : pas d'affirmation « tout est mort »
        };
        let still_alive = tracked.iter().any(|member| {
            table.iter().any(|e| {
                e.pid == member.pid
                    && !e.zombie
                    && match (e.start_ms, member.start_ms) {
                        (Some(a), Some(b)) => crate::sys::same_start_time(a, b),
                        _ => true,
                    }
            })
        });
        swept.is_ok_and(|s| s.complete()) && !still_alive
    }

    /// Rafraîchit le suivi des descendants et — Linux, où l'hôte est
    /// « subreaper » — collecte les orphelins SUIVIS devenus zombies sous lui
    /// (jamais le programme direct, que `try_wait` collecte, ni un enfant
    /// étranger du process).
    pub fn reap_orphans(&self) {
        let tracked = self.refresh_tracked();
        #[cfg(target_os = "linux")]
        if let Ok(table) = crate::sys::snapshot() {
            let host = std::process::id();
            for entry in &table {
                let ours = entry.zombie
                    && entry.ppid == Some(host)
                    && entry.pid != self.pid as u32
                    && (self.adopt_orphans || tracked.iter().any(|m| m.pid == entry.pid));
                if ours {
                    crate::sys::unix::reap_zombie_children(
                        std::slice::from_ref(entry),
                        host,
                        Some(self.pid as u32),
                    );
                }
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = tracked;
    }
}

impl Drop for Pty {
    /// Un `Pty` détruit ne laisse pas son programme derrière lui (parité
    /// avec Windows, où la fermeture du Job Object tue la descendance).
    fn drop(&mut self) {
        self.close();
        let already_reaped = self.reaped.lock().map(|r| r.is_some()).unwrap_or(false);
        if !already_reaped {
            // SAFETY: groupe de notre enfant non encore collecté (son numéro
            // ne peut donc pas avoir été réattribué).
            unsafe { libc::kill(-self.pid, libc::SIGKILL) };
            let mut status = 0;
            // SAFETY: enfant à nous ; SIGKILL vient d'être envoyé.
            unsafe { libc::waitpid(self.pid, &mut status, 0) };
        }
    }
}

/// Tout ce que l'enfant utilise entre `fork` et `exec`, préparé AVANT le
/// `fork` (aucune allocation dans l'enfant).
struct ChildPlan<'a> {
    slave: RawFd,
    master: RawFd,
    report: RawFd,
    host_pid: libc::pid_t,
    cwd: &'a CString,
    program: &'a CString,
    argv: &'a [*const libc::c_char],
    env: &'a [*const libc::c_char],
}

/// Partie enfant du `fork` : ne rend jamais la main.
///
/// # Safety
/// À n'appeler que dans l'enfant, juste après `fork`. Tous les pointeurs
/// désignent des données vivantes préparées avant le `fork`.
unsafe fn child_exec(plan: &ChildPlan<'_>) -> ! {
    let ChildPlan {
        slave,
        master,
        report,
        host_pid,
        cwd,
        program,
        argv,
        env,
    } = *plan;
    let fail = |report: RawFd| -> ! {
        // SAFETY: errno du thread courant ; écriture best effort.
        unsafe {
            let errno = *errno_location();
            let bytes = errno.to_ne_bytes();
            libc::write(report, bytes.as_ptr().cast(), bytes.len());
            libc::_exit(127)
        }
    };
    // SAFETY: appels async-signal-safe sur des fds et données valides.
    unsafe {
        if unblock_all_signals().is_err() {
            fail(report);
        }
        // Dispositions par défaut : std ignore SIGPIPE dans l'hôte, un shell
        // doit naître avec les dispositions standard.
        for signal in 1..32 {
            if signal != libc::SIGKILL && signal != libc::SIGSTOP {
                libc::signal(signal, libc::SIG_DFL);
            }
        }
        // Linux : le programme meurt (SIGKILL) avec l'hôte, même tué
        // brutalement. Sans cela, un `kill -9` de l'hôte laisserait le shell
        // vivant (seul SIGHUP du noyau à la fermeture du maître l'atteint, et
        // un shell peut l'ignorer). Garde : si l'hôte est déjà mort, le signal
        // ne viendra jamais — on n'exécute pas un orphelin.
        #[cfg(target_os = "linux")]
        {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0 {
                fail(report);
            }
            if libc::getppid() != host_pid {
                *errno_location() = libc::ESRCH;
                fail(report);
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = host_pid;
        if libc::setsid() < 0 {
            fail(report);
        }
        if libc::ioctl(slave, libc::TIOCSCTTY as _, 0) != 0 {
            fail(report);
        }
        for target in 0..3 {
            if libc::dup2(slave, target) < 0 {
                fail(report);
            }
        }
        if slave > 2 {
            libc::close(slave);
        }
        libc::close(master);
        if libc::chdir(cwd.as_ptr()) != 0 {
            fail(report);
        }
        libc::execve(program.as_ptr(), argv.as_ptr(), env.as_ptr());
        fail(report)
    }
}

#[cfg(target_os = "linux")]
unsafe fn errno_location() -> *mut libc::c_int {
    // SAFETY: errno du thread courant.
    unsafe { libc::__errno_location() }
}

#[cfg(target_os = "macos")]
unsafe fn errno_location() -> *mut libc::c_int {
    // SAFETY: errno du thread courant.
    unsafe { libc::__error() }
}
