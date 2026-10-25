//! Tests de bout en bout de `striart-native pty-host` : vrai pseudo-terminal,
//! vrai canal d'attache, vrais process. Le programme hébergé est l'exemple
//! `pty-fixture` (comportement déterministe, sans dépendre du shell de la
//! machine), sauf pour le test d'écho qui passe par le shell du système.

mod common;

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};
use striart_native::base64;
use striart_native::json::{self, Value};
use striart_native::sys::ipc::{self, Conn};

const WAIT: Duration = Duration::from_secs(30);

fn native() -> &'static str {
    env!("CARGO_BIN_EXE_striart-native")
}

fn fixture() -> PathBuf {
    let dir = Path::new(native()).parent().expect("target dir");
    let path = dir
        .join("examples")
        .join(format!("pty-fixture{}", std::env::consts::EXE_SUFFIX));
    assert!(path.exists(), "fixture missing: {}", path.display());
    path
}

struct Host {
    child: Child,
    dir: PathBuf,
    state: PathBuf,
    endpoint: String,
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn unique(tag: &str) -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    format!(
        "{}-{}-{tag}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    )
}

/// Racine des dossiers de test. Un socket Unix est limité à ~103 octets (macOS) :
/// `temp_dir()` y vaut `/var/folders/…/T` (≈ 50 octets) et fait déborder le chemin
/// du socket — d'où `/tmp`, court et présent sur tout Unix.
fn test_root() -> PathBuf {
    if cfg!(unix) {
        PathBuf::from("/tmp")
    } else {
        std::env::temp_dir()
    }
}

fn layout(tag: &str) -> (PathBuf, PathBuf, String) {
    let dir = test_root().join(format!("striart-pty-it-{}", unique(tag)));
    let state = dir.join(".striart").join("pty").join("agent-t");
    std::fs::create_dir_all(&dir).expect("temp dir");
    let endpoint = if cfg!(windows) {
        format!(r"\\.\pipe\striart-{}-agent-t", unique(tag).replace('-', ""))
    } else {
        state.join("attach.sock").to_string_lossy().into_owned()
    };
    (dir, state, endpoint)
}

fn spawn_host(tag: &str, extra: &[&str], program: &[&str]) -> Host {
    let (dir, state, endpoint) = layout(tag);
    spawn_host_at(dir, state, endpoint, extra, program)
}

fn spawn_host_at(
    dir: PathBuf,
    state: PathBuf,
    endpoint: String,
    extra: &[&str],
    program: &[&str],
) -> Host {
    let mut command = Command::new(native());
    command
        .args(["pty-host", "--agent", "agent-t", "--state-dir"])
        .arg(&state)
        .args(["--endpoint", &endpoint, "--cwd"])
        .arg(&dir)
        .args(extra)
        .arg("--")
        .args(program)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let child = command.spawn().expect("spawn pty-host");
    Host {
        child,
        dir,
        state,
        endpoint,
    }
}

fn fixture_program(args: &[&str]) -> Vec<String> {
    let mut all = vec![fixture().to_string_lossy().into_owned()];
    all.extend(args.iter().map(|s| s.to_string()));
    all
}

fn wait_ready(host: &mut Host) {
    let deadline = Instant::now() + WAIT;
    while !host.state.join("host.pid").exists() {
        if let Ok(Some(status)) = host.child.try_wait() {
            let mut stderr = String::new();
            use std::io::Read;
            let _ = host
                .child
                .stderr
                .take()
                .map(|mut e| e.read_to_string(&mut stderr));
            panic!("host exited early ({status}): {stderr}");
        }
        assert!(Instant::now() < deadline, "host never wrote host.pid");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Client de test : un thread lit les frames, le test écrit.
struct Client {
    conn: Arc<Conn>,
    frames: Receiver<Value>,
    output: String,
}

fn start_reader(conn: Arc<Conn>) -> Receiver<Value> {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let mut pending = Vec::new();
        let mut buf = vec![0u8; 65536];
        loop {
            let n = match conn.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            pending.extend_from_slice(&buf[..n]);
            while let Some(end) = pending.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = pending.drain(..=end).collect();
                let text =
                    String::from_utf8(line[..line.len() - 1].to_vec()).expect("frame is UTF-8");
                let value = json::parse(&text).expect("frame is JSON");
                if tx.send(value).is_err() {
                    return;
                }
            }
        }
    });
    rx
}

fn connect_raw(endpoint: &str) -> Arc<Conn> {
    let deadline = Instant::now() + WAIT;
    loop {
        match ipc::connect(endpoint) {
            Ok(conn) => return Arc::new(conn),
            Err(e) => {
                assert!(Instant::now() < deadline, "connect: {e}");
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

impl Client {
    fn connect(endpoint: &str) -> Self {
        let conn = connect_raw(endpoint);
        let frames = start_reader(Arc::clone(&conn));
        Self {
            conn,
            frames,
            output: String::new(),
        }
    }

    fn next(&mut self, within: Duration) -> Option<Value> {
        match self.frames.recv_timeout(within) {
            Ok(frame) => {
                if frame.get("type").and_then(Value::as_str) == Some("data") {
                    let chunk = frame.get("chunk").and_then(Value::as_str).expect("chunk");
                    let bytes = base64::decode(chunk).expect("base64");
                    self.output.push_str(
                        std::str::from_utf8(&bytes).expect("data frame is valid UTF-8 on its own"),
                    );
                }
                Some(frame)
            }
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => None,
        }
    }

    /// Lit jusqu'à une frame du type demandé.
    fn until_type(&mut self, kind: &str) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let frame = self
                .next(left)
                .unwrap_or_else(|| panic!("no {kind} frame; output so far: {:?}", self.output));
            if frame.get("type").and_then(Value::as_str) == Some(kind) {
                return frame;
            }
        }
    }

    fn until_output(&mut self, needle: &str) {
        let deadline = Instant::now() + WAIT;
        while !self.output.contains(needle) {
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(
                self.next(left).is_some(),
                "{needle:?} never arrived; output: {:?}",
                self.output
            );
        }
    }

    fn send(&self, frame: &str) {
        self.conn
            .write_all(format!("{frame}\n").as_bytes())
            .expect("send");
    }

    fn message(&self, text: &str) {
        self.send(
            &striart_native::json::Json::Obj(vec![
                ("type", striart_native::json::Json::Str("message".into())),
                ("text", striart_native::json::Json::Str(text.into())),
            ])
            .to_line(),
        );
    }
}

fn wait_exit(host: &mut Host, within: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + within;
    loop {
        if let Ok(Some(status)) = host.child.try_wait() {
            return Some(status);
        }
        if Instant::now() > deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn system_shell() -> Vec<String> {
    if cfg!(windows) {
        vec!["cmd.exe".into(), "/q".into()]
    } else {
        vec!["/bin/sh".into()]
    }
}

#[test]
fn hello_commande_initiale_et_message_atteignent_le_shell() {
    let shell = system_shell();
    let shell: Vec<&str> = shell.iter().map(String::as_str).collect();
    let mut host = spawn_host(
        "echo",
        &[
            "--cols",
            "100",
            "--rows",
            "30",
            "--initial",
            "echo MARK-INIT",
        ],
        &shell,
    );
    wait_ready(&mut host);
    let mut client = Client::connect(&host.endpoint);
    let hello = client.until_type("hello");
    assert_eq!(hello.get("agent").and_then(Value::as_str), Some("agent-t"));
    assert_eq!(hello.get("cols").and_then(Value::as_u64), Some(100));
    assert_eq!(hello.get("rows").and_then(Value::as_u64), Some(30));
    // Le pty traduit \n en \r\n en sortie (ONLCR, par défaut sous POSIX comme
    // sous ConPTY) : la fin de ligne vue par le client est \r\n partout.
    let eol = "\r\n";
    client.until_output(&format!("MARK-INIT{eol}"));
    client.message("echo MARK-MSG");
    client.until_output(&format!("MARK-MSG{eol}"));
}

#[test]
fn resize_diffuse_a_tous_les_clients() {
    let program = fixture_program(&["echo-lines"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut host = spawn_host("resize", &[], &program);
    wait_ready(&mut host);
    let mut a = Client::connect(&host.endpoint);
    a.until_type("hello");
    let mut b = Client::connect(&host.endpoint);
    b.until_type("hello");
    b.send(r#"{"type":"resize","cols":111,"rows":41}"#);
    let seen = a.until_type("resize");
    assert_eq!(seen.get("cols").and_then(Value::as_u64), Some(111));
    assert_eq!(seen.get("rows").and_then(Value::as_u64), Some(41));
    b.until_type("resize");
    // Un client arrivé ensuite reçoit la taille courante dans son hello.
    let mut c = Client::connect(&host.endpoint);
    let hello = c.until_type("hello");
    assert_eq!(hello.get("cols").and_then(Value::as_u64), Some(111));
    // Ligne malformée ou dimension invalide : ignorée, le pty continue.
    c.send("not json");
    c.send(r#"{"type":"resize","cols":0,"rows":41}"#);
    c.message("still-alive");
    c.until_output("ECHO:still-alive");
}

#[test]
fn pid_file_atomique_et_identite() {
    let program = fixture_program(&["echo-lines"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut host = spawn_host("pid", &[], &program);
    wait_ready(&mut host);
    let text = std::fs::read_to_string(host.state.join("host.pid")).expect("pid file");
    let doc = json::parse(text.trim()).expect("pid file is JSON");
    assert_eq!(
        doc.get("pid").and_then(Value::as_u64),
        Some(u64::from(host.child.id()))
    );
    assert_eq!(
        doc.get("implementation").and_then(Value::as_str),
        Some("native")
    );
    let program_name = doc.get("program").and_then(Value::as_str).expect("program");
    assert_eq!(
        program_name,
        Path::new(native()).file_name().unwrap().to_str().unwrap()
    );
    let started = doc
        .get("startedAt")
        .and_then(Value::as_str)
        .expect("startedAt");
    assert!(started.ends_with('Z') && started.len() == 24, "{started}");
    assert!(
        doc.get("childPid")
            .and_then(Value::as_u64)
            .is_some_and(|p| p > 0)
    );
    // Ligne de commande lue chez l'OS : `pty-host --agent agent-t`, que
    // ptyHostStatus (src/pty-host-state.ts) reconnaît.
    let info = striart_native::sys::infos(&[host.child.id()]).expect("proc info");
    let line = info[0].command_line.clone().expect("command line");
    assert!(line.contains("pty-host --agent agent-t"), "{line}");
    // Aucun fichier temporaire laissé à côté du PID file.
    let leftovers: Vec<_> = std::fs::read_dir(&host.state)
        .expect("state dir")
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty());
}

#[test]
fn un_seul_hote_par_agent() {
    let program = fixture_program(&["echo-lines"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut first = spawn_host("single", &[], &program);
    wait_ready(&mut first);
    let endpoint2 = if cfg!(windows) {
        format!("{}x-agent-t", first.endpoint.trim_end_matches("agent-t"))
    } else {
        first.endpoint.clone()
    };
    let second_dir = test_root().join(format!("striart-pty-it-{}", unique("single2")));
    std::fs::create_dir_all(&second_dir).expect("dir");
    let mut second = spawn_host_at(second_dir, first.state.clone(), endpoint2, &[], &program);
    let status = wait_exit(&mut second, WAIT).expect("second host must exit");
    assert_eq!(status.code(), Some(3));
    // Le premier sert toujours.
    let mut client = Client::connect(&first.endpoint);
    client.until_type("hello");
    // Le second ne touche pas à l'état du premier.
    assert!(first.state.join("host.pid").exists());
}

#[test]
fn arret_propre_par_host_stop_avec_accuse() {
    let program = fixture_program(&["echo-lines"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut host = spawn_host("stop", &[], &program);
    wait_ready(&mut host);
    let mut client = Client::connect(&host.endpoint);
    client.until_type("hello");
    client.until_output("ECHO-READY");
    let stop = host.state.join("host.stop");
    // Demande adressée à un AUTRE PID : ignorée.
    std::fs::write(
        &stop,
        format!(r#"{{"pid":{},"requestedAt":"x"}}"#, host.child.id() + 1),
    )
    .expect("write");
    std::thread::sleep(Duration::from_millis(400));
    assert!(host.child.try_wait().expect("try_wait").is_none());
    let asked = Instant::now();
    std::fs::write(
        &stop,
        format!(r#"{{"pid":{},"requestedAt":"x"}}"#, host.child.id()),
    )
    .expect("write");
    let exit = client.until_type("exit");
    assert_eq!(exit.get("exitCode"), Some(&Value::Null));
    let status = wait_exit(&mut host, Duration::from_secs(10)).expect("host must stop");
    let elapsed = asked.elapsed();
    assert_eq!(status.code(), Some(0));
    assert!(elapsed < Duration::from_secs(5), "stop took {elapsed:?}");
    assert!(!host.state.join("host.pid").exists(), "pid file removed");
    assert!(!stop.exists(), "stop file removed");
    if cfg!(unix) {
        assert!(!Path::new(&host.endpoint).exists(), "socket removed");
    }
}

#[test]
fn fin_naturelle_du_programme_rend_son_code() {
    // `exit-after-line` laisse au client le temps de se connecter : la frame
    // `exit` qu'il reçoit porte le code RÉEL du programme (7), pas seulement
    // « le processus hôte a fini ».
    let program = fixture_program(&["exit-after-line", "7"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut host = spawn_host("natural", &[], &program);
    wait_ready(&mut host);
    let mut client = Client::connect(&host.endpoint);
    client.until_output("READY");
    client.message("go");
    let exit = client.until_type("exit");
    assert_eq!(
        exit.get("exitCode").and_then(Value::as_u64),
        Some(7),
        "{exit:?}"
    );
    let status = wait_exit(&mut host, WAIT).expect("host must end with its program");
    assert_eq!(status.code(), Some(0));
    assert!(!host.state.join("host.pid").exists());
}

#[test]
fn fin_naturelle_vue_par_un_client() {
    let program = fixture_program(&["echo-lines"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut host = spawn_host("natural-client", &[], &program);
    wait_ready(&mut host);
    let mut client = Client::connect(&host.endpoint);
    client.until_output("ECHO-READY");
    // Fin d'entrée : Ctrl+D (POSIX) / Ctrl+Z puis Entrée (console Windows).
    let eof = if cfg!(windows) { "Gg==" } else { "BA==" };
    client.send(&format!(r#"{{"type":"input","data":"{eof}"}}"#));
    if cfg!(windows) {
        client.send(r#"{"type":"input","data":"DQ=="}"#);
    }
    let exit = client.until_type("exit");
    assert_eq!(exit.get("exitCode").and_then(Value::as_u64), Some(0));
    assert!(wait_exit(&mut host, Duration::from_secs(10)).is_some());
}

/// POSIX seulement : le pty y transmet les octets du programme tels quels.
/// Sous Windows, ConPTY re-rend la sortie depuis son tampon d'écran à un
/// débit qui dépend de la charge de la machine — la même logique
/// (éviction, frame explicite, rejeu borné et sûr) y est couverte sur le
/// vrai named pipe par tests/pty_hub.rs.
#[cfg(unix)]
#[test]
fn client_lent_evince_puis_rejeu_sans_coupure_de_sequence() {
    let program = fixture_program(&["flood-on-go", "4000000"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut host = spawn_host(
        "slow",
        // File de 256 Kio : le client lent (4 Mo de flot, il ne lit rien) est
        // évincé sans ambiguïté, alors que le pilote — qui lit sans cesse — ne
        // l'est que s'il a plus de 256 Kio de retard, ce qu'une machine
        // chargée (CI partagée) ne provoque pas.
        &["--replay-bytes", "4096", "--client-queue-bytes", "262144"],
        &program,
    );
    // Journal de l'hôte lu au fil de l'eau : l'éviction y est un événement.
    let log = Arc::new(std::sync::Mutex::new(String::new()));
    {
        let log = Arc::clone(&log);
        let stderr = host.child.stderr.take().expect("stderr");
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stderr)
                .lines()
                .map_while(Result::ok)
            {
                log.lock().unwrap().push_str(&format!(
                    "{line}
"
                ));
            }
        });
    }
    wait_ready(&mut host);
    // Client lent : il lit son hello, déclenche le flot, puis ne lit plus.
    let slow = connect_raw(&host.endpoint);
    let mut first = vec![0u8; 256];
    let n = slow.read(&mut first).expect("hello");
    assert!(n > 0);
    let mut driver = Client::connect(&host.endpoint);
    driver.until_output("READY-FOR-GO");
    driver.message("go");
    // Le driver lit tout ; on attend que l'hôte journalise l'éviction du
    // client lent (indépendant du débit de la machine).
    let deadline = Instant::now() + Duration::from_secs(90);
    while !log.lock().unwrap().contains("\"event\":\"client-evicted\"") {
        assert!(
            Instant::now() < deadline,
            "no eviction logged; driver got {} chars",
            driver.output.len()
        );
        let _ = driver.next(Duration::from_millis(100));
    }
    // Le client lent reprend sa lecture : frames déjà dans les tampons, puis
    // `evicted`, puis fermeture.
    let frames = start_reader(Arc::clone(&slow));
    let deadline = Instant::now() + WAIT;
    let mut evicted = false;
    loop {
        match frames.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(frame) => {
                if frame.get("type").and_then(Value::as_str) == Some("evicted") {
                    assert_eq!(
                        frame.get("reason").and_then(Value::as_str),
                        Some("slow-client")
                    );
                    evicted = true;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => panic!("slow client never closed"),
        }
    }
    assert!(
        evicted,
        "slow client must receive an explicit evicted frame"
    );
    // Reconnexion : hello + rejeu borné, qui commence à une frontière sûre.
    let mut again = Client::connect(&host.endpoint);
    again.until_type("hello");
    let replay = again.until_type("data");
    let bytes = base64::decode(replay.get("chunk").and_then(Value::as_str).unwrap()).unwrap();
    assert!(bytes.len() <= 4096, "replay bounded: {}", bytes.len());
    let text = std::str::from_utf8(&bytes).expect("replay is valid UTF-8");
    assert!(!text.contains('\u{fffd}'));
    // Le rejeu est un morceau du flux réel (vu en entier par le driver) ; en
    // CHAQUE endroit où il apparaît, le flux est à l'état « sol » juste avant :
    // aucune séquence CSI/OSC n'est coupée (machine à états, pas une liste de
    // premiers caractères tolérés).
    let places: Vec<usize> = driver.output.match_indices(text).map(|(i, _)| i).collect();
    assert!(!places.is_empty(), "replay must be part of the real stream");
    for start in places {
        assert!(
            common::is_ground_state_after(&driver.output[..start]),
            "replay starts inside a sequence: {:?}",
            &text[..text.len().min(32)]
        );
    }
    // Le driver, lui, n'a jamais été évincé.
    driver.message("still");
    assert!(host.child.try_wait().expect("try_wait").is_none());
}

#[test]
fn hote_possede_s_arrete_a_la_mort_du_parent() {
    let mut parent = Command::new(fixture())
        .arg("echo-lines")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .expect("parent stand-in");
    let program = fixture_program(&["echo-lines"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let parent_pid = parent.id().to_string();
    let mut host = spawn_host("parent", &["--parent-pid", &parent_pid], &program);
    wait_ready(&mut host);
    parent.kill().expect("kill parent");
    let _ = parent.wait();
    let status = wait_exit(&mut host, Duration::from_secs(10))
        .expect("owned host must stop with its parent");
    assert_eq!(status.code(), Some(0));
}

#[test]
fn programme_introuvable_echoue_explicitement() {
    let mut host = spawn_host("missing", &[], &["definitely-not-a-program-xyz"]);
    let status = wait_exit(&mut host, WAIT).expect("must fail");
    assert_eq!(status.code(), Some(1));
    let mut stderr = String::new();
    use std::io::Read;
    host.child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    let last = stderr.trim_end().lines().last().unwrap_or_default();
    assert!(
        last.contains("\"code\":\"PTY_PROGRAM_NOT_FOUND\""),
        "{stderr}"
    );
    assert!(!host.state.join("host.pid").exists());
}

#[cfg(windows)]
#[test]
fn dacl_du_named_pipe_limitee_a_l_utilisateur() {
    let program = fixture_program(&["echo-lines"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut host = spawn_host("dacl", &[], &program);
    wait_ready(&mut host);
    let conn = connect_raw(&host.endpoint);
    let sddl = conn.dacl_sddl().expect("read DACL");
    let sid = ipc::current_user_sid().expect("sid");
    // Un seul ACE, accès complet, pour l'utilisateur courant ; protégée.
    // Le formateur SDDL de Windows abrège le SID du compte administrateur
    // local (RID 500, ex. `runneradmin` en CI) en l'alias `LA` : même principal,
    // autre écriture — l'ACE reste unique et limité à l'utilisateur courant.
    let expected = format!("D:P(A;;FA;;;{sid})");
    let admin_alias = "D:P(A;;FA;;;LA)";
    assert!(
        sddl == expected || (sid.ends_with("-500") && sddl == admin_alias),
        "{sddl} (attendu {expected})"
    );
}

#[cfg(unix)]
#[test]
fn socket_unix_en_0600_et_dossier_en_0700() {
    use std::os::unix::fs::MetadataExt;
    let program = fixture_program(&["echo-lines"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut host = spawn_host("mode", &[], &program);
    wait_ready(&mut host);
    assert_eq!(ipc::endpoint_mode(&host.endpoint).expect("mode"), 0o600);
    assert_eq!(
        std::fs::metadata(&host.state).expect("dir").mode() & 0o777,
        0o700
    );
}

fn host_child_pid(host: &Host) -> u32 {
    let text = std::fs::read_to_string(host.state.join("host.pid")).expect("pid file");
    let doc = json::parse(text.trim()).expect("pid file is JSON");
    u32::try_from(
        doc.get("childPid")
            .and_then(Value::as_u64)
            .expect("childPid"),
    )
    .expect("u32")
}

fn gone(pid: u32) -> bool {
    striart_native::sys::snapshot()
        .map(|table| !table.iter().any(|e| e.pid == pid && !e.zombie))
        .unwrap_or(false)
}

fn wait_gone(pid: u32, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if gone(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    gone(pid)
}

/// PID annoncé par le fixture (`GRANDCHILD:<pid>` / `DETACHED:<pid>`).
fn announced_pid(client: &mut Client, label: &str) -> u32 {
    let needle = format!("{label}:");
    client.until_output("ECHO-READY");
    let at = client.output.find(&needle).expect("label in output") + needle.len();
    client.output[at..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .expect("pid")
}

/// N-I5 : l'hôte est tué BRUTALEMENT (aucun nettoyage possible). Le programme
/// du pty meurt avec lui — Windows : Job Object KILL_ON_JOB_CLOSE ; Linux :
/// PR_SET_PDEATHSIG ; partout : SIGHUP du noyau à la fermeture du maître sur
/// le groupe de premier plan, où se trouve aussi son petit-fils.
#[test]
fn kill_brutal_de_l_hote_emporte_le_programme_et_son_petit_fils() {
    let program = fixture_program(&["spawn-grandchild", "600000"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut host = spawn_host("brutal", &[], &program);
    wait_ready(&mut host);
    let mut client = Client::connect(&host.endpoint);
    let grandchild = announced_pid(&mut client, "GRANDCHILD");
    let child = host_child_pid(&host);
    assert!(
        !gone(child) && !gone(grandchild),
        "both must be alive first"
    );
    host.child.kill().expect("kill -9 the host");
    let _ = host.child.wait();
    assert!(
        wait_gone(child, Duration::from_secs(15)),
        "program {child} survived its host"
    );
    assert!(
        wait_gone(grandchild, Duration::from_secs(15)),
        "grandchild {grandchild} survived its host"
    );
}

/// `Ending::Signal` : SIGTERM sur l'hôte = sortie 128+15, programme tué.
#[cfg(unix)]
#[test]
fn sigterm_de_l_hote_sort_en_143_et_tue_le_programme() {
    let program = fixture_program(&["spawn-grandchild", "600000"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut host = spawn_host("sigterm", &[], &program);
    wait_ready(&mut host);
    let mut client = Client::connect(&host.endpoint);
    let grandchild = announced_pid(&mut client, "GRANDCHILD");
    let child = host_child_pid(&host);
    // SAFETY: signal envoyé à notre propre enfant.
    unsafe { libc::kill(host.child.id() as libc::pid_t, libc::SIGTERM) };
    let status = wait_exit(&mut host, Duration::from_secs(15)).expect("host must stop on SIGTERM");
    assert_eq!(status.code(), Some(128 + libc::SIGTERM));
    assert!(wait_gone(child, Duration::from_secs(5)));
    assert!(wait_gone(grandchild, Duration::from_secs(5)));
    assert!(!host.state.join("host.pid").exists(), "pid file removed");
}

/// Un descendant qui a QUITTÉ le groupe et la session du shell (`setsid`) est
/// tué à l'arrêt propre : l'hôte est subreaper (Linux) et balaie les orphelins.
#[cfg(target_os = "linux")]
#[test]
fn arret_propre_tue_un_descendant_sorti_du_groupe() {
    let program = fixture_program(&["spawn-detached", "600000"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut host = spawn_host("detached", &[], &program);
    wait_ready(&mut host);
    let mut client = Client::connect(&host.endpoint);
    let detached = announced_pid(&mut client, "DETACHED");
    assert!(!gone(detached));
    std::fs::write(
        host.state.join("host.stop"),
        format!(r#"{{"pid":{},"requestedAt":"x"}}"#, host.child.id()),
    )
    .expect("stop request");
    let status = wait_exit(&mut host, Duration::from_secs(20)).expect("host must stop");
    assert_eq!(status.code(), Some(0));
    assert!(
        wait_gone(detached, Duration::from_secs(5)),
        "setsid descendant {detached} survived the clean stop"
    );
}

/// `--kill-grace-ms` : un programme qui ignore SIGHUP n'est tué qu'APRÈS le
/// délai demandé, puis il l'est bel et bien.
#[cfg(unix)]
#[test]
fn kill_grace_laisse_le_delai_puis_tue_un_programme_qui_ignore_sighup() {
    let program = fixture_program(&["ignore-hup"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut host = spawn_host("grace", &["--kill-grace-ms", "1500"], &program);
    wait_ready(&mut host);
    let mut client = Client::connect(&host.endpoint);
    client.until_output("IGNORING-HUP");
    let child = host_child_pid(&host);
    let asked = Instant::now();
    std::fs::write(
        host.state.join("host.stop"),
        format!(r#"{{"pid":{},"requestedAt":"x"}}"#, host.child.id()),
    )
    .expect("stop request");
    let status = wait_exit(&mut host, Duration::from_secs(20)).expect("host must stop");
    let elapsed = asked.elapsed();
    assert_eq!(status.code(), Some(0));
    assert!(
        elapsed >= Duration::from_millis(1_400),
        "killed before the grace: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_secs(15),
        "grace not enforced: {elapsed:?}"
    );
    assert!(
        wait_gone(child, Duration::from_secs(5)),
        "program survived the grace"
    );
}

#[test]
fn chemin_de_socket_trop_long_refuse_nettement() {
    if cfg!(windows) {
        return; // named pipe : pas de limite sockaddr_un
    }
    // Racine de projet très profonde : `.striart/pty/<agent>/attach.sock` dépasse
    // la limite de `sockaddr_un`. La disposition du dossier d'état reste
    // valide (c'est le seul défaut du chemin).
    let (dir, _, _) = layout("long");
    let state = dir
        .join("x".repeat(200))
        .join(".striart")
        .join("pty")
        .join("agent-t");
    let endpoint = state.join("attach.sock").to_string_lossy().into_owned();
    let program = fixture_program(&["echo-lines"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut host = spawn_host_at(dir, state, endpoint, &[], &program);
    let status = wait_exit(&mut host, WAIT).expect("must fail fast");
    assert_eq!(status.code(), Some(1));
    let mut stderr = String::new();
    use std::io::Read;
    host.child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert!(stderr.contains("PTY_ENDPOINT_TOO_LONG"), "{stderr}");
}

/// M8 : une ligne cliente qui n'est pas de l'UTF-8 valide est REJETÉE (et
/// journalisée), jamais « réparée » en U+FFFD puis envoyée au programme.
#[test]
fn ligne_cliente_non_utf8_rejetee_jamais_reparee() {
    let program = fixture_program(&["echo-lines"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut host = spawn_host("badutf8", &[], &program);
    wait_ready(&mut host);
    let mut client = Client::connect(&host.endpoint);
    client.until_output("ECHO-READY");
    // `{"type":"message","text":"A<0xFF>B"}` : 0xFF n'est jamais valide en UTF-8.
    let mut line = br#"{"type":"message","text":"A"#.to_vec();
    line.push(0xFF);
    line.extend_from_slice(br#"B"}"#);
    line.push(b'\n');
    client.conn.write_all(&line).expect("send raw line");
    client.message("after-bad-line");
    client.until_output("ECHO:after-bad-line");
    assert!(
        !client.output.contains("ECHO:A"),
        "the corrupted line must never reach the program: {:?}",
        client.output
    );
}

/// M2 : un programme qui sort légitimement avec le code 259 (= STILL_ACTIVE)
/// est vu comme SORTI, avec ce code (Windows ; les codes POSIX sont sur 8 bits).
#[cfg(windows)]
#[test]
fn code_de_sortie_259_n_est_pas_still_active() {
    let program = fixture_program(&["exit-after-line", "259"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut host = spawn_host("still-active", &[], &program);
    wait_ready(&mut host);
    let mut client = Client::connect(&host.endpoint);
    client.until_output("READY");
    client.message("go");
    let exit = client.until_type("exit");
    assert_eq!(
        exit.get("exitCode").and_then(Value::as_u64),
        Some(259),
        "{exit:?}"
    );
}

/// N-I5, le cas qui distingue PR_SET_PDEATHSIG du seul SIGHUP du noyau : un
/// programme qui IGNORE SIGHUP survit à la fermeture du maître — sauf si
/// l'hôte l'a armé avec `PR_SET_PDEATHSIG = SIGKILL` (Linux).
#[cfg(target_os = "linux")]
#[test]
fn kill_brutal_de_l_hote_emporte_un_programme_qui_ignore_sighup() {
    let program = fixture_program(&["ignore-hup"]);
    let program: Vec<&str> = program.iter().map(String::as_str).collect();
    let mut host = spawn_host("pdeathsig", &[], &program);
    wait_ready(&mut host);
    let mut client = Client::connect(&host.endpoint);
    client.until_output("IGNORING-HUP");
    let child = host_child_pid(&host);
    assert!(!gone(child));
    host.child.kill().expect("kill -9 the host");
    let _ = host.child.wait();
    assert!(
        wait_gone(child, Duration::from_secs(15)),
        "SIGHUP-ignoring program {child} survived the brutal death of its host"
    );
}
