//! Process de test pilotable (tests d'intégration de `striart-native`) —
//! construit par `cargo test`, jamais livré (les exemples ne font pas partie
//! du binaire publié).
//!
//! Rôles :
//! - `sleep <ms>` : dort puis sort 0 ;
//! - `spawn-orphan <ms>` : lance `sleep <ms>` (stdio fermés), écrit son PID
//!   sur stdout, sort 0 aussitôt — le petit-fils devient orphelin ;
//! - `spawn-tree <ms>` : lance `sleep <ms>`, écrit son PID, puis dort `<ms>` ;
//! - `print-then-sleep <ms>` : écrit `ready` (vidé), dort, écrit `done`.

use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

fn spawn_sleeper(ms: u64) -> u32 {
    let exe = std::env::current_exe().expect("current exe");
    Command::new(exe)
        .args(["sleep", &ms.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn sleeper")
        .id()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let ms: u64 = args
        .get(1)
        .and_then(|v| v.parse().ok())
        .expect("usage: process-fixture <role> <ms>");
    let mut out = std::io::stdout();
    match args[0].as_str() {
        "sleep" => std::thread::sleep(Duration::from_millis(ms)),
        "spawn-orphan" => {
            let pid = spawn_sleeper(ms);
            writeln!(out, "{pid}").expect("stdout");
            out.flush().expect("flush");
        }
        "spawn-tree" => {
            let pid = spawn_sleeper(ms);
            writeln!(out, "{pid}").expect("stdout");
            out.flush().expect("flush");
            std::thread::sleep(Duration::from_millis(ms));
        }
        "print-then-sleep" => {
            writeln!(out, "ready").expect("stdout");
            out.flush().expect("flush");
            std::thread::sleep(Duration::from_millis(ms));
            writeln!(out, "done").expect("stdout");
        }
        other => panic!("unknown role {other}"),
    }
}
