import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelegator, emptyUsage } from '../src/workflow.js';

const report = (role) => ({ report: role === 'worker' ? 'Done.' : 'PASS',
  usage: emptyUsage(), logPath: `/logs/${role}.jsonl` });

test('returns log references, not transcripts', async () => {
  const delegate = createDelegator(async (role) => report(role));
  const result = await delegate({ task: 'Task' });
  assert.deepEqual(result.details.logs, {
    worker: '/logs/worker.jsonl', reviewer: '/logs/reviewer.jsonl',
  });
  assert.match(result.content[0].text, /worker transcript log: \/logs\/worker.jsonl/);
  assert.match(result.content[0].text, /reviewer transcript log: \/logs\/reviewer.jsonl/);
});

test('preserves log references on worker and reviewer failure', async () => {
  for (const failedRole of ['worker', 'reviewer']) {
    const delegate = createDelegator(async (role) => {
      if (role === failedRole) throw Object.assign(new Error('Failed'), {
        logPath: `/logs/${role}.jsonl`,
      });
      return report(role);
    });
    const result = await delegate({ task: 'Task' });
    assert.equal(result.isError, true);
    assert.equal(result.details.logs[failedRole], `/logs/${failedRole}.jsonl`);
    assert.match(result.content[0].text, new RegExp(`${failedRole} transcript log:`));
    if (failedRole === 'reviewer') assert.equal(result.details.logs.worker, '/logs/worker.jsonl');
  }
});

test('cancellation after worker retains its log', async () => {
  const controller = new AbortController();
  const delegate = createDelegator(async (role) => {
    controller.abort();
    return report(role);
  });
  const result = await delegate({ task: 'Task' }, controller.signal);
  assert.equal(result.isError, true);
  assert.deepEqual(result.details.logs, { worker: '/logs/worker.jsonl' });
});
