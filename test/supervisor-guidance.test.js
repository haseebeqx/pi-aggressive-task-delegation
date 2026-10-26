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
const mainRouting = [
  ['substantive default', /Main(?:: delegate| delegates) substantive implementation or context-heavy investigation by default/i],
  ['bounded orientation', /after brief bounded orientation/i],
  ['observable routing triggers', /multi-file change, meaningful implementation plus tests, (?:or )?broad investigation/i],
  ['trivial work exception', /Trivial localized edits.*?cheap lookups.*?may stay local/i],
  ['whole cohesive handoff allowed', /(?:whole cohesive scope without manufacturing subtasks|Whole cohesive scope is allowed)/i],
];
const workerExecution = [
  ['direct when it fits context', /Complete your assignment directly when it fits comfortably in your context/i],
  ['early delegation under context pressure', /Never struggle with limited context: delegate early, before context pressure builds/i],
  ['no unchanged or reworded forwarding', /Never forward the whole assignment unchanged or merely reworded/i],
  ['no artificial split', /or split artificially/i],
];
const discoveryUse = [
  ['optional not prerequisite', /Discovery is optional, not a prerequisite/i],
  ['bounded Main orientation', /Main keeps orientation bounded, using targeted local reads and searches for routing or cheap facts only/i],
  ['no cheap discovery handoffs', /do not launch discovery for facts you can cheaply obtain directly/i],
  ['substantial isolated discovery only', /Delegate mode discover only for a substantial, bounded investigation that benefits from a fresh context/i],
  ['facts and gaps rather than implementation or plans', /verified evidence and gaps, not implementation or plans/i],
  ['no separate discovery review', /no separate review stage/i],
  ['decision-relevant follow-up', /Follow up only on decision-relevant gaps/i],
];
const discoveryRecursion = [
  ['direct facts when scope fits', /Gather facts directly when the scope fits comfortably in your context/i],
  ['early delegation under context pressure', /Never struggle with limited context: delegate early, before context pressure builds/i],
  ['strict scope reduction', /strictly narrower factual scope/i],
  ['discovery only', /mode discover only/i],
  ['no execution delegation', /never delegate execution/i],
  ['no unchanged forwarding', /Never forward the whole assignment unchanged or merely reworded/i],
  ['no artificial split', /or split artificially/i],
  ['bounded direct lookup and stopping', /Use bounded searches and targeted reads; stop when the assigned questions are answered/i],
];
const context = [
  ['sequential calls', /Call delegate_task sequentially/i],
  ['dependency order', /in dependency order when needed/i],
  ['minimal relevant context', /Pass only relevant paths, user and project requirements, outcomes, acceptance criteria, decisions, and concise verified prior worker reports, not transcripts/i],
  ['targeted transcript inspection', /only relevant transcript portions when needed, not whole logs by default/i],
];
const integration = [
  ['delegated independent review default', /When execution is delegated, independent review is enabled by default/i],
  ['PASS avoids duplicate work', /After PASS, integrate.*?without routinely repeating exploration, review, or leaf edits/i],
  ['targeted risk and integration checks', /targeted checks for specific risks, contradictions, gaps, or cross-task integration/i],
  ['new evidence remains relevant', /do not ignore new evidence/i],
  ['direct narrow correction', /review failure, fix narrow findings directly; delegate substantial remaining scope using the role-specific routing policy/i],
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
  test(`${workflow}: Main routes substantive scopes; workers avoid automatic recursion`, () => {
    check(prompts.supervisorPrompt, [...mainRouting,
      ['handoff before broad work', /Hand off before broad exploration or implementation; do not solve the task first/i],
      ['familiarity is not exemption', /familiarity alone is not an exemption/i],
      ['user and project delegation restrictions', /Respect user and applicable project delegation requirements, including restrictions on using workers/i],
    ]);
    assert.doesNotMatch(prompts.supervisorPrompt, /if uncertain, work locally|benefit outweighs|Never forward the whole assignment/i);
    for (const child of [prompts.workerPrompt, prompts.discoveryPrompt]) {
      assert.doesNotMatch(child, /Main delegates substantive|Routing triggers include|whole cohesive scope/i);
    }
    check(prompts.supervisorPrompt, [['direct verification', /Verify your work, including work done directly/i]]);
    check(prompts.workerPrompt, workerExecution);
    check(prompts.workerPrompt, [
      ['assigned scope and constraints', /Complete only the assigned task.*?respect the assigned goals, acceptance criteria, and cross-task constraints/i],
      ['mandatory verification', /Verify your work/i],
      ['compact outcome report', /concise report.*?Outcome; Files changed or relevant artifacts; Verification actually performed.*?; Assumptions and unresolved issues/i],
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
      ['no duplicate child exploration', /Integrate child findings without repeating their exploration/i],
      ['verify evidence within discovery', /Verify decision-relevant evidence within discovery itself/i],
      ['child claims are not proof', /child claims as claims, not proof/i],
      ['targeted evidence checks', /targeted checks for contradictions or unsupported claims, not wholesale re-exploration/i],
      ['evidence coverage and inference checks', /Check scope, evidence accuracy, coverage, inferences, and disclosed gaps/i],
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

test('user requirements override extension guidance in every role and tool description', () => {
  for (const name of ['supervisorPrompt', 'workerPrompt', 'reviewerPrompt', 'discoveryPrompt', 'delegationDescription']) {
    check(shared[name], [
      ['explicit precedence on conflict', /User requirements take precedence over this extension's prompt guidance when they conflict/i],
      ['covers more than delegation opt-outs', /including workflow, scope, methods, and output format/i],
      ['propagates requirements to fresh contexts', /Preserve relevant user requirements in every child assignment/i],
      ['project instructions and propagation', /Honor applicable project instructions, including AGENTS\.md delegation requirements, and carry them into child assignments/i],
      ['no silent requirement changes', /never silently drop or reinterpret them/i],
      ['safety and runtime constraints remain', /does not override platform safety rules or hard tool constraints/i],
      ['honest conflict reporting', /If a hard constraint prevents compliance, explain the conflict rather than claim compliance/i],
    ]);
  }
});

test('no prompt or tool description mandates delegation for its own sake', () => {
  for (const name of ['supervisorPrompt', 'workerPrompt', 'discoveryPrompt', 'delegationDescription']) {
    assert.doesNotMatch(shared[name], /MUST delegate|MUST recurse|must delegate substantive|Size, ease, or speed are not opt-outs|even for small tasks/i, name);
  }
});

// Exercise descriptions actually registered on both entry paths, not source text.
for (const [workflow, register] of Object.entries({ interactive: extension, standalone: registerDelegateTasks })) {
  test(`${workflow} tool description: shared policy, execution and discovery safeguards`, () => {
    let tool;
    register({ registerTool(value) { tool = value; }, registerCommand() {}, registerFlag() {},
      registerShortcut() {}, registerEntryRenderer() {}, on() {} });
    assert.equal(tool.description, shared.delegationDescription, 'shared tool description');
    assert.ok(normalize(tool.description).includes(normalize(reviewGuidance)), 'shared review guidance');
    check(tool.description, [...mainRouting, ...riskGuidance,
      ['sequential calls', /Calls are sequential/i],
      ['minimal acceptance context', /pass outcomes, acceptance criteria, paths, user\/project requirements and verified reports, not transcripts/i],
      ['read-only optional discovery', /Optional mode discover is read-only with no separate reviewer, not a prerequisite; avoid mutations\/side effects/i],
      ['evidence and gaps', /return verified sources and gaps/i],
      ['verification without duplication', /Verify work; integrate PASS without duplicate exploration\/review/i],
      ['user and project delegation restrictions', /Honor user\/project delegation restrictions/i],
      ['handoff before broad exploration', /after brief bounded orientation, before broad exploration/i],
      ['children may delegate when needed', /Workers, reviewers and discoverers may delegate when needed so context never runs short \(reviewers and discoverers: mode discover only\)/i],
      ['no forwarding', /Never forward unchanged assignments or manufacture splits/i],
      ['direct narrow fixes', /Fix narrow review failures directly/i],
    ]);
    assert.ok(tool.description.split(/\s+/).length < 320, 'always-present description stays compact');
  });
}
