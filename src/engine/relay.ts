// The network relay of --kiln-block-private-network: an HTTP proxy on the
// loopback interface that Chromium sends all its traffic to. It resolves
// each host itself, refuses private addresses, and connects to the address
// it checked, so that a DNS answer cannot change between the check and the
// connection. Chromium follows redirects itself: each hop comes back here.
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { connect, isIP, type AddressInfo, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

function v4(ip: string): number[] {
  return ip.split('.').map(Number);
}

// The eight 16-bit groups of a valid IPv6 address, "::" expanded; an IPv4
// address written at its end makes its last two. A URL writes the IPv4
// part in hexadecimal ([::ffff:127.0.0.1] becomes [::ffff:7f00:1]), so the
// address is judged on its value, never on its text.
function groups6(ip: string): number[] {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parse = (part: string | undefined) => (part ? part.split(':').map((h) => parseInt(h, 16)) : []);
  const [head, rest] = s.split('::');
  const left = parse(head);
  const right = parse(rest);
  return rest === undefined ? left : [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

// Loopback, private, link-local (169.254.169.254, the metadata address of
// the clouds), carrier-grade NAT, multicast, reserved and unspecified.
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = v4(ip) as [number, number, number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && v4(ip)[2] === 0) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(ip) === 6) {
    const g = groups6(ip);
    if (g.length !== 8) return true;
    const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
    // An IPv4 address carried in IPv6 is judged as that address: mapped
    // (::ffff:0:0/96), compatible (::/96, so :: and ::1 too) and the NAT64
    // prefix (64:ff9b::/96).
    if ((zero(0, 5) && (g[5] === 0xffff || g[5] === 0)) || (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6))) {
      return isPrivateAddress([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255].join('.'));
    }
    const first = g[0]!;
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return true;
}

export class BlockedAddress extends Error {}

// A server certificate that does not verify (self-signed, expired, issued
// for another name), refused: code is the system's name of the reason.
export class CertificateError extends Error {
  constructor(readonly code: string) {
    super(`invalid certificate (${code})`);
  }
}

// Resolves `host` and returns the addresses it may connect to, in the
// resolver's order.
export async function checkedAddresses(host: string, block: boolean): Promise<{ address: string; family: number }[]> {
  const bare = host.replace(/^\[|\]$/g, '');
  const found = isIP(bare) ? [{ address: bare, family: isIP(bare) }] : await lookup(bare, { all: true });
  if (!block) return found;
  if (!found.length || found.some((a) => isPrivateAddress(a.address))) throw new BlockedAddress(`Blocked access to private address of ${bare}`);
  return found;
}

export async function checkedAddress(host: string, block: boolean): Promise<{ address: string; family: number }> {
  return (await checkedAddresses(host, block))[0]!;
}

// Errors after which the next address of the host is tried, as a browser
// does: localhost is often ::1 first, and a server may listen on 127.0.0.1
// only.
const NEXT_ADDRESS = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EAFNOSUPPORT']);

export interface Relay {
  url: string; // for --proxy-server
  // Why it could not reach a host, for the messages: BlockedAddress, or the
  // error of its lookup or connection. Chromium only sees a 403, a 502 or
  // a closed connection.
  failure(host: string): Error | undefined;
  close(): Promise<void>;
}

export async function startRelay(): Promise<Relay> {
  // By host, an IPv6 address without its brackets.
  const failures = new Map<string, Error>();
  const bare = (host: string) => host.replace(/^\[|\]$/g, '');
  const failed = (host: string, e: unknown) => failures.set(bare(host), e as Error);
  const sockets = new Set<Socket>();
  const server: Server = createServer(async (req, res) => {
    // A plain HTTP request, with an absolute URL.
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    try {
      const addr = await checkedAddress(target.hostname, true);
      const headers = { ...req.headers };
      delete headers['proxy-connection'];
      const up = httpRequest({
        host: addr.address,
        family: addr.family,
        port: target.port || 80,
        method: req.method,
        path: target.pathname + target.search,
        headers,
      }, (r: IncomingMessage) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', (e) => {
        if (!res.headersSent) failed(target.hostname, e);
        res.destroy();
      });
      req.pipe(up);
    } catch (e) {
      failed(target.hostname, e);
      res.writeHead(e instanceof BlockedAddress ? 403 : 502).end();
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  // HTTPS and WebSocket: a tunnel to the checked address.
  server.on('connect', async (req, client: Socket, head: Buffer) => {
    const [host, port] = splitHostPort(req.url ?? '');
    try {
      const addr = await checkedAddress(host, true);
      let open = false;
      const up = connect({ host: addr.address, port: Number(port) || 443 }, () => {
        open = true;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.write(head);
        up.pipe(client);
        client.pipe(up);
      });
      up.on('error', (e) => {
        if (!open) failed(host, e);
        client.destroy();
      });
      client.on('error', () => up.destroy());
    } catch (e) {
      failed(host, e);
      client.end(`HTTP/1.1 ${e instanceof BlockedAddress ? 403 : 502} Refused\r\n\r\n`);
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    failure: (host) => failures.get(bare(host)),
    close: () => new Promise<void>((ok) => {
      for (const s of sockets) s.destroy();
      server.close(() => ok());
    }),
  };
}

function splitHostPort(s: string): [string, string] {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(s) ?? /^([^:]+):(\d+)$/.exec(s);
  return m ? [m[1]!, m[2]!] : [s, '443'];
}

export interface Fetched { status: number; statusText: string; headers: [string, string][]; body: Buffer }

// The client certificate of --ssl-crt-path and --ssl-key-path.
export interface ClientCert { cert: Buffer; key: Buffer; passphrase: string }

// The proxy of Chromium's requests (--proxy), for those made here: http or
// SOCKS 5, and the hosts of --bypass-proxy-for.
export interface Upstream { type: 'http' | 'socks5'; host: string; port: number; user: string; password: string }
export interface RelayProxy { server: Upstream; bypass: string[] }

// Chromium's rule for the page's requests: loopback and link-local hosts
// never go through the proxy, nor the hosts of the bypass list, as written
// or under a "*." or "." name.
export function bypassesProxy(host: string, bypass: string[]): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isIP(h) === 4) {
    const [a, b] = v4(h);
    if (a === 127 || (a === 169 && b === 254)) return true;
  }
  if (isIP(h) === 6) {
    const g = groups6(h);
    if ((g.slice(0, 7).every((x) => x === 0) && g[7] === 1) || ((g[0] ?? 0) & 0xffc0) === 0xfe80) return true;
  }
  return bypass.some((entry) => {
    const b = entry.trim().toLowerCase();
    const suffix = b.startsWith('*.') ? b.slice(1) : b.startsWith('.') ? b : undefined;
    return b === h || (suffix !== undefined && h.endsWith(suffix));
  });
}

// The challenges of WWW-Authenticate or Proxy-Authenticate headers: a
// scheme, then its parameters, quoted or not.
function challenges(values: string[]): { scheme: string; params: Map<string, string> }[] {
  const list: { scheme: string; params: Map<string, string> }[] = [];
  for (const s of values) {
    let i = 0;
    for (;;) {
      const m = /^[\s,]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)/.exec(s.slice(i));
      if (!m) break;
      const name = m[1]!.toLowerCase();
      i += m[0].length;
      const eq = /^\s*=\s*/.exec(s.slice(i));
      if (!eq || !list.length) {
        list.push({ scheme: name, params: new Map() });
        continue;
      }
      i += eq[0].length;
      let value = '';
      if (s[i] === '"') {
        for (i++; i < s.length && s[i] !== '"'; i++) value += s[i] === '\\' ? (s[++i] ?? '') : s[i];
        i++;
      } else {
        value = /^[^,\s]*/.exec(s.slice(i))![0];
        i += value.length;
      }
      list.at(-1)!.params.set(name, value);
    }
  }
  return list;
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const quoted = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;

// RFC 2617's Digest, as Qt 4.8 and Chromium answer it: MD5 or MD5-sess,
// with the qop "auth" when the server offers it.
function digest(p: Map<string, string>, login: { user: string; password: string }, method: string, uri: string): string | undefined {
  const nonce = p.get('nonce');
  const algorithm = (p.get('algorithm') ?? 'MD5').toUpperCase();
  const qops = p.has('qop') ? p.get('qop')!.split(',').map((q) => q.trim().toLowerCase()) : [];
  if (nonce === undefined || (algorithm !== 'MD5' && algorithm !== 'MD5-SESS') || (qops.length && !qops.includes('auth'))) return undefined;
  const realm = p.get('realm') ?? '';
  const cnonce = randomBytes(8).toString('hex');
  const nc = '00000001';
  let ha1 = md5(`${login.user}:${realm}:${login.password}`);
  if (algorithm === 'MD5-SESS') ha1 = md5(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qops.length ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  return [
    `Digest username=${quoted(login.user)}`, `realm=${quoted(realm)}`, `nonce=${quoted(nonce)}`, `uri=${quoted(uri)}`, `response=${quoted(response)}`,
    ...(p.has('algorithm') ? [`algorithm=${p.get('algorithm')}`] : []),
    ...(p.has('opaque') ? [`opaque=${quoted(p.get('opaque')!)}`] : []),
    ...(qops.length ? [`qop=auth`, `nc=${nc}`, `cnonce=${quoted(cnonce)}`] : []),
  ].join(', ');
}

// The answer to a challenge: Digest when offered, else Basic, as Chromium
// picks between the two; none for another scheme.
export function answerChallenge(values: string[], login: { user: string; password: string }, method: string, uri: string): string | undefined {
  const offered = challenges(values);
  for (const c of offered) {
    const answer = c.scheme === 'digest' ? digest(c.params, login, method, uri) : undefined;
    if (answer) return answer;
  }
  return offered.some((c) => c.scheme === 'basic') ? `Basic ${Buffer.from(`${login.user}:${login.password}`).toString('base64')}` : undefined;
}

// The values of a response's header, one per line.
function values(r: IncomingMessage, name: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < r.rawHeaders.length; i += 2) if (r.rawHeaders[i]!.toLowerCase() === name) found.push(r.rawHeaders[i + 1]!);
  return found;
}

// A tunnel to host:port through an http proxy (CONNECT), its challenge
// answered once with the proxy's user and password.
async function tunnel(proxy: Upstream, host: string, port: number): Promise<Socket> {
  const target = `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  const ask = (authorization?: string) => new Promise<{ status: number; socket: Socket; offered: string[] }>((ok, fail) => {
    const c = httpRequest({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: target, headers: { host: target, ...(authorization ? { 'proxy-authorization': authorization } : {}) } });
    c.on('connect', (res: IncomingMessage, socket: Socket) => ok({ status: res.statusCode ?? 0, socket, offered: values(res, 'proxy-authenticate') }));
    c.on('error', fail);
    c.end();
  });
  let t = await ask();
  if (t.status === 407 && proxy.user) {
    const answer = answerChallenge(t.offered, { user: proxy.user, password: proxy.password }, 'CONNECT', target);
    if (answer) {
      t.socket.destroy();
      t = await ask(answer);
    }
  }
  if (t.status !== 200) {
    t.socket.destroy();
    throw new Error(`the proxy answered ${t.status} to CONNECT ${target}`);
  }
  return t.socket;
}

// A connection to host:port through a SOCKS 5 proxy, which resolves the
// name; without authentication, as Chromium, which has none for SOCKS.
async function socks5(proxy: Upstream, host: string, port: number): Promise<Socket> {
  const socket = connect({ host: proxy.host, port: proxy.port });
  const read = (n: number) => new Promise<Buffer>((ok, fail) => {
    const done = () => {
      socket.off('readable', next);
      socket.off('end', ended);
      socket.off('error', fail);
    };
    const next = () => {
      const b = socket.read(n) as Buffer | null;
      if (b) {
        done();
        ok(b);
      }
    };
    const ended = () => {
      done();
      fail(new Error('the SOCKS proxy closed the connection'));
    };
    socket.on('readable', next);
    socket.on('end', ended);
    socket.on('error', fail);
    next();
  });
  try {
    await new Promise<void>((ok, fail) => {
      socket.once('connect', () => {
        socket.off('error', fail);
        ok();
      });
      socket.once('error', fail);
    });
    socket.write(Buffer.from([5, 1, 0]));
    const [version, method] = await read(2);
    if (version !== 5 || method !== 0) throw new Error('the SOCKS proxy asks for an authentication');
    const family = isIP(host);
    const address = family === 4 ? Buffer.from([1, ...v4(host)])
      : family === 6 ? Buffer.from([4, ...groups6(host).flatMap((g) => [g >> 8, g & 255])])
        : Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)]);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 255])]));
    const reply = await read(4);
    if (reply[1] !== 0) throw new Error(`the SOCKS proxy could not reach ${host}:${port} (reply ${reply[1]})`);
    await read((reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : (await read(1))[0]!) + 2);
    return socket;
  } catch (e) {
    socket.destroy();
    throw e;
  }
}

export interface RelayOptions {
  block: boolean;
  method?: string;
  headers?: Record<string, string>;
  // Headers for this URL's host only, over those of the same name: left
  // out at a redirect to another host (cookies, the native --header).
  hostHeaders?: Record<string, string>;
  // Or those of each hop of a redirect, given by the caller.
  hostHeadersFor?: (url: string) => Promise<Record<string, string>>;
  body?: Buffer;
  tls?: ClientCert;
  // Redirects followed here (fonts), or given back to Chromium.
  follow?: boolean;
  // Certificates that do not verify are accepted, as wkhtmltopdf accepts
  // them; refused otherwise. untrusted is told of each response that came
  // over a connection whose certificate did not verify, with that
  // connection.
  insecure?: boolean;
  untrusted?: (connection: object) => void;
  // Through Chromium's proxy, but to the hosts it reaches directly.
  proxy?: RelayProxy;
  // For a server that asks for them, as Chromium is given them for the
  // page's requests (--username, --password).
  login?: { user: string; password: string };
}

// A request done by the command itself (fonts relayed with CORS headers,
// requests with a client certificate), with the same check as the relay,
// at every redirect.
export async function relayRequest(url: string, opts: RelayOptions, hops = 0, answers: { server?: string; proxy?: string } = {}): Promise<Fetched> {
  const u = new URL(url);
  const https = u.protocol === 'https:';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port) || (https ? 443 : 80);
  const method = opts.method ?? 'GET';
  const via = opts.proxy && !bypassesProxy(host, opts.proxy.bypass) ? opts.proxy.server : undefined;
  const headers: Record<string, string> = { host: u.host, ...opts.headers, ...opts.hostHeaders, ...(answers.server ? { authorization: answers.server } : {}) };
  const tls = { servername: isIP(host) ? undefined : host, rejectUnauthorized: !opts.insecure, ...(opts.tls && https ? opts.tls : {}) };
  const send = (options: RequestOptions) => new Promise<IncomingMessage>((ok, fail) => {
    const c = (https ? httpsRequest : httpRequest)({ path: u.pathname + u.search, method, headers, ...options }, (r) => {
      const socket = r.socket as TLSSocket;
      if (https && socket.authorized === false) opts.untrusted?.(socket);
      ok(r);
    });
    c.on('error', (e) => {
      // A refused certificate ends the connection with the reason, which
      // the socket keeps.
      const reason = opts.insecure ? undefined : (c.socket as TLSSocket | null)?.authorizationError;
      fail(reason ? new CertificateError(String(reason)) : e);
    });
    c.end(opts.body);
  });
  let r: IncomingMessage | undefined;
  if (via?.type === 'http' && !https) {
    // An http proxy gets the whole URL.
    r = await send({ host: via.host, port: via.port, path: u.href.replace(/#.*$/, ''), headers: { ...headers, ...(answers.proxy ? { 'proxy-authorization': answers.proxy } : {}) } });
  } else if (via) {
    // A tunnel, with TLS to the host for https.
    const socket = via.type === 'http' ? await tunnel(via, host, port) : await socks5(via, host, port);
    r = await send({ host, port, createConnection: () => (https ? tlsConnect({ socket, host, ...tls }) : socket) });
  } else {
    const addrs = await checkedAddresses(host, opts.block);
    for (const [i, addr] of addrs.entries()) {
      try {
        r = await send({ host: addr.address, family: addr.family, port, ...tls });
        break;
      } catch (e) {
        if (i === addrs.length - 1 || !NEXT_ADDRESS.has((e as { code?: string }).code ?? '')) throw e;
      }
    }
  }
  if (!r) throw new Error(`${host} has no address`);
  // A server, or the http proxy of an http URL, that asks for credentials:
  // answered once, as Chromium answers for the page's requests.
  const retry = (more: { server?: string; proxy?: string }) => {
    r!.resume();
    return relayRequest(url, opts, hops, { ...answers, ...more });
  };
  if (r.statusCode === 401 && opts.login && !answers.server) {
    const answer = answerChallenge(values(r, 'www-authenticate'), opts.login, method, u.pathname + u.search);
    if (answer) return retry({ server: answer });
  }
  if (r.statusCode === 407 && via?.type === 'http' && !https && via.user && !answers.proxy) {
    const answer = answerChallenge(values(r, 'proxy-authenticate'), { user: via.user, password: via.password }, method, u.href.replace(/#.*$/, ''));
    if (answer) return retry({ proxy: answer });
  }
  if (opts.follow && r.statusCode && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 10) {
    r.resume();
    const next = new URL(r.headers.location, u);
    const hostHeaders = opts.hostHeadersFor ? await opts.hostHeadersFor(next.href) : next.host === u.host ? opts.hostHeaders : undefined;
    return relayRequest(next.href, { ...opts, hostHeaders, method: 'GET', body: undefined }, hops + 1);
  }
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(c as Buffer);
  const received: [string, string][] = [];
  for (let i = 0; i < r.rawHeaders.length; i += 2) received.push([r.rawHeaders[i]!, r.rawHeaders[i + 1]!]);
  return { status: r.statusCode ?? 0, statusText: r.statusMessage ?? '', headers: received, body: Buffer.concat(chunks) };
}

export function relayGet(url: string, opts: Omit<RelayOptions, 'method' | 'body' | 'follow'>): Promise<Fetched> {
  return relayRequest(url, { ...opts, follow: true });
}
