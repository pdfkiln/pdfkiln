// Starts chrome-headless-shell for one conversion: a fresh profile in a
// temporary folder, the sandbox on, DevTools over a pipe, and a deadline
// after which the whole process group is killed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';
import { ensureChromium } from '../chromium.js';

export interface LaunchOptions {
  // Folder of the conversion: the profile goes in it, the caller removes it.
  dir: string;
  noSandbox?: boolean;
  // Chromium's own proxy settings, as --proxy-server and --proxy-bypass-list.
  proxyServer?: string;
  proxyBypassList?: string;
  env?: NodeJS.ProcessEnv;
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

// Explains the usual reasons Chromium cannot start, with the fix.
export function explain(message: string, serverCore: () => boolean = windowsServerCore, missing: () => string[] = () => [], space: () => AddressSpace | null = () => null): string {
  if (serverCore()) {
    return 'Chromium does not run on Windows Server Core: it stops at start, for want of system libraries. Use Windows Server with the Desktop Experience, or the mcr.microsoft.com/windows/server container image rather than servercore.';
  }
  const libs = missing();
  const loader = /error while loading shared libraries: ([^:\s]+)/.exec(message);
  if (loader && !libs.includes(loader[1]!)) libs.push(loader[1]!);
  if (libs.length) {
    return `Chromium cannot start: the system lacks ${libs.join(', ')}. The Debian package installs Chromium's libraries; with the archive or the Composer package, install them first (README, Installation, Linux and macOS archives).`;
  }
  // A soft cap is raised (chromiumCommand), a hard one cannot be.
  const cap = space();
  if (cap && cap.hard !== Infinity) {
    return `Chromium cannot start under a cap on its address space (ulimit -v, RLIMIT_AS) of ${Math.round(cap.hard / 2 ** 20)} MiB: it reserves far more than it uses. Lift the hard cap: LimitAS=infinity in a systemd unit, ulimit -H -v unlimited in the shell that starts the program.`;
  }
  if (/as root without --no-sandbox/i.test(message)) {
    return 'Chromium refuses to run as root with its sandbox on. Run the command as an unprivileged user (or pass --kiln-no-sandbox, not recommended).';
  }
  if (/No usable sandbox|namespace|setuid sandbox|zygote/i.test(message)) {
    return "Chromium's sandbox could not start: unprivileged user namespaces are unavailable. On Ubuntu 23.10 and later, AppArmor restricts them: install an AppArmor profile for Chromium that allows userns (see the README), or enable kernel.unprivileged_userns_clone. --kiln-no-sandbox works around it, not recommended.";
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

export async function launch(opts: LaunchOptions): Promise<Session> {
  let exe: string;
  try {
    exe = await ensureChromium();
  } catch (e) {
    throw new LaunchError(`Chromium could not be downloaded: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!existsSync(exe)) throw new LaunchError(`Chromium is missing: ${exe}`);
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
  let browser: Browser;
  try {
    // Puppeteer gets every argument, its defaults included: under a cap on
    // the address space, the program it starts is a shell.
    const [file, argv] = chromiumCommand(exe, await puppeteer.defaultArgs({ headless: 'shell', args }));
    browser = await puppeteer.launch({
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
  } catch (e) {
    removeQuietly(profile);
    throw new LaunchError(explain(e instanceof Error ? e.message : String(e), windowsServerCore, () => missingLibraries(exe), addressSpace));
  }
  const pid = browser.process()?.pid;
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
      if (process.platform === 'win32') {
        await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
        if (browser.process()?.exitCode === null) killTree(pid);
        await removeWhenFree(profile);
      } else {
        browser.disconnect().catch(() => {});
        killTree(pid);
        removeQuietly(profile);
      }
    },
  };
  return session;
}

// Kills Chromium if the conversion outlives `seconds`; 0 disables it.
// onTimeout ends the process, once Chromium's folder is removed.
export function deadline(session: Session, seconds: number, onTimeout: () => void): () => void {
  if (!seconds) return () => {};
  const timer = setTimeout(() => {
    killTree(session.browser.process()?.pid);
    session.stopping = removeWhenFree(session.profile).then(onTimeout);
  }, seconds * 1000);
  timer.unref();
  return () => clearTimeout(timer);
}
