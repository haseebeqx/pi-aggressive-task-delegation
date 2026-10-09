import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, SettingsManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { createStandaloneExecutor, launcherExtensionPath } from '../src/standalone-runner.js';
import { rolePrompts } from '../src/workflow.js';

// Keep the production executor boundary, but expose runAgent results/errors directly.
async function rawStandaloneExecutor(options) {
  const sourceUrl = new URL('../src/standalone-runner.js', import.meta.url);
  let source = await readFile(sourceUrl, 'utf8');
  source = source.replace(
    "import { createDelegator, rolePrompts, emptyUsage, addUsage } from './workflow.js';",
    "import { rolePrompts, emptyUsage, addUsage } from './workflow.js';\n" +
      "const createDelegator = (runAgent) => (params, signal) => runAgent(params.role ?? 'worker', params.task, signal);",
  );
  source = source.replace(/\bfrom\s+(['"])(\.\.?\/[^'"]+)\1/g,
    (_, quote, specifier) => `from ${quote}${new URL(specifier, sourceUrl).href}${quote}`);
  source = source.replace("new URL('./extension.js', import.meta.url)",
    `new URL(${JSON.stringify(new URL('./extension.js', sourceUrl).href)})`);
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  return module.createStandaloneExecutor(options);
}

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

test('review:false forwards through executor: only worker session, private log and usage', async t => {
  const f = fixture(t, ['done']);
  const progress = [];
  const executor = createStandaloneExecutor({ cwd: f.dir, agentDir: f.dir, sdk: f.sdk,
    onProgress: phase => progress.push(phase) });
  const result = await executor.execute({ task: 'work', review: false });
  assert.equal(result.isError, false);
  assert.equal(result.details.completed, true);
  assert.equal(result.details.approved, true);
  assert.equal(result.details.independentApproved, false);
  assert.equal(result.details.reviewStatus, 'skipped');
  assert.equal(f.sessions.length, 1);
  assert.equal(f.loaders.length, 1);
  assert.deepEqual(Object.keys(result.details.logs), ['worker']);
  assert.equal(statSync(result.details.logs.worker).mode & 0o777, 0o600);
  assert.equal(result.usage.input, 3);
  assert.equal(result.usage.output, 2);
  assert.deepEqual(progress, ['Working', 'worker: initializing']);
  assert.equal(f.sessions[0].disposed && f.sessions[0].shutdown && f.sessions[0].unsubscribed, true);
});

test('raw standalone success returns the real session ID, report and metadata', async (t) => {
  const f = fixture(t, ['completed work']);
  const executor = await rawStandaloneExecutor({ cwd: f.dir, agentDir: f.dir, sdk: f.sdk });
  const result = await executor.execute({ task: 'work' });
  assert.equal(f.options.length, 1);
  assert.strictEqual(result.sessionId, f.options[0].sessionManager.getSessionId());
  assert.equal(result.report, 'completed work');
  assert.equal(result.usage.input, 3);
  assert.equal(result.usage.output, 2);
  assert.equal(result.logPath, f.options[0].sessionManager.getSessionFile());
  assert.equal(statSync(result.logPath).mode & 0o777, 0o600);
  assert.equal(f.sessions[0].disposed && f.sessions[0].shutdown && f.sessions[0].unsubscribed, true);
});

test('raw standalone success tolerates a session manager without optional getSessionId', async (t) => {
  const f = fixture(t, ['completed work']);
  const withoutSessionId = (manager) => {
    manager.getSessionId = undefined;
    return manager;
  };
  f.sdk.SessionManager = {
    create: (...args) => withoutSessionId(SessionManager.create(...args)),
    open: (...args) => withoutSessionId(SessionManager.open(...args)),
  };
  const executor = await rawStandaloneExecutor({ cwd: f.dir, agentDir: f.dir, sdk: f.sdk });
  const result = await executor.execute({ task: 'work' });
  assert.equal(f.options.length, 1);
  assert.ok(f.options[0].sessionManager instanceof SessionManager);
  assert.equal(f.options[0].sessionManager.getSessionId, undefined);
  assert.equal(result.sessionId, undefined);
  assert.equal(result.report, 'completed work');
  assert.equal(result.usage.input, 3);
  assert.equal(result.usage.output, 2);
  assert.equal(result.logPath, f.options[0].sessionManager.getSessionFile());
  assert.equal(statSync(result.logPath).mode & 0o777, 0o600);
  assert.equal(f.sessions[0].disposed && f.sessions[0].shutdown && f.sessions[0].unsubscribed, true);
});

test('raw standalone prompt failure wraps the cause and retains session metadata, usage and private log', async (t) => {
  const original = new Error('prompt failed');
  const f = fixture(t, ['unused'], () => { throw original; });
  const executor = await rawStandaloneExecutor({ cwd: f.dir, agentDir: f.dir, sdk: f.sdk });
  await assert.rejects(executor.execute({ task: 'work' }), (error) => {
    assert.ok(error instanceof Error);
    assert.notStrictEqual(error, original);
    assert.strictEqual(error.cause, original);
    assert.equal(f.options.length, 1);
    const manager = f.options[0].sessionManager;
    assert.strictEqual(error.sessionId, manager.getSessionId());
    assert.strictEqual(error.logPath, manager.getSessionFile());
    const log = statSync(error.logPath);
    assert.equal(log.isFile(), true);
    assert.equal(log.mode & 0o777, 0o600);
    assert.equal(error.usage.input, 3);
    assert.equal(error.usage.output, 2);
    assert.equal(f.sessions.length, 1);
    assert.equal(f.sessions[0].shutdown, true);
    assert.equal(f.sessions[0].disposed, true);
    assert.equal(f.sessions[0].unsubscribed, true);
    return true;
  });
});

test('raw standalone prompt failure tolerates a session manager without optional getSessionId', async (t) => {
  const original = new Error('prompt failed');
  const f = fixture(t, ['unused'], () => { throw original; });
  const withoutSessionId = (manager) => {
    manager.getSessionId = undefined;
    return manager;
  };
  f.sdk.SessionManager = {
    create: (...args) => withoutSessionId(SessionManager.create(...args)),
    open: (...args) => withoutSessionId(SessionManager.open(...args)),
  };
  const executor = await rawStandaloneExecutor({ cwd: f.dir, agentDir: f.dir, sdk: f.sdk });
  await assert.rejects(executor.execute({ task: 'work' }), (error) => {
    assert.ok(error instanceof Error);
    assert.notStrictEqual(error, original);
    assert.strictEqual(error.cause, original);
    assert.equal(f.options.length, 1);
    const manager = f.options[0].sessionManager;
    assert.ok(manager instanceof SessionManager);
    assert.equal(manager.getSessionId, undefined);
    assert.equal(error.sessionId, undefined);
    assert.strictEqual(error.logPath, manager.getSessionFile());
    const log = statSync(error.logPath);
    assert.equal(log.isFile(), true);
    assert.equal(log.mode & 0o777, 0o600);
    assert.equal(error.usage.input, 3);
    assert.equal(error.usage.output, 2);
    assert.equal(f.sessions.length, 1);
    assert.equal(f.sessions[0].shutdown, true);
    assert.equal(f.sessions[0].disposed, true);
    assert.equal(f.sessions[0].unsubscribed, true);
    return true;
  });
});

test('raw standalone factory failure retains the reopened session metadata and private log', async (t) => {
  const original = new Error('createAgentSession failed');
  const f = fixture(t);
  let reopenedManager;
  f.sdk.SessionManager = {
    create: (...args) => SessionManager.create(...args),
    open: (...args) => {
      reopenedManager = SessionManager.open(...args);
      return reopenedManager;
    },
  };
  f.sdk.createAgentSession = async (options) => {
    assert.strictEqual(options.sessionManager, reopenedManager);
    throw original;
  };
  const executor = await rawStandaloneExecutor({ cwd: f.dir, agentDir: f.dir, sdk: f.sdk });
  await assert.rejects(executor.execute({ task: 'work' }), (error) => {
    assert.ok(error instanceof Error);
    assert.notStrictEqual(error, original);
    assert.strictEqual(error.cause, original);
    assert.ok(reopenedManager instanceof SessionManager);
    assert.strictEqual(error.sessionId, reopenedManager.getSessionId());
    assert.strictEqual(error.logPath, reopenedManager.getSessionFile());
    const log = statSync(error.logPath);
    assert.equal(log.isFile(), true);
    assert.equal(log.mode & 0o777, 0o600);
    assert.equal(f.sessions.length, 0);
    return true;
  });
});

test('raw standalone resource loader reload failure retains the reopened session metadata and private log', async (t) => {
  const original = new Error('resource loader reload failed');
  const f = fixture(t);
  let reopenedManager;
  f.sdk.SessionManager = {
    create: (...args) => SessionManager.create(...args),
    open: (...args) => {
      reopenedManager = SessionManager.open(...args);
      return reopenedManager;
    },
  };
  f.sdk.DefaultResourceLoader = class extends f.sdk.DefaultResourceLoader {
    async reload() { throw original; }
  };
  const executor = await rawStandaloneExecutor({ cwd: f.dir, agentDir: f.dir, sdk: f.sdk });
  await assert.rejects(executor.execute({ task: 'work' }), (error) => {
    assert.ok(error instanceof Error);
    assert.notStrictEqual(error, original);
    assert.strictEqual(error.cause, original);
    assert.ok(reopenedManager instanceof SessionManager);
    assert.strictEqual(error.sessionId, reopenedManager.getSessionId());
    assert.strictEqual(error.logPath, reopenedManager.getSessionFile());
    const log = statSync(error.logPath);
    assert.equal(log.isFile(), true);
    assert.equal(log.mode & 0o777, 0o600);
    assert.equal(f.options.length, 0);
    assert.equal(f.sessions.length, 0);
    return true;
  });
});

test('raw standalone open failure retains the created session metadata and seeded private log', async (t) => {
  const original = new Error('SessionManager.open failed');
  const f = fixture(t);
  let createdManager;
  let openReached = false;
  f.sdk.SessionManager = {
    create: (...args) => {
      createdManager = SessionManager.create(...args);
      return createdManager;
    },
    open: (logPath) => {
      openReached = true;
      assert.ok(createdManager instanceof SessionManager);
      assert.strictEqual(logPath, createdManager.getSessionFile());
      const log = statSync(logPath);
      assert.equal(log.isFile(), true);
      assert.equal(log.mode & 0o777, 0o600);
      throw original;
    },
  };
  const executor = await rawStandaloneExecutor({ cwd: f.dir, agentDir: f.dir, sdk: f.sdk });
  await assert.rejects(executor.execute({ task: 'work' }), (error) => {
    assert.ok(error instanceof Error);
    assert.notStrictEqual(error, original);
    assert.strictEqual(error.cause, original);
    assert.equal(openReached, true);
    assert.ok(createdManager instanceof SessionManager);
    assert.strictEqual(error.sessionId, createdManager.getSessionId());
    assert.strictEqual(error.logPath, createdManager.getSessionFile());
    const log = statSync(error.logPath);
    assert.equal(log.isFile(), true);
    assert.equal(log.mode & 0o777, 0o600);
    assert.equal(f.options.length, 0);
    assert.equal(f.sessions.length, 0);
    return true;
  });
});
