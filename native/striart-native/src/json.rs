//! JSON minimal : encodeur (`Json`) et lecteur strict (`parse`, `Value`).
//!
//! Les commandes ponctuelles n'émettent que du JSON (leurs entrées arrivent
//! par argv) ; l'hôte de pty (`pty_host`) en LIT aussi : les frames ndjson
//! des clients d'attache et la demande d'arrêt `host.stop`. Une dépendance
//! (`serde_json`) pour quelques objets plats ajouterait de la surface supply
//! chain sans rien apporter : l'encodage comme la lecture sont entièrement
//! couverts par les tests ci-dessous (échappements, caractères de contrôle,
//! Unicode, paires de substitution, profondeur et taille bornées).

use std::fmt::Write as _;

/// Valeur JSON. Les objets gardent l'ordre d'insertion (sortie stable,
/// lisible dans un log).
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(&'static str, Json)>),
}

impl Json {
    /// Sérialisation compacte, sur une seule ligne (ndjson-compatible).
    pub fn to_line(&self) -> String {
        let mut out = String::with_capacity(128);
        self.write_into(&mut out);
        out
    }

    fn write_into(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Int(n) => {
                // `write!` vers une String ne peut pas échouer.
                let _ = write!(out, "{n}");
            }
            Json::UInt(n) => {
                let _ = write!(out, "{n}");
            }
            Json::Str(s) => write_string(s, out),
            Json::Arr(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write_into(out);
                }
                out.push(']');
            }
            Json::Obj(fields) => {
                out.push('{');
                for (i, (key, value)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_string(key, out);
                    out.push(':');
                    value.write_into(out);
                }
                out.push('}');
            }
        }
    }
}

impl From<Option<u64>> for Json {
    fn from(value: Option<u64>) -> Self {
        value.map_or(Json::Null, Json::UInt)
    }
}

impl From<Option<u32>> for Json {
    fn from(value: Option<u32>) -> Self {
        value.map_or(Json::Null, |v| Json::UInt(u64::from(v)))
    }
}

impl From<Option<String>> for Json {
    fn from(value: Option<String>) -> Self {
        value.map_or(Json::Null, Json::Str)
    }
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // Contrôles C0 et DEL, plus les séparateurs de ligne Unicode :
            // une ligne de commande lue chez l'OS est une donnée étrangère, elle
            // ne doit pas pouvoir casser le découpage en lignes du lecteur.
            c if (c as u32) < 0x20 || c == '\u{7f}' || c == '\u{2028}' || c == '\u{2029}' => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

// ── Lecture ──────────────────────────────────────────────────────────────

/// Profondeur maximale d'imbrication acceptée (les documents lus sont plats).
pub const MAX_DEPTH: usize = 16;

/// Valeur JSON lue. Les nombres gardent leur texte : l'appelant choisit le
/// type cible et ses bornes (`as_u64`), sans perte par un passage en f64.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(String),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

impl Value {
    /// Champ d'un objet (première occurrence ; une clé dupliquée est refusée
    /// par `parse`).
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    /// Entier non signé écrit en notation décimale simple (ni fraction, ni
    /// exposant, ni signe).
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Value::Number(text) if text.bytes().all(|b| b.is_ascii_digit()) => text.parse().ok(),
            _ => None,
        }
    }
}

/// Lecture stricte d'un document JSON complet (RFC 8259) : espaces de tête
/// et de fin tolérés, rien d'autre après la valeur, clés dupliquées refusées,
/// profondeur bornée. `Err` porte une raison courte (diagnostic, sans écho de
/// l'entrée).
pub fn parse(text: &str) -> Result<Value, &'static str> {
    let mut reader = Reader {
        bytes: text.as_bytes(),
        pos: 0,
    };
    reader.skip_ws();
    let value = reader.value(0)?;
    reader.skip_ws();
    if reader.pos != reader.bytes.len() {
        return Err("trailing characters");
    }
    Ok(value)
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn literal(&mut self, word: &str, value: Value) -> Result<Value, &'static str> {
        if self.bytes[self.pos..].starts_with(word.as_bytes()) {
            self.pos += word.len();
            Ok(value)
        } else {
            Err("invalid literal")
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, &'static str> {
        if depth > MAX_DEPTH {
            return Err("nesting too deep");
        }
        match self.peek().ok_or("unexpected end")? {
            b'n' => self.literal("null", Value::Null),
            b't' => self.literal("true", Value::Bool(true)),
            b'f' => self.literal("false", Value::Bool(false)),
            b'"' => self.string().map(Value::Str),
            b'[' => self.array(depth),
            b'{' => self.object(depth),
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err("unexpected character"),
        }
    }

    fn number(&mut self) -> Result<Value, &'static str> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
            }
            _ => return Err("invalid number"),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err("invalid number");
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err("invalid number");
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        // Les octets lus sont ASCII : la tranche est de l'UTF-8 valide.
        let text =
            std::str::from_utf8(&self.bytes[start..self.pos]).map_err(|_| "invalid number")?;
        Ok(Value::Number(text.to_string()))
    }

    fn hex4(&mut self) -> Result<u32, &'static str> {
        let digits = self
            .bytes
            .get(self.pos..self.pos + 4)
            .ok_or("invalid escape")?;
        let mut n = 0u32;
        for &d in digits {
            n = n * 16 + char::from(d).to_digit(16).ok_or("invalid escape")?;
        }
        self.pos += 4;
        Ok(n)
    }

    fn string(&mut self) -> Result<String, &'static str> {
        self.pos += 1; // guillemet ouvrant
        let mut out = String::new();
        loop {
            let start = self.pos;
            while let Some(b) = self.peek() {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.pos += 1;
            }
            // Le texte d'entrée est une &str : toute tranche entre deux
            // octets ASCII est de l'UTF-8 valide.
            out.push_str(
                std::str::from_utf8(&self.bytes[start..self.pos]).map_err(|_| "invalid string")?,
            );
            match self.peek().ok_or("unterminated string")? {
                b'"' => {
                    self.pos += 1;
                    return Ok(out);
                }
                b'\\' => {
                    self.pos += 1;
                    let escape = self.peek().ok_or("invalid escape")?;
                    self.pos += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let first = self.hex4()?;
                            let code = if (0xd800..0xdc00).contains(&first) {
                                if self.bytes.get(self.pos..self.pos + 2) != Some(b"\\u") {
                                    return Err("lone surrogate");
                                }
                                self.pos += 2;
                                let second = self.hex4()?;
                                if !(0xdc00..0xe000).contains(&second) {
                                    return Err("lone surrogate");
                                }
                                0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00)
                            } else if (0xdc00..0xe000).contains(&first) {
                                return Err("lone surrogate");
                            } else {
                                first
                            };
                            out.push(char::from_u32(code).ok_or("invalid escape")?);
                        }
                        _ => return Err("invalid escape"),
                    }
                }
                _ => return Err("control character in string"),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Value, &'static str> {
        self.pos += 1;
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Value::Arr(items));
        }
        loop {
            self.skip_ws();
            items.push(self.value(depth + 1)?);
            self.skip_ws();
            match self.peek().ok_or("unexpected end")? {
                b',' => self.pos += 1,
                b']' => {
                    self.pos += 1;
                    return Ok(Value::Arr(items));
                }
                _ => return Err("expected , or ]"),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value, &'static str> {
        self.pos += 1;
        let mut fields: Vec<(String, Value)> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Value::Obj(fields));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err("expected a key");
            }
            let key = self.string()?;
            if fields.iter().any(|(k, _)| *k == key) {
                return Err("duplicate key");
            }
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err("expected :");
            }
            self.pos += 1;
            self.skip_ws();
            let value = self.value(depth + 1)?;
            fields.push((key, value));
            self.skip_ws();
            match self.peek().ok_or("unexpected end")? {
                b',' => self.pos += 1,
                b'}' => {
                    self.pos += 1;
                    return Ok(Value::Obj(fields));
                }
                _ => return Err("expected , or }"),
            }
        }
    }
}

#[cfg(test)]
mod read_tests {
    use super::{Json, Value, parse};

    #[test]
    fn documents_valides() {
        let v = parse(r#" {"type":"resize","cols":120,"rows":40,"x":[true,false,null,-1.5e3]} "#)
            .expect("valid");
        assert_eq!(v.get("type").and_then(Value::as_str), Some("resize"));
        assert_eq!(v.get("cols").and_then(Value::as_u64), Some(120));
        assert_eq!(
            v.get("x"),
            Some(&Value::Arr(vec![
                Value::Bool(true),
                Value::Bool(false),
                Value::Null,
                Value::Number("-1.5e3".into())
            ]))
        );
        assert_eq!(v.get("absent"), None);
    }

    #[test]
    fn echappements_et_unicode() {
        let v = parse(r#""a\"b\\c\/d\b\f\n\r\t\u00e9\ud83d\ude00é""#).expect("valid");
        assert_eq!(v.as_str(), Some("a\"b\\c/d\u{8}\u{c}\n\r\té😀é"));
        // Aller-retour avec l'encodeur.
        let original = "q\"\\\n\u{1}\u{2028}😀";
        assert_eq!(
            parse(&Json::Str(original.into()).to_line()).expect("roundtrip"),
            Value::Str(original.into())
        );
    }

    #[test]
    fn entiers_stricts() {
        for (text, expected) in [
            ("0", Some(0)),
            ("42", Some(42)),
            ("-1", None),
            ("1.0", None),
            ("1e2", None),
        ] {
            assert_eq!(parse(text).expect("valid").as_u64(), expected, "{text}");
        }
        assert_eq!(
            parse("99999999999999999999999").expect("valid").as_u64(),
            None
        );
    }

    #[test]
    fn refus() {
        for bad in [
            "",
            "{",
            "{\"a\":1,}",
            "[1,]",
            "{\"a\":1}x",
            "01",
            "1.",
            "-",
            "\"\\x\"",
            "\"a\nb\"",
            "\"\\ud83d\"",
            "\"\\ude00\"",
            "{\"a\":1,\"a\":2}",
            "{a:1}",
            "nul",
            "tru",
        ] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
        let deep = format!("{}{}", "[".repeat(40), "]".repeat(40));
        assert_eq!(parse(&deep), Err("nesting too deep"));
    }
}

#[cfg(test)]
mod tests {
    use super::Json;

    #[test]
    fn scalaires_et_conteneurs() {
        let value = Json::Obj(vec![
            ("a", Json::Null),
            ("b", Json::Bool(true)),
            ("c", Json::Int(-4058)),
            ("d", Json::UInt(u64::MAX)),
            ("e", Json::Arr(vec![Json::UInt(1), Json::Str("x".into())])),
            ("f", Json::Obj(vec![])),
        ]);
        assert_eq!(
            value.to_line(),
            r#"{"a":null,"b":true,"c":-4058,"d":18446744073709551615,"e":[1,"x"],"f":{}}"#
        );
    }

    #[test]
    fn echappements() {
        let s = Json::Str("q\"b\\n\nr\rt\tz\u{1}\u{7f}\u{2028}é😀".into());
        assert_eq!(s.to_line(), r#""q\"b\\n\nr\rt\tz\u0001\u007f\u2028é😀""#);
    }

    #[test]
    fn options() {
        assert_eq!(Json::from(None::<u64>), Json::Null);
        assert_eq!(Json::from(Some(7u32)), Json::UInt(7));
        assert_eq!(Json::from(Some("x".to_string())), Json::Str("x".into()));
    }
}
