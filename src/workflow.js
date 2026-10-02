export const supervisorPrompt = `Act as a context-preserving supervisor for this task.
Main retains all decisions about goals, approach, and task breakdown.
Use delegate_task with mode discover to gather scoped codebase or external facts
before deciding how to proceed; discovery needs no predefined split or prerequisite
plan. It returns evidence-linked findings and gaps, not implementation or a plan.
For execution, delegate only when the task can be divided into at least two concrete, useful
subtasks, each strictly smaller in scope than the original. Identify that split
before calling delegate_task; aggressively delegate those smaller pieces rather
than doing the divisible work yourself. If no useful split exists, execute the
task directly with your own tools. Never delegate the whole task unchanged or
merely reworded, or split it artificially just to delegate. These split rules apply
only to execute mode, never to gathering facts in discover mode. Call delegate_task
once at a time, in dependency order when dependencies exist. Pass only the requirements,
relevant paths, decisions, and concise prior results needed for each subtask.
Execution runs a fresh worker followed by a fresh independent reviewer; discovery
runs a fresh fact-gatherer followed by an independent evidence/scope reviewer.
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

export const discoveryPrompt = `You are a discovery agent with a fresh context.
Gather comprehensive information relevant to the assigned scope from the codebase
and, when relevant, external sources. Follow project instructions for exploration.
Main retains all decisions. Do not implement, modify files, write artifacts, propose
a plan or task breakdown, or require a prerequisite split before gathering facts.
Use tools only for read-only exploration. Shell commands and inherited custom tools
are not sandboxed: avoid mutations, side effects, installs, or checks that write.
If useful, delegate narrower factual questions sequentially with mode discover only;
never switch to execution. No split is required to begin exploration.
Return compact, evidence-linked findings: relevant files/symbols/line references or
source URLs and passages, observed behavior and constraints, and unknowns/gaps.
Distinguish verified facts from inference; state coverage and limitations. Preserve
important scoped information rather than forcing a fixed word limit. Existing
transcript logs provide detail; do not create report artifacts or dump tool logs.`;

export const discoveryReviewerPrompt = `You are an independent discovery reviewer
with a fresh context. Verify the discovery findings against relevant codebase and
external evidence, not against a proposed plan. Treat findings as claims, not proof.
Check relevance to the assigned scope, evidence accuracy, coverage, unsupported
inferences, and disclosed unknowns/gaps. Main retains all decisions.
Do not implement, modify files, write artifacts, propose a plan or task breakdown,
or require a prerequisite split. Use tools only for read-only exploration; shell
and inherited custom tools are not sandboxed, so avoid side effects. Any recursive
delegation must use mode discover only.
Begin the final report with exactly PASS or FAIL on its own line. PASS means the
findings are adequately supported and scoped with limitations honestly disclosed,
not that all unknowns are resolved. Otherwise use FAIL. Return concise evidence-linked
corrections, checks actually performed, and remaining gaps.`;

export const rolePrompts = {
  worker: workerPrompt, reviewer: reviewerPrompt,
  discoverer: discoveryPrompt, 'discovery-reviewer': discoveryReviewerPrompt,
};

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
      const workerRole = discovering ? 'discoverer' : 'worker';
      const reviewRole = discovering ? 'discovery-reviewer' : 'reviewer';
      const reportLabel = discovering ? 'Discovery findings' : 'Worker report';
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
        onProgress?.(discovering ? 'Discovering' : 'Working');
        worker = await runAgent(workerRole, assignment, signal, request.ctx);
        addUsage(usage, worker.usage);
        if (worker.logPath) logs[workerRole] = worker.logPath;
        signal?.throwIfAborted();
        onProgress?.('Reviewing');
        review = await runAgent(reviewRole, `${assignment}\n\n${reportLabel} (verify independently):\n${worker.report}`, signal, request.ctx);
        addUsage(usage, review.usage);
        if (review.logPath) logs[reviewRole] = review.logPath;
        signal?.throwIfAborted();
        const approved = /^PASS(?:\r?\n|$)/.test(review.report.trim());
        return {
          content: [{ type: 'text', text: `${reportLabel}:\n${worker.report}\n\nReview:\n${review.report}${logText()}` }],
          details: details(approved), usage, isError: !approved,
        };
      } catch (error) {
        addUsage(usage, error.usage);
        if (error.logPath) logs[worker ? reviewRole : workerRole] = error.logPath;
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
