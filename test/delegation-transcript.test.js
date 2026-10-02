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
  updateArgs() {}
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

test('uses native definitions and preserves the tool instance through streaming and invalidation', () => {
  const calls = [];
  const definition = { renderCall() {}, renderResult() {} };
  class NativeTool extends Tool {
    constructor(...args) { super(args[0]); calls.push(['construct', ...args]); }
    updateArgs(args) { calls.push(['args', args]); }
    updateResult(result, partial) { super.updateResult(result); calls.push(['result', result, partial]); }
    invalidate() { calls.push(['invalidate']); }
  }
  const rendererDeps = { ...deps, ToolExecutionComponent: NativeTool,
    resolveToolDefinition(name, cwd) {
      calls.push(['resolve', name, cwd]);
      return name === 'edit' ? definition : undefined;
    },
  };
  const tui = {};
  let record = { role: 'worker', kind: 'tool', cwd: '/project',
    tool: { name: 'edit', id: 'call-1', args: { path: 'code.js' } } };
  const component = createTranscriptComponent(() => record, rendererDeps, tui, theme);
  component.render(80);
  const construction = calls.find(([type]) => type === 'construct');
  assert.equal(construction[5], definition);
  assert.equal(construction[6], tui);
  assert.equal(construction[7], '/project');
  const result = { content: [{ type: 'text', text: 'Edited' }],
    details: { diff: '-1 old\n+1 new' }, isError: false };
  record = { ...record, tool: { ...record.tool, result, partial: true } };
  component.render(80);
  record = { ...record, tool: { ...record.tool, partial: false } };
  component.render(80);
  component.invalidate();
  component.render(40);
  assert.equal(calls.filter(([type]) => type === 'construct').length, 1);
  assert.deepEqual(calls.filter(([type]) => type === 'result'), [
    ['result', result, true], ['result', result, false],
  ]);
  assert.ok(calls.some(([type]) => type === 'invalidate'));

  // Restored entries resolve renderers too; unknown tools retain the fallback.
  const replay = createTranscriptComponent(() => structuredClone(record), rendererDeps, tui, theme);
  replay.render(80);
  assert.equal(calls.filter(([type]) => type === 'construct').at(-1)[5], definition);
  record = { ...record, tool: { ...record.tool, name: 'custom', id: 'call-2' } };
  component.render(80);
  assert.equal(calls.filter(([type]) => type === 'construct').at(-1)[5], undefined);
});
