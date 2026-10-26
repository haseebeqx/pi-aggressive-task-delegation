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
  ['Main coordination ownership', /Main owns the goals, cross-task constraints, (?:task )?breakdown,? and integration/i],
  ['scoped worker implementation ownership', /Workers choose how to implement within their scope/i],
  ['outcome-oriented assignment', /Give workers outcomes and acceptance criteria/i],
  ['steps only for concrete constraints or risks', /not step-by-step instructions, unless a specific constraint or risk/i],
];
const mainRouting = [
  ['substantive default', /(?:By default, Main hands off|Main: by default, hand off) substantial implementation and context-heavy investigation/i],
  ['bounded orientation', /after a short orientation|First do a short orientation/i],
  ['observable routing triggers', /(?:multi-file change, real implementation plus tests, broad investigation|changes several files, needs real implementation plus tests, or needs broad investigation)/i],
  ['trivial work exception', /Small local edits.*?cheap lookups.*?(?:can )?stay local/i],
  ['whole cohesive handoff allowed', /(?:hand off the whole task in one piece; don't invent subtasks|Handing off the whole task is fine)/i],
];
const workerExecution = [
  ['direct when it fits context', /Do the assignment yourself if it fits comfortably in your context/i],
  ['early delegation under context pressure', /delegate early, before context gets tight/i],
  ['no unchanged or reworded forwarding', /Don't pass on your whole assignment unchanged or reworded/i],
  ['no artificial split', /don't split it artificially/i],
];
const discoveryUse = [
  ['optional not prerequisite', /Discovery is optional, not a required first step/i],
  ['bounded Main orientation', /Main keeps orientation short: a few targeted reads or searches, for routing or cheap facts only/i],
  ['no cheap discovery handoffs', /Don't start discovery for facts you can get cheaply yourself/i],
  ['substantial isolated discovery only', /Use mode discover only for a substantial, bounded investigation that benefits from a fresh context/i],
  ['facts and gaps rather than implementation or plans', /verified evidence and gaps, not implementation or plans/i],
  ['no separate discovery review', /gets no separate review/i],
  ['decision-relevant follow-up', /Follow up only on gaps that affect a decision/i],
];
const discoveryRecursion = [
  ['direct facts when scope fits', /Gather facts yourself if the scope fits comfortably in your context/i],
  ['early delegation under context pressure', /delegate early, before context gets tight/i],
  ['strict scope reduction', /strictly narrower factual scope/i],
  ['discovery only', /mode discover only/i],
  ['no execution delegation', /never delegate execution/i],
  ['no unchanged forwarding', /Don't pass on your whole assignment unchanged or reworded/i],
  ['no artificial split', /don't split it artificially/i],
  ['bounded direct lookup and stopping', /Use bounded searches and targeted reads, and stop once the assigned questions are answered/i],
];
const context = [
  ['sequential calls', /(?:Call delegate_task one at a time|Calls run one at a time)/i],
  ['dependency order', /in dependency order when it matters/i],
  ['minimal relevant context', /Pass only what's relevant: paths, user and project requirements, outcomes, acceptance criteria, decisions, and short verified reports from earlier workers. Don't pass transcripts/i],
  ['targeted transcript inspection', /Read only the relevant parts of a transcript when you need to, not whole logs/i],
];
const integration = [
  ['delegated independent review default', /When execution is delegated, independent review is on by default/i],
  ['PASS avoids duplicate work', /After a PASS, integrate the result without redoing exploration, review or small edits/i],
  ['targeted risk and integration checks', /targeted checks where there is a specific risk, contradiction, gap or cross-task issue/i],
  ['new evidence remains relevant', /don't ignore new evidence/i],
  ['direct narrow correction', /review fails, fix narrow findings yourself; delegate larger remaining work following your role's routing rules/i],
  ['no false success', /Don't claim success while failures remain unresolved/i],
];
const riskGuidance = [
  ['review defaults on', /Independent review is on by default/i],
  ['skip limited to narrow verified low risk', /review:false only for low-risk, narrow work the worker has concretely verified/i],
  ['redundant nested review exception', /or to avoid redundant nested reviews/i],
  ['risky work retains review', /Keep review for risky, security-sensitive or broad changes/i],
  ['uncertainty and user requirements retain review', /uncertain verification, or explicit user requirements/i],
  ['worker verification never skipped', /Skipping review never skips the worker's own verification/i],
  ['skipped review is not approval', /completion with review skipped is not a PASS or independent approval/i],
  ['integrate with limitation', /integrate the worker's report and note that limitation/i],
  ['mandatory whole-item gate', /In non-interactive task lists, the final review of each whole item is mandatory/i],
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
      ['handoff before broad work', /Hand off before exploring broadly or implementing; don't solve the task first/i],
      ['familiarity is not exemption', /being familiar with the code is not a reason to keep work/i],
      ['user and project delegation restrictions', /Follow the user's and project's delegation rules, including limits on using workers/i],
    ]);
    assert.doesNotMatch(prompts.supervisorPrompt, /if uncertain, work locally|benefit outweighs|Never forward the whole assignment/i);
    for (const child of [prompts.workerPrompt, prompts.discoveryPrompt]) {
      assert.doesNotMatch(child, /Main delegates substantive|Routing triggers include|whole cohesive scope/i);
    }
    check(prompts.supervisorPrompt, [['direct verification', /Verify your work, including work you did yourself/i]]);
    check(prompts.workerPrompt, workerExecution);
    check(prompts.workerPrompt, [
      ['assigned scope and constraints', /Do only the assigned task.*?respect the assigned goals,? acceptance criteria,? and cross-task constraints/i],
      ['mandatory verification', /Verify your work/i],
      ['compact outcome report', /short report.*?Outcome; Files changed or relevant artifacts; Verification actually performed.*?; Assumptions and unresolved issues/i],
      ['reviewable paths and facts', /paths and facts a reviewer needs/i],
      ['no raw dumps', /not tool logs, file dumps or your reasoning/i],
    ]);
  });
  test(`${workflow} reviewer: independent read-only workspace verification and strict verdict`, () => {
    check(prompts.reviewerPrompt, [
      ['independent fresh reviewer', /independent reviewer with a fresh context/i],
      ['actual workspace and worker report', /against the actual workspace and the worker report/i],
      ['claims are not proof', /claims as claims, not proof/i],
      ['files and checks', /read the relevant files and run appropriate checks/i],
      ['read-only reviewer', /Do not modify files or implement fixes/i],
      ['no claims-only approval', /Never approve just because the worker says it works/i],
      ['failure and verification gaps', /concrete failures and missing verification/i],
      ['strict verdict', /exactly PASS or FAIL on its own line/i],
      ['actual checks and limitations', /checks you actually performed, and limitations/i],
      ['PASS requires all requirements', /PASS means all task requirements are met; otherwise use FAIL/i],
    ]);
  });
  test(`${workflow} discovery: narrow recursion, read-only tools and verified evidence reports`, () => {
    check(prompts.discoveryPrompt, [...discoveryRecursion, ...context,
      ['Main owns coordination', /Main owns the goals, cross-task constraints, breakdown and integration/i],
      ['read-only evidence', /read-only, evidence-linked facts/i],
      ['no implementation, writes, artifacts or plans', /Do not implement, modify files, write artifacts, propose plans or task breakdowns/i],
      ['no prerequisite split', /or require a prerequisite split/i],
      ['unsandboxed side effects forbidden', /Tools are not sandboxed, so avoid anything that mutates state or has side effects: installs, checks that write/i],
      ['shell and inherited tools covered', /shell or inherited custom tools/i],
      ['no duplicate child exploration', /Combine child findings without repeating their exploration/i],
      ['verify evidence within discovery', /Verify the evidence that matters within discovery itself/i],
      ['child claims are not proof', /child claims as claims, not proof/i],
      ['targeted evidence checks', /targeted checks for contradictions or unsupported claims, not wholesale re-exploration/i],
      ['evidence coverage and inference checks', /Check scope, evidence accuracy, coverage, inferences and disclosed gaps/i],
      ['source references', /files\/symbols\/line references or source URLs and passages/i],
      ['behavior and constraints', /observed behavior and constraints/i],
      ['actual checks and explicit gaps', /checks you actually performed, and explicit unknowns\/gaps/i],
      ['facts distinct from inference', /Distinguish verified facts from inference/i],
      ['coverage and limitations', /state coverage and limitations/i],
      ['no separate verdict review', /No separate reviewer or PASS\/FAIL verdict is needed/i],
      ['no report artifacts or raw logs', /Do not create report artifacts or return raw logs, file dumps or transcripts/i],
    ]);
  });
}

test('user requirements override extension guidance in every role and tool description', () => {
  for (const name of ['supervisorPrompt', 'workerPrompt', 'reviewerPrompt', 'discoveryPrompt', 'delegationDescription']) {
    check(shared[name], [
      ['explicit precedence on conflict', /The user's requirements come first\. If they conflict with this guidance, the user wins/i],
      ['covers more than delegation opt-outs', /including on workflow, scope, methods and output format/i],
      ['propagates requirements to fresh contexts', /Pass the relevant requirements to every child task/i],
      ['project instructions and propagation', /Follow project instructions too \(such as AGENTS\.md delegation rules\) and pass those on/i],
      ['no silent requirement changes', /don't drop or reinterpret them/i],
      ['safety and runtime constraints remain', /Safety rules and hard tool limits still apply/i],
      ['honest conflict reporting', /say so instead of claiming you complied/i],
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
      ['sequential calls', /Calls run one at a time/i],
      ['minimal acceptance context', /pass outcomes, acceptance criteria, paths, user\/project requirements and verified reports, not transcripts/i],
      ['read-only optional discovery', /Optional mode discover is read-only, has no separate reviewer, and is not a prerequisite; it must avoid mutations and side effects/i],
      ['evidence and gaps', /return verified sources and gaps/i],
      ['verification without duplication', /Verify work; on PASS, integrate without repeating exploration or review/i],
      ['user and project delegation restrictions', /Follow user and project delegation limits/i],
      ['handoff before broad exploration', /after a short orientation, before exploring broadly/i],
      ['children may delegate when needed', /Workers, reviewers and discoverers may delegate when they would otherwise run short of context \(reviewers and discoverers: mode discover only\)/i],
      ['no forwarding', /Don't pass on unchanged assignments or invent splits/i],
      ['direct narrow fixes', /Fix narrow review failures yourself/i],
    ]);
    assert.ok(tool.description.split(/\s+/).length < 320, 'always-present description stays compact');
  });
}
