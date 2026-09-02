/**
 * Faux agent ACP (Agent Client Protocol) pour les tests du transport ACP.
 *
 * Parle le sous-ensemble v1 que le client de Striart utilise : initialize,
 * session/new, session/prompt, notifications session/update, et selon le
 * mode, session/request_permission et fs/read+write vers le client.
 *
 * En .cjs comme fake-agent.cjs : exécuté depuis un clone temporaire sans
 * package.json, aucune ambiguïté ESM/CJS.
 *
 * Comportement piloté par FAKE_ACP_MODE :
 *  - commit (défaut) : stream des updates, commite via git, end_turn.
 *  - message         : stream des updates SANS commit, end_turn (pas de git —
 *                      utilisable côté unit).
 *  - refusal         : répond au prompt par stopReason 'refusal'.
 *  - hang            : ne répond jamais au prompt (test du délai) ; honore
 *                      session/cancel par stopReason 'cancelled'.
 *  - permission      : demande une permission AVANT d'agir — accordée →
 *                      comme 'message' ; refusée → 'refusal'.
 *  - fs              : écrit puis relit un fichier VIA LE CLIENT (fs/write +
 *                      fs/read), end_turn si accordé.
 *  - fs-escape       : tente d'écrire HORS du clone via le client ; end_turn
 *                      si (et seulement si) le client a refusé par erreur.
 *  - badversion      : répond au handshake avec protocolVersion 99.
 */
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const mode = process.env.FAKE_ACP_MODE || 'commit';
let nextId = 1000;
const pending = new Map();

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
const update = (sessionId, u) =>
  send({ method: 'session/update', params: { sessionId, update: u } });

let promptId = null;
let sessionId = null;

async function handlePrompt(id, params) {
  promptId = id;
  sessionId = params.sessionId;
  const promptText = (params.prompt ?? []).map((b) => b.text ?? '').join(' ');

  if (mode === 'refusal') {
    send({ id, result: { stopReason: 'refusal' } });
    return;
  }
  if (mode === 'hang') return; // session/cancel répondra.

  update(sessionId, {
    sessionUpdate: 'plan',
    entries: [{ content: 'faire le travail', priority: 'high', status: 'pending' }],
  });
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: `travail sur : ${promptText}` },
  });

  if (mode === 'permission') {
    const res = await request('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'tc-1', title: 'Modifier feature.js' },
      options: [
        { optionId: 'ok', name: 'Autoriser', kind: 'allow_once' },
        { optionId: 'no', name: 'Refuser', kind: 'reject_once' },
      ],
    });
    if (res?.outcome?.outcome !== 'selected' || res.outcome.optionId !== 'ok') {
      send({ id, result: { stopReason: 'refusal' } });
      return;
    }
  }

  if (mode === 'fs') {
    await request('fs/write_text_file', {
      sessionId,
      path: path.join(process.cwd(), 'via-client.txt'),
      content: 'écrit via le client ACP',
    });
    const read = await request('fs/read_text_file', {
      sessionId,
      path: path.join(process.cwd(), 'via-client.txt'),
    });
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `relu : ${read.content}` },
    });
  }

  if (mode === 'fs-escape') {
    // Chemin volontairement HORS du clone : le client DOIT répondre par une
    // erreur JSON-RPC. end_turn seulement si le refus a bien eu lieu.
    try {
      await request('fs/write_text_file', {
        sessionId,
        path: path.join(process.cwd(), '..', '..', 'evasion.txt'),
        content: 'ne doit jamais exister',
      });
      send({ id, result: { stopReason: 'refusal' } }); // écriture passée : échec du test
      return;
    } catch {
      // Refus attendu — le garde-fou du client a fonctionné.
    }
  }

  if (mode === 'commit') {
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-git',
      title: 'git commit',
      kind: 'execute',
      status: 'in_progress',
    });
    writeFileSync('feature.js', `// ${promptText}\nexport const feature = 1;\n`);
    const git = (args) => execFileSync('git', args, { stdio: 'pipe' });
    git(['add', '-A']);
    git([
      '-c',
      'user.email=agent@striart.test',
      '-c',
      'user.name=Fake ACP Agent',
      'commit',
      '-m',
      'feat: travail du faux agent ACP',
    ]);
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-git',
      status: 'completed',
    });
  }

  send({ id, result: { stopReason: 'end_turn' } });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // Réponses du client à NOS requêtes (permission, fs).
  if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
    const entry = pending.get(msg.id);
    if (entry) {
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    }
    return;
  }
  if (msg.method === 'initialize') {
    send({
      id: msg.id,
      result: {
        protocolVersion: mode === 'badversion' ? 99 : 1,
        agentCapabilities: {},
        authMethods: [],
      },
    });
    return;
  }
  if (msg.method === 'session/new') {
    send({ id: msg.id, result: { sessionId: 'sess-fake-1' } });
    return;
  }
  if (msg.method === 'session/prompt') {
    void handlePrompt(msg.id, msg.params ?? {});
    return;
  }
  if (msg.method === 'session/cancel') {
    if (promptId != null) send({ id: promptId, result: { stopReason: 'cancelled' } });
    return;
  }
  if (msg.id != null) {
    send({ id: msg.id, error: { code: -32601, message: `inconnue : ${msg.method}` } });
  }
});

rl.on('close', () => process.exit(0));
