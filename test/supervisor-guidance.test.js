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
  ['Main coordination ownership', /Main owns.*?goals.*?constraints.*?breakdown.*?integration/i],
  ['scoped worker implementation ownership', /Workers choose how to implement/i],
  ['outcome-oriented assignment', /outcomes and acceptance criteria/i],
  ['steps only for concrete constraints or risks', /not step-by-step.*?unless.*?constraint or risk/i],
];
const mainRouting = [
  ['substantive default', /by default,? (?:Main )?delegates? substantial implementation and context-heavy investigation/i],
  ['bounded orientation', /short orientation/i],
  ['observable routing triggers', /multi-file change.*?implementation plus tests.*?broad investigation/i],
  ['trivial work exception', /Small local edits.*?cheap lookups.*?stay local/i],
  ['whole cohesive handoff allowed', /(?:delegat\w+) the whole task/i],
];
const workerExecution = [
  ['direct when it fits context', /yourself if it fits comfortably in your context/i],
  ['early delegation under context pressure', /struggle with limited context.*?delegate early/i],
  ['no unchanged or reworded forwarding', /(?:Don't|Never) (?:pass on|forward) your whole assignment unchanged/i],
  ['no artificial split', /split it artificially/i],
];
const discoveryUse = [
  ['optional not prerequisite', /Discovery is optional, not a required/i],
  ['bounded Main orientation', /orientation short.*?routing or cheap facts only/i],
  ['no cheap discovery handoffs', /Don't start discovery for facts you can get cheaply/i],
  ['substantial isolated discovery only', /mode discover only for a substantial, bounded investigation/i],
  ['facts and gaps rather than implementation or plans', /evidence and gaps, not implementation or plans/i],
  ['no separate discovery review', /no separate review/i],
  ['decision-relevant follow-up', /Follow up only on gaps that affect a decision/i],
];
const discoveryRecursion = [
  ['direct facts when scope fits', /Gather facts yourself if the scope fits/i],
  ['early delegation under context pressure', /struggle with limited context.*?delegate early/i],
  ['strict scope reduction', /strictly narrower/i],
  ['discovery only', /mode discover only/i],
  ['no execution delegation', /never delegate execution/i],
  ['no unchanged forwarding', /pass on your whole assignment unchanged/i],
  ['no artificial split', /split it artificially/i],
  ['bounded direct lookup and stopping', /bounded searches.*?stop once/i],
];
const context = [
  ['sequential calls', /one at a time/i],
  ['dependency order', /dependency order/i],
  ['minimal relevant context', /Pass only what's relevant.*?acceptance criteria.*?Don't pass transcripts/i],
  ['targeted transcript inspection', /only the relevant parts of a transcript/i],
];
const integration = [
  ['delegated independent review default', /execution is delegated, independent review is on by default/i],
  ['PASS avoids duplicate work', /After a PASS, integrate.*?without redoing exploration, review/i],
  ['targeted risk and integration checks', /targeted checks.*?specific risk.*?cross-task/i],
  ['new evidence remains relevant', /don't ignore new evidence/i],
  ['direct narrow correction', /fix narrow findings yourself; delegate larger remaining work/i],
  ['no false success', /Don't claim success while failures remain/i],
];
const riskGuidance = [
  ['review defaults on', /review is on by default/i],
  ['skip limited to narrow verified low risk', /review:false only for low-risk, narrow work/i],
  ['redundant nested review exception', /redundant nested reviews/i],
  ['risky work retains review', /Keep review for risky, security-sensitive or broad changes/i],
  ['uncertainty and user requirements retain review', /uncertain verification, or explicit user requirements/i],
  ['worker verification never skipped', /never skips the worker's own verification/i],
  ['skipped review is not approval', /review skipped is not a PASS or independent approval/i],
  ['integrate with limitation', /note that limitation/i],
  ['mandatory whole-item gate', /non-interactive task lists.*?whole-item review.*?mandatory/i],
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
      ['handoff before broad work', /Delegate before exploring broadly or implementing/i],
      ['familiarity is not exemption', /familiar with the code is not a reason/i],
      ['user and project delegation restrictions', /delegation rules, including limits on using workers/i],
    ]);
    assert.doesNotMatch(prompts.supervisorPrompt, /if uncertain, work locally|benefit outweighs|Don't pass on your whole assignment/i);
    for (const child of [prompts.workerPrompt, prompts.discoveryPrompt]) {
      assert.doesNotMatch(child, /By default, Main delegates|Delegate when the task|delegate the whole task/i);
    }
    check(prompts.supervisorPrompt, [['direct verification', /Verify your work, including work you did/i]]);
    check(prompts.workerPrompt, workerExecution);
    check(prompts.workerPrompt, [
      ['assigned scope and constraints', /only the assigned task.*?acceptance criteria.*?cross-task constraints/i],
      ['mandatory verification', /Verify your work/i],
      ['compact outcome report', /report.*?Outcome.*?Files changed.*?Verification actually performed.*?Assumptions and unresolved issues/i],
      ['reviewable paths and facts', /paths and facts.*?review/i],
      ['no raw dumps', /not tool logs, file dumps/i],
    ]);
  });
  test(`${workflow} reviewer: independent read-only workspace verification and strict verdict`, () => {
    check(prompts.reviewerPrompt, [
      ['independent fresh reviewer', /independent reviewer with a fresh context/i],
      ['actual workspace and worker report', /actual workspace and the worker report/i],
      ['claims are not proof', /claims as claims, not proof/i],
      ['files and checks', /relevant files and run appropriate checks/i],
      ['read-only reviewer', /Do not modify files or implement fixes/i],
      ['no claims-only approval', /Never approve.*?worker says/i],
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
      ['unsandboxed side effects forbidden', /not sandboxed.*?avoid.*?(?:mutat|side effects).*?installs/i],
      ['shell and inherited tools covered', /shell and inherited custom tools/i],
      ['no duplicate child exploration', /child findings without repeating their exploration/i],
      ['verify evidence within discovery', /Verify.*?within discovery itself/i],
      ['child claims are not proof', /child claims as claims, not proof/i],
      ['targeted evidence checks', /targeted checks for contradictions or unsupported claims, not wholesale re-exploration/i],
      ['evidence coverage and inference checks', /scope, evidence accuracy, coverage, inferences/i],
      ['source references', /files\/symbols\/line references or source URLs and passages/i],
      ['behavior and constraints', /observed behavior and constraints/i],
      ['actual checks and explicit gaps', /checks you actually performed, and explicit unknowns\/gaps/i],
      ['facts distinct from inference', /Distinguish verified facts from inference/i],
      ['coverage and limitations', /state coverage and limitations/i],
      ['no separate verdict review', /No separate reviewer or PASS\/FAIL verdict is needed/i],
      ['no report artifacts or raw logs', /Do not create report artifacts or return raw logs/i],
    ]);
  });
}

test('user requirements override extension guidance in every role and tool description', () => {
  for (const name of ['supervisorPrompt', 'workerPrompt', 'reviewerPrompt', 'discoveryPrompt', 'delegationDescription']) {
    check(shared[name], [
      ['explicit precedence on conflict', /user's requirements come first.*?the user wins/i],
      ['covers more than delegation opt-outs', /workflow, scope, methods and output format/i],
      ['propagates requirements to fresh contexts', /Pass the relevant requirements to every child task/i],
      ['project instructions and propagation', /project instructions.*?AGENTS\.md.*?pass those on/i],
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
      ['minimal acceptance context', /outcomes, acceptance criteria, paths.*?verified reports, not transcripts/i],
      ['read-only optional discovery', /mode discover is read-only.*?no separate reviewer.*?not a prerequisite.*?avoid mutations and side effects/i],
      ['evidence and gaps', /return verified sources and gaps/i],
      ['verification without duplication', /Verify work.*?PASS, integrate without repeating/i],
      ['user and project delegation restrictions', /Follow user and project delegation limits/i],
      ['handoff before broad exploration', /after a short orientation, before exploring broadly/i],
      ['children may delegate when needed', /Workers, reviewers and discoverers may delegate.*?mode discover only/i],
      ['no forwarding', /unchanged assignments or invent splits/i],
      ['direct narrow fixes', /Fix narrow review failures yourself/i],
    ]);
    assert.ok(tool.description.split(/\s+/).length < 320, 'always-present description stays compact');
  });
}
