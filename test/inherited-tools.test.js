import assert from 'node:assert/strict';
import test from 'node:test';
import { inheritTools } from '../src/inherited-tools.js';

const tool = (name, extra = {}) => ({ name, label: name, description: name,
  parameters: { type: 'object', properties: {} }, ...extra });

test('inherits every callable tool, including nonstandard builtins and MCP; replaces delegation', () => {
  const delegate = tool('delegate_task');
  const parent = { tools: [tool('read'), tool('powershell'), tool('web_search'),
    tool('mcp__research__fetch', { exposure: 'deferred', namespace: { name: 'research' },
      annotations: { readOnlyHint: true }, outputSchema: { type: 'object' } }),
    tool('delegate_task', { execute() { throw new Error('Must not call parent delegation'); } })],
  executeTool() {} };
  const result = inheritTools(parent, delegate);
  assert.deepEqual(result.tools, ['read', 'powershell', 'web_search', 'mcp__research__fetch', 'delegate_task']);
  assert.equal(result.customTools.at(-1), delegate);
  assert.equal(result.customTools[3].exposure, 'direct');
  assert.deepEqual(result.customTools[3].namespace, { name: 'research' });
  assert.deepEqual(result.customTools[3].annotations, { readOnlyHint: true });
  assert.deepEqual(result.customTools[3].outputSchema, { type: 'object' });
  assert.equal(parent.tools[3].exposure, 'deferred');
});

test('forwards arguments, abort signal, progress and permission-aware error outcomes', async () => {
  const controller = new AbortController();
  const args = { query: 'docs' };
  const updates = [];
  const onUpdate = (update) => updates.push(update);
  const partial = { content: [{ type: 'text', text: 'Searching' }], details: undefined };
  const result = { content: [{ type: 'text', text: 'Permission denied' }], details: { blocked: true },
    structuredContent: { blocked: true }, usage: { input: 42 } };
  const parent = { tools: [tool('web_search')], async executeTool(name, actual, options) {
    assert.equal(this, parent);
    assert.equal(name, 'web_search');
    assert.equal(actual, args);
    assert.equal(options.signal, controller.signal);
    options.onUpdate(partial);
    return { result, isError: true };
  } };
  const inherited = inheritTools(parent, tool('delegate_task')).customTools[0];
  assert.deepEqual(await inherited.execute('child-id', args, controller.signal, onUpdate),
    { content: result.content, details: result.details, structuredContent: result.structuredContent, isError: true });
  assert.deepEqual(updates, [partial]);
});

test('recursive bridging stays callable and uses a new child-local delegate', async () => {
  let calls = 0;
  const root = { tools: [tool('research')], async executeTool() {
    calls++;
    return { result: { content: [], details: undefined }, isError: false };
  } };
  const firstDelegate = tool('delegate_task');
  const first = inheritTools(root, firstDelegate);
  const secondDelegate = tool('delegate_task');
  const second = inheritTools({ tools: first.customTools,
    async executeTool(name, args, options) {
      return { result: await first.customTools.find((t) => t.name === name)
        .execute('nested', args, options.signal, options.onUpdate), isError: false };
    } }, secondDelegate);
  assert.equal(second.customTools.at(-1), secondDelegate);
  assert.notEqual(second.customTools.at(-1), firstDelegate);
  await second.customTools[0].execute('leaf', {});
  assert.equal(calls, 1);
});

test('discovery blocks known mutation tools before forwarding, but keeps exploration tools', async () => {
  const calls = [];
  const parent = { tools: ['write', 'edit', 'apply_patch', 'read', 'bash', 'web_search'].map((name) => tool(name)),
    async executeTool(name) { calls.push(name); return { result: { content: [] }, isError: false }; } };
  const inherited = inheritTools(parent, tool('delegate_task'), { discoveryOnly: true });
  for (const name of ['write', 'edit', 'apply_patch']) {
    await assert.rejects(inherited.customTools.find((t) => t.name === name).execute('id', {}), /read-only/);
  }
  assert.deepEqual(calls, []);
  for (const name of ['read', 'bash', 'web_search']) await inherited.customTools.find((t) => t.name === name).execute('id', {});
  assert.deepEqual(calls, ['read', 'bash', 'web_search']);
  await inheritTools(parent, tool('delegate_task')).customTools[0].execute('id', {});
  assert.equal(calls.at(-1), 'write');
});

test('fails clearly without the public Pi tool bridge rather than falling back to an allowlist', () => {
  assert.throws(() => inheritTools({}, tool('delegate_task')), /ExtensionToolContext/);
});
