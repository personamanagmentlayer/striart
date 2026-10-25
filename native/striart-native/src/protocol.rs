//! Contrat entre `striart-native` et son appelant (src/native.ts).
//!
//! - **stdout = données** : un unique document JSON sur une ligne, émis en
//!   fin de commande quand elle réussit (`job run` excepté : stdout et stderr
//!   y appartiennent à la commande enfant, le rapport va dans `--report-file`).
//! - **stderr = diagnostics** : en cas d'échec, une ligne JSON
//!   `{"error":{"code":…,"message":…}}`, rien d'autre.
//! - **codes de sortie stables** (`exit`) : 0 succès, 1 échec d'exécution,
//!   2 usage invalide, 3 hôte de pty déjà actif pour l'agent (`pty-host`
//!   seulement), 128+n interruption par le signal n (POSIX) ou par
//!   l'événement console équivalent (Windows).
//! - **argv uniquement** : aucune entrée n'est lue sur stdin, aucune n'est
//!   interprétée par un shell. `pty-host` est un service : il lit les frames
//!   de ses clients sur son canal d'attache local, et sa demande d'arrêt
//!   dans `host.stop` ; stderr est son journal (une ligne JSON par
//!   événement, la dernière est l'erreur en cas d'échec).

use crate::json::Json;
use std::io::Write;

/// Version du protocole. Incrémentée à toute rupture de forme d'une sortie
/// existante ; src/native.ts refuse un binaire d'une autre version.
pub const PROTOCOL_VERSION: u64 = 1;

/// Codes de sortie du binaire.
pub mod exit {
    pub const OK: i32 = 0;
    pub const FAILURE: i32 = 1;
    pub const USAGE: i32 = 2;
    /// 128 + numéro du signal (convention POSIX des shells).
    pub const SIGNAL_BASE: i32 = 128;
}

/// Erreur rapportée à l'appelant. `code` est stable (contrat) ; `message`
/// est un diagnostic humain en anglais, sans donnée sensible.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeError {
    pub code: &'static str,
    pub message: String,
    pub exit_code: i32,
}

impl NativeError {
    pub fn usage(message: impl Into<String>) -> Self {
        Self {
            code: "USAGE",
            message: message.into(),
            exit_code: exit::USAGE,
        }
    }

    pub fn failure(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            exit_code: exit::FAILURE,
        }
    }

    /// Échec d'un appel système, avec l'erreur de l'OS (jamais de donnée
    /// utilisateur dans `what`).
    pub fn os(code: &'static str, what: &str) -> Self {
        Self::failure(code, format!("{what}: {}", std::io::Error::last_os_error()))
    }

    pub fn to_json(&self) -> Json {
        Json::Obj(vec![(
            "error",
            Json::Obj(vec![
                ("code", Json::Str(self.code.to_string())),
                ("message", Json::Str(self.message.clone())),
            ]),
        )])
    }
}

/// Écrit le document de données sur stdout. Un stdout fermé (lecteur parti)
/// est un échec : le résultat n'a pas été livré.
pub fn emit_data(value: &Json) -> Result<(), NativeError> {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{}", value.to_line())
        .and_then(|()| stdout.flush())
        .map_err(|e| NativeError::failure("OUTPUT_FAILED", format!("stdout: {e}")))
}

/// Écrit l'erreur sur stderr. Best effort : si stderr est fermé, le code de
/// sortie reste le seul canal — il suffit au contrat.
pub fn emit_error(error: &NativeError) {
    let mut stderr = std::io::stderr().lock();
    let _ = writeln!(stderr, "{}", error.to_json().to_line());
    let _ = stderr.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forme_de_l_erreur() {
        let e = NativeError::usage("unknown option --x");
        assert_eq!(e.exit_code, exit::USAGE);
        assert_eq!(
            e.to_json().to_line(),
            r#"{"error":{"code":"USAGE","message":"unknown option --x"}}"#
        );
    }
}
