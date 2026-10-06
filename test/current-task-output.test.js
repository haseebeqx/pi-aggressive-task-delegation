import assert from 'node:assert/strict';
import test from 'node:test';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { createCurrentTaskOutput } from '../src/current-task-output.js';

test('native message and tool rendering streams and resets per task', () => {
  initTheme('dark');
  let view;
  const emit = createCurrentTaskOutput({ setWidget(_key, factory) {
    view = factory({ requestRender() {} });
  } }, process.cwd());
  emit({ reset: true });
  const message = { role: 'assistant', content: [{ type: 'text', text: 'Live answer' }] };
  emit({ event: { type: 'message_start', message } });
  assert.match(view.render(80).join('\n'), /Live answer/);
  emit({ event: { type: 'tool_execution_start', toolCallId: '1', toolName: 'bash', args: { command: 'pwd' } } });
  emit({ event: { type: 'tool_execution_end', toolCallId: '1', result: { content: [{ type: 'text', text: 'Tool output' }] } } });
  assert.match(view.render(80).join('\n'), /Tool output/);
  view.invalidate();
  emit({ reset: true });
  assert.deepEqual(view.render(80), []);
});
