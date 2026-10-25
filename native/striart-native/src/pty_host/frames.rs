//! Frames ndjson du protocole d'attache (contrat partagé avec
//! `src/pty-attach.ts`, inchangé depuis l'hôte Node) — une frame JSON par
//! ligne :
//!
//! - serveur → client : `hello {agent, cols, rows}`, `data {chunk}` (sortie
//!   du pty en base64), `resize {cols, rows}` (diffusé à TOUS les clients
//!   quand l'un redimensionne), `exit {exitCode, signal}`, et `evicted
//!   {reason}` (nouveau : client trop lent, déconnecté — il se reconnecte et
//!   reçoit le rejeu ; un client qui ignore ce type voit simplement la
//!   connexion se fermer) ;
//! - client → serveur : `input {data}` (frappes brutes, base64), `message
//!   {text}` (instruction du bus `@agent`, Entrée ajoutée par l'hôte),
//!   `resize {cols, rows}`.

use crate::base64;
use crate::json::{self, Json, Value};

/// Plus grande dimension de terminal acceptée (colonnes comme lignes).
pub const MAX_DIMENSION: u64 = 1_000;
/// Plus longue ligne client acceptée ; au-delà, le client est coupé (une
/// ligne sans fin ferait grossir le tampon de l'hôte sans borne).
pub const MAX_CLIENT_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientFrame {
    Input(Vec<u8>),
    Message(String),
    Resize { cols: u16, rows: u16 },
}

fn dimension(value: Option<&Value>) -> Option<u16> {
    let v = value?.as_u64()?;
    if (1..=MAX_DIMENSION).contains(&v) {
        u16::try_from(v).ok()
    } else {
        None
    }
}

/// Validation positive d'une ligne client. `Err` : ligne ignorée (comme
/// l'hôte Node : une ligne malformée ne coupe pas le pty partagé).
pub fn parse_client_frame(line: &str) -> Result<ClientFrame, &'static str> {
    let value = json::parse(line)?;
    match value.get("type").and_then(Value::as_str) {
        Some("input") => {
            let data = value
                .get("data")
                .and_then(Value::as_str)
                .ok_or("input: missing data")?;
            base64::decode(data)
                .map(ClientFrame::Input)
                .ok_or("input: invalid base64")
        }
        Some("message") => value
            .get("text")
            .and_then(Value::as_str)
            .map(|t| ClientFrame::Message(t.to_string()))
            .ok_or("message: missing text"),
        Some("resize") => match (dimension(value.get("cols")), dimension(value.get("rows"))) {
            (Some(cols), Some(rows)) => Ok(ClientFrame::Resize { cols, rows }),
            _ => Err("resize: invalid dimensions"),
        },
        _ => Err("unknown frame type"),
    }
}

fn line(value: &Json) -> Vec<u8> {
    let mut out = value.to_line().into_bytes();
    out.push(b'\n');
    out
}

pub fn hello(agent: &str, cols: u16, rows: u16) -> Vec<u8> {
    line(&Json::Obj(vec![
        ("type", Json::Str("hello".into())),
        ("agent", Json::Str(agent.into())),
        ("cols", Json::UInt(u64::from(cols))),
        ("rows", Json::UInt(u64::from(rows))),
    ]))
}

pub fn data(bytes: &[u8]) -> Vec<u8> {
    line(&Json::Obj(vec![
        ("type", Json::Str("data".into())),
        ("chunk", Json::Str(base64::encode(bytes))),
    ]))
}

pub fn resize(cols: u16, rows: u16) -> Vec<u8> {
    line(&Json::Obj(vec![
        ("type", Json::Str("resize".into())),
        ("cols", Json::UInt(u64::from(cols))),
        ("rows", Json::UInt(u64::from(rows))),
    ]))
}

pub fn exit(code: Option<i64>, signal: Option<i32>) -> Vec<u8> {
    line(&Json::Obj(vec![
        ("type", Json::Str("exit".into())),
        ("exitCode", code.map_or(Json::Null, Json::Int)),
        (
            "signal",
            signal.map_or(Json::Null, |s| Json::Int(i64::from(s))),
        ),
    ]))
}

pub fn evicted(reason: &str) -> Vec<u8> {
    line(&Json::Obj(vec![
        ("type", Json::Str("evicted".into())),
        ("reason", Json::Str(reason.into())),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_serveur() {
        assert_eq!(
            hello("agent-a", 80, 24),
            b"{\"type\":\"hello\",\"agent\":\"agent-a\",\"cols\":80,\"rows\":24}\n"
        );
        assert_eq!(
            data(b"\x1b[0m\xff"),
            b"{\"type\":\"data\",\"chunk\":\"G1swbf8=\"}\n"
        );
        assert_eq!(
            resize(111, 41),
            b"{\"type\":\"resize\",\"cols\":111,\"rows\":41}\n"
        );
        assert_eq!(
            exit(Some(0), None),
            b"{\"type\":\"exit\",\"exitCode\":0,\"signal\":null}\n"
        );
        assert_eq!(
            exit(None, None),
            b"{\"type\":\"exit\",\"exitCode\":null,\"signal\":null}\n"
        );
        assert_eq!(
            evicted("slow-client"),
            b"{\"type\":\"evicted\",\"reason\":\"slow-client\"}\n"
        );
    }

    #[test]
    fn frames_client() {
        assert_eq!(
            parse_client_frame(r#"{"type":"input","data":"aGk="}"#),
            Ok(ClientFrame::Input(b"hi".to_vec()))
        );
        assert_eq!(
            parse_client_frame(r#"{"type":"message","text":"echo é"}"#),
            Ok(ClientFrame::Message("echo é".into()))
        );
        assert_eq!(
            parse_client_frame(r#"{"type":"resize","cols":120,"rows":40}"#),
            Ok(ClientFrame::Resize {
                cols: 120,
                rows: 40
            })
        );
        for bad in [
            "",
            "not json",
            r#"{"type":"input","data":"%%"}"#,
            r#"{"type":"input"}"#,
            r#"{"type":"message","text":3}"#,
            r#"{"type":"resize","cols":0,"rows":40}"#,
            r#"{"type":"resize","cols":1001,"rows":40}"#,
            r#"{"type":"resize","cols":80.5,"rows":40}"#,
            r#"{"type":"resize","cols":-1,"rows":40}"#,
            r#"{"type":"stop"}"#,
            r#"["input"]"#,
        ] {
            assert!(parse_client_frame(bad).is_err(), "{bad}");
        }
    }
}
