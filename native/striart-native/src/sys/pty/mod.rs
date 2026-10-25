//! Pseudo-terminal hébergé par `pty-host` : ConPTY sous Windows, `openpty`
//! sous POSIX, derrière la même interface (`Pty`).
//!
//! Choix d'implémentation (plutôt que le crate `portable-pty` de WezTerm,
//! envisagé par la roadmap) : `portable-pty` 0.9 (dernière version
//! 2025-02) tire `winapi` (plus maintenu depuis 2021, doublon de
//! `windows-sys`), `shared_library` (dernière version 2017), `serial2` (ports
//! série, sans rapport), `bitflags` 1 et 2 à la fois — la politique
//! `cargo deny` du dépôt (doublons et crates non maintenus refusés) le
//! rejette. Les deux API natives tiennent en quelques centaines de lignes
//! sur `windows-sys` et `libc`, déjà audités, et donnent la main sur ce qui
//! comptait dans les bugs constatés avec node-pty : l'ordre de fermeture de
//! ConPTY (sortie drainée pendant `ClosePseudoConsole`) et la mort de toute
//! la descendance avec l'hôte (Job Object, groupe de session POSIX).
//!
//! # Mort brutale de l'hôte (SIGKILL, `TerminateProcess`)
//!
//! Aucun code ne s'exécute ; la garantie vient de l'OS et n'est PAS la même
//! partout :
//! - **Windows** : le handle du Job Object se ferme avec le process, le noyau
//!   tue TOUTE la descendance (`KILL_ON_JOB_CLOSE`) ;
//! - **Linux** : le programme du pty reçoit `PR_SET_PDEATHSIG = SIGKILL` ; de
//!   plus, la fermeture du maître envoie SIGHUP au groupe de premier plan, où
//!   vivent d'ordinaire ses descendants. Un descendant qui a QUITTÉ le groupe
//!   (`setsid`, `nohup` + démon) ou ignore SIGHUP survit : il n'existe pas
//!   d'équivalent POSIX de `KILL_ON_JOB_CLOSE` ;
//! - **macOS** : SIGHUP du noyau seulement (pas de `PDEATHSIG`).
//!
//! À l'arrêt PROPRE, en revanche, l'hôte tue le groupe puis les descendants
//! SUIVIS (liste de PID + heures de création établie avant l'arrêt et
//! rafraîchie toutes les 2 s) qui ont quitté le groupe : seuls les process de
//! l'arbre du programme sont visés. Sous Linux l'hôte est de plus
//! « subreaper » : les orphelins lui sont reparentés, ses zombies suivis sont
//! collectés.

use std::ffi::OsString;
use std::path::Path;

/// Programme à lancer dans le pty (chemin déjà résolu, voir `resolve_program`).
#[derive(Debug)]
pub struct PtySpec<'a> {
    pub program: &'a Path,
    pub args: &'a [OsString],
    pub cwd: &'a Path,
    pub cols: u16,
    pub rows: u16,
    /// POSIX : valeur de `TERM` pour le programme (ignoré sous Windows).
    pub term: Option<&'a str>,
    /// Le programme du pty est le SEUL enfant du process courant (l'hôte
    /// `pty-host`, devenu subreaper sous Linux) : tout enfant de ce process est
    /// alors un descendant orphelin du programme et sera tué avec lui, même s'il
    /// a été reparenté avant d'avoir pu être suivi. Faux pour une bibliothèque
    /// qui héberge plusieurs ptys (ou d'autres enfants) dans le même process :
    /// seuls les descendants SUIVIS sont alors visés. Sans effet sous Windows
    /// (le Job Object contient toute la descendance).
    pub adopt_orphans: bool,
}

/// Fin du programme direct.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitStatus {
    pub code: Option<i64>,
    /// Signal fatal (POSIX), numéro.
    pub signal: Option<i32>,
}

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use self::unix::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

/// Résout `program` en chemin absolu SANS jamais chercher dans le dossier
/// courant : le dossier de travail du pty est le clone d'un agent, dont le
/// contenu n'est pas de confiance — un `powershell.exe` déposé à sa racine ne
/// doit pas être lancé à la place du vrai (Windows cherche par défaut dans le
/// dossier courant avant le PATH). Un nom sans séparateur est cherché dans
/// les entrées ABSOLUES de `PATH` ; un chemin explicite est pris tel quel
/// (relatif : par rapport à `cwd`). Sous Windows, seuls `.exe` et `.com`
/// sont lançables directement (un `.bat`/`.cmd` passerait par cmd.exe et son
/// interprétation des arguments).
pub fn resolve_program(
    program: &std::ffi::OsStr,
    cwd: &Path,
    path_var: Option<&std::ffi::OsStr>,
) -> Option<std::path::PathBuf> {
    let candidate = Path::new(program);
    let has_separator = candidate.components().count() > 1 || candidate.is_absolute();
    let extensions: &[&str] = if cfg!(windows) {
        &["", ".exe", ".com"]
    } else {
        &[""]
    };
    let accept = |path: std::path::PathBuf| -> Option<std::path::PathBuf> {
        let is_file = path.metadata().map(|m| m.is_file()).unwrap_or(false);
        if !is_file {
            return None;
        }
        // POSIX : un fichier sans bit d'exécution n'est pas lançable
        // (`execvp` le saute et continue la recherche dans PATH : prendre le
        // premier fichier venu masquerait le vrai programme situé plus loin).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let executable = path
                .metadata()
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false);
            if !executable {
                return None;
            }
        }
        if cfg!(windows) {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if ext != "exe" && ext != "com" {
                return None;
            }
        }
        Some(path)
    };
    let with_extensions = |base: std::path::PathBuf| -> Option<std::path::PathBuf> {
        extensions.iter().find_map(|ext| {
            let mut name = base.clone().into_os_string();
            name.push(ext);
            accept(std::path::PathBuf::from(name))
        })
    };
    if has_separator {
        let base = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            cwd.join(candidate)
        };
        return with_extensions(base);
    }
    let path_var = path_var?;
    std::env::split_paths(path_var)
        .filter(|dir| dir.is_absolute())
        .find_map(|dir| with_extensions(dir.join(candidate)))
}

#[cfg(all(test, unix))]
mod tests {
    use super::resolve_program;
    use std::os::unix::fs::PermissionsExt;

    fn write(dir: &std::path::Path, name: &str, mode: u32) {
        let file = dir.join(name);
        std::fs::write(&file, b"#!/bin/sh\n").expect("write");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).expect("chmod");
    }

    #[test]
    fn un_fichier_non_executable_du_path_est_saute() {
        let root = std::env::temp_dir().join(format!("striart-resolve-{}", std::process::id()));
        let first = root.join("first");
        let second = root.join("second");
        std::fs::create_dir_all(&first).expect("dir");
        std::fs::create_dir_all(&second).expect("dir");
        write(&first, "tool", 0o644);
        write(&second, "tool", 0o755);
        let path_var = std::env::join_paths([&first, &second]).expect("join");
        let found = resolve_program("tool".as_ref(), &root, Some(path_var.as_os_str()));
        assert_eq!(found, Some(second.join("tool")));
        // Un chemin explicite non exécutable n'est pas résolu non plus.
        assert_eq!(
            resolve_program(first.join("tool").as_os_str(), &root, None),
            None
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
