import test from 'node:test';
import assert from 'node:assert/strict';
import * as standalone from '../src/workflow.js';
import * as interactive from '../src/interactive-workflow.js';
import extension from '../src/extension.js';
import { registerDelegateTasks } from '../src/delegate-tasks.js';

for (const [name, { createDelegator, emptyUsage }] of Object.entries({ standalone, interactive })) {
  const usage = () => ({ ...emptyUsage(), input: 3, output: 2, totalTokens: 5,
    cost: { ...emptyUsage().cost, input: 0.2, output: 0.3, total: 0.5 } });
  for (const review of [undefined, true, false]) {
    test(`${name}: review=${review} success gates, calls, logs, usage and progress`, async () => {
      const calls = [], phases = [], ctx = { cwd: '/workspace' };
      const controller = new AbortController();
      const delegate = createDelegator(async (role, prompt, signal, receivedCtx) => {
        calls.push(role);
        assert.equal(signal, controller.signal);
        assert.equal(receivedCtx, ctx);
        assert.match(prompt, /Assignment|Assigned task/);
        if (role === 'reviewer') assert.match(prompt, /verified worker report/);
        return { report: role === 'worker' ? 'verified worker report' : '  PASS\nChecked files.  ',
          usage: usage(), logPath: `/${role}.jsonl` };
      });
      const result = await delegate({ task: 'Task', context: 'constraints', ctx,
        ...(review === undefined ? {} : { review }) }, controller.signal, phase => phases.push(phase));
      const enabled = review !== false;
      assert.deepEqual(calls, enabled ? ['worker', 'reviewer'] : ['worker']);
      assert.deepEqual(phases, enabled ? ['Working', 'Reviewing'] : ['Working']);
      assert.equal(result.isError, false);
      assert.deepEqual(result.details, { approved: true, completed: true,
        reviewStatus: enabled ? 'passed' : 'skipped', independentApproved: enabled,
        logs: enabled ? { worker: '/worker.jsonl', reviewer: '/reviewer.jsonl' } : { worker: '/worker.jsonl' } });
      const expectedUsage = emptyUsage();
      for (let i = 0; i < (enabled ? 2 : 1); i++) standalone.addUsage(expectedUsage, usage());
      assert.deepEqual(result.usage, expectedUsage);
      assert.match(result.content[0].text, /verified worker report/);
      if (!enabled) {
        assert.match(result.content[0].text, /Independent review skipped \(review:false\)/);
        assert.match(result.content[0].text, /Worker completion only; no independent approval/);
        assert.doesNotMatch(result.content[0].text, /Review:|reviewer transcript log|PASS/);
      }
    });
  }

  for (const review of [true, false]) {
    for (const failure of ['throw', 'cancel']) {
      test(`${name}: worker ${failure}, review=${review} is not successful completion`, async () => {
        const calls = [], phases = [], controller = new AbortController();
        const delegate = createDelegator(async role => {
          calls.push(role);
          if (failure === 'throw') throw Object.assign(new Error('worker failed'), {
            usage: usage(), logPath: '/worker.jsonl' });
          controller.abort();
          return { report: 'Partial work', usage: usage(), logPath: '/worker.jsonl' };
        });
        const result = await delegate({ task: 'Task', review }, controller.signal, phase => phases.push(phase));
        assert.equal(result.isError, true);
        assert.deepEqual(result.details, { approved: false, completed: false,
          reviewStatus: 'not-run', independentApproved: false, logs: { worker: '/worker.jsonl' } });
        assert.deepEqual(result.usage, usage());
        assert.deepEqual(calls, ['worker']);
        assert.deepEqual(phases, ['Working']);
        assert.doesNotMatch(result.content[0].text, /Independent review skipped/);
        await assert.rejects(delegate({ task: 'Queued', review }, AbortSignal.abort()), /abort/i);
        assert.deepEqual(calls, ['worker']);
      });
    }
  }

  for (const verdict of ['FAIL\nMissing tests', 'Looks good', 'PASSING', 'PASS extra']) {
    test(`${name}: ${verdict} is a failed independent review`, async () => {
      const delegate = createDelegator(async role => ({ report: role === 'worker' ? 'Done' : verdict }));
      const result = await delegate({ task: 'Task', review: true });
      assert.equal(result.isError, true);
      assert.deepEqual(result.details, { approved: false, completed: false,
        reviewStatus: 'failed', independentApproved: false });
    });
  }

  test(`${name}: reviewer error preserves worker result and queue recovers`, async () => {
    let fail = true;
    const delegate = createDelegator(async role => {
      if (role === 'reviewer' && fail) {
        fail = false;
        throw Object.assign(new Error('review unavailable'), { usage: usage(), logPath: '/reviewer.jsonl' });
      }
      return { report: role === 'worker' ? 'Completed edits' : 'PASS', usage: usage(), logPath: `/${role}.jsonl` };
    });
    const result = await delegate({ task: 'Task' });
    assert.equal(result.isError, true);
    assert.deepEqual(result.details, { approved: false, completed: false, reviewStatus: 'error',
      independentApproved: false, logs: { worker: '/worker.jsonl', reviewer: '/reviewer.jsonl' } });
    assert.equal(result.usage.cost.total, 1);
    assert.match(result.content[0].text, /Completed edits/);
    assert.equal((await delegate({ task: 'Next', review: false })).details.reviewStatus, 'skipped');
  });

  for (const discoveryOnly of [false, true]) {
    test(`${name}: discovery unchanged for every review value (discoveryOnly=${discoveryOnly})`, async () => {
      const calls = [], phases = [];
      const delegate = createDelegator(async role => {
        calls.push(role);
        return { report: 'Verified facts', usage: usage(), logPath: '/discoverer.jsonl' };
      }, { discoveryOnly });
      let baseline;
      for (const review of [undefined, true, false]) {
        const result = await delegate({ task: 'Find facts', ...(discoveryOnly ? {} : { mode: 'discover' }), review },
          undefined, phase => phases.push(phase));
        assert.equal(result.isError, false);
        assert.deepEqual(result.details, { approved: true, logs: { discoverer: '/discoverer.jsonl' } });
        assert.deepEqual(result.usage, usage());
        if (baseline) assert.deepEqual(result, baseline);
        baseline = result;
      }
      assert.deepEqual(calls, ['discoverer', 'discoverer', 'discoverer']);
      assert.deepEqual(phases, ['Discovering', 'Discovering', 'Discovering']);
    });
  }

  test(`${name}: invalid review values rejected without agents and queue recovers`, async () => {
    const calls = [];
    const delegate = createDelegator(async role => { calls.push(role); return { report: 'Done' }; });
    for (const review of [null, 'false', 0, {}]) {
      await assert.rejects(delegate({ task: 'Task', review }), /review must be a boolean/);
    }
    assert.deepEqual(calls, []);
    assert.equal((await delegate({ task: 'Next', review: false })).details.completed, true);
  });
}

function capture(register, options) {
  let tool;
  register({ registerTool(value) { tool = value; }, registerCommand() {}, registerFlag() {},
    registerShortcut() {}, registerEntryRenderer() {}, on() {} }, options);
  return tool;
}

for (const [name, register] of Object.entries({ interactive: extension, standalone: registerDelegateTasks })) {
  test(`${name}: registered schema exposes optional boolean review default true`, () => {
    const tool = capture(register);
    assert.equal(tool.parameters.properties.review.type, 'boolean');
    assert.equal(tool.parameters.properties.review.default, true);
    assert.ok(!tool.parameters.required.includes('review'));
    assert.match(tool.parameters.properties.review.description, /ignored for discovery/i);
  });
}

test('standalone registered tool forwards review values, signal and progress to executor', async () => {
  const calls = [], updates = [], controller = new AbortController();
  const tool = capture(registerDelegateTasks, { createExecutor: () => ({
    execute: async (params, signal, onProgress) => {
      calls.push({ params, signal });
      onProgress('Working');
      return { content: [], details: { approved: true } };
    },
  }) });
  for (const review of [undefined, true, false]) {
    const params = { task: 'Task', ...(review === undefined ? {} : { review }) };
    await tool.execute('id', params, controller.signal, value => updates.push(value), { cwd: '/work' });
    assert.equal(calls.at(-1).params, params);
    assert.equal(calls.at(-1).signal, controller.signal);
  }
  assert.equal(updates.length, 3);
  assert.ok(updates.every(update => update.content[0].text === 'Working: Task'));
});

test('interactive registered tool forwards review to delegator validation before starting sessions', async () => {
  const tool = capture(extension);
  await assert.rejects(tool.execute('id', { task: 'Task', review: 'false' }, undefined, undefined,
    { hasUI: false }), /review must be a boolean/);
});
