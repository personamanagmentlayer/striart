import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from '@playwright/test';

const SERVE = fileURLToPath(new URL('./serve.ts', import.meta.url));

export interface Scenario {
  agents?: number;
  tickets?: number;
  queue?: number;
  long?: boolean;
  permissions?: number;
  elicitation?: boolean;
  mainSession?: boolean;
  profiles?: boolean;
  demo?: boolean;
  missing?: number;
  /** Agents inactifs (GC d'inactivité) : agent-00 dormant, agent-01 session vivante avertie. */
  idle?: boolean;
  port?: number;
}

export interface LinkInfo {
  url: string;
  expiresAt: string;
}

interface Reply {
  id?: number;
  event?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
  port?: number;
  baseUrl?: string;
  root?: string;
}

/** Un dashboard réel (process séparé) et son canal de commande. */
export class DashboardServer {
  private seq = 0;
  private readonly pending = new Map<number, (m: Reply) => void>();
  private stderr = '';
  baseUrl = '';
  port = 0;
  root = '';
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly ready: Promise<void>;

  private constructor(scenario: Scenario, env: Record<string, string>) {
    this.child = spawn(process.execPath, [SERVE, JSON.stringify(scenario)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, STRIART_LANG: 'fr', ...env },
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += String(chunk);
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`serveur de test muet : ${this.stderr}`)),
        240_000,
      );
      this.child.once('exit', (code) =>
        reject(new Error(`serveur de test arrêté (${code}) : ${this.stderr}`)),
      );
      createInterface({ input: this.child.stdout }).on('line', (line) => {
        let msg: Reply;
        try {
          msg = JSON.parse(line) as Reply;
        } catch {
          return; // ligne de journal, pas un message du protocole
        }
        if (msg.event === 'ready') {
          clearTimeout(timer);
          this.baseUrl = msg.baseUrl ?? '';
          this.port = msg.port ?? 0;
          this.root = msg.root ?? '';
          resolve();
          return;
        }
        if (msg.id !== undefined) this.pending.get(msg.id)?.(msg);
      });
    });
  }

  static async start(
    scenario: Scenario = {},
    env: Record<string, string> = {},
  ): Promise<DashboardServer> {
    const server = new DashboardServer(scenario, env);
    await server.ready;
    return server;
  }

  /** Envoie une commande au serveur de test (lien, graines, bruit d'état…). */
  cmd<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (m) => {
        this.pending.delete(id);
        if (m.ok) resolve(m.result as T);
        else reject(new Error(m.error));
      });
      this.child.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }

  link(): Promise<LinkInfo> {
    return this.cmd<LinkInfo>('link');
  }

  /** Contexte de navigateur déjà connecté (lien à usage unique consommé). */
  async signedInContext(
    browser: Browser,
    options: Parameters<Browser['newContext']>[0] = {},
  ): Promise<BrowserContext> {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await page.goto((await this.link()).url);
    await page.waitForURL(`${this.baseUrl}/`);
    await page.close();
    return context;
  }

  /** Page connectée, premier état rendu (« direct »). */
  async openPage(context: BrowserContext): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`${this.baseUrl}/`);
    await page.locator('#live.is-live').waitFor();
    return page;
  }

  /**
   * Contexte connecté à travers un relais coupable (voir cut-proxy.ts) : même
   * nom d'hôte d'instance, autre port. Rend aussi l'URL de base via le relais.
   */
  async signedInContextVia(
    browser: Browser,
    proxyPort: number,
    options: Parameters<Browser['newContext']>[0] = {},
  ): Promise<{ context: BrowserContext; base: string }> {
    const swap = (url: string) => url.replace(`:${this.port}`, `:${proxyPort}`);
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await page.goto(swap((await this.link()).url));
    await page.waitForURL(`${swap(this.baseUrl)}/`);
    await page.close();
    return { context, base: swap(this.baseUrl) };
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.stdin.write(`${JSON.stringify({ id: -1, cmd: 'close' })}\n`);
    const killer = setTimeout(() => this.child.kill(), 30_000);
    await exited;
    clearTimeout(killer);
  }
}
