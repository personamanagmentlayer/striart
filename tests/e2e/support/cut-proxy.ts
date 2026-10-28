import net from 'node:net';

/**
 * Relais TCP que le test peut COUPER puis rétablir : seule façon fiable de
 * simuler la chute réseau d'un flux SSE déjà ouvert (l'émulation « hors ligne »
 * de Chromium ne coupe pas les connexions établies). Le dashboard ne contrôle
 * que le nom d'hôte, pas le port : la page passe par le relais sans changement.
 */
export class CutProxy {
  private cutOff = false;
  private readonly sockets = new Set<net.Socket>();
  private constructor(
    private readonly server: net.Server,
    readonly port: number,
  ) {}

  static async start(targetPort: number): Promise<CutProxy> {
    let self: CutProxy | null = null;
    const server = net.createServer((client) => {
      if (self?.cutOff) {
        client.destroy();
        return;
      }
      const upstream = net.connect(targetPort, '127.0.0.1');
      for (const s of [client, upstream]) {
        self?.sockets.add(s);
        s.on('close', () => self?.sockets.delete(s));
        s.on('error', () => s.destroy());
      }
      client.pipe(upstream);
      upstream.pipe(client);
      upstream.on('close', () => client.destroy());
      client.on('close', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    self = new CutProxy(server, (server.address() as net.AddressInfo).port);
    return self;
  }

  /** Coupe toutes les connexions en cours et refuse les suivantes. */
  cut(): void {
    this.cutOff = true;
    for (const s of this.sockets) s.destroy();
  }

  resume(): void {
    this.cutOff = false;
  }

  async close(): Promise<void> {
    this.cut();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
