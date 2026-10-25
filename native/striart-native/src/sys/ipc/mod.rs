//! Canal d'attache local de l'hôte de pty : named pipe sous Windows (DACL
//! limitée à l'utilisateur courant), socket Unix `0600` ailleurs. Jamais de
//! réseau. Même interface des deux côtés : `bind`/`Listener::accept` pour
//! l'hôte, `connect` pour un client, `Conn` lisible et inscriptible en
//! parallèle depuis deux threads.

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use self::unix::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;
