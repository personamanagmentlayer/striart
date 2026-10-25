//! Windows : Toolhelp32 (table des process et des threads), droits minimaux
//! (`PROCESS_QUERY_LIMITED_INFORMATION`), ligne de commande par
//! `NtQueryInformationProcess(ProcessCommandLineInformation)` — Windows 8.1+.

use super::{Entry, Info, KillOutcome};
use crate::protocol::NativeError;
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::ptr::null_mut;
use windows_sys::Wdk::System::Threading::{
    NtQueryInformationProcess, ProcessCommandLineInformation,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, FILETIME, GetLastError, HANDLE,
    INVALID_HANDLE_VALUE, UNICODE_STRING, WAIT_OBJECT_0,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, OpenThread, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, ResumeThread, THREAD_SUSPEND_RESUME, TerminateProcess,
    WaitForSingleObject,
};

/// Process sans parent ni existence propre : jamais ciblés.
const SYSTEM_IDLE_PID: u32 = 0;
const SYSTEM_PID: u32 = 4;

/// Les groupes et sessions POSIX n'existent pas ici : l'arbre se suit par le
/// parent seulement (et par le Job Object pour `job run`).
pub const USES_PROCESS_GROUPS: bool = false;

/// Délai d'attente de la mort effective d'un process tué.
const KILL_WAIT_MS: u32 = 5_000;
/// Attente d'un process dont TerminateProcess échoue parce qu'il sort déjà.
const EXITING_WAIT_MS: u32 = 1_000;

/// Écart entre l'epoch FILETIME (1601-01-01) et l'epoch Unix, en 100 ns.
const FILETIME_UNIX_EPOCH: u64 = 116_444_736_000_000_000;

/// HANDLE possédé, fermé à la destruction.
#[derive(Debug)]
pub struct OwnedHandle(pub HANDLE);

impl OwnedHandle {
    /// `None` pour le handle nul ou INVALID_HANDLE_VALUE (échec d'ouverture).
    pub fn new(handle: HANDLE) -> Option<Self> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            None
        } else {
            Some(Self(handle))
        }
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: le handle est valide (construit par `new`) et fermé une
        // seule fois, ici.
        unsafe { CloseHandle(self.0) };
    }
}

/// Instantané Toolhelp des process : (pid, ppid, nom d'image).
fn toolhelp_processes() -> Result<Vec<(u32, u32, String)>, NativeError> {
    // SAFETY: appel sans pointeur ; le retour est vérifié.
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    let snapshot = OwnedHandle::new(raw)
        .ok_or_else(|| NativeError::os("SNAPSHOT_FAILED", "CreateToolhelp32Snapshot"))?;
    // SAFETY: PROCESSENTRY32W est une structure C sans invariant ; zéro est
    // une valeur valide, dwSize est renseigné avant l'appel.
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut rows = Vec::with_capacity(512);
    // SAFETY: snapshot valide, `entry` initialisée avec sa taille.
    let mut ok = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    while ok != 0 {
        rows.push((
            entry.th32ProcessID,
            entry.th32ParentProcessID,
            wide_to_string(&entry.szExeFile),
        ));
        // SAFETY: idem.
        ok = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    Ok(rows)
}

/// Chaîne UTF-16 terminée par NUL (tampon fixe) → String (U+FFFD sur une
/// moitié de paire de substitution orpheline).
fn wide_to_string(buffer: &[u16]) -> String {
    let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..len])
}

fn open_process(pid: u32, access: u32) -> Option<OwnedHandle> {
    // SAFETY: appel sans pointeur ; un échec rend NULL, filtré par `new`.
    OwnedHandle::new(unsafe { OpenProcess(access, 0, pid) })
}

/// Heure de création (ms epoch Unix) d'un process ouvert.
pub fn creation_ms(handle: &OwnedHandle) -> Option<u64> {
    let mut times = [FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    }; 4];
    let [creation, exit, kernel, user] = &mut times;
    // SAFETY: handle valide ; quatre FILETIME distincts et inscriptibles.
    let ok = unsafe { GetProcessTimes(handle.0, creation, exit, kernel, user) };
    if ok == 0 {
        return None;
    }
    let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    ticks
        .checked_sub(FILETIME_UNIX_EPOCH)
        .map(|since_epoch| since_epoch / 10_000)
}

/// Ligne de commande d'un process ouvert avec PROCESS_QUERY_LIMITED_INFORMATION.
fn command_line(handle: &OwnedHandle) -> Option<String> {
    let mut needed: u32 = 0;
    // Premier appel : taille requise (STATUS_INFO_LENGTH_MISMATCH attendu).
    // SAFETY: tampon nul de longueur nulle, `needed` inscriptible.
    unsafe {
        NtQueryInformationProcess(
            handle.0,
            ProcessCommandLineInformation,
            null_mut(),
            0,
            &mut needed,
        )
    };
    let needed_bytes = usize::try_from(needed).ok()?;
    if needed_bytes < size_of::<UNICODE_STRING>() || needed_bytes > 1 << 20 {
        return None;
    }
    // Tampon de u64 : alignement suffisant pour UNICODE_STRING (pointeur).
    let mut buffer = vec![0u64; needed_bytes.div_ceil(8)];
    let capacity = buffer.len() * 8;
    let mut written: u32 = 0;
    // SAFETY: le tampon fait `capacity` octets, aligné sur 8.
    let status = unsafe {
        NtQueryInformationProcess(
            handle.0,
            ProcessCommandLineInformation,
            buffer.as_mut_ptr().cast::<c_void>(),
            u32::try_from(capacity).ok()?,
            &mut written,
        )
    };
    if status < 0 {
        return None;
    }
    // SAFETY: l'OS a écrit un UNICODE_STRING en tête du tampon (aligné).
    let header = unsafe { &*buffer.as_ptr().cast::<UNICODE_STRING>() };
    let units = usize::from(header.Length) / 2;
    if units == 0 {
        return Some(String::new());
    }
    // Défense : les données doivent se trouver DANS notre tampon.
    let base = buffer.as_ptr() as usize;
    let start = header.Buffer as usize;
    if start < base || start + units * 2 > base + capacity {
        return None;
    }
    // SAFETY: plage [start, start + 2·units) vérifiée incluse dans le tampon,
    // alignée sur 2 (u16) puisque le tampon l'est sur 8 et que l'OS place
    // les données à un décalage pair.
    let data = unsafe { std::slice::from_raw_parts(header.Buffer, units) };
    Some(String::from_utf16_lossy(data))
}

/// Table complète des process, avec l'heure de création de ceux qu'on peut
/// ouvrir.
pub fn snapshot() -> Result<Vec<Entry>, NativeError> {
    Ok(toolhelp_processes()?
        .into_iter()
        .filter(|(pid, _, _)| *pid != SYSTEM_IDLE_PID)
        .map(|(pid, ppid, _)| {
            // Un process TERMINÉ dont un handle reste ouvert quelque part
            // (le parent, un moniteur) figure encore dans Toolhelp : c'est
            // l'équivalent d'un zombie POSIX — mort, ni vivant ni tuable.
            // SYNCHRONIZE permet de le constater ; refusé (process protégé),
            // on retombe sur le droit minimal et le process est supposé vivant.
            let handle = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)
                .or_else(|| open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION));
            let exited = handle.as_ref().is_some_and(|h| {
                // SAFETY: handle de process valide, attente nulle (simple test).
                let state = unsafe { WaitForSingleObject(h.0, 0) };
                state == WAIT_OBJECT_0
            });
            Entry {
                pid,
                ppid: (ppid != 0).then_some(ppid),
                start_ms: handle.as_ref().and_then(creation_ms),
                pgid: None,
                sid: None,
                zombie: exited,
            }
        })
        .collect())
}

/// Identité des PID demandés (les absents sont omis).
pub fn infos(pids: &[u32]) -> Result<Vec<Info>, NativeError> {
    let table = toolhelp_processes()?;
    Ok(pids
        .iter()
        .filter_map(|&pid| {
            let (_, ppid, name) = table.iter().find(|(p, _, _)| *p == pid)?;
            let handle = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION);
            Some(Info {
                pid,
                ppid: (*ppid != 0).then_some(*ppid),
                name: name.clone(),
                command_line: handle.as_ref().and_then(command_line),
                start_ms: handle.as_ref().and_then(creation_ms),
            })
        })
        .collect())
}

/// Tue `pid` si (et seulement si) c'est toujours le process attendu. Le
/// handle ouvert épingle le process : la vérification et le kill visent le
/// même objet noyau, sans fenêtre de recyclage entre les deux.
pub fn kill_verified(pid: u32, expected_start: Option<u64>) -> KillOutcome {
    if pid == SYSTEM_IDLE_PID || pid == SYSTEM_PID || pid == std::process::id() {
        return KillOutcome::Failed("refusing to kill a system process or itself".into());
    }
    let Some(handle) = open_process(
        pid,
        PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
    ) else {
        // SAFETY: lecture de l'erreur du thread courant, sans pointeur.
        let error = unsafe { GetLastError() };
        return if error == ERROR_INVALID_PARAMETER {
            KillOutcome::Gone
        } else if error == ERROR_ACCESS_DENIED {
            KillOutcome::Failed("access denied".into())
        } else {
            KillOutcome::Failed(format!("OpenProcess failed (error {error})"))
        };
    };
    if let Some(expected) = expected_start {
        match creation_ms(&handle) {
            Some(actual) if super::same_start_time(actual, expected) => {}
            Some(_) => return KillOutcome::Mismatch,
            None => return KillOutcome::Failed("creation time unreadable".into()),
        }
    }
    // SAFETY: handle valide, attente nulle.
    if unsafe { WaitForSingleObject(handle.0, 0) } == WAIT_OBJECT_0 {
        return KillOutcome::Gone; // déjà sorti, handle encore ouvert ailleurs
    }
    // SAFETY: handle valide avec PROCESS_TERMINATE.
    if unsafe { TerminateProcess(handle.0, 1) } == 0 {
        // Un process déjà en cours de sortie fait échouer TerminateProcess
        // (ERROR_ACCESS_DENIED) : on lui laisse le temps de finir avant de
        // conclure à un refus.
        // SAFETY: handle valide avec SYNCHRONIZE.
        if unsafe { WaitForSingleObject(handle.0, EXITING_WAIT_MS) } == WAIT_OBJECT_0 {
            return KillOutcome::Gone; // sorti entre-temps
        }
        return KillOutcome::Failed(format!(
            "TerminateProcess failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: handle valide avec SYNCHRONIZE.
    unsafe { WaitForSingleObject(handle.0, KILL_WAIT_MS) };
    KillOutcome::Killed
}

/// Reprend tous les threads d'un process créé suspendu (`CREATE_SUSPENDED`).
/// Rend le nombre de threads repris.
pub fn resume_process_threads(pid: u32) -> Result<usize, NativeError> {
    // SAFETY: appel sans pointeur ; le retour est vérifié.
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    let snapshot = OwnedHandle::new(raw)
        .ok_or_else(|| NativeError::os("SNAPSHOT_FAILED", "CreateToolhelp32Snapshot"))?;
    // SAFETY: structure C sans invariant, dwSize renseigné.
    let mut entry: THREADENTRY32 = unsafe { zeroed() };
    entry.dwSize = size_of::<THREADENTRY32>() as u32;
    let mut resumed = 0;
    // SAFETY: snapshot valide, `entry` initialisée.
    let mut ok = unsafe { Thread32First(snapshot.0, &mut entry) };
    while ok != 0 {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: appel sans pointeur ; échec = NULL, filtré par `new`.
            let raw_thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if let Some(thread) = OwnedHandle::new(raw_thread) {
                // SAFETY: handle de thread valide avec THREAD_SUSPEND_RESUME.
                if unsafe { ResumeThread(thread.0) } != u32::MAX {
                    resumed += 1;
                }
            }
        }
        // SAFETY: idem.
        ok = unsafe { Thread32Next(snapshot.0, &mut entry) };
    }
    Ok(resumed)
}
