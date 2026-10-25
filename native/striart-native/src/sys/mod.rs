//! Couche système : tout ce qui parle à l'OS vit ici, une implémentation par
//! famille d'OS derrière les mêmes fonctions. Les modules de commande
//! (`proc_info`, `tree_kill`, `job`) ne contiennent aucun appel système.
//!
//! Choix d'implémentation (plutôt que le crate `sysinfo`) : `sysinfo` donne
//! l'heure de création à la SECONDE (`Process::start_time`), trop grossier
//! pour départager un process de celui qui reprend son PID, et rafraîchit
//! toute la table des process (mémoire, CPU, disque) quand on n'en veut que
//! quatre champs. Les API natives donnent la milliseconde (Windows :
//! FILETIME à 100 ns ; macOS : timeval à la µs ; Linux : tick de 10 ms), et
//! sous Windows la ligne de commande s'obtient par
//! `NtQueryInformationProcess(ProcessCommandLineInformation)` avec le seul
//! droit `PROCESS_QUERY_LIMITED_INFORMATION` — là où lire le PEB exige
//! `PROCESS_VM_READ`. Dépendances : `windows-sys` (Microsoft) et `libc`
//! (rust-lang), rien d'autre.

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
compile_error!("striart-native supports Windows, Linux and macOS only");

/// Ligne de la table des process (instantané complet de l'OS).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub pid: u32,
    /// Parent tel que l'OS le rapporte. Sous Windows, un parent mort n'est
    /// PAS remplacé (pas de reparentage) : le numéro peut désigner un process
    /// plus récent qui l'a repris — d'où la comparaison des heures de création.
    pub ppid: Option<u32>,
    /// Création, en ms depuis l'epoch Unix. `None` : illisible (droits).
    pub start_ms: Option<u64>,
    /// Groupe de process (POSIX), `None` sous Windows.
    pub pgid: Option<u32>,
    /// Session (POSIX), `None` sous Windows.
    pub sid: Option<u32>,
    /// Déjà mort mais encore listé — zombie POSIX en attente de collecte, ou
    /// process Windows terminé dont un handle reste ouvert ailleurs : ni
    /// vivant ni tuable, jamais un survivant.
    pub zombie: bool,
}

/// Identité d'un process, telle que rendue par `proc info`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Info {
    pub pid: u32,
    pub ppid: Option<u32>,
    /// Nom d'image brut (`node.exe`, `/usr/bin/zsh`, `-bash`) : la
    /// normalisation appartient à l'appelant (src/process-info.ts).
    pub name: String,
    pub command_line: Option<String>,
    pub start_ms: Option<u64>,
}

/// Issue d'un `kill_verified`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KillOutcome {
    /// Tué par nous (et sa mort constatée quand l'OS le permet).
    Killed,
    /// Plus aucun process sous ce numéro : rien à tuer.
    Gone,
    /// Le numéro appartient désormais à un AUTRE process (heure de création
    /// différente) : surtout ne pas le tuer.
    Mismatch,
    /// Échec (droits, process protégé) : message de l'OS.
    Failed(String),
}

/// Écart toléré entre deux lectures de l'heure de création d'un MÊME
/// process. Seul Linux en a besoin : il la recalcule à chaque lecture depuis
/// l'heure de boot (horloge murale − CLOCK_BOOTTIME, lues à quelques ns
/// d'écart), d'où une gigue de l'ordre de la ms ; 50 ms la couvre sans laisser
/// de place à un recyclage de PID (un PID ne se libère et ne se réattribue pas
/// en 50 ms en pratique). Windows (FILETIME) et macOS (timeval) rendent une
/// valeur STOCKÉE par le noyau : deux lectures du même process sont
/// identiques, la tolérance y est nulle — une fenêtre de 50 ms y ferait
/// prendre pour identique un process qui reprend un PID libéré presque
/// aussitôt (churn de process courts sous Windows).
#[cfg(target_os = "linux")]
pub const START_TIME_TOLERANCE_MS: u64 = 50;
#[cfg(not(target_os = "linux"))]
pub const START_TIME_TOLERANCE_MS: u64 = 0;

/// Deux lectures de l'heure de création désignent-elles le MÊME process ?
/// (`<= TOLERANCE` n'est pas écrit tel quel : avec une tolérance nulle c'est
/// une égalité, et la comparaison « inférieure ou égale à zéro » est absurde.)
#[cfg(target_os = "linux")]
pub fn same_start_time(a: u64, b: u64) -> bool {
    a.abs_diff(b) <= START_TIME_TOLERANCE_MS
}
#[cfg(not(target_os = "linux"))]
pub fn same_start_time(a: u64, b: u64) -> bool {
    a == b
}

/// Ligne de commande POSIX reconstituée depuis argv : les arguments contenant
/// une espace sont entre guillemets doubles (lisible par
/// `splitCommandLine` de src/process-info.ts). Jamais ré-exécutée.
#[cfg(unix)]
pub fn join_command_line(args: &[String]) -> Option<String> {
    if args.is_empty() {
        return None;
    }
    Some(
        args.iter()
            .map(|arg| {
                if arg.chars().any(char::is_whitespace) {
                    format!("\"{arg}\"")
                } else {
                    arg.clone()
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

pub mod ipc;
pub mod pty;

#[cfg(windows)]
pub mod job_object;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(unix)]
pub mod unix;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use self::linux::*;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use self::macos::*;

#[cfg(all(test, unix))]
mod tests {
    use super::join_command_line;

    #[test]
    fn ligne_de_commande_posix() {
        assert_eq!(join_command_line(&[]), None);
        assert_eq!(
            join_command_line(&["node".into(), "a b".into(), "-e".into()]),
            Some("node \"a b\" -e".into())
        );
    }
}

#[cfg(test)]
mod tolerance_tests {
    use super::START_TIME_TOLERANCE_MS;

    /// Windows et macOS rendent une heure de création STOCKÉE : deux lectures
    /// du même process sont identiques, la tolérance y est nulle (une fenêtre
    /// de 50 ms ferait confondre un process avec celui qui reprend son PID).
    /// Seul Linux, qui recalcule l'heure à chaque lecture, en a besoin.
    #[test]
    fn tolerance_nulle_sauf_linux() {
        if cfg!(target_os = "linux") {
            assert_eq!(START_TIME_TOLERANCE_MS, 50);
        } else {
            assert_eq!(START_TIME_TOLERANCE_MS, 0);
        }
    }
}
