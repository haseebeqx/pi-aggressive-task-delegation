// Load through Pi to test fresh SDK sessions without a network/model call.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, getAgentDir, initTheme, SessionManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { visibleWidth } from '@earendil-works/pi-tui';
import taskDivider from '../src/extension.js';
import { emptyUsage } from '../src/workflow.js';

export default function (pi) {
  pi.registerCommand('divider-smoke', {
    description: 'Offline task-divider SDK integration test.',
    handler: async (_args, commandCtx) => {
      try {
      let webCalls = 0;
      let blockedCalls = 0;
      let resultHooks = 0;
      let smokeCompleted = false;
      const nestedEvents = [];
      const fixture = (api) => {
        for (const [name, exposure] of [['web_research', 'deferred'], ['code_research', 'codemode'],
          ['model_orchestrator', 'model-only'], ['hidden_fixture', 'hidden']]) {
          api.registerTool({
            name, label: name, description: 'Offline research fixture', exposure,
            parameters: Type.Object({ query: Type.String() }),
            async execute(_id, args, signal) {
              signal?.throwIfAborted();
              assert.ok(['web_research', 'code_research'].includes(name));
              assert.equal(args.query, 'hook-approved', 'Supervisor input hook must run');
              webCalls++;
              return { content: [{ type: 'text', text: 'Unredacted evidence' }], details: undefined };
            },
          });
        }
        api.on('tool_call', (event) => {
          if (!['web_research', 'code_research'].includes(event.toolName)) return;
          assert.equal(event.parentToolCallId, 'smoke-root');
          nestedEvents.push(event.toolCallId);
          if (event.input.query === 'blocked') {
            blockedCalls++;
            return { block: true, reason: 'Research denied by supervisor hook' };
          }
          event.input.query = 'hook-approved';
        });
        api.on('tool_result', (event) => {
          if (!['web_research', 'code_research'].includes(event.toolName) || event.isError) return;
          resultHooks++;
          return { content: [{ type: 'text', text: 'Verified web evidence' }] };
        });
        api.registerTool({
          name: 'smoke_entry', label: 'Smoke entry', description: 'Run integration assertions',
          parameters: Type.Object({}),
          async execute(_id, _args, _signal, _update, ctx) {
            assert.ok(ctx.tools.some((tool) => tool.name === 'web_research'));
            assert.ok(ctx.tools.some((tool) => tool.name === 'code_research'));
            assert.ok(!ctx.tools.some((tool) => tool.name === 'model_orchestrator'));
            assert.ok(!ctx.tools.some((tool) => tool.name === 'hidden_fixture'));
            assert.ok(api.getActiveTools().includes('model_orchestrator'), 'Model-only exclusion applies even when active');
            const denied = await ctx.executeTool('model_orchestrator', { query: 'test' });
            assert.equal(denied.isError, true, 'Public bridge must reject model-only tools');
            await runSmoke(ctx);
            smokeCompleted = true;
            return { content: [{ type: 'text', text: 'Smoke completed' }], details: undefined };
          },
        });
      };
      const loader = new DefaultResourceLoader({ cwd: commandCtx.cwd, agentDir: getAgentDir(), noExtensions: true,
        noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [fixture] });
      await loader.reload();
      const { session } = await createAgentSession({ cwd: commandCtx.cwd, model: commandCtx.model,
        resourceLoader: loader, sessionManager: SessionManager.inMemory() });
      session.setActiveToolsByName(['smoke_entry', 'model_orchestrator']);
      let supervisorRequests = 0;
      session.agent.streamFunction = (model) => {
        const content = supervisorRequests++ === 0
          ? { type: 'toolCall', id: 'smoke-root', name: 'smoke_entry', arguments: {} }
          : { type: 'text', text: 'Done' };
        const message = { role: 'assistant', content: [content], api: model.api,
          provider: model.provider, model: model.id, usage: emptyUsage(),
          stopReason: content.type === 'toolCall' ? 'toolUse' : 'stop', timestamp: Date.now() };
        const stream = new AssistantMessageEventStream();
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end(message);
        return stream;
      };
      try {
        await session.bindExtensions({});
        await session.prompt('Run the smoke entry.');
        assert.equal(smokeCompleted, true, JSON.stringify(session.messages.findLast((message) =>
          message.role === 'toolResult')));
        assert.equal(supervisorRequests, 2);
      } finally { session.dispose(); }

      async function runSmoke(toolCtx) {
      // Pi exposes the live tool bridge through non-enumerable getters.
      const ctx = { ...toolCtx, tools: toolCtx.tools, executeTool: toolCtx.executeTool };
      initTheme('dark', false);
      const widgetFrames = [];
      const footerFrames = [];
      let footerComponent;
      const paintFooter = () => {
        if (!footerComponent) return;
        for (const width of [20, 80]) {
          const lines = footerComponent.render(width);
          assert.ok(lines.every((line) => visibleWidth(line) <= width), 'Footer must fit terminal width');
          footerFrames.push(lines);
        }
      };
      const entryRenderers = new Map();
      const transcriptComponents = [];
      const transcriptFrames = [];
      let painting = false;
      const paintTranscript = () => {
        if (painting) return;
        painting = true;
        try {
          for (const component of transcriptComponents) {
            for (const width of [20, 80]) {
              const lines = component.render(width);
              assert.ok(lines.every((line) => visibleWidth(line) <= width), 'Transcript must fit terminal width');
              transcriptFrames.push(lines);
            }
          }
        } finally { painting = false; }
      };
      const transcriptAPI = {
        registerEntryRenderer: (type, renderer) => { entryRenderers.set(type, renderer); },
        appendEntry: (customType, data) => {
          const renderer = entryRenderers.get(customType);
          if (renderer) transcriptComponents.push(renderer({ customType, data }, {}, ctx.ui.theme));
          paintTranscript();
        },
      };
      const ui = {
        ...ctx.ui,
        setFooter(factory) {
          footerComponent?.dispose?.();
          footerComponent = factory?.({ requestRender: paintFooter }, ctx.ui.theme, {
            getGitBranch: () => 'smoke-branch',
            getExtensionStatuses: () => new Map([['smoke', 'Smoke status']]),
            getAvailableProviderCount: () => 1,
          });
          if (!factory) footerFrames.push(['restored']);
          paintFooter();
        },
        setWidget(key, factory, options) {
          if (!factory) {
            widgetFrames.push({ key, cleared: true });
            return;
          }
          const component = factory({ requestRender: paintTranscript }, ctx.ui.theme);
          for (const width of [20, 80]) {
            const lines = component.render(width);
            assert.ok(lines.every((line) => visibleWidth(line) <= width), 'Widget must fit terminal width');
            widgetFrames.push({ key, lines, options });
          }
          component.invalidate();
        },
      };
      let tool;
      taskDivider({
        ...transcriptAPI,
        registerTool: (definition) => { tool = definition; },
        registerCommand() {}, on() {},
      });
      const answers = [
        { type: 'toolCall', id: 'leaf-call', name: 'delegate_task', arguments: { task: 'Leaf task' } },
        { type: 'toolCall', id: 'research-blocked', name: 'web_research', arguments: { query: 'blocked' } },
        { type: 'toolCall', id: 'research-worker', name: 'web_research', arguments: { query: 'worker' } },
        { type: 'text', text: 'Leaf completed.' },
        { type: 'toolCall', id: 'research-reviewer', name: 'code_research', arguments: { query: 'reviewer' } },
        { type: 'text', text: 'PASS\nLeaf verified.' },
        { type: 'text', text: 'Parent completed.' },
        { type: 'text', text: 'PASS\nParent verified.' },
      ];
      let calls = 0;
      const transcripts = [];
      const registry = {
        streamSimple(model, context) {
          transcripts.push(context.messages);
          const content = answers[calls++];
          assert.ok(content, 'Unexpected extra model request');
          const stream = new AssistantMessageEventStream();
          const message = {
            role: 'assistant', content: [content], api: model.api,
            provider: model.provider, model: model.id,
            usage: { ...emptyUsage(), input: 1 },
            stopReason: content.type === 'toolCall' ? 'toolUse' : 'stop',
            timestamp: Date.now(),
          };
          stream.push({ type: 'done', reason: message.stopReason, message });
          stream.end(message);
          return stream;
        },
      };
      assert.ok(ctx.model, 'A configured model is needed, but will not be called.');
      const result = await tool.execute('root', { task: 'Parent task' }, undefined,
        undefined, { ...ctx, mode: 'tui', hasUI: true, ui, modelRegistry: registry });
      assert.equal(result.isError, false, result.content[0].text);
      assert.ok(widgetFrames.some((frame) => frame.key === 'delegation-indicator' &&
        frame.options?.placement === 'belowEditor' && frame.lines.some((line) => /Delegated task/.test(line))));
      assert.ok(transcriptFrames.some((lines) => lines.some((line) => /Leaf completed/.test(line))));
      assert.ok(transcriptFrames.some((lines) => lines.some((line) => /delegate_task/.test(line))));
      assert.ok(widgetFrames.some((frame) => frame.key === 'delegation-indicator' && frame.cleared));
      assert.equal(result.isError, false, result.content[0].text);
      assert.ok(footerFrames.some((lines) => lines.some((line) => /↑1/.test(line))),
        'Native footer must show completed child usage');
      assert.ok(footerFrames.some((lines) => lines.some((line) => /smoke-branch/.test(line))));
      assert.ok(footerFrames.some((lines) => lines.some((line) => /Smoke status/.test(line))));
      assert.equal(footerComponent, undefined, 'Supervisor footer must be restored');
      assert.equal(calls, 8);
      assert.equal(webCalls, 2, 'Recursive worker and reviewer must inherit research tools');
      assert.equal(blockedCalls, 1, 'Supervisor hook must prevent child tool execution');
      assert.equal(resultHooks, 2, 'Supervisor result hooks must run for worker and reviewer');
      assert.equal(new Set(nestedEvents).size, 3, 'Nested calls must receive unique Pi-assigned ids');
      assert.equal(result.usage.input, 8);
      assert.equal(result.details.approved, true);
      const readEntries = (path) => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
      const workerEntries = readEntries(result.details.logs.worker);
      const reviewerEntries = readEntries(result.details.logs.reviewer);
      assert.ok(workerEntries.some((e) => e.message?.role === 'assistant'));
      assert.ok(workerEntries.some((e) => e.message?.role === 'user'));
      const nested = workerEntries.find((e) => e.message?.role === 'toolResult');
      assert.equal(nested.message.toolName, 'delegate_task');
      const nestedLogs = nested.message.details.logs;
      const leafEntries = readEntries(nestedLogs.worker);
      assert.ok(leafEntries.some((e) =>
        e.message?.content?.some?.((c) => c.text === 'Leaf completed.')));
      assert.equal(leafEntries.find((e) => e.customType === 'delegation').data.parentSession,
        result.details.logs.worker);
      assert.ok(reviewerEntries.some((e) => e.message?.role === 'assistant'));
      for (const path of [...Object.values(result.details.logs), ...Object.values(nestedLogs)]) {
        if (process.platform !== 'win32') {
          assert.equal(statSync(path).mode & 0o777, 0o600);
          assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
        }
        rmSync(dirname(path), { recursive: true });
      }
      assert.match(result.content[0].text, /Parent completed/);
      assert.doesNotMatch(result.content[0].text, /Leaf completed/);
      // Worker/reviewer each start with exactly one user assignment, not history.
      assert.ok(transcripts[3].some((message) => message.role === 'toolResult' &&
        message.content.some((part) => /Verified web evidence/.test(part.text))), 'Worker receives hook-redacted result');
      assert.ok(transcripts[5].some((message) => message.role === 'toolResult' &&
        message.content.some((part) => /Verified web evidence/.test(part.text))), 'Reviewer receives hook-redacted result');
      assert.ok(transcripts[2].some((message) => message.role === 'toolResult' && message.isError &&
        message.content.some((part) => /Research denied/.test(part.text))), 'Worker receives blocked result');
      for (const index of [0, 1, 4, 7]) {
        assert.equal(transcripts[index].filter((m) => m.role === 'user').length, 1);
        assert.equal(transcripts[index].filter((m) => m.role === 'assistant').length, 0);
      }
      // Discovery uses its own prompts and keeps recursive calls read-only.
      const discoveryAnswers = [
        { type: 'toolCall', id: 'forbidden-execution', name: 'delegate_task', arguments: { task: 'Must not implement', mode: 'execute' } },
        { type: 'toolCall', id: 'fact-child', name: 'delegate_task', arguments: { task: 'Narrow factual question' } },
        { type: 'text', text: 'README.md:1 identifies the project; external coverage unknown.' },
        { type: 'text', text: 'PASS\nEvidence and gap checked.' },
        { type: 'text', text: 'README.md:1 identifies the project. Narrow findings integrated.' },
        { type: 'text', text: 'PASS\nScoped discovery verified.' },
      ];
      let discoveryCalls = 0;
      const discoveryRegistry = { streamSimple(model) {
        const content = discoveryAnswers[discoveryCalls++];
        assert.ok(content, 'Unexpected discovery model request');
        const message = { role: 'assistant', content: [content], api: model.api,
          provider: model.provider, model: model.id, usage: { ...emptyUsage(), input: 1 },
          stopReason: content.type === 'toolCall' ? 'toolUse' : 'stop', timestamp: Date.now() };
        const stream = new AssistantMessageEventStream();
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end(message);
        return stream;
      } };
      const discovered = await tool.execute('discovery-root', { task: 'Gather project facts', mode: 'discover' },
        undefined, undefined, { ...ctx, modelRegistry: discoveryRegistry });
      assert.equal(discovered.isError, false, discovered.content[0].text);
      assert.equal(discoveryCalls, 6);
      assert.equal(discovered.usage.input, 6);
      const discoveryEntries = readEntries(discovered.details.logs.discoverer);
      const discoveryReviews = readEntries(discovered.details.logs['discovery-reviewer']);
      assert.match(JSON.stringify(discoveryEntries.filter((e) => e.message?.role === 'system')), /You are a discovery agent/);
      assert.match(JSON.stringify(discoveryReviews.filter((e) => e.message?.role === 'system')), /independent discovery reviewer/);
      const discoveryResults = discoveryEntries.filter((e) => e.message?.role === 'toolResult');
      assert.equal(discoveryResults[0].message.isError, true);
      assert.match(discoveryResults[0].message.content[0].text, /cannot delegate execution/);
      const discoveryChildLogs = discoveryResults[1].message.details.logs;
      assert.deepEqual(Object.keys(discoveryChildLogs), ['discoverer', 'discovery-reviewer']);
      for (const path of [...Object.values(discovered.details.logs), ...Object.values(discoveryChildLogs)]) {
        rmSync(dirname(path), { recursive: true });
      }
      // UI failures at a final message boundary must not strand SDK prompt().
      for (const failure of ['widget', 'transcript', 'footer']) {
        let resilientTool;
        let failed = false;
        let warnings = 0;
        let requests = 0;
        taskDivider({
          registerEntryRenderer() {},
          appendEntry(_type, data) {
            if (failure === 'transcript' && data.message?.stopReason === 'stop') {
              failed = true;
              throw new Error('Final transcript rendering failed');
            }
          },
          registerTool: (definition) => { resilientTool = definition; },
          registerCommand() {}, on() {},
        });
        const resilientUI = {
          ...ui,
          notify() { warnings++; },
          setFooter(factory) {
            if (failure === 'footer' && factory && !failed) {
              failed = true;
              throw new Error('Footer installation failed');
            }
            return ui.setFooter(factory);
          },
          setWidget(key, factory, options) {
            if (failure === 'widget' && requests > 0 && factory && !failed) {
              failed = true;
              throw new Error('Final widget rendering failed');
            }
            return ui.setWidget(key, factory, options);
          },
        };
        const resilientRegistry = {
          streamSimple(model) {
            const message = {
              role: 'assistant', content: [{ type: 'text', text: requests++ === 0
                ? 'Worker finished.' : 'PASS\nVerified.' }],
              api: model.api, provider: model.provider, model: model.id,
              usage: { ...emptyUsage(), input: 1 }, stopReason: 'stop', timestamp: Date.now(),
            };
            const stream = new AssistantMessageEventStream();
            stream.push({ type: 'done', reason: 'stop', message });
            stream.end(message);
            return stream;
          },
        };
        let deadline;
        let resilientResult;
        try {
          resilientResult = await Promise.race([
            resilientTool.execute('render-failure', { task: 'Finish despite UI failure' },
              undefined, undefined, { ...ctx, mode: 'tui', hasUI: true,
                ui: resilientUI, modelRegistry: resilientRegistry }),
            new Promise((_, reject) => {
              deadline = setTimeout(() => reject(new Error(`${failure} failure stranded delegation`)), 5000);
            }),
          ]);
        } finally { clearTimeout(deadline); }
        assert.equal(failed, true, `${failure} failure must be exercised`);
        assert.equal(warnings, 1);
        assert.equal(requests, 2, 'Worker must automatically advance to reviewer');
        assert.equal(resilientResult.isError, false, resilientResult.content[0].text);
        assert.equal(resilientResult.usage.input, 2);
        for (const path of Object.values(resilientResult.details.logs)) {
          assert.ok(readEntries(path).some((entry) => entry.message?.stopReason === 'stop'));
          rmSync(dirname(path), { recursive: true });
        }
      }
      // Cancel a nested worker, then steer its immediate parent through the
      // actual extension input hook while its delegate_task call is blocked.
      const handlers = {};
      const commands = {};
      const shortcuts = {};
      let cancelTool;
      taskDivider({
        ...transcriptAPI,
        registerTool: (definition) => { cancelTool = definition; },
        registerCommand: (name, definition) => { commands[name] = definition; },
        registerShortcut: (key, definition) => { shortcuts[key] = definition; },
        on: (name, handler) => { handlers[name] = handler; },
        sendUserMessage() { throw new Error('Nested input must not reach Main'); },
      });
      assert.deepEqual(Object.keys(commands), ['delegate-tasks']);
      assert.deepEqual(Object.keys(shortcuts), ['ctrl+escape']);
      let usageNotice;
      await commands['delegate-tasks'].handler(' ', {
        ui: { notify: (message) => { usageNotice = message; } },
      });
      assert.equal(usageNotice, 'Usage: /delegate-tasks <task>');
      let cancelCalls = 0;
      let intervention;
      const cancelTranscripts = [];
      const cancelRegistry = {
        streamSimple(model, context, options) {
          const index = cancelCalls++;
          cancelTranscripts.push(context.messages);
          const stream = new AssistantMessageEventStream();
          const message = {
            role: 'assistant', content: [], api: model.api,
            provider: model.provider, model: model.id,
            usage: emptyUsage(), stopReason: 'stop', timestamp: Date.now(),
          };
          if (index === 1) {
            // Keep the nested provider request alive until cancellation arrives.
            options.signal.addEventListener('abort', () => {
              message.stopReason = 'aborted';
              stream.push({ type: 'error', reason: 'aborted', error: message });
              stream.end(message);
            }, { once: true });
            intervention = Promise.resolve().then(async () => {
              await shortcuts['ctrl+escape'].handler({ ui: { notify() {} } });
              const response = await handlers.input({
                source: 'interactive', text: 'Skip the leaf; complete the parent instead.',
              });
              assert.equal(response.action, 'handled');
            });
            return stream;
          }
          message.content = [index === 0
            ? { type: 'toolCall', id: 'cancel-leaf', name: 'delegate_task', arguments: { task: 'Cancellable leaf' } }
            : { type: 'text', text: index === 2 ? 'Parent recovered.' : 'PASS\nRecovery verified.' }];
          message.stopReason = index === 0 ? 'toolUse' : 'stop';
          stream.push({ type: 'done', reason: message.stopReason, message });
          stream.end(message);
          return stream;
        },
      };
      const recovered = await cancelTool.execute('cancel-root', { task: 'Recover parent' },
        undefined, undefined, { ...ctx, mode: 'tui', hasUI: true, ui, modelRegistry: cancelRegistry });
      await intervention;
      assert.equal(recovered.isError, false, recovered.content[0].text);
      assert.equal(cancelCalls, 4);
      assert.ok(cancelTranscripts[2].some((message) => message.role === 'user' &&
        message.content.some((part) => part.text === 'Skip the leaf; complete the parent instead.')));
      const recoveredEntries = readEntries(recovered.details.logs.worker);
      const cancelledResult = recoveredEntries.find((entry) => entry.message?.role === 'toolResult');
      assert.equal(cancelledResult.message.isError, true);
      assert.match(cancelledResult.message.content[0].text, /Cancelled by user/);
      for (const path of [...Object.values(recovered.details.logs),
        ...Object.values(cancelledResult.message.details.logs)]) {
        rmSync(dirname(path), { recursive: true });
      }
      console.log('Task-divider SDK smoke test passed (real supervisor tool bridge/hooks, recursive worker/reviewer inheritance, logs, usage, UI failure recovery, nested cancellation and parent input).');
      }
      } catch (error) {
        // Pi reports command errors but otherwise exits successfully.
        process.exitCode = 1;
        console.error(error.stack);
        throw error;
      }
    },
  });
}
