//! `proc tree-kill --pid <n> [--root-started-ms <ms>]` : tue l'arbre entier.
//!
//! Énumération des descendants depuis un instantané complet de l'OS, puis
//! kill de haut en bas (un parent tué ne peut plus engendrer), en plusieurs
//! passes jusqu'à ce qu'aucun descendant ne reste.
//!
//! Lien parent → enfant (`select`) :
//! - un enfant est rattaché à un membre de l'arbre par son PID parent ET par
//!   l'ordre des créations (enfant créé après le parent). Sous Windows, un
//!   parent mort n'est jamais remplacé : sans cet ordre, le numéro d'un parent
//!   mort repris par un process étranger rattacherait les enfants de
//!   l'étranger — ou, à l'inverse, un vieux process dont le parent défunt
//!   portait notre numéro (cas d'explorer.exe) serait tué ;
//! - racine déjà morte : ses enfants sont retrouvés si l'appelant donne son
//!   heure de création (`--root-started-ms`) ; sans elle, sous Windows,
//!   aucun lien vers un parent mort n'est sûr et l'on s'abstient (sous POSIX
//!   le noyau reparente les orphelins : le groupe de process les retrouve) ;
//! - POSIX : les membres du groupe ou de la session dont la racine est chef
//!   sont rattachés aussi — un petit-fils dont le parent est mort reste dans
//!   le groupe (le noyau ne réattribue pas un PID tant que son groupe existe).
//!
//! Le process courant n'est jamais visé.

use crate::json::Json;
use crate::protocol::NativeError;
use crate::sys::{self, Entry, KillOutcome, START_TIME_TOLERANCE_MS, same_start_time};

/// Passes maximales : un arbre qui engendre plus vite qu'on ne tue (fork
/// bomb) ne fait pas tourner la commande sans fin.
const MAX_ROUNDS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootState {
    /// Vivant, et c'est bien le process attendu.
    Alive,
    /// Plus aucun process sous ce numéro.
    Dead,
    /// Le numéro appartient à un autre process (recyclé), ou son identité est
    /// illisible : la racine n'est pas tuée.
    Foreign,
}

impl RootState {
    fn as_str(self) -> &'static str {
        match self {
            RootState::Alive => "alive",
            RootState::Dead => "dead",
            RootState::Foreign => "foreign",
        }
    }
}

/// Parent connu hors de l'instantané courant : membre tué lors d'une passe
/// précédente (Windows ne reparente pas ses enfants), ou — pour `job run` —
/// le process courant, sous lequel le noyau reparente les orphelins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Member {
    pub pid: u32,
    pub start_ms: Option<u64>,
}

/// Nœud parent candidat : `pid`, créé à `start_ms`, et — si son numéro est
/// désormais repris — l'heure de création du repreneur (`reused_at`) : un
/// enfant créé après elle appartient au repreneur.
#[derive(Debug, Clone, Copy)]
struct Parent {
    pid: u32,
    start_ms: Option<u64>,
    reused_at: Option<u64>,
}

pub fn classify_root(table: &[Entry], root: u32, expected: Option<u64>) -> RootState {
    match table.iter().find(|e| e.pid == root && !e.zombie) {
        None => RootState::Dead,
        Some(entry) => match (expected, entry.start_ms) {
            (None, _) => RootState::Alive,
            (Some(want), Some(actual)) if same_start_time(actual, want) => RootState::Alive,
            _ => RootState::Foreign,
        },
    }
}

fn is_child_of(entry: &Entry, parent: &Parent) -> bool {
    if entry.ppid != Some(parent.pid) {
        return false;
    }
    let Some(child_start) = entry.start_ms else {
        return false; // ordre invérifiable : on ne rattache pas
    };
    if parent.start_ms.is_some_and(|p| child_start < p) {
        return false;
    }
    !parent.reused_at.is_some_and(|r| child_start >= r)
}

/// Sélection pure (testable sans OS) des process à tuer, dans l'ordre parent
/// avant enfant. `self_pid` n'est jamais sélectionné.
pub fn select(
    table: &[Entry],
    root: u32,
    expected: Option<u64>,
    known_parents: &[Member],
    self_pid: u32,
    use_groups: bool,
) -> (RootState, Vec<Entry>) {
    let state = classify_root(table, root, expected);
    let root_entry = table.iter().find(|e| e.pid == root && !e.zombie);
    let live_start = |pid: u32| {
        table
            .iter()
            .find(|e| e.pid == pid && !e.zombie)
            .and_then(|e| e.start_ms)
    };

    let mut parents: Vec<Parent> = Vec::new();
    let mut selected: Vec<Entry> = Vec::new();
    let take = |entry: &Entry, selected: &mut Vec<Entry>, parents: &mut Vec<Parent>| {
        if entry.pid == self_pid || entry.pid <= 1 || entry.zombie {
            return;
        }
        if selected.iter().any(|s| s.pid == entry.pid) {
            return;
        }
        selected.push(entry.clone());
        parents.push(Parent {
            pid: entry.pid,
            start_ms: entry.start_ms,
            reused_at: None,
        });
    };

    match state {
        RootState::Alive => {
            if let Some(entry) = root_entry {
                take(entry, &mut selected, &mut parents);
            }
        }
        RootState::Dead | RootState::Foreign => {
            // Racine absente ou reprise : ses enfants ne se rattachent que si
            // son heure de création est connue.
            if let Some(start) = expected {
                parents.push(Parent {
                    pid: root,
                    start_ms: Some(start.saturating_sub(START_TIME_TOLERANCE_MS)),
                    reused_at: root_entry.and_then(|e| e.start_ms),
                });
            }
        }
    }
    for member in known_parents {
        let current = live_start(member.pid);
        parents.push(Parent {
            pid: member.pid,
            start_ms: member.start_ms,
            reused_at: current.filter(|c| Some(*c) != member.start_ms),
        });
    }

    if use_groups && state != RootState::Foreign {
        let floor = match state {
            RootState::Alive => root_entry.and_then(|e| e.start_ms),
            _ => expected.map(|s| s.saturating_sub(START_TIME_TOLERANCE_MS)),
        };
        for entry in table {
            let in_group = entry.pgid == Some(root) || entry.sid == Some(root);
            let after_root = match (floor, entry.start_ms) {
                (Some(f), Some(s)) => s >= f,
                (Some(_), None) => false,
                (None, _) => true,
            };
            if in_group && after_root {
                take(entry, &mut selected, &mut parents);
            }
        }
    }

    // Point fixe : descendants des membres retenus.
    let mut cursor = 0;
    while cursor < parents.len() {
        let parent = parents[cursor];
        cursor += 1;
        for entry in table {
            if is_child_of(entry, &parent) {
                take(entry, &mut selected, &mut parents);
            }
        }
    }
    (state, selected)
}

/// Résultat d'un balayage : ce qui a été tué, ce qui a refusé de mourir et ce
/// qui vit encore à la fin. `survivors` vide ⇔ l'arbre est éteint, aux yeux
/// d'une dernière lecture de la table des process.
#[derive(Debug, Clone)]
pub struct Sweep {
    pub root_state: RootState,
    pub killed: Vec<Member>,
    pub failed: Vec<(u32, String)>,
    pub survivors: Vec<Entry>,
    pub rounds: usize,
}

impl Sweep {
    pub fn complete(&self) -> bool {
        self.survivors.is_empty()
    }
}

/// Tue l'arbre de `root` par passes successives, puis relit la table pour
/// établir ce qui survit. `extra_parents` : parents connus hors instantané
/// (voir `Member`).
pub fn sweep(
    root: u32,
    expected: Option<u64>,
    extra_parents: &[Member],
    self_pid: u32,
) -> Result<Sweep, NativeError> {
    let mut killed: Vec<Member> = Vec::new();
    let mut failed: Vec<(u32, String)> = Vec::new();
    let mut first_state = None;
    let mut rounds = 0;
    let mut anchor = expected;
    for _ in 0..MAX_ROUNDS {
        let table = sys::snapshot()?;
        let parents: Vec<Member> = extra_parents.iter().chain(killed.iter()).copied().collect();
        let (state, selected) = select(
            &table,
            root,
            anchor,
            &parents,
            self_pid,
            sys::USES_PROCESS_GROUPS,
        );
        if first_state.is_none() {
            first_state = Some(state);
            if state == RootState::Alive && anchor.is_none() {
                // Les passes suivantes verront la racine morte : son heure de
                // création garde ses enfants rattachables.
                anchor = selected.first().and_then(|e| e.start_ms);
            }
        }
        let fresh: Vec<Entry> = selected
            .into_iter()
            .filter(|e| {
                !killed
                    .iter()
                    .any(|k| k.pid == e.pid && k.start_ms == e.start_ms)
                    && !failed.iter().any(|(pid, _)| *pid == e.pid)
            })
            .collect();
        if fresh.is_empty() {
            break;
        }
        rounds += 1;
        freeze(&fresh);
        for entry in &fresh {
            match sys::kill_verified(entry.pid, entry.start_ms) {
                KillOutcome::Killed => killed.push(Member {
                    pid: entry.pid,
                    start_ms: entry.start_ms,
                }),
                KillOutcome::Gone | KillOutcome::Mismatch => {}
                KillOutcome::Failed(reason) => failed.push((entry.pid, reason)),
            }
        }
    }
    // Dernière lecture : ce qui est encore sélectionné (hors zombies, que
    // `select` écarte) a survécu — refus de l'OS, mort non constatée, ou
    // arbre plus rapide que nos passes.
    let table = sys::snapshot()?;
    let parents: Vec<Member> = extra_parents.iter().chain(killed.iter()).copied().collect();
    let (final_state, survivors) = select(
        &table,
        root,
        anchor,
        &parents,
        self_pid,
        sys::USES_PROCESS_GROUPS,
    );
    // Une racine « étrangère » (PID recyclé) n'est jamais un survivant : on
    // ne la touche pas, et `select` ne la retient pas non plus.
    let _ = final_state;
    Ok(Sweep {
        root_state: first_state.unwrap_or(RootState::Dead),
        killed,
        failed,
        survivors,
        rounds,
    })
}

pub fn run(root: u32, expected: Option<u64>) -> Result<Json, NativeError> {
    let swept = sweep(root, expected, &[], std::process::id())?;
    let pid_entry = |pid: u32, start_ms: Option<u64>| {
        Json::Obj(vec![
            ("pid", Json::UInt(u64::from(pid))),
            ("startTimeMs", Json::from(start_ms)),
        ])
    };
    Ok(Json::Obj(vec![
        ("root", Json::UInt(u64::from(root))),
        ("rootState", Json::Str(swept.root_state.as_str().into())),
        (
            "killed",
            Json::Arr(
                swept
                    .killed
                    .iter()
                    .map(|k| pid_entry(k.pid, k.start_ms))
                    .collect(),
            ),
        ),
        (
            "failed",
            Json::Arr(
                swept
                    .failed
                    .iter()
                    .map(|(pid, reason)| {
                        Json::Obj(vec![
                            ("pid", Json::UInt(u64::from(*pid))),
                            ("reason", Json::Str(reason.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "survivors",
            Json::Arr(
                swept
                    .survivors
                    .iter()
                    .map(|e| pid_entry(e.pid, e.start_ms))
                    .collect(),
            ),
        ),
        ("complete", Json::Bool(swept.complete())),
        ("rounds", Json::UInt(swept.rounds as u64)),
    ]))
}

/// POSIX : SIGSTOP sur toute la sélection avant le premier SIGKILL — un
/// membre gelé ne peut plus engendrer pendant qu'on tue les autres.
#[cfg(unix)]
fn freeze(entries: &[Entry]) {
    for entry in entries {
        sys::unix::stop_verified(entry.pid, entry.start_ms);
    }
}

#[cfg(windows)]
fn freeze(_entries: &[Entry]) {
    // Pas d'équivalent sûr sans Job Object : le kill de haut en bas et les
    // passes successives rattrapent ce qui naîtrait entre-temps.
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(pid: u32, ppid: u32, start: u64) -> Entry {
        Entry {
            pid,
            ppid: Some(ppid),
            start_ms: Some(start),
            pgid: None,
            sid: None,
            zombie: false,
        }
    }

    fn pids(selected: &[Entry]) -> Vec<u32> {
        selected.iter().map(|e| e.pid).collect()
    }

    #[test]
    fn racine_vivante_descendants_dans_l_ordre() {
        let table = [e(10, 1, 100), e(11, 10, 110), e(12, 11, 120), e(13, 1, 130)];
        let (state, selected) = select(&table, 10, None, &[], 999, false);
        assert_eq!(state, RootState::Alive);
        assert_eq!(pids(&selected), vec![10, 11, 12]);
    }

    #[test]
    fn enfant_plus_vieux_que_le_parent_jamais_rattache() {
        // explorer.exe (20) a pour ppid un userinit défunt dont le numéro (10)
        // est repris par notre racine, plus récente.
        let table = [e(10, 1, 500), e(20, 10, 100), e(21, 10, 600)];
        let (_, selected) = select(&table, 10, None, &[], 999, false);
        assert_eq!(pids(&selected), vec![10, 21]);
    }

    #[test]
    fn racine_morte_sans_heure_on_s_abstient() {
        let table = [e(11, 10, 110)];
        let (state, selected) = select(&table, 10, None, &[], 999, false);
        assert_eq!(state, RootState::Dead);
        assert!(selected.is_empty());
    }

    #[test]
    fn racine_morte_avec_heure_enfants_et_petits_enfants() {
        let table = [e(11, 10, 110), e(12, 11, 120), e(30, 10, 10)];
        let (state, selected) = select(&table, 10, Some(100), &[], 999, false);
        assert_eq!(state, RootState::Dead);
        assert_eq!(pids(&selected), vec![11, 12]);
    }

    #[test]
    fn racine_reprise_par_un_etranger() {
        // Notre racine (créée à 100) est morte ; le numéro 10 est repris à
        // 300 par un étranger. 11 est à nous, 12 est l'enfant de l'étranger.
        let table = [e(10, 1, 300), e(11, 10, 110), e(12, 10, 310)];
        let (state, selected) = select(&table, 10, Some(100), &[], 999, false);
        assert_eq!(state, RootState::Foreign);
        assert_eq!(pids(&selected), vec![11]);
    }

    #[test]
    fn membre_deja_tue_reste_parent() {
        // Passe 2 sous Windows : 11 (tué) n'est plus dans la table, son
        // enfant 12 garde ppid = 11.
        let table = [e(12, 11, 120)];
        let killed = [Member {
            pid: 11,
            start_ms: Some(110),
        }];
        let (_, selected) = select(&table, 10, Some(100), &killed, 999, false);
        assert_eq!(pids(&selected), vec![12]);
    }

    #[test]
    fn membre_tue_dont_le_numero_est_repris() {
        let table = [e(11, 1, 400), e(12, 11, 120), e(13, 11, 410)];
        let killed = [Member {
            pid: 11,
            start_ms: Some(110),
        }];
        let (_, selected) = select(&table, 10, Some(100), &killed, 999, false);
        assert_eq!(pids(&selected), vec![12]);
    }

    #[test]
    fn groupe_posix_retrouve_l_orphelin() {
        // 12 : petit-fils dont le parent (11) est mort, reparenté à init (1),
        // resté dans le groupe 10.
        let mut orphan = e(12, 1, 120);
        orphan.pgid = Some(10);
        let mut root = e(10, 1, 100);
        root.pgid = Some(10);
        let table = [root, orphan];
        let (_, selected) = select(&table, 10, None, &[], 999, true);
        assert_eq!(pids(&selected), vec![10, 12]);
        // Sans les groupes (Windows), l'orphelin est hors d'atteinte.
        let (_, selected) = select(&table, 10, None, &[], 999, false);
        assert_eq!(pids(&selected), vec![10]);
    }

    #[test]
    fn groupe_ignore_quand_la_racine_est_etrangere() {
        let mut member = e(12, 1, 120);
        member.pgid = Some(10);
        let table = [e(10, 1, 300), member];
        let (state, selected) = select(&table, 10, Some(100), &[], 999, true);
        assert_eq!(state, RootState::Foreign);
        assert!(selected.is_empty());
    }

    #[test]
    fn jamais_soi_meme_ni_init_ni_zombie() {
        let mut zombie = e(13, 10, 130);
        zombie.zombie = true;
        let table = [e(10, 1, 100), e(999, 10, 110), e(14, 999, 140), zombie];
        let (_, selected) = select(&table, 10, None, &[], 999, false);
        assert_eq!(pids(&selected), vec![10]);
        let (_, selected) = select(&[e(1, 0, 0)], 1, None, &[], 999, false);
        assert!(selected.is_empty());
    }

    #[test]
    fn heure_illisible_jamais_rattachee() {
        let mut unknown = e(11, 10, 0);
        unknown.start_ms = None;
        let table = [e(10, 1, 100), unknown];
        let (_, selected) = select(&table, 10, None, &[], 999, false);
        assert_eq!(pids(&selected), vec![10]);
    }
}
