//! Tests de bout en bout du binaire `striart-native` (protocole, process
//! réels de l'OS). Les process pilotés sont l'exemple `process-fixture`,
//! construit par `cargo test`.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};
use striart_native::sys;

fn native() -> &'static str {
    env!("CARGO_BIN_EXE_striart-native")
}

fn fixture() -> PathBuf {
    let dir = Path::new(native()).parent().expect("target dir");
    let name = format!("process-fixture{}", std::env::consts::EXE_SUFFIX);
    let path = dir.join("examples").join(name);
    assert!(
        path.exists(),
        "fixture missing: {} (cargo test builds examples)",
        path.display()
    );
    path
}

fn run(args: &[&str]) -> Output {
    Command::new(native())
        .args(args)
        .output()
        .expect("run striart-native")
}

/// Valeur brute d'un champ numérique ou littéral d'un document JSON plat.
fn field<'a>(json: &'a str, name: &str) -> &'a str {
    let key = format!("\"{name}\":");
    let start = json
        .find(&key)
        .unwrap_or_else(|| panic!("{name} absent: {json}"))
        + key.len();
    let rest = &json[start..];
    let end = rest.find([',', '}']).unwrap_or(rest.len());
    &rest[..end]
}

fn alive(pid: u32) -> bool {
    sys::infos(&[pid]).map(|v| !v.is_empty()).unwrap_or(false)
        && sys::snapshot()
            .map(|t| t.iter().any(|e| e.pid == pid && !e.zombie))
            .unwrap_or(false)
}

fn wait_dead(pid: u32, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    !alive(pid)
}

fn temp_report(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("striart-native-it-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir.join("report.json")
}

fn job(grace_ms: u64, timeout_ms: Option<u64>, role: &str, ms: u64, tag: &str) -> (Output, String) {
    let report = temp_report(tag);
    let mut command = Command::new(native());
    command.args(["job", "run", "--grace-ms", &grace_ms.to_string()]);
    if let Some(t) = timeout_ms {
        command.args(["--timeout-ms", &t.to_string()]);
    }
    command
        .arg("--report-file")
        .arg(&report)
        .arg("--")
        .arg(fixture())
        .args([role, &ms.to_string()]);
    let output = command.output().expect("job run");
    let text = std::fs::read_to_string(&report).unwrap_or_default();
    let _ = std::fs::remove_dir_all(report.parent().expect("dir"));
    (output, text)
}

#[test]
fn version_et_erreur_d_usage() {
    let out = run(&["version"]);
    assert!(out.status.success());
    let doc = String::from_utf8(out.stdout).expect("utf8");
    assert_eq!(field(&doc, "protocol"), "1");
    assert!(doc.ends_with('\n') && doc.lines().count() == 1);

    let bad = run(&["proc", "info", "--pids", "abc"]);
    assert_eq!(bad.status.code(), Some(2));
    assert!(bad.stdout.is_empty(), "stdout must stay empty on error");
    let err = String::from_utf8(bad.stderr).expect("utf8");
    assert!(err.starts_with("{\"error\":{\"code\":\"USAGE\""), "{err}");
}

#[test]
fn proc_info_lot_et_absent() {
    let me = std::process::id();
    let out = run(&["proc", "info", "--pids", &format!("{me},4294967294")]);
    assert!(out.status.success());
    let doc = String::from_utf8(out.stdout).expect("utf8");
    assert!(doc.contains(&format!("{{\"pid\":{me},")), "{doc}");
    assert!(doc.ends_with("\"missing\":[4294967294]}\n"), "{doc}");
    assert_ne!(field(&doc, "startTimeMs"), "null");
}

#[test]
fn job_run_orphelin_compte_et_tue() {
    let (out, report) = job(300, None, "spawn-orphan", 60_000, "orphan");
    assert!(out.status.success(), "{out:?}");
    // Le PID du petit-fils, écrit par le fixture, est passé par NOTRE stdout
    // (flux hérité, pas tamponné).
    let orphan: u32 = String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .expect("orphan pid on stdout");
    assert_eq!(field(&report, "exitCode"), "0");
    assert_eq!(field(&report, "orphansKilled"), "1", "{report}");
    assert!(
        report.contains(&format!("\"orphanPids\":[{orphan}]")),
        "{report}"
    );
    assert!(
        wait_dead(orphan, Duration::from_secs(5)),
        "orphan {orphan} survived"
    );
}

#[test]
fn job_run_descendant_qui_finit_dans_le_delai_de_grace() {
    let (out, report) = job(5_000, None, "spawn-orphan", 300, "grace");
    assert!(out.status.success());
    assert_eq!(field(&report, "orphansKilled"), "0", "{report}");
    assert_eq!(field(&report, "timedOut"), "false");
}

#[test]
fn job_run_timeout_tue_tout() {
    let started = Instant::now();
    // Délai assez long pour que le fixture lance son enfant sur une machine
    // chargée ; ce qui est vérifié est le kill de TOUT le conteneur.
    let (out, report) = job(100, Some(4_000), "spawn-tree", 60_000, "timeout");
    assert!(out.status.success());
    assert!(started.elapsed() < Duration::from_secs(30));
    assert_eq!(field(&report, "timedOut"), "true", "{report}");
    let killed: u64 = field(&report, "killedOnTimeout").parse().expect("count");
    assert!(killed >= 2, "program and its child: {report}");
    let child: u32 = String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .expect("child pid");
    assert!(wait_dead(child, Duration::from_secs(5)));
}

#[test]
fn job_run_programme_introuvable() {
    let report = temp_report("missing");
    let out = Command::new(native())
        .args(["job", "run", "--grace-ms", "0", "--report-file"])
        .arg(&report)
        .args(["--", "striart-native-no-such-program"])
        .output()
        .expect("run");
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("SPAWN_FAILED"));
    assert!(!report.exists());
}

/// Lance `spawn-orphan` en racine (groupe propre sous POSIX, comme les
/// subprocess `detached` de Striart), attend sa sortie : rend (racine, son
/// heure de création, petit-fils).
fn orphaned_grandchild() -> (u32, u64, u32) {
    let mut command = Command::new(fixture());
    command
        .args(["spawn-orphan", "60000"])
        .stdout(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().expect("spawn root");
    let root = child.id();
    let started = sys::infos(&[root])
        .expect("infos")
        .first()
        .and_then(|i| i.start_ms);
    let grandchild = first_line_pid(child.stdout.take().expect("stdout"));
    // Lecture d'une seule ligne : sous Windows, le petit-fils hérite du
    // handle du tube (bInheritHandles) et le garde ouvert jusqu'à sa mort.
    child.wait().expect("root exit");
    (root, started.expect("root start time"), grandchild)
}

fn first_line_pid(stdout: std::process::ChildStdout) -> u32 {
    use std::io::BufRead;
    let mut line = String::new();
    std::io::BufReader::new(stdout)
        .read_line(&mut line)
        .expect("read pid");
    line.trim().parse().expect("pid line")
}

#[test]
fn tree_kill_racine_morte_avec_son_heure() {
    let (root, started, grandchild) = orphaned_grandchild();
    assert!(alive(grandchild));
    let out = run(&[
        "proc",
        "tree-kill",
        "--pid",
        &root.to_string(),
        "--root-started-ms",
        &started.to_string(),
    ]);
    assert!(out.status.success());
    let doc = String::from_utf8(out.stdout).expect("utf8");
    assert_eq!(field(&doc, "rootState"), "\"dead\"", "{doc}");
    assert!(doc.contains(&format!("{{\"pid\":{grandchild},")), "{doc}");
    assert!(wait_dead(grandchild, Duration::from_secs(5)));
}

#[test]
fn tree_kill_racine_vivante() {
    let mut child = Command::new(fixture())
        .args(["spawn-tree", "60000"])
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn");
    let root = child.id();
    let grandchild = first_line_pid(child.stdout.take().expect("stdout"));
    let out = run(&["proc", "tree-kill", "--pid", &root.to_string()]);
    let doc = String::from_utf8(out.stdout).expect("utf8");
    assert_eq!(field(&doc, "rootState"), "\"alive\"", "{doc}");
    assert!(wait_dead(grandchild, Duration::from_secs(5)), "{doc}");
    // Collecte de la racine tuée (sinon zombie sous POSIX).
    let status = child.wait().expect("root reaped");
    assert!(!status.success());
    assert!(wait_dead(root, Duration::from_secs(5)), "{doc}");
}

/// N-I6 : le rapport de `job run` DIT si le conteneur est vide ; un nettoyage
/// réussi est `complete: true`, sans survivant.
#[test]
fn job_run_rapport_complet_apres_nettoyage() {
    let (out, report) = job(300, None, "spawn-orphan", 60_000, "complete");
    assert!(out.status.success(), "{out:?}");
    assert_eq!(field(&report, "complete"), "true", "{report}");
    assert!(report.contains("\"survivorPids\":[]"), "{report}");
    let (_, timeout_report) = job(100, Some(3_000), "spawn-tree", 60_000, "complete-timeout");
    assert_eq!(
        field(&timeout_report, "complete"),
        "true",
        "{timeout_report}"
    );
    assert!(
        timeout_report.contains("\"survivorPids\":[]"),
        "{timeout_report}"
    );
}

/// N-I6 : `tree-kill` rend `survivors` et `complete` (jamais un simple succès).
#[test]
fn tree_kill_rend_survivors_et_complete() {
    let mut child = Command::new(fixture())
        .args(["spawn-tree", "60000"])
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn");
    let root = child.id();
    let grandchild = first_line_pid(child.stdout.take().expect("stdout"));
    let out = run(&["proc", "tree-kill", "--pid", &root.to_string()]);
    let doc = String::from_utf8(out.stdout).expect("utf8");
    assert_eq!(field(&doc, "complete"), "true", "{doc}");
    assert!(doc.contains("\"survivors\":[]"), "{doc}");
    assert!(wait_dead(grandchild, Duration::from_secs(5)), "{doc}");
    let _ = child.wait();
    // Racine absente : rien à tuer, et l'arbre est (trivialement) éteint.
    let out = run(&["proc", "tree-kill", "--pid", "4294967290"]);
    let doc = String::from_utf8(out.stdout).expect("utf8");
    assert_eq!(field(&doc, "rootState"), "\"dead\"", "{doc}");
    assert_eq!(field(&doc, "complete"), "true", "{doc}");
}

/// SIGTERM / SIGINT sur `job run` : tout le conteneur est tué, le rapport est
/// écrit (`interrupted`), sortie 128+n (POSIX ; sous Windows l'équivalent
/// console, non pilotable sans console dédiée).
#[cfg(unix)]
#[test]
fn job_run_interrompu_par_signal_tue_le_conteneur_et_ecrit_le_rapport() {
    for (signal, name) in [(libc::SIGTERM, "SIGTERM"), (libc::SIGINT, "SIGINT")] {
        let report_path = temp_report(&format!("signal-{name}"));
        let mut child = Command::new(native())
            .args(["job", "run", "--grace-ms", "100", "--report-file"])
            .arg(&report_path)
            .arg("--")
            .arg(fixture())
            .args(["spawn-tree", "60000"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("job run");
        let grandchild = first_line_pid(child.stdout.take().expect("stdout"));
        assert!(alive(grandchild));
        // SAFETY: signal envoyé à notre propre enfant.
        unsafe { libc::kill(child.id() as libc::pid_t, signal) };
        let status = child.wait().expect("job run must exit");
        assert_eq!(status.code(), Some(128 + signal), "{name}");
        let report = std::fs::read_to_string(&report_path).expect("report written");
        assert_eq!(
            field(&report, "interrupted"),
            format!("\"{name}\""),
            "{report}"
        );
        assert_eq!(field(&report, "complete"), "true", "{report}");
        assert!(
            wait_dead(grandchild, Duration::from_secs(5)),
            "{name}: grandchild survived"
        );
        let _ = std::fs::remove_dir_all(report_path.parent().expect("dir"));
    }
}

/// N-I5 : `striart-native job run` est tué BRUTALEMENT (SIGKILL /
/// TerminateProcess). Windows : le Job Object KILL_ON_JOB_CLOSE emporte toute
/// la descendance. Linux : le programme direct meurt (PR_SET_PDEATHSIG) ; ses
/// descendants ne sont PAS garantis morts (asymétrie documentée, voir
/// job/mod.rs) — le test n'affirme donc que ce qui est garanti.
#[test]
fn job_run_tue_brutalement_emporte_le_programme() {
    let report_path = temp_report("brutal");
    let mut child = Command::new(native())
        .args(["job", "run", "--grace-ms", "100", "--report-file"])
        .arg(&report_path)
        .arg("--")
        .arg(fixture())
        .args(["spawn-tree", "60000"])
        .stdout(Stdio::piped())
        .spawn()
        .expect("job run");
    let job_run = child.id();
    let grandchild = first_line_pid(child.stdout.take().expect("stdout"));
    let program_pid = sys::snapshot()
        .expect("snapshot")
        .into_iter()
        .find(|e| e.ppid == Some(job_run) && !e.zombie && e.pid != grandchild)
        .map(|e| e.pid)
        .expect("program under job run");
    child.kill().expect("kill -9 job run");
    let _ = child.wait();
    if cfg!(any(windows, target_os = "linux")) {
        assert!(
            wait_dead(program_pid, Duration::from_secs(10)),
            "program {program_pid} survived the brutal death of job run"
        );
    }
    if cfg!(windows) {
        assert!(
            wait_dead(grandchild, Duration::from_secs(10)),
            "Job Object must take the whole descendance"
        );
    }
    // Ménage : les survivants éventuels (POSIX) ne doivent pas fuir du test.
    let _ = run(&["proc", "tree-kill", "--pid", &grandchild.to_string()]);
    let _ = std::fs::remove_dir_all(report_path.parent().expect("dir"));
}
