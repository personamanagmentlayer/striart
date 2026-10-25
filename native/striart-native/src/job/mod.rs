//! `job run` : exécute une commande dans un conteneur de process et rend un
//! rapport — la primitive du Test Gate (orphelin = gate rouge).
//!
//! - **Conteneur** : Windows, Job Object `KILL_ON_JOB_CLOSE` (le programme y
//!   entre créé suspendu, avant d'avoir pu engendrer quoi que ce soit ; si
//!   `striart-native` meurt, le noyau tue tout le job) ; POSIX, nouveau groupe
//!   de process, et sous Linux `PR_SET_CHILD_SUBREAPER` (les orphelins sont
//!   reparentés sous nous au lieu d'init, même s'ils changent de groupe) plus
//!   `PR_SET_PDEATHSIG` sur le programme.
//! - **Mort brutale de `striart-native`** (SIGKILL, `TerminateProcess`, crash) :
//!   aucun nettoyage n'est possible, et la garantie dépend de l'OS —
//!   **Windows** : le noyau ferme le handle du Job Object et tue TOUTE la
//!   descendance (`KILL_ON_JOB_CLOSE`) ; **Linux** : seul le programme direct
//!   meurt (`PR_SET_PDEATHSIG = SIGKILL`) — ses descendants, eux, ne sont PAS
//!   garantis morts (reparentés sous init, ils vivent jusqu'à leur fin
//!   naturelle) ; **macOS** : aucune garantie (pas de PDEATHSIG). C'est une
//!   asymétrie du système, pas un oubli : un SIGKILL ne laisse aucun code
//!   s'exécuter, et un groupe de process n'a pas d'équivalent POSIX de
//!   `KILL_ON_JOB_CLOSE`. Le Test Gate ne s'y fie pas : il écrit et relit le
//!   rapport du conteneur (`complete`, `survivorPids`) dans le cas normal.
//! - **Flux** : stdin/stdout/stderr du programme SONT ceux de
//!   `striart-native` (handles hérités) — aucune copie, aucun tampon, la
//!   sortie arrive à l'appelant au fil de l'eau.
//! - **Orphelins** : après la sortie du programme, on laisse `grace_ms` aux
//!   descendants pour se terminer seuls ; ceux qui vivent encore sont tués et
//!   comptés (`orphansKilled`).
//! - **Garantie de nettoyage** : le rapport dit si le conteneur est
//!   effectivement vide (`complete`, `survivorPids`). Un `terminate` qui
//!   n'aboutit pas n'est jamais présenté comme un succès : l'appelant (Test
//!   Gate) refuse alors de conclure à l'absence d'orphelin.
//! - **Délai** (`timeout_ms`) : dépassé, tout le conteneur est tué
//!   (`timedOut: true`, `killedOnTimeout`).
//! - **Interruption** (SIGINT/SIGTERM/SIGHUP/SIGQUIT, Ctrl+C/Break/fermeture
//!   console) : tout le conteneur est tué, le rapport est écrit
//!   (`interrupted`), sortie 128+n.
//! - **Rapport** : JSON écrit atomiquement (fichier temporaire puis
//!   renommage) dans `--report-file` ; stdout et stderr appartiennent au
//!   programme.

use crate::cli::JobSpec;
use crate::json::Json;
use crate::protocol::NativeError;
use std::path::Path;

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

/// Fin du programme direct.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub pid: u32,
    /// Code de sortie brut (Windows : u32 non signé, normalisé côté Node).
    pub exit_code: Option<i64>,
    /// Signal fatal (POSIX), nom symbolique (`SIGKILL`).
    pub signal: Option<String>,
    pub timed_out: bool,
    /// Signal ou événement console qui a interrompu `striart-native`.
    pub interrupted: Option<String>,
    /// Descendants vivants après sortie du programme + délai de grâce, tués.
    pub orphan_pids: Vec<u32>,
    /// Process tués à l'expiration du délai ou sur interruption (programme
    /// compris).
    pub killed_pids: Vec<u32>,
    /// Process du conteneur ENCORE vivants à la fin du nettoyage (refus de
    /// l'OS, mort non constatée dans le délai). Non vide ⇒ `complete: false`.
    pub survivor_pids: Vec<u32>,
    pub grace_ms: u64,
    pub duration_ms: u64,
}

impl Report {
    pub fn to_json(&self) -> Json {
        let pids =
            |list: &[u32]| Json::Arr(list.iter().map(|p| Json::UInt(u64::from(*p))).collect());
        Json::Obj(vec![
            ("pid", Json::UInt(u64::from(self.pid))),
            ("exitCode", self.exit_code.map_or(Json::Null, Json::Int)),
            ("signal", Json::from(self.signal.clone())),
            ("timedOut", Json::Bool(self.timed_out)),
            ("interrupted", Json::from(self.interrupted.clone())),
            ("orphansKilled", Json::UInt(self.orphan_pids.len() as u64)),
            ("orphanPids", pids(&self.orphan_pids)),
            ("killedOnTimeout", Json::UInt(self.killed_pids.len() as u64)),
            ("killedPids", pids(&self.killed_pids)),
            ("survivorPids", pids(&self.survivor_pids)),
            ("complete", Json::Bool(self.survivor_pids.is_empty())),
            ("graceMs", Json::UInt(self.grace_ms)),
            ("durationMs", Json::UInt(self.duration_ms)),
        ])
    }
}

/// Exécute le job et écrit son rapport ; rend le code de sortie de
/// `striart-native` (0, ou 128+n sur interruption).
pub fn run(spec: &JobSpec) -> Result<i32, NativeError> {
    #[cfg(unix)]
    let (report, code) = unix::run_job(spec)?;
    #[cfg(windows)]
    let (report, code) = windows::run_job(spec)?;
    let written = write_report(&spec.report_file, &report.to_json());
    // Libère le gestionnaire de fermeture de console, qui attend ce moment
    // (échec d'écriture compris : inutile de le faire attendre).
    #[cfg(windows)]
    windows::report_written();
    written?;
    Ok(code)
}

/// Écriture atomique : le lecteur voit le rapport complet ou rien.
pub fn write_report(path: &Path, report: &Json) -> Result<(), NativeError> {
    let file_name = path
        .file_name()
        .ok_or_else(|| NativeError::usage("--report-file: not a file path"))?;
    let mut temp_name = file_name.to_os_string();
    temp_name.push(format!(".{}.tmp", std::process::id()));
    let temp = path.with_file_name(temp_name);
    let content = format!("{}\n", report.to_line());
    std::fs::write(&temp, content.as_bytes())
        .and_then(|()| std::fs::rename(&temp, path))
        .map_err(|e| {
            let _ = std::fs::remove_file(&temp);
            NativeError::failure("REPORT_WRITE_FAILED", format!("report file: {e}"))
        })
}

/// Pas de scrutation : intervalle de vérification du programme, du délai et
/// des signaux.
pub const POLL_MS: u64 = 10;
/// Intervalle de vérification des descendants pendant le délai de grâce.
pub const GRACE_POLL_MS: u64 = 20;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rapport_json() {
        let report = Report {
            pid: 7,
            exit_code: Some(0),
            signal: None,
            timed_out: false,
            interrupted: None,
            orphan_pids: vec![8, 9],
            killed_pids: vec![],
            survivor_pids: vec![],
            grace_ms: 500,
            duration_ms: 42,
        };
        assert_eq!(
            report.to_json().to_line(),
            r#"{"pid":7,"exitCode":0,"signal":null,"timedOut":false,"interrupted":null,"orphansKilled":2,"orphanPids":[8,9],"killedOnTimeout":0,"killedPids":[],"survivorPids":[],"complete":true,"graceMs":500,"durationMs":42}"#
        );
    }

    #[test]
    fn ecriture_atomique() {
        let dir = std::env::temp_dir().join(format!("striart-native-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("report.json");
        write_report(&path, &Json::Obj(vec![("ok", Json::Bool(true))])).expect("write");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            "{\"ok\":true}\n"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .expect("list")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        let missing_dir = dir.join("absent").join("report.json");
        let error = write_report(&missing_dir, &Json::Null).expect_err("must fail");
        assert_eq!(error.code, "REPORT_WRITE_FAILED");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
