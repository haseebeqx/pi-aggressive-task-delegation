import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { registerCli } from '../src/extension.js';

function fixture(flag, overrides = {}, mode = 'print') {
  const handlers = {}, flags = {}, output = [];
  const host = new EventEmitter();
  let calls = 0, options, input, removed = false, shutdowns = 0;
  const widgets = [], statuses = [];
  const pi = { registerFlag: (n, o) => { flags[n] = o; }, getFlag: () => flag,
    on: (n, h) => { handlers[n] = h; } };
  registerCli(pi, { host, write: (s) => output.push(s),
    createExecutor: (o) => { options = o; return { execute: () => {} }; },
    runList: async () => { calls++; return { isError: false, content: [{ type: 'text', text: 'done' }] }; },
    ...overrides });
  const ctx = { cwd: '/work', model: { id: 'selected' }, thinkingLevel: 'high', mode,
    hasUI: mode === 'tui', shutdown: () => shutdowns++, ui: {
      setStatus: (key, text) => statuses.push({ key, text }), setWidget: (key, lines) => widgets.push({ key, lines }), notify: (s) => output.push(s),
      onTerminalInput: (h) => { input = h; return () => { removed = true; }; },
    } };
  return { handlers, flags, host, output, widgets, statuses, ctx, start: (reason = 'startup') => handlers.session_start({ reason }, ctx),
    get calls() { return calls; }, get options() { return options; }, get removed() { return removed; },
    get shutdowns() { return shutdowns; }, key: (s) => input(s) };
}

test('string flag only; no flag is inert; startup runs once, not reload/new/resume/fork', async () => {
  const absent = fixture(undefined); await absent.start(); assert.equal(absent.calls, 0);
  assert.equal(absent.flags['delegate-list'].type, 'string');
  const f = fixture('tasks.md');
  for (const reason of ['reload', 'new', 'resume', 'fork']) await f.start(reason);
  assert.equal(f.calls, 0);
  await f.start(); await f.start();
  assert.equal(f.calls, 1);
  assert.equal(f.options.model, f.ctx.model);
  assert.equal(f.options.thinkingLevel, 'high');
  assert.equal(f.options.modelRuntime, undefined);
  assert.equal(f.host.listenerCount('SIGINT'), 0);
  assert.ok(f.output.includes('done'));
  // A newly registered runtime also ignores reload.
  const reload = fixture('tasks.md'); await reload.start('reload'); assert.equal(reload.calls, 0);
});

for (const trigger of ['SIGINT', 'shutdown', 'ctrl+c', 'ctrl+escape']) {
  test(`cancellation via ${trigger} reaches executor and cleans up`, async () => {
    let entered;
    const ready = new Promise((r) => { entered = r; });
    const f = fixture('tasks.md', { runList: async (_p, { signal }) => {
      entered();
      await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
      return { isError: true, content: [{ type: 'text', text: 'cancelled' }] };
    } }, 'tui');
    const work = f.start(); await ready;
    if (trigger === 'SIGINT') f.host.emit('SIGINT');
    else if (trigger === 'shutdown') f.handlers.session_shutdown();
    else assert.deepEqual(f.key(trigger === 'ctrl+c' ? '\x03' : '\x1b[27;5;27~'), { consume: true });
    await work;
    assert.equal(f.options.signal.aborted, true);
    assert.equal(f.host.exitCode, 130);
    assert.equal(f.removed, true);
    assert.equal(f.host.listenerCount('SIGINT'), 0);
  });
}

test('failure outcomes and thrown setup errors route to stderr and exit status', async () => {
  for (const overrides of [
    { runList: async () => ({ isError: true, content: [{ type: 'text', text: 'failed review' }] }) },
    { createExecutor: () => { throw new Error('setup failed'); } },
  ]) {
    const f = fixture('', overrides); await f.start();
    assert.equal(f.host.exitCode, 1);
    assert.match(f.output.at(-1), /failed/);
  }
});

test('live child output is shown and replaced for the next task', async () => {
  const f = fixture('tasks.md', {}, 'tui');
  await f.start();
  const emit = f.options.onOutput;
  emit({ task: 'First task', reset: true });
  const first = f.widgets.at(-1).lines;
  assert.equal(typeof first, 'function');
  const view = first({ requestRender() {} });
  assert.deepEqual(view.render(80), []);
  emit({ task: 'Second task', reset: true });
  assert.notEqual(f.widgets.at(-1).lines, first);
  assert.deepEqual(f.widgets.at(-1).lines({ requestRender() {} }).render(80), []);
});

test('RPC requests supported shutdown; print and TUI do not', async () => {
  for (const mode of ['rpc', 'print', 'json', 'tui']) {
    const f = fixture('tasks.md', {}, mode); await f.start();
    assert.equal(f.shutdowns, mode === 'rpc' ? 1 : 0);
  }
});

for (const fail of [false, true]) {
  test(`task status advances and clears after ${fail ? 'failure' : 'completion'}`, async () => {
    const f = fixture('tasks.md', { runList: async (_path, { execute, signal }) => {
      await execute({ task: 'First' }, signal);
      await execute({ task: 'Second' }, signal);
      if (fail) throw new Error('failed');
      return { isError: false, content: [] };
    } }, 'tui');
    await f.start();
    assert.deepEqual(f.statuses, [
      { key: 'delegate-list', text: 'delegate-list: running task #1' },
      { key: 'delegate-list', text: 'delegate-list: running task #2' },
      { key: 'delegate-list', text: undefined },
    ]);
  });
}
