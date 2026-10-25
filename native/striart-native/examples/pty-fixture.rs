//! Programme hébergé par les tests de `pty-host` (tests/pty_host.rs et
//! tests/integration/pty-native.test.js) : comportements déterministes,
//! indépendants du shell de la machine.
//!
//! - `flood-on-go <octets>` : attend une ligne « go » sur l'entrée, puis
//!   écrit <octets> octets d'unités mêlant séquences ANSI (CSI, OSC, DCS) et
//!   caractères UTF-8 multi-octets, puis `FLOOD-DONE`, puis attend la fin de
//!   l'entrée ;
//! - `echo-lines` : réécrit chaque ligne lue préfixée de `ECHO:` ;
//! - `exit-with <code>` : écrit `BYE` et sort avec <code> ;
//! - `exit-after-line <code>` : écrit `READY`, attend une ligne, écrit `BYE`
//!   et sort avec <code> (un client a le temps de se connecter avant la fin) ;
//! - `sleep <ms>` : dort puis sort 0 (petit-fils des tests) ;
//! - `spawn-grandchild <ms>` : lance `sleep <ms>` (stdio fermés, même groupe),
//!   écrit `GRANDCHILD:<pid>`, puis se comporte comme `echo-lines` ;
//! - `spawn-detached <ms>` (POSIX) : idem mais le petit-fils quitte le groupe et
//!   la session (`setsid`), écrit `DETACHED:<pid>` ;
//! - `ignore-hup` (POSIX) : ignore SIGHUP, écrit `IGNORING-HUP` et vit
//!   jusqu'à ce qu'on le tue (ne lit plus l'entrée).

use std::io::{BufRead, Write};

/// Unité du flot : CSI (couleur) et UTF-8 multi-octets. Le titre (OSC) n'est
/// émis qu'une fois : sous conhost, chaque changement de titre coûte des
/// centaines de millisecondes et ralentirait le flot à quelques lignes par
/// seconde (constaté avec node-pty comme avec l'hôte natif).
const UNIT: &str = "\x1b[38;5;196mé€😀\x1b[0m|ok\r\n";
const TITLE: &str = "\x1b]0;flood\x07";

/// Lance `pty-fixture sleep <ms>` (stdio fermés) et rend son PID ; `detached`
/// (POSIX) : le petit-fils quitte le groupe et la session du pty (`setsid`).
fn spawn_sleeper(ms: u64, detached: bool) -> u32 {
    let exe = std::env::current_exe().expect("current exe");
    let mut command = std::process::Command::new(exe);
    command
        .args(["sleep", &ms.to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    if detached {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid est async-signal-safe ; seul appel entre fork et exec.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            })
        };
    }
    #[cfg(not(unix))]
    let _ = detached;
    command.spawn().expect("spawn sleeper").id()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    match args.first().map(String::as_str) {
        Some("flood-on-go") => {
            let total: usize = args.get(1).and_then(|n| n.parse().ok()).unwrap_or(1 << 20);
            let _ = writeln!(out, "READY-FOR-GO");
            let _ = out.flush();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { return };
                if line.trim() == "go" {
                    break;
                }
            }
            let _ = out.write_all(TITLE.as_bytes());
            let mut written = 0usize;
            while written < total {
                let _ = out.write_all(UNIT.as_bytes());
                written += UNIT.len();
            }
            let _ = writeln!(out, "FLOOD-DONE");
            let _ = out.flush();
            for line in stdin.lock().lines() {
                if line.is_err() {
                    return;
                }
            }
        }
        Some("echo-lines") => {
            let _ = writeln!(out, "ECHO-READY");
            let _ = out.flush();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { return };
                let _ = writeln!(out, "ECHO:{}", line.trim_end());
                let _ = out.flush();
            }
        }
        Some("exit-with") => {
            let code: i32 = args.get(1).and_then(|n| n.parse().ok()).unwrap_or(0);
            let _ = writeln!(out, "BYE");
            let _ = out.flush();
            std::process::exit(code);
        }
        Some("exit-after-line") => {
            let code: i32 = args.get(1).and_then(|n| n.parse().ok()).unwrap_or(0);
            let _ = writeln!(out, "READY");
            let _ = out.flush();
            let mut line = String::new();
            let _ = stdin.lock().read_line(&mut line);
            let _ = writeln!(out, "BYE");
            let _ = out.flush();
            std::process::exit(code);
        }
        Some("sleep") => {
            let ms: u64 = args.get(1).and_then(|n| n.parse().ok()).unwrap_or(0);
            std::thread::sleep(std::time::Duration::from_millis(ms));
        }
        Some(role @ ("spawn-grandchild" | "spawn-detached")) => {
            let ms: u64 = args.get(1).and_then(|n| n.parse().ok()).unwrap_or(60_000);
            let pid = spawn_sleeper(ms, role == "spawn-detached");
            let label = if role == "spawn-detached" {
                "DETACHED"
            } else {
                "GRANDCHILD"
            };
            let _ = writeln!(out, "{label}:{pid}");
            let _ = writeln!(out, "ECHO-READY");
            let _ = out.flush();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { return };
                let _ = writeln!(out, "ECHO:{}", line.trim_end());
                let _ = out.flush();
            }
        }
        #[cfg(unix)]
        Some("ignore-hup") => {
            // SAFETY: signal(2) avec une disposition standard.
            unsafe { libc::signal(libc::SIGHUP, libc::SIG_IGN) };
            let _ = writeln!(out, "IGNORING-HUP");
            let _ = out.flush();
            loop {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        _ => {
            eprintln!(
                "usage: pty-fixture flood-on-go <bytes> | echo-lines | exit-with <code> | exit-after-line <code> | sleep <ms> | spawn-grandchild <ms> | spawn-detached <ms> | ignore-hup"
            );
            std::process::exit(2);
        }
    }
}
