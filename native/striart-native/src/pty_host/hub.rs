//! Multiplexage des clients d'attache : diffusion de la sortie du pty à
//! tous, rejeu pour un client qui arrive, contre-pression par client.
//!
//! Chaque client a sa file d'envoi et son thread d'écriture : un client lent
//! ne ralentit jamais les autres ni la lecture du pty. Au-delà de
//! `queue_limit` octets en attente, le client est **évincé explicitement** :
//! sa file est vidée, une frame `evicted` lui est envoyée, puis la connexion
//! est fermée. Il se reconnecte et reçoit l'état courant par le rejeu — au
//! lieu de faire grossir la mémoire de l'hôte sans borne, ou de bloquer la
//! diffusion. Un client évincé qui ne lit même plus sa frame `evicted` est
//! coupé de force après `EVICTION_FORCE_CLOSE`.
//!
//! Ordre garanti : l'arrivée d'un client (hello + rejeu) et la diffusion de
//! la sortie se font sous le même verrou — aucune sortie ne peut s'intercaler
//! entre le rejeu et le direct, donc ni trou ni doublon.

use super::frames;
use super::replay::ReplayBuffer;
use crate::sys::ipc::Conn;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// Délai laissé à un client évincé pour lire sa frame `evicted` (un
/// panneau momentanément gelé, un terminal suspendu par Ctrl+S). Au-delà, la
/// connexion est coupée de force : sa file est déjà vidée, il ne retient plus
/// qu'un thread et un handle.
pub const EVICTION_FORCE_CLOSE: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueueState {
    Open,
    /// Trop lent : plus rien n'est ajouté ; la frame `evicted` part puis la
    /// connexion se ferme.
    Evicted(Instant),
    /// Fin de session : la file se vide puis la connexion se ferme.
    Draining,
    /// Connexion terminée.
    Closed,
}

#[derive(Debug)]
struct Queue {
    frames: VecDeque<Arc<[u8]>>,
    bytes: usize,
    state: QueueState,
}

#[derive(Debug)]
pub struct Client {
    pub id: u64,
    pub conn: Arc<Conn>,
    queue: Mutex<Queue>,
    ready: Condvar,
}

impl Client {
    /// Ajoute une frame ; rend `true` si le client vient d'être évincé.
    fn push(&self, frame: Arc<[u8]>, limit: Option<usize>) -> bool {
        let Ok(mut queue) = self.queue.lock() else {
            return false;
        };
        if queue.state != QueueState::Open {
            return false;
        }
        let mut evicted_now = false;
        if limit.is_some_and(|limit| queue.bytes + frame.len() > limit) {
            queue.frames.clear();
            let evicted: Arc<[u8]> = frames::evicted("slow-client").into();
            queue.bytes = evicted.len();
            queue.frames.push_back(evicted);
            queue.state = QueueState::Evicted(Instant::now());
            evicted_now = true;
        } else {
            queue.bytes += frame.len();
            queue.frames.push_back(frame);
        }
        self.ready.notify_all();
        evicted_now
    }

    fn set_state(&self, state: QueueState) {
        if let Ok(mut queue) = self.queue.lock() {
            if queue.state != QueueState::Closed {
                queue.state = state;
            }
            self.ready.notify_all();
        }
    }

    /// Fin de la connexion (lecture terminée ou erreur) : le thread
    /// d'écriture s'arrête sans vider la file.
    pub fn closed(&self) {
        self.set_state(QueueState::Closed);
        self.conn.shutdown();
    }

    /// Boucle du thread d'écriture du client.
    pub fn write_loop(&self) {
        loop {
            let frame = {
                let Ok(mut queue) = self.queue.lock() else {
                    break;
                };
                loop {
                    if queue.state == QueueState::Closed {
                        break None;
                    }
                    if let Some(frame) = queue.frames.pop_front() {
                        queue.bytes -= frame.len();
                        break Some(frame);
                    }
                    if queue.state != QueueState::Open {
                        // Évincé ou en fin de session, file vide : terminé.
                        break None;
                    }
                    queue = match self.ready.wait(queue) {
                        Ok(q) => q,
                        Err(_) => return,
                    };
                }
            };
            let Some(frame) = frame else {
                break;
            };
            if self.conn.write_all(&frame).is_err() {
                break;
            }
        }
        self.set_state(QueueState::Closed);
        self.conn.shutdown();
    }

    fn eviction_overdue(&self, now: Instant) -> bool {
        self.queue
            .lock()
            .map(|q| matches!(q.state, QueueState::Evicted(since) if now.duration_since(since) > EVICTION_FORCE_CLOSE))
            .unwrap_or(false)
    }

    fn is_closed(&self) -> bool {
        self.queue
            .lock()
            .map(|q| q.state == QueueState::Closed)
            .unwrap_or(true)
    }
}

#[derive(Debug)]
struct State {
    clients: Vec<Arc<Client>>,
    replay: ReplayBuffer,
    cols: u16,
    rows: u16,
    accepting: bool,
}

#[derive(Debug)]
pub struct Hub {
    agent: String,
    queue_limit: usize,
    state: Mutex<State>,
    /// Sérialise les redimensionnements (changement du pty PUIS mémorisation
    /// de la taille) sans tenir `state` pendant l'appel système : la sortie
    /// du pty continue de se diffuser pendant un `ResizePseudoConsole`.
    resize_lock: Mutex<()>,
    next_id: AtomicU64,
}

impl Hub {
    pub fn new(agent: &str, cols: u16, rows: u16, replay_bytes: usize, queue_limit: usize) -> Self {
        // Défense en profondeur : la file doit toujours accueillir le rejeu
        // et deux frames de sortie (la CLI valide, ceci garantit l'invariant
        // pour tout autre appelant).
        let floor = usize::try_from(super::min_client_queue_bytes(replay_bytes as u64))
            .unwrap_or(usize::MAX);
        let queue_limit = queue_limit.max(floor);
        Self {
            agent: agent.to_string(),
            queue_limit,
            state: Mutex::new(State {
                clients: Vec::new(),
                replay: ReplayBuffer::new(replay_bytes),
                cols,
                rows,
                accepting: true,
            }),
            resize_lock: Mutex::new(()),
            next_id: AtomicU64::new(1),
        }
    }

    /// Inscrit un client : hello + rejeu dans sa file, puis le direct. `None`
    /// si la session se termine (le client est refusé).
    pub fn attach(&self, conn: Arc<Conn>) -> Option<Arc<Client>> {
        let mut state = self.state.lock().ok()?;
        if !state.accepting {
            return None;
        }
        let client = Arc::new(Client {
            id: self.next_id.fetch_add(1, Ordering::SeqCst),
            conn,
            queue: Mutex::new(Queue {
                frames: VecDeque::new(),
                bytes: 0,
                state: QueueState::Open,
            }),
            ready: Condvar::new(),
        });
        client.push(
            frames::hello(&self.agent, state.cols, state.rows).into(),
            None,
        );
        if !state.replay.is_empty() {
            client.push(frames::data(&state.replay.snapshot()).into(), None);
        }
        state.clients.push(Arc::clone(&client));
        Some(client)
    }

    /// Sortie du pty : rejeu + diffusion. Rend les clients évincés par cette
    /// diffusion (journalisés par l'appelant, hors verrou).
    pub fn output(&self, bytes: &[u8]) -> Vec<u64> {
        let mut evicted = Vec::new();
        if bytes.is_empty() {
            return evicted;
        }
        let Ok(mut state) = self.state.lock() else {
            return evicted;
        };
        state.replay.push(bytes);
        let frame: Arc<[u8]> = frames::data(bytes).into();
        for client in &state.clients {
            if client.push(Arc::clone(&frame), Some(self.queue_limit)) {
                evicted.push(client.id);
            }
        }
        evicted
    }

    /// Redimensionnement atomique : `apply` change la taille du pty ; si elle
    /// réussit, la taille est mémorisée et diffusée. Deux clients qui
    /// redimensionnent en même temps ne peuvent pas laisser le pty à une
    /// taille et le hub (hello des suivants) à une autre.
    pub fn resize_with(&self, cols: u16, rows: u16, apply: impl FnOnce() -> bool) {
        let Ok(_serial) = self.resize_lock.lock() else {
            return;
        };
        if apply() {
            self.resized(cols, rows);
        }
    }

    /// Redimensionnement accepté : mémorisé (hello des suivants) et diffusé à
    /// tous, l'émetteur compris (idempotent pour lui).
    pub fn resized(&self, cols: u16, rows: u16) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.cols = cols;
        state.rows = rows;
        let frame: Arc<[u8]> = frames::resize(cols, rows).into();
        for client in &state.clients {
            let _ = client.push(Arc::clone(&frame), Some(self.queue_limit));
        }
    }

    /// Fin de session : plus aucun client accepté, frame `exit` à tous, puis
    /// chaque file se vide et sa connexion se ferme.
    pub fn finish(&self, code: Option<i64>, signal: Option<i32>) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.accepting = false;
        let frame: Arc<[u8]> = frames::exit(code, signal).into();
        for client in &state.clients {
            // Sans limite : la frame de fin doit partir, même derrière une
            // file chargée (la session se termine, la mémoire est bornée par
            // la limite déjà appliquée au direct).
            let _ = client.push(Arc::clone(&frame), None);
            client.set_state(QueueState::Draining);
        }
    }

    /// Taille (colonnes, lignes) mémorisée — celle du `hello` des suivants.
    pub fn size(&self) -> (u16, u16) {
        self.state
            .lock()
            .map_or((0, 0), |state| (state.cols, state.rows))
    }

    pub fn queue_limit(&self) -> usize {
        self.queue_limit
    }

    /// Retire les clients terminés ; coupe de force les évincés qui ne lisent
    /// plus. Rend le nombre de clients encore connectés.
    pub fn sweep(&self) -> usize {
        let Ok(mut state) = self.state.lock() else {
            return 0;
        };
        let now = Instant::now();
        for client in &state.clients {
            if client.eviction_overdue(now) {
                client.closed();
            }
        }
        state.clients.retain(|c| !c.is_closed());
        state.clients.len()
    }

    /// Clients encore connectés (fin de session : attente bornée).
    pub fn connected(&self) -> usize {
        self.sweep()
    }

    /// Coupe toutes les connexions restantes.
    pub fn close_all(&self) {
        if let Ok(state) = self.state.lock() {
            for client in &state.clients {
                client.closed();
            }
        }
    }
}
