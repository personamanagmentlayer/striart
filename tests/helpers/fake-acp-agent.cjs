/**
 * Faux agent ACP (Agent Client Protocol) pour les tests du transport ACP.
 *
 * Parle le sous-ensemble v1 que le client de Striart utilise : initialize,
 * authenticate, session/new, session/prompt, session/cancel, session/close,
 * notifications session/update, et selon le mode, session/request_permission,
 * elicitation/create, fs/read+write et terminal/* vers le client.
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
 *  - permission-commit : comme 'permission', puis commite comme 'commit'
 *                      (proxy `striart acp` : arbitrage dans l'IDE + merge).
 *  - fs              : écrit puis relit un fichier VIA LE CLIENT (fs/write +
 *                      fs/read), end_turn si accordé.
 *  - fs-escape       : tente d'écrire HORS du clone via le client ; end_turn
 *                      si (et seulement si) le client a refusé par erreur.
 *  - badversion      : répond au handshake avec protocolVersion 99.
 *  - auth            : annonce deux méthodes d'authentification ; session/new
 *                      répond auth_required (-32000) tant que `authenticate`
 *                      n'a pas été appelé avec 'agent-login'.
 *  - elicitation     : pose une question structurée (elicitation/create, mode
 *                      form) ; accept + stratégie → end_turn, sinon refusal.
 *                      Si le client n'a PAS annoncé la capacité, ne la pose
 *                      pas (conforme au protocole) et le dit au log.
 *  - terminal        : lance une commande via terminal/create (cwd = clone),
 *                      attend sa sortie, relit son output, release.
 *  - terminal-escape : terminal/create avec un cwd HORS du clone ; end_turn
 *                      si (et seulement si) le client a refusé.
 *  - terminal-hang   : terminal/create d'une commande qui ne finit jamais ;
 *                      wait_for_exit doit revenir (délai du client, kill).
 *  - mcp             : rapporte au log les mcpServers reçus à session/new.
 *  - slow            : comme 'message' mais attend FAKE_ACP_DELAY_MS avant
 *                      end_turn, à chaque prompt (tests multi-prompts).
 *
 * FAKE_ACP_MARKER_DIR : si posé, l'agent y écrit `closed-<sessionId>` à la
 * réception de session/close (preuve que le client ferme la session).
 */
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const mode = process.env.FAKE_ACP_MODE || 'commit';
let nextId = 1000;
const pending = new Map();
let clientCapabilities = {};
let authenticated = false;
let mcpServersSeen = null;
let promptCount = 0;

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
const update = (sessionId, u) =>
  send({ method: 'session/update', params: { sessionId, update: u } });
const say = (sessionId, text) =>
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

let promptId = null;
let sessionId = null;

async function handlePrompt(id, params) {
  promptId = id;
  sessionId = params.sessionId;
  promptCount += 1;
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
  say(sessionId, `travail sur : ${promptText}`);

  if (mode === 'slow') {
    say(sessionId, `\n[prompt #${promptCount}] ${promptText}\n`);
    const delay = Number(process.env.FAKE_ACP_DELAY_MS || 1500);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (promptId === id) promptId = null;
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }

  if (mode === 'mcp') {
    say(sessionId, `\nmcpServers=${JSON.stringify(mcpServersSeen)}\n`);
    say(sessionId, `\nclientCapabilities=${JSON.stringify(clientCapabilities)}\n`);
  }

  if (mode === 'permission' || mode === 'permission-commit') {
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

  if (mode === 'elicitation') {
    if (!clientCapabilities?.elicitation?.form) {
      say(sessionId, '\nelicitation non annoncée par le client\n');
      send({ id, result: { stopReason: 'end_turn' } });
      return;
    }
    let res;
    try {
      res = await request('elicitation/create', {
        sessionId,
        mode: 'form',
        message: 'Quelle stratégie de fusion ?',
        requestedSchema: {
          type: 'object',
          properties: {
            strategy: { type: 'string', title: 'Stratégie', enum: ['rebase', 'merge'] },
            squash: { type: 'boolean' },
          },
          required: ['strategy'],
        },
      });
    } catch (error) {
      say(sessionId, `\nelicitation en erreur : ${error.message}\n`);
      send({ id, result: { stopReason: 'refusal' } });
      return;
    }
    if (res?.action === 'accept' && typeof res.content?.strategy === 'string') {
      say(sessionId, `\nstratégie choisie : ${res.content.strategy}\n`);
      send({ id, result: { stopReason: 'end_turn' } });
    } else {
      say(sessionId, `\nelicitation : ${res?.action}\n`);
      send({ id, result: { stopReason: 'refusal' } });
    }
    return;
  }

  if (mode === 'terminal' || mode === 'terminal-hang' || mode === 'terminal-escape') {
    if (clientCapabilities?.terminal !== true) {
      say(sessionId, '\nterminal non annoncé par le client\n');
      send({ id, result: { stopReason: 'refusal' } });
      return;
    }
    const script =
      mode === 'terminal-hang'
        ? 'setInterval(() => {}, 1000)'
        : 'process.stdout.write("TERM-OK é " + process.cwd() + " " + process.env.STRIART_SESSION + " " + process.env.FAKE_TERM_VAR)';
    const cwd = mode === 'terminal-escape' ? path.join(process.cwd(), '..', '..') : process.cwd();
    let created;
    try {
      created = await request('terminal/create', {
        sessionId,
        command: process.execPath,
        args: ['-e', script],
        env: [
          { name: 'FAKE_TERM_VAR', value: 'from-agent' },
          { name: 'STRIART_SESSION', value: '0' },
        ],
        cwd,
        outputByteLimit: 4096,
      });
    } catch (error) {
      say(sessionId, `\nterminal refusé : ${error.message}\n`);
      send({ id, result: { stopReason: mode === 'terminal-escape' ? 'end_turn' : 'refusal' } });
      return;
    }
    if (mode === 'terminal-escape') {
      send({ id, result: { stopReason: 'refusal' } }); // création passée : échec du test
      return;
    }
    const exit = await request('terminal/wait_for_exit', {
      sessionId,
      terminalId: created.terminalId,
    });
    const out = await request('terminal/output', { sessionId, terminalId: created.terminalId });
    await request('terminal/release', { sessionId, terminalId: created.terminalId });
    say(
      sessionId,
      `\nterminal sortie=[${out.output}] truncated=${out.truncated} exit=${JSON.stringify(exit)}\n`,
    );
    send({ id, result: { stopReason: 'end_turn' } });
    return;
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
    say(sessionId, `relu : ${read.content}`);
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

  if (mode === 'fs-read-cap') {
    // Fichier plus gros que acp.fsReadMaxBytes : le client DOIT refuser (erreur
    // JSON-RPC) ; end_turn seulement si le refus a bien eu lieu.
    try {
      await request('fs/read_text_file', {
        sessionId,
        path: path.join(process.cwd(), 'gros.txt'),
      });
      send({ id, result: { stopReason: 'refusal' } }); // lecture passée : échec du test
      return;
    } catch {
      // Refus attendu.
    }
  }

  if (mode === 'commit' || mode === 'permission-commit') {
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
  // Réponses du client à NOS requêtes (permission, fs, terminal, elicitation).
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
    clientCapabilities = msg.params?.clientCapabilities ?? {};
    send({
      id: msg.id,
      result: {
        protocolVersion: mode === 'badversion' ? 99 : 1,
        agentCapabilities: { sessionCapabilities: { close: {} } },
        authMethods:
          mode === 'auth'
            ? [
                { id: 'agent-login', name: 'Agent login', description: 'Sign in' },
                {
                  id: 'terminal-login',
                  name: 'Terminal login',
                  type: 'terminal',
                  args: ['--login'],
                },
              ]
            : [],
      },
    });
    return;
  }
  if (msg.method === 'authenticate') {
    if (mode === 'auth' && msg.params?.methodId === 'agent-login') {
      authenticated = true;
      send({ id: msg.id, result: {} });
    } else {
      send({ id: msg.id, error: { code: -32602, message: 'unknown auth method' } });
    }
    return;
  }
  if (msg.method === 'session/new') {
    if (mode === 'auth' && !authenticated) {
      send({ id: msg.id, error: { code: -32000, message: 'Authentication required' } });
      return;
    }
    mcpServersSeen = msg.params?.mcpServers ?? null;
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
  if (msg.method === 'session/close') {
    if (process.env.FAKE_ACP_MARKER_DIR) {
      writeFileSync(
        path.join(process.env.FAKE_ACP_MARKER_DIR, `closed-${msg.params?.sessionId}`),
        String(promptCount),
      );
    }
    if (promptId != null) send({ id: promptId, result: { stopReason: 'cancelled' } });
    send({ id: msg.id, result: {} });
    return;
  }
  if (msg.id != null) {
    send({ id: msg.id, error: { code: -32601, message: `inconnue : ${msg.method}` } });
  }
});

rl.on('close', () => process.exit(0));
