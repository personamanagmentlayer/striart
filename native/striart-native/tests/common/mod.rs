//! Aides partagées des tests d'intégration.
#![allow(dead_code)]

/// Le flux est-il à l'état « sol » (hors séquence ANSI) après `prefix` ?
/// Un rejeu qui commence à cet endroit du vrai flux ne coupe aucune séquence
/// CSI ni OSC : c'est la définition positive d'une frontière sûre.
pub fn is_ground_state_after(prefix: &str) -> bool {
    #[derive(PartialEq, Clone, Copy)]
    enum State {
        Ground,
        Esc,
        Csi,
        Osc,
        OscEsc,
    }
    let mut state = State::Ground;
    for c in prefix.chars() {
        state = match (state, c) {
            (State::Ground, '\x1b') => State::Esc,
            (State::Ground, _) => State::Ground,
            (State::Esc, '[') => State::Csi,
            (State::Esc, ']') => State::Osc,
            (State::Esc, _) => State::Ground,
            (State::Csi, c) if ('\u{40}'..='\u{7e}').contains(&c) => State::Ground,
            (State::Csi, _) => State::Csi,
            (State::Osc, '\x07') => State::Ground,
            (State::Osc, '\x1b') => State::OscEsc,
            (State::Osc, _) => State::Osc,
            (State::OscEsc, '\\') => State::Ground,
            (State::OscEsc, _) => State::Osc,
        };
    }
    state == State::Ground
}

#[test]
fn machine_a_etats_ansi() {
    assert!(is_ground_state_after(""));
    assert!(is_ground_state_after("abc\x1b[31mred\x1b[0m"));
    assert!(!is_ground_state_after("abc\x1b[38;5;19"));
    assert!(!is_ground_state_after("x\x1b"));
    assert!(!is_ground_state_after("\x1b]0;titre"));
    assert!(is_ground_state_after("\x1b]0;titre\x07"));
    assert!(is_ground_state_after("\x1b]0;titre\x1b\\"));
}
