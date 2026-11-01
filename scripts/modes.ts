// The modes of a tree about to be archived or packaged, whatever the
// machine that built it gave: 0755 for folders and executables, 0644 for
// the rest. Unpacked as root, or installed by dpkg, no file is writable by
// another user than its owner. Links keep theirs.
import { chmodSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function normalizeModes(path: string): void {
  const s = lstatSync(path);
  if (s.isSymbolicLink()) return;
  if (s.isDirectory()) {
    chmodSync(path, 0o755);
    for (const f of readdirSync(path)) normalizeModes(join(path, f));
  } else {
    chmodSync(path, s.mode & 0o111 ? 0o755 : 0o644);
  }
}
