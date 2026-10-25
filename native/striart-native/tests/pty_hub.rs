//! Contre-pression et rejeu du multiplexeur de l'hôte de pty, sur le VRAI
//! canal d'attache (named pipe Windows / socket Unix) mais sans pseudo-
//! terminal : la sortie est injectée directement dans le hub, à un débit qui
//! ne dépend pas de la machine.
//!
//! Pourquoi en plus du test de bout en bout (tests/pty_host.rs) : sous
//! Windows, ConPTY ne relaie pas les octets du programme, il les RE-REND
//! depuis son tampon d'écran, à un débit qui dépend de la charge de la
//! machine (constaté : quelques dizaines de lignes par seconde sur un poste
//! chargé, node-pty comme hôte natif). Le test de bout en bout de l'éviction
//! y serait au mieux lent, au pire non déterministe ; il tourne sous POSIX,
//! où le pty transmet les octets tels quels, et ce test-ci couvre la même
//! logique sur les trois OS.

mod common;

use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};
use striart_native::base64;
use striart_native::json::{self, Value};
use striart_native::pty_host::hub::Hub;
use striart_native::sys::ipc::{self, Conn};

const UNIT: &[u8] = "\x1b[38;5;196mé€😀\x1b[0m|ok\r\n".as_bytes();

fn endpoint(tag: &str) -> (String, Option<std::path::PathBuf>) {
    let unique = format!(
        "{}{}{tag}",
        std::process::id(),
        Instant::now().elapsed().as_nanos()
    );
    if cfg!(windows) {
        (format!(r"\\.\pipe\striart-hubtest{unique}-agent-h"), None)
    } else {
        let dir = std::env::temp_dir().join(format!("striart-hub-{unique}"));
        std::fs::create_dir_all(&dir).expect("dir");
        (
            dir.join("attach.sock").to_string_lossy().into_owned(),
            Some(dir),
        )
    }
}

/// Hub servi sur un vrai canal : chaque client accepté a son thread
/// d'écriture, comme dans l'hôte.
fn serve(tag: &str, replay: usize, limit: usize) -> (Arc<Hub>, String, Option<std::path::PathBuf>) {
    let (ep, dir) = endpoint(tag);
    let listener = ipc::bind(&ep).expect("bind");
    let hub = Arc::new(Hub::new("agent-h", 80, 24, replay, limit));
    // Balayage périodique, comme la boucle principale de l'hôte : retire les
    // clients terminés (leur connexion se ferme alors).
    let swept = Arc::clone(&hub);
    std::thread::spawn(move || {
        loop {
            swept.sweep();
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    let served = Arc::clone(&hub);
    std::thread::spawn(move || {
        while let Ok(Some(conn)) = listener.accept() {
            if let Some(client) = served.attach(Arc::new(conn)) {
                std::thread::spawn(move || client.write_loop());
            }
        }
    });
    (hub, ep, dir)
}

fn reader(conn: Arc<Conn>) -> Receiver<Value> {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let mut pending = Vec::new();
        let mut buf = vec![0u8; 65536];
        while let Ok(n) = conn.read(&mut buf) {
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&buf[..n]);
            while let Some(end) = pending.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = pending.drain(..=end).collect();
                let text = std::str::from_utf8(&line[..line.len() - 1]).expect("utf8 frame");
                if tx.send(json::parse(text).expect("json frame")).is_err() {
                    return;
                }
            }
        }
    });
    rx
}

fn wait_clients(hub: &Hub, n: usize) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while hub.connected() < n {
        assert!(Instant::now() < deadline, "client never attached");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn client_qui_ne_lit_plus_evince_explicitement_puis_rejeu_borne_et_sur() {
    let (hub, ep, dir) = serve("evict", 4096, 65_536);
    let slow = Arc::new(ipc::connect(&ep).expect("connect"));
    wait_clients(&hub, 1);
    // Sortie injectée jusqu'à l'éviction (le client ne lit rien).
    let mut evicted = Vec::new();
    let mut sent = 0usize;
    let mut units = 0usize;
    while evicted.is_empty() {
        evicted = hub.output(UNIT);
        sent += UNIT.len();
        units += 1;
        assert!(sent < 64 * 1024 * 1024, "never evicted");
    }
    assert_eq!(evicted.len(), 1);
    // La mémoire de l'hôte est bornée : plus rien n'est mis en file pour lui.
    for _ in 0..1000 {
        assert!(hub.output(UNIT).is_empty());
        units += 1;
    }
    // Il reprend sa lecture : ce qui était déjà parti, puis `evicted`, puis
    // la fermeture.
    let frames = reader(Arc::clone(&slow));
    let mut last = None;
    loop {
        match frames.recv_timeout(Duration::from_secs(20)) {
            Ok(frame) => last = Some(frame),
            Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => panic!("evicted client never closed"),
        }
    }
    let last = last.expect("frames");
    assert_eq!(last.get("type").and_then(Value::as_str), Some("evicted"));
    assert_eq!(
        last.get("reason").and_then(Value::as_str),
        Some("slow-client")
    );

    // Reconnexion : hello (taille courante) puis rejeu borné, décodable seul,
    // qui commence à une frontière sûre.
    let again = Arc::new(ipc::connect(&ep).expect("reconnect"));
    let frames = reader(again);
    let hello = frames.recv_timeout(Duration::from_secs(10)).expect("hello");
    assert_eq!(hello.get("type").and_then(Value::as_str), Some("hello"));
    let data = frames
        .recv_timeout(Duration::from_secs(10))
        .expect("replay");
    assert_eq!(data.get("type").and_then(Value::as_str), Some("data"));
    let bytes = base64::decode(data.get("chunk").and_then(Value::as_str).unwrap()).unwrap();
    assert!(!bytes.is_empty() && bytes.len() <= 4096, "{}", bytes.len());
    let text = std::str::from_utf8(&bytes).expect("replay is valid UTF-8");
    // Le rejeu est un SUFFIXE du flux réel ; il doit commencer à l'état « sol »
    // de ce flux (aucune séquence CSI/OSC coupée) — vérifié par une machine à
    // états, pas par une liste de premiers caractères tolérés.
    let stream = String::from_utf8(UNIT.repeat(units)).expect("stream");
    assert!(
        stream.ends_with(text),
        "replay must be a suffix of the stream"
    );
    let start = stream.len() - text.len();
    assert!(
        common::is_ground_state_after(&stream[..start]),
        "replay starts inside a sequence: {:?}",
        &text[..text.len().min(24)]
    );
    if let Some(dir) = dir {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn fin_de_session_frame_exit_puis_fermeture_pour_tous() {
    let (hub, ep, dir) = serve("finish", 4096, 65_536);
    let a = reader(Arc::new(ipc::connect(&ep).expect("connect")));
    let b = reader(Arc::new(ipc::connect(&ep).expect("connect")));
    wait_clients(&hub, 2);
    hub.output(b"bye\r\n");
    hub.finish(Some(3), None);
    for frames in [a, b] {
        let mut kinds = Vec::new();
        loop {
            match frames.recv_timeout(Duration::from_secs(10)) {
                Ok(frame) => {
                    kinds.push(
                        frame
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap()
                            .to_string(),
                    );
                    if kinds.last().is_some_and(|k| k == "exit") {
                        assert_eq!(frame.get("exitCode").and_then(Value::as_u64), Some(3));
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => panic!("client never closed"),
            }
        }
        assert_eq!(kinds, ["hello", "data", "exit"]);
    }
    // Plus aucun client accepté après la fin.
    let late = Arc::new(ipc::connect(&ep).expect("connect"));
    let mut buf = [0u8; 64];
    assert_eq!(late.read(&mut buf).unwrap_or(0), 0);
    if let Some(dir) = dir {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn file_minimale_une_frame_de_sortie_n_evince_pas_un_client_vide() {
    // Limite demandée absurde (1 octet) : le hub la remonte au plancher
    // (rejeu + deux frames), sinon la première frame évincerait chaque client
    // dès sa connexion, en boucle de reconnexion (M4).
    let (hub, ep, dir) = serve("floor", 65_536, 1);
    let _client = Arc::new(ipc::connect(&ep).expect("connect"));
    wait_clients(&hub, 1);
    let chunk = vec![b'x'; striart_native::pty_host::OUTPUT_CHUNK_BYTES];
    for _ in 0..2 {
        assert!(hub.output(&chunk).is_empty(), "client evicted by one frame");
    }
    assert!(hub.queue_limit() as u64 >= striart_native::pty_host::min_client_queue_bytes(65_536));
    if let Some(dir) = dir {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn redimensionnements_concurrents_pty_et_hub_ne_divergent_jamais() {
    // Plusieurs clients redimensionnent en même temps : l'ordre d'application
    // au pty doit être celui de la taille mémorisée (M9).
    let hub = Arc::new(Hub::new("agent-h", 80, 24, 4096, 65_536));
    let applied = Arc::new(std::sync::Mutex::new(Vec::<(u16, u16)>::new()));
    let mut threads = Vec::new();
    for t in 0..8u16 {
        let hub = Arc::clone(&hub);
        let applied = Arc::clone(&applied);
        threads.push(std::thread::spawn(move || {
            for i in 0..200u16 {
                let (cols, rows) = (100 + t, 30 + i % 50);
                hub.resize_with(cols, rows, || {
                    applied.lock().unwrap().push((cols, rows));
                    true
                });
            }
        }));
    }
    for t in threads {
        t.join().expect("thread");
    }
    let last = *applied.lock().unwrap().last().expect("applied");
    assert_eq!(
        hub.size(),
        last,
        "hub size must be the last size applied to the pty"
    );
    // Un échec d'application ne change pas la taille mémorisée.
    hub.resize_with(999, 999, || false);
    assert_eq!(hub.size(), last);
}

/// M1 : `shutdown` ne laisse JAMAIS une lecture bloquée — y compris quand il
/// s'exécute entre le contrôle de `closed` et le démarrage de l'E/S (Windows :
/// `CancelIoEx` n'avait alors rien à annuler).
#[test]
fn shutdown_concurrent_ne_laisse_jamais_une_lecture_bloquee() {
    let (ep, dir) = endpoint("shutdownrace");
    let listener = Arc::new(ipc::bind(&ep).expect("bind"));
    for round in 0..60u64 {
        let _client = ipc::connect(&ep).expect("connect");
        let server = Arc::new(
            listener
                .accept()
                .expect("accept")
                .expect("a connection, not a shutdown"),
        );
        let reading = Arc::clone(&server);
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 16];
            let _ = reading.read(&mut buf);
            let _ = tx.send(());
        });
        // Délai variable : le `shutdown` tombe avant, pendant ou après le
        // démarrage de l'E/S du thread lecteur.
        std::thread::sleep(Duration::from_micros(round * 40));
        server.shutdown();
        rx.recv_timeout(Duration::from_secs(5))
            .expect("read must return promptly after shutdown");
    }
    listener.shutdown();
    if let Some(dir) = dir {
        let _ = std::fs::remove_dir_all(dir);
    }
}
