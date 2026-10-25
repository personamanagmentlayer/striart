//! Analyse stricte de argv et aiguillage vers les commandes.
//!
//! Validation positive : toute option inconnue, répétée, sans valeur ou hors
//! bornes est une erreur d'usage (sortie 2), jamais ignorée. Les commandes
//! sont regroupées par domaine (`proc`, `job`, `pty-host`) ; un domaine
//! s'ajoute comme une variante de `Command` et un module, sans toucher aux
//! autres.

use crate::protocol::{NativeError, PROTOCOL_VERSION, emit_data, emit_error, exit};
use crate::pty_host::{self, PtyHostSpec};
use crate::{job, json::Json, proc_info, tree_kill};
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

/// Nombre maximal de PID par `proc info` : borne la taille de la requête et
/// de la réponse (le plus gros lot réel est le daemon + un hôte de pty par
/// agent).
pub const MAX_PIDS: usize = 4096;
/// Délai de grâce maximal de `job run` (10 min).
pub const MAX_GRACE_MS: u64 = 600_000;
/// Délai maximal de `job run` (24 h).
pub const MAX_TIMEOUT_MS: u64 = 86_400_000;

pub const USAGE: &str = "\
Usage: striart-native <command> [options]

Commands:
  version
      Protocol and build identity (JSON).
  proc info --pids <pid,pid,...>
      Identity of each process: pid, ppid, image name, command line,
      creation time (ms since the Unix epoch).
  proc tree-kill --pid <pid> [--root-started-ms <ms>]
      Kill the whole process tree rooted at <pid> (descendants included,
      even when the root already exited); reports the killed processes.
  job run --grace-ms <ms> [--timeout-ms <ms>] --report-file <path>
          [--windows-verbatim-args] -- <program> [args...]
      Run <program> inside a process container (Windows Job Object, POSIX
      process group + Linux child subreaper). stdin/stdout/stderr are the
      program's own. Descendants still alive <grace-ms> after the program
      exits are killed and counted; the JSON report is written atomically
      to <path>.

  pty-host --agent <name> --state-dir <dir> --endpoint <path> --cwd <dir>
           [--cols <n>] [--rows <n>] [--initial <text>] [--term <name>]
           [--replay-bytes <n>] [--client-queue-bytes <n>]
           [--kill-grace-ms <ms>] [--parent-pid <pid>] -- <program> [args...]
      Host <program> in a pseudo-terminal (ConPTY / POSIX pty) and serve it
      to attach clients over a local endpoint (named pipe restricted to the
      current user / Unix socket 0600) with the ndjson attach protocol.
      Writes <state-dir>/host.pid once ready; stops cleanly on a
      <state-dir>/host.stop request, a signal, the end of <program> or the
      death of --parent-pid. Exit 3: a host already runs for this agent.

stdout carries data only; errors are one JSON line on stderr.
Exit codes: 0 ok, 1 failure, 2 usage, 3 pty host already running,
128+n interrupted by signal n.
";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Help,
    Version,
    ProcInfo {
        pids: Vec<u32>,
    },
    TreeKill {
        pid: u32,
        root_started_ms: Option<u64>,
    },
    JobRun(JobSpec),
    PtyHost(PtyHostSpec),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobSpec {
    pub grace_ms: u64,
    pub timeout_ms: Option<u64>,
    pub report_file: PathBuf,
    /// Windows : les arguments après le programme sont transmis tels quels
    /// (sans requotage MSVC), comme `windowsVerbatimArguments` de Node —
    /// nécessaire pour `cmd.exe /d /s /c "<commande>"`.
    pub verbatim_args: bool,
    pub argv: Vec<OsString>,
}

/// Point d'entrée : rend le code de sortie du process.
pub fn run(args: Vec<OsString>) -> i32 {
    match parse(&args).and_then(execute) {
        Ok(code) => code,
        Err(error) => {
            emit_error(&error);
            error.exit_code
        }
    }
}

fn execute(command: Command) -> Result<i32, NativeError> {
    match command {
        Command::Help => {
            print!("{USAGE}");
            Ok(exit::OK)
        }
        Command::Version => {
            emit_data(&version_document())?;
            Ok(exit::OK)
        }
        Command::ProcInfo { pids } => {
            emit_data(&proc_info::run(&pids)?)?;
            Ok(exit::OK)
        }
        Command::TreeKill {
            pid,
            root_started_ms,
        } => {
            emit_data(&tree_kill::run(pid, root_started_ms)?)?;
            Ok(exit::OK)
        }
        Command::JobRun(spec) => job::run(&spec),
        Command::PtyHost(spec) => pty_host::run(&spec),
    }
}

pub fn version_document() -> Json {
    Json::Obj(vec![
        ("name", Json::Str("striart-native".into())),
        ("version", Json::Str(env!("CARGO_PKG_VERSION").into())),
        ("protocol", Json::UInt(PROTOCOL_VERSION)),
        ("os", Json::Str(std::env::consts::OS.into())),
        ("arch", Json::Str(std::env::consts::ARCH.into())),
        (
            "commands",
            Json::Arr(
                ["proc info", "proc tree-kill", "job run", "pty-host"]
                    .into_iter()
                    .map(|c| Json::Str(c.into()))
                    .collect(),
            ),
        ),
    ])
}

/// Analyse argv (sans le nom du programme).
pub fn parse(args: &[OsString]) -> Result<Command, NativeError> {
    let words: Vec<&OsStr> = args.iter().map(OsString::as_os_str).collect();
    match words.as_slice() {
        [] => Err(NativeError::usage("missing command (see --help)")),
        [h] if *h == "--help" || *h == "-h" || *h == "help" => Ok(Command::Help),
        [v] if *v == "version" || *v == "--version" => Ok(Command::Version),
        [d, c, rest @ ..] if *d == "proc" && *c == "info" => parse_proc_info(rest),
        [d, c, rest @ ..] if *d == "proc" && *c == "tree-kill" => parse_tree_kill(rest),
        [d, c, rest @ ..] if *d == "job" && *c == "run" => parse_job_run(rest),
        [c, rest @ ..] if *c == "pty-host" => parse_pty_host(rest),
        [first, ..] => Err(NativeError::usage(format!(
            "unknown command \"{}\" (see --help)",
            first.to_string_lossy()
        ))),
    }
}

/// Options `--nom valeur` (et drapeaux) d'une commande, chacune au plus une fois.
struct Options<'a> {
    values: Vec<(&'static str, &'a OsStr)>,
    flags: Vec<&'static str>,
}

impl<'a> Options<'a> {
    fn parse(
        words: &[&'a OsStr],
        valued: &'static [&'static str],
        flags: &'static [&'static str],
    ) -> Result<Self, NativeError> {
        let mut options = Options {
            values: Vec::new(),
            flags: Vec::new(),
        };
        let mut i = 0;
        while i < words.len() {
            let word = words[i]
                .to_str()
                .ok_or_else(|| NativeError::usage("option names must be valid UTF-8"))?;
            if let Some(&flag) = flags.iter().find(|f| **f == word) {
                if options.flags.contains(&flag) {
                    return Err(NativeError::usage(format!("option {flag} given twice")));
                }
                options.flags.push(flag);
                i += 1;
                continue;
            }
            let Some(&name) = valued.iter().find(|a| **a == word) else {
                return Err(NativeError::usage(format!("unknown option \"{word}\"")));
            };
            if options.values.iter().any(|(n, _)| *n == name) {
                return Err(NativeError::usage(format!("option {name} given twice")));
            }
            let Some(value) = words.get(i + 1) else {
                return Err(NativeError::usage(format!("option {name} needs a value")));
            };
            options.values.push((name, value));
            i += 2;
        }
        Ok(options)
    }

    fn get(&self, name: &str) -> Option<&'a OsStr> {
        self.values
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| *v)
    }

    fn require(&self, name: &str) -> Result<&'a OsStr, NativeError> {
        self.get(name)
            .ok_or_else(|| NativeError::usage(format!("missing required option {name}")))
    }

    fn flag(&self, name: &str) -> bool {
        self.flags.contains(&name)
    }
}

fn utf8<'a>(value: &'a OsStr, option: &str) -> Result<&'a str, NativeError> {
    value
        .to_str()
        .ok_or_else(|| NativeError::usage(format!("{option}: value must be valid UTF-8")))
}

/// Entier décimal strict : chiffres seulement, pas de zéro de tête (hors
/// « 0 »), pas de signe, bornes incluses.
pub fn parse_integer(text: &str, option: &str, min: u64, max: u64) -> Result<u64, NativeError> {
    let well_formed = !text.is_empty()
        && text.len() <= 20
        && text.bytes().all(|b| b.is_ascii_digit())
        && (text == "0" || !text.starts_with('0'));
    let value = if well_formed {
        text.parse::<u64>().ok()
    } else {
        None
    };
    match value {
        Some(v) if (min..=max).contains(&v) => Ok(v),
        _ => Err(NativeError::usage(format!(
            "{option}: expected an integer in [{min}, {max}], got \"{text}\""
        ))),
    }
}

fn parse_pid(text: &str, option: &str) -> Result<u32, NativeError> {
    // PID 0 n'est jamais un process ciblable (Idle sous Windows, l'ordonnanceur
    // sous POSIX). La borne haute garantit la conversion sans perte.
    let value = parse_integer(text, option, 1, u64::from(u32::MAX))?;
    u32::try_from(value).map_err(|_| NativeError::usage(format!("{option}: PID out of range")))
}

fn parse_proc_info(rest: &[&OsStr]) -> Result<Command, NativeError> {
    let options = Options::parse(rest, &["--pids"], &[])?;
    let raw = utf8(options.require("--pids")?, "--pids")?;
    let mut pids: Vec<u32> = Vec::new();
    for part in raw.split(',') {
        let pid = parse_pid(part, "--pids")?;
        if !pids.contains(&pid) {
            pids.push(pid);
        }
        if pids.len() > MAX_PIDS {
            return Err(NativeError::usage(format!(
                "--pids: at most {MAX_PIDS} distinct PIDs per call"
            )));
        }
    }
    Ok(Command::ProcInfo { pids })
}

fn parse_tree_kill(rest: &[&OsStr]) -> Result<Command, NativeError> {
    let options = Options::parse(rest, &["--pid", "--root-started-ms"], &[])?;
    let pid = parse_pid(utf8(options.require("--pid")?, "--pid")?, "--pid")?;
    let root_started_ms = options
        .get("--root-started-ms")
        .map(|v| {
            utf8(v, "--root-started-ms")
                .and_then(|t| parse_integer(t, "--root-started-ms", 1, i64::MAX as u64))
        })
        .transpose()?;
    Ok(Command::TreeKill {
        pid,
        root_started_ms,
    })
}

fn parse_job_run(rest: &[&OsStr]) -> Result<Command, NativeError> {
    let Some(separator) = rest.iter().position(|w| *w == "--") else {
        return Err(NativeError::usage(
            "job run: \"--\" must separate the options from the command",
        ));
    };
    let (head, tail) = rest.split_at(separator);
    let argv: Vec<OsString> = tail[1..].iter().map(|w| w.to_os_string()).collect();
    if argv.first().is_none_or(|program| program.is_empty()) {
        return Err(NativeError::usage("job run: missing program after \"--\""));
    }
    let options = Options::parse(
        head,
        &["--grace-ms", "--timeout-ms", "--report-file"],
        &["--windows-verbatim-args"],
    )?;
    let grace_ms = parse_integer(
        utf8(options.require("--grace-ms")?, "--grace-ms")?,
        "--grace-ms",
        0,
        MAX_GRACE_MS,
    )?;
    let timeout_ms = options
        .get("--timeout-ms")
        .map(|v| {
            utf8(v, "--timeout-ms")
                .and_then(|t| parse_integer(t, "--timeout-ms", 1, MAX_TIMEOUT_MS))
        })
        .transpose()?;
    let report = options.require("--report-file")?;
    if report.is_empty() {
        return Err(NativeError::usage("--report-file: empty path"));
    }
    let verbatim_args = options.flag("--windows-verbatim-args");
    if verbatim_args && !cfg!(windows) {
        return Err(NativeError::usage(
            "--windows-verbatim-args only exists on Windows",
        ));
    }
    Ok(Command::JobRun(JobSpec {
        grace_ms,
        timeout_ms,
        report_file: PathBuf::from(report),
        verbatim_args,
        argv,
    }))
}

fn optional_integer(
    options: &Options<'_>,
    name: &str,
    min: u64,
    max: u64,
    default: u64,
) -> Result<u64, NativeError> {
    options
        .get(name)
        .map(|v| utf8(v, name).and_then(|t| parse_integer(t, name, min, max)))
        .transpose()
        .map(|v| v.unwrap_or(default))
}

fn optional_text(options: &Options<'_>, name: &str) -> Result<Option<String>, NativeError> {
    options
        .get(name)
        .map(|v| utf8(v, name).map(str::to_string))
        .transpose()
}

fn parse_pty_host(rest: &[&OsStr]) -> Result<Command, NativeError> {
    let Some(separator) = rest.iter().position(|w| *w == "--") else {
        return Err(NativeError::usage(
            "pty-host: \"--\" must separate the options from the program",
        ));
    };
    let (head, tail) = rest.split_at(separator);
    let argv: Vec<OsString> = tail[1..].iter().map(|w| w.to_os_string()).collect();
    if argv.first().is_none_or(|program| program.is_empty()) {
        return Err(NativeError::usage("pty-host: missing program after \"--\""));
    }
    let options = Options::parse(
        head,
        &[
            "--agent",
            "--state-dir",
            "--endpoint",
            "--cwd",
            "--cols",
            "--rows",
            "--initial",
            "--term",
            "--replay-bytes",
            "--client-queue-bytes",
            "--kill-grace-ms",
            "--parent-pid",
        ],
        &[],
    )?;
    let agent = utf8(options.require("--agent")?, "--agent")?.to_string();
    if !pty_host::is_valid_agent_name(&agent) {
        return Err(NativeError::usage("--agent: invalid agent name"));
    }
    let state_dir = PathBuf::from(options.require("--state-dir")?);
    if !state_dir.is_absolute() || state_dir.file_name() != Some(OsStr::new(&agent)) {
        return Err(NativeError::usage(
            "--state-dir: expected an absolute path ending with the agent name",
        ));
    }
    let endpoint = utf8(options.require("--endpoint")?, "--endpoint")?.to_string();
    pty_host::validate_endpoint(&agent, &state_dir, &endpoint)?;
    let cwd = PathBuf::from(options.require("--cwd")?);
    if !cwd.is_absolute() {
        return Err(NativeError::usage("--cwd: expected an absolute path"));
    }
    let max_dimension = pty_host::frames::MAX_DIMENSION;
    let cols = optional_integer(
        &options,
        "--cols",
        1,
        max_dimension,
        u64::from(pty_host::DEFAULT_COLS),
    )?;
    let rows = optional_integer(
        &options,
        "--rows",
        1,
        max_dimension,
        u64::from(pty_host::DEFAULT_ROWS),
    )?;
    let initial = optional_text(&options, "--initial")?;
    if initial
        .as_ref()
        .is_some_and(|t| t.len() > pty_host::MAX_INITIAL_BYTES)
    {
        return Err(NativeError::usage("--initial: text too long"));
    }
    let term = optional_text(&options, "--term")?;
    if term.as_ref().is_some_and(|t| {
        t.is_empty()
            || t.len() > 64
            || !t
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
    }) {
        return Err(NativeError::usage("--term: invalid terminal name"));
    }
    let replay_bytes = optional_integer(
        &options,
        "--replay-bytes",
        pty_host::MIN_REPLAY_BYTES,
        pty_host::MAX_REPLAY_BYTES,
        pty_host::DEFAULT_REPLAY_BYTES,
    )?;
    let client_queue_bytes = optional_integer(
        &options,
        "--client-queue-bytes",
        pty_host::MIN_CLIENT_QUEUE_BYTES,
        pty_host::MAX_CLIENT_QUEUE_BYTES,
        pty_host::DEFAULT_CLIENT_QUEUE_BYTES,
    )?;
    let queue_floor = pty_host::min_client_queue_bytes(replay_bytes);
    if client_queue_bytes < queue_floor {
        return Err(NativeError::usage(format!(
            "--client-queue-bytes: must be at least {queue_floor} for --replay-bytes {replay_bytes}              (the replay frame plus two output frames must fit in a client queue)"
        )));
    }
    let kill_grace_ms = optional_integer(
        &options,
        "--kill-grace-ms",
        0,
        pty_host::MAX_KILL_GRACE_MS,
        pty_host::DEFAULT_KILL_GRACE_MS,
    )?;
    let parent_pid = options
        .get("--parent-pid")
        .map(|v| utf8(v, "--parent-pid").and_then(|t| parse_pid(t, "--parent-pid")))
        .transpose()?;
    Ok(Command::PtyHost(PtyHostSpec {
        agent,
        state_dir,
        endpoint,
        cwd,
        // Bornes vérifiées ci-dessus (≤ MAX_DIMENSION) : conversion sans perte.
        cols: cols as u16,
        rows: rows as u16,
        initial,
        term,
        replay_bytes,
        client_queue_bytes,
        kill_grace_ms,
        parent_pid,
        argv,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    fn usage_error(list: &[&str]) -> String {
        match parse(&args(list)) {
            Err(e) => {
                assert_eq!(e.code, "USAGE");
                assert_eq!(e.exit_code, exit::USAGE);
                e.message
            }
            Ok(c) => panic!("expected a usage error, got {c:?}"),
        }
    }

    #[test]
    fn commandes_de_base() {
        assert_eq!(parse(&args(&["--help"])), Ok(Command::Help));
        assert_eq!(parse(&args(&["version"])), Ok(Command::Version));
        assert!(usage_error(&[]).contains("missing command"));
        assert!(usage_error(&["frobnicate"]).contains("unknown command"));
        assert!(usage_error(&["proc"]).contains("unknown command"));
    }

    #[test]
    fn proc_info_dedoublonne_et_borne() {
        assert_eq!(
            parse(&args(&["proc", "info", "--pids", "3,1,3"])),
            Ok(Command::ProcInfo { pids: vec![3, 1] })
        );
        for bad in [
            "",
            "0",
            "-1",
            "1,,2",
            "07",
            "1.5",
            "4294967296",
            "1e3",
            " 1",
        ] {
            usage_error(&["proc", "info", "--pids", bad]);
        }
        let many = (1..=MAX_PIDS as u32 + 1)
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(",");
        assert!(usage_error(&["proc", "info", "--pids", &many]).contains("at most"));
        assert!(usage_error(&["proc", "info"]).contains("missing required"));
        assert!(usage_error(&["proc", "info", "--pids"]).contains("needs a value"));
        assert!(usage_error(&["proc", "info", "--pids", "1", "--pids", "2"]).contains("twice"));
        assert!(usage_error(&["proc", "info", "--pid", "1"]).contains("unknown option"));
    }

    #[test]
    fn tree_kill() {
        assert_eq!(
            parse(&args(&["proc", "tree-kill", "--pid", "42"])),
            Ok(Command::TreeKill {
                pid: 42,
                root_started_ms: None
            })
        );
        assert_eq!(
            parse(&args(&[
                "proc",
                "tree-kill",
                "--root-started-ms",
                "1700000000000",
                "--pid",
                "42"
            ])),
            Ok(Command::TreeKill {
                pid: 42,
                root_started_ms: Some(1_700_000_000_000)
            })
        );
        usage_error(&["proc", "tree-kill", "--pid", "0"]);
        usage_error(&["proc", "tree-kill", "--pid", "42", "--root-started-ms", "0"]);
    }

    #[test]
    fn job_run() {
        let parsed = parse(&args(&[
            "job",
            "run",
            "--grace-ms",
            "500",
            "--report-file",
            "r.json",
            "--",
            "node",
            "--grace-ms",
            "--",
        ]));
        assert_eq!(
            parsed,
            Ok(Command::JobRun(JobSpec {
                grace_ms: 500,
                timeout_ms: None,
                report_file: PathBuf::from("r.json"),
                verbatim_args: false,
                // Tout ce qui suit « -- » appartient à la commande, options
                // homonymes et « -- » compris.
                argv: args(&["node", "--grace-ms", "--"]),
            }))
        );
        assert!(
            usage_error(&["job", "run", "--grace-ms", "1", "--report-file", "r"])
                .contains("\"--\"")
        );
        assert!(
            usage_error(&["job", "run", "--grace-ms", "1", "--report-file", "r", "--"])
                .contains("missing program")
        );
        assert!(
            usage_error(&["job", "run", "--report-file", "r", "--", "x"]).contains("--grace-ms")
        );
        usage_error(&[
            "job",
            "run",
            "--grace-ms",
            "600001",
            "--report-file",
            "r",
            "--",
            "x",
        ]);
        usage_error(&[
            "job",
            "run",
            "--grace-ms",
            "1",
            "--timeout-ms",
            "0",
            "--report-file",
            "r",
            "--",
            "x",
        ]);
        usage_error(&[
            "job",
            "run",
            "--grace-ms",
            "1",
            "--report-file",
            "",
            "--",
            "x",
        ]);
        let verbatim = parse(&args(&[
            "job",
            "run",
            "--grace-ms",
            "1",
            "--report-file",
            "r",
            "--windows-verbatim-args",
            "--",
            "cmd.exe",
        ]));
        if cfg!(windows) {
            assert!(matches!(
                verbatim,
                Ok(Command::JobRun(JobSpec {
                    verbatim_args: true,
                    ..
                }))
            ));
        } else {
            assert!(verbatim.is_err());
        }
    }

    fn state_dir() -> (String, String, String) {
        if cfg!(windows) {
            (
                r"C:\r\.striart\pty\agent-a".to_string(),
                r"\\.\pipe\striart-0123456789ab-agent-a".to_string(),
                r"C:\r".to_string(),
            )
        } else {
            (
                "/r/.striart/pty/agent-a".to_string(),
                "/r/.striart/pty/agent-a/attach.sock".to_string(),
                "/r".to_string(),
            )
        }
    }

    fn pty_args(extra: &[&str], tail: Option<&[&str]>) -> Vec<OsString> {
        let (dir, endpoint, cwd) = state_dir();
        let mut all: Vec<String> = [
            "pty-host",
            "--agent",
            "agent-a",
            "--state-dir",
            dir.as_str(),
            "--endpoint",
            endpoint.as_str(),
            "--cwd",
            cwd.as_str(),
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        all.extend(extra.iter().map(|s| s.to_string()));
        if let Some(tail) = tail {
            all.push("--".into());
            all.extend(tail.iter().map(|s| s.to_string()));
        }
        all.into_iter().map(OsString::from).collect()
    }

    fn usage_error_args(list: Vec<OsString>) -> String {
        match parse(&list) {
            Err(e) => {
                assert_eq!(e.code, "USAGE");
                e.message
            }
            Ok(c) => panic!("expected a usage error, got {c:?}"),
        }
    }

    #[test]
    fn pty_host() {
        match parse(&pty_args(
            &["--cols", "120", "--initial", "claude"],
            Some(&["sh", "-l"]),
        )) {
            Ok(Command::PtyHost(spec)) => {
                assert_eq!(spec.agent, "agent-a");
                assert_eq!((spec.cols, spec.rows), (120, pty_host::DEFAULT_ROWS));
                assert_eq!(spec.initial.as_deref(), Some("claude"));
                assert_eq!(spec.replay_bytes, pty_host::DEFAULT_REPLAY_BYTES);
                assert_eq!(
                    spec.client_queue_bytes,
                    pty_host::DEFAULT_CLIENT_QUEUE_BYTES
                );
                assert_eq!(spec.kill_grace_ms, pty_host::DEFAULT_KILL_GRACE_MS);
                assert_eq!(spec.parent_pid, None);
                assert_eq!(spec.argv, args(&["sh", "-l"]));
            }
            other => panic!("{other:?}"),
        }
        assert!(usage_error_args(pty_args(&[], None)).contains("\"--\""));
        assert!(usage_error_args(pty_args(&[], Some(&[]))).contains("missing program"));
        for extra in [
            ["--cols", "0"],
            ["--rows", "1001"],
            ["--replay-bytes", "10"],
            ["--client-queue-bytes", "1"],
            ["--kill-grace-ms", "60001"],
            ["--term", "x;rm"],
            ["--parent-pid", "0"],
            ["--unknown", "1"],
        ] {
            usage_error_args(pty_args(&extra, Some(&["sh"])));
        }
        // Un rejeu que la file par défaut ne peut pas accueillir est refusé
        // franchement (sinon : éviction en boucle de chaque client).
        assert!(
            usage_error_args(pty_args(&["--replay-bytes", "16777216"], Some(&["sh"])))
                .contains("--client-queue-bytes")
        );
        let too_long = "x".repeat(pty_host::MAX_INITIAL_BYTES + 1);
        assert!(
            usage_error_args(pty_args(&["--initial", &too_long], Some(&["sh"])))
                .contains("--initial")
        );
        // Agent, dossier d'état et canal doivent concorder.
        let mut wrong_agent = pty_args(&[], Some(&["sh"]));
        wrong_agent[2] = "../x".into();
        usage_error_args(wrong_agent);
        let mut other_dir = pty_args(&[], Some(&["sh"]));
        other_dir[4] = if cfg!(windows) {
            r"C:\r\.striart\pty\agent-b".into()
        } else {
            "/r/.striart/pty/agent-b".into()
        };
        usage_error_args(other_dir);
        let mut other_endpoint = pty_args(&[], Some(&["sh"]));
        other_endpoint[6] = if cfg!(windows) {
            r"\\.\pipe\other-agent-a".into()
        } else {
            "/tmp/attach.sock".into()
        };
        usage_error_args(other_endpoint);
        let mut relative_cwd = pty_args(&[], Some(&["sh"]));
        relative_cwd[8] = "r".into();
        usage_error_args(relative_cwd);
    }

    #[test]
    fn entiers_stricts() {
        assert_eq!(parse_integer("0", "x", 0, 10), Ok(0));
        assert_eq!(parse_integer("10", "x", 0, 10), Ok(10));
        assert!(parse_integer("11", "x", 0, 10).is_err());
        assert!(parse_integer("+1", "x", 0, 10).is_err());
        assert!(parse_integer("99999999999999999999999", "x", 0, u64::MAX).is_err());
    }
}
