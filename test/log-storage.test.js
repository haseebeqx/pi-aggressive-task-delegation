import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { allocateLogDirectory, seedPrivateSession } from '../src/log-storage.js';

test('storage is private, project/session scoped, and unique even with permissive umask', () => {
  const root = mkdtempSync(join(tmpdir(), 'divider-storage-test-'));
  const previous = process.umask(0);
  try {
    const first = allocateLogDirectory(root, '/workspace', 'parent-a', 'worker');
    const second = allocateLogDirectory(root, '/workspace', 'parent-a', 'worker');
    assert.notEqual(first, second);
    assert.equal(dirname(first), dirname(second));
    assert.notEqual(dirname(first), dirname(allocateLogDirectory(root, '/workspace', 'parent-b', 'worker')));
    assert.notEqual(dirname(first), dirname(allocateLogDirectory(root, '/other', 'parent-a', 'worker')));
    if (process.platform !== 'win32') {
      for (let path = first; path !== root; path = dirname(path)) {
        assert.equal(lstatSync(path).mode & 0o777, 0o700);
      }
    }
    const file = join(first, 'session.jsonl');
    const manager = { getSessionFile: () => file, getHeader: () => ({ type: 'session' }) };
    seedPrivateSession(manager);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { type: 'session' });
    if (process.platform !== 'win32') assert.equal(lstatSync(file).mode & 0o777, 0o600);
    assert.throws(() => seedPrivateSession(manager), { code: 'EEXIST' });
  } finally { process.umask(previous); rmSync(root, { recursive: true, force: true }); }
});

test('rejects symlink storage rather than writing through it', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'divider-storage-test-'));
  try {
    const target = join(root, 'target');
    mkdirSync(target);
    symlinkSync(target, join(root, 'delegation-logs'));
    assert.throws(() => allocateLogDirectory(root, '/workspace', 'parent', 'worker'), /Unsafe/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
