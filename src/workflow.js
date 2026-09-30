export const supervisorPrompt = `Act as a context-preserving supervisor for this task.
Delegate only when the task can be divided into at least two concrete, useful
subtasks, each strictly smaller in scope than the original. Identify that split
before calling delegate_task; aggressively delegate those smaller pieces rather
than doing the divisible work yourself. If no useful split exists, execute the
task directly with your own tools. Never delegate the whole task unchanged or
merely reworded, or split it artificially just to delegate. Call delegate_task
once at a time, in dependency order. Pass only the requirements,
relevant paths, decisions, and concise prior results needed for each subtask.
Each delegation runs a fresh worker followed by a fresh independent reviewer.
If review fails, delegate a focused correction with the findings before proceeding.
Do not claim success with unresolved failures. Keep your own context focused on the
goal, decisions, and compact reports. Delegation returns transcript log paths;
inspect relevant portions with read/bash only when needed, not whole logs by default.
Finish with a brief integrated outcome.`;

export const workerPrompt = `You are a worker with a fresh context. Complete only the
assigned task in the shared working directory. Follow project instructions.
Delegate only if you can identify at least two concrete, useful subtasks, each
strictly smaller in scope than your assignment. Identify that split first, then
use delegate_task sequentially for the smaller pieces. Otherwise this is a leaf
task: execute it directly, even if it is difficult or time-consuming. Never
delegate your whole assignment unchanged or merely reworded, or split it
artificially just to delegate. Each recursive step must reduce scope; when further
useful division is impossible, stop delegating and do the work.
Pass minimal relevant context, not transcripts. Child transcript log paths are
available for targeted inspection with read/bash when needed.
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
