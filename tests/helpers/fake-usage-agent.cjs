/**
 * Faux agent à flux stream-json (format Claude Code) qui consomme des tokens
 * par paliers : un message assistant toutes les 80 ms (1 000 entrée + 100
 * sortie, id distinct), puis un `result` avec le cumul et le coût rapporté.
 *
 * `node fake-usage-agent.cjs <messages> [format]` — format `claude` (défaut)
 * ou `codex` (turn.completed). Un message est RÉPÉTÉ (même id) pour vérifier
 * la déduplication par id. S'il est tué (budget), il ne rend pas de résultat :
 * la fin normale est donc un signe que personne ne l'a arrêté.
 */
const total = Number(process.argv[2] ?? 5);
const format = process.argv[3] ?? 'claude';
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

emit({ type: 'system', subtype: 'init', model: 'fake-usage' });
let i = 0;
const timer = setInterval(() => {
  i += 1;
  if (format === 'codex') {
    emit({
      type: 'turn.completed',
      usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 },
    });
  } else {
    const message = {
      id: `msg_${i}`,
      model: 'fake-usage',
      content: [{ type: 'text', text: `étape ${i}` }],
      usage: { input_tokens: 1000, output_tokens: 100 },
    };
    emit({ type: 'assistant', message });
    emit({ type: 'assistant', message }); // même id : ne doit compter qu'une fois
  }
  if (i >= total) {
    clearInterval(timer);
    if (format === 'claude') {
      emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 0.25,
        usage: { input_tokens: 1000 * total, output_tokens: 100 * total },
        result: 'done',
      });
    }
    process.exit(0);
  }
}, 80);
