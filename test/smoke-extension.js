// Load through Pi to test fresh SDK sessions without a network/model call.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import taskDivider from '../src/extension.js';
import { emptyUsage } from '../src/workflow.js';

export default function (pi) {
  pi.registerCommand('divider-smoke', {
    description: 'Offline task-divider SDK integration test.',
    handler: async (_args, ctx) => {
      initTheme('dark', false);
      const widgetFrames = [];
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
        { type: 'text', text: 'Leaf completed.' },
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
      assert.equal(calls, 5);
      assert.equal(result.usage.input, 5);
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
      for (const index of [0, 1, 2, 4]) {
        assert.equal(transcripts[index].filter((m) => m.role === 'user').length, 1);
        assert.equal(transcripts[index].filter((m) => m.role === 'assistant').length, 0);
      }
      // UI failures at a final message boundary must not strand SDK prompt().
      for (const failure of ['widget', 'transcript']) {
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
      console.log('Task-divider SDK smoke test passed (recursion, logs, usage, UI failure recovery, nested cancellation and parent input).');
    },
  });
}
