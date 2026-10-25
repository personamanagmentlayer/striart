//! Tampon de rejeu de l'hôte de pty : les derniers octets de sortie, envoyés
//! à un client qui s'attache APRÈS coup (sans quoi il démarrerait sur un
//! écran vide tant que l'outil hébergé ne redessine rien).
//!
//! Circulaire et borné, mais jamais coupé n'importe où : le début du tampon
//! est toujours une **frontière sûre** — hors de toute séquence d'échappement
//! (CSI, OSC, DCS, SOS/PM/APC, ESC + intermédiaires) et au début d'un
//! caractère UTF-8. Un rejeu qui commencerait au milieu de
//! `ESC [ 3 8 ; 5 ; 1 9 6 m` afficherait `8;5;196m` en clair, ou pire
//! ferait interpréter la suite comme une autre séquence ; au milieu d'un
//! caractère multi-octets, il produirait un U+FFFD (constat d'audit 3.3 sur
//! l'ancien tampon `slice(-64000)`).
//!
//! Invariant : le premier octet du tampon est lu dans l'état « sol »
//! (`Scan::Ground`). Pour retirer des octets en tête, on les fait passer
//! dans l'automate depuis cet état ; on s'arrête au premier point où
//! l'automate est revenu au sol ET où l'octet suivant n'est pas un octet de
//! continuation UTF-8. Coût : linéaire en octets retirés.

use std::collections::VecDeque;

/// États de l'automate (sous-ensemble ECMA-48 / VT500 suffisant pour
/// délimiter les séquences, sans les interpréter).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scan {
    Ground,
    Escape,
    EscapeIntermediate,
    Csi,
    /// OSC, DCS, SOS, PM, APC : chaîne terminée par ST (`ESC \`) ou BEL.
    Str,
    StrEscape,
}

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;

fn step(state: Scan, byte: u8) -> Scan {
    // CAN et SUB annulent toute séquence en cours.
    if matches!(byte, CAN | SUB) && state != Scan::Ground {
        return Scan::Ground;
    }
    match state {
        Scan::Ground => {
            if byte == ESC {
                Scan::Escape
            } else {
                Scan::Ground
            }
        }
        Scan::Escape => match byte {
            ESC => Scan::Escape,
            b'[' => Scan::Csi,
            b']' | b'P' | b'X' | b'^' | b'_' => Scan::Str,
            0x20..=0x2f => Scan::EscapeIntermediate,
            0x30..=0x7e => Scan::Ground,
            // Contrôle C0 exécuté au milieu de la séquence : elle continue.
            0x00..=0x1f => Scan::Escape,
            _ => Scan::Ground,
        },
        Scan::EscapeIntermediate => match byte {
            ESC => Scan::Escape,
            0x00..=0x2f => Scan::EscapeIntermediate,
            _ => Scan::Ground,
        },
        Scan::Csi => match byte {
            ESC => Scan::Escape,
            0x40..=0x7e => Scan::Ground,
            0x00..=0x3f => Scan::Csi,
            // Octet hors ECMA-48 (texte) : la séquence est abandonnée.
            _ => Scan::Ground,
        },
        Scan::Str => match byte {
            BEL => Scan::Ground,
            ESC => Scan::StrEscape,
            _ => Scan::Str,
        },
        Scan::StrEscape => match byte {
            b'\\' => Scan::Ground,
            // ESC suivi d'autre chose : nouvelle séquence d'échappement.
            other => step(Scan::Escape, other),
        },
    }
}

const fn is_continuation(byte: u8) -> bool {
    byte & 0xc0 == 0x80
}

/// Tampon de rejeu borné à `capacity` octets.
#[derive(Debug)]
pub struct ReplayBuffer {
    data: VecDeque<u8>,
    capacity: usize,
}

impl ReplayBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            data: VecDeque::with_capacity(capacity.min(1 << 20)),
            capacity,
        }
    }

    pub fn len(&self) -> usize {
        self.data.len()
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.data.extend(bytes);
        if self.data.len() > self.capacity {
            self.trim(self.data.len() - self.capacity);
        }
    }

    /// Retire au moins `minimum` octets en tête, puis avance jusqu'à la
    /// prochaine frontière sûre (au pire : tampon vide).
    fn trim(&mut self, minimum: usize) {
        let mut state = Scan::Ground;
        let mut dropped = 0usize;
        while let Some(&byte) = self.data.front() {
            if dropped >= minimum && state == Scan::Ground && !is_continuation(byte) {
                return;
            }
            state = step(state, byte);
            self.data.pop_front();
            dropped += 1;
        }
    }

    /// Copie du contenu, du plus ancien au plus récent.
    pub fn snapshot(&self) -> Vec<u8> {
        let (a, b) = self.data.as_slices();
        let mut out = Vec::with_capacity(a.len() + b.len());
        out.extend_from_slice(a);
        out.extend_from_slice(b);
        out
    }
}

/// Longueur du suffixe de `bytes` qui est un début de caractère UTF-8 encore
/// incomplet (0 à 3 octets) : retenu jusqu'à la lecture suivante, pour que
/// chaque frame `data` soit décodable seule. Un suffixe qui ne peut pas
/// devenir un caractère valide (octet invalide) n'est pas retenu.
pub fn incomplete_utf8_suffix_len(bytes: &[u8]) -> usize {
    let n = bytes.len();
    for back in 1..=3.min(n) {
        let byte = bytes[n - back];
        if is_continuation(byte) {
            continue;
        }
        let needed = match byte {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return 0,
        };
        return if back < needed { back } else { 0 };
    }
    0
}

#[cfg(test)]
mod tests {
    use super::{ReplayBuffer, incomplete_utf8_suffix_len};

    const UNIT: &str = "\x1b[38;5;196mé€😀\x1b[0m|\x1b]0;titre\x07\x1bP1$r\x1b\\\x1b(B";

    fn starts_safely(text: &[u8]) -> bool {
        // Début sûr = le reste d'une unité commence à une frontière que
        // l'automate aurait choisie : jamais au milieu d'une séquence.
        // Seule la FIN peut être un caractère encore incomplet (la suite
        // arrive avec la sortie suivante) ; jamais le début.
        let s = match std::str::from_utf8(text) {
            Ok(s) => s,
            Err(e) => {
                assert!(e.error_len().is_none(), "invalid UTF-8 inside the replay");
                std::str::from_utf8(&text[..e.valid_up_to()]).expect("valid prefix")
            }
        };
        let boundaries = [
            "\x1b[38;5;196m",
            "é",
            "€",
            "😀",
            "\x1b[0m",
            "|",
            "\x1b]0;",
            "\x1bP",
            "\x1b(B",
        ];
        // Un tampon plus court qu'une séquence (sa fin n'est pas encore
        // arrivée) commence lui aussi à une frontière : il en est un préfixe.
        boundaries
            .iter()
            .any(|b| s.starts_with(b) || b.starts_with(s))
    }

    #[test]
    fn borne_et_frontieres_sures_quel_que_soit_le_decoupage() {
        let unit = UNIT.as_bytes();
        for capacity in [17usize, 64, 100, 257, 1000] {
            for chunk in [1usize, 2, 3, 5, 7, 64] {
                let mut replay = ReplayBuffer::new(capacity);
                let stream: Vec<u8> = unit
                    .iter()
                    .copied()
                    .cycle()
                    .take(unit.len() * 50 + 11)
                    .collect();
                for piece in stream.chunks(chunk) {
                    replay.push(piece);
                    assert!(replay.len() <= capacity);
                    let snap = replay.snapshot();
                    if !snap.is_empty() {
                        assert!(
                            starts_safely(&snap),
                            "capacity {capacity}, chunk {chunk}: {:?}",
                            String::from_utf8_lossy(&snap[..snap.len().min(24)])
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn sous_la_capacite_rien_n_est_retire() {
        let mut replay = ReplayBuffer::new(64);
        replay.push(b"\x1b[3");
        replay.push(b"1mok");
        assert_eq!(replay.snapshot(), b"\x1b[31mok");
    }

    #[test]
    fn sequence_jamais_terminee_vide_le_tampon_plutot_que_de_le_couper() {
        let mut replay = ReplayBuffer::new(8);
        replay.push(b"\x1b]0;un titre sans fin");
        assert!(replay.is_empty());
        replay.push(b"abc");
        assert!(replay.is_empty() || replay.snapshot() == b"abc");
    }

    #[test]
    fn can_et_sub_annulent_une_sequence() {
        let mut replay = ReplayBuffer::new(6);
        replay.push(b"\x1b[12\x18abcdef");
        assert_eq!(replay.snapshot(), b"abcdef");
    }

    #[test]
    fn suffixe_utf8_incomplet() {
        assert_eq!(incomplete_utf8_suffix_len(b""), 0);
        assert_eq!(incomplete_utf8_suffix_len(b"abc"), 0);
        let euro = "€".as_bytes(); // e2 82 ac
        assert_eq!(incomplete_utf8_suffix_len(&euro[..1]), 1);
        assert_eq!(incomplete_utf8_suffix_len(&euro[..2]), 2);
        assert_eq!(incomplete_utf8_suffix_len(euro), 0);
        let smile = "😀".as_bytes(); // f0 9f 98 80
        assert_eq!(incomplete_utf8_suffix_len(&smile[..3]), 3);
        assert_eq!(incomplete_utf8_suffix_len(smile), 0);
        // Octets invalides : rien de retenu.
        assert_eq!(incomplete_utf8_suffix_len(&[b'a', 0xff]), 0);
        assert_eq!(incomplete_utf8_suffix_len(&[0x80, 0x80, 0x80]), 0);
    }
}
