import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { registerCli } from '../src/extension.js';

function fixture(flag, overrides = {}, mode = 'print') {
  const handlers = {}, flags = {}, output = [], messages = [], commands = {};
  const notifications = [], statuses = [], inputHandlers = [];
  const host = new EventEmitter();
  let calls = 0, options, shutdowns = 0, inputCleanups = 0;
  const pi = { registerFlag: (n, o) => { flags[n] = o; }, getFlag: () => flag,
    registerCommand: (n, c) => { commands[n] = c; },
    sendUserMessage: (...args) => messages.push(args),
    on: (n, h) => { (handlers[n] ??= []).push(h); } };
  registerCli(pi, { host, write: s => output.push(s),
    createExecutor: o => { options = o; return { execute: () => {} }; },
    runList: async () => { calls++; return { isError: false, content: [{ type: 'text', text: 'done' }] }; },
    ...overrides });
  const ctx = { cwd: '/work', model: { id: 'selected' }, thinkingLevel: 'high', mode,
    sessionManager: { getBranch: () => [] },
    hasUI: mode === 'tui', shutdown: () => shutdowns++, ui: {
      notify: (text, type) => { notifications.push([text, type]); output.push(text); },
      setStatus: (key, text) => statuses.push([key, text]),
      onTerminalInput: handler => {
        inputHandlers.push(handler);
        return () => {
          inputCleanups++;
          const index = inputHandlers.indexOf(handler);
          if (index !== -1) inputHandlers.splice(index, 1);
        };
      },
    } };
  const emit = async (name, event = {}) => { for (const h of handlers[name] ?? []) await h(event, ctx); };
  return { flags, host, output, messages, commands, ctx, emit,
    notifications, statuses, inputHandlers,
    get inputCleanups() { return inputCleanups; },
    start: (reason = 'startup') => emit('session_start', { reason }),
    get calls() { return calls; }, get options() { return options; }, get shutdowns() { return shutdowns; } };
}

test('string flag only; startup runs once, not reload/new/resume/fork', async () => {
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

for (const trigger of ['SIGINT', 'shutdown']) {
  test(`noninteractive cancellation via ${trigger} cleans up`, async () => {
    let entered;
    const ready = new Promise(r => { entered = r; });
    const f = fixture('tasks.md', { runList: async (_p, { signal }) => {
      entered();
      await new Promise(r => signal.addEventListener('abort', r, { once: true }));
      return { isError: true, content: [{ type: 'text', text: 'cancelled' }] };
    } });
    const work = f.start(); await ready;
    if (trigger === 'SIGINT') f.host.emit('SIGINT');
    else await f.emit('session_shutdown');
    await work;
    assert.equal(f.options.signal.aborted, true);
    assert.equal(f.host.exitCode, 130);
    assert.equal(f.host.listenerCount('SIGINT'), 0);
  });
}

test('failure and setup errors route to stderr and exit status', async () => {
  for (const overrides of [
    { runList: async () => ({ isError: true, content: [{ type: 'text', text: 'failed review' }] }) },
    { createExecutor: () => { throw new Error('setup failed'); } },
  ]) {
    const f = fixture('', overrides); await f.start();
    assert.equal(f.host.exitCode, 1);
    assert.match(f.output.at(-1), /failed/);
  }
});

test('RPC requests shutdown; print and JSON do not', async () => {
  for (const mode of ['rpc', 'print', 'json']) {
    const f = fixture('tasks.md', {}, mode); await f.start();
    assert.equal(f.shutdowns, mode === 'rpc' ? 1 : 0);
  }
});


for (const mode of ['print', 'json', 'rpc']) {
  test(`${mode} forwards runtime output without adding Main messages`, async () => {
    const { initTheme } = await import('@earendil-works/pi-coding-agent');
    initTheme('dark');
    let view, onOutput;
    const f = fixture('tasks.md', {
      createExecutor: options => {
        onOutput = options.onOutput;
        return { execute: async () => {
          onOutput({ reset: true, task: 'first' });
          onOutput({ role: 'worker', event: { type: 'message_end', message: {
            role: 'assistant', content: [{ type: 'text', text: 'Live answer' }],
          } } });
          onOutput({ role: 'worker', event: { type: 'tool_execution_start',
            toolCallId: '1', toolName: 'bash', args: { command: 'pwd' } } });
          onOutput({ role: 'worker', event: { type: 'tool_execution_end',
            toolCallId: '1', toolName: 'bash', result: { content: [{ type: 'text', text: 'Tool output' }] } } });
          if (mode === 'tui') {
            assert.match(view.render(80).join('\n'), /Live answer/);
            assert.match(view.render(80).join('\n'), /Tool output/);
          }
          onOutput({ reset: true, task: 'second' });
          if (mode === 'tui') assert.deepEqual(view.render(80), []);
        } };
      },
      runList: async (_path, options) => {
        await options.execute({ task: 'first' }, options.signal);
        return { content: [{ type: 'text', text: 'done' }] };
      },
    }, mode);
    f.ctx.ui.setWidget = (_key, factory) => {
      assert.equal(mode, 'tui');
      view = factory({ requestRender() {} });
    };
    await f.start();
    if (mode !== 'tui') {
      assert.ok(f.output.includes('worker: Live answer'));
      assert.ok(f.output.includes('worker: running bash'));
      assert.ok(f.output.includes('worker: bash finished'));
    }
    const before = [...f.output];
    onOutput({ reset: true, task: 'late' });
    assert.deepEqual(f.output, before);
    assert.deepEqual(f.messages, []);
  });
}

 test('TUI startup dispatches a native command, without SDK execution', async () => {
  const f = fixture('tasks.md', { createExecutor: () => assert.fail('SDK must not run') }, 'tui');
  await f.start(); await f.start(); await f.start('new');
  assert.deepEqual(f.messages, [['/delegate-list-run', { expandPromptTemplates: true }]]);
  assert.equal(f.calls, 0);
  assert.ok(f.commands['delegate-list-run']);
});
