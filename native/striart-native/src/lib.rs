//! `striart-native` : composants natifs de Striart, servis au paquet npm par
//! un protocole argv → JSON (voir `protocol`).
//!
//! Organisation :
//! - `cli` : analyse stricte de argv, aiguillage par domaine de commandes ;
//! - `proc_info`, `tree_kill`, `job`, `pty_host` : une commande par module,
//!   sans appel système direct ;
//! - `sys` : la seule couche qui parle à l'OS (Windows / Linux / macOS) —
//!   process, Job Objects, pseudo-terminaux, canal d'attache local ;
//! - `json`, `base64`, `protocol` : encodages et contrat de sortie.

pub mod base64;
pub mod cli;
pub mod job;
pub mod json;
pub mod proc_info;
pub mod protocol;
pub mod pty_host;
pub mod sys;
pub mod tree_kill;
