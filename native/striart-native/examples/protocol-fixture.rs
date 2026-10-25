//! Faux `striart-native` qui viole le protocole à la demande — pour les tests
//! de src/native.ts (validation positive des réponses). Construit par
//! `npm run native:build` (exemples compris) et `cargo test`, jamais livré.
//!
//! Le mode vient de la variable `STRIART_PROTOCOL_FIXTURE` (les arguments
//! sont ceux qu'envoie src/native.ts, inchangés) :
//! - `ok-version-bad-info` : `version` conforme, `proc info` de forme invalide ;
//! - `stdout-garbage` : `version` rend du texte qui n'est pas du JSON ;
//! - `stdout-multiline` : deux documents JSON au lieu d'un ;
//! - `protocol-2` : `version` annonce le protocole 2 ;
//! - `wrong-platform` : `version` annonce un autre OS ;
//! - `stderr-garbage` : sortie 1 avec un stderr qui n'est pas du JSON ;
//! - `native-error` : sortie 1 avec une erreur JSON conforme.

use std::io::Write;

fn version_doc(protocol: u32, os: &str) -> String {
    format!(
        "{{\"name\":\"striart-native\",\"version\":\"0.0.0-fixture\",\"protocol\":{protocol},\"os\":\"{os}\",\"arch\":\"{}\",\"commands\":[]}}",
        std::env::consts::ARCH
    )
}

fn main() {
    let mode = std::env::var("STRIART_PROTOCOL_FIXTURE").unwrap_or_default();
    let command = std::env::args().nth(1).unwrap_or_default();
    let os = std::env::consts::OS;
    let mut out = std::io::stdout();
    let mut err = std::io::stderr();
    let code = match (mode.as_str(), command.as_str()) {
        ("ok-version-bad-info", "version") => {
            writeln!(out, "{}", version_doc(1, os)).ok();
            0
        }
        ("ok-version-bad-info", _) => {
            writeln!(out, "{{\"processes\":[{{\"pid\":\"x\"}}],\"missing\":[]}}").ok();
            0
        }
        ("stdout-garbage", _) => {
            writeln!(out, "this is not json").ok();
            0
        }
        ("stdout-multiline", _) => {
            writeln!(out, "{}\n{}", version_doc(1, os), version_doc(1, os)).ok();
            0
        }
        ("protocol-2", _) => {
            writeln!(out, "{}", version_doc(2, os)).ok();
            0
        }
        ("wrong-platform", _) => {
            let other = if os == "windows" { "linux" } else { "windows" };
            writeln!(out, "{}", version_doc(1, other)).ok();
            0
        }
        ("stderr-garbage", _) => {
            writeln!(err, "panicked at something").ok();
            1
        }
        ("native-error", _) => {
            writeln!(
                err,
                "{{\"error\":{{\"code\":\"SNAPSHOT_FAILED\",\"message\":\"fixture\"}}}}"
            )
            .ok();
            1
        }
        _ => {
            writeln!(err, "unknown STRIART_PROTOCOL_FIXTURE mode \"{mode}\"").ok();
            2
        }
    };
    std::process::exit(code);
}
