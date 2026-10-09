export { supervisorPrompt, workerPrompt, reviewerPrompt, discoveryPrompt,
  rolePrompts } from './role-prompts.js';

export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function addUsage(total, usage) {
  if (!usage) return total;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
    total[key] += usage[key] ?? 0;
  }
  for (const key of Object.keys(total.cost)) total.cost[key] += usage.cost?.[key] ?? 0;
  return total;
}

// One queue per supervisor/worker context. Child contexts have their own queue,
// so recursive delegation can proceed while its parent awaits it.
export function createDelegator(runAgent, { discoveryOnly = false } = {}) {
  let tail = Promise.resolve();
  return (request, signal, onProgress) => {
    const result = tail.then(async () => {
      signal?.throwIfAborted();
      const task = request.task?.trim();
      if (!task) throw new Error('A non-empty task is required.');
      const mode = request.mode === undefined ? (discoveryOnly ? 'discover' : 'execute') : request.mode;
      if (mode !== 'execute' && mode !== 'discover') throw new Error('mode must be execute or discover.');
      if (discoveryOnly && mode !== 'discover') throw new Error('Discovery cannot delegate execution.');
      const discovering = mode === 'discover';
      if (request.review !== undefined && typeof request.review !== 'boolean') throw new Error('review must be a boolean.');
      const reviewEnabled = request.review !== false;
      let reviewStatus = mode === 'discover' ? 'not-applicable' : 'not-run';
      let reviewing = false;
      const workerRole = discovering ? 'discoverer' : 'worker';
      const reviewRole = 'reviewer';
      const reportLabel = discovering ? 'Discovery findings' : 'Worker report';
      const context = request.context?.trim() || '(none supplied)';
      const assignment = `Assigned task:\n${task}\n\nRelevant context:\n${context}`;
      const usage = emptyUsage();
      let worker;
      let review;
      const logs = {};
      const sessionIds = {};
      const logText = () => Object.entries(logs)
        .map(([role, path]) => `\n${role} transcript log: ${path}`).join('')
        + Object.entries(sessionIds)
          .map(([role, id]) => `\n${role} session ID: ${id}`).join('');
      // approved is the legacy success gate, not evidence of independent approval.
      const details = (approved) => ({ approved,
        ...(mode === 'execute' ? { completed: approved, reviewStatus,
          independentApproved: reviewStatus === 'passed' } : {}),
        ...(Object.keys(logs).length ? { logs: { ...logs } } : {}),
        ...(Object.keys(sessionIds).length ? { sessionIds: { ...sessionIds } } : {}) });
      try {
        onProgress?.(discovering ? 'Discovering' : 'Working');
        worker = await runAgent(workerRole, assignment, signal, request.ctx);
        addUsage(usage, worker.usage);
        if (worker.logPath) logs[workerRole] = worker.logPath;
        if (worker.sessionId) sessionIds[workerRole] = worker.sessionId;
        signal?.throwIfAborted();
        if (discovering) {
          return {
            content: [{ type: 'text', text: `${reportLabel}:\n${worker.report}${logText()}` }],
            details: details(true), usage, isError: false,
          };
        }
        if (!reviewEnabled) {
          reviewStatus = 'skipped';
          return {
            content: [{ type: 'text', text: `Worker report:
${worker.report}

Independent review skipped (review:false). Worker completion only; no independent approval.${logText()}` }],
            details: details(true), usage, isError: false,
          };
        }
        reviewing = true;
        reviewStatus = 'error';
        onProgress?.('Reviewing');
        review = await runAgent(reviewRole, `${assignment}\n\n${reportLabel} (verify independently):\n${worker.report}`, signal, request.ctx);
        addUsage(usage, review.usage);
        if (review.logPath) logs[reviewRole] = review.logPath;
        if (review.sessionId) sessionIds[reviewRole] = review.sessionId;
        signal?.throwIfAborted();
        const approved = /^PASS(?:\r?\n|$)/.test(review.report.trim());
        reviewStatus = approved ? 'passed' : 'failed';
        return {
          content: [{ type: 'text', text: `${reportLabel}:\n${worker.report}\n\nReview:\n${review.report}${logText()}` }],
          details: details(approved), usage, isError: !approved,
        };
      } catch (error) {
        addUsage(usage, error.usage);
        if (error.logPath) logs[reviewing ? reviewRole : workerRole] = error.logPath;
        if (error.sessionId) sessionIds[reviewing ? reviewRole : workerRole] = error.sessionId;
        return {
          content: [{ type: 'text', text: `Delegation failed: ${error.message}${worker ? `\n\nCompleted ${reportLabel.toLowerCase()}:\n${worker.report}` : ''}${logText()}` }],
          details: details(false), usage, isError: true,
        };
      }
    });
    tail = result.catch(() => {});
    return result;
  };
}
