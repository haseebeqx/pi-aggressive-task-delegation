import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelegator, emptyUsage } from '../src/workflow.js';

test('standalone reviewed execution preserves logs and exposes worker/reviewer session IDs on PASS', async () => {
  const calls = [];
  const worker = {
    report: 'Implemented and verified.',
    logPath: '/logs/worker.jsonl',
    sessionId: 'worker-session-id',
    usage: {
      ...emptyUsage(),
      input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
  };
  const reviewer = {
    report: 'PASS\nIndependently verified.',
    logPath: '/logs/reviewer.jsonl',
    sessionId: 'reviewer-session-id',
    usage: {
      ...emptyUsage(),
      input: 13, output: 5, cacheRead: 4, cacheWrite: 1, totalTokens: 23,
      cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 26 },
    },
  };
  const delegate = createDelegator(async (role) => {
    calls.push(role);
    assert.ok(role === 'worker' || role === 'reviewer');
    return role === 'worker' ? worker : reviewer;
  });

  const result = await delegate({ task: 'Implement the change.', mode: 'execute', review: true });

  assert.deepEqual(calls, ['worker', 'reviewer']);
  assert.deepEqual(result.details.sessionIds, {
    worker: 'worker-session-id', reviewer: 'reviewer-session-id',
  });
  assert.deepEqual(result.details.logs, {
    worker: '/logs/worker.jsonl', reviewer: '/logs/reviewer.jsonl',
  });
  assert.deepEqual(result.content, [{
    type: 'text',
    text: 'Worker report:\nImplemented and verified.\n\nReview:\nPASS\nIndependently verified.'
      + '\nworker transcript log: /logs/worker.jsonl'
      + '\nreviewer transcript log: /logs/reviewer.jsonl'
      + '\nworker session ID: worker-session-id'
      + '\nreviewer session ID: reviewer-session-id',
  }]);
  assert.equal(result.details.approved, true);
  assert.equal(result.details.completed, true);
  assert.equal(result.details.reviewStatus, 'passed');
  assert.equal(result.details.independentApproved, true);
  assert.equal(result.isError, false);
  assert.deepEqual(result.usage, {
    input: 24, output: 12, cacheRead: 7, cacheWrite: 3, totalTokens: 46,
    cost: { input: 6, output: 8, cacheRead: 10, cacheWrite: 12, total: 36 },
  });
});

test('standalone reviewed execution preserves logs and exposes worker/reviewer session IDs on FAIL', async () => {
  const calls = [];
  const worker = {
    report: 'Implemented the change.',
    logPath: '/logs/failed-worker.jsonl',
    sessionId: 'failed-worker-session-id',
    usage: {
      ...emptyUsage(),
      input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
  };
  const reviewer = {
    report: 'FAIL\nVerification found a regression.',
    logPath: '/logs/failed-reviewer.jsonl',
    sessionId: 'failed-reviewer-session-id',
    usage: {
      ...emptyUsage(),
      input: 13, output: 5, cacheRead: 4, cacheWrite: 1, totalTokens: 23,
      cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 26 },
    },
  };
  const delegate = createDelegator(async (role) => {
    calls.push(role);
    assert.ok(role === 'worker' || role === 'reviewer');
    return role === 'worker' ? worker : reviewer;
  });

  const result = await delegate({ task: 'Implement the change.', mode: 'execute', review: true });

  assert.deepEqual(calls, ['worker', 'reviewer']);
  assert.deepEqual(result.details.sessionIds, {
    worker: 'failed-worker-session-id', reviewer: 'failed-reviewer-session-id',
  });
  assert.deepEqual(result.details.logs, {
    worker: '/logs/failed-worker.jsonl', reviewer: '/logs/failed-reviewer.jsonl',
  });
  assert.deepEqual(result.content, [{
    type: 'text',
    text: 'Worker report:\nImplemented the change.\n\nReview:\nFAIL\nVerification found a regression.'
      + '\nworker transcript log: /logs/failed-worker.jsonl'
      + '\nreviewer transcript log: /logs/failed-reviewer.jsonl'
      + '\nworker session ID: failed-worker-session-id'
      + '\nreviewer session ID: failed-reviewer-session-id',
  }]);
  assert.equal(result.details.approved, false);
  assert.equal(result.details.completed, false);
  assert.equal(result.details.reviewStatus, 'failed');
  assert.equal(result.details.independentApproved, false);
  assert.equal(result.isError, true);
  assert.deepEqual(result.usage, {
    input: 24, output: 12, cacheRead: 7, cacheWrite: 3, totalTokens: 46,
    cost: { input: 6, output: 8, cacheRead: 10, cacheWrite: 12, total: 36 },
  });
});

test('standalone execution with review:false preserves worker logs and session ID without independent approval', async () => {
  const calls = [];
  const worker = {
    report: 'Implemented and verified without review.',
    logPath: '/logs/unreviewed-worker.jsonl',
    sessionId: 'unreviewed-worker-session-id',
    usage: {
      ...emptyUsage(),
      input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
  };
  const delegate = createDelegator(async (role) => {
    calls.push(role);
    assert.equal(role, 'worker');
    return worker;
  });

  const result = await delegate({ task: 'Implement the change.', mode: 'execute', review: false });

  assert.deepEqual(calls, ['worker']);
  assert.deepEqual(result.details.sessionIds, { worker: 'unreviewed-worker-session-id' });
  assert.deepEqual(result.details.logs, { worker: '/logs/unreviewed-worker.jsonl' });
  assert.deepEqual(result.content, [{
    type: 'text',
    text: 'Worker report:\nImplemented and verified without review.'
      + '\n\nIndependent review skipped (review:false). Worker completion only; no independent approval.'
      + '\nworker transcript log: /logs/unreviewed-worker.jsonl'
      + '\nworker session ID: unreviewed-worker-session-id',
  }]);
  assert.equal(result.details.approved, true);
  assert.equal(result.details.completed, true);
  assert.equal(result.details.reviewStatus, 'skipped');
  assert.equal(result.details.independentApproved, false);
  assert.equal(result.isError, false);
  assert.deepEqual(result.usage, worker.usage);
});

test('standalone discovery preserves discoverer logs and session ID without execution status fields', async () => {
  const calls = [];
  const discoverer = {
    report: 'Verified the relevant facts.',
    logPath: '/logs/discoverer.jsonl',
    sessionId: 'discoverer-session-id',
    usage: {
      ...emptyUsage(),
      input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
  };
  const delegate = createDelegator(async (role) => {
    calls.push(role);
    assert.equal(role, 'discoverer');
    return discoverer;
  });

  const result = await delegate({ task: 'Discover the relevant facts.', mode: 'discover' });

  assert.deepEqual(calls, ['discoverer']);
  assert.deepEqual(result.details.sessionIds, { discoverer: 'discoverer-session-id' });
  assert.deepEqual(result.details.logs, { discoverer: '/logs/discoverer.jsonl' });
  assert.deepEqual(result.details, {
    approved: true,
    logs: { discoverer: '/logs/discoverer.jsonl' },
    sessionIds: { discoverer: 'discoverer-session-id' },
  });
  assert.deepEqual(result.content, [{
    type: 'text',
    text: 'Discovery findings:\nVerified the relevant facts.'
      + '\ndiscoverer transcript log: /logs/discoverer.jsonl'
      + '\ndiscoverer session ID: discoverer-session-id',
  }]);
  assert.equal(result.details.approved, true);
  assert.equal(result.isError, false);
  assert.deepEqual(result.usage, discoverer.usage);
});

test('standalone worker throw preserves error logs, session ID, and usage without running requested review', async () => {
  const calls = [];
  const error = Object.assign(new Error('Worker execution failed.'), {
    logPath: '/logs/thrown-worker.jsonl',
    sessionId: 'thrown-worker-session-id',
    usage: {
      ...emptyUsage(),
      input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
  });
  const delegate = createDelegator(async (role) => {
    calls.push(role);
    assert.equal(role, 'worker');
    throw error;
  });

  const result = await delegate({ task: 'Implement the change.', mode: 'execute', review: true });

  assert.deepEqual(calls, ['worker']);
  assert.deepEqual(result.details.logs, { worker: '/logs/thrown-worker.jsonl' });
  assert.deepEqual(result.details.sessionIds, { worker: 'thrown-worker-session-id' });
  assert.deepEqual(result.details, {
    approved: false,
    completed: false,
    reviewStatus: 'not-run',
    independentApproved: false,
    logs: { worker: '/logs/thrown-worker.jsonl' },
    sessionIds: { worker: 'thrown-worker-session-id' },
  });
  assert.deepEqual(result.content, [{
    type: 'text',
    text: 'Delegation failed: Worker execution failed.'
      + '\nworker transcript log: /logs/thrown-worker.jsonl'
      + '\nworker session ID: thrown-worker-session-id',
  }]);
  assert.equal(result.isError, true);
  assert.deepEqual(result.usage, error.usage);
});

test('standalone reviewer throw preserves completed worker report, both logs and session IDs, and aggregated usage', async () => {
  const calls = [];
  const worker = {
    report: 'Implemented and verified.',
    logPath: '/logs/completed-worker.jsonl',
    sessionId: 'completed-worker-session-id',
    usage: {
      ...emptyUsage(),
      input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
  };
  const error = Object.assign(new Error('Reviewer execution failed.'), {
    logPath: '/logs/thrown-reviewer.jsonl',
    sessionId: 'thrown-reviewer-session-id',
    usage: {
      ...emptyUsage(),
      input: 13, output: 5, cacheRead: 4, cacheWrite: 1, totalTokens: 23,
      cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 26 },
    },
  });
  const delegate = createDelegator(async (role) => {
    calls.push(role);
    assert.ok(role === 'worker' || role === 'reviewer');
    if (role === 'worker') return worker;
    throw error;
  });

  const result = await delegate({ task: 'Implement the change.', mode: 'execute', review: true });

  assert.deepEqual(calls, ['worker', 'reviewer']);
  assert.deepEqual(result.details.logs, {
    worker: '/logs/completed-worker.jsonl', reviewer: '/logs/thrown-reviewer.jsonl',
  });
  assert.deepEqual(result.details.sessionIds, {
    worker: 'completed-worker-session-id', reviewer: 'thrown-reviewer-session-id',
  });
  assert.deepEqual(result.details, {
    approved: false,
    completed: false,
    reviewStatus: 'error',
    independentApproved: false,
    logs: { worker: '/logs/completed-worker.jsonl', reviewer: '/logs/thrown-reviewer.jsonl' },
    sessionIds: { worker: 'completed-worker-session-id', reviewer: 'thrown-reviewer-session-id' },
  });
  assert.deepEqual(result.content, [{
    type: 'text',
    text: 'Delegation failed: Reviewer execution failed.'
      + '\n\nCompleted worker report:\nImplemented and verified.'
      + '\nworker transcript log: /logs/completed-worker.jsonl'
      + '\nreviewer transcript log: /logs/thrown-reviewer.jsonl'
      + '\nworker session ID: completed-worker-session-id'
      + '\nreviewer session ID: thrown-reviewer-session-id',
  }]);
  assert.equal(result.isError, true);
  assert.deepEqual(result.usage, {
    input: 24, output: 12, cacheRead: 7, cacheWrite: 3, totalTokens: 46,
    cost: { input: 6, output: 8, cacheRead: 10, cacheWrite: 12, total: 36 },
  });
});

test('standalone discoverer throw preserves error logs, session ID, and usage without execution status fields', async () => {
  const calls = [];
  const error = Object.assign(new Error('Discovery failed.'), {
    logPath: '/logs/thrown-discoverer.jsonl',
    sessionId: 'thrown-discoverer-session-id',
    usage: {
      ...emptyUsage(),
      input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
  });
  const delegate = createDelegator(async (role) => {
    calls.push(role);
    assert.equal(role, 'discoverer');
    throw error;
  });

  const result = await delegate({ task: 'Discover the relevant facts.', mode: 'discover' });

  assert.deepEqual(calls, ['discoverer']);
  assert.deepEqual(result.details, {
    approved: false,
    logs: { discoverer: '/logs/thrown-discoverer.jsonl' },
    sessionIds: { discoverer: 'thrown-discoverer-session-id' },
  });
  assert.deepEqual(result.content, [{
    type: 'text',
    text: 'Delegation failed: Discovery failed.'
      + '\ndiscoverer transcript log: /logs/thrown-discoverer.jsonl'
      + '\ndiscoverer session ID: thrown-discoverer-session-id',
  }]);
  assert.equal(result.isError, true);
  assert.deepEqual(result.usage, error.usage);
});

const reviewedSessionIdOmissionCases = [
  { name: 'both session IDs missing', workerIds: {}, reviewerIds: {}, expectedIds: null },
  { name: 'both session IDs empty', workerIds: { sessionId: '' }, reviewerIds: { sessionId: '' }, expectedIds: null },
  { name: 'worker session ID missing and reviewer session ID empty', workerIds: {}, reviewerIds: { sessionId: '' }, expectedIds: null },
  { name: 'worker session ID empty and reviewer session ID missing', workerIds: { sessionId: '' }, reviewerIds: {}, expectedIds: null },
  { name: 'worker-only session ID with reviewer ID missing', workerIds: { sessionId: 'worker-session-id' }, reviewerIds: {}, expectedIds: { worker: 'worker-session-id' } },
  { name: 'worker-only session ID with reviewer ID empty', workerIds: { sessionId: 'worker-session-id' }, reviewerIds: { sessionId: '' }, expectedIds: { worker: 'worker-session-id' } },
  { name: 'reviewer-only session ID with worker ID missing', workerIds: {}, reviewerIds: { sessionId: 'reviewer-session-id' }, expectedIds: { reviewer: 'reviewer-session-id' } },
  { name: 'reviewer-only session ID with worker ID empty', workerIds: { sessionId: '' }, reviewerIds: { sessionId: 'reviewer-session-id' }, expectedIds: { reviewer: 'reviewer-session-id' } },
];

for (const verdict of ['PASS', 'FAIL']) {
  for (const { name, workerIds, reviewerIds, expectedIds } of reviewedSessionIdOmissionCases) {
    test(`standalone reviewed execution on ${verdict} preserves logs with ${name}`, async () => {
      const calls = [];
      const worker = {
        report: 'Implemented and verified.',
        logPath: '/logs/worker.jsonl',
        ...workerIds,
        usage: {
          ...emptyUsage(),
          input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
          cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        },
      };
      const reviewer = {
        report: `${verdict}\nIndependent verification finished.`,
        logPath: '/logs/reviewer.jsonl',
        ...reviewerIds,
        usage: {
          ...emptyUsage(),
          input: 13, output: 5, cacheRead: 4, cacheWrite: 1, totalTokens: 23,
          cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 26 },
        },
      };
      const delegate = createDelegator(async (role) => {
        calls.push(role);
        assert.ok(role === 'worker' || role === 'reviewer');
        return role === 'worker' ? worker : reviewer;
      });

      const result = await delegate({ task: 'Implement the change.', mode: 'execute', review: true });
      const approved = verdict === 'PASS';
      const sessionText = expectedIds?.worker ? '\nworker session ID: worker-session-id'
        : expectedIds?.reviewer ? '\nreviewer session ID: reviewer-session-id' : '';

      assert.deepEqual(calls, ['worker', 'reviewer']);
      assert.deepEqual(result.content, [{
        type: 'text',
        text: `Worker report:\nImplemented and verified.\n\nReview:\n${verdict}\nIndependent verification finished.`
          + '\nworker transcript log: /logs/worker.jsonl'
          + '\nreviewer transcript log: /logs/reviewer.jsonl'
          + sessionText,
      }]);
      assert.equal(Object.hasOwn(result.details, 'sessionIds'), expectedIds !== null);
      assert.deepEqual(result.details, {
        approved,
        completed: approved,
        reviewStatus: approved ? 'passed' : 'failed',
        independentApproved: approved,
        logs: { worker: '/logs/worker.jsonl', reviewer: '/logs/reviewer.jsonl' },
        ...(expectedIds === null ? {} : { sessionIds: expectedIds }),
      });
      assert.equal(result.isError, !approved);
      assert.deepEqual(result.usage, {
        input: 24, output: 12, cacheRead: 7, cacheWrite: 3, totalTokens: 46,
        cost: { input: 6, output: 8, cacheRead: 10, cacheWrite: 12, total: 36 },
      });
    });
  }
}

const unreviewedSessionIdOmissionCases = [
  { name: 'missing session ID', workerIds: {} },
  { name: 'empty-string session ID', workerIds: { sessionId: '' } },
];

for (const { name, workerIds } of unreviewedSessionIdOmissionCases) {
  test(`standalone execution with review:false preserves worker logs with ${name}`, async () => {
    const calls = [];
    const worker = {
      report: 'Implemented and verified without review.',
      logPath: '/logs/unreviewed-worker.jsonl',
      ...workerIds,
      usage: {
        ...emptyUsage(),
        input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
    };
    const delegate = createDelegator(async (role) => {
      calls.push(role);
      assert.equal(role, 'worker');
      return worker;
    });

    const result = await delegate({ task: 'Implement the change.', mode: 'execute', review: false });

    assert.deepEqual(calls, ['worker']);
    assert.equal(Object.hasOwn(result.details, 'sessionIds'), false);
    assert.deepEqual(result.details, {
      approved: true,
      completed: true,
      reviewStatus: 'skipped',
      independentApproved: false,
      logs: { worker: '/logs/unreviewed-worker.jsonl' },
    });
    assert.deepEqual(result.content, [{
      type: 'text',
      text: 'Worker report:\nImplemented and verified without review.'
        + '\n\nIndependent review skipped (review:false). Worker completion only; no independent approval.'
        + '\nworker transcript log: /logs/unreviewed-worker.jsonl',
    }]);
    assert.equal(result.isError, false);
    assert.deepEqual(result.usage, {
      input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    });
  });
}

const discoverySessionIdOmissionCases = [
  { name: 'missing session ID', discovererIds: {} },
  { name: 'empty-string session ID', discovererIds: { sessionId: '' } },
];

for (const { name, discovererIds } of discoverySessionIdOmissionCases) {
  test(`standalone discovery preserves discoverer logs with ${name}`, async () => {
    const calls = [];
    const discoverer = {
      report: 'Verified the relevant facts.',
      logPath: '/logs/discoverer.jsonl',
      ...discovererIds,
      usage: {
        ...emptyUsage(),
        input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
    };
    const delegate = createDelegator(async (role) => {
      calls.push(role);
      assert.equal(role, 'discoverer');
      return discoverer;
    });

    const result = await delegate({ task: 'Discover the relevant facts.', mode: 'discover' });

    assert.deepEqual(calls, ['discoverer']);
    assert.equal(Object.hasOwn(result.details, 'sessionIds'), false);
    assert.deepEqual(result.details, {
      approved: true,
      logs: { discoverer: '/logs/discoverer.jsonl' },
    });
    assert.deepEqual(result.content, [{
      type: 'text',
      text: 'Discovery findings:\nVerified the relevant facts.'
        + '\ndiscoverer transcript log: /logs/discoverer.jsonl',
    }]);
    assert.equal(result.isError, false);
    assert.deepEqual(result.usage, {
      input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    });
  });
}

const workerThrowSessionIdOmissionCases = [
  { name: 'missing session ID', errorIds: {} },
  { name: 'empty-string session ID', errorIds: { sessionId: '' } },
];

for (const { name, errorIds } of workerThrowSessionIdOmissionCases) {
  test(`standalone worker throw preserves error logs and usage with ${name} without running requested review`, async () => {
    const calls = [];
    const error = Object.assign(new Error('Worker execution failed.'), {
      logPath: '/logs/thrown-worker.jsonl',
      ...errorIds,
      usage: {
        ...emptyUsage(),
        input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
    });
    const delegate = createDelegator(async (role) => {
      calls.push(role);
      assert.equal(role, 'worker');
      throw error;
    });

    const result = await delegate({ task: 'Implement the change.', mode: 'execute', review: true });

    assert.deepEqual(calls, ['worker']);
    assert.equal(Object.hasOwn(result.details, 'sessionIds'), false);
    assert.deepEqual(result.details, {
      approved: false,
      completed: false,
      reviewStatus: 'not-run',
      independentApproved: false,
      logs: { worker: '/logs/thrown-worker.jsonl' },
    });
    assert.deepEqual(result.content, [{
      type: 'text',
      text: 'Delegation failed: Worker execution failed.'
        + '\nworker transcript log: /logs/thrown-worker.jsonl',
    }]);
    assert.equal(result.isError, true);
    assert.deepEqual(result.usage, {
      input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    });
  });
}

const discovererThrowSessionIdOmissionCases = [
  { name: 'missing session ID', errorIds: {} },
  { name: 'empty-string session ID', errorIds: { sessionId: '' } },
];

for (const { name, errorIds } of discovererThrowSessionIdOmissionCases) {
  test(`standalone discoverer throw preserves error logs and usage with ${name}`, async () => {
    const calls = [];
    const error = Object.assign(new Error('Discovery failed.'), {
      logPath: '/logs/thrown-discoverer.jsonl',
      ...errorIds,
      usage: {
        ...emptyUsage(),
        input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
    });
    const delegate = createDelegator(async (role) => {
      calls.push(role);
      assert.equal(role, 'discoverer');
      throw error;
    });

    const result = await delegate({ task: 'Discover the relevant facts.', mode: 'discover' });

    assert.deepEqual(calls, ['discoverer']);
    assert.equal(Object.hasOwn(result.details, 'sessionIds'), false);
    assert.deepEqual(result.details, {
      approved: false,
      logs: { discoverer: '/logs/thrown-discoverer.jsonl' },
    });
    assert.deepEqual(result.content, [{
      type: 'text',
      text: 'Delegation failed: Discovery failed.'
        + '\ndiscoverer transcript log: /logs/thrown-discoverer.jsonl',
    }]);
    assert.equal(result.isError, true);
    assert.deepEqual(result.usage, {
      input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    });
  });
}

for (const { name, workerIds, reviewerIds, expectedIds } of reviewedSessionIdOmissionCases) {
  test(`standalone reviewer throw preserves completed worker report, logs and usage with ${name}`, async () => {
    const calls = [];
    const worker = {
      report: 'Implemented and verified.',
      logPath: '/logs/worker.jsonl',
      ...workerIds,
      usage: {
        ...emptyUsage(),
        input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
    };
    const error = Object.assign(new Error('Independent review failed.'), {
      logPath: '/logs/thrown-reviewer.jsonl',
      ...reviewerIds,
      usage: {
        ...emptyUsage(),
        input: 13, output: 5, cacheRead: 4, cacheWrite: 1, totalTokens: 23,
        cost: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, total: 26 },
      },
    });
    const delegate = createDelegator(async (role) => {
      calls.push(role);
      assert.ok(role === 'worker' || role === 'reviewer');
      if (role === 'worker') return worker;
      throw error;
    });

    const result = await delegate({ task: 'Implement the change.', mode: 'execute', review: true });
    const sessionText = expectedIds?.worker ? '\nworker session ID: worker-session-id'
      : expectedIds?.reviewer ? '\nreviewer session ID: reviewer-session-id' : '';

    assert.deepEqual(calls, ['worker', 'reviewer']);
    assert.equal(Object.hasOwn(result.details, 'sessionIds'), expectedIds !== null);
    assert.deepEqual(result.details, {
      approved: false,
      completed: false,
      reviewStatus: 'error',
      independentApproved: false,
      logs: { worker: '/logs/worker.jsonl', reviewer: '/logs/thrown-reviewer.jsonl' },
      ...(expectedIds === null ? {} : { sessionIds: expectedIds }),
    });
    assert.deepEqual(result.content, [{
      type: 'text',
      text: 'Delegation failed: Independent review failed.'
        + '\n\nCompleted worker report:\nImplemented and verified.'
        + '\nworker transcript log: /logs/worker.jsonl'
        + '\nreviewer transcript log: /logs/thrown-reviewer.jsonl'
        + sessionText,
    }]);
    assert.equal(result.isError, true);
    assert.deepEqual(result.usage, {
      input: 24, output: 12, cacheRead: 7, cacheWrite: 3, totalTokens: 46,
      cost: { input: 6, output: 8, cacheRead: 10, cacheWrite: 12, total: 36 },
    });
  });
}
