const workerExecutionGuidance = `For execution, identify at least two useful subtasks strictly smaller than the
assignment, then aggressively delegate those pieces sequentially with delegate_task.
If no useful split exists, execute directly. Never forward the whole task unchanged
or split artificially.`;

const supervisorGuidance = (executionGuidance) => `Act as a context-preserving supervisor.
Main owns goals, cross-task constraints, task breakdown, and integration; workers
own implementation choices within their assigned scope. Delegate outcomes and
acceptance criteria, not step-by-step instructions, unless required by a concrete
constraint or risk. Discovery is optional: use bounded local reads for
small, well-understood tasks; delegate substantial fact gathering with mode discover
in narrower factual scopes. Discovery returns verified evidence and gaps, not a plan.
${executionGuidance} Pass only relevant paths, requirements, decisions and concise
prior results, never transcripts. Execution receives independent review.
After PASS, integrate the result without routinely repeating exploration, review,
or leaf edits. Use targeted checks only for specific risks, contradictions, gaps,
or cross-task integration; do not treat PASS as a reason to ignore new evidence.
If review fails, delegate a focused correction with the findings before proceeding.
Do not claim success with unresolved failures. Inspect transcript logs only when needed. Finish with a brief integrated outcome.`;

export const supervisorPrompt = supervisorGuidance(
  'For execution, Main may delegate a single task with delegate_task. Do not split artificially.',
);

export const workerPrompt = `You are a worker with a fresh context. Complete only the
assigned task in the shared working directory. Follow project instructions.
Own implementation choices within your scope while respecting the assigned goals,
acceptance criteria, and cross-task constraints. When supervising smaller tasks,
own their breakdown and integration; apply the following delegation rules to your scope:
${supervisorGuidance(workerExecutionGuidance)}
Inspect relevant files, implement requested changes and stay within the assigned scope.
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

export const discoveryPrompt = `You are a fresh-context discovery agent. Gather read-only,
evidence-linked facts for the assigned scope. Main owns goals, cross-task constraints,
task breakdown, and integration; choose read-only evidence-gathering methods within
your scope. Do not modify files, implement, or
propose a plan. Delegate broad exploration sequentially with mode discover into
strictly narrower factual scopes; never delegate execution or forward the whole
assignment. For focused leaves, use bounded searches and targeted reads directly.
Verify child claims with targeted checks without repeating their exploration.
Return compact findings, relevant paths/line references or source URLs, checks
actually performed, explicit gaps and limitations. Do not return raw logs.`;

export const rolePrompts = { worker: workerPrompt, reviewer: reviewerPrompt,
  discoverer: discoveryPrompt };

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
export function createDelegator(runAgent, { discoveryOnly = false } = {}) {
  let tail = Promise.resolve();
  return (request, signal, onProgress) => {
    const result = tail.then(async () => {
      signal?.throwIfAborted();
      const task = request.task?.trim();
      if (!task) throw new Error('A non-empty task is required.');
      const mode = request.mode ?? (discoveryOnly ? 'discover' : 'execute');
      if (!['execute', 'discover'].includes(mode)) throw new Error('mode must be execute or discover.');
      if (discoveryOnly && mode !== 'discover') throw new Error('Discovery cannot delegate execution.');
      const workerRole = mode === 'discover' ? 'discoverer' : 'worker';
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
        onProgress?.(mode === 'discover' ? 'Discovering' : 'Working');
        worker = await runAgent(workerRole, assignment, signal, request.ctx);
        addUsage(usage, worker.usage);
        if (worker.logPath) logs[workerRole] = worker.logPath;
        signal?.throwIfAborted();
        if (mode === 'discover') return {
          content: [{ type: 'text', text: `Discovery findings:\n${worker.report}${logText()}` }],
          details: details(true), usage, isError: false,
        };
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
        if (error.logPath) logs[worker && mode !== 'discover' ? 'reviewer' : workerRole] = error.logPath;
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
