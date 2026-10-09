import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelegator } from '../src/interactive-workflow.js';

const workerId = { sessionId: 'worker-session-id' };
const reviewerId = { sessionId: 'reviewer-session-id' };
const emptyId = { sessionId: '' };
const sessionCases = [
  ['both IDs', workerId, reviewerId, { worker: workerId.sessionId, reviewer: reviewerId.sessionId }],
  ['omitted IDs', {}, {}, null],
  ['empty IDs', emptyId, emptyId, null],
  ['omitted worker and empty reviewer ID', {}, emptyId, null],
  ['empty worker and omitted reviewer ID', emptyId, {}, null],
  ['worker-only ID, reviewer omitted', workerId, {}, { worker: workerId.sessionId }],
  ['worker-only ID, reviewer empty', workerId, emptyId, { worker: workerId.sessionId }],
  ['reviewer-only ID, worker omitted', {}, reviewerId, { reviewer: reviewerId.sessionId }],
  ['reviewer-only ID, worker empty', emptyId, reviewerId, { reviewer: reviewerId.sessionId }],
];
const verdictCases = [
  { verdict: 'PASS', approved: true, reviewStatus: 'passed' },
  { verdict: 'FAIL', approved: false, reviewStatus: 'failed' },
];

for (const { verdict, approved, reviewStatus } of verdictCases) {
  for (const [name, workerIds, reviewerIds, expectedIds] of sessionCases) {
    test(`interactive reviewed execution ${verdict}: ${name}`, async () => {
      const worker = {
        report: 'Implemented and verified.', logPath: '/logs/worker.jsonl', ...workerIds,
        usage: {
          input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
          cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        },
      };
      const reviewer = {
        report: `${verdict}\nIndependent verification finished.`,
        logPath: '/logs/reviewer.jsonl', ...reviewerIds,
        usage: {
          input: 13, output: 5, cacheRead: 4, cacheWrite: 1, totalTokens: 23,
          cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 26 },
        },
      };
      const calls = [];
      const signal = new AbortController().signal;
      const ctx = { cwd: '/workspace' };
      const delegate = createDelegator(async (...args) => {
        calls.push(args);
        assert.equal(args[2], signal);
        assert.equal(args[3], ctx);
        return args[0] === 'worker' ? worker : reviewer;
      });

      const result = await delegate({ task: 'Implement the change.',
        context: 'Preserve existing behavior.', mode: 'execute', review: true, ctx }, signal);
      const assignment = 'Assigned task:\nImplement the change.\n\nRelevant context:\nPreserve existing behavior.';
      assert.deepEqual(calls, [
        ['worker', assignment, signal, ctx],
        ['reviewer', `${assignment}\n\nWorker report (verify independently):\nImplemented and verified.`, signal, ctx],
      ]);
      const sessionText = Object.entries(expectedIds ?? {})
        .map(([role, id]) => `\n${role} session ID: ${id}`).join('');
      assert.deepEqual(result, {
        content: [{ type: 'text',
          text: `Worker report:\nImplemented and verified.\n\nReview:\n${verdict}\nIndependent verification finished.`
            + '\nworker transcript log: /logs/worker.jsonl'
            + '\nreviewer transcript log: /logs/reviewer.jsonl' + sessionText,
        }],
        details: {
          approved, completed: approved, reviewStatus, independentApproved: approved,
          logs: { worker: '/logs/worker.jsonl', reviewer: '/logs/reviewer.jsonl' },
          ...(expectedIds === null ? {} : { sessionIds: expectedIds }),
        },
        usage: {
          input: 24, output: 12, cacheRead: 7, cacheWrite: 3, totalTokens: 46,
          cost: { input: 6, output: 8, cacheRead: 10, cacheWrite: 12, total: 36 },
        },
        isError: !approved,
      });
    });
  }
}

const unreviewedSessionCases = [
  ['present worker ID', { sessionId: 'unreviewed-worker-session-id' }, { worker: 'unreviewed-worker-session-id' }],
  ['missing worker ID', {}, null],
  ['empty worker ID', { sessionId: '' }, null],
];

for (const [unreviewedName, unreviewedIds, unreviewedExpectedIds] of unreviewedSessionCases) {
  test(`interactive unreviewed execution success: ${unreviewedName}`, async () => {
    const unreviewedWorker = {
      report: 'Implemented and verified.', logPath: '/logs/worker.jsonl', ...unreviewedIds,
      usage: {
        input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
    };
    const unreviewedCalls = [];
    const unreviewedSignal = new AbortController().signal;
    const unreviewedCtx = { cwd: '/workspace' };
    const unreviewedDelegate = createDelegator(async (...args) => {
      unreviewedCalls.push(args);
      assert.equal(args[0], 'worker');
      assert.equal(args[2], unreviewedSignal);
      assert.equal(args[3], unreviewedCtx);
      return unreviewedWorker;
    });

    const unreviewedResult = await unreviewedDelegate({ task: 'Implement the change.',
      context: 'Preserve existing behavior.', mode: 'execute', review: false,
      ctx: unreviewedCtx }, unreviewedSignal);
    assert.deepEqual(unreviewedCalls, [
      ['worker', 'Assigned task:\nImplement the change.\n\nRelevant context:\nPreserve existing behavior.',
        unreviewedSignal, unreviewedCtx],
    ]);
    const unreviewedSessionText = unreviewedExpectedIds === null ? ''
      : `\nworker session ID: ${unreviewedExpectedIds.worker}`;
    assert.deepEqual(unreviewedResult, {
      content: [{ type: 'text',
        text: 'Worker report:\nImplemented and verified.\n\n'
          + 'Independent review skipped (review:false). Worker completion only; no independent approval.'
          + '\nworker transcript log: /logs/worker.jsonl' + unreviewedSessionText,
      }],
      details: {
        approved: true, completed: true, reviewStatus: 'skipped', independentApproved: false,
        logs: { worker: '/logs/worker.jsonl' },
        ...(unreviewedExpectedIds === null ? {} : { sessionIds: unreviewedExpectedIds }),
      },
      usage: {
        input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
      isError: false,
    });
  });
}

const discoverySessionCases = [
  ['present discoverer ID', { sessionId: 'discovery-session-id' }, { discoverer: 'discovery-session-id' }],
  ['missing discoverer ID', {}, null],
  ['empty discoverer ID', { sessionId: '' }, null],
];

for (const [discoveryName, discoveryIds, discoveryExpectedIds] of discoverySessionCases) {
  test(`interactive discovery success: ${discoveryName}`, async () => {
    const discoveryAgent = {
      report: 'Verified findings.', logPath: '/logs/discoverer.jsonl', ...discoveryIds,
      usage: {
        input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
    };
    const discoveryCalls = [];
    const discoverySignal = new AbortController().signal;
    const discoveryCtx = { cwd: '/workspace' };
    const discoveryDelegate = createDelegator(async (...args) => {
      discoveryCalls.push(args);
      assert.equal(args[0], 'discoverer');
      assert.equal(args[2], discoverySignal);
      assert.equal(args[3], discoveryCtx);
      return discoveryAgent;
    });

    const discoveryResult = await discoveryDelegate({ task: 'Investigate the change.',
      context: 'Preserve existing behavior.', mode: 'discover', ctx: discoveryCtx }, discoverySignal);
    assert.deepEqual(discoveryCalls, [
      ['discoverer', 'Assigned task:\nInvestigate the change.\n\nRelevant context:\nPreserve existing behavior.',
        discoverySignal, discoveryCtx],
    ]);
    const discoverySessionText = discoveryExpectedIds === null ? ''
      : `\ndiscoverer session ID: ${discoveryExpectedIds.discoverer}`;
    assert.deepEqual(discoveryResult, {
      content: [{ type: 'text',
        text: 'Discovery findings:\nVerified findings.'
          + '\ndiscoverer transcript log: /logs/discoverer.jsonl' + discoverySessionText,
      }],
      details: {
        approved: true,
        logs: { discoverer: '/logs/discoverer.jsonl' },
        ...(discoveryExpectedIds === null ? {} : { sessionIds: discoveryExpectedIds }),
      },
      usage: {
        input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
      isError: false,
    });
  });
}

for (const [workerThrowName, workerThrowIds, workerThrowExpectedIds] of unreviewedSessionCases) {
  test(`interactive execution worker throws: ${workerThrowName}`, async () => {
    const workerError = Object.assign(new Error('Worker execution failed.'), {
      logPath: '/logs/worker-error.jsonl', ...workerThrowIds,
      usage: {
        input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
    });
    const workerThrowCalls = [];
    const workerThrowSignal = new AbortController().signal;
    const workerThrowCtx = { cwd: '/workspace' };
    const workerThrowDelegate = createDelegator(async (...args) => {
      workerThrowCalls.push(args);
      assert.equal(args[0], 'worker');
      assert.equal(args[2], workerThrowSignal);
      assert.equal(args[3], workerThrowCtx);
      throw workerError;
    });

    const workerThrowResult = await workerThrowDelegate({ task: 'Implement the change.',
      context: 'Preserve existing behavior.', mode: 'execute', review: true,
      ctx: workerThrowCtx }, workerThrowSignal);
    assert.deepEqual(workerThrowCalls, [
      ['worker', 'Assigned task:\nImplement the change.\n\nRelevant context:\nPreserve existing behavior.',
        workerThrowSignal, workerThrowCtx],
    ]);
    const workerThrowSessionText = workerThrowExpectedIds === null ? ''
      : `\nworker session ID: ${workerThrowExpectedIds.worker}`;
    assert.deepEqual(workerThrowResult, {
      content: [{ type: 'text',
        text: 'Delegation failed: Worker execution failed.'
          + '\nworker transcript log: /logs/worker-error.jsonl' + workerThrowSessionText,
      }],
      details: {
        approved: false, completed: false, reviewStatus: 'not-run', independentApproved: false,
        logs: { worker: '/logs/worker-error.jsonl' },
        ...(workerThrowExpectedIds === null ? {} : { sessionIds: workerThrowExpectedIds }),
      },
      usage: {
        input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
      isError: true,
    });
  });
}

for (const [reviewerThrowName, workerIds, reviewerIds, expectedIds] of sessionCases) {
  test(`interactive execution reviewer throws after successful worker: ${reviewerThrowName}`, async () => {
    const worker = {
      report: 'Implemented and verified.', logPath: '/logs/worker.jsonl', ...workerIds,
      usage: {
        input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
    };
    const reviewerError = Object.assign(new Error('Reviewer execution failed.'), {
      logPath: '/logs/reviewer-error.jsonl', ...reviewerIds,
      usage: {
        input: 13, output: 5, cacheRead: 4, cacheWrite: 1, totalTokens: 23,
        cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 26 },
      },
    });
    const calls = [];
    const signal = new AbortController().signal;
    const ctx = { cwd: '/workspace' };
    const delegate = createDelegator(async (...args) => {
      calls.push(args);
      assert.ok(args[0] === 'worker' || args[0] === 'reviewer');
      assert.equal(args[2], signal);
      assert.equal(args[3], ctx);
      if (args[0] === 'worker') return worker;
      throw reviewerError;
    });

    const result = await delegate({ task: 'Implement the change.',
      context: 'Preserve existing behavior.', mode: 'execute', review: true, ctx }, signal);
    const assignment = 'Assigned task:\nImplement the change.\n\nRelevant context:\nPreserve existing behavior.';
    assert.deepEqual(calls, [
      ['worker', assignment, signal, ctx],
      ['reviewer', `${assignment}\n\nWorker report (verify independently):\nImplemented and verified.`, signal, ctx],
    ]);
    const sessionText = Object.entries(expectedIds ?? {})
      .map(([role, id]) => `\n${role} session ID: ${id}`).join('');
    assert.deepEqual(result, {
      content: [{ type: 'text',
        text: 'Delegation failed: Reviewer execution failed.'
          + '\n\nCompleted worker report:\nImplemented and verified.'
          + '\nworker transcript log: /logs/worker.jsonl'
          + '\nreviewer transcript log: /logs/reviewer-error.jsonl' + sessionText,
      }],
      details: {
        approved: false, completed: false, reviewStatus: 'error', independentApproved: false,
        logs: { worker: '/logs/worker.jsonl', reviewer: '/logs/reviewer-error.jsonl' },
        ...(expectedIds === null ? {} : { sessionIds: expectedIds }),
      },
      usage: {
        input: 24, output: 12, cacheRead: 7, cacheWrite: 3, totalTokens: 46,
        cost: { input: 6, output: 8, cacheRead: 10, cacheWrite: 12, total: 36 },
      },
      isError: true,
    });
  });
}

for (const [discoveryThrowName, discoveryThrowIds, discoveryThrowExpectedIds] of discoverySessionCases) {
  test(`interactive discovery discoverer throws: ${discoveryThrowName}`, async () => {
    const discoveryError = Object.assign(new Error('Discovery execution failed.'), {
      logPath: '/logs/discoverer-error.jsonl', ...discoveryThrowIds,
      usage: {
        input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
    });
    const discoveryThrowCalls = [];
    const discoveryThrowSignal = new AbortController().signal;
    const discoveryThrowCtx = { cwd: '/workspace' };
    const discoveryThrowDelegate = createDelegator(async (...args) => {
      discoveryThrowCalls.push(args);
      assert.equal(args[0], 'discoverer');
      assert.equal(args[2], discoveryThrowSignal);
      assert.equal(args[3], discoveryThrowCtx);
      throw discoveryError;
    });

    const discoveryThrowResult = await discoveryThrowDelegate({ task: 'Investigate the change.',
      context: 'Preserve existing behavior.', mode: 'discover',
      ctx: discoveryThrowCtx }, discoveryThrowSignal);
    assert.deepEqual(discoveryThrowCalls, [
      ['discoverer', 'Assigned task:\nInvestigate the change.\n\nRelevant context:\nPreserve existing behavior.',
        discoveryThrowSignal, discoveryThrowCtx],
    ]);
    const discoveryThrowSessionText = discoveryThrowExpectedIds === null ? ''
      : `\ndiscoverer session ID: ${discoveryThrowExpectedIds.discoverer}`;
    assert.deepEqual(discoveryThrowResult, {
      content: [{ type: 'text',
        text: 'Delegation failed: Discovery execution failed.'
          + '\ndiscoverer transcript log: /logs/discoverer-error.jsonl' + discoveryThrowSessionText,
      }],
      details: {
        approved: false,
        logs: { discoverer: '/logs/discoverer-error.jsonl' },
        ...(discoveryThrowExpectedIds === null ? {} : { sessionIds: discoveryThrowExpectedIds }),
      },
      usage: {
        input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
      isError: true,
    });
  });
}
