import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import extension from '../src/extension.js';
import { addUsage, emptyUsage, rolePrompts, supervisorPrompt } from '../src/interactive-workflow.js';

// Evaluate the real runner with explicit dependencies, without starting an SDK
// session or routing its result through the workflow's error/result conversion.
// Hooks receive state so tests can abort a controller or hold an async boundary.
function createRunnerHarness(options = {}) {
  const state = {
    createdId: 'created-manager-id', openedId: 'opened-manager-id',
    logPath: '/mock/delegation/child.jsonl', logDirectory: '/mock/delegation',
    report: 'Completed child report.', usage: {
      input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
      cost: { input: 0.11, output: 0.07, cacheRead: 0.03, cacheWrite: 0.02, total: 0.23 },
    },
    loaderOptions: [], reloads: 0, creates: [], opens: [], seeds: [],
    entries: [], sessionOptions: [], prompts: [], runners: [],
    subscriptions: 0, unsubscriptions: 0, aborts: 0, disposals: 0,
    entered: [], updated: [], left: [], allocations: [], streamCalls: [],
  };
  const listeners = new Set();
  const emit = (event) => { for (const listener of listeners) listener(event); };
  const createdManager = {
    getSessionFile: () => '/mock/created-but-not-opened.jsonl',
  };
  if (!options.createdWithoutGetSessionId) createdManager.getSessionId = () => state.createdId;
  const openedManager = {
    getSessionFile: () => state.logPath,
    appendCustomEntry: (...args) => state.entries.push(args),
  };
  if (!options.withoutGetSessionId) openedManager.getSessionId = () => state.openedId;
  const session = {
    agent: {}, messages: [],
    subscribe(listener) {
      state.subscriptions++;
      listeners.add(listener);
      return () => { state.unsubscriptions++; listeners.delete(listener); };
    },
    async prompt(prompt) {
      state.prompts.push(prompt);
      await options.onPrompt?.(state, session, emit);
      if (options.promptError) throw options.promptError;
      const message = {
        role: 'assistant', content: [{ type: 'text', text: state.report }],
        usage: structuredClone(state.usage), stopReason: 'stop',
        api: 'mock', provider: 'mock', model: 'mock', timestamp: 0,
      };
      session.messages.push(message);
      emit({ type: 'message_end', message });
    },
    async abort() { state.aborts++; await options.onAbort?.(state, session); },
    dispose() { state.disposals++; },
  };
  class MockResourceLoader {
    constructor(config) { state.loaderOptions.push(config); }
    async reload() {
      state.reloads++;
      await options.onReload?.(state);
      if (options.initError) throw options.initError;
    }
  }
  class MockView {
    open(parent, signal) { return { parent, controller: new AbortController(), signal }; }
    enter(scope, child, role, task) {
      const node = { scope, session: child, role, task };
      state.entered.push(node);
      return node;
    }
    update(node) { state.updated.push(node); }
    leave(node) { state.left.push(node); }
    async finish() {}
    async input() { return false; }
    cancel() { return false; }
    shutdown() {}
  }
  class MockFooter { focus() {} refresh() {} restore() {} }
  class MockTranscript { records = new Map(); restore() {} }
  const schema = (value) => value;
  const definition = (cwd) => ({ cwd });
  const mocks = {
    delegationDescription: 'Mock delegation',
    AssistantMessageComponent: class {}, ToolExecutionComponent: class {}, FooterComponent: class {},
    createAgentSession: async (config) => {
      state.sessionOptions.push(config);
      await options.onCreateAgentSession?.(state, session);
      if (options.createAgentSessionError) throw options.createAgentSessionError;
      return { session };
    },
    DefaultResourceLoader: MockResourceLoader,
    getAgentDir: () => '/mock/agent',
    SessionManager: {
      create: (...args) => { state.creates.push(args); return createdManager; },
      open: (...args) => {
        state.opens.push(args);
        if (options.openError) throw options.openError;
        return openedManager;
      },
    },
    createBashToolDefinition: definition, createEditToolDefinition: definition,
    createFindToolDefinition: definition, createGrepToolDefinition: definition,
    createLsToolDefinition: definition, createPowerShellToolDefinition: definition,
    createReadToolDefinition: definition, createWriteToolDefinition: definition,
    Type: Object.fromEntries(['Object', 'String', 'Optional', 'Union', 'Literal', 'Boolean']
      .map((key) => [key, schema])),
    Text: class {},
    createDelegationWidgets: () => ({}), updateDelegationMessage: () => false,
    DelegationView: MockView, DelegationFooter: MockFooter, DelegationTranscript: MockTranscript,
    OUTPUT_ENTRY: 'mock-output', createTranscriptComponent: () => ({}),
    existsSync: (path) => options.logExists !== false && path === state.logPath,
    randomUUID: () => 'mock-ephemeral-parent',
    allocateLogDirectory: (...args) => {
      state.allocations.push(args);
      return state.logDirectory;
    },
    seedPrivateSession: (manager) => {
      state.seeds.push(manager);
      if (options.seedError) throw options.seedError;
      return state.logPath;
    },
    inheritTools: (ctx, tool, config) => ({ tools: ctx.tools, customTools: [tool], ...config }),
    addUsage, emptyUsage, rolePrompts, supervisorPrompt,
    createDelegator: (runner, config) => {
      state.runners.push({ runner, config });
      // Intentionally no workflow: tests invoke the captured runner directly.
      return () => { throw new Error('Invoke harness.runner, not the workflow mock.'); };
    },
  };
  const source = readFileSync(new URL('../src/interactive-delegation.js', import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace('export default function taskDivider', 'function taskDivider');
  const taskDivider = new Function(...Object.keys(mocks), `${source}\nreturn taskDivider;`)
    (...Object.values(mocks));
  const tools = [], hooks = {}, commands = {}, shortcuts = {};
  const pi = {
    registerTool: (tool) => tools.push(tool),
    registerEntryRenderer() {}, appendEntry() {}, sendUserMessage() {},
    on: (name, handler) => { (hooks[name] ??= []).push(handler); },
    registerCommand: (name, command) => { commands[name] = command; },
    registerShortcut: (name, shortcut) => { shortcuts[name] = shortcut; },
  };
  taskDivider(pi);
  const ctx = {
    cwd: '/mock/project', model: { id: 'parent-model', provider: 'mock' },
    thinkingLevel: 'medium', hasUI: false, mode: 'json', tools: [],
    sessionManager: { getSessionFile: () => '/mock/parent.jsonl', getSessionId: () => 'parent-id' },
    modelRegistry: { streamSimple: (...args) => { state.streamCalls.push(args); return 'mock-stream'; } },
    executeTool: async () => ({ content: [] }),
  };
  return { runner: state.runners[0].runner, state, options, ctx, session, emit,
    createdManager, openedManager, pi, tools, hooks, commands, shortcuts };
}

test('raw interactive runner returns report, full usage and opened manager session ID', async () => {
  const { runner, state, ctx, createdManager, openedManager } = createRunnerHarness();
  const result = await runner('worker', 'Complete the task.', new AbortController().signal,
    ctx, {}, 'Complete the task.');

  assert.equal(result.report, state.report);
  assert.deepEqual(result.usage, state.usage);
  assert.equal(result.logPath, openedManager.getSessionFile());
  assert.equal(state.sessionOptions[0].sessionManager, openedManager);
  assert.equal(result.sessionId, openedManager.getSessionId());
  assert.notEqual(result.sessionId, result.logPath);
  assert.notEqual(result.sessionId, createdManager.getSessionId());
});

for (const fails of [false, true]) {
  test(`raw interactive runner ${fails ? 'rejects' : 'succeeds'} without an opened manager session ID accessor`, async () => {
    const failure = new Error('Prompt failed without a session ID accessor.');
    const { runner, state, ctx, openedManager } = createRunnerHarness({
      withoutGetSessionId: true,
      ...(fails ? { promptError: failure } : {}),
    });
    assert.equal('getSessionId' in openedManager, false);

    const pending = runner('worker', 'Run without an ID accessor.', undefined,
      ctx, {}, 'Run without an ID accessor.');
    if (fails) {
      await assert.rejects(pending, (error) => {
        assert.equal(error, failure);
        assert.equal(error.sessionId, undefined);
        assert.equal(error.logPath, state.logPath);
        return true;
      });
    } else {
      const result = await pending;
      assert.equal(result.report, state.report);
      assert.equal(result.sessionId, undefined);
      assert.equal(result.logPath, state.logPath);
    }
  });
}

for (const stage of ['seed', 'open']) {
  test(`raw interactive runner preserves ${stage} rejection without a created manager session ID accessor`, async () => {
    const failure = new Error(`${stage} failed without a session ID accessor.`);
    const { runner, ctx, createdManager } = createRunnerHarness({
      createdWithoutGetSessionId: true,
      [`${stage}Error`]: failure,
    });
    assert.equal('getSessionId' in createdManager, false);

    await assert.rejects(
      runner('worker', 'Initialize without an ID accessor.', undefined,
        ctx, {}, 'Initialize without an ID accessor.'),
      (error) => {
        assert.equal(error, failure);
        assert.equal(error.sessionId, undefined);
        assert.equal(error.logPath, undefined);
        return true;
      },
    );
  });
}

test('raw interactive runner rejects cancellation after session creation before prompting', async () => {
  const controller = new AbortController();
  let createdSession;
  const { runner, state, ctx, session, openedManager, createdManager } = createRunnerHarness({
    onCreateAgentSession(_state, childSession) {
      createdSession = childSession;
      controller.abort();
    },
  });

  await assert.rejects(
    runner('worker', 'Cancel before prompting.', controller.signal,
      ctx, {}, 'Cancel before prompting.'),
    (error) => {
      assert.equal(controller.signal.aborted, true);
      assert.equal(error.name, 'Error');
      assert.equal(error.message, 'Delegated session cancelled before starting.');
      assert.equal(error.sessionId, openedManager.getSessionId());
      assert.notEqual(error.sessionId, createdManager.getSessionId());
      assert.equal(error.logPath, openedManager.getSessionFile());
      assert.notEqual(error.logPath, createdManager.getSessionFile());
      return true;
    },
  );
  assert.equal(state.creates.length, 1);
  assert.deepEqual(state.seeds, [createdManager]);
  assert.deepEqual(state.opens, [[state.logPath, state.logDirectory]]);
  assert.equal(state.sessionOptions.length, 1);
  assert.equal(state.sessionOptions[0].sessionManager, openedManager);
  assert.equal(createdSession, session);
  assert.equal(state.prompts.length, 0);
  assert.equal(state.aborts, 0);
  assert.equal(state.disposals, 1);
  assert.equal(state.subscriptions, 0);
  assert.equal(state.unsubscriptions, 0);
  assert.equal(state.entered.length, 0);
  assert.equal(state.updated.length, 0);
  assert.equal(state.left.length, 0);
});

test('raw interactive runner handles cancellation during prompt and cleans up listeners', async () => {
  const controller = new AbortController();
  const { signal } = controller;
  const added = [], removed = [];
  const addEventListener = signal.addEventListener.bind(signal);
  const removeEventListener = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { added.push(args); return addEventListener(...args); };
  signal.removeEventListener = (...args) => { removed.push(args); return removeEventListener(...args); };
  let settlePrompt;
  const { runner, state, ctx, emit, openedManager, createdManager } = createRunnerHarness({
    onPrompt() {
      const pending = new Promise((resolve) => { settlePrompt = resolve; });
      controller.abort();
      return pending;
    },
    onAbort() {
      assert.equal(state.prompts.length, 1);
      settlePrompt();
    },
  });

  let cancellation;
  await assert.rejects(
    runner('worker', 'Cancel during prompting.', signal, ctx, {}, 'Cancel during prompting.'),
    (error) => {
      cancellation = error;
      assert.equal(error, signal.reason);
      assert.equal(error.name, 'AbortError');
      assert.equal(error.sessionId, openedManager.getSessionId());
      assert.notEqual(error.sessionId, createdManager.getSessionId());
      assert.equal(error.logPath, openedManager.getSessionFile());
      assert.notEqual(error.logPath, createdManager.getSessionFile());
      return true;
    },
  );
  assert.equal(state.prompts.length, 1);
  assert.equal(state.aborts, 1);
  assert.equal(state.subscriptions, 1);
  assert.equal(state.unsubscriptions, 1);
  assert.equal(state.entered.length, 1);
  assert.deepEqual(state.left, state.entered);
  assert.equal(state.disposals, 1);
  assert.equal(added.length, 1);
  assert.equal(added[0][0], 'abort');
  assert.deepEqual(added[0][2], { once: true });
  assert.equal(removed.length, 1);
  assert.equal(removed[0][0], 'abort');
  assert.equal(removed[0][1], added[0][1]);

  const usageAfterCleanup = structuredClone(cancellation.usage);
  const updatesAfterCleanup = state.updated.length;
  emit({ type: 'message_end', message: { role: 'assistant', usage: state.usage } });
  assert.deepEqual(cancellation.usage, usageAfterCleanup);
  assert.equal(state.updated.length, updatesAfterCleanup);
  signal.dispatchEvent(new Event('abort'));
  assert.equal(state.aborts, 1);
});

test('raw interactive runner preserves prompt rejection with opened ID, log path and accrued usage', async () => {
  const failure = new Error('Prompt failed.');
  const { runner, state, ctx, openedManager, createdManager } = createRunnerHarness({
    promptError: failure,
    onPrompt(state, session, emit) {
      emit({ type: 'message_end', message: {
        role: 'assistant', usage: structuredClone(state.usage),
      } });
    },
  });

  await assert.rejects(
    runner('worker', 'Fail the prompt.', undefined, ctx, {}, 'Fail the prompt.'),
    (error) => {
      assert.equal(error, failure);
      assert.equal(error.sessionId, openedManager.getSessionId());
      assert.notEqual(error.sessionId, createdManager.getSessionId());
      assert.equal(error.logPath, openedManager.getSessionFile());
      assert.deepEqual(error.usage, state.usage);
      return true;
    },
  );
  assert.equal(state.prompts.length, 1);
  assert.equal(state.unsubscriptions, 1);
  assert.equal(state.disposals, 1);
  assert.equal(state.left.length, 1);
});

test('raw interactive runner preserves session creation rejection with opened ID and log path', async () => {
  const failure = new Error('Session creation failed.');
  const { runner, state, ctx, openedManager, createdManager } = createRunnerHarness({
    createAgentSessionError: failure,
  });

  await assert.rejects(
    runner('worker', 'Create a session.', undefined, ctx, {}, 'Create a session.'),
    (error) => {
      assert.equal(error, failure);
      assert.equal(error.sessionId, openedManager.getSessionId());
      assert.notEqual(error.sessionId, createdManager.getSessionId());
      assert.equal(error.logPath, openedManager.getSessionFile());
      return true;
    },
  );
  assert.equal(state.sessionOptions.length, 1);
  assert.equal(state.sessionOptions[0].sessionManager, openedManager);
  assert.equal(state.prompts.length, 0);
  assert.equal(state.entered.length, 0);
});

for (const stage of ['seed', 'open']) {
  test(`raw interactive runner preserves ${stage} rejection with created manager ID before opening`, async () => {
    const failure = new Error(`${stage} failed.`);
    const { runner, state, ctx, createdManager, openedManager } = createRunnerHarness({
      [`${stage}Error`]: failure,
    });

    await assert.rejects(
      runner('worker', 'Initialize a session.', undefined, ctx, {}, 'Initialize a session.'),
      (error) => {
        assert.equal(error, failure);
        assert.equal(error.sessionId, createdManager.getSessionId());
        assert.notEqual(error.sessionId, openedManager.getSessionId());
        assert.equal(error.logPath, undefined);
        return true;
      },
    );
    assert.equal(state.creates.length, 1);
    assert.deepEqual(state.seeds, [createdManager]);
    assert.equal(state.opens.length, stage === 'open' ? 1 : 0);
    assert.equal(state.sessionOptions.length, 0);
    assert.equal(state.prompts.length, 0);
  });
}

test('interactive entry restores original supervisor, UI hooks and retains list flag', async () => {
  const commands = {}, hooks = {}, shortcuts = {}, flags = {}, messages = [], tools = [];
  const pi = {
    registerCommand: (name, value) => { commands[name] = value; },
    registerTool: (tool) => tools.push(tool),
    registerFlag: (name, value) => { flags[name] = value; },
    registerShortcut: (name, value) => { shortcuts[name] = value; },
    registerEntryRenderer() {},
    on: (name, handler) => { (hooks[name] ??= []).push(handler); },
    sendUserMessage: (message) => messages.push(message),
  };
  extension(pi);
  const notices = [];
  const ctx = { ui: { notify: (...args) => notices.push(args) } };
  await commands['delegate-tasks'].handler(' ', ctx);
  assert.equal(messages.length, 0);
  assert.deepEqual(notices, [['Usage: /delegate-tasks <task>', 'info']]);
  await commands['delegate-tasks'].handler('  restore behavior  ', ctx);
  assert.deepEqual(messages, [`${supervisorPrompt}\n\nTask:\nrestore behavior`]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'delegate_task');
  assert.ok(shortcuts['ctrl+escape']);
  assert.ok(hooks.input);
  assert.ok(hooks.session_tree);
  assert.equal(flags['delegate-list'].type, 'string');
});
