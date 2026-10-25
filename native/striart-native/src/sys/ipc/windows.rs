//! Canal d'attache sous Windows : named pipe local en E/S recouvertes
//! (overlapped).
//!
//! - **DACL** : un seul ACE, accès complet pour l'utilisateur courant
//!   (`D:P(A;;GA;;;<SID>)`, protégée contre l'héritage) — ni les autres
//!   utilisateurs, ni « Everyone », ni les administrateurs d'une autre
//!   session ne peuvent s'y connecter. Par défaut, un named pipe accorde la
//!   lecture à « Everyone » et l'accès complet aux administrateurs.
//! - **Local seulement** : `PIPE_REJECT_REMOTE_CLIENTS` refuse les clients
//!   SMB distants.
//! - **Instance unique du nom** : la première instance est créée avec
//!   `FILE_FLAG_FIRST_PIPE_INSTANCE` — si un autre process possède déjà ce
//!   nom (squat), la création échoue au lieu de partager l'espace de noms.
//! - **Overlapped** : sur un handle synchrone, Windows sérialise les E/S
//!   d'un même objet fichier — un `ReadFile` en attente bloquerait tout
//!   `WriteFile` de l'autre thread. Chaque opération a ici sa propre
//!   structure OVERLAPPED et son événement, et peut être annulée
//!   (`CancelIoEx`) pour couper un client lent.

use crate::sys::OwnedHandle;
use std::ffi::c_void;
use std::io;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use windows_sys::Win32::Foundation::{
    ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY,
    ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, GetLastError,
    HANDLE, HLOCAL, LocalFree, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
    ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
    SE_KERNEL_OBJECT,
};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
    TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
    PIPE_ACCESS_DUPLEX, READ_CONTROL, ReadFile, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
    WriteFile,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT, WaitNamedPipeW,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, INFINITE, OpenProcessToken, SetEvent, WaitForMultipleObjects,
};

/// Taille des tampons noyau du pipe, par sens. La contre-pression par client
/// (file de l'hôte) s'ajoute à ces 64 Kio.
const PIPE_BUFFER_BYTES: u32 = 64 * 1024;
/// Attente maximale d'une instance libre côté client.
const CLIENT_BUSY_WAIT_MS: u32 = 2_000;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide_ptr(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    // SAFETY: chaîne terminée par NUL allouée par l'API appelante.
    while unsafe { *ptr.add(len) } != 0 {
        len += 1;
    }
    // SAFETY: `len` caractères lisibles avant le NUL.
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(ptr, len) })
}

/// Mémoire allouée par une API Windows (`LocalAlloc`), libérée à la destruction.
struct LocalMemory(*mut c_void);

impl Drop for LocalMemory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: pointeur alloué par l'API (LocalAlloc), libéré une fois.
            unsafe { LocalFree(self.0 as HLOCAL) };
        }
    }
}

/// SID de l'utilisateur du process, forme texte (`S-1-5-21-…`).
pub fn current_user_sid() -> io::Result<String> {
    let mut token: HANDLE = null_mut();
    // SAFETY: pseudo-handle du process courant ; `token` inscriptible.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = OwnedHandle::new(token).ok_or_else(io::Error::last_os_error)?;
    let mut needed = 0u32;
    // SAFETY: appel de dimensionnement (tampon nul) ; l'échec attendu est
    // ERROR_INSUFFICIENT_BUFFER avec `needed` renseigné.
    unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut needed) };
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    // Tampon de usize : alignement de TOKEN_USER.
    let mut buffer = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
    // SAFETY: tampon d'au moins `needed` octets, aligné.
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast::<c_void>(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: le tampon commence par la structure TOKEN_USER renseignée.
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let mut text: *mut u16 = null_mut();
    // SAFETY: SID valide (dans le tampon vivant) ; `text` alloué par l'API.
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let owned = LocalMemory(text.cast::<c_void>());
    Ok(from_wide_ptr(owned.0.cast::<u16>()))
}

/// SDDL de la DACL appliquée au canal : l'utilisateur courant seul.
pub fn endpoint_sddl(sid: &str) -> String {
    format!("D:P(A;;GA;;;{sid})")
}

/// Descripteur de sécurité (et ses attributs) d'une instance du pipe.
struct Security {
    descriptor: LocalMemory,
}

impl Security {
    fn current_user_only() -> io::Result<Self> {
        let sddl = wide(&endpoint_sddl(&current_user_sid()?));
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: chaîne SDDL terminée par NUL ; `descriptor` alloué par l'API.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            descriptor: LocalMemory(descriptor),
        })
    }

    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor.0,
            bInheritHandle: 0,
        }
    }
}

/// Événement manuel possédé.
fn manual_event() -> io::Result<OwnedHandle> {
    // SAFETY: événement anonyme, sans attributs.
    OwnedHandle::new(unsafe { CreateEventW(null(), 1, 0, null()) })
        .ok_or_else(io::Error::last_os_error)
}

/// Une connexion (côté serveur comme côté client). Lecture et écriture
/// peuvent avoir lieu en même temps depuis deux threads.
#[derive(Debug)]
pub struct Conn {
    handle: OwnedHandle,
    closed: AtomicBool,
}

// SAFETY: un HANDLE de pipe est utilisable depuis n'importe quel thread ;
// chaque opération a sa propre structure OVERLAPPED (aucun état partagé).
unsafe impl Send for Conn {}
// SAFETY: idem — les E/S concurrentes sur un handle overlapped sont prévues
// par l'API, `closed` est atomique.
unsafe impl Sync for Conn {}

impl Conn {
    fn io(&self, write: bool, buffer: *mut u8, len: usize) -> io::Result<usize> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(io::Error::from(io::ErrorKind::NotConnected));
        }
        let event = manual_event()?;
        // SAFETY: structure C sans invariant ; l'événement est renseigné.
        let mut overlapped: OVERLAPPED = unsafe { zeroed() };
        overlapped.hEvent = event.0;
        let len = u32::try_from(len).unwrap_or(u32::MAX);
        // SAFETY: tampon valide pour `len` octets pendant toute l'opération
        // (attendue ci-dessous avant de rendre la main) ; OVERLAPPED vivante.
        let ok = unsafe {
            if write {
                WriteFile(self.handle.0, buffer, len, null_mut(), &mut overlapped)
            } else {
                ReadFile(self.handle.0, buffer, len, null_mut(), &mut overlapped)
            }
        };
        if ok == 0 {
            // SAFETY: lecture de l'erreur du thread courant.
            let error = unsafe { GetLastError() };
            if error != ERROR_IO_PENDING {
                return Err(map_error(error));
            }
        }
        // `shutdown` a pu s'exécuter ENTRE le contrôle de `closed` et le
        // démarrage de l'E/S ci-dessus : son `CancelIoEx` n'avait alors rien
        // à annuler et cette E/S bloquerait pour toujours. L'E/S étant
        // désormais enregistrée, on relit `closed` et on l'annule nous-mêmes ;
        // si `shutdown` survient après cette relecture, son annulation la
        // atteint.
        if self.closed.load(Ordering::SeqCst) {
            // SAFETY: handle valide ; OVERLAPPED de cette opération, vivante.
            unsafe { CancelIoEx(self.handle.0, &overlapped) };
        }
        let mut transferred = 0u32;
        // SAFETY: attente de fin de l'opération démarrée ci-dessus.
        if unsafe { GetOverlappedResult(self.handle.0, &overlapped, &mut transferred, 1) } == 0 {
            // SAFETY: lecture de l'erreur du thread courant.
            return Err(map_error(unsafe { GetLastError() }));
        }
        Ok(transferred as usize)
    }

    /// Lit des octets ; `Ok(0)` à la fermeture par le pair.
    pub fn read(&self, buffer: &mut [u8]) -> io::Result<usize> {
        match self.io(false, buffer.as_mut_ptr(), buffer.len()) {
            Err(e) if is_disconnect(&e) => Ok(0),
            other => other,
        }
    }

    pub fn write_all(&self, mut data: &[u8]) -> io::Result<()> {
        while !data.is_empty() {
            // WriteFile ne modifie pas le tampon : le pointeur mutable n'est
            // exigé que par la signature commune lecture/écriture.
            let n = self.io(true, data.as_ptr().cast_mut(), data.len())?;
            if n == 0 {
                return Err(io::Error::from(io::ErrorKind::WriteZero));
            }
            data = &data[n..];
        }
        Ok(())
    }

    /// Coupe la connexion : les E/S en cours échouent immédiatement
    /// (`CancelIoEx`), les suivantes aussi. Jamais `DisconnectNamedPipe` : il
    /// JETTE les octets que le client n'a pas encore lus — la frame `exit` ou
    /// `evicted` envoyée juste avant serait perdue. Le handle se ferme à la
    /// destruction de la connexion ; le client lit alors ce qui reste, puis la
    /// fin de flux.
    pub fn shutdown(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        // SAFETY: handle valide ; annule toutes les E/S en cours du handle.
        unsafe { CancelIoEx(self.handle.0, null()) };
    }

    /// SDDL de la DACL du pipe (tests de sécurité).
    pub fn dacl_sddl(&self) -> io::Result<String> {
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: handle valide ouvert avec READ_CONTROL ; seul le
        // descripteur est demandé (alloué par l'API).
        let rc = unsafe {
            GetSecurityInfo(
                self.handle.0,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            )
        };
        if rc != 0 {
            return Err(io::Error::from_raw_os_error(rc as i32));
        }
        let descriptor = LocalMemory(descriptor);
        let mut text: *mut u16 = null_mut();
        // SAFETY: descripteur valide ; `text` alloué par l'API.
        if unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor.0,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let text = LocalMemory(text.cast::<c_void>());
        Ok(from_wide_ptr(text.0.cast::<u16>()))
    }
}

fn map_error(code: u32) -> io::Error {
    io::Error::from_raw_os_error(code as i32)
}

fn is_disconnect(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error().map(|c| c as u32),
        Some(ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED | ERROR_OPERATION_ABORTED)
    )
}

/// Serveur d'un canal d'attache.
#[derive(Debug)]
pub struct Listener {
    name: Vec<u16>,
    security: Security,
    /// Instance créée d'avance, en attente du prochain client.
    pending: Mutex<Option<OwnedHandle>>,
    stop: OwnedHandle,
}

impl std::fmt::Debug for Security {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Security(current user only)")
    }
}

// SAFETY: handles utilisables depuis tout thread ; `pending` est protégé par
// un Mutex, le descripteur de sécurité n'est que lu.
unsafe impl Send for Listener {}
// SAFETY: idem.
unsafe impl Sync for Listener {}

impl Listener {
    fn instance(&self, first: bool) -> io::Result<OwnedHandle> {
        let attributes = self.security.attributes();
        let flags = PIPE_ACCESS_DUPLEX
            | FILE_FLAG_OVERLAPPED
            | if first {
                FILE_FLAG_FIRST_PIPE_INSTANCE
            } else {
                0
            };
        // SAFETY: nom terminé par NUL ; attributs de sécurité valides le temps
        // de l'appel (le descripteur vit dans `self`).
        let handle = unsafe {
            CreateNamedPipeW(
                self.name.as_ptr(),
                flags,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                PIPE_BUFFER_BYTES,
                PIPE_BUFFER_BYTES,
                0,
                &attributes,
            )
        };
        OwnedHandle::new(handle).ok_or_else(io::Error::last_os_error)
    }

    /// Attend le prochain client ; `Ok(None)` après `shutdown`.
    pub fn accept(&self) -> io::Result<Option<Conn>> {
        let handle = match self
            .pending
            .lock()
            .map_err(|_| io::Error::other("poisoned"))?
            .take()
        {
            Some(h) => h,
            None => self.instance(false)?,
        };
        let event = manual_event()?;
        // SAFETY: structure C sans invariant ; l'événement est renseigné.
        let mut overlapped: OVERLAPPED = unsafe { zeroed() };
        overlapped.hEvent = event.0;
        // SAFETY: handle serveur valide ; OVERLAPPED vivante jusqu'à la fin
        // de l'attente (ou de l'annulation) ci-dessous.
        let ok = unsafe { ConnectNamedPipe(handle.0, &mut overlapped) };
        let connected = if ok != 0 {
            true
        } else {
            // SAFETY: lecture de l'erreur du thread courant.
            match unsafe { GetLastError() } {
                ERROR_PIPE_CONNECTED => true,
                ERROR_IO_PENDING => false,
                other => return Err(map_error(other)),
            }
        };
        if !connected {
            let events = [event.0, self.stop.0];
            // SAFETY: deux handles d'événement valides.
            let which = unsafe { WaitForMultipleObjects(2, events.as_ptr(), 0, INFINITE) };
            if which != WAIT_OBJECT_0 {
                // Arrêt demandé (ou échec de l'attente) : annule la connexion
                // en cours et attend sa fin avant de libérer OVERLAPPED.
                // SAFETY: handle valide ; OVERLAPPED vivante.
                unsafe { CancelIoEx(handle.0, &overlapped) };
                let mut ignored = 0u32;
                // SAFETY: attente de la fin de l'opération annulée.
                unsafe { GetOverlappedResult(handle.0, &overlapped, &mut ignored, 1) };
                return Ok(None);
            }
            let mut ignored = 0u32;
            // SAFETY: opération terminée (événement signalé).
            if unsafe { GetOverlappedResult(handle.0, &overlapped, &mut ignored, 0) } == 0 {
                // SAFETY: lecture de l'erreur du thread courant.
                let error = unsafe { GetLastError() };
                if error != ERROR_PIPE_CONNECTED {
                    return Err(map_error(error));
                }
            }
        }
        // Instance suivante créée AVANT de rendre la main : un client qui se
        // connecte pendant qu'on sert celui-ci ne trouve jamais le nom vide.
        if let Ok(next) = self.instance(false) {
            *self
                .pending
                .lock()
                .map_err(|_| io::Error::other("poisoned"))? = Some(next);
        }
        Ok(Some(Conn {
            handle,
            closed: AtomicBool::new(false),
        }))
    }

    /// Débloque `accept` (qui rend `Ok(None)`) et refuse les suivants.
    pub fn shutdown(&self) {
        // SAFETY: événement valide.
        unsafe { SetEvent(self.stop.0) };
        if let Ok(mut pending) = self.pending.lock() {
            pending.take();
        }
    }
}

/// Crée le canal `\\.\pipe\…`. Échoue si le nom existe déjà.
pub fn bind(endpoint: &str) -> io::Result<Listener> {
    let listener = Listener {
        name: wide(endpoint),
        security: Security::current_user_only()?,
        pending: Mutex::new(None),
        stop: manual_event()?,
    };
    let first = listener.instance(true)?;
    *listener
        .pending
        .lock()
        .map_err(|_| io::Error::other("poisoned"))? = Some(first);
    Ok(listener)
}

/// Connexion cliente (tests, outils) ; attend brièvement une instance libre.
pub fn connect(endpoint: &str) -> io::Result<Conn> {
    let name = wide(endpoint);
    loop {
        // SAFETY: nom terminé par NUL ; pas d'attributs ; niveau
        // d'usurpation limité à l'identification (le serveur ne peut pas
        // agir au nom du client).
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
                0,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                null_mut(),
            )
        };
        if let Some(handle) = OwnedHandle::new(handle) {
            return Ok(Conn {
                handle,
                closed: AtomicBool::new(false),
            });
        }
        // SAFETY: lecture de l'erreur du thread courant.
        let error = unsafe { GetLastError() };
        if error != ERROR_PIPE_BUSY {
            return Err(map_error(error));
        }
        // SAFETY: nom terminé par NUL.
        if unsafe { WaitNamedPipeW(name.as_ptr(), CLIENT_BUSY_WAIT_MS) } == 0 {
            return Err(io::Error::last_os_error());
        }
    }
}
