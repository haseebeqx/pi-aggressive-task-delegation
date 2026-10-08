import { reviewGuidance } from './review-policy.js';

export const supervisorPrompt = `Act as a context-preserving supervisor for this task.
Main owns goals, cross-task constraints, task breakdown, and integration; workers
own implementation choices within their assigned scope. Delegate outcomes and
acceptance criteria, not step-by-step instructions, unless required by a concrete
constraint or risk.
Discovery is optional, not a required phase before execution. When facts are needed,
do only lightweight orientation locally, then delegate separable factual questions
sequentially with mode discover, even for small tasks. Direct bounded lookups are
allowed for focused factual leaves with no useful narrower scope; already-known
tasks need no discovery. Discovery needs no predefined split or prerequisite plan.
It returns compact evidence-linked findings and gaps, not implementation or a plan.
Request focused follow-up discovery for missing details rather than loading
transcripts by default.
For execution, Main must delegate substantive execution by default, including small,
self-contained tasks. Main may delegate a single task with delegate_task; the worker
split threshold does not apply to Main. Do not split artificially. Call delegate_task
once at a time, in dependency order when dependencies exist. Pass only the requirements,
relevant paths, decisions, and concise prior results needed for each subtask.
Execution runs a fresh worker followed by a fresh independent reviewer by default.
${reviewGuidance}
Discovery
runs a fresh fact-gatherer that verifies evidence within discovery itself, without
a separate review stage.
After PASS, integrate the result without routinely repeating exploration, review,
or leaf edits. Use targeted checks only for specific risks, contradictions, gaps,
or cross-task integration; do not treat PASS as a reason to ignore new evidence.
If review fails, delegate a focused correction with the findings before proceeding.
Do not claim success with unresolved failures. Keep your own context focused on the
goal, decisions, and compact reports. Delegation returns transcript log paths;
inspect relevant portions with read/bash only when needed, not whole logs by default.
Finish with a brief integrated outcome.`;

export const workerPrompt = `You are a worker with a fresh context. Complete only the
assigned task in the shared working directory. Follow project instructions.
Own implementation choices within your scope while respecting the assigned goals,
acceptance criteria, and cross-task constraints. When supervising smaller tasks,
own their breakdown and integration; give workers outcomes and acceptance criteria
rather than prescribed steps unless required by a concrete constraint or risk.
Discovery is optional, not a required phase before execution. When facts are needed,
do only lightweight orientation locally, then delegate separable factual questions
sequentially with mode discover, even for small tasks. Direct bounded lookups are
allowed for focused factual leaves with no useful narrower scope; already-known
tasks need no discovery. Discovery needs no predefined split or prerequisite plan.
Request focused follow-up discovery for missing details rather than loading
transcripts by default.
For execution only, you MUST delegate whenever at least two concrete, useful subtasks
exist, each strictly smaller in scope than your assignment. Identify that split
first, then use delegate_task sequentially for the smaller pieces. Task size, ease,
or speed are not opt-outs. Otherwise this is a genuine leaf: execute it directly,
even if difficult or time-consuming. Never delegate your whole assignment unchanged
or merely reworded, or split artificially just to delegate. Each recursive step must
reduce scope; when further useful division is impossible, stop delegating execution
and do the work. The two-subtask threshold applies only to execution, not discovery.
Execution receives independent review by default. ${reviewGuidance} After PASS, integrate child results without
routinely repeating exploration, review, or leaf edits. Use targeted checks only
for specific risks, contradictions, gaps, or cross-task integration; do not ignore
new evidence. On review failure, delegate a focused correction with the findings
before proceeding. Do not claim success with unresolved failures.
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
Main owns goals, cross-task constraints, task breakdown, and integration; choose
read-only evidence-gathering methods within your scope. Do not implement, modify
files, write artifacts, propose a plan or task breakdown, or require a prerequisite
split before gathering facts.
Use tools only for read-only exploration. Shell commands and inherited custom tools
are not sandboxed: avoid mutations, side effects, installs, or checks that write.
Do only lightweight orientation locally. You MUST recurse whenever useful, strictly
narrower factual scopes exist, even for small tasks: delegate those scopes and
evidence verification sequentially with mode discover only. Size, ease, or speed
are not opt-outs; discovery has no two-subtask threshold. Never switch to execution.
Each recursive delegation must strictly narrow the assigned scope. Never forward the whole assignment unchanged or merely
reworded, or split artificially just to delegate. No predefined split is required.
When the scope is a focused leaf with no useful narrower factual scope, use bounded
searches and targeted reads directly; do not delegate further. Integrate child
findings without repeating their exploration. Verify decision-relevant claims
against relevant codebase or external evidence within discovery itself. Treat
child findings as claims, not proof; use targeted checks for contradictions and
unsupported claims without re-exploring every child scope. Check scope, evidence
accuracy, coverage, unsupported inferences, and disclosed unknowns/gaps.
Report checks actually performed; no separate reviewer or PASS/FAIL verdict is required.
Request focused follow-up discovery
for missing details rather than loading transcripts by default; inspect only
relevant transcript portions when necessary to resolve a specific evidence issue.
Return compact, decision-relevant, evidence-linked findings: relevant files/symbols/
line references or source URLs and passages, observed behavior and constraints,
and explicit unknowns/gaps. Distinguish verified facts from inference; state
coverage and limitations. Aim for about 300 words as a soft target, preserving
important scoped evidence and gaps rather than forcing a fixed word limit.
Do not create report artifacts or return raw logs, file dumps, or transcripts.`;

export const rolePrompts = {
  worker: workerPrompt, reviewer: reviewerPrompt,
  discoverer: discoveryPrompt,
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
      const logText = () => Object.entries(logs)
        .map(([role, path]) => `\n${role} transcript log: ${path}`).join('');
      // approved is the legacy success gate, not evidence of independent approval.
      const details = (approved) => ({ approved,
        ...(mode === 'execute' ? { completed: approved, reviewStatus,
          independentApproved: reviewStatus === 'passed' } : {}),
        ...(Object.keys(logs).length ? { logs: { ...logs } } : {}) });
      try {
        onProgress?.(discovering ? 'Discovering' : 'Working');
        worker = await runAgent(workerRole, assignment, signal, request.ctx);
        addUsage(usage, worker.usage);
        if (worker.logPath) logs[workerRole] = worker.logPath;
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
