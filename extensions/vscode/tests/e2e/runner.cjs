'use strict';
// Exécuté DANS l'hôte d'extensions de VS Code. Mini-harnais séquentiel sans dépendance :
// chaque suite exporte { tests: [{ name, fn }] } ; la première erreur fait échouer le run.
const vscode = require('vscode');
const assert = require('node:assert/strict');

const EXTENSION_ID = 'jumsay.striart-vscode';

async function waitUntil(predicate, { timeoutMs = 120_000, intervalMs = 250, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function run() {
  const suite = require(process.env.STRIART_E2E_SUITE);
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `extension ${EXTENSION_ID} not found`);
  const api = await extension.activate();
  const ctx = { vscode, assert, api, waitUntil, workspace: process.env.STRIART_E2E_WORKSPACE, extension };
  let failed = 0;
  for (const test of suite.tests) {
    const started = Date.now();
    try {
      await test.fn(ctx);
      console.log(`  ok   ${test.name} (${Date.now() - started} ms)`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${test.name}\n       ${error && error.stack ? error.stack : error}`);
      break;
    }
  }
  if (failed > 0) throw new Error(`${failed} e2e test(s) failed`);
}

module.exports = { run };
