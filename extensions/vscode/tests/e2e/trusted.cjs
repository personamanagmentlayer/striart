'use strict';
const fs = require('node:fs');
const path = require('node:path');

const COMMANDS = [
  'striart.refresh',
  'striart.reconnect',
  'striart.showOutput',
  'striart.merge',
  'striart.sync',
  'striart.stop',
  'striart.newTask',
  'striart.openTerminal',
  'striart.resolveTicket',
  'striart.showDiff',
  'striart.openDashboard',
  'striart.doctor',
  'striart.rollbackMerge',
  'striart.retryQueue',
  'striart.answerRequest',
];

exports.tests = [
  {
    name: 'activation rapide (< 200 ms de CPU)',
    fn: async ({ api, assert }) => {
      console.log(
        `       activate(): wall ${api.activationMs.toFixed(1)} ms, cpu ${api.activationCpuMs.toFixed(1)} ms (${api.activationMarks.join(', ')})`,
      );
      // Le temps mural dépend de la charge de la machine (hôte d'extension préempté) ; le budget de 200 ms
      // s'applique au temps CPU de activate(), et le temps mural reste borné par un plafond large.
      assert.ok(api.activationCpuMs < 200, `activate() used ${api.activationCpuMs.toFixed(1)} ms of CPU`);
      assert.ok(api.activationMs < 1500, `activate() took ${api.activationMs.toFixed(1)} ms`);
    },
  },
  {
    name: 'les 15 commandes sont enregistrées',
    fn: async ({ vscode, assert }) => {
      const all = await vscode.commands.getCommands(true);
      for (const id of COMMANDS) assert.ok(all.includes(id), `missing command ${id}`);
    },
  },
  {
    name: 'connexion au vrai striart api (réglages du dépôt hostile ignorés)',
    fn: async ({ api, assert, waitUntil, workspace }) => {
      await waitUntil(() => api.snapshot().connection === 'connected', { what: 'connected' });
      assert.equal(api.launches(), 1);
      assert.ok(!fs.existsSync(path.join(workspace, 'PWNED')), 'workspace binary must never run');
    },
  },
  {
    name: 'la vue liste l’agent avec un statut en toutes lettres et signale le watcher arrêté',
    fn: async ({ api, assert, waitUntil }) => {
      const labels = await waitUntil(
        () => {
          const l = api.treeLabels();
          return l.some((x) => x.includes('agent-a')) ? l : null;
        },
        { what: 'agent in tree' },
      );
      // Un commit vient d'être fait : l'agent est « Recent activity » (groupe En cours), le statut est écrit en toutes lettres.
      assert.ok(
        labels.some(
          (l) => l.includes('agent-a') && /Recent activity|Ready to merge/.test(l) && l.includes('1 pending commit'),
        ),
        JSON.stringify(labels),
      );
      assert.ok(
        labels.some((l) => l.startsWith('  Watcher stopped')),
        'the stopped watcher must be called out under "Needs attention"',
      );
    },
  },
  {
    name: 'la barre d’état résume agents et watcher',
    fn: async ({ api, assert }) => {
      const text = api.statusBarText();
      assert.match(text, /1 agent/);
      assert.match(text, /watcher off/);
    },
  },
  {
    name: 'doctor et showOutput s’exécutent sans erreur',
    fn: async ({ vscode }) => {
      await vscode.commands.executeCommand('striart.showOutput');
      await vscode.commands.executeCommand('striart.doctor');
    },
  },
  {
    name: 'CPU quasi nul au repos (aucun polling)',
    fn: async ({ assert }) => {
      const before = process.cpuUsage();
      await new Promise((r) => setTimeout(r, 5000));
      const used = process.cpuUsage(before);
      const ms = (used.user + used.system) / 1000;
      assert.ok(ms < 250, `idle CPU over 5 s: ${ms.toFixed(0)} ms`);
    },
  },
  {
    name: 'reprise automatique après mort du serveur',
    fn: async ({ api, assert, waitUntil }) => {
      api.dropConnection();
      await waitUntil(() => api.snapshot().connection === 'offline', {
        what: 'offline',
        timeoutMs: 30_000,
        intervalMs: 20,
      });
      assert.match(api.statusBarText(), /offline/);
      await waitUntil(() => api.snapshot().connection === 'connected', { what: 'reconnected' });
      assert.equal(api.launches(), 2);
      assert.ok(api.snapshot().agents.includes('agent-a'));
    },
  },
];
