//! Base64 standard (RFC 4648 §4, alphabet `A-Z a-z 0-9 + /`, remplissage
//! `=`) — l'encodage des octets du pty dans le protocole d'attache (frames
//! `data` et `input`), identique à `Buffer.from(x).toString('base64')` de
//! Node. Le décodage est strict : caractère hors alphabet, remplissage mal
//! placé ou longueur incohérente sont refusés, jamais « réparés ».

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(char::from(ALPHABET[(n >> 18) as usize & 63]));
        out.push(char::from(ALPHABET[(n >> 12) as usize & 63]));
        out.push(if chunk.len() > 1 {
            char::from(ALPHABET[(n >> 6) as usize & 63])
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            char::from(ALPHABET[n as usize & 63])
        } else {
            '='
        });
    }
    out
}

fn value(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some(u32::from(c - b'A')),
        b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Décodage strict ; `None` pour toute entrée non canonique.
pub fn decode(input: &str) -> Option<Vec<u8>> {
    let bytes = input.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let groups = bytes.len() / 4;
    for (index, group) in bytes.chunks(4).enumerate() {
        let last = index + 1 == groups;
        let pad = group.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && !last) {
            return None;
        }
        let mut n = 0u32;
        for &c in &group[..4 - pad] {
            n = (n << 6) | value(c)?;
        }
        n <<= 6 * pad as u32;
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
        // Bits de remplissage non nuls : encodage non canonique.
        let mask = match pad {
            1 => 0xff,
            2 => 0xffff,
            _ => 0,
        };
        if n & mask != 0 {
            return None;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::{decode, encode};

    #[test]
    fn vecteurs_rfc4648() {
        for (plain, coded) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(encode(plain.as_bytes()), coded);
            assert_eq!(decode(coded).as_deref(), Some(plain.as_bytes()));
        }
    }

    #[test]
    fn octets_quelconques() {
        let all: Vec<u8> = (0..=255).collect();
        assert_eq!(decode(&encode(&all)), Some(all));
    }

    #[test]
    fn refus_stricts() {
        for bad in [
            "Zg", "Zg=", "Z===", "Zg==Zg==", "Zm9v!", "Zh==", "Zm9=", "Zm 9v",
        ] {
            assert_eq!(decode(bad), None, "{bad}");
        }
    }
}
