//! Pseudo-console Windows (ConPTY, `CreatePseudoConsole`, Windows 10 1809+).
//!
//! - Le programme est créé suspendu, attaché à la pseudo-console par
//!   l'attribut `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`, affecté à un Job
//!   Object `KILL_ON_JOB_CLOSE` puis repris : toute sa descendance vit dans
//!   le job, et meurt avec l'hôte même si celui-ci est tué brutalement
//!   (`TerminateProcess`, repli de `stopPtyHost`).
//! - Aucun handle n'est hérité (`bInheritHandles = FALSE`) et
//!   `STARTF_USESTDHANDLES` est posé avec des handles nuls : les flux
//!   standard du programme sont ceux de la pseudo-console, jamais les flux
//!   redirigés de l'hôte (son journal).
//! - Fermeture : `ClosePseudoConsole` peut attendre que la sortie en attente
//!   soit lue ; l'appelant la fait donc pendant que le thread lecteur draine
//!   encore la sortie (voir `pty_host`) — c'est l'origine des arrêts de
//!   plusieurs secondes constatés avec node-pty.

use super::{ExitStatus, PtySpec};
use crate::protocol::NativeError;
use crate::sys::OwnedHandle;
use crate::sys::job_object::{active_processes, create_job, terminate_job};
use std::ffi::{OsStr, c_void};
use std::fs::File;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::ptr::{null, null_mut};
use std::sync::{Mutex, RwLock};
use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
};
use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION,
    ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

/// Ajoute `arg` à une ligne de commande Windows selon les règles de
/// découpage de la CRT Microsoft (`CommandLineToArgvW`) : guillemets si
/// nécessaire, barres obliques inverses doublées devant un guillemet.
pub fn append_quoted_arg(arg: &OsStr, line: &mut Vec<u16>) {
    let wide: Vec<u16> = arg.encode_wide().collect();
    let needs_quotes = wide.is_empty()
        || wide.iter().any(|&c| {
            c == u16::from(b' ')
                || c == u16::from(b'\t')
                || c == u16::from(b'\n')
                || c == 0x0b
                || c == u16::from(b'"')
        });
    if !needs_quotes {
        line.extend_from_slice(&wide);
        return;
    }
    line.push(u16::from(b'"'));
    let mut backslashes = 0usize;
    for &c in &wide {
        if c == u16::from(b'\\') {
            backslashes += 1;
            continue;
        }
        if c == u16::from(b'"') {
            line.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes * 2 + 1));
        } else {
            line.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes));
        }
        backslashes = 0;
        line.push(c);
    }
    line.extend(std::iter::repeat_n(u16::from(b'\\'), backslashes * 2));
    line.push(u16::from(b'"'));
}

/// Ligne de commande complète (programme puis arguments), terminée par NUL.
pub fn command_line(program: &OsStr, args: &[std::ffi::OsString]) -> Vec<u16> {
    let mut line = Vec::new();
    append_quoted_arg(program, &mut line);
    for arg in args {
        line.push(u16::from(b' '));
        append_quoted_arg(arg, &mut line);
    }
    line.push(0);
    line
}

fn wide_path(path: &OsStr) -> Vec<u16> {
    path.encode_wide().chain(std::iter::once(0)).collect()
}

fn coord(cols: u16, rows: u16) -> COORD {
    COORD {
        X: i16::try_from(cols).unwrap_or(i16::MAX),
        Y: i16::try_from(rows).unwrap_or(i16::MAX),
    }
}

fn pipe() -> Result<(OwnedHandle, OwnedHandle), NativeError> {
    let mut read: HANDLE = null_mut();
    let mut write: HANDLE = null_mut();
    // SAFETY: deux sorties inscriptibles ; pas d'attributs (non héritables).
    if unsafe { CreatePipe(&mut read, &mut write, null(), 0) } == 0 {
        return Err(NativeError::os("PTY_SPAWN_FAILED", "CreatePipe"));
    }
    match (OwnedHandle::new(read), OwnedHandle::new(write)) {
        (Some(r), Some(w)) => Ok((r, w)),
        _ => Err(NativeError::failure(
            "PTY_SPAWN_FAILED",
            "CreatePipe returned no handle",
        )),
    }
}

/// Liste d'attributs de création de process portant la pseudo-console.
struct AttributeList {
    buffer: Vec<usize>,
}

impl AttributeList {
    fn with_pseudoconsole(hpc: HPCON) -> Result<Self, NativeError> {
        let mut size = 0usize;
        // SAFETY: appel de dimensionnement (liste nulle) ; échec attendu.
        unsafe { InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size) };
        if size == 0 {
            return Err(NativeError::os(
                "PTY_SPAWN_FAILED",
                "InitializeProcThreadAttributeList",
            ));
        }
        let mut list = Self {
            buffer: vec![0usize; size.div_ceil(size_of::<usize>())],
        };
        // SAFETY: tampon d'au moins `size` octets, aligné.
        if unsafe { InitializeProcThreadAttributeList(list.ptr(), 1, 0, &mut size) } == 0 {
            return Err(NativeError::os(
                "PTY_SPAWN_FAILED",
                "InitializeProcThreadAttributeList",
            ));
        }
        // SAFETY: liste initialisée ; la valeur de l'attribut est le HPCON
        // lui-même (contrat documenté de PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE).
        if unsafe {
            UpdateProcThreadAttribute(
                list.ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                hpc as *const c_void,
                size_of::<HPCON>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            // SAFETY: liste initialisée ci-dessus.
            unsafe { DeleteProcThreadAttributeList(list.ptr()) };
            list.buffer.clear();
            return Err(NativeError::os(
                "PTY_SPAWN_FAILED",
                "UpdateProcThreadAttribute",
            ));
        }
        Ok(list)
    }

    fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr().cast::<c_void>()
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        if !self.buffer.is_empty() {
            // SAFETY: liste initialisée (buffer non vidé), détruite une fois.
            unsafe { DeleteProcThreadAttributeList(self.ptr()) };
        }
    }
}

/// Pseudo-console et programme hébergé.
#[derive(Debug)]
pub struct Pty {
    /// HPCON ; 0 une fois fermée. `RwLock` et non atomique : un `resize`
    /// tient le verrou en lecture pendant l'appel système, `close` le prend
    /// en écriture pour le mettre à 0 — un HPCON ne peut donc jamais être
    /// fermé (puis son numéro réutilisé) pendant qu'un redimensionnement
    /// s'en sert.
    hpc: RwLock<HPCON>,
    process: OwnedHandle,
    job: OwnedHandle,
    pid: u32,
    reader: Mutex<Option<File>>,
    writer: Mutex<Option<File>>,
}

// SAFETY: les handles Windows sont utilisables depuis tout thread ; l'état
// mutable est derrière des Mutex ou atomique.
unsafe impl Send for Pty {}
// SAFETY: idem.
unsafe impl Sync for Pty {}

impl Pty {
    pub fn spawn(spec: &PtySpec<'_>) -> Result<Self, NativeError> {
        let (input_read, input_write) = pipe()?;
        let (output_read, output_write) = pipe()?;
        let mut hpc: HPCON = 0;
        // SAFETY: handles de pipe valides ; `hpc` inscriptible.
        let hr = unsafe {
            CreatePseudoConsole(
                coord(spec.cols, spec.rows),
                input_read.0,
                output_write.0,
                0,
                &mut hpc,
            )
        };
        if hr < 0 {
            return Err(NativeError::failure(
                "PTY_SPAWN_FAILED",
                format!("CreatePseudoConsole: HRESULT 0x{:08x}", hr as u32),
            ));
        }
        // La pseudo-console a dupliqué ses extrémités : les nôtres se ferment
        // (sinon la lecture de la sortie ne verrait jamais la fin).
        drop(input_read);
        drop(output_write);
        let close_on_error = |error: NativeError| {
            // SAFETY: HPCON valide, fermé une seule fois sur ce chemin d'erreur.
            unsafe { ClosePseudoConsole(hpc) };
            error
        };

        let job = create_job().map_err(close_on_error)?;
        let mut attributes = AttributeList::with_pseudoconsole(hpc).map_err(close_on_error)?;
        // SAFETY: structure C sans invariant ; taille et liste renseignées.
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.lpAttributeList = attributes.ptr();
        // Séparateurs normalisés : cmd.exe lit son propre argv[0] et prend
        // `C:/Windows/System32/cmd.exe` pour une option (« /Windows »).
        let program: std::ffi::OsString = std::os::windows::ffi::OsStringExt::from_wide(
            &spec
                .program
                .as_os_str()
                .encode_wide()
                .map(|c| {
                    if c == u16::from(b'/') {
                        u16::from(b'\\')
                    } else {
                        c
                    }
                })
                .collect::<Vec<u16>>(),
        );
        let application = wide_path(&program);
        let mut line = command_line(&program, spec.args);
        let cwd = wide_path(spec.cwd.as_os_str());
        // SAFETY: structure de sortie inscriptible.
        let mut info: PROCESS_INFORMATION = unsafe { zeroed() };
        // SAFETY: chaînes terminées par NUL ; ligne de commande modifiable
        // (contrat de CreateProcessW) ; environnement hérité (NULL) ; aucune
        // héritabilité de handle.
        let ok = unsafe {
            CreateProcessW(
                application.as_ptr(),
                line.as_mut_ptr(),
                null(),
                null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                null(),
                cwd.as_ptr(),
                &startup.StartupInfo,
                &mut info,
            )
        };
        drop(attributes);
        if ok == 0 {
            return Err(close_on_error(NativeError::os(
                "PTY_SPAWN_FAILED",
                "CreateProcessW",
            )));
        }
        let process = OwnedHandle(info.hProcess);
        let thread = OwnedHandle(info.hThread);
        // SAFETY: job et process (suspendu) valides.
        if unsafe { AssignProcessToJobObject(job.0, process.0) } == 0 {
            let error = NativeError::os("PTY_SPAWN_FAILED", "AssignProcessToJobObject");
            // SAFETY: process valide, suspendu, à nous.
            unsafe { TerminateProcess(process.0, 1) };
            return Err(close_on_error(error));
        }
        // SAFETY: thread principal suspendu du process créé.
        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            let error = NativeError::os("PTY_SPAWN_FAILED", "ResumeThread");
            // SAFETY: job valide.
            let _ = terminate_job(&job);
            return Err(close_on_error(error));
        }
        drop(thread);
        // SAFETY: handles de pipe possédés, transférés à File (fermés une fois).
        let reader = unsafe { File::from_raw_handle(output_read.0) };
        std::mem::forget(output_read);
        // SAFETY: idem.
        let writer = unsafe { File::from_raw_handle(input_write.0) };
        std::mem::forget(input_write);
        Ok(Self {
            hpc: RwLock::new(hpc),
            process,
            job,
            pid: info.dwProcessId,
            reader: Mutex::new(Some(reader)),
            writer: Mutex::new(Some(writer)),
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Flux de sortie du pty (à lire dans un thread dédié) ; une seule fois.
    pub fn take_reader(&self) -> Option<File> {
        self.reader.lock().ok()?.take()
    }

    /// Écrit dans l'entrée du pty (frappes) ; sérialisé entre clients.
    pub fn write_input(&self, data: &[u8]) -> io::Result<()> {
        use std::io::Write;
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
        let guard = self.hpc.read().map_err(|_| io::Error::other("poisoned"))?;
        let hpc = *guard;
        if hpc == 0 {
            return Err(io::Error::from(io::ErrorKind::NotConnected));
        }
        // SAFETY: HPCON ouvert (non nul) ; le verrou en lecture, tenu
        // pendant l'appel, interdit à `close` de le fermer en même temps.
        let hr = unsafe { ResizePseudoConsole(hpc, coord(cols, rows)) };
        drop(guard);
        if hr < 0 {
            Err(io::Error::other(format!(
                "ResizePseudoConsole: HRESULT 0x{:08x}",
                hr as u32
            )))
        } else {
            Ok(())
        }
    }

    /// Fin du programme direct, sans attendre.
    pub fn try_wait(&self) -> io::Result<Option<ExitStatus>> {
        // SAFETY: handle de process valide.
        if unsafe { WaitForSingleObject(self.process.0, 0) } != WAIT_OBJECT_0 {
            return Ok(None);
        }
        let mut code = 0u32;
        // SAFETY: handle valide ; sortie inscriptible.
        if unsafe { GetExitCodeProcess(self.process.0, &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // Pas de test contre STILL_ACTIVE (259) : le handle est signalé, le
        // process est donc terminé, et un programme peut légitimement
        // sortir avec le code 259.
        Ok(Some(ExitStatus {
            code: Some(i64::from(code)),
            signal: None,
        }))
    }

    /// Ferme la pseudo-console : les process attachés reçoivent
    /// CTRL_CLOSE_EVENT, la sortie se termine. À appeler pendant que la
    /// sortie est encore lue. Idempotent.
    pub fn close(&self) {
        // Le verrou en écriture attend la fin d'un `resize` en cours ; la
        // valeur est remise à 0 AVANT la fermeture, et le verrou relâché
        // avant l'appel (potentiellement long) : un `resize` concurrent voit
        // 0 et échoue proprement au lieu d'utiliser un HPCON fermé.
        let hpc = match self.hpc.write() {
            Ok(mut guard) => std::mem::replace(&mut *guard, 0),
            Err(poisoned) => std::mem::replace(&mut *poisoned.into_inner(), 0),
        };
        if hpc != 0 {
            // SAFETY: HPCON ouvert, fermé une seule fois (valeur remise à 0).
            unsafe { ClosePseudoConsole(hpc) };
        }
        // Le verrou d'écriture peut être tenu par un `write_input` bloqué
        // (pipe d'entrée plein, programme qui ne lit plus) : attente bornée,
        // jamais indéfinie. En cas d'échec le handle est fermé à la
        // destruction du `Pty`.
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

    /// Un process du job (le programme ou un descendant) vit-il encore ?
    pub fn tree_alive(&self) -> bool {
        active_processes(&self.job) != 0
    }

    /// Tue tout le job (programme et descendance) et attend sa fin. Rend
    /// `true` seulement si le job est effectivement vide.
    pub fn terminate(&self) -> bool {
        terminate_job(&self.job).is_ok_and(|ended| ended.complete())
    }

    /// Sans objet sous Windows (le Job Object contient toute la descendance).
    pub fn reap_orphans(&self) {}
}

impl Drop for Pty {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::{append_quoted_arg, command_line};
    use std::ffi::{OsStr, OsString};

    fn quoted(arg: &str) -> String {
        let mut line = Vec::new();
        append_quoted_arg(OsStr::new(arg), &mut line);
        String::from_utf16(&line).expect("utf16")
    }

    #[test]
    fn regles_de_la_crt() {
        assert_eq!(quoted("simple"), "simple");
        assert_eq!(quoted(""), "\"\"");
        assert_eq!(quoted("a b"), "\"a b\"");
        assert_eq!(quoted("a\"b"), "\"a\\\"b\"");
        assert_eq!(quoted("a\\b"), "a\\b");
        assert_eq!(quoted("a b\\"), "\"a b\\\\\"");
        assert_eq!(quoted("a\\\"b"), "\"a\\\\\\\"b\"");
        assert_eq!(quoted("C:\\Program Files\\x"), "\"C:\\Program Files\\x\"");
    }

    #[test]
    fn ligne_complete() {
        let line = command_line(
            OsStr::new("C:\\Windows\\cmd.exe"),
            &[OsString::from("/d"), OsString::from("echo a b")],
        );
        assert_eq!(
            String::from_utf16(&line[..line.len() - 1]).expect("utf16"),
            "C:\\Windows\\cmd.exe /d \"echo a b\""
        );
        assert_eq!(line.last(), Some(&0));
    }
}
