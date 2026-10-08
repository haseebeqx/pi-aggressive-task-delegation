import test from 'node:test';
import assert from 'node:assert/strict';
import * as interactive from '../src/interactive-workflow.js';
import * as standalone from '../src/workflow.js';
import extension from '../src/extension.js';
import { registerDelegateTasks } from '../src/delegate-tasks.js';

// Normalize wrapping, but check individual responsibilities and safeguards rather
// than snapshotting the prompts (the two workflows intentionally differ in detail).
const normalize = (prompt) => prompt.replace(/\s+/g, ' ').trim();
const check = (prompt, concepts) => {
  for (const [concept, pattern] of concepts) assert.match(prompt, pattern, concept);
};

for (const [workflow, prompts] of Object.entries({ interactive, standalone })) {
  for (const [role, rawPrompt] of Object.entries({
    supervisor: prompts.supervisorPrompt,
    worker: prompts.workerPrompt,
  })) {
    const prompt = normalize(rawPrompt);
    test(`${workflow} ${role}: outcome-oriented ownership, not prescribed implementation`, () => {
      if (role === 'supervisor') {
        check(prompt, [
          ['Main owns the high-level coordination', /Main owns goals, cross-task constraints, task breakdown, and integration/i],
          ['workers own scoped implementation', /workers own implementation choices within their assigned scope/i],
        ]);
      } else {
        check(prompt, [
          ['worker owns implementation under assigned constraints', /Own implementation choices within your scope while respecting the assigned goals, acceptance criteria, and cross-task constraints/i],
          ['recursive worker owns breakdown and integration', /When supervising smaller tasks, own their breakdown and integration/i],
          ['worker verifies its own work', /Verify your work/i],
        ]);
      }
      check(prompt, [
        ['assign outcomes and acceptance criteria', /(?:Delegate|give workers) outcomes and acceptance criteria/i],
        ['avoid prescribing steps except for concrete constraints or risks', /(?:not step-by-step instructions|rather than prescribed steps),? unless required by a concrete constraint or risk/i],
      ]);
    });

    test(`${workflow} ${role}: PASS integrates without routine duplicate work, not blind trust`, () => {
      check(prompt, [
        ['PASS leads to integration, not repeated leaf work', /After PASS, integrate (?:the result|child results) without routinely repeating exploration, review, or leaf edits/i],
        ['targeted risk and integration checks remain allowed', /Use targeted checks only for specific risks, contradictions, gaps, or cross-task integration/i],
        ['new evidence still matters after PASS', /do not (?:treat PASS as a reason to )?ignore new evidence/i],
        ['execution still receives independent review', /Execution (?:receives independent review|runs a fresh worker followed by a fresh independent reviewer)/i],
        ['failed review requires a focused correction with findings', /(?:If review fails|On review failure), delegate a focused correction with the findings before proceeding/i],
        ['unresolved failures cannot be called success', /Do not claim success with unresolved failures/i],
      ]);
    });

    test(`${workflow} ${role}: Main can delegate one task while workers retain split rules`, () => {
      if (role === 'supervisor') {
        assert.match(prompt, /Main may delegate a single task with delegate_task/i);
        assert.doesNotMatch(prompt, /at least two|If no useful split exists, execute|Never (?:delegate|forward) the whole task unchanged/i);
        return;
      }
      assert.doesNotMatch(prompt, /Main may delegate a single task/i);
      check(prompt, [
        ['at least two useful, strictly smaller execution subtasks', /MUST delegate whenever at least two concrete, useful subtasks exist, each strictly smaller in scope than your assignment/i],
        ['identify the split before delegating', /(?:Identify that split (?:before calling delegate_task|first)|identify at least two useful subtasks strictly smaller than the assignment, then)/i],
        ['execute unsplittable work directly', /Otherwise this is a genuine leaf: execute it directly/i],
        ['do not forward the whole task or manufacture splits', /Never (?:delegate (?:the whole task|your whole assignment)|forward the whole task) unchanged.{0,100}split (?:it )?artificially/i],
      ]);
    });
  }

  test(`${workflow} reviewer: PASS still requires independent workspace verification`, () => {
    check(normalize(prompts.reviewerPrompt), [
      ['review the workspace, not just the report', /Review the assigned task against the actual workspace/i],
      ['reports are claims, not proof', /Treat the report as claims, not proof/i],
      ['reviewer checks without implementing fixes', /Inspect relevant files and run appropriate checks\. Do not modify files or implement fixes/i],
      ['PASS or FAIL verdict remains explicit', /exactly PASS or FAIL on its own line/i],
    ]);
  });
}

for (const [workflow, prompts] of Object.entries({ interactive, standalone })) {
  test(`${workflow}: Main delegates even small self-contained execution by default`, () => {
    check(normalize(prompts.supervisorPrompt), [
      ['default delegation includes small tasks', /Main must delegate substantive execution by default, including small, self-contained tasks/i],
      ['Main is exempt from worker split threshold', /worker split threshold does not apply to Main/i],
      ['sequential calls only', /Call delegate_task once at a time/i],
      ['no artificial splits', /Do not split artificially/i],
    ]);
  });

  test(`${workflow}: worker split obligation cannot be waived for convenience`, () => {
    check(normalize(prompts.workerPrompt), [
      ['mandatory useful split', /MUST delegate whenever at least two concrete, useful subtasks exist, each strictly smaller in scope than your assignment/i],
      ['no size/ease/speed exception', /Task size, ease, or speed are not opt-outs/i],
      ['sequential smaller tasks', /use delegate_task sequentially for the smaller pieces/i],
      ['genuine leaves work even when difficult', /genuine leaf: execute it directly, even if difficult or time-consuming/i],
      ['recursion terminates at leaves', /when further useful division is impossible, stop delegating execution/i],
      ['execution threshold is not discovery threshold', /two-subtask threshold applies only to execution, not discovery/i],
    ]);
  });

  for (const role of ['supervisor', 'worker']) {
    test(`${workflow} ${role}: lower discovery threshold preserves focused lookup exceptions`, () => {
      const prompt = normalize(prompts[`${role}Prompt`]);
      check(prompt, [
        ['no mandatory discovery phase', /Discovery is optional, not a required phase before execution/i],
        ['local orientation only', /do only lightweight orientation locally/i],
        ['separable factual questions even for small tasks', /delegate separable factual questions sequentially with mode discover, even for small tasks/i],
        ['direct bounded factual leaf lookup', /Direct bounded lookups are allowed for focused factual leaves with no useful narrower scope/i],
        ['already-known tasks do not need discovery', /already-known tasks need no discovery/i],
        ['no prerequisite split', /Discovery needs no predefined split or prerequisite plan/i],
      ]);
      assert.doesNotMatch(prompt, /For small or well-understood tasks, use bounded local reads|Offload substantial fact gathering/i);
    });
  }

  test(`${workflow} discovery: narrower factual scopes require sequential recursion; leaves stop`, () => {
    check(normalize(prompts.discoveryPrompt), [
      ['mandatory narrower recursion even for small tasks', /MUST recurse whenever useful, strictly narrower factual scopes exist, even for small tasks/i],
      ['sequential discovery only', /sequentially with mode discover only/i],
      ['no convenience exception', /Size, ease, or speed are not opt-outs/i],
      ['no two-subtask threshold', /discovery has no two-subtask threshold/i],
      ['execution forbidden', /never (?:switch to|delegate) execution/i],
      ['each recursive step strictly narrows scope', /Each recursive delegation must strictly narrow the assigned scope/i],
      ['no assignment forwarding or artificial split', /Never forward the whole assignment unchanged or merely reworded, or split artificially just to delegate/i],
      ['focused leaves stop and use bounded lookups', /(?:focused leaf with no useful narrower factual scope|focused leaves with no useful narrower factual scope), use bounded searches and targeted reads directly; do not delegate further/i],
      ['evidence integration without duplicate exploration', /Integrate child findings without repeating their exploration/i],
    ]);
  });
}

// Capture the registered tool rather than inspecting source so these cover the
// descriptions actually presented to the model on both entry paths.
for (const [workflow, register] of Object.entries({ interactive: extension, standalone: registerDelegateTasks })) {
  test(`${workflow} tool description: stronger policy and recursion guardrails`, () => {
    let tool;
    register({
      registerTool: (value) => { tool = value; },
      registerCommand() {}, registerFlag() {}, registerShortcut() {},
      registerEntryRenderer() {}, on() {},
    });
    const description = normalize(tool.description);
    check(description, [
      ['Main default delegation including small tasks', /delegate substantive execution by default, including small self-contained tasks/i],
      ['single Main execution assignment permitted', /Main (?:must .*?and )?may delegate a single (?:execution )?task/i],
      ['worker must split when useful', /workers MUST delegate whenever at least two concrete, useful, strictly smaller execution subtasks exist/i],
      ['no convenience opt-out', /size, ease, or speed are not opt-outs/i],
      ['genuine leaves execute', /Genuine (?:execution )?leaves (?:execute|work) directly/i],
      ['lower discovery threshold', /delegate separable factual questions even for small tasks/i],
      ['mandatory narrower discovery recursion', /Discovery agents MUST recurse whenever useful strictly narrower factual scopes exist/i],
      ['no forwarding worker assignment or artificial splits', /never forward a whole worker assignment or split artificially/i],
      ['discovery optional with direct leaf lookups', /Discovery is optional:.*?(?:focused factual leaves permit direct bounded lookups|direct focused leaf lookups)/i],
      ['discovery threshold is distinct', /no two-subtask threshold applies/i],
      ['discovery cannot execute', /(?:mode discover only|without artificial splits or execution)/i],
      ['sequential only', /Call(?:s)? (?:run )?sequentially/i],
      ['independent review preserved', /independent (?:execution )?review(?:er)?/i],
      ['focused failure correction', /(?:on (?:review )?failure|On review failure),? delegate (?:a )?focused correction before proceeding/i],
    ]);
    assert.doesNotMatch(description, /offload substantial fact gathering|for small or well-understood tasks, use bounded local reads/i);
  });
}

// Review choice is risk-based; skipping a reviewer is never a verification opt-out.
const riskGuidance = [
  ['default review', /Independent review defaults to true/i],
  ['narrow verified work can skip', /Set review:false for low-risk, narrow work with concrete worker verification/i],
  ['nested redundancy can justify skipping', /avoid redundant nested reviews/i],
  ['high risk retains review', /Retain review for risky, security-sensitive or broad changes, uncertain verification, or explicit user requirements/i],
  ['worker verification mandatory', /Skipping independent review never skips worker verification/i],
  ['skipped is not approval', /review-skipped completion is not PASS or independent approval/i],
  ['integrate with limitation', /integrate its worker report with that limitation/i],
  ['whole-item gate remains mandatory', /Non-interactive task-list whole-item review is mandatory/i],
];
for (const [workflow, prompts] of Object.entries({ interactive, standalone })) {
  for (const role of ['supervisor', 'worker']) {
    test(`${workflow} ${role}: risk-based optional review preserves verification and whole-item gate`, () => {
      check(normalize(prompts[`${role}Prompt`]), riskGuidance);
    });
  }
}
for (const [workflow, register] of Object.entries({ interactive: extension, standalone: registerDelegateTasks })) {
  test(`${workflow} tool description: risk-based review choice`, () => {
    let tool;
    register({ registerTool(value) { tool = value; }, registerCommand() {}, registerFlag() {},
      registerShortcut() {}, registerEntryRenderer() {}, on() {} });
    check(normalize(tool.description), riskGuidance);
  });
}
