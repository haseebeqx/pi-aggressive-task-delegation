// Load through Pi to test fresh SDK sessions without a network/model call.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import taskDivider from '../src/extension.js';
import { emptyUsage } from '../src/workflow.js';

export default function (pi) {
  pi.registerCommand('divider-smoke', {
    description: 'Offline task-divider SDK integration test.',
    handler: async (_args, ctx) => {
      let tool;
      taskDivider({
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
        undefined, { ...ctx, modelRegistry: registry });
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
      assert.ok(readEntries(nestedLogs.worker).some((e) =>
        e.message?.content?.some?.((c) => c.text === 'Leaf completed.')));
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
      console.log('Task-divider SDK smoke test passed (recursive delegation, fresh contexts, persisted logs, usage).');
    },
  });
}
