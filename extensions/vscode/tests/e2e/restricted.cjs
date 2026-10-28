'use strict';

exports.tests = [
  {
    name: 'aucun process lancé, état « restricted » (le dépôt n’est jamais exécuté)',
    fn: async ({ api, assert }) => {
      await new Promise((r) => setTimeout(r, 6000));
      assert.equal(api.launches(), 0);
      assert.equal(api.snapshot().connection, 'restricted');
      assert.deepEqual(api.treeLabels(), []);
      assert.match(api.statusBarText(), /Striart/);
    },
  },
  {
    name: 'les commandes existent mais n’agissent pas (pas de connexion)',
    fn: async ({ vscode, assert, api }) => {
      await vscode.commands.executeCommand('striart.refresh');
      await vscode.commands.executeCommand('striart.reconnect');
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(api.launches(), 0, 'reconnect must not start anything in a restricted workspace');
    },
  },
];
