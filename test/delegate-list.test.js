import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDelegateList, uncheckedTasks } from '../src/delegate-list.js';

const pass = { details: { approved: true }, isError: false };
function setup(t, text, execute, filename = 'todo file.md') {
  const cwd = mkdtempSync(join(tmpdir(), 'delegate-list-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, filename);
  writeFileSync(path, text);
  const calls = [], notices = [];
  const ctx = { cwd };
  const runner = signal => runDelegateList(path, { cwd, execute: invoke, signal });
  const invoke = async (params, signal) => {
    calls.push(params);
    return execute?.(calls.length, path, signal) ?? pass;
  };
  return { runnerRun: runner, run: async (name = filename) => {
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

test('successful items retain ordered task metadata and every executor session and log', async t => {
  const text = '- [X] done\n- [ ] first\n```md\n- [ ] example\n```\n- [x] also done\n- [ ] second\n';
  const artifacts = [1, 2].map(n => ({
    sessionIds: { worker: `worker-${n}`, reviewer: `reviewer-${n}`, extra: `extra-${n}` },
    logs: { worker: `/logs/worker-${n}`, reviewer: `/logs/reviewer-${n}`, extra: `/logs/extra-${n}` },
  }));
  const s = setup(t, text, n => ({
    isError: false,
    details: { approved: true, ...artifacts[n - 1] },
  }));
  const result = await s.runnerRun();
  assert.equal(result.isError, false);
  assert.equal(result.details.completed, 2);
  assert.deepEqual(result.details.items, [
    { taskNumber: 2, task: 'first', completed: true, ...artifacts[0] },
    { taskNumber: 4, task: 'second', completed: true, ...artifacts[1] },
  ]);
});

test('successful output associates task numbers and completion status with every executor session and log', async t => {
  const artifacts = [1, 2].map(n => ({
    sessionIds: { worker: `worker-${n}`, reviewer: `reviewer-${n}`, extra: `extra-${n}` },
    logs: { worker: `/logs/worker-${n}`, reviewer: `/logs/reviewer-${n}`, extra: `/logs/extra-${n}` },
  }));
  const s = setup(t, '- [X] done\n- [ ] first\n- [x] also done\n- [ ] second\n', n => ({
    isError: false,
    details: { approved: true, ...artifacts[n - 1] },
  }));
  const result = await s.runnerRun();
  assert.equal(result.isError, false);
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[0].text, [
    'delegate-list: 2 item(s) completed.',
    'Task 2 [completed]: first',
    '  worker session ID: worker-1',
    '  reviewer session ID: reviewer-1',
    '  extra session ID: extra-1',
    '  worker transcript log: /logs/worker-1',
    '  reviewer transcript log: /logs/reviewer-1',
    '  extra transcript log: /logs/extra-1',
    'Task 4 [completed]: second',
    '  worker session ID: worker-2',
    '  reviewer session ID: reviewer-2',
    '  extra session ID: extra-2',
    '  worker transcript log: /logs/worker-2',
    '  reviewer transcript log: /logs/reviewer-2',
    '  extra transcript log: /logs/extra-2',
  ].join('\n'));
});

test('legacy successful items default session and log maps while preserving ordered task metadata', async t => {
  const s = setup(t, '- [X] done\n- [ ] first\n- [x] also done\n- [ ] second\n', () => ({
    isError: false,
    details: { approved: true },
  }));
  const result = await s.runnerRun();
  assert.equal(result.isError, false);
  assert.equal(result.details.completed, 2);
  assert.deepEqual(result.details.items, [
    { taskNumber: 2, task: 'first', completed: true, sessionIds: {}, logs: {} },
    { taskNumber: 4, task: 'second', completed: true, sessionIds: {}, logs: {} },
  ]);
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

test('removing the list preserves external text and finishes normally', async t => {
  const s = setup(t, '- [ ] first\n- [ ] second', (_, path) => { writeFileSync(path, 'changed externally'); return pass; });
  await s.run();
  assert.equal(readFileSync(s.path, 'utf8'), 'changed externally');
  assert.equal(s.calls.length, 1);
  assert.match(s.notices.at(-1)[0], /0 item\(s\) completed/);
});

test('validates input before executing', async t => {
  const s = setup(t, '- [ ]   \n');
  for (const [name, message] of [
    ['', /task file path/], ['   ', /task file path/],
    [null, /task file path/], [42, /task file path/],
    ['missing.tasks', /ENOENT/], [s.ctx.cwd, /regular file/],
    ['todo file.md', /non-empty/],
  ]) {
    const result = await runDelegateList(name, { cwd: s.ctx.cwd, execute: () => { s.calls.push(name); return pass; } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, message);
  }
  assert.equal(s.calls.length, 0);
  assert.throws(() => uncheckedTasks('- [ ] '), /non-empty/);
});

for (const filename of ['todo.tasks', 'todo.txt', 'todo.custom-extension', 'todo', 'todo.md', 'todo.markdown']) {
  test(`checkbox tasks and shell commands work regardless of extension: ${filename}`, async t => {
    const events = [];
    const text = '!echo setup\n- [x] skipped\n- [ ] work\n!echo teardown\n';
    const s = setup(t, text, undefined, filename);
    const result = await runDelegateList(filename, {
      cwd: s.ctx.cwd,
      execute: async params => { s.calls.push(params); events.push('task'); return pass; },
      onCommandOutput: ({ stream, text }) => { if (stream === 'label') events.push(text.trim()); },
    });
    assert.equal(result.isError, false);
    assert.equal(result.details.completed, 1);
    assert.deepEqual(s.calls.map(c => c.task), ['work']);
    assert.deepEqual(events, ['delegate-list shell: !echo setup', 'task', 'delegate-list shell: !echo teardown']);
    assert.equal(result.details.commands.length, 2);
    assert.ok(result.details.commands.every(c => c.completed && c.exitCode === 0));
    assert.equal(readFileSync(s.path, 'utf8'), text.replace('[ ] work', '[x] work'));
  });
}

test('empty shell commands in .tasks files reject before any work', async t => {
  const text = '- [ ] work\n!   \n';
  const s = setup(t, text, undefined, 'todo.tasks');
  const result = await s.run();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Shell commands must have non-empty text/);
  assert.equal(s.calls.length, 0);
  assert.equal(readFileSync(s.path, 'utf8'), text);
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

for (const changed of ['- [ ] first extended\n- [ ] second\n', '- [x] first\n- [ ] second\n', '- [ ] fir', '- [ ] other\n- [ ] second\n']) test(`live edits are processed: ${JSON.stringify(changed)}`, async t => {
  const s = setup(t, '- [ ] first', (n, path) => { if (n === 1) writeFileSync(path, changed); return pass; });
  const result = await s.runnerRun();
  assert.equal(result.isError, false);
  assert.deepEqual(s.calls.map(c => c.task), ['first', ...uncheckedTasks(changed).map(c => c.task)]);
  assert.equal(result.details.items[0].completed, changed.includes('[x] first'));
  assert.equal(readFileSync(s.path, 'utf8'), changed.replaceAll('[ ]', '[x]'));
});

for (const ending of ['\n', '\r\n']) test(`insertions, pending edits and reordering preserve latest text (${JSON.stringify(ending)})`, async t => {
  const initial = ['# Tasks', '- [ ] active', '- [ ] pending', '- [x] done'].join(ending) + ending;
  const changed = ['# New heading', '- [ ] inserted before', '- [ ] pending revised', '- [x] done revised', '- [ ] active', '- [ ] inserted after'].join(ending) + ending;
  const s = setup(t, initial, (n, path) => {
    if (n === 1) writeFileSync(path, changed);
    else assert.match(readFileSync(path, 'utf8'), /\[x\] active/);
    return pass;
  });
  const result = await s.runnerRun();
  assert.equal(result.isError, false);
  assert.equal(result.details.completed, 4);
  assert.deepEqual(s.calls.map(c => c.task), ['active', 'inserted before', 'pending revised', 'inserted after']);
  assert.equal(readFileSync(s.path, 'utf8'), changed.replaceAll('[ ]', '[x]'));
});

for (const change of ['edit', 'delete']) test(`active ${change} does not apply stale approval`, async t => {
  const changed = change === 'edit' ? '- [ ] revised\n- [ ] later\n' : '- [ ] later\n';
  const s = setup(t, '- [ ] active\n- [ ] later\n', (n, path) => {
    if (n === 1) writeFileSync(path, changed);
    if (n === 2) {
      // First approval must not change any part of the latest file.
      assert.equal(readFileSync(path, 'utf8'), changed);
      return { isError: true };
    }
    return pass;
  });
  const result = await s.runnerRun();
  assert.equal(result.isError, true);
  assert.equal(result.details.completed, 0);
  assert.equal(result.details.items[0].completed, false);
  assert.deepEqual(s.calls.map(c => c.task), ['active', change === 'edit' ? 'revised' : 'later']);
  assert.equal(readFileSync(s.path, 'utf8'), changed);
});

test('external checkbox edits skip checked tasks and rerun reopened completed tasks', async t => {
  const changed = '- [X] active\r\n- [x] pending\r\n- [ ] completed revised\r\n';
  const s = setup(t, '- [ ] active\r\n- [ ] pending\r\n- [x] completed\r\n', (n, path) => {
    if (n === 1) writeFileSync(path, changed);
    if (n === 2) assert.equal(readFileSync(path, 'utf8'), changed);
    return pass;
  });
  const result = await s.runnerRun();
  assert.equal(result.isError, false);
  assert.deepEqual(s.calls.map(c => c.task), ['active', 'completed revised']);
  assert.equal(readFileSync(s.path, 'utf8'), changed.replace('[ ]', '[x]'));
});

test('unchanged duplicate lists terminate and execute each occurrence', async t => {
  const s = setup(t, '- [ ] same\n- [ ] same\n- [x] same\n');
  const result = await s.runnerRun();
  assert.equal(result.isError, false);
  assert.equal(result.details.completed, 2);
  assert.equal(s.calls.length, 2);
  assert.equal(readFileSync(s.path, 'utf8'), '- [x] same\n- [x] same\n- [x] same\n');
});

for (const changed of [
  '# shifted\n- [ ] same\n- [ ] same\n',
  '- [ ] same\n',
  '- [x] same\n- [ ] same\n',
  '- [ ] revised\n- [ ] same\n',
]) test(`ambiguous duplicate changes never check another occurrence: ${JSON.stringify(changed)}`, async t => {
  const s = setup(t, '- [ ] same\n- [ ] same\n', (n, path) => {
    if (n === 1) writeFileSync(path, changed);
    if (n === 2) assert.equal(readFileSync(path, 'utf8'), changed);
    assert.ok(n <= 4, 'duplicate retry must terminate');
    return pass;
  });
  const result = await s.runnerRun();
  assert.equal(result.isError, false);
  assert.equal(result.details.items[0].completed, false);
  assert.equal(result.details.completed, uncheckedTasks(changed).length);
  assert.equal(readFileSync(s.path, 'utf8'), changed.replaceAll('[ ]', '[x]'));
});

test('adding an identical task during execution cannot inherit approval', async t => {
  const changed = '- [ ] same\n- [ ] same\n';
  const s = setup(t, '- [ ] same\n', (n, path) => {
    if (n === 1) writeFileSync(path, changed);
    if (n === 2) assert.equal(readFileSync(path, 'utf8'), changed);
    return pass;
  });
  const result = await s.runnerRun();
  assert.equal(result.details.items[0].completed, false);
  assert.equal(result.details.completed, 2);
  assert.equal(s.calls.length, 3);
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

test('later failed executor result preserves ordered attempts and artifacts in stopped output', async t => {
  const text = '- [X] done\n- [ ] first\n- [x] also done\n- [ ] second\n- [ ] later\n';
  const artifacts = [1, 2].map(n => ({
    sessionIds: { worker: `worker-${n}`, reviewer: `reviewer-${n}`, extra: `extra-${n}` },
    logs: { worker: `/logs/worker-${n}`, reviewer: `/logs/reviewer-${n}`, extra: `/logs/extra-${n}` },
  }));
  const s = setup(t, text, n => ({
    isError: n !== 1,
    details: { approved: n === 1, ...artifacts[n - 1] },
    content: [{ type: 'text', text: n === 1 ? 'approved' : 'review failed' }],
  }));
  const result = await s.runnerRun();
  assert.equal(result.isError, true);
  assert.equal(result.details.completed, 1);
  assert.deepEqual(result.details.items, [
    { taskNumber: 2, task: 'first', completed: true, ...artifacts[0] },
    { taskNumber: 4, task: 'second', completed: false, ...artifacts[1] },
  ]);
  assert.deepEqual(s.calls.map(c => [c.taskNumber, c.task]), [[2, 'first'], [4, 'second']]);
  assert.equal(readFileSync(s.path, 'utf8'), text.replace('[ ] first', '[x] first'));
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[0].text, [
    'delegate-list stopped after 1 item(s): review failed',
    'Task 2 [completed]: first',
    '  worker session ID: worker-1',
    '  reviewer session ID: reviewer-1',
    '  extra session ID: extra-1',
    '  worker transcript log: /logs/worker-1',
    '  reviewer transcript log: /logs/reviewer-1',
    '  extra transcript log: /logs/extra-1',
    'Task 4 [not completed]: second',
    '  worker session ID: worker-2',
    '  reviewer session ID: reviewer-2',
    '  extra session ID: extra-2',
    '  worker transcript log: /logs/worker-2',
    '  reviewer transcript log: /logs/reviewer-2',
    '  extra transcript log: /logs/extra-2',
  ].join('\n'));
});

test('shell setup, reviewed task, and teardown run in cwd in order without model/reviewer commands', async t => {
  const text = '!printf setup > state\r\n- [ ] work\r\n!printf teardown >> state\r\n';
  const s = setup(t, text, (_n, path) => {
    assert.equal(readFileSync(join(s.ctx.cwd, 'state'), 'utf8'), 'setup');
    return pass;
  });
  const output = [];
  const result = await runDelegateList(s.path, { cwd: s.ctx.cwd, execute: async params => {
    s.calls.push(params);
    assert.equal(readFileSync(join(s.ctx.cwd, 'state'), 'utf8'), 'setup');
    return pass;
  }, onCommandOutput: event => output.push(event) });
  assert.equal(result.isError, false);
  assert.equal(result.details.completed, 1);
  assert.equal(result.details.commands.length, 2);
  assert.ok(result.details.commands.every(c => c.completed && c.exitCode === 0));
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].review, true);
  assert.equal(readFileSync(join(s.ctx.cwd, 'state'), 'utf8'), 'setupteardown');
  assert.equal(readFileSync(s.path, 'utf8'), text.replace('[ ]', '[x]'));
  assert.equal(output.length, 2);
});

test('shell stdout and stderr stream; duplicates consume once each per run, including checked-only lists', async t => {
  const s = setup(t, '!printf out; printf err >&2\n!printf out; printf err >&2\n- [x] done\n');
  for (let n = 0; n < 2; n++) {
    const output = [];
    const result = await runDelegateList(s.path, { cwd: s.ctx.cwd, execute: () => { throw new Error('no AI'); },
      onCommandOutput: event => output.push(event) });
    assert.equal(result.isError, false);
    assert.equal(result.details.commands.length, 2);
    assert.equal(output.filter(e => e.stream === 'stdout').map(e => e.text).join(''), 'outout');
    assert.equal(output.filter(e => e.stream === 'stderr').map(e => e.text).join(''), 'errerr');
  }
});

test('only column-one bang lines outside fences are commands; empty commands reject before execution', async t => {
  const s = setup(t, '```sh\n!exit 99\n```\n  !exit 99\n- !exit 99\n!printf ok\n');
  const result = await runDelegateList(s.path, { execute: () => pass, onCommandOutput: () => {} });
  assert.equal(result.isError, false);
  assert.equal(result.details.commands.length, 1);
  assert.deepEqual(uncheckedTasks('!echo hi\n- [ ] !regular assignment'), [{ task: '!regular assignment', offset: 12, taskNumber: 1 }]);
  writeFileSync(s.path, '!touch should-not-exist\n!   \n- [ ] work');
  const rejected = await s.run();
  assert.equal(rejected.isError, true);
  assert.equal(s.calls.length, 0);
});

test('nonzero command stops before task and teardown without changing source', async t => {
  const text = '!printf failure >&2; exit 7\n- [ ] work\n!touch teardown';
  const s = setup(t, text);
  const output = [];
  const result = await runDelegateList(s.path, { cwd: s.ctx.cwd, execute: () => { throw new Error('no AI'); },
    onCommandOutput: event => output.push(event) });
  assert.equal(result.isError, true);
  assert.equal(result.details.commands[0].exitCode, 7);
  assert.equal(result.details.commands[0].completed, false);
  assert.match(result.content[0].text, /exit 7/);
  assert.equal(readFileSync(s.path, 'utf8'), text);
  assert.equal(output.filter(e => e.stream === 'stderr').map(e => e.text).join(''), 'failure');
});

test('command cancellation terminates foreground work and prevents task and teardown', async t => {
  const s = setup(t, '!printf started; sleep 30\n- [ ] work\n!touch teardown');
  const controller = new AbortController();
  const result = await runDelegateList(s.path, { cwd: s.ctx.cwd, execute: () => { throw new Error('no AI'); },
    signal: controller.signal, onCommandOutput: event => {
      if (event.stream === 'stdout') controller.abort(new Error('cancel command'));
    } });
  assert.equal(result.isError, true);
  assert.equal(result.details.commands[0].completed, false);
  assert.match(result.content[0].text, /cancel command/);
});

test('consumed unique commands follow shifts while a worker runs', async t => {
  const s = setup(t, '!printf setup >> state\n- [ ] work\n!printf old >> state\n', (_n, path) => {
    writeFileSync(path, '# moved\n!printf setup >> state\n- [ ] work\n!printf old >> state\n');
    return pass;
  });
  const result = await s.run();
  assert.equal(result.isError, false);
  assert.equal(result.details.commands.length, 2);
  assert.equal(s.calls.length, 1);
  assert.equal(readFileSync(join(s.ctx.cwd, 'state'), 'utf8'), 'setupold');
});

test('shell commands added while a worker runs are refused, but the approved checkbox is kept', async t => {
  const s = setup(t, '- [ ] work\n', (_n, path) => {
    writeFileSync(path, '- [ ] work\n!touch injected\n');
    return pass;
  });
  const result = await s.run();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /appeared in the task file while a worker was running.*!touch injected/);
  assert.equal(result.details.commands, undefined);
  assert.equal(existsSync(join(s.ctx.cwd, 'injected')), false);
  assert.match(readFileSync(s.path, 'utf8'), /\[x\] work/);
});

test('review rejection triggers bounded revisions that carry the findings', async t => {
  const rejected = { isError: true, details: { approved: false, independentApproved: false,
    reviewStatus: 'failed', reviewReport: 'FAIL\nmissing test' } };
  let n = 0;
  const s = setup(t, '- [ ] work\n', () => (++n < 3 ? rejected : pass));
  const result = await s.run();
  assert.equal(result.isError, false);
  assert.equal(s.calls.length, 3);
  assert.doesNotMatch(s.calls[0].context, /missing test/);
  assert.match(s.calls[1].context, /rejected by independent review[\s\S]*missing test/);
  assert.equal(result.details.items[0].revisions, 2);
  assert.match(result.content[0].text, /revisions after review rejection: 2/);

  const always = setup(t, '- [ ] work\n', () => rejected);
  const stopped = await always.run();
  assert.equal(stopped.isError, true);
  assert.equal(always.calls.length, 3);
  assert.match(readFileSync(always.path, 'utf8'), /\[ \] work/);
});

test('dropped approval after an edit is reported in the result', async t => {
  const s = setup(t, '- [ ] work\n', (n, path) => {
    if (n === 1) writeFileSync(path, '- [ ] work edited\n');
    return pass;
  });
  const result = await s.run();
  assert.equal(result.isError, false);
  assert.equal(s.calls.length, 2);
  assert.match(result.details.items[0].note, /approval not recorded/);
  assert.match(result.content[0].text, /note: approval not recorded/);
});

test('own checkbox writes do not repeat duplicate commands; external ambiguous edits stop safely', async t => {
  const s = setup(t, '!true\n- [ ] work\n!true\n');
  assert.equal((await s.run()).details.commands.length, 2);
  writeFileSync(s.path, '!true\n- [ ] changed\n!true\n');
  const result = await runDelegateList(s.path, { execute: () => {
    writeFileSync(s.path, '# shift\n!true\n- [ ] changed\n!true\n');
    return pass;
  }, onCommandOutput: () => {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ambiguous/);
  assert.equal(result.details.commands.length, 1);
});

test('failed mandatory AI review skips shell teardown and preserves unchecked task', async t => {
  const s = setup(t, '!true\n- [ ] work\n!exit 99\n', () => ({ isError: true,
    details: { approved: false, independentApproved: false, reviewStatus: 'failed' } }));
  const result = await s.run();
  assert.equal(result.isError, true);
  assert.equal(result.details.commands.length, 1);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].review, true);
  assert.match(readFileSync(s.path, 'utf8'), /\[ \] work/);
});

test('background command with redirected streams lets task proceed and teardown stops service', async t => {
  if (process.platform === 'win32') return t.skip('POSIX background shell syntax');
  const s = setup(t, '!sleep 30 </dev/null >service.log 2>&1 & echo $! >service.pid\n- [ ] work\n!kill "$(cat service.pid)"\n', () => {
    const pid = Number(readFileSync(join(s.ctx.cwd, 'service.pid'), 'utf8'));
    process.kill(pid, 0);
    return pass;
  });
  t.after(() => {
    try { process.kill(Number(readFileSync(join(s.ctx.cwd, 'service.pid'), 'utf8')), 'SIGKILL'); } catch { /* stopped or fixture removed */ }
  });
  const result = await s.run();
  assert.equal(result.isError, false);
  assert.equal(result.details.commands.length, 2);
  assert.equal(s.calls.length, 1);
});
