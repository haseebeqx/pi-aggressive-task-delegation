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
  const prompts = [], statuses = [], contexts = [];
  let input, switches = 0, aborts = 0;
  function context() {
    let stale = false;
    const branch = [];
    const assertFresh = () => assert.equal(stale, false, 'outgoing context reused');
    const ctx = { cwd, abort() { assertFresh(); aborts++; },
      async waitForIdle() { assertFresh(); },
      ui: { notify() { assertFresh(); }, setStatus(_key, value) { assertFresh(); statuses.push(value); },
        onTerminalInput(handler) { assertFresh(); input = handler; return () => { input = undefined; }; } },
      sessionManager: { getBranch() { assertFresh(); return branch; } },
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
        const stopReason = await onPrompt({ text, path, host, input, prompts });
        branch.push({ type: 'message', message: { role: 'assistant', stopReason: stopReason || 'stop', content: [] } });
      },
    };
    contexts.push(ctx);
    return ctx;
  }
  return { path, host, prompts, statuses, ctx: context(), get switches() { return switches; }, get aborts() { return aborts; } };
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
  assert.match(f.prompts[0], /context-preserving supervisor/);
  assert.match(f.prompts[0], /Task:\nfirst/);
  assert.doesNotMatch(f.prompts[1], /Task:\nfirst/);
  assert.match(f.prompts[2], /Task:\nappended/);
  assert.deepEqual(f.statuses, ['Currently running #1', 'Currently running #2', 'Currently running #3', undefined]);
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
  assert.deepEqual(f.statuses, ['Currently running #7', 'Currently running #9', undefined]);
  assert.equal(readFileSync(f.path, 'utf8'), text.replace('[ ] seven', '[x] seven').replace('[ ] nine', '[x] nine'));
});

for (const reason of ['error', 'aborted']) test(`native ${reason} leaves item unchecked`, async t => {
  const f = fixture(t, () => reason);
  const result = await runNativeList(f.path, f.ctx, { host: f.host });
  assert.equal(result.isError, true);
  assert.equal(f.switches, 1);
  assert.match(readFileSync(f.path, 'utf8'), /^- \[ \] first/);
  assert.equal(f.host.exitCode, 1);
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
