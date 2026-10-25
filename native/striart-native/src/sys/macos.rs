//! macOS : libproc (`proc_listallpids`, `proc_pidinfo(PROC_PIDTBSDINFO)`,
//! `proc_pidpath`) et `sysctl(KERN_PROCARGS2)` pour la ligne de commande.
//! Heure de création : `pbi_start_tvsec`/`pbi_start_tvusec` (µs).
//!
//! Limite assumée : pas de descripteur de process — entre la vérification de
//! l'heure de création et `kill(2)`, la fenêtre de recyclage est de l'ordre
//! de la µs (macOS attribue les PID séquentiellement, un recyclage exige un
//! tour complet de l'espace des PID).

use super::{Entry, Info, KillOutcome, same_start_time};
use crate::protocol::NativeError;
use std::ffi::c_void;
use std::mem::{size_of, zeroed};

pub const USES_PROCESS_GROUPS: bool = true;

/// `SZOMB` de <sys/proc.h> : process mort en attente de collecte.
const SZOMB: u32 = 5;

fn bsdinfo(pid: u32) -> Option<libc::proc_bsdinfo> {
    let raw = libc::c_int::try_from(pid).ok()?;
    // SAFETY: structure C sans invariant.
    let mut info: libc::proc_bsdinfo = unsafe { zeroed() };
    let size = size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: tampon de la taille exacte de la structure demandée.
    let written = unsafe {
        libc::proc_pidinfo(
            raw,
            libc::PROC_PIDTBSDINFO,
            0,
            (&raw mut info).cast::<c_void>(),
            size,
        )
    };
    (written == size).then_some(info)
}

fn start_ms(info: &libc::proc_bsdinfo) -> Option<u64> {
    let ms = info
        .pbi_start_tvsec
        .checked_mul(1_000)?
        .checked_add(info.pbi_start_tvusec / 1_000)?;
    (ms > 0).then_some(ms)
}

fn c_name(raw: &[libc::c_char]) -> String {
    let bytes: Vec<u8> = raw
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn all_pids() -> Result<Vec<u32>, NativeError> {
    // SAFETY: tampon nul : demande du nombre de PID.
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Err(NativeError::os("SNAPSHOT_FAILED", "proc_listallpids"));
    }
    // Marge : des process peuvent naître entre les deux appels.
    let capacity = usize::try_from(count).unwrap_or(0) + 64;
    let mut pids = vec![0 as libc::c_int; capacity];
    let bytes = libc::c_int::try_from(capacity * size_of::<libc::c_int>())
        .map_err(|_| NativeError::failure("SNAPSHOT_FAILED", "process table too large"))?;
    // SAFETY: tampon de `bytes` octets.
    let filled = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast::<c_void>(), bytes) };
    if filled <= 0 {
        return Err(NativeError::os("SNAPSHOT_FAILED", "proc_listallpids"));
    }
    pids.truncate(usize::try_from(filled).unwrap_or(0).min(capacity));
    Ok(pids
        .into_iter()
        .filter_map(|p| u32::try_from(p).ok())
        .filter(|p| *p > 0)
        .collect())
}

pub fn snapshot() -> Result<Vec<Entry>, NativeError> {
    Ok(all_pids()?
        .into_iter()
        .filter_map(|pid| {
            let info = bsdinfo(pid)?;
            // SAFETY: appel sans pointeur.
            let sid = unsafe { libc::getsid(pid as libc::pid_t) };
            Some(Entry {
                pid,
                ppid: (info.pbi_ppid != 0).then_some(info.pbi_ppid),
                start_ms: start_ms(&info),
                pgid: Some(info.pbi_pgid),
                sid: u32::try_from(sid).ok(),
                zombie: info.pbi_status == SZOMB,
            })
        })
        .collect())
}

fn executable_path(pid: u32) -> Option<String> {
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: tampon de PROC_PIDPATHINFO_MAXSIZE octets.
    let len = unsafe {
        libc::proc_pidpath(
            pid as libc::c_int,
            buffer.as_mut_ptr().cast::<c_void>(),
            buffer.len() as u32,
        )
    };
    let len = usize::try_from(len).ok().filter(|l| *l > 0)?;
    buffer.truncate(len);
    Some(String::from_utf8_lossy(&buffer).into_owned())
}

/// argv d'un process par `KERN_PROCARGS2` : `argc` (i32), chemin de
/// l'exécutable, bourrage NUL, puis `argc` chaînes terminées par NUL.
fn arguments(pid: u32) -> Option<Vec<String>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let mut arg_max: libc::c_int = 0;
    let mut size = size_of::<libc::c_int>();
    // SAFETY: MIB de deux entiers, sortie entière de taille `size`.
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            (&raw mut arg_max).cast::<c_void>(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || arg_max <= 0 {
        return None;
    }
    let mut buffer = vec![0u8; usize::try_from(arg_max).ok()?];
    let mut len = buffer.len();
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    // SAFETY: MIB de trois entiers, tampon de `len` octets.
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast::<c_void>(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return None; // autre utilisateur, ou process disparu
    }
    parse_procargs2(&buffer[..len.min(buffer.len())])
}

pub fn parse_procargs2(data: &[u8]) -> Option<Vec<String>> {
    let argc = usize::try_from(i32::from_ne_bytes(data.get(..4)?.try_into().ok()?)).ok()?;
    let mut rest = data.get(4..)?;
    // Chemin de l'exécutable, puis bourrage NUL.
    let exec_end = rest.iter().position(|b| *b == 0)?;
    rest = &rest[exec_end..];
    let first_arg = rest.iter().position(|b| *b != 0)?;
    rest = &rest[first_arg..];
    let args: Vec<String> = rest
        .split(|b| *b == 0)
        .take(argc)
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect();
    (args.len() == argc).then_some(args)
}

pub fn infos(pids: &[u32]) -> Result<Vec<Info>, NativeError> {
    Ok(pids
        .iter()
        .filter_map(|&pid| {
            let info = bsdinfo(pid)?;
            let args = arguments(pid).unwrap_or_default();
            Some(Info {
                pid,
                ppid: (info.pbi_ppid != 0).then_some(info.pbi_ppid),
                name: executable_path(pid).unwrap_or_else(|| {
                    let long = c_name(&info.pbi_name);
                    if long.is_empty() {
                        c_name(&info.pbi_comm)
                    } else {
                        long
                    }
                }),
                command_line: super::join_command_line(&args),
                start_ms: start_ms(&info),
            })
        })
        .collect())
}

fn is_dead(pid: u32) -> bool {
    bsdinfo(pid).is_none_or(|info| info.pbi_status == SZOMB)
}

pub fn signal_verified(
    pid: u32,
    expected_start: Option<u64>,
    signal: libc::c_int,
    wait: bool,
) -> KillOutcome {
    if pid <= 1 || pid == std::process::id() {
        return KillOutcome::Failed("refusing to signal launchd or itself".into());
    }
    let Some(info) = bsdinfo(pid) else {
        return KillOutcome::Gone;
    };
    if info.pbi_status == SZOMB {
        return KillOutcome::Gone;
    }
    if let Some(expected) = expected_start {
        match start_ms(&info) {
            Some(actual) if same_start_time(actual, expected) => {}
            Some(_) => return KillOutcome::Mismatch,
            None => return KillOutcome::Failed("creation time unreadable".into()),
        }
    }
    let outcome = super::unix::send_signal(pid, signal);
    if wait && outcome == KillOutcome::Killed {
        super::unix::wait_until_dead(pid, is_dead);
    }
    outcome
}

pub fn kill_verified(pid: u32, expected_start: Option<u64>) -> KillOutcome {
    signal_verified(pid, expected_start, libc::SIGKILL, true)
}

#[cfg(test)]
mod tests {
    use super::parse_procargs2;

    #[test]
    fn procargs2() {
        let mut data = 2i32.to_ne_bytes().to_vec();
        data.extend_from_slice(b"/usr/bin/node\0\0\0node\0a b\0FOO=bar\0");
        assert_eq!(
            parse_procargs2(&data),
            Some(vec!["node".to_string(), "a b".to_string()])
        );
        assert_eq!(parse_procargs2(&[1, 0]), None);
    }
}
