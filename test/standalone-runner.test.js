import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, SettingsManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { createStandaloneExecutor, launcherExtensionPath } from '../src/standalone-runner.js';
import { rolePrompts } from '../src/workflow.js';

function fixture(t, reports = ['done', 'PASS\nchecked'], hook) {
  const dir = mkdtempSync(join(tmpdir(), 'standalone-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const loaders = [], sessions = [], options = [];
  const sdk = { SessionManager,
    SettingsManager: { create: () => ({
      getGlobalSettings: () => ({ extensions: ['safe.js'] }),
      getProjectSettings: () => ({ extensions: [`+${launcherExtensionPath}`] }),
    }) },
    createCodemodeExtension: () => () => {}, createToolSearchExtension: () => () => {},
    createMcpExtension: () => () => {},
    DefaultResourceLoader: class {
      constructor(opts) { this.options = opts; loaders.push(this); }
      async reload() {
        for (const scope of ['getGlobalSettings', 'getProjectSettings']) {
          assert.equal(this.options.settingsManager[scope]().extensions.at(-1), `-${launcherExtensionPath}`);
        }
      }
    },
    async createAgentSession(opts) {
      options.push(opts);
      let listener;
      const session = { messages: [], agent: {}, disposed: false, aborted: false,
        extensionRunner: { emit: async () => { session.shutdown = true; } },
        subscribe(fn) { listener = fn; return () => { session.unsubscribed = true; }; },
        async bindExtensions() { session.bound = true; },
        async abort() { session.aborted = true; },
        dispose() { session.disposed = true; },
        async prompt(text) {
          assert.equal(session.bound, true);
          session.assignment = text;
          listener({ type: 'message_end', message: { role: 'toolResult', usage: { output: 2 } } });
          listener({ type: 'message_end', message: { role: 'assistant', usage: { input: 3 } } });
          await hook?.(session);
          session.messages.push({ role: 'assistant', stopReason: 'stop',
            content: [{ type: 'text', text: reports[sessions.indexOf(session)] }] });
        },
      };
      sessions.push(session);
      return { session };
    },
  };
  return { dir, sdk, loaders, sessions, options };
}

test('independent sessions, prompts, credentials, private logs, usage and reviewer gate', async (t) => {
  const f = fixture(t);
  const progress = [], runtime = {};
  const executor = createStandaloneExecutor({ cwd: f.dir, agentDir: f.dir, sdk: f.sdk,
    modelRuntime: runtime, model: { id: 'test' }, thinkingLevel: 'high',
    onProgress: (phase) => progress.push(phase) });
  const result = await executor.execute({ task: 'implement', context: 'constraints' });
  assert.equal(result.details.approved, true);
  assert.equal(result.usage.input, 6);
  assert.equal(result.usage.output, 4);
  assert.deepEqual(progress, ['Working', 'worker: initializing', 'Reviewing', 'reviewer: initializing']);
  assert.notEqual(f.loaders[0], f.loaders[1]);
  assert.notEqual(f.options[0].sessionManager, f.options[1].sessionManager);
  for (const [i, role] of ['worker', 'reviewer'].entries()) {
    assert.equal(f.loaders[i].options.appendSystemPromptOverride([])[0], rolePrompts[role]);
    const delegation = f.loaders[i].options.extensionFactories.find((ext) => ext.name === 'aggressive-task-delegation');
    const commands = [], tools = [];
    delegation.factory({ on() {}, registerCommand: (name) => commands.push(name),
      registerTool: (tool) => tools.push(tool.name) });
    assert.deepEqual(commands, ['delegate-tasks']);
    assert.deepEqual(tools, ['delegate_task']);
    assert.equal(f.options[i].modelRuntime, runtime);
    assert.equal(f.sessions[i].agent.streamFunction, undefined);
    assert.equal(f.options[i].tools, undefined);
    assert.equal(f.options[i].customTools, undefined);
    assert.equal(statSync(result.details.logs[role]).mode & 0o777, 0o600);
    assert.equal(f.sessions[i].disposed && f.sessions[i].shutdown && f.sessions[i].unsubscribed, true);
  }
  assert.match(f.sessions[1].assignment, /Worker report[\s\S]*done/);
});

test('review failure is not approved', async (t) => {
  const f = fixture(t, ['done', 'FAIL\nmissing tests']);
  const result = await createStandaloneExecutor({ cwd: f.dir, agentDir: f.dir, sdk: f.sdk }).execute({ task: 'work' });
  assert.equal(result.details.approved, false);
  assert.equal(result.isError, true);
});

test('cancellation aborts and disposes worker, preserves logs/usage, skips review', async (t) => {
  const controller = new AbortController();
  const f = fixture(t, ['done'], () => controller.abort());
  const result = await createStandaloneExecutor({ cwd: f.dir, agentDir: f.dir, sdk: f.sdk,
    signal: controller.signal }).execute({ task: 'work' });
  assert.equal(result.details.approved, false);
  assert.equal(f.sessions.length, 1);
  assert.equal(f.sessions[0].aborted, true);
  assert.equal(f.sessions[0].disposed, true);
  assert.ok(result.details.logs.worker);
  assert.equal(result.usage.input, 3);
});

test('missing report fails without reviewer', async (t) => {
  const f = fixture(t, ['']);
  const result = await createStandaloneExecutor({ cwd: f.dir, agentDir: f.dir, sdk: f.sdk }).execute({ task: 'work' });
  assert.equal(result.details.approved, false);
  assert.equal(f.sessions.length, 1);
});


test('real SDK discovery excludes launcher before its factory runs', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'settings.json'), JSON.stringify({ extensions: [launcherExtensionPath] }));
  f.sdk.SettingsManager = SettingsManager;
  f.sdk.DefaultResourceLoader = class extends DefaultResourceLoader {
    constructor(options) { super(options); f.loaders.push(this); }
  };
  const result = await createStandaloneExecutor({ cwd: f.dir, agentDir: f.dir, sdk: f.sdk }).execute({ task: 'work' });
  assert.equal(result.details.approved, true);
  for (const loader of f.loaders) {
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.equal(loader.getExtensions().extensions.some((ext) => ext.path === launcherExtensionPath), false);
  }
});

// Verify the factory boundary rather than faking a successful authenticated prompt:
// the SDK owns preflight and streaming, both configured by modelRuntime.
test('auth configuration reaches SDK factory; registry-only credentials are not bridged', async (t) => {
  const f = fixture(t);
  const runtime = { credential: 'fake-key' };
  const model = { id: 'fake-model', provider: 'fake-provider' };
  const calls = [];
  f.sdk.createAgentSession = async (options) => {
    calls.push(options);
    assert.equal(options.model, model);
    assert.equal(options.modelRegistry, undefined);
    // Stop at the SDK factory: no fake prompt can conceal SDK auth preflight.
    throw new Error('factory boundary reached');
  };
  const registry = { streamSimple() { assert.fail('must not bypass SDK authentication'); } };
  await createStandaloneExecutor({ cwd: f.dir, agentDir: f.dir, sdk: f.sdk,
    model, modelRuntime: runtime }).execute({ task: 'work' });
  assert.equal(calls[0].modelRuntime, runtime);
  await createStandaloneExecutor({ cwd: f.dir, agentDir: f.dir, sdk: f.sdk,
    model, modelRegistry: registry }).execute({ task: 'work' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].modelRuntime, undefined);
  assert.equal(calls[1].agentDir, f.dir);
});
