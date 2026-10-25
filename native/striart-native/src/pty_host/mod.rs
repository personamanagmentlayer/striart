//! `pty-host` : hôte d'un pseudo-terminal d'agent, derrière le protocole
//! d'attache ndjson de `src/pty-attach.ts` (remplace l'hôte Node/node-pty).
//!
//! Cycle de vie :
//! 1. dossier d'état de l'agent (`0700` sous POSIX), verrou exclusif
//!    `host.lock` — un second hôte pour le même agent sort en 3 ;
//! 2. canal d'attache (named pipe à DACL restreinte / socket `0600`) ;
//! 3. programme lancé dans le pty (Job Object / session POSIX), commande
//!    initiale écrite ;
//! 4. PID file atomique : l'hôte est prêt ;
//! 5. service des clients jusqu'à la fin du programme, une demande d'arrêt
//!    (`host.stop`, accusée), un signal (POSIX), ou la mort du process
//!    parent désigné (`--parent-pid`, hôte « possédé ») ;
//! 6. fin propre : pty fermé et descendance tuée après le délai de grâce,
//!    frame `exit` à tous les clients, fichiers d'état retirés, sortie 0.
//!
//! Aucun thread n'existe avant l'étape 3 (contrat de `ipc::bind` POSIX et
//! du `fork`).

pub mod files;
pub mod frames;
pub mod hub;
pub mod replay;

use crate::protocol::{NativeError, emit_error, exit};
use crate::sys::ipc;
use crate::sys::pty::{ExitStatus, Pty, PtySpec, resolve_program};
use files::{LockOutcome, StatePaths};
use frames::{ClientFrame, MAX_CLIENT_LINE_BYTES};
use hub::Hub;
use std::ffi::OsString;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

/// Sortie : un autre hôte vivant tient déjà cet agent.
pub const EXIT_ALREADY_RUNNING: i32 = 3;

pub const DEFAULT_COLS: u16 = 80;
pub const DEFAULT_ROWS: u16 = 24;
pub const DEFAULT_REPLAY_BYTES: u64 = 65_536;
pub const MIN_REPLAY_BYTES: u64 = 1_024;
pub const MAX_REPLAY_BYTES: u64 = 16 * 1024 * 1024;
pub const DEFAULT_CLIENT_QUEUE_BYTES: u64 = 4 * 1024 * 1024;
/// Plancher de la file par client : au moins deux frames de sortie (voir
/// `OUTPUT_CHUNK_BYTES` et `min_client_queue_bytes`), sinon une seule frame
/// suffirait à évincer un client dont la file est vide.
pub const MIN_CLIENT_QUEUE_BYTES: u64 = 32 * 1024;
pub const MAX_CLIENT_QUEUE_BYTES: u64 = 256 * 1024 * 1024;
pub const DEFAULT_KILL_GRACE_MS: u64 = 1_000;
pub const MAX_KILL_GRACE_MS: u64 = 60_000;
/// Plus longue commande initiale acceptée. Sous Windows elle voyage dans la
/// ligne de commande de l'hôte (32 767 caractères au total, chemins et
/// options compris) : 16 Kio laissent la marge ; ailleurs, la limite d'argv
/// est de l'ordre du Mio.
#[cfg(windows)]
pub const MAX_INITIAL_BYTES: usize = 16 * 1024;
#[cfg(not(windows))]
pub const MAX_INITIAL_BYTES: usize = 64 * 1024;
/// Taille maximale d'un morceau de sortie lu puis diffusé en une frame
/// (base64 : ~4/3). Borné pour qu'une frame reste très inférieure à la file
/// minimale d'un client.
pub const OUTPUT_CHUNK_BYTES: usize = 8 * 1024;
/// Marge d'une frame `data` au-delà de son contenu base64 (JSON, newline).
const FRAME_OVERHEAD_BYTES: u64 = 64;

/// Taille maximale d'une frame `data` sur le fil.
pub const fn max_data_frame_bytes() -> u64 {
    // +3 : suffixe UTF-8 incomplet reporté d'un tour.
    ((OUTPUT_CHUNK_BYTES as u64 + 3).div_ceil(3)) * 4 + FRAME_OVERHEAD_BYTES
}

/// File minimale d'un client pour un rejeu de `replay_bytes` : le rejeu part
/// en UNE frame à l'attache (sans limite) puis la file doit encore accueillir
/// au moins deux frames de sortie, sinon le client serait évincé dès la
/// première sortie, en boucle de reconnexion.
pub const fn min_client_queue_bytes(replay_bytes: u64) -> u64 {
    replay_bytes.div_ceil(3) * 4 + FRAME_OVERHEAD_BYTES + 2 * max_data_frame_bytes()
}

/// Pas de la boucle principale.
const TICK: Duration = Duration::from_millis(25);
/// Lecture de `host.stop` (le demandeur attend l'accusé 3 s au plus).
const STOP_POLL: Duration = Duration::from_millis(100);
/// Contrôle du process parent d'un hôte possédé.
const PARENT_POLL: Duration = Duration::from_millis(250);
/// Vidange de la sortie après fermeture du pty.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(3);
/// Programme sorti : délai laissé à sa sortie résiduelle avant de fermer.
const EXIT_SETTLE: Duration = Duration::from_millis(150);
/// Envoi des dernières frames aux clients.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);
/// Attente maximale de la fin d'un thread auxiliaire à l'arrêt : l'hôte ne se
/// laisse jamais suspendre par un thread bloqué dans un appel système (un
/// `ClosePseudoConsole` ou un `read` qui ne revient pas).
const JOIN_TIMEOUT: Duration = Duration::from_secs(5);
/// Purge des zombies reparentés sous l'hôte (Linux subreaper).
const REAP_POLL: Duration = Duration::from_secs(2);

/// `join` borné : rend la main au plus tard après `timeout`. Un thread qui ne
/// finit pas est abandonné (journalisé) ; la sortie du process l'emporte.
fn join_bounded(handle: std::thread::JoinHandle<()>, timeout: Duration, name: &str) {
    let deadline = Instant::now() + timeout;
    while !handle.is_finished() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    if handle.is_finished() {
        let _ = handle.join();
    } else {
        log_event(
            "thread-join-timeout",
            vec![("thread", crate::json::Json::Str(name.into()))],
        );
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyHostSpec {
    pub agent: String,
    pub state_dir: PathBuf,
    pub endpoint: String,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub initial: Option<String>,
    pub term: Option<String>,
    pub replay_bytes: u64,
    pub client_queue_bytes: u64,
    pub kill_grace_ms: u64,
    pub parent_pid: Option<u32>,
    pub argv: Vec<OsString>,
}

/// Longueur maximale (NUL final compris) d'un chemin de socket Unix.
#[cfg(target_os = "macos")]
pub const MAX_SOCKET_PATH_BYTES: usize = 104;
#[cfg(not(target_os = "macos"))]
pub const MAX_SOCKET_PATH_BYTES: usize = 108;

/// Nom d'agent : même règle que `AGENT_NAME_RE` (src/agent-name.js).
pub fn is_valid_agent_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

/// Le canal désigné doit être celui de l'agent : named pipe `striart-…`
/// (nom dérivé par src/pty-attach.ts), ou socket `attach.sock` DANS le
/// dossier d'état de l'agent.
pub fn validate_endpoint(
    spec_agent: &str,
    state_dir: &std::path::Path,
    endpoint: &str,
) -> Result<(), NativeError> {
    if cfg!(windows) {
        let name = endpoint.strip_prefix(r"\\.\pipe\striart-").ok_or_else(|| {
            NativeError::usage("--endpoint: expected \\\\.\\pipe\\striart-<hash>-<agent>")
        })?;
        let well_formed = name.ends_with(&format!("-{spec_agent}"))
            && name.len() <= 200
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if !well_formed {
            return Err(NativeError::usage(
                "--endpoint: malformed pipe name for this agent",
            ));
        }
        return Ok(());
    }
    let path = std::path::Path::new(endpoint);
    // `sockaddr_un.sun_path` : 108 octets (Linux) / 104 (macOS), NUL final
    // compris. Au-delà, `bind` échouerait avec une erreur opaque (ou tronquerait
    // le chemin) : refus net et actionnable.
    if endpoint.len() >= MAX_SOCKET_PATH_BYTES {
        return Err(NativeError::failure(
            "PTY_ENDPOINT_TOO_LONG",
            format!(
                "the attach socket path is {} bytes, the OS limit is {} : use a shorter project path",
                endpoint.len(),
                MAX_SOCKET_PATH_BYTES - 1
            ),
        ));
    }
    if path.parent() != Some(state_dir)
        || path.file_name() != Some(std::ffi::OsStr::new("attach.sock"))
    {
        return Err(NativeError::usage(
            "--endpoint: must be attach.sock inside --state-dir",
        ));
    }
    Ok(())
}

fn log_event(event: &str, fields: Vec<(&'static str, crate::json::Json)>) {
    use crate::json::Json;
    use std::io::Write;
    let mut all = vec![
        ("event", Json::Str(event.into())),
        ("time", Json::Str(files::iso8601(SystemTime::now()))),
    ];
    all.extend(fields);
    let mut stderr = std::io::stderr().lock();
    let _ = writeln!(stderr, "{}", Json::Obj(all).to_line());
}

/// Raison de fin de session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ending {
    ProgramExited(ExitStatus),
    StopRequested,
    ParentGone,
    #[cfg(unix)]
    Signal(i32),
}

pub fn run(spec: &PtyHostSpec) -> Result<i32, NativeError> {
    // 1. État et verrou.
    std::fs::create_dir_all(&spec.state_dir)
        .map_err(|e| NativeError::failure("PTY_STATE_FAILED", format!("state directory: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&spec.state_dir, std::fs::Permissions::from_mode(0o700)).map_err(
            |e| NativeError::failure("PTY_STATE_FAILED", format!("state directory: {e}")),
        )?;
    }
    let _lock = match files::acquire_lock(&spec.state_dir)? {
        LockOutcome::Acquired(lock) => lock,
        LockOutcome::Held => {
            emit_error(&NativeError::failure(
                "PTY_HOST_ALREADY_RUNNING",
                "another pty host is already running for this agent",
            ));
            return Ok(EXIT_ALREADY_RUNNING);
        }
    };
    let paths = StatePaths::new(&spec.state_dir);
    let own_pid = std::process::id();
    // Reliquats d'un hôte mort (le verrou garantit qu'aucun vivant n'existe).
    let _ = std::fs::remove_file(&paths.pid);
    files::remove_if_owned(&paths.stop, own_pid);

    // 2. Programme résolu AVANT d'ouvrir quoi que ce soit (échec net).
    let program = resolve_program(
        &spec.argv[0],
        &spec.cwd,
        std::env::var_os("PATH").as_deref(),
    )
    .ok_or_else(|| {
        NativeError::failure(
            "PTY_PROGRAM_NOT_FOUND",
            format!(
                "program not found in PATH: {}",
                spec.argv[0].to_string_lossy()
            ),
        )
    })?;
    if !spec.cwd.is_dir() {
        return Err(NativeError::failure(
            "PTY_CWD_INVALID",
            "--cwd is not a directory",
        ));
    }

    // 3. Canal d'attache (aucun thread encore : umask POSIX sûr).
    let listener = ipc::bind(&spec.endpoint).map_err(|e| {
        NativeError::failure(
            "PTY_ATTACH_LISTEN_FAILED",
            format!("cannot open the attach endpoint: {e}"),
        )
    })?;

    #[cfg(unix)]
    crate::sys::unix::watch_interruptions()?;

    // 4. Programme dans le pty. Linux : l'hôte devient subreaper (les
    // descendants dont le parent meurt lui sont reparentés au lieu d'init :
    // leurs zombies sont collectés et leur ppid reste lisible). Pas de thread
    // encore : le fork du pty reste sûr.
    #[cfg(target_os = "linux")]
    crate::sys::become_subreaper()?;
    let pty = Arc::new(Pty::spawn(&PtySpec {
        program: &program,
        args: &spec.argv[1..],
        cwd: &spec.cwd,
        cols: spec.cols,
        rows: spec.rows,
        term: spec.term.as_deref(),
        // L'hôte n'a qu'un enfant : le programme du pty.
        adopt_orphans: true,
    })?);
    let hub = Arc::new(Hub::new(
        &spec.agent,
        spec.cols,
        spec.rows,
        usize::try_from(spec.replay_bytes).unwrap_or(usize::MAX),
        usize::try_from(spec.client_queue_bytes).unwrap_or(usize::MAX),
    ));
    let output_ended = Arc::new(AtomicBool::new(false));
    let reader = pty
        .take_reader()
        .ok_or_else(|| NativeError::failure("PTY_SPAWN_FAILED", "pty output unavailable"))?;
    let reader_thread = {
        let hub = Arc::clone(&hub);
        let ended = Arc::clone(&output_ended);
        std::thread::Builder::new()
            .name("pty-output".into())
            .spawn(move || pump_output(reader, &hub, &ended))
            .map_err(|e| NativeError::failure("PTY_SPAWN_FAILED", format!("thread: {e}")))?
    };
    if let Some(initial) = &spec.initial {
        let mut line = initial.clone().into_bytes();
        line.push(b'\r');
        if let Err(e) = pty.write_input(&line) {
            log_event(
                "initial-command-failed",
                vec![("error", crate::json::Json::Str(e.to_string()))],
            );
        }
    }

    let listener = Arc::new(listener);
    {
        let listener = Arc::clone(&listener);
        let hub = Arc::clone(&hub);
        let pty = Arc::clone(&pty);
        std::thread::Builder::new()
            .name("accept".into())
            .spawn(move || accept_loop(&listener, &hub, &pty))
            .map_err(|e| NativeError::failure("PTY_SPAWN_FAILED", format!("thread: {e}")))?;
    }

    // 5. Prêt : PID file atomique.
    let program_name = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "striart-native".into());
    let pid_doc = files::pid_document(
        own_pid,
        &files::iso8601(SystemTime::now()),
        &program_name,
        pty.pid(),
    );
    if let Err(e) = files::write_atomic(&paths.pid, format!("{}\n", pid_doc.to_line()).as_bytes()) {
        pty.close();
        let _ = pty.terminate();
        return Err(NativeError::failure(
            "PTY_STATE_FAILED",
            format!("host.pid: {e}"),
        ));
    }
    log_event(
        "listening",
        vec![
            ("agent", crate::json::Json::Str(spec.agent.clone())),
            ("pid", crate::json::Json::UInt(u64::from(own_pid))),
            ("childPid", crate::json::Json::UInt(u64::from(pty.pid()))),
        ],
    );

    let parent_start = spec
        .parent_pid
        .and_then(|pid| crate::sys::infos(&[pid]).ok()?.first()?.start_ms);
    let ending = wait_for_end(spec, &paths, &pty, &hub, own_pid, parent_start);

    // 6. Fin propre.
    let stop_started = Instant::now();
    let (code, signal) = match ending {
        Ending::ProgramExited(status) => {
            // Sortie résiduelle du programme (et des descendants qui
            // l'écrivent encore) avant de fermer le pty.
            let settle = Instant::now() + EXIT_SETTLE;
            while !output_ended.load(Ordering::SeqCst) && Instant::now() < settle {
                std::thread::sleep(TICK);
            }
            (status.code, status.signal)
        }
        _ => (None, None),
    };
    let descendants_gone = close_pty(&pty, &output_ended, spec.kill_grace_ms);
    if !descendants_gone {
        // Rien de plus à tenter ici : l'événement journalisé est le signal
        // (fail closed côté appelant, qui relit le journal de l'hôte).
        log_event("descendants-survived", Vec::new());
    }
    join_bounded(reader_thread, JOIN_TIMEOUT, "pty-output");
    hub.finish(code, signal);
    let flush_deadline = Instant::now() + FLUSH_TIMEOUT;
    while hub.connected() > 0 && Instant::now() < flush_deadline {
        std::thread::sleep(TICK);
    }
    hub.close_all();
    listener.shutdown();
    files::remove_if_owned(&paths.pid, own_pid);
    files::remove_if_owned(&paths.stop, own_pid);
    log_event(
        "stopped",
        vec![
            ("reason", crate::json::Json::Str(format!("{ending:?}"))),
            (
                "stopMs",
                crate::json::Json::UInt(stop_started.elapsed().as_millis() as u64),
            ),
        ],
    );
    #[cfg(unix)]
    if let Ending::Signal(signal) = ending {
        return Ok(exit::SIGNAL_BASE + signal);
    }
    Ok(exit::OK)
}

fn wait_for_end(
    spec: &PtyHostSpec,
    paths: &StatePaths,
    pty: &Pty,
    hub: &Hub,
    own_pid: u32,
    parent_start: Option<u64>,
) -> Ending {
    let mut next_stop_check = Instant::now();
    let mut next_parent_check = Instant::now() + PARENT_POLL;
    let mut next_reap = Instant::now() + REAP_POLL;
    loop {
        if let Ok(Some(status)) = pty.try_wait() {
            return Ending::ProgramExited(status);
        }
        #[cfg(unix)]
        if let Some(signal) = crate::sys::unix::interruption() {
            return Ending::Signal(signal);
        }
        let now = Instant::now();
        if now >= next_stop_check {
            next_stop_check = now + STOP_POLL;
            if files::acknowledge_stop(&paths.stop, own_pid) {
                return Ending::StopRequested;
            }
        }
        if let Some(parent) = spec.parent_pid
            && now >= next_parent_check
        {
            next_parent_check = now + PARENT_POLL;
            if !parent_alive(parent, parent_start) {
                return Ending::ParentGone;
            }
        }
        if now >= next_reap {
            next_reap = now + REAP_POLL;
            pty.reap_orphans();
        }
        hub.sweep();
        std::thread::sleep(TICK);
    }
}

/// Le parent désigné vit-il encore (même process : même heure de création) ?
fn parent_alive(pid: u32, start_ms: Option<u64>) -> bool {
    match crate::sys::infos(&[pid]) {
        Ok(list) => list
            .first()
            .is_some_and(|info| match (start_ms, info.start_ms) {
                (Some(expected), Some(actual)) => crate::sys::same_start_time(expected, actual),
                _ => true,
            }),
        // Lecture impossible : on ne s'arrête pas sur un doute.
        Err(_) => true,
    }
}

/// Ferme le pty pendant que la sortie est encore drainée par son thread,
/// laisse `grace_ms` à la descendance pour sortir, puis tue ce qui reste.
/// Rend `true` si plus aucun process de la descendance ne vit.
fn close_pty(pty: &Arc<Pty>, output_ended: &AtomicBool, grace_ms: u64) -> bool {
    // ClosePseudoConsole peut attendre la vidange de la sortie : appelée
    // depuis un thread à part, la boucle d'attente ci-dessous reste maîtresse
    // des délais.
    let closer = {
        let pty = Arc::clone(pty);
        std::thread::spawn(move || pty.close())
    };
    let grace = Instant::now() + Duration::from_millis(grace_ms);
    while pty.tree_alive() && Instant::now() < grace {
        std::thread::sleep(Duration::from_millis(10));
    }
    // `terminate` est toujours appelé : sous Linux il balaie aussi les
    // orphelins sortis du groupe (reparentés sous l'hôte), que `tree_alive`
    // (le groupe) ne voit pas.
    let gone = pty.terminate();
    let drain = Instant::now() + DRAIN_TIMEOUT;
    while !output_ended.load(Ordering::SeqCst) && Instant::now() < drain {
        std::thread::sleep(Duration::from_millis(10));
    }
    join_bounded(closer, JOIN_TIMEOUT, "pty-closer");
    gone
}

fn pump_output(mut reader: std::fs::File, hub: &Hub, ended: &AtomicBool) {
    let mut buffer = vec![0u8; OUTPUT_CHUNK_BYTES];
    let mut carry: Vec<u8> = Vec::new();
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                carry.extend_from_slice(&buffer[..n]);
                let keep = replay::incomplete_utf8_suffix_len(&carry);
                let ready = carry.len() - keep;
                log_evictions(&hub.output(&carry[..ready]), hub);
                carry.drain(..ready);
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            // EIO (POSIX, esclave fermé) ou pipe rompu (Windows) : fin.
            Err(_) => break,
        }
    }
    log_evictions(&hub.output(&carry), hub);
    ended.store(true, Ordering::SeqCst);
}

/// Éviction d'un client trop lent : événement journalisé (observabilité —
/// un panneau qui décroche en boucle se voit dans le journal de l'hôte).
fn log_evictions(clients: &[u64], hub: &Hub) {
    for client in clients {
        log_event(
            "client-evicted",
            vec![
                ("client", crate::json::Json::UInt(*client)),
                (
                    "queueLimit",
                    crate::json::Json::UInt(hub.queue_limit() as u64),
                ),
            ],
        );
    }
}

fn accept_loop(listener: &ipc::Listener, hub: &Arc<Hub>, pty: &Arc<Pty>) {
    loop {
        let conn = match listener.accept() {
            Ok(Some(conn)) => Arc::new(conn),
            Ok(None) => return,
            Err(e) => {
                log_event(
                    "accept-failed",
                    vec![("error", crate::json::Json::Str(e.to_string()))],
                );
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        let Some(client) = hub.attach(Arc::clone(&conn)) else {
            conn.shutdown();
            continue;
        };
        let writer = Arc::clone(&client);
        let spawned_writer = std::thread::Builder::new()
            .name(format!("client-{}-out", client.id))
            .spawn(move || writer.write_loop());
        let reader_client = Arc::clone(&client);
        let hub_for_reader = Arc::clone(hub);
        let pty_for_reader = Arc::clone(pty);
        let spawned_reader = std::thread::Builder::new()
            .name(format!("client-{}-in", client.id))
            .spawn(move || read_client(&reader_client, &hub_for_reader, &pty_for_reader));
        if spawned_writer.is_err() || spawned_reader.is_err() {
            client.closed();
        }
    }
}

fn read_client(client: &hub::Client, hub: &Hub, pty: &Pty) {
    let mut pending: Vec<u8> = Vec::new();
    let mut buffer = vec![0u8; 16 * 1024];
    'outer: loop {
        let n = match client.conn.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.extend_from_slice(&buffer[..n]);
        while let Some(end) = pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            // Une ligne qui n'est pas de l'UTF-8 valide est REJETÉE (jamais
            // « réparée » par U+FFFD : une frappe altérée en silence est
            // pire qu'une frappe perdue et journalisée).
            match std::str::from_utf8(&line[..line.len() - 1]) {
                Ok(text) => apply_frame(text.trim_end_matches('\r'), hub, pty),
                Err(_) => log_event(
                    "client-line-invalid-utf8",
                    vec![("client", crate::json::Json::UInt(client.id))],
                ),
            }
        }
        if pending.len() > MAX_CLIENT_LINE_BYTES {
            log_event(
                "client-line-too-long",
                vec![("client", crate::json::Json::UInt(client.id))],
            );
            break 'outer;
        }
    }
    client.closed();
}

fn apply_frame(line: &str, hub: &Hub, pty: &Pty) {
    if line.is_empty() {
        return;
    }
    match frames::parse_client_frame(line) {
        Ok(ClientFrame::Input(bytes)) => {
            let _ = pty.write_input(&bytes);
        }
        Ok(ClientFrame::Message(text)) => {
            let mut bytes = text.into_bytes();
            bytes.push(b'\r');
            let _ = pty.write_input(&bytes);
        }
        Ok(ClientFrame::Resize { cols, rows }) => {
            // Atomique vis-à-vis des autres redimensionnements : la taille du
            // pty et celle mémorisée par le hub ne peuvent pas diverger.
            hub.resize_with(cols, rows, || pty.resize(cols, rows).is_ok());
        }
        // Ligne malformée : ignorée, le pty partagé n'est jamais coupé pour
        // un client fautif.
        Err(_) => {}
    }
}
