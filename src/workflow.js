export const workerPrompt = `You are a worker with a fresh context. Complete only the
assigned task in the shared working directory. Follow project instructions.
Execute this self-contained assignment directly with the available tools.
Do not delegate work or rely on unavailable delegation tools. Inspect the relevant
files, implement the requested changes, and keep your work within the assigned scope.
Verify your work. Return a concise report (aim for under 200 words) with:
Outcome; Files changed or relevant artifacts; Verification actually performed;
Unresolved issues. Include paths and facts needed for independent review.
Do not return tool logs, file dumps, or your internal reasoning.`;

export const reviewerPrompt = `You are an independent reviewer with a fresh context.
Review the assigned task against the actual workspace and the worker's report.
Treat the report as claims, not proof. Inspect relevant files and run appropriate
checks. Do not modify files or implement fixes. Report concrete failures and
missing verification; do not approve solely because the worker claims success.
Begin your final report with exactly PASS or FAIL on its own line, followed by
concise findings, checks actually performed, and any limitations (under 200 words).
PASS means the task's requirements are met; otherwise use FAIL.`;

export const rolePrompts = { worker: workerPrompt, reviewer: reviewerPrompt };

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

// Serialize complete worker/reviewer runs, including recovery after failures.
export function createDelegator(runAgent) {
  let tail = Promise.resolve();
  return (request, signal, onProgress) => {
    const result = tail.then(async () => {
      signal?.throwIfAborted();
      const task = request.task?.trim();
      if (!task) throw new Error('A non-empty task is required.');
      const context = request.context?.trim() || '(none supplied)';
      const assignment = `Assigned task:\n${task}\n\nRelevant context:\n${context}`;
      const usage = emptyUsage();
      let worker;
      let review;
      const logs = {};
      const logText = () => Object.entries(logs)
        .map(([role, path]) => `\n${role} transcript log: ${path}`).join('');
      const details = (approved) => ({ approved,
        ...(Object.keys(logs).length ? { logs: { ...logs } } : {}) });
      try {
        onProgress?.('Working');
        worker = await runAgent('worker', assignment, signal, request.ctx);
        addUsage(usage, worker.usage);
        if (worker.logPath) logs.worker = worker.logPath;
        signal?.throwIfAborted();
        onProgress?.('Reviewing');
        review = await runAgent('reviewer', `${assignment}\n\nWorker report (verify independently):\n${worker.report}`, signal, request.ctx);
        addUsage(usage, review.usage);
        if (review.logPath) logs.reviewer = review.logPath;
        signal?.throwIfAborted();
        const approved = /^PASS(?:\r?\n|$)/.test(review.report.trim());
        return {
          content: [{ type: 'text', text: `Worker report:\n${worker.report}\n\nReview:\n${review.report}${logText()}` }],
          details: details(approved), usage, isError: !approved,
        };
      } catch (error) {
        addUsage(usage, error.usage);
        if (error.logPath) logs[worker ? 'reviewer' : 'worker'] = error.logPath;
        return {
          content: [{ type: 'text', text: `Delegation failed: ${error.message}${worker ? `\n\nCompleted worker report:\n${worker.report}` : ''}${logText()}` }],
          details: details(false), usage, isError: true,
        };
      }
    });
    tail = result.catch(() => {});
    return result;
  };
}
