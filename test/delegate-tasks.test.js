import test from 'node:test';
import assert from 'node:assert/strict';
import { registerDelegateTasks } from '../src/delegate-tasks.js';
import { supervisorPrompt, createDelegator } from '../src/workflow.js';

function fixture() {
  const commands = {}, tools = {}, handlers = {}, messages = [], options = [];
  registerDelegateTasks({
    registerCommand: (name, value) => { commands[name] = value; },
    registerTool: (value) => { tools[value.name] = value; },
    on: (name, handler) => { handlers[name] = handler; },
    sendUserMessage: (text) => messages.push(text),
  }, { createExecutor: (value) => {
    options.push(value);
    return { execute: async () => ({ content: [], details: { approved: true } }) };
  } });
  return { commands, tools, handlers, messages, options };
}

test('slash command restores supervisor instructions and validates empty input', async () => {
  const f = fixture(), notices = [];
  const ctx = { ui: { notify: (text) => notices.push(text) } };
  await f.commands['delegate-tasks'].handler(' ', ctx);
  assert.equal(f.messages.length, 0);
  assert.match(notices[0], /Usage/);
  await f.commands['delegate-tasks'].handler('  implement signup  ', ctx);
  assert.equal(f.messages[0], `${supervisorPrompt}\n\nTask:\nimplement signup`);
});

test('delegation executor is session-local and inherits selected model', async () => {
  const f = fixture();
  const ctx = { cwd: '/work', model: { id: 'selected' }, thinkingLevel: 'high' };
  const execute = () => f.tools.delegate_task.execute('id', { task: 'leaf' }, undefined, undefined, ctx);
  await execute(); await execute();
  assert.equal(f.options.length, 1);
  assert.equal(f.options[0].model, ctx.model);
  f.handlers.session_start();
  await execute();
  assert.equal(f.options.length, 2);
});

test('discovery runs without reviewer and cannot delegate execution', async () => {
  const roles = [];
  const delegate = createDelegator(async (role) => {
    roles.push(role);
    return { report: 'verified facts' };
  }, { discoveryOnly: true });
  const result = await delegate({ task: 'find relevant symbols' });
  assert.deepEqual(roles, ['discoverer']);
  assert.equal(result.details.approved, true);
  await assert.rejects(delegate({ task: 'implement', mode: 'execute' }), /cannot delegate execution/);
});
