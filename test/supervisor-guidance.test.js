import test from 'node:test';
import assert from 'node:assert/strict';
import * as interactive from '../src/interactive-workflow.js';
import * as standalone from '../src/workflow.js';
import * as shared from '../src/role-prompts.js';
import { reviewGuidance } from '../src/review-policy.js';
import extension from '../src/extension.js';
import { registerDelegateTasks } from '../src/delegate-tasks.js';

// Check small policy concepts, not prompt snapshots or line wrapping.
const normalize = (prompt) => prompt.replace(/\s+/g, ' ').trim();
const check = (raw, concepts) => {
  const prompt = normalize(raw);
  for (const [concept, pattern] of concepts) assert.match(prompt, pattern, concept);
};
const ownership = [
  ['Main coordination ownership', /Main owns goals, cross-task constraints, (?:task )?breakdown, and integration/i],
  ['scoped worker implementation ownership', /workers own implementation choices within their (?:assigned )?scope/i],
  ['outcome-oriented assignment', /(?:Assign|Delegate) outcomes and acceptance criteria/i],
  ['steps only for concrete constraints or risks', /not prescribed steps, unless a concrete constraint or risk/i],
];
const mainExecution = [
  ['substantive default includes small work', /delegate substantive execution by default, including small,? self-contained tasks/i],
  ['single Main assignment', /Main may delegate a single task/i],
  ['Main exempt from worker threshold', /worker split threshold does not apply to Main/i],
  ['no manufactured splits', /Do not split artificially/i],
];
const workerExecution = [
  ['mandatory two useful tasks', /workers MUST delegate whenever at least two concrete, useful subtasks exist/i],
  ['strictly smaller pieces', /each strictly smaller (?:in scope )?than their assignment/i],
  ['identify split first', /Identify the split first, then call delegate_task/i],
  ['sequential execution', /delegate_task sequentially for (?:those|the smaller) pieces/i],
  ['no convenience opt-outs', /Size, ease, or speed are not opt-outs/i],
  ['no unchanged or reworded forwarding', /Never forward the whole assignment unchanged or merely reworded/i],
  ['no artificial split', /or split artificially/i],
  ['recursive scope reduction', /Each recursive step must reduce scope/i],
  ['unsplittable execution is direct', /no useful split remains, execute the genuine leaf directly/i],
  ['difficult leaves still direct', /even if difficult or time-consuming/i],
  ['execution-only threshold', /two-subtask threshold applies only to execution, not discovery/i],
];
const discoveryUse = [
  ['optional not prerequisite', /Discovery is optional, not a (?:prerequisite|required phase)/i],
  ['lightweight local orientation', /do only lightweight local orientation/i],
  ['lower delegation threshold', /delegate separable factual questions with mode discover, even for small tasks/i],
  ['bounded focused leaves', /Focused factual leaves with no useful narrower scope allow direct bounded lookups/i],
  ['known tasks need no discovery', /already-known tasks need no discovery/i],
  ['no prerequisite split or plan', /Discovery needs no predefined split or prerequisite plan/i],
  ['facts and gaps rather than implementation or plans', /verified evidence and gaps, not implementation or plans/i],
  ['no separate discovery review', /no separate review stage/i],
  ['focused missing-evidence follow-up', /focused follow-up discovery for missing details/i],
];
const discoveryRecursion = [
  ['mandatory strictly narrower factual recursion', /MUST recurse whenever useful, strictly narrower factual scopes exist/i],
  ['small tasks also recurse', /even for small tasks/i],
  ['discovery only', /mode discover only/i],
  ['no convenience opt-outs', /Size, ease, or speed are not opt-outs/i],
  ['no execution threshold', /no two-subtask threshold/i],
  ['strict recursive narrowing', /recursive step must strictly narrow scope/i],
  ['no unchanged or reworded forwarding', /Never forward the whole assignment unchanged or merely reworded/i],
  ['no artificial split', /or split artificially/i],
  ['no execution delegation', /never delegate execution/i],
  ['no prerequisite split', /No predefined split is required/i],
  ['focused leaves use bounded direct lookup', /focused leaves with no useful narrower scope, use bounded searches and targeted reads directly/i],
  ['leaf recursion stops', /without further delegation/i],
];
const context = [
  ['sequential calls', /Call delegate_task sequentially/i],
  ['dependency order', /in dependency order when needed/i],
  ['minimal relevant context', /Pass only relevant paths, requirements, decisions, and concise prior results, not transcripts/i],
  ['targeted transcript inspection', /only relevant transcript portions when needed, not whole logs by default/i],
];
const integration = [
  ['fresh independent review default', /fresh worker and fresh independent reviewer by default/i],
  ['PASS avoids duplicate work', /After PASS, integrate.*?without routinely repeating exploration, review, or leaf edits/i],
  ['targeted risk and integration checks', /targeted checks for specific risks, contradictions, gaps, or cross-task integration/i],
  ['new evidence remains relevant', /do not ignore new evidence/i],
  ['focused correction with findings', /review failure, delegate a focused correction with the findings before proceeding/i],
  ['no false success', /Do not claim success with unresolved failures/i],
];
const riskGuidance = [
  ['review defaults on', /Independent review defaults to true/i],
  ['skip limited to narrow verified low risk', /review:false only for low-risk, narrow work with concrete worker verification/i],
  ['redundant nested review exception', /or to avoid redundant nested reviews/i],
  ['risky work retains review', /(?:Keep|Retain) review for risky, security-sensitive or broad changes/i],
  ['uncertainty and user requirements retain review', /uncertain verification, or explicit user requirements/i],
  ['worker verification never skipped', /Skipping (?:independent )?review never skips worker verification/i],
  ['skipped review is not approval', /review-skipped completion is not PASS or independent approval/i],
  ['integrate with limitation', /integrate its worker report with that limitation/i],
  ['mandatory whole-item gate', /Non-interactive task-list whole-item review is mandatory/i],
];

for (const [workflow, prompts] of Object.entries({ interactive, standalone })) {
  test(`${workflow}: shared prompt exports cannot drift`, () => {
    for (const name of ['supervisorPrompt', 'workerPrompt', 'reviewerPrompt', 'discoveryPrompt', 'rolePrompts']) {
      assert.equal(prompts[name], shared[name], name);
    }
    assert.deepEqual(prompts.rolePrompts, {
      worker: prompts.workerPrompt, reviewer: prompts.reviewerPrompt, discoverer: prompts.discoveryPrompt,
    });
  });
  for (const role of ['supervisor', 'worker']) {
    const prompt = prompts[`${role}Prompt`];
    test(`${workflow} ${role}: ownership, discovery, context, integration and risk-based review`, () => {
      check(prompt, [...ownership, ...discoveryUse, ...context, ...integration, ...riskGuidance]);
      assert.ok(normalize(prompt).includes(normalize(reviewGuidance)), 'shared review guidance');
    });
  }
  test(`${workflow}: Main default delegation is distinct from mandatory worker splits`, () => {
    check(prompts.supervisorPrompt, mainExecution);
    assert.doesNotMatch(prompts.supervisorPrompt, /at least two|execute the genuine leaf/i);
    check(prompts.workerPrompt, workerExecution);
    assert.doesNotMatch(prompts.workerPrompt, /Main may delegate a single task/i);
    check(prompts.workerPrompt, [
      ['assigned scope and constraints', /Complete only the assigned task.*?respect the assigned goals, acceptance criteria, and cross-task constraints/i],
      ['recursive ownership', /smaller tasks, own their breakdown and integration/i],
      ['mandatory verification', /Verify your work/i],
      ['compact outcome report', /concise report.*?Outcome; Files changed or relevant artifacts; Verification actually performed; Unresolved issues/i],
      ['reviewable paths and facts', /paths and facts needed for independent review/i],
      ['no raw dumps', /not tool logs, file dumps, or internal reasoning/i],
    ]);
  });
  test(`${workflow} reviewer: independent read-only workspace verification and strict verdict`, () => {
    check(prompts.reviewerPrompt, [
      ['independent fresh reviewer', /independent reviewer with a fresh context/i],
      ['actual workspace and worker report', /against the actual workspace and worker report/i],
      ['claims are not proof', /claims as claims, not proof/i],
      ['files and checks', /inspect relevant files and run appropriate checks/i],
      ['read-only reviewer', /Do not modify files or implement fixes/i],
      ['no claims-only approval', /never approve solely on worker claims/i],
      ['failure and verification gaps', /concrete failures and missing verification/i],
      ['strict verdict', /exactly PASS or FAIL on its own line/i],
      ['actual checks and limitations', /checks actually performed, and limitations/i],
      ['PASS requires all requirements', /PASS means all task requirements are met; otherwise use FAIL/i],
    ]);
  });
  test(`${workflow} discovery: narrow recursion, read-only tools and verified evidence reports`, () => {
    check(prompts.discoveryPrompt, [...discoveryRecursion, ...context,
      ['Main owns coordination', /Main owns goals, cross-task constraints, breakdown, and integration/i],
      ['read-only evidence', /read-only, evidence-linked facts/i],
      ['no implementation, writes, artifacts or plans', /Do not implement, modify files, write artifacts, propose plans or task breakdowns/i],
      ['no prerequisite split', /or require a prerequisite split/i],
      ['unsandboxed side effects forbidden', /Tools are not sandboxed: avoid mutations, side effects, installs, and checks that write/i],
      ['shell and inherited tools covered', /including shell and inherited custom tools/i],
      ['lightweight orientation', /Do only lightweight local orientation/i],
      ['no duplicate child exploration', /Integrate child findings without repeating their exploration/i],
      ['verify evidence within discovery', /Verify decision-relevant evidence within discovery itself/i],
      ['child claims are not proof', /child claims as claims, not proof/i],
      ['targeted evidence checks', /targeted checks for contradictions or unsupported claims, not wholesale re-exploration/i],
      ['evidence coverage and inference checks', /Check scope, evidence accuracy, coverage, inferences, and disclosed gaps/i],
      ['focused gap correction', /focused follow-up discovery for missing details/i],
      ['source references', /files\/symbols\/line references or source URLs and passages/i],
      ['behavior and constraints', /observed behavior and constraints/i],
      ['actual checks and explicit gaps', /checks actually performed, and explicit unknowns\/gaps/i],
      ['facts distinct from inference', /Distinguish verified facts from inference/i],
      ['coverage and limitations', /state coverage and limitations/i],
      ['no separate verdict review', /No separate reviewer or PASS\/FAIL verdict is required/i],
      ['no report artifacts or raw logs', /Do not create report artifacts or return raw logs, file dumps, or transcripts/i],
    ]);
  });
}

// Exercise descriptions actually registered on both entry paths, not source text.
for (const [workflow, register] of Object.entries({ interactive: extension, standalone: registerDelegateTasks })) {
  test(`${workflow} tool description: shared policy, execution and discovery safeguards`, () => {
    let tool;
    register({ registerTool(value) { tool = value; }, registerCommand() {}, registerFlag() {},
      registerShortcut() {}, registerEntryRenderer() {}, on() {} });
    assert.equal(tool.description, shared.delegationDescription, 'shared tool description');
    assert.ok(normalize(tool.description).includes(normalize(reviewGuidance)), 'shared review guidance');
    check(tool.description, [...mainExecution, ...workerExecution, ...ownership, ...discoveryUse,
      ...discoveryRecursion, ...context, ...integration, ...riskGuidance,
      ['read-only tools without side effects', /read-only: no mutations, side effects, artifacts, installs, or checks that write/i],
      ['evidence and child verification', /Verify evidence and child claims with targeted checks/i],
      ['sources, checks and gaps', /report sources, actual checks, gaps and limitations/i],
      ['facts distinct from inference', /distinguishing facts from inference/i],
    ]);
  });
}
