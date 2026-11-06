// PDFKiln's cache folder for the account: PDFKILN_CACHE_DIR, or the
// platform's. Alone in its module, for the commands to use before they
// load the rest.
import { homedir } from 'node:os';
import { join } from 'node:path';

export function userCacheDir(): string {
  if (process.env.PDFKILN_CACHE_DIR) return process.env.PDFKILN_CACHE_DIR;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'pdfkiln');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'pdfkiln');
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'pdfkiln');
}

// Node's compile cache, in that folder. Node's own default is a folder of
// the shared temporary folder that the first account to use it makes for
// all: the others get no cache, or the files another account put there.
// It serves the modules loaded after it, those of dist/src; a bundle is
// one file, compiled before.
export function compileCacheDir(): string {
  return join(userCacheDir(), 'node-compile-cache');
}
