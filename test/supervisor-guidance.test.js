import test from 'node:test';
import assert from 'node:assert/strict';
import * as interactive from '../src/interactive-workflow.js';
import * as standalone from '../src/workflow.js';

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
        ['at least two useful, strictly smaller execution subtasks', /at least two (?:concrete, useful subtasks, each strictly smaller in scope|useful subtasks strictly smaller)/i],
        ['identify the split before delegating', /(?:Identify that split (?:before calling delegate_task|first)|identify at least two useful subtasks strictly smaller than the assignment, then)/i],
        ['execute unsplittable work directly', /(?:If no useful split exists, execute (?:the task )?directly|Otherwise this is a leaf task: execute it directly)/i],
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
