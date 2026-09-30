import assert from 'node:assert/strict';
import test from 'node:test';
import { createDelegationWidgets, updateDelegationMessage } from '../src/delegation-renderer.js';

test('streams structured assistant messages, including thinking, without clipping Markdown source', () => {
  const node = {};
  const message = { role: 'assistant', content: [
    { type: 'thinking', thinking: 'Considering options' },
    { type: 'text', text: '```js\n' + 'const x = 1;\n'.repeat(500) + '```' },
  ] };
  updateDelegationMessage(node, { type: 'message_start', message });
  assert.equal(node.streaming, true);
  updateDelegationMessage(node, { type: 'message_update', message });
  assert.equal(node.message.content[1].text, message.content[1].text);
  updateDelegationMessage(node, { type: 'message_end', message });
  assert.equal(node.streaming, false);
});

test('tool output stays separate from assistant Markdown and resets on the next response', () => {
  const node = {};
  const message = { role: 'assistant', content: [{ type: 'text', text: '**Plan**' }] };
  updateDelegationMessage(node, { type: 'message_end', message });
  updateDelegationMessage(node, { type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash', args: { command: 'pwd' } });
  const result = { content: [{ type: 'text', text: '**literal output**' }] };
  updateDelegationMessage(node, { type: 'tool_execution_update', toolCallId: 'a', toolName: 'bash', partialResult: result });
  assert.equal(node.tool.partial, true);
  updateDelegationMessage(node, { type: 'tool_execution_end', toolCallId: 'a', toolName: 'bash', result, isError: true });
  assert.equal(node.tool.result.isError, true);
  assert.equal(node.tool.partial, false);
  assert.equal(node.message, message);
  assert.equal(updateDelegationMessage(node, { type: 'message_end', message: { role: 'toolResult' } }), false);
  updateDelegationMessage(node, { type: 'message_start', message: { ...message, content: [] } });
  assert.equal(node.tool, undefined);
  assert.deepEqual(node.message.content, []);
});

test('widgets use native session components, clip rendered lines, and theme the bottom indicator orange', () => {
  const calls = [];
  class Text {
    constructor(text) { this.text = text; }
    render() { return [this.text]; }
    invalidate() { calls.push('invalidate'); }
  }
  class AssistantMessageComponent extends Text {
    updateContent(message, streaming) { calls.push({ message, streaming }); }
    render(width) { calls.push(width); return Array.from({ length: 30 }, (_, i) => `formatted ${i}`); }
  }
  class ToolExecutionComponent extends Text {
    constructor(...args) { super('tool output'); calls.push(args); }
    markExecutionStarted() {}
    setArgsComplete() {}
    updateResult(result, partial) { calls.push({ result, partial }); }
  }
  const node = { role: 'worker', task: 'Test', cwd: '/tmp', streaming: true,
    message: { role: 'assistant', content: [] },
    tool: { name: 'bash', id: 'a', args: {}, result: { content: [] }, partial: true } };
  const theme = { fg: (_color, text) => text, style: (text, style) => { calls.push(style); return text; } };
  const widgets = createDelegationWidgets(node, { Text, AssistantMessageComponent, ToolExecutionComponent });
  const component = widgets.content({}, theme);
  const lines = component.render(40);
  assert.equal(lines.length, 21);
  assert.equal(lines[3], 'formatted 13');
  assert.equal(lines.at(-1), 'tool output');
  assert.ok(calls.some((call) => call.message === node.message && call.streaming));
  assert.equal(widgets.indicator({}, theme).render(40)[0],
    'Delegated task · worker · Ctrl+Esc: cancel and return to parent');
  assert.ok(calls.some((call) => call.fg?.kind === 'rgb' && call.fg.r === 255 && call.fg.g === 149 && call.fg.b === 0));
  component.invalidate();
  assert.equal(calls.filter((call) => call === 'invalidate').length, 5);
});
