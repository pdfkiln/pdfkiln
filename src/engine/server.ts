// Chromium kept open between conversions (pdfkiln serve): started once,
// reached through a socket only its user can open (a Unix socket in a
// folder of mode 0700, a named pipe on Windows), never a TCP port, which
// any local user could drive. Each conversion connects, works in a browser
// context of its own (cookies, cache and storage apart) and leaves; its
// requests are still intercepted, files read and limits enforced by its
// own process. Without a server, the commands start their own Chromium.
//
// One DevTools connection to Chromium is shared by every client: message
// ids are renumbered per client, and events go to the client that owns the
// browser context of their target.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import puppeteer, { type Browser, type ConnectionTransport } from 'puppeteer-core';
import { ensureChromium, userCacheDir } from '../chromium.js';
import { addressSpace, chromiumCommand, explain, killTree, LaunchError, missingLibraries, removeWhenFree, userNamespaces, windowsServerCore } from './browser.js';

// PDFKILN_SERVER: the socket, or "off" not to look for a server.
export function socketPath(): string | null {
  const env = process.env.PDFKILN_SERVER;
  if (env === 'off') return null;
  if (env) return env;
  if (process.platform === 'win32') {
    // An IIS application pool's identity has no account Node can read
    // (uv_os_get_passwd fails with ENOMEM, Windows Server Core 2025, CI job
    // dotnet): no pipe to name, so no server, and each conversion starts
    // its own Chromium.
    try {
      return `\\\\.\\pipe\\pdfkiln-${userInfo().username}`;
    } catch {
      return null;
    }
  }
  // The user's cache folder: a service and the application it serves, run
  // by the same user, find the same path.
  return join(userCacheDir(), 'run', 'chromium.sock');
}

// Messages framed as on Chromium's pipe: JSON, each ended by a NUL. Only
// the new chunk is searched, and a message is decoded once whole: a PDF
// comes in hundreds of chunks, and a character may straddle two.
export function frames(onMessage: (m: string) => void): (chunk: Buffer) => void {
  let pending: Buffer[] = [];
  return (chunk) => {
    let start = 0;
    let end = chunk.indexOf(0);
    while (end !== -1) {
      pending.push(chunk.subarray(start, end));
      onMessage(Buffer.concat(pending).toString('utf8'));
      pending = [];
      start = end + 1;
      end = chunk.indexOf(0, start);
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  };
}

class SocketTransport implements ConnectionTransport {
  onmessage?: (message: string) => void;
  onclose?: () => void;

  constructor(private readonly socket: Socket) {
    socket.on('data', frames((m) => this.onmessage?.(m)));
    socket.on('close', () => this.onclose?.());
    socket.on('error', () => {});
  }

  send(message: string): void {
    this.socket.write(`${message}\0`);
  }

  close(): void {
    this.socket.end();
  }
}

// The server of this user, if one answers.
export async function connectServer(): Promise<Browser | null> {
  const path = socketPath();
  if (!path) return null;
  if (process.platform !== 'win32') {
    try {
      // A socket another user put there is not ours to trust.
      if (statSync(path).uid !== process.getuid!()) return null;
    } catch {
      return null;
    }
  }
  const socket = await new Promise<Socket | null>((ok) => {
    const s = netConnect(path);
    s.once('connect', () => ok(s));
    s.once('error', () => ok(null));
  });
  if (!socket) return null;
  // A server that does not answer in 5 s is left for a Chromium of our own.
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((ok) => (timer = setTimeout(() => ok(null), 5000)));
  const browser = await Promise.race([
    puppeteer.connect({ transport: new SocketTransport(socket), defaultViewport: null, protocolTimeout: 0 }).catch(() => null),
    late,
  ]);
  clearTimeout(timer);
  if (!browser) socket.destroy();
  return browser;
}

interface Message {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: unknown;
}

class Client {
  constructor(readonly socket: Socket) {}
  send(m: Message | string): void {
    if (!this.socket.destroyed) this.socket.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\0`);
  }
}

// Most messages are routed without being parsed: they carry style sheets,
// files and PDFs, megabytes per conversion. Puppeteer writes
// {"method","params","id","sessionId"}, Chromium {"id",...} for answers
// and {...,"sessionId"} at the end of a session's events; anything else is
// parsed.
const CLIENT_METHOD = /^\{"method":"([^"\\]+)"/;
const CLIENT_ID = /"id":(\d+)(,"sessionId":"[^"\\]+")?\}$/;
const ANSWER = /^\{"id":(\d+),/;
const SESSION = /,"sessionId":"([^"\\]+)"\}$/;

// Shares one DevTools connection between clients.
export class Mux {
  private nextId = 1;
  private readonly pending = new Map<number, { client?: Client; id: number; method: string }>();
  private readonly contexts = new Map<string, Client>();
  private readonly targets = new Map<string, Client>();
  private readonly sessions = new Map<string, Client>();

  constructor(private readonly toChromium: (m: string) => void) {}

  private forward(m: Message, client?: Client): void {
    const id = this.nextId++;
    this.pending.set(id, { client, id: m.id ?? 0, method: m.method ?? '' });
    this.toChromium(JSON.stringify({ ...m, id }));
  }

  fromClient(client: Client, raw: string): void {
    const method = CLIENT_METHOD.exec(raw);
    const tail = CLIENT_ID.exec(raw);
    const m: Message = method && tail ? { method: method[1], id: Number(tail[1]), sessionId: tail[2] } : JSON.parse(raw) as Message;
    // Closing the browser is the server's business: the client only leaves.
    if (m.method === 'Browser.close' && !m.sessionId) {
      client.send({ id: m.id, result: {} });
      client.socket.end();
      return;
    }
    if (!method || !tail) {
      this.forward(m, client);
      return;
    }
    const id = this.nextId++;
    this.pending.set(id, { client, id: m.id!, method: m.method! });
    this.toChromium(`${raw.slice(0, tail.index)}"id":${id}${tail[2] ?? ''}}`);
  }

  fromChromium(raw: string): void {
    const answer = ANSWER.exec(raw);
    if (answer) {
      const p = this.pending.get(Number(answer[1]));
      if (p && p.method !== 'Target.createBrowserContext') {
        this.pending.delete(Number(answer[1]));
        p.client?.send(`{"id":${p.id},${raw.slice(answer[0].length)}`);
        return;
      }
    } else if (!raw.startsWith('{"method":"Target.')) {
      const session = SESSION.exec(raw);
      if (session) {
        this.sessions.get(session[1]!)?.send(raw);
        return;
      }
    }
    const m = JSON.parse(raw) as Message;
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (p.method === 'Target.createBrowserContext' && m.result?.browserContextId && p.client) this.contexts.set(m.result.browserContextId, p.client);
      p.client?.send({ ...m, id: p.id });
      return;
    }
    this.ownerOf(m)?.send(raw);
  }

  private ownerOf(m: Message): Client | undefined {
    const info = m.params?.targetInfo as { targetId: string; browserContextId?: string } | undefined;
    switch (m.method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const owner = info?.browserContextId ? this.contexts.get(info.browserContextId) : undefined;
        if (owner && info) this.targets.set(info.targetId, owner);
        return owner;
      }
      case 'Target.targetDestroyed':
      case 'Target.targetCrashed': {
        const id = m.params?.targetId as string;
        const owner = this.targets.get(id);
        if (m.method === 'Target.targetDestroyed') this.targets.delete(id);
        return owner;
      }
      case 'Target.attachedToTarget': {
        const owner = (m.sessionId && this.sessions.get(m.sessionId)) || (info?.browserContextId ? this.contexts.get(info.browserContextId) : undefined);
        if (owner) this.sessions.set(m.params!.sessionId as string, owner);
        return owner;
      }
      case 'Target.detachedFromTarget': {
        const owner = (m.sessionId && this.sessions.get(m.sessionId)) || this.sessions.get(m.params?.sessionId as string);
        this.sessions.delete(m.params?.sessionId as string);
        return owner;
      }
      default:
        return m.sessionId ? this.sessions.get(m.sessionId) : undefined;
    }
  }

  // A client gone: its browser contexts and pages with it.
  leave(client: Client): void {
    for (const [id, owner] of this.contexts) {
      if (owner !== client) continue;
      this.contexts.delete(id);
      this.forward({ method: 'Target.disposeBrowserContext', params: { browserContextId: id } });
    }
    for (const [id, owner] of this.sessions) if (owner === client) this.sessions.delete(id);
    for (const [id, owner] of this.targets) if (owner === client) this.targets.delete(id);
    for (const p of this.pending.values()) if (p.client === client) p.client = undefined;
  }

  connect(socket: Socket): void {
    const client = new Client(socket);
    socket.on('data', frames((m) => {
      try {
        this.fromClient(client, m);
      } catch {
        socket.destroy();
      }
    }));
    socket.on('close', () => this.leave(client));
    socket.on('error', () => {});
  }
}

export interface ServeOptions {
  socket: string;
  noSandbox: boolean;
  // Chromium's environment, given its folder.
  env: (dir: string) => NodeJS.ProcessEnv;
  log: (line: string) => void;
}

// Starts Chromium with the same arguments as for one conversion, and
// serves it until the process is stopped or Chromium exits.
export async function serve(opts: ServeOptions): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'pdfkiln-serve-'));
  let chromium: ChildProcess | undefined;
  let server: Server | undefined;
  const stop = async () => {
    server?.close();
    killTree(chromium?.pid);
    await removeWhenFree(dir);
    if (process.platform !== 'win32') rmSync(opts.socket, { force: true });
  };
  try {
    if (process.platform !== 'win32') {
      const folder = join(opts.socket, '..');
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      chmodSync(folder, 0o700);
      if (existsSync(opts.socket)) {
        const alive = await new Promise<boolean>((ok) => {
          const s = netConnect(opts.socket).once('connect', () => (s.destroy(), ok(true))).once('error', () => ok(false));
        });
        if (alive) throw new LaunchError(`a server already listens on ${opts.socket}`);
        rmSync(opts.socket, { force: true });
      }
    }
    let exe: string;
    try {
      exe = await ensureChromium();
    } catch (e) {
      throw new LaunchError(`Chromium could not be downloaded: ${e instanceof Error ? e.message : String(e)}`);
    }
    const args = await puppeteer.defaultArgs({
      headless: 'shell',
      userDataDir: join(dir, 'chromium'),
      args: [
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        ...(opts.noSandbox ? ['--no-sandbox'] : []),
        '--remote-debugging-pipe',
      ],
    });
    const child = spawn(...chromiumCommand(exe, args), { env: { ...process.env, ...opts.env(dir) }, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    chromium = child;
    let stderr = '';
    child.stderr!.on('data', (d) => (stderr += d));
    const toChromium = child.stdio[3] as NodeJS.WritableStream;
    const fromChromium = child.stdio[4] as NodeJS.ReadableStream;
    // A Chromium gone breaks its pipes (EPIPE): its exit tells why.
    toChromium.on('error', () => {});
    fromChromium.on('error', () => {});
    const mux = new Mux((m) => toChromium.write(`${m}\0`));
    // Chromium answers its first message, id 0, before anything is served.
    let answered: () => void = () => {};
    let started = false;
    fromChromium.on('data', frames((m) => {
      if (started) mux.fromChromium(m);
      else {
        started = true;
        answered();
      }
    }));
    await new Promise<void>((ok, fail) => {
      const onExit = () => fail(new LaunchError(explain(stderr || 'Chromium exited', windowsServerCore, () => missingLibraries(exe), addressSpace, opts.noSandbox ? () => null : userNamespaces)));
      child.once('exit', onExit);
      answered = () => {
        child.off('exit', onExit);
        ok();
      };
      toChromium.write(`${JSON.stringify({ id: 0, method: 'Browser.getVersion' })}\0`);
    });
    server = createServer((socket) => mux.connect(socket));
    await new Promise<void>((ok, fail) => server!.once('error', fail).listen(opts.socket, ok));
    if (process.platform !== 'win32') chmodSync(opts.socket, 0o600);
    opts.log(`pdfkiln: Chromium kept open, serving on ${opts.socket}`);
    const code = await new Promise<number>((ok) => {
      child.once('exit', () => {
        opts.log('pdfkiln: Chromium exited');
        ok(1);
      });
      for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => ok(0));
    });
    return code;
  } finally {
    await stop();
  }
}
