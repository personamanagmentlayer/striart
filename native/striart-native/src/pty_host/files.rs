//! Fichiers d'état de l'hôte dans son dossier d'agent
//! (`.striart/pty/<agent>/`) :
//!
//! - `host.lock` : verrou exclusif tenu toute la vie de l'hôte (Windows :
//!   ouverture sans partage, supprimée à la fermeture du handle ; POSIX :
//!   `flock`). Le noyau le libère à la mort du process, même brutale : un
//!   second hôte pour le même agent est refusé (sortie 3), jamais lancé en
//!   double, et le socket d'un hôte mort peut être retiré sans risque ;
//! - `host.pid` : PID file écrit ATOMIQUEMENT (temporaire + renommage) une
//!   fois le canal ouvert et le programme lancé — sa présence signifie
//!   « hôte prêt ». Identité vérifiable : `program` (nom du binaire) et la
//!   ligne de commande `pty-host --agent <agent>` que `ptyHostStatus`
//!   reconnaît, `startedAt` postérieur à la création du process (PID
//!   recyclé détecté par l'heure de création) ;
//! - `host.stop` : demande d'arrêt propre (protocole de
//!   `src/stop-request.js`) — `{pid, requestedAt}` écrit par le demandeur,
//!   accusé `ackAt` ajouté par l'hôte visé avant de s'arrêter, fichier
//!   retiré par l'hôte à la sortie.

use crate::json::{self, Json, Value};
use crate::protocol::{NativeError, PROTOCOL_VERSION};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const LOCK_FILE: &str = "host.lock";
pub const PID_FILE: &str = "host.pid";
pub const STOP_FILE: &str = "host.stop";

/// Horodatage ISO 8601 UTC à la milliseconde (`2026-10-24T13:37:05.123Z`),
/// la forme de `new Date().toISOString()`.
pub fn iso8601(time: SystemTime) -> String {
    let ms = time
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let secs = (ms / 1000) as i64;
    let millis = (ms % 1000) as u32;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Jours depuis l'epoch → date civile (algorithme de H. Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Écriture atomique (temporaire dans le même dossier, puis renommage).
pub fn write_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let mut temp_name = path.file_name().unwrap_or_default().to_os_string();
    temp_name.push(format!(".{}.tmp", std::process::id()));
    let temp = path.with_file_name(temp_name);
    let result = std::fs::write(&temp, content).and_then(|()| std::fs::rename(&temp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// Contenu du PID file.
pub fn pid_document(pid: u32, started_at: &str, program: &str, child_pid: u32) -> Json {
    Json::Obj(vec![
        ("pid", Json::UInt(u64::from(pid))),
        ("startedAt", Json::Str(started_at.into())),
        ("implementation", Json::Str("native".into())),
        ("program", Json::Str(program.into())),
        ("protocol", Json::UInt(PROTOCOL_VERSION)),
        ("childPid", Json::UInt(u64::from(child_pid))),
    ])
}

/// PID inscrit dans un fichier JSON `{pid, …}`, s'il est lisible.
pub fn read_pid_field(path: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(path).ok()?;
    let value = json::parse(text.trim()).ok()?;
    u32::try_from(value.get("pid")?.as_u64()?).ok()
}

/// Retire `path` seulement s'il désigne `pid` (jamais le fichier d'un autre
/// hôte qui aurait pris la suite).
pub fn remove_if_owned(path: &Path, pid: u32) {
    if read_pid_field(path) == Some(pid) {
        let _ = std::fs::remove_file(path);
    }
}

/// Demande d'arrêt lue dans `host.stop`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopRequest {
    pub pid: u32,
    pub requested_at: Option<String>,
    pub acknowledged: bool,
}

pub fn parse_stop_request(text: &str) -> Option<StopRequest> {
    let value = json::parse(text.trim()).ok()?;
    let pid = u32::try_from(value.get("pid")?.as_u64()?).ok()?;
    Some(StopRequest {
        pid,
        requested_at: value
            .get("requestedAt")
            .and_then(Value::as_str)
            .map(str::to_string),
        acknowledged: value.get("ackAt").is_some_and(|v| *v != Value::Null),
    })
}

/// Lit la demande d'arrêt ; si elle vise `pid` et n'est pas encore accusée,
/// écrit l'accusé (atomiquement) et rend `true`. Un échec d'écriture (fichier
/// tenu par un lecteur sous Windows) rend `false` : nouvel essai au tour
/// suivant, la demande n'est pas perdue.
pub fn acknowledge_stop(path: &Path, pid: u32) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    let Some(request) = parse_stop_request(&text) else {
        return false;
    };
    if request.pid != pid || request.acknowledged {
        return false;
    }
    let ack = Json::Obj(vec![
        ("pid", Json::UInt(u64::from(pid))),
        ("requestedAt", Json::from(request.requested_at)),
        ("ackAt", Json::Str(iso8601(SystemTime::now()))),
    ]);
    write_atomic(path, format!("{}\n", ack.to_line()).as_bytes()).is_ok()
}

/// Verrou exclusif de l'agent, tenu jusqu'à la destruction.
#[derive(Debug)]
pub struct HostLock {
    #[cfg(windows)]
    _handle: crate::sys::OwnedHandle,
    #[cfg(unix)]
    _file: std::fs::File,
}

/// Issue de la prise du verrou.
#[derive(Debug)]
pub enum LockOutcome {
    Acquired(HostLock),
    /// Un autre hôte vivant tient déjà l'agent.
    Held,
}

#[cfg(windows)]
pub fn acquire_lock(dir: &Path) -> Result<LockOutcome, NativeError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, GENERIC_WRITE, GetLastError,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_DELETE_ON_CLOSE, OPEN_ALWAYS,
    };
    let path: Vec<u16> = dir
        .join(LOCK_FILE)
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // Un hôte précédent qui vient de sortir laisse le fichier « suppression en
    // attente » (DELETE_ON_CLOSE) pendant un court instant : l'ouverture
    // échoue alors en ERROR_ACCESS_DENIED. Ce n'est ni un hôte vivant ni une
    // panne : on réessaie, brièvement, avant de conclure à un échec.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        // SAFETY: chemin terminé par NUL ; partage nul (exclusif) ; le fichier
        // disparaît à la fermeture du handle, y compris à la mort du process.
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_WRITE | windows_sys::Win32::Storage::FileSystem::DELETE,
                0,
                std::ptr::null(),
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_DELETE_ON_CLOSE,
                std::ptr::null_mut(),
            )
        };
        if let Some(handle) = crate::sys::OwnedHandle::new(handle) {
            return Ok(LockOutcome::Acquired(HostLock { _handle: handle }));
        }
        // SAFETY: lecture de l'erreur du thread courant.
        let error = unsafe { GetLastError() };
        if error == ERROR_SHARING_VIOLATION {
            return Ok(LockOutcome::Held);
        }
        if error == ERROR_ACCESS_DENIED && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
            continue;
        }
        return Err(NativeError::os("PTY_STATE_FAILED", "host.lock"));
    }
}

#[cfg(unix)]
pub fn acquire_lock(dir: &Path) -> Result<LockOutcome, NativeError> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(dir.join(LOCK_FILE))
        .map_err(|e| NativeError::failure("PTY_STATE_FAILED", format!("host.lock: {e}")))?;
    // SAFETY: fd valide ; non bloquant.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(LockOutcome::Acquired(HostLock { _file: file }));
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::EWOULDBLOCK) => Ok(LockOutcome::Held),
        _ => Err(NativeError::os("PTY_STATE_FAILED", "flock host.lock")),
    }
}

/// Chemins de l'état d'un hôte.
#[derive(Debug, Clone)]
pub struct StatePaths {
    pub dir: PathBuf,
    pub pid: PathBuf,
    pub stop: PathBuf,
}

impl StatePaths {
    pub fn new(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
            pid: dir.join(PID_FILE),
            stop: dir.join(STOP_FILE),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn horodatage_iso() {
        assert_eq!(iso8601(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso8601(UNIX_EPOCH + Duration::from_millis(1_792_841_548_751)),
            "2026-10-24T11:32:28.751Z"
        );
        // 29 février d'une année bissextile, et fin de siècle.
        assert_eq!(
            iso8601(UNIX_EPOCH + Duration::from_secs(951_782_400)),
            "2000-02-29T00:00:00.000Z"
        );
        assert_eq!(
            iso8601(UNIX_EPOCH + Duration::from_secs(4_107_542_399)),
            "2100-02-28T23:59:59.000Z"
        );
    }

    #[test]
    fn demande_d_arret() {
        assert_eq!(
            parse_stop_request(r#"{"pid":42,"requestedAt":"2026-01-01T00:00:00.000Z"}"#),
            Some(StopRequest {
                pid: 42,
                requested_at: Some("2026-01-01T00:00:00.000Z".into()),
                acknowledged: false
            })
        );
        assert!(parse_stop_request(r#"{"pid":42,"ackAt":"x"}"#).is_some_and(|r| r.acknowledged));
        assert_eq!(parse_stop_request(r#"{"pid":"42"}"#), None);
        assert_eq!(parse_stop_request("garbage"), None);
    }

    #[test]
    fn accuse_atomique_et_cible() {
        let dir = std::env::temp_dir().join(format!("striart-native-stop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let file = dir.join(STOP_FILE);
        std::fs::write(&file, r#"{"pid":7,"requestedAt":"t"}"#).expect("write");
        assert!(!acknowledge_stop(&file, 8), "autre PID : ignorée");
        assert!(acknowledge_stop(&file, 7));
        let after =
            parse_stop_request(&std::fs::read_to_string(&file).expect("read")).expect("parse");
        assert!(after.acknowledged);
        assert_eq!(after.requested_at.as_deref(), Some("t"));
        assert!(!acknowledge_stop(&file, 7), "déjà accusée");
        remove_if_owned(&file, 8);
        assert!(file.exists());
        remove_if_owned(&file, 7);
        assert!(!file.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verrou_exclusif() {
        let dir = std::env::temp_dir().join(format!("striart-native-lock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let first = acquire_lock(&dir).expect("lock");
        assert!(matches!(first, LockOutcome::Acquired(_)));
        // Même process, second handle/fd : refusé (Windows : partage nul ;
        // POSIX : flock est par description de fichier ouverte).
        assert!(matches!(
            acquire_lock(&dir).expect("lock"),
            LockOutcome::Held
        ));
        drop(first);
        assert!(matches!(
            acquire_lock(&dir).expect("lock"),
            LockOutcome::Acquired(_)
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
