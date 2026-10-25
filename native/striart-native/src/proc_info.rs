//! `proc info --pids <liste>` : identité groupée de plusieurs process, en un
//! seul appel et un seul instantané de l'OS.
//!
//! Sortie : `{"processes":[{pid, ppid, name, commandLine, startTimeMs}],
//! "missing":[pid…]}`. Un PID absent (mort, jamais attribué) figure dans
//! `missing` ; un champ illisible (droits) vaut `null` — jamais une valeur
//! devinée.

use crate::json::Json;
use crate::protocol::NativeError;
use crate::sys::{self, Info};

pub fn run(pids: &[u32]) -> Result<Json, NativeError> {
    Ok(document(pids, &sys::infos(pids)?))
}

pub fn info_json(info: &Info) -> Json {
    Json::Obj(vec![
        ("pid", Json::UInt(u64::from(info.pid))),
        ("ppid", Json::from(info.ppid)),
        ("name", Json::Str(info.name.clone())),
        ("commandLine", Json::from(info.command_line.clone())),
        ("startTimeMs", Json::from(info.start_ms)),
    ])
}

fn document(requested: &[u32], infos: &[Info]) -> Json {
    let missing = requested
        .iter()
        .filter(|pid| !infos.iter().any(|i| i.pid == **pid))
        .map(|pid| Json::UInt(u64::from(*pid)))
        .collect();
    Json::Obj(vec![
        (
            "processes",
            Json::Arr(infos.iter().map(info_json).collect()),
        ),
        ("missing", Json::Arr(missing)),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forme_du_document() {
        let infos = [Info {
            pid: 10,
            ppid: None,
            name: "node.exe".into(),
            command_line: Some("node \"a b\"".into()),
            start_ms: Some(1_700_000_000_123),
        }];
        assert_eq!(
            document(&[10, 11], &infos).to_line(),
            r#"{"processes":[{"pid":10,"ppid":null,"name":"node.exe","commandLine":"node \"a b\"","startTimeMs":1700000000123}],"missing":[11]}"#
        );
    }

    #[test]
    fn lit_le_process_courant_et_son_parent() {
        let me = std::process::id();
        let infos = sys::infos(&[me]).expect("infos");
        let info = infos.first().expect("current process must be readable");
        assert_eq!(info.pid, me);
        assert!(info.ppid.is_some());
        assert!(info.name.to_lowercase().contains("striart_native"));
        let line = info.command_line.as_deref().expect("own command line");
        assert!(line.to_lowercase().contains("striart_native"));
        let started = info.start_ms.expect("own creation time");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_millis() as u64;
        assert!(
            started <= now + 1_000,
            "created in the future: {started} > {now}"
        );
        assert!(
            now - started < 3_600_000,
            "test process older than an hour?"
        );
    }

    #[test]
    fn pid_inexistant_absent() {
        // u32::MAX - 1 : multiple de 2 mais pas de 4 — jamais un PID Windows,
        // au-delà de pid_max sous Linux et macOS.
        let ghost = u32::MAX - 1;
        assert!(sys::infos(&[ghost]).expect("infos").is_empty());
    }
}
