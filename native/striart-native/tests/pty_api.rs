//! Contrat de l'API `Pty` (sans hôte ni canal) : redimensionnement et
//! fermeture concurrents, nettoyage de la descendance.
//!
//! Le programme hébergé est l'exemple `pty-fixture` (comportement
//! déterministe).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use striart_native::sys::pty::{Pty, PtySpec};

fn fixture() -> PathBuf {
    let dir = Path::new(env!("CARGO_BIN_EXE_striart-native"))
        .parent()
        .expect("target dir");
    let path = dir
        .join("examples")
        .join(format!("pty-fixture{}", std::env::consts::EXE_SUFFIX));
    assert!(path.exists(), "fixture missing: {}", path.display());
    path
}

fn spawn(args: &[&str]) -> Arc<Pty> {
    let program = fixture();
    let args: Vec<std::ffi::OsString> = args.iter().map(Into::into).collect();
    let cwd = std::env::temp_dir();
    Arc::new(
        Pty::spawn(&PtySpec {
            program: &program,
            args: &args,
            cwd: &cwd,
            cols: 80,
            rows: 24,
            term: None,
            adopt_orphans: false,
        })
        .expect("spawn pty"),
    )
}

/// N-I4 : `resize` et `close` en course. Jamais de plantage ni d'appel sur un
/// HPCON fermé ; une fois fermé, `resize` échoue proprement (`NotConnected`),
/// et `close` reste idempotent.
#[test]
fn resize_et_close_concurrents_puis_resize_apres_close() {
    for round in 0..20u64 {
        let pty = spawn(&["echo-lines"]);
        let reader = pty.take_reader().expect("reader");
        let drain = std::thread::spawn(move || {
            use std::io::Read;
            let mut sink = [0u8; 4096];
            let mut reader = reader;
            while matches!(reader.read(&mut sink), Ok(n) if n > 0) {}
        });
        let resizer = {
            let pty = Arc::clone(&pty);
            std::thread::spawn(move || {
                for i in 0..400u16 {
                    let _ = pty.resize(60 + i % 40, 20 + i % 20);
                }
            })
        };
        std::thread::sleep(Duration::from_millis(round % 5));
        pty.close();
        pty.close(); // idempotent
        resizer.join().expect("resizer must not panic");
        let error = pty
            .resize(100, 30)
            .expect_err("resize after close must fail");
        assert_eq!(error.kind(), std::io::ErrorKind::NotConnected, "{error:?}");
        assert!(pty.terminate(), "descendance tuée, plus rien ne vit");
        let _ = drain.join();
    }
}

/// `terminate` rend `true` seulement si plus rien ne vit, et il attend.
#[test]
fn terminate_tue_le_programme_et_rend_vrai() {
    let pty = spawn(&["echo-lines"]);
    let reader = pty.take_reader().expect("reader");
    std::thread::spawn(move || {
        use std::io::Read;
        let mut sink = [0u8; 4096];
        let mut reader = reader;
        while matches!(reader.read(&mut sink), Ok(n) if n > 0) {}
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while !pty.tree_alive() {
        assert!(Instant::now() < deadline, "program never started");
        std::thread::sleep(Duration::from_millis(10));
    }
    pty.close();
    assert!(pty.terminate());
    assert!(!pty.tree_alive());
    assert!(pty.terminate(), "idempotent on an empty tree");
}

/// M5 : détruire un `Pty` ne laisse pas son programme derrière lui (POSIX :
/// `Drop` ; Windows : fermeture du Job Object).
#[test]
fn drop_du_pty_tue_le_programme() {
    let pty = spawn(&["spawn-grandchild", "600000"]);
    let pid = pty.pid();
    // La sortie est drainée (ConPTY peut attendre sa lecture à la fermeture).
    let reader = pty.take_reader().expect("reader");
    std::thread::spawn(move || {
        use std::io::Read;
        let mut sink = [0u8; 4096];
        let mut reader = reader;
        while matches!(reader.read(&mut sink), Ok(n) if n > 0) {}
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while !alive(pid) {
        assert!(Instant::now() < deadline, "program never started");
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(pty);
    let deadline = Instant::now() + Duration::from_secs(15);
    while alive(pid) {
        assert!(Instant::now() < deadline, "program {pid} survived the drop");
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn alive(pid: u32) -> bool {
    striart_native::sys::snapshot()
        .map(|table| table.iter().any(|e| e.pid == pid && !e.zombie))
        .unwrap_or(false)
}
