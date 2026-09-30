import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24);

// Only harden directories owned by this extension, never the agent directory itself.
function privateDirectory(path) {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error(`Unsafe delegation log directory: ${path}`);
  }
  chmodSync(path, 0o700);
  return path;
}

export function allocateLogDirectory(agentDir, cwd, parentSession, role) {
  const root = privateDirectory(join(agentDir, 'delegation-logs'));
  const project = privateDirectory(join(root, hash(resolve(cwd))));
  const parent = privateDirectory(join(project, hash(parentSession)));
  // Random allocation prevents concurrent runs from sharing or overwriting logs.
  const directory = mkdtempSync(join(parent, `${role}-`));
  chmodSync(directory, 0o700);
  return directory;
}

// Seed the native session file privately before any sensitive messages are written.
// Opening it afterward makes the SDK append instead of recreating it with defaults.
export function seedPrivateSession(manager) {
  const path = manager.getSessionFile();
  writeFileSync(path, `${JSON.stringify(manager.getHeader())}\n`, { flag: 'wx', mode: 0o600 });
  return path;
}
