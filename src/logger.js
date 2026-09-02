import pino from 'pino';

const level = process.env.STRIART_LOG_LEVEL ?? 'info';

// En mode MCP, stdout est le canal du protocole JSON-RPC : la moindre ligne
// de log le corromprait. Tout part alors sur stderr (fd 2) — détection par
// argv (le logger s'initialise à l'import, avant tout parsing de commande)
// avec STRIART_LOG_STDERR=1 en surcharge explicite pour les cas indirects.
const toStderr = process.env.STRIART_LOG_STDERR === '1' || process.argv[2] === 'mcp';

export const logger = toStderr
  ? pino({ level }, pino.destination(2))
  : pino({
      level,
      ...(process.stdout.isTTY && {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
    });
