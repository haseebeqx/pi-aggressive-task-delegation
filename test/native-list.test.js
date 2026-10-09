import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeList } from '../src/native-list.js';

function fixture(t, onPrompt = () => {}, veto = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'native-list-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'tasks.md');
  writeFileSync(path, '- [ ] first\n- [ ] second\n');
  const host = new EventEmitter();
  const prompts = [], statuses = [], contexts = [], notifications = [];
  let input, switches = 0, aborts = 0;
  function context() {
    let stale = false;
    const branch = [];
    const sessionId = `native-${contexts.length}`;
    const assertFresh = () => assert.equal(stale, false, 'outgoing context reused');
    const ctx = { cwd, abort() { assertFresh(); aborts++; },
      async waitForIdle() { assertFresh(); },
      ui: { notify(text, level) { assertFresh(); notifications.push({ text, level }); }, setStatus(_key, value) { assertFresh(); statuses.push(value); },
        onTerminalInput(handler) { assertFresh(); input = handler; return () => { input = undefined; }; } },
      sessionManager: { getSessionId() { assertFresh(); return sessionId; }, getBranch() { assertFresh(); return branch; } },
      async newSession({ withSession }) {
        assertFresh();
        if (veto) return { cancelled: true };
        host.emit('delegate-list-session-shutdown', { reason: 'new' });
        switches++;
        stale = true;
        const fresh = context();
        await withSession(fresh);
        return { cancelled: false };
      },
      async sendUserMessage(text) {
        assertFresh();
        assert.deepEqual(branch, [], 'fresh native history');
        prompts.push(text);
        const stopReason = await onPrompt({ text, path, host, input, prompts, branch });
        branch.push({ type: 'message', message: { role: 'assistant', stopReason: stopReason || 'stop', content: [] } });
      },
    };
    contexts.push(ctx);
    return ctx;
  }
  return { path, host, prompts, statuses, notifications, ctx: context(), get switches() { return switches; }, get aborts() { return aborts; } };
}

test('fresh native contexts submit normal supervisor prompts sequentially and preserve appended items', async t => {
  const f = fixture(t, ({ path, prompts }) => {
    if (prompts.length === 1) appendFileSync(path, '- [ ] appended\n');
    if (prompts.length === 2) assert.match(readFileSync(path, 'utf8'), /^- \[x\] first/);
  });
  const result = await runNativeList(f.path, f.ctx, { host: f.host });
  assert.equal(result.isError, false);
  assert.equal(result.details.completed, 3);
  assert.equal(f.switches, 3);
  assert.deepEqual(result.details.items.map(item => item.sessionIds), [
    { supervisor: 'native-1' }, { supervisor: 'native-2' }, { supervisor: 'native-3' },
  ]);
  assert.match(f.notifications.at(-1).text, /Task 3 \[completed\]: appended\n  supervisor session ID: native-3/);
  assert.equal(f.notifications.at(-1).level, 'info');
  assert.match(f.prompts[0], /Do the work directly by default/);
  assert.match(f.prompts[0], /Task:\nfirst/);
  assert.doesNotMatch(f.prompts[1], /Task:\nfirst/);
  assert.match(f.prompts[2], /Task:\nappended/);
  assert.deepEqual(f.statuses, ['delegated task #1', 'delegated task #2', 'delegated task #3', undefined]);
  assert.equal(readFileSync(f.path, 'utf8'), '- [x] first\n- [x] second\n- [x] appended\n');
  assert.equal(f.host.listenerCount('SIGINT'), 0);
});

test('footer uses checkbox positions including previously completed items', async t => {
  const f = fixture(t);
  const text = '# Tasks\n- [x] one\n- [X] two\n- [x] three\n- [x] four\n- [x] five\n- [x] six\n```md\n- [ ] example\n```\n- [ ] seven\n- [x] eight\n- [ ] nine\n';
  writeFileSync(f.path, text);
  const result = await runNativeList(f.path, f.ctx, { host: f.host });
  assert.equal(result.isError, false);
  assert.equal(result.details.completed, 2);
  assert.deepEqual(f.statuses, ['delegated task #7', 'delegated task #9', undefined]);
  assert.equal(readFileSync(f.path, 'utf8'), text.replace('[ ] seven', '[x] seven').replace('[ ] nine', '[x] nine'));
});

for (const reason of ['error', 'aborted']) test(`native ${reason} leaves item unchecked`, async t => {
  const f = fixture(t, () => reason);
  const result = await runNativeList(f.path, f.ctx, { host: f.host });
  assert.equal(result.isError, true);
  assert.equal(f.switches, 1);
  assert.match(readFileSync(f.path, 'utf8'), /^- \[ \] first/);
  assert.equal(f.host.exitCode, 1);
  assert.equal(result.details.items[0].sessionIds.supervisor, 'native-1');
  assert.match(f.notifications.at(-1).text, /supervisor session ID: native-1/);
  assert.equal(f.notifications.at(-1).level, 'error');
});

for (const trigger of ['SIGINT', 'shutdown', 'ctrl+c', 'ctrl+escape']) test(`native ${trigger} aborts host and stops marking`, async t => {
  const f = fixture(t, ({ host, input }) => {
    if (trigger === 'SIGINT') host.emit('SIGINT');
    else if (trigger === 'shutdown') host.emit('delegate-list-session-shutdown', { reason: 'exit' });
    else assert.deepEqual(input(trigger === 'ctrl+c' ? '\x03' : '\x1b[27;5;27~'), { consume: true });
  });
  const result = await runNativeList(f.path, f.ctx, { host: f.host });
  assert.equal(result.isError, true);
  assert.equal(f.aborts, 1);
  assert.equal(f.host.exitCode, 130);
  assert.equal(result.details.items[0].sessionIds.supervisor, 'native-1');
  assert.match(f.notifications.at(-1).text, /supervisor session ID: native-1/);
  assert.equal(f.switches, 1);
  assert.match(readFileSync(f.path, 'utf8'), /^- \[ \] first/);
  assert.equal(f.host.listenerCount('SIGINT'), 0);
});

test('new-session veto stops without submitting a prompt', async t => {
  const f = fixture(t, undefined, true);
  const result = await runNativeList(f.path, f.ctx, { host: f.host });
  assert.equal(result.isError, true);
  assert.deepEqual(f.prompts, []);
  assert.equal(f.switches, 0);
  assert.deepEqual(result.details.items[0].sessionIds, {});
});

test('real Pi runtime supplies fresh command context and awaitable native prompting', async t => {
  const { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
    DefaultResourceLoader, SessionManager, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const f = fixture(t);
  const loader = new DefaultResourceLoader({ cwd: f.ctx.cwd, agentDir: f.ctx.cwd,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir: cwd,
      resourceLoader: loader, settingsManager: SettingsManager.inMemory() });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(factory, { cwd: f.ctx.cwd,
    agentDir: f.ctx.cwd, sessionManager: SessionManager.inMemory(f.ctx.cwd) });
  t.after(() => runtime.dispose());
  const bind = session => session.bindExtensions({ mode: 'tui', uiContext: f.ctx.ui,
    commandContextActions: { waitForIdle: () => session.waitForIdle(),
      newSession: options => runtime.newSession(options) } });
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  const outgoing = runtime.session;
  let fresh;
  const replacement = await runtime.newSession({ withSession: async ctx => { fresh = ctx; } });
  assert.equal(replacement.cancelled, false);
  assert.notEqual(runtime.session, outgoing);
  assert.equal(typeof fresh.newSession, 'function');
  assert.equal(typeof fresh.sendUserMessage, 'function');
  // No selected model: the real prompt pipeline must reject asynchronously,
  // rather than fire-and-forget like ExtensionAPI.sendUserMessage.
  runtime.session.agent.state.model = undefined;
  await assert.rejects(fresh.sendUserMessage('native prompt regression'), /model/i);
});

function toolResult(branch, toolCallId, details, toolName = 'delegate_task', isError = false) {
  branch.push({ type: 'message', message: { role: 'toolResult', toolName, toolCallId, details, isError } });
}

test('native child IDs and logs retain multiple call labels and task association in final notification', async t => {
  const f = fixture(t, ({ branch, prompts }) => {
    if (prompts.length !== 1) return;
    toolResult(branch, 'call-one', { sessionIds: { worker: 'worker-one', reviewer: 'review-one' }, logs: { worker: '/logs/one' } });
    toolResult(branch, 'call-two', { sessionIds: { worker: 'worker-two' }, logs: { worker: '/logs/two' } });
    toolResult(branch, 'ignored', { sessionIds: { worker: 'not-a-delegation' } }, 'bash');
  });
  const result = await runNativeList(f.path, f.ctx, { host: f.host });
  assert.equal(result.isError, false);
  assert.deepEqual(result.details.items[0].sessionIds, {
    supervisor: 'native-1',
    'delegate_task #1 (call-one) worker': 'worker-one',
    'delegate_task #1 (call-one) reviewer': 'review-one',
    'delegate_task #2 (call-two) worker': 'worker-two',
  });
  assert.deepEqual(result.details.items[0].logs, {
    'delegate_task #1 (call-one) worker': '/logs/one',
    'delegate_task #2 (call-two) worker': '/logs/two',
  });
  assert.deepEqual(result.details.items[1].sessionIds, { supervisor: 'native-2' });
  const text = f.notifications.at(-1).text;
  assert.match(text, /delegate_task #1 \(call-one\) worker session ID: worker-one/);
  assert.match(text, /delegate_task #2 \(call-two\) worker transcript log: \/logs\/two/);
  assert.doesNotMatch(text, /not-a-delegation/);
});

test('missing native/child IDs are omitted, without inferring IDs from tool calls or logs', async t => {
  const f = fixture(t, ({ branch }) => {
    toolResult(branch, 'not-a-session-id', undefined);
    toolResult(branch, undefined, { sessionIds: { worker: undefined, reviewer: '' }, logs: { worker: '/logs/only' } });
  });
  const newSession = f.ctx.newSession;
  f.ctx.newSession = options => newSession({ withSession: fresh => {
    delete fresh.sessionManager.getSessionId;
    return options.withSession(fresh);
  } });
  // One item is sufficient to exercise a host without session-ID metadata.
  writeFileSync(f.path, '- [ ] first\n');
  const result = await runNativeList(f.path, f.ctx, { host: f.host });
  assert.equal(result.isError, false);
  assert.deepEqual(result.details.items[0].sessionIds, {});
  assert.deepEqual(result.details.items[0].logs, { 'delegate_task #2 worker': '/logs/only' });
  assert.doesNotMatch(f.notifications.at(-1).text, /session ID:/);
});

for (const failure of ['error', 'throw', 'cancel']) test(`native ${failure} retains child failure metadata`, async t => {
  const f = fixture(t, ({ branch, host }) => {
    toolResult(branch, 'failed-call', { sessionIds: { worker: 'failed-worker' }, logs: { worker: '/logs/failed' } }, 'delegate_task', true);
    if (failure === 'throw') throw new Error('Prompt rejected');
    if (failure === 'cancel') host.emit('SIGINT');
    return 'error';
  });
  const result = await runNativeList(f.path, f.ctx, { host: f.host });
  assert.equal(result.isError, true);
  assert.equal(result.details.completed, 0);
  assert.deepEqual(result.details.items[0].sessionIds, { supervisor: 'native-1', 'delegate_task #1 (failed-call) worker': 'failed-worker' });
  assert.match(f.notifications.at(-1).text, /Task 1 \[not completed\]: first/);
  assert.match(f.notifications.at(-1).text, /failed-worker/);
  assert.match(f.notifications.at(-1).text, /\/logs\/failed/);
  assert.match(readFileSync(f.path, 'utf8'), /^- \[ \] first/);
});
