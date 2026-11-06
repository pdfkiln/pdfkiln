// The network relay of --kiln-block-private-network: an HTTP proxy on the
// loopback interface that Chromium sends all its traffic to. It resolves
// each host itself, refuses private addresses, and connects to the address
// it checked, so that a DNS answer cannot change between the check and the
// connection. Chromium follows redirects itself: each hop comes back here.
import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, isIP, type AddressInfo, type Socket } from 'node:net';

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

export interface RelayOptions {
  block: boolean;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer;
  tls?: ClientCert;
  // Redirects followed here (fonts), or given back to Chromium.
  follow?: boolean;
}

// A request done by the command itself (fonts relayed with CORS headers,
// requests with a client certificate), with the same check as the relay,
// at every redirect.
export async function relayRequest(url: string, opts: RelayOptions, hops = 0): Promise<Fetched> {
  const u = new URL(url);
  const req = u.protocol === 'https:' ? httpsRequest : httpRequest;
  const send = (addr: { address: string; family: number }) => new Promise<IncomingMessage>((ok, fail) => {
    const c = req({
      host: addr.address,
      family: addr.family,
      servername: isIP(u.hostname) ? undefined : u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method ?? 'GET',
      headers: { host: u.host, ...opts.headers },
      // As wkhtmltopdf, which ignores certificate errors.
      rejectUnauthorized: false,
      ...(opts.tls && u.protocol === 'https:' ? opts.tls : {}),
    }, ok);
    c.on('error', fail);
    c.end(opts.body);
  });
  let r: IncomingMessage | undefined;
  const addrs = await checkedAddresses(u.hostname, opts.block);
  for (const [i, addr] of addrs.entries()) {
    try {
      r = await send(addr);
      break;
    } catch (e) {
      if (i === addrs.length - 1 || !NEXT_ADDRESS.has((e as { code?: string }).code ?? '')) throw e;
    }
  }
  if (!r) throw new Error(`${u.hostname} has no address`);
  if (opts.follow && r.statusCode && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 10) {
    r.resume();
    return relayRequest(new URL(r.headers.location, u).href, { ...opts, method: 'GET', body: undefined }, hops + 1);
  }
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(c as Buffer);
  const headers: [string, string][] = [];
  for (let i = 0; i < r.rawHeaders.length; i += 2) headers.push([r.rawHeaders[i]!, r.rawHeaders[i + 1]!]);
  return { status: r.statusCode ?? 0, statusText: r.statusMessage ?? '', headers, body: Buffer.concat(chunks) };
}

export function relayGet(url: string, opts: { block: boolean; headers?: Record<string, string>; tls?: ClientCert }): Promise<Fetched> {
  return relayRequest(url, { ...opts, follow: true });
}
