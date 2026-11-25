// Starts chrome-headless-shell for one conversion: a fresh profile in a
// temporary folder, the sandbox on, DevTools over a pipe, and a deadline
// after which the whole process group is killed.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';
import { ensureChromium } from '../chromium.js';

export interface LaunchOptions {
  // Folder of the conversion: the profile goes in it, the caller removes it.
  dir: string;
  noSandbox?: boolean;
  // The option of the command that turns the sandbox off, which the
  // explanation of a sandbox that cannot start names.
  noSandboxOption?: string;
  // Chromium's own proxy settings, as --proxy-server and --proxy-bypass-list.
  proxyServer?: string;
  proxyBypassList?: string;
  // Certificates that do not verify accepted, at their handshake, as Qt
  // accepts them for wkhtmltopdf. Puppeteer's acceptInsecureCerts
  // (Security.setIgnoreCertificateErrors) fails each such connection's
  // handshake first, then opens it again (measured on Chromium 157).
  ignoreCertificateErrors?: boolean;
  // XSLT, which Chromium turns off from 158: a feature turns it back on,
  // until Chrome 176 turns it off for everyone (August 2027, Google's
  // schedule). Puppeteer merges the feature into its own --enable-features.
  xslt?: boolean;
  env?: NodeJS.ProcessEnv;
  // Work for this process while Chromium starts, which leaves it idle:
  // loading the modules the conversion needs next.
  meanwhile?: () => void;
}

export class LaunchError extends Error {}

// Windows Server Core, read from the registry. Chromium stops at start there
// (STATUS_STACK_OVERFLOW), whatever the account and the sandbox: measured on
// Server Core 2022 and 2025 in containers, as the administrator and as an
// IIS application pool, and with Media Foundation turned on. Windows Server
// with the Desktop Experience runs it, IIS included.
export function windowsServerCore(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'InstallationType'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return /InstallationType\s+REG_SZ\s+Server Core\s*$/m.test(out);
  } catch {
    return false;
  }
}

// The shared libraries Chromium needs and the system lacks, from ldd: on
// Linux, the archive and the Composer package hold Chromium but not them,
// and a Chromium that cannot load one exits before DevTools answers, so
// Puppeteer only says "Target closed". Read once Chromium has failed.
export function missingLibraries(exe: string): string[] {
  if (process.platform !== 'linux') return [];
  try {
    return parseLdd(execFileSync('ldd', [exe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return [];
  }
}

export function parseLdd(out: string): string[] {
  return [...new Set([...out.matchAll(/^\s*(\S+) => not found\s*$/gm)].map((m) => m[1]!))];
}

// The cap on the address space (RLIMIT_AS, `ulimit -v`), in bytes, Infinity
// when there is none: from /proc/self/limits, or from `limits` when given.
// Null off Linux.
export interface AddressSpace { soft: number; hard: number }

export function addressSpace(limits?: string): AddressSpace | null {
  if (limits === undefined) {
    if (process.platform !== 'linux') return null;
    try {
      limits = readFileSync('/proc/self/limits', 'utf8');
    } catch {
      return null;
    }
  }
  const m = /^Max address space\s+(\S+)\s+(\S+)/m.exec(limits);
  if (!m) return null;
  const bytes = (v: string) => (v === 'unlimited' ? Infinity : Number(v));
  return { soft: bytes(m[1]!), hard: bytes(m[2]!) };
}

// Odoo caps the address space of the programs it starts, wkhtmltopdf
// included: RLIMIT_AS at its limit_memory_hard, 2560 MiB by default, in
// every server mode of Odoo 16 to 20. Chromium reserves far more address
// space than it uses and does not start under any such cap, even 16 GiB,
// where wkhtmltopdf 0.12.6 runs in 2560 MiB (measured 01/11/2026). A soft
// cap is raised to the hard one, which Odoo leaves unlimited, by a shell
// that then becomes Chromium: Node cannot change its own limits.
export function chromiumCommand(exe: string, args: string[], space: AddressSpace | null = addressSpace()): [string, string[]] {
  if (!space || space.soft === Infinity) return [exe, args];
  return ['/bin/sh', ['-c', 'ulimit -S -v "$(ulimit -H -v)"; exec "$0" "$@"', exe, ...args]];
}

// Whether this system lets a process create a user namespace, which
// Chromium's sandbox needs: Docker's default seccomp profile refuses it,
// as does a kernel with unprivileged user namespaces turned off, and
// Chromium then only says "Target closed". Asked of unshare (util-linux)
// once Chromium has failed; null when it cannot tell.
export function userNamespaces(): boolean | null {
  if (process.platform !== 'linux') return null;
  try {
    execFileSync('unshare', ['--user', 'true'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch (e) {
    // unshare exits 1 when the kernel refuses; anything else tells nothing.
    return (e as { status?: number }).status === 1 ? false : null;
  }
}

// Whether this process runs as root, by its real or its effective user ID,
// root in a container's user namespace included. Chromium inherits them,
// and with its sandbox on refuses to start as root, on Linux: its zygote
// exits at once (crbug.com/638180). It says so on its stderr only, which
// Puppeteer keeps to itself: through the pipe, "Target closed" is all that
// comes (Chromium 158). Asked once Chromium has failed.
export function runsAsRoot(): boolean {
  return process.platform === 'linux' && (process.getuid?.() === 0 || process.geteuid?.() === 0);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// The profiles in /etc/apparmor.d, where the Debian package writes its own
// and Ubuntu its programs'.
function appArmorProfiles(): string[] {
  try {
    return readdirSync('/etc/apparmor.d', { withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => readText(join('/etc/apparmor.d', f.name)) ?? '');
  } catch {
    return [];
  }
}

// The Chromium that AppArmor keeps from the user namespaces its sandbox
// needs, or null. From Ubuntu 23.10, with
// kernel.apparmor_restrict_unprivileged_userns, an unconfined program gets
// none it can use, unless a profile allows them to it, as the Debian
// package's does to its Chromium: then Chromium says "No usable sandbox!"
// on its stderr only. Looked for: the restriction, this process unconfined,
// so Chromium too unless a profile names it, and no profile in
// /etc/apparmor.d that names it. In a container, confined by the
// container's profile, it cannot tell: null. Asked once Chromium has failed.
export function appArmorRestricts(exe: string, read: (path: string) => string | null = readText, profiles: () => string[] = appArmorProfiles): string | null {
  if (read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')?.trim() !== '1') return null;
  const label = read('/proc/self/attr/apparmor/current') ?? read('/proc/self/attr/current');
  if (label?.replace(/\0/g, '').trim() !== 'unconfined') return null;
  let real = exe;
  try {
    real = realpathSync(exe);
  } catch {
    // The path as given.
  }
  return profiles().some((p) => p.includes(exe) || p.includes(real)) ? null : exe;
}

// What is asked of a Chromium that did not start, once it has failed:
// through the pipe, Puppeteer passes on none of its words, so each usual
// reason is looked for. Those of the sandbox are not asked when it is off.
export interface Probes {
  serverCore?: () => boolean;
  missing?: () => string[];
  space?: () => AddressSpace | null;
  root?: () => boolean;
  appArmor?: () => string | null;
  namespaces?: () => boolean | null;
}

// Explains the usual reasons Chromium cannot start, with the fix, in the
// order Chromium meets them; noSandbox is the command's option that turns
// the sandbox off.
export function explain(message: string, probes: Probes = {}, noSandbox = '--kiln-no-sandbox'): string {
  if (probes.serverCore?.()) {
    return 'Chromium does not run on Windows Server Core: it stops at start, for want of system libraries. Use Windows Server with the Desktop Experience, or the mcr.microsoft.com/windows/server container image rather than servercore.';
  }
  const libs = probes.missing?.() ?? [];
  if (libs.length) {
    return `Chromium cannot start: the system lacks ${libs.join(', ')}. The Debian package installs Chromium's libraries; with the archive or the Composer package, install them first (README, Installation, Linux and macOS archives).`;
  }
  // A soft cap is raised (chromiumCommand), a hard one cannot be.
  const cap = probes.space?.();
  if (cap && cap.hard !== Infinity) {
    return `Chromium cannot start under a cap on its address space (ulimit -v, RLIMIT_AS) of ${Math.round(cap.hard / 2 ** 20)} MiB: it reserves far more than it uses. Lift the hard cap: LimitAS=infinity in a systemd unit, ulimit -H -v unlimited in the shell that starts the program.`;
  }
  // Chromium checks the user before it tries the sandbox.
  if (probes.root?.()) {
    return `Chromium refuses to run as root with its sandbox on. Run the command as an unprivileged user (or pass ${noSandbox}, not recommended).`;
  }
  const restricted = probes.appArmor?.();
  if (restricted) {
    return `Chromium's sandbox cannot start: AppArmor allows the user namespaces it needs only to programs with a profile that allows them, as on Ubuntu 23.10 and later. The Debian package loads one for its Chromium; for this one, load a profile that allows userns to ${restricted} (https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md). ${noSandbox} works around it, not recommended.`;
  }
  if (probes.namespaces?.() === false) {
    return `Chromium's sandbox cannot start: this system refuses the user namespaces it needs. In a container, run it with PDFKiln's seccomp profile (docker run --security-opt seccomp=seccomp.json, from https://raw.githubusercontent.com/pdfkiln/pdfkiln/main/docker/seccomp.json); elsewhere, allow unprivileged user namespaces (user.max_user_namespaces, kernel.unprivileged_userns_clone). ${noSandbox} works around it, not recommended.`;
  }
  return `Chromium did not start: ${message.split('\n')[0]}`;
}

// Removes a temporary folder; on Windows, Chromium's files may stay locked
// a moment after it is killed. A folder left behind is better than a
// crash that hides the conversion's result.
export function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Left in the temporary folder.
  }
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

// Removes the folder of a Chromium just killed, retrying for up to `ms`
// while the event loop runs. On Windows, taskkill returns before
// Chromium's processes are gone, and their files stay locked until then.
// For a page stuck in a script, measured: 10 timeouts out of 10 left
// their folder with removeQuietly, 19 out of 20 with synchronous retries
// for 9 s, none out of 20 waiting this way.
export async function removeWhenFree(path: string, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      // Left in the temporary folder past `ms`.
      if (Date.now() > end) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

export interface Session {
  browser: Browser;
  profile: string;
  // Set once the deadline has killed Chromium: it ends the process.
  stopping?: Promise<void>;
  close(): Promise<void>;
}

// Ctrl+C, SIGTERM or SIGHUP during a conversion. Puppeteer's handlers are
// off, and Node would end without the finally blocks: Chromium leaves with
// its pipe, but the conversion's folder stayed. The cleanups kill it and
// remove the folder, then the signal ends the process as it would have.
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const cleanups = new Set<() => Promise<void>>();

async function onSignal(signal: NodeJS.Signals): Promise<void> {
  // A second signal ends the process at once.
  for (const s of SIGNALS) process.off(s, onSignal);
  await Promise.allSettled([...cleanups].map((c) => c()));
  cleanups.clear();
  process.kill(process.pid, signal);
}

function cleanupOnSignal(cleanup: () => Promise<void>): () => void {
  if (!cleanups.size) for (const s of SIGNALS) process.on(s, onSignal);
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
    if (!cleanups.size) for (const s of SIGNALS) process.off(s, onSignal);
  };
}

export async function launch(opts: LaunchOptions): Promise<Session> {
  let pid: number | undefined;
  let launching: Promise<Browser> | undefined;
  // The conversion's whole folder: Chromium's profile and the files beside.
  // A Chromium still starting has no pid here yet: its start is awaited.
  const forget = cleanupOnSignal(async () => {
    if (pid === undefined && launching) pid = (await launching.catch(() => undefined))?.process()?.pid;
    killTree(pid);
    await removeWhenFree(opts.dir, 5000);
  });
  let exe: string;
  try {
    exe = await ensureChromium();
  } catch (e) {
    forget();
    throw new LaunchError(`Chromium could not be downloaded: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!existsSync(exe)) {
    forget();
    throw new LaunchError(`Chromium is missing: ${exe}`);
  }
  const profile = join(opts.dir, 'chromium');
  const args = [
    `--user-data-dir=${profile}`,
    // WebRTC would go around the proxy with UDP.
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  ];
  if (opts.noSandbox) args.push('--no-sandbox');
  if (opts.proxyServer) args.push(`--proxy-server=${opts.proxyServer}`);
  if (opts.proxyBypassList) args.push(`--proxy-bypass-list=${opts.proxyBypassList}`);
  if (opts.ignoreCertificateErrors) args.push('--ignore-certificate-errors');
  const features: string[] = [];
  if (opts.xslt) features.push('XSLT');
  // On Windows, a process of Chromium's own that does not set its log
  // writes it beside the program (debug.log, base's default): in the
  // folder of the package or of the user's cache, to which every
  // conversion would add its lines. Its network service is the one that
  // did, all it logged (measured, Chromium 158), unsandboxed since it could
  // write there. Run in the browser's process, which logs into the profile,
  // its lines go with the conversion's folder.
  if (process.platform === 'win32') features.push('NetworkServiceInProcess2');
  if (features.length) args.push(`--enable-features=${features.join(',')}`);
  let browser: Browser;
  try {
    // Puppeteer gets every argument, its defaults included: under a cap on
    // the address space, the program it starts is a shell.
    const [file, argv] = chromiumCommand(exe, await puppeteer.defaultArgs({ headless: 'shell', args }));
    launching = puppeteer.launch({
      executablePath: file,
      ignoreDefaultArgs: true,
      headless: 'shell',
      pipe: true,
      args: argv,
      env: { ...process.env, ...opts.env },
      defaultViewport: null,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      protocolTimeout: 0,
    });
    // Once Puppeteer has started Chromium, before Chromium answers.
    if (opts.meanwhile) setTimeout(opts.meanwhile, 0);
    browser = await launching;
  } catch (e) {
    forget();
    removeQuietly(profile);
    const probes: Probes = { serverCore: windowsServerCore, missing: () => missingLibraries(exe), space: addressSpace };
    if (!opts.noSandbox) Object.assign(probes, { root: runsAsRoot, appArmor: () => appArmorRestricts(exe), namespaces: userNamespaces });
    throw new LaunchError(explain(e instanceof Error ? e.message : String(e), probes, opts.noSandboxOption));
  }
  pid = browser.process()?.pid;
  let closed = false;
  const session: Session = {
    browser,
    profile,
    async close() {
      // A conversion cut off by the deadline does not report its own error.
      if (session.stopping) return session.stopping;
      if (closed) return;
      closed = true;
      // Nothing to save in a throwaway profile: on Linux and macOS, killing
      // the process group is faster than a graceful close. On Windows,
      // taskkill costs about 0.85 s by itself: it only goes after a
      // Chromium that did not close (its other processes leave with it).
      // Browser.close is sent here rather than by browser.close(): when its
      // answer is lost, Chromium already leaving, Puppeteer runs taskkill
      // with its output let through, and "ERROR: The process ... not
      // found." reached the caller's stderr (CI, 18/11/2026).
      if (process.platform === 'win32') {
        const child = browser.process();
        const exited = new Promise<void>((done) => {
          if (!child || child.exitCode !== null || child.signalCode !== null) done();
          else child.once('exit', () => done());
        });
        // Without its connection, Chromium cannot be asked: killed at once.
        if (browser.connected) {
          void (async () => {
            const cdp = await browser.target().createCDPSession();
            await cdp.send('Browser.close');
          })().catch(() => {});
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([exited, new Promise<void>((done) => (timer = setTimeout(done, 5000)))]);
          clearTimeout(timer);
        }
        if (child?.exitCode === null) killTree(pid);
        await browser.disconnect().catch(() => {});
        await removeWhenFree(profile);
      } else {
        browser.disconnect().catch(() => {});
        killTree(pid);
        removeQuietly(profile);
      }
      // The callers remove the rest of the folder themselves.
      forget();
    },
  };
  return session;
}

// Kills Chromium if the conversion outlives `seconds`; 0 disables it, and
// so does more than a timer can hold (24.8 days), which would fire at
// once. onTimeout ends the process, once Chromium's folder is removed.
export function deadline(session: Session, seconds: number, onTimeout: () => void): () => void {
  if (!seconds || seconds * 1000 > 2 ** 31 - 1) return () => {};
  const timer = setTimeout(() => {
    killTree(session.browser.process()?.pid);
    session.stopping = removeWhenFree(session.profile).then(onTimeout);
  }, seconds * 1000);
  timer.unref();
  return () => clearTimeout(timer);
}
