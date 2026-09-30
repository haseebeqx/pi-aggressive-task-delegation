import assert from 'node:assert/strict';
import test from 'node:test';
import { DelegationTranscript, OUTPUT_ENTRY, CHECKPOINT_ENTRY, createTranscriptComponent } from '../src/delegation-transcript.js';

class Text {
  constructor(text = '') { this.text = text; }
  render() { return this.text.split('\n'); }
  invalidate() {}
}
class Assistant extends Text {
  updateContent(message) { this.text = message.content[0].text; }
}
class Tool extends Text {
  constructor(name) { super(name); }
  markExecutionStarted() {}
  setArgsComplete() {}
  setExpanded(expanded) { assert.equal(expanded, true); }
  updateResult(result) { this.text = result.content[0].text; }
}
const deps = { Text, AssistantMessageComponent: Assistant, ToolExecutionComponent: Tool };
const theme = { fg: (_color, text) => text };
const message = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });

test('live transcript grows without clipping and retains earlier responses and tool changes', () => {
  const entries = [];
  const transcript = new DelegationTranscript((customType, data) => entries.push({ customType, data }), () => String(entries.length));
  const node = { role: 'worker', task: 'Do not pin this prompt', cwd: '/tmp' };
  const first = transcript.start(node, 'assistant', { message: message('Planning'), streaming: true });
  const component = createTranscriptComponent(() => transcript.records.get(first.id), deps, {}, theme);
  assert.deepEqual(component.render(80), ['Delegated worker', 'Planning']);
  const full = Array.from({ length: 100 }, (_, i) => `change ${i}`).join('\n');
  transcript.update(first, { message: message(full), streaming: false }, true);
  assert.equal(component.render(80).length, 101);
  assert.equal(component.render(80)[1], 'change 0');
  const tool = transcript.start(node, 'tool', { tool: { id: 'edit', name: 'edit', args: {} } });
  transcript.update(tool, { tool: { ...tool.tool, result: { content: [{ type: 'text', text: '-old\n+new' }] } } }, true);
  const toolComponent = createTranscriptComponent(() => tool, deps, {}, theme);
  assert.deepEqual(toolComponent.render(80), ['Delegated worker', '-old', '+new']);
  transcript.start(node, 'assistant', { message: message('Next response'), streaming: true });
  assert.equal(component.render(80)[1], 'change 0');
  assert.equal(entries.filter((e) => e.customType === OUTPUT_ENTRY).length, 3);
  assert.equal(entries.filter((e) => e.customType === CHECKPOINT_ENTRY).length, 2);
  assert.equal(entries[0].data.message.content[0].text, 'Planning');
  const restored = new DelegationTranscript(() => {}, () => {});
  restored.restore(entries);
  const replay = createTranscriptComponent(() => restored.records.get(first.id), deps, {}, theme);
  assert.deepEqual(replay.render(80), component.render(80));
  assert.deepEqual(createTranscriptComponent(() => restored.records.get(tool.id), deps, {}, theme).render(80), toolComponent.render(80));
});
