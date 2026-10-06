import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerDelegateList, uncheckedTasks } from '../src/delegate-list.js';

const pass = { details: { approved: true }, isError: false };
function setup(t, text, execute) {
  const cwd = mkdtempSync(join(tmpdir(), 'delegate-list-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'todo file.md');
  writeFileSync(path, text);
  let handler, tool;
  const events = {};
  let completion;
  const calls = [], notices = [];
  const ctx = { cwd, waitForIdle: async () => {}, ui: { notify: (...args) => notices.push(args) } };
  registerDelegateList({ on: (event, handler) => { events[event] = handler; }, registerTool: definition => { tool = definition; assert.equal(tool.name, 'delegate_list'); }, registerCommand: (name, command) => { assert.equal(name, 'delegate-list'); handler = command.handler; completion = command.getArgumentCompletions; } }, (_ctx, getParent) => {
    assert.equal(getParent().procedural, true);
    return { execute: async (id, params, signal, update, context) => {
      assert.equal(context, ctx);
      calls.push(params);
      return execute?.(calls.length, path, signal) ?? pass;
    } };
  });
  events.session_start({}, ctx);
  return { complete: prefix => completion(prefix), start: cwd => events.session_start({}, { cwd }), toolRun: (signal) => tool.execute('list', { path }, signal, undefined, ctx), tool: () => tool, run: (args = '"todo file.md"') => handler(args, ctx), path, ctx, calls, notices };
}

test('sequential direct execution preserves all text and skips checked/fenced items', async t => {
  const text = '# Tasks\r\n- [X] done\r\n- [ ] first\r\n```md\r\n- [ ] example\r\n```\r\n  1. [ ] second';
  const s = setup(t, text, (n, path) => {
    if (n === 2) assert.match(readFileSync(path, 'utf8'), /\[x\] first/);
    return pass;
  });
  await s.run();
  assert.deepEqual(s.calls.map(c => [c.task, c.mode]), [['first', 'execute'], ['second', 'execute']]);
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
  for (const args of ['', 'missing.md', 'todo.txt', '"todo file.md"']) await s.run(args);
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

test('tool waits for pending reviewed success and persistence before next item', async t => {
  let release;
  const s = setup(t, '- [ ] first\n- [ ] unrelated', (n, path) => {
    if (n === 1) return new Promise(resolve => { release = resolve; });
    assert.match(readFileSync(path, 'utf8'), /\[x\] first/);
    return pass;
  });
  s.ctx.waitForIdle = () => { throw new Error('tool must not wait for idle'); };
  assert.deepEqual(s.tool().parameters.required, ['path']);
  const pending = s.toolRun();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.calls.length, 1);
  assert.match(readFileSync(s.path, 'utf8'), /\[ \] first/);
  release(pass);
  const result = await pending;
  assert.equal(result.isError, false);
  assert.equal(result.details.completed, 2);
  assert.deepEqual(s.calls.map(c => c.task), ['first', 'unrelated']);
});

for (const kind of ['failed', 'unapproved', 'cancelled', 'pre-aborted']) test(`tool stops at ${kind} first item`, async t => {
  const controller = new AbortController();
  const s = setup(t, '- [ ] first\n- [ ] later', (_n, _path, signal) => {
    assert.equal(signal, controller.signal);
    if (kind === 'cancelled') controller.abort();
    return kind === 'unapproved' ? { details: {} } : { isError: true };
  });
  if (kind === 'pre-aborted') controller.abort();
  const result = await s.toolRun(controller.signal);
  assert.equal(result.isError, true);
  assert.equal(result.details.completed, 0);
  assert.equal(s.calls.length, kind === 'pre-aborted' ? 0 : 1);
  assert.equal(readFileSync(s.path, 'utf8'), '- [ ] first\n- [ ] later');
});

for (const owner of ['tool', 'command']) test(`shared guard while ${owner} owns run`, async t => {
  let release;
  const s = setup(t, '- [ ] first', () => new Promise(resolve => { release = resolve; }));
  const pending = owner === 'tool' ? s.toolRun() : s.run();
  await new Promise(resolve => setImmediate(resolve));
  const rejected = await s.toolRun();
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /already active/);
  await s.run();
  assert.match(s.notices.at(-1)[0], /already active/);
  assert.equal(s.calls.length, 1);
  release(pass);
  await pending;
  assert.equal((await s.toolRun()).isError, false);
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
  const pending = s.toolRun();
  await new Promise(resolve => setImmediate(resolve));
  writeFileSync(s.path, initial + suffix);
  release(pass);
  const result = await pending;
  assert.equal(result.isError, false);
  assert.equal(result.details.completed, 3);
  assert.deepEqual(s.calls.map(c => c.task), ['first', 'second', 'third']);
  assert.equal(readFileSync(s.path, 'utf8'), (initial + suffix + '- [ ] third\n').replace('[ ] first', '[x] first').replace('[ ] second', '[x] second').replace('[ ] third', '[x] third'));
});

for (const changed of ['- [ ] first extended\n- [ ] second\n', '- [x] first\n- [ ] second\n', '- [ ] fir', '- [ ] other\n- [ ] second\n']) test(`rejects unsafe edits: ${JSON.stringify(changed)}`, async t => {
  const s = setup(t, '- [ ] first', (_n, path) => { writeFileSync(path, changed); return pass; });
  const result = await s.toolRun();
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
  const result = await s.toolRun(controller.signal);
  assert.equal(result.isError, true);
  assert.equal(result.details.completed, 0);
  assert.equal(s.calls.length, 1);
  assert.equal(readFileSync(s.path, 'utf8'), text);
});

test('completion does not wait for later additions; a new run processes them', async t => {
  const s = setup(t, '- [ ] first\n');
  assert.equal((await s.toolRun()).details.completed, 1);
  writeFileSync(s.path, readFileSync(s.path, 'utf8') + '- [ ] later\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.calls.length, 1);
  assert.equal((await s.toolRun()).details.completed, 1);
  assert.deepEqual(s.calls.map(c => c.task), ['first', 'later']);
});

test('command completion filters files, navigates paths and follows session cwd', t => {
  const s = setup(t, '');
  const cwd = s.ctx.cwd;
  mkdirSync(join(cwd, 'task folder'));
  writeFileSync(join(cwd, 'task folder', 'next.markdown'), '');
  writeFileSync(join(cwd, 'notes.MD'), '');
  writeFileSync(join(cwd, 'ignore.txt'), '');
  const values = prefix => s.complete(prefix)?.map(item => item.value);
  assert.deepEqual(values(''), ['notes.MD', '"task folder/"', '"todo file.md"']);
  assert.deepEqual(values('"task folder/n'), ['"task folder/next.markdown"']);
  assert.deepEqual(values("'task folder/n"), ["'task folder/next.markdown'"]);
  assert.deepEqual(values('./notes'), ['./notes.MD']);
  assert.deepEqual(values(join(cwd, 'notes')), [join(cwd, 'notes.MD')]);
  assert.deepEqual(values('@"todo'), ['@"todo file.md"']);
  assert.equal(s.complete('missing/'), null);
  assert.equal(s.complete('ignore'), null);
  s.start(join(cwd, 'task folder'));
  assert.deepEqual(values(''), ['next.markdown']);
  assert.deepEqual(values('../notes'), ['../notes.MD']);
});

for (const args of ['@"todo file.md"', "@'todo file.md'"]) test(`command accepts built-in reference ${args}`, async t => {
  const s = setup(t, '- [ ] task\n');
  await s.run(args);
  assert.equal(s.calls.length, 1);
  assert.equal(readFileSync(s.path, 'utf8'), '- [x] task\n');
});

test('command accepts unquoted @path', async t => {
  const s = setup(t, '');
  writeFileSync(join(s.ctx.cwd, 'tasks.md'), '- [ ] task\n');
  await s.run('@tasks.md');
  assert.equal(s.calls.length, 1);
});
