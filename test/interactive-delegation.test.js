import assert from 'node:assert/strict';
import test from 'node:test';
import extension from '../src/extension.js';
import { supervisorPrompt } from '../src/interactive-workflow.js';

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
