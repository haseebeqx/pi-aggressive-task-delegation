import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDelegateList, uncheckedTasks } from '../src/delegate-list.js';

const pass = { details: { approved: true }, isError: false };
function setup(t, text, execute) {
  const cwd = mkdtempSync(join(tmpdir(), 'delegate-list-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'todo file.md');
  writeFileSync(path, text);
  const calls = [], notices = [];
  const ctx = { cwd };
  const runner = signal => runDelegateList(path, { cwd, execute: invoke, signal });
  const invoke = async (params, signal) => {
    calls.push(params);
    return execute?.(calls.length, path, signal) ?? pass;
  };
  return { runnerRun: runner, run: async (name = 'todo file.md') => {
    const result = await runDelegateList(name, { cwd, execute: invoke, signal: ctx.signal });
    notices.push([result.content[0].text]);
    return result;
  }, path, ctx, calls, notices };
}

test('sequential direct execution preserves all text and skips checked/fenced items', async t => {
  const text = '# Tasks\r\n- [X] done\r\n- [ ] first\r\n```md\r\n- [ ] example\r\n```\r\n  1. [ ] second';
  const s = setup(t, text, (n, path) => {
    if (n === 2) assert.match(readFileSync(path, 'utf8'), /\[x\] first/);
    return pass;
  });
  await s.run();
  assert.deepEqual(s.calls.map(c => [c.task, c.mode]), [['first', 'execute'], ['second', 'execute']]);
  assert.deepEqual(s.calls.map(c => c.taskNumber), [2, 3]);
  assert.equal(readFileSync(s.path, 'utf8'), text.replace('[ ] first', '[x] first').replace('[ ] second', '[x] second'));
  assert.ok(s.calls.every(c => !c.context.includes('report')));
});

for (const kind of ['failure', 'throw', 'cancel']) test(`stops on ${kind} leaving later tasks unchecked`, async t => {
  const s = setup(t, '- [ ] one\n- [ ] two\n- [ ] three\n', n => {
    if (n === 1) return pass;
    if (kind === 'throw') throw new Error('broken');
    if (kind === 'cancel') s.controller.abort();
    return { isError: true, details: { approved: false } };
  });
  s.controller = new AbortController();
  s.ctx.signal = s.controller.signal;
  await s.run();
  assert.equal(s.calls.length, 2);
  assert.equal(readFileSync(s.path, 'utf8'), '- [x] one\n- [ ] two\n- [ ] three\n');
});

test('conflicting edits are never overwritten', async t => {
  const s = setup(t, '- [ ] first\n- [ ] second', (_, path) => { writeFileSync(path, 'changed externally'); return pass; });
  await s.run();
  assert.equal(readFileSync(s.path, 'utf8'), 'changed externally');
  assert.equal(s.calls.length, 1);
  assert.match(s.notices.at(-1)[0], /changed/);
});

test('validates input before executing', async t => {
  const s = setup(t, '- [ ]   \n');
  for (const args of ['', 'missing.md', 'todo.txt', 'todo file.md']) await s.run(args);
  assert.equal(s.calls.length, 0);
  assert.throws(() => uncheckedTasks('- [ ] '), /non-empty/);
});

test('rejects overlapping list runs', async t => {
  let release;
  const s = setup(t, '- [ ] first', () => new Promise(resolve => { release = resolve; }));
  const first = s.run();
  await new Promise(resolve => setImmediate(resolve));
  await s.run();
  assert.match(s.notices.at(-1)[0], /already active/);
  release(pass);
  await first;
  assert.equal(s.calls.length, 1);
});

test('runner waits for pending reviewed success and persistence before next item', async t => {
  let release;
  const s = setup(t, '- [ ] first\n- [ ] unrelated', (n, path) => {
    if (n === 1) return new Promise(resolve => { release = resolve; });
    assert.match(readFileSync(path, 'utf8'), /\[x\] first/);
    return pass;
  });
  const pending = s.runnerRun();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.calls.length, 1);
  assert.match(readFileSync(s.path, 'utf8'), /\[ \] first/);
  release(pass);
  const result = await pending;
  assert.equal(result.isError, false);
  assert.equal(result.details.completed, 2);
  assert.deepEqual(s.calls.map(c => c.task), ['first', 'unrelated']);
});

for (const kind of ['failed', 'unapproved', 'cancelled', 'pre-aborted']) test(`runner stops at ${kind} first item`, async t => {
  const controller = new AbortController();
  const s = setup(t, '- [ ] first\n- [ ] later', (_n, _path, signal) => {
    assert.equal(signal, controller.signal);
    if (kind === 'cancelled') controller.abort();
    return kind === 'unapproved' ? { details: {} } : { isError: true };
  });
  if (kind === 'pre-aborted') controller.abort();
  const result = await s.runnerRun(controller.signal);
  assert.equal(result.isError, true);
  assert.equal(result.details.completed, 0);
  assert.equal(s.calls.length, kind === 'pre-aborted' ? 0 : 1);
  assert.equal(readFileSync(s.path, 'utf8'), '- [ ] first\n- [ ] later');
});

test('shared guard rejects concurrent runner runs', async t => {
  let release;
  const s = setup(t, '- [ ] first', () => new Promise(resolve => { release = resolve; }));
  const pending = s.runnerRun();
  await new Promise(resolve => setImmediate(resolve));
  const rejected = await s.runnerRun();
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /already active/);
  await s.run();
  assert.match(s.notices.at(-1)[0], /already active/);
  assert.equal(s.calls.length, 1);
  release(pass);
  await pending;
  assert.equal((await s.runnerRun()).isError, false);
});

for (const ending of ['\n', '', '\r\n']) test(`live additions survive marking and run sequentially (${JSON.stringify(ending)})`, async t => {
  let release;
  const initial = '# Tasks' + (ending || '\n') + '- [ ] first' + ending;
  const suffix = (ending ? '' : '\r\n') + '- [X] skipped\r\n```md\r\n- [ ] example\r\n```\r\n- [ ] second\r\n';
  const s = setup(t, initial, (n, path) => {
    if (n === 1) return new Promise(resolve => { release = resolve; });
    assert.match(readFileSync(path, 'utf8'), /\[x\] first/);
    if (n === 2) writeFileSync(path, readFileSync(path, 'utf8') + '- [ ] third\n');
    return pass;
  });
  const pending = s.runnerRun();
  await new Promise(resolve => setImmediate(resolve));
  writeFileSync(s.path, initial + suffix);
  release(pass);
  const result = await pending;
  assert.equal(result.isError, false);
  assert.equal(result.details.completed, 3);
  assert.deepEqual(s.calls.map(c => c.task), ['first', 'second', 'third']);
  assert.deepEqual(s.calls.map(c => c.taskNumber), [1, 3, 4]);
  assert.equal(readFileSync(s.path, 'utf8'), (initial + suffix + '- [ ] third\n').replace('[ ] first', '[x] first').replace('[ ] second', '[x] second').replace('[ ] third', '[x] third'));
});

for (const changed of ['- [ ] first extended\n- [ ] second\n', '- [x] first\n- [ ] second\n', '- [ ] fir', '- [ ] other\n- [ ] second\n']) test(`rejects unsafe edits: ${JSON.stringify(changed)}`, async t => {
  const s = setup(t, '- [ ] first', (_n, path) => { writeFileSync(path, changed); return pass; });
  const result = await s.runnerRun();
  assert.equal(result.isError, true);
  assert.equal(result.details.completed, 0);
  assert.match(result.content[0].text, /conflict/);
  assert.equal(readFileSync(s.path, 'utf8'), changed);
  assert.equal(s.calls.length, 1);
});

for (const kind of ['failure', 'cancel']) test(`live additions stay unchecked on ${kind}`, async t => {
  const controller = new AbortController();
  const text = '- [ ] first\n- [ ] appended\n';
  const s = setup(t, '- [ ] first\n', (_n, path) => {
    writeFileSync(path, text);
    if (kind === 'cancel') controller.abort();
    return kind === 'failure' ? { isError: true } : pass;
  });
  const result = await s.runnerRun(controller.signal);
  assert.equal(result.isError, true);
  assert.equal(result.details.completed, 0);
  assert.equal(s.calls.length, 1);
  assert.equal(readFileSync(s.path, 'utf8'), text);
});

test('completion does not wait for later additions; a new run processes them', async t => {
  const s = setup(t, '- [ ] first\n');
  assert.equal((await s.runnerRun()).details.completed, 1);
  writeFileSync(s.path, readFileSync(s.path, 'utf8') + '- [ ] later\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.calls.length, 1);
  assert.equal((await s.runnerRun()).details.completed, 1);
  assert.deepEqual(s.calls.map(c => c.task), ['first', 'later']);
});


test('aggregates usage including the failed reviewed result', async t => {
  const s = setup(t, '- [ ] first\n- [ ] second\n- [ ] later\n', n => ({
    details: { approved: n === 1 }, isError: n !== 1,
    content: [{ type: 'text', text: 'review failed' }],
    usage: { input: n, output: 2, totalTokens: n + 2, cost: { total: 0.25 } },
  }));
  const result = await s.runnerRun();
  assert.equal(result.details.completed, 1);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /review failed/);
  assert.deepEqual(result.usage, {
    input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
  });
});

test('requires an injected executor', async t => {
  const s = setup(t, '- [ ] task\n');
  const result = await runDelegateList(s.path);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /executor/);
  assert.equal(readFileSync(s.path, 'utf8'), '- [ ] task\n');
});

for (const details of [
  { approved: true, completed: true, reviewStatus: 'skipped', independentApproved: false },
  { approved: true, reviewStatus: 'skipped' },
  { approved: true, independentApproved: false },
]) test(`whole-item gate rejects unreviewed success: ${JSON.stringify(details)}`, async t => {
  const text = '- [ ] first\n- [ ] later\n';
  const s = setup(t, text, () => ({ isError: false, details,
    content: [{ type: 'text', text: 'Worker completion only; no independent approval.' }] }));
  const result = await s.runnerRun();
  assert.equal(result.isError, true);
  assert.equal(result.details.completed, 0);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].review, true);
  assert.equal(readFileSync(s.path, 'utf8'), text);
});

for (const details of [
  { approved: true, completed: true, reviewStatus: 'passed', independentApproved: true },
  { approved: true }, // Legacy result compatibility (also used by interactive lists).
]) test(`whole-item gate accepts reviewed/legacy success: ${JSON.stringify(details)}`, async t => {
  const s = setup(t, '- [ ] first\n- [ ] later\n', () => ({ isError: false, details }));
  const result = await s.runnerRun();
  assert.equal(result.isError, false);
  assert.equal(result.details.completed, 2);
  assert.ok(s.calls.every(call => call.review === true && call.mode === 'execute'));
  assert.equal(readFileSync(s.path, 'utf8'), '- [x] first\n- [x] later\n');
});
