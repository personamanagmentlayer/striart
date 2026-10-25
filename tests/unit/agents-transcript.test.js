import { describe, expect, it } from 'vitest';
import { TOOL_OUTPUT_MAX_CHARS, transcribeStructuredOutput } from '../../src/agents/transcript.ts';

const lines = (...events) =>
  events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n');

describe('transcription de la sortie structurée', () => {
  it("'none' : sortie inchangée", () => {
    expect(transcribeStructuredOutput('none', '{"type":"x"}\nraw')).toBe('{"type":"x"}\nraw');
  });

  it('claude-stream-json : messages, outils, résultat — raisonnement omis', () => {
    const out = transcribeStructuredOutput(
      'claude-stream-json',
      lines(
        { type: 'system', subtype: 'init', model: 'claude-x' },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'secret reasoning' },
              { type: 'text', text: 'Je modifie feature.js' },
              { type: 'tool_use', name: 'Edit', input: { file: 'feature.js' } },
            ],
          },
        },
        {
          type: 'user',
          message: { content: [{ type: 'tool_result', content: 'ok', is_error: false }] },
        },
        { type: 'result', subtype: 'success', num_turns: 3, duration_ms: 1200, result: 'Fini.' },
      ),
    );
    expect(out).toContain('[session] démarrée — modèle claude-x');
    expect(out).toContain('Je modifie feature.js');
    expect(out).toContain('[outil] Edit');
    expect(out).toContain('[outil] → ok');
    expect(out).toContain('[résultat] success — 3 tours — 1200 ms');
    expect(out).toContain('Fini.');
    expect(out).not.toContain('secret reasoning');
  });

  it('codex-jsonl : commandes, fichiers, message, fin de tour', () => {
    const out = transcribeStructuredOutput(
      'codex-jsonl',
      lines(
        { type: 'thread.started', thread_id: 't1' },
        { type: 'item.started', item: { type: 'command_execution', command: 'npm test' } },
        {
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command: 'npm test',
            status: 'completed',
            exit_code: 0,
            aggregated_output: 'pass',
          },
        },
        {
          type: 'item.completed',
          item: {
            type: 'file_change',
            status: 'completed',
            changes: [{ path: 'a.js', kind: 'update' }],
          },
        },
        { type: 'item.completed', item: { type: 'agent_message', text: 'Terminé' } },
        { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
      ),
    );
    expect(out).toContain('[session] démarrée (t1)');
    expect(out).toContain('[commande] npm test → completed (code 0)');
    expect(out).toContain('[fichiers] update a.js');
    expect(out).toContain('Terminé');
    expect(out).toContain('[tour] terminé — 10 in / 5 out');
  });

  it('gemini-stream-json : écho utilisateur omis, outils et résultat', () => {
    const out = transcribeStructuredOutput(
      'gemini-stream-json',
      lines(
        { type: 'message', role: 'user', content: 'la tâche' },
        { type: 'message', role: 'assistant', content: 'Réponse' },
        { type: 'tool_use', tool_name: 'write_file', parameters: { path: 'x' } },
        { type: 'result', status: 'success' },
      ),
    );
    expect(out).not.toContain('la tâche');
    expect(out).toContain('Réponse');
    expect(out).toContain('[outil] write_file');
    expect(out).toContain('[résultat] success');
  });

  it('fidélité : lignes non JSON et types inconnus conservés, sorties d’outil bornées', () => {
    const big = 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 50);
    const out = transcribeStructuredOutput(
      'claude-stream-json',
      lines(
        'Error: something on stderr',
        '{"truncated": ',
        { type: 'mystery', value: 1 },
        { type: 'user', message: { content: [{ type: 'tool_result', content: big }] } },
      ),
    );
    expect(out).toContain('Error: something on stderr');
    expect(out).toContain('{"truncated": ');
    expect(out).toContain('[mystery]');
    expect(out).toContain('50 caractères tronqués');
  });

  it('ndjson générique : chaque objet rendu par son type', () => {
    expect(
      transcribeStructuredOutput('ndjson', lines({ type: 'run_result', text: 'ok' })),
    ).toContain('[run_result]');
  });
});
