import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runListCommand } from '../src/list-command.js';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test('cancellation escalates for descendants even after the shell closes', {
  skip: process.platform === 'win32', timeout: 10000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'list-command-'));
  let pid;
  try {
    const script = join(dir, 'child.cjs');
    const pidFile = join(dir, 'pid');
    await writeFile(script, `process.on('SIGTERM', () => {});\nrequire('node:fs').writeFileSync(process.argv[2], String(process.pid));\nsetInterval(() => {}, 1000);\n`);
    const controller = new AbortController();
    const result = runListCommand(`${quote(process.execPath)} ${quote(script)} ${quote(pidFile)} >/dev/null 2>&1 & wait`, {
      cwd: dir, signal: controller.signal,
    });
    // Install a rejection handler before aborting.
    const rejected = assert.rejects(result, /abort/i);
    for (let attempt = 0; attempt < 100; attempt++) {
      try { pid = Number(await readFile(pidFile, 'utf8')); break; }
      catch { await delay(20); }
    }
    assert.ok(pid, 'descendant started');
    controller.abort();
    await rejected;
    let alive = true;
    for (let attempt = 0; attempt < 150; attempt++) {
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') { alive = false; break; } throw error; }
      await delay(20);
    }
    assert.equal(alive, false, 'TERM-resistant descendant must be killed');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(dir, { recursive: true, force: true });
  }
});
