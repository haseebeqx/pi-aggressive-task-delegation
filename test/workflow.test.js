import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelegator, emptyUsage, rolePrompts } from '../src/workflow.js';

const report = (text) => ({ report: text, usage: { ...emptyUsage(), input: 1 } });

test('worker then independent reviewer; only reports and aggregate usage return', async () => {
  const calls = [];
  const delegate = createDelegator(async (role, prompt, signal, ctx) => {
    calls.push({ role, prompt, ctx });
    return report(role === 'worker' ? 'Changed src/a.js; tests passed.' : 'PASS\nChecked src/a.js.');
  });
  const ctx = { cwd: '/workspace' };
  const result = await delegate({ task: 'Fix bug', context: 'src/a.js', ctx });
  assert.deepEqual(calls.map((c) => c.role), ['worker', 'reviewer']);
  assert.equal(calls[0].ctx, ctx);
  assert.match(calls[1].prompt, /Changed src\/a.js/);
  assert.equal(result.isError, false);
  assert.equal(result.usage.input, 2);
  assert.deepEqual(result.details, { approved: true, completed: true,
    reviewStatus: 'passed', independentApproved: true });
  assert.equal(JSON.stringify(result).includes('messages'), false);
});

test('concurrent sibling requests execute completely in sequence', async () => {
  const calls = [];
  let active = 0;
  const delegate = createDelegator(async (role, prompt) => {
    active++;
    assert.equal(active, 1);
    calls.push(`${role}:${prompt.includes('First') ? 'first' : 'second'}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return report(role === 'worker' ? 'Done.' : 'PASS');
  });
  await Promise.all([delegate({ task: 'First' }), delegate({ task: 'Second' })]);
  assert.deepEqual(calls, ['worker:first', 'reviewer:first', 'worker:second', 'reviewer:second']);
});

test('failed or malformed review is not approval', async () => {
  for (const verdict of ['FAIL\nMissing test.', 'Looks good.', 'PASSING']) {
    const delegate = createDelegator(async (role) => report(role === 'worker' ? 'Done.' : verdict));
    const result = await delegate({ task: 'Task' });
    assert.equal(result.isError, true);
    assert.equal(result.details.approved, false);
  }
});

test('review exception preserves worker report and usage; queue recovers', async () => {
  let fail = true;
  const delegate = createDelegator(async (role) => {
    if (role === 'reviewer' && fail) {
      fail = false;
      throw Object.assign(new Error('Provider failed'), { usage: report('').usage });
    }
    return report(role === 'worker' ? 'Work exists on disk.' : 'PASS');
  });
  const result = await delegate({ task: 'Task' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Work exists on disk/);
  assert.equal(result.usage.input, 2);
  assert.equal((await delegate({ task: 'Next' })).isError, false);
});

test('cancellation stops before review and prevents queued work from starting', async () => {
  const controller = new AbortController();
  const calls = [];
  const delegate = createDelegator(async (role) => {
    calls.push(role);
    controller.abort();
    return report('Partial work.');
  });
  const result = await delegate({ task: 'Task' }, controller.signal);
  assert.equal(result.isError, true);
  await assert.rejects(delegate({ task: 'Next' }, controller.signal), /abort/i);
  assert.deepEqual(calls, ['worker']);
});

test('empty tasks are rejected without launching agents', async () => {
  const delegate = createDelegator(() => assert.fail('Must not run'));
  await assert.rejects(delegate({ task: '  ' }), /non-empty/);
});

test('workers favor direct execution and reviewers remain independent', () => {
  assert.deepEqual(Object.keys(rolePrompts), ['worker', 'reviewer', 'discoverer']);
  assert.match(rolePrompts.worker, /Complete your assignment directly by default/);
  assert.match(rolePrompts.worker, /Recursive delegation is exceptional/);
  assert.match(rolePrompts.worker, /delegate_task/);
  assert.match(rolePrompts.discoverer, /never delegate execution/);
  assert.match(rolePrompts.worker, /Verify your work/);
  assert.match(rolePrompts.reviewer, /Do not modify files or implement fixes/);
});

test('progress reports execution and review phases', async () => {
  const phases = [];
  const controller = new AbortController();
  const delegate = createDelegator(async (role, _prompt, signal) => {
    assert.equal(signal, controller.signal);
    return report(role === 'worker' ? 'Done.' : 'PASS');
  });
  await delegate({ task: 'Task' }, controller.signal, (phase) => phases.push(phase));
  assert.deepEqual(phases, ['Working', 'Reviewing']);
});
