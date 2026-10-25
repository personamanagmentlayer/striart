//! Canal d'attache sous POSIX : socket Unix créé directement en `0600`.
//!
//! Le socket naît avec les droits du umask du process : le umask est mis à
//! `0177` le temps du `bind` (l'hôte n'a encore lancé aucun thread à ce
//! moment — voir `pty_host::run`), puis les droits sont réimposés par
//! `chmod 0600` — aucune fenêtre où un autre utilisateur local pourrait se
//! connecter (l'ancien hôte Node créait le socket puis le restreignait). Le
//! dossier parent, propre à l'agent, est lui-même restreint à `0700`.

use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Une connexion ; lecture et écriture concurrentes depuis deux threads.
#[derive(Debug)]
pub struct Conn {
    reader: UnixStream,
    writer: UnixStream,
    closed: AtomicBool,
}

impl Conn {
    fn new(stream: UnixStream) -> io::Result<Self> {
        Ok(Self {
            writer: stream.try_clone()?,
            reader: stream,
            closed: AtomicBool::new(false),
        })
    }

    /// Lit des octets ; `Ok(0)` à la fermeture par le pair.
    pub fn read(&self, buffer: &mut [u8]) -> io::Result<usize> {
        match (&self.reader).read(buffer) {
            Err(e) if e.kind() == io::ErrorKind::ConnectionReset => Ok(0),
            other => other,
        }
    }

    pub fn write_all(&self, data: &[u8]) -> io::Result<()> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(io::Error::from(io::ErrorKind::NotConnected));
        }
        (&self.writer).write_all(data)
    }

    /// Coupe la connexion : les E/S bloquées échouent ou rendent EOF.
    pub fn shutdown(&self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            let _ = self.reader.shutdown(Shutdown::Both);
        }
    }
}

/// Serveur d'un canal d'attache.
#[derive(Debug)]
pub struct Listener {
    inner: UnixListener,
    path: PathBuf,
    stopped: AtomicBool,
}

impl Listener {
    /// Attend le prochain client ; `Ok(None)` après `shutdown`.
    pub fn accept(&self) -> io::Result<Option<Conn>> {
        loop {
            match self.inner.accept() {
                Ok((stream, _)) => {
                    if self.stopped.load(Ordering::SeqCst) {
                        return Ok(None);
                    }
                    return Conn::new(stream).map(Some);
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(_) if self.stopped.load(Ordering::SeqCst) => return Ok(None),
                Err(e) => return Err(e),
            }
        }
    }

    /// Débloque `accept` (connexion à soi-même) et retire le socket.
    pub fn shutdown(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = UnixStream::connect(&self.path);
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Crée le socket en `0600`. Un fichier déjà présent au chemin est un
/// reliquat d'un hôte mort : l'appelant détient le verrou exclusif de
/// l'agent (`host.lock`), aucun hôte vivant ne peut donc l'occuper.
pub fn bind(endpoint: &str) -> io::Result<Listener> {
    let path = PathBuf::from(endpoint);
    if let Some(parent) = path.parent() {
        restrict_dir(parent)?;
    }
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    // SAFETY: umask(2) n'échoue jamais ; l'ancien masque est restauré juste
    // après. Aucun autre thread n'existe à cet instant (contrat de l'appelant).
    let previous = unsafe { libc::umask(0o177) };
    let bound = UnixListener::bind(&path);
    // SAFETY: idem.
    unsafe { libc::umask(previous) };
    let inner = bound?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    Ok(Listener {
        inner,
        path,
        stopped: AtomicBool::new(false),
    })
}

fn restrict_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

/// Connexion cliente (tests, outils).
pub fn connect(endpoint: &str) -> io::Result<Conn> {
    Conn::new(UnixStream::connect(endpoint)?)
}

/// Droits du socket (tests de sécurité).
pub fn endpoint_mode(endpoint: &str) -> io::Result<u32> {
    use std::os::unix::fs::MetadataExt;
    Ok(std::fs::metadata(endpoint)?.mode() & 0o777)
}
