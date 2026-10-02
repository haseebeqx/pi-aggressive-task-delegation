import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDelegator, emptyUsage, rolePrompts, supervisorPrompt } from '../src/workflow.js';

const report = (text) => ({ report: text, usage: { ...emptyUsage(), input: 1 } });

test('worker then independent reviewer; only reports and aggregate usage return', async () => {
  const calls = [];
  const delegate = createDelegator(async (role, prompt, signal, ctx) => {
    calls.push({ role, prompt, ctx });
    return report(role === 'worker' ? 'Changed src/a.js; tests passed.' : 'PASS\nChecked src/a.js.');
  });
  const ctx = { cwd: '/workspace' };
  const result = await delegate({ task: 'Fix bug', context: 'src/a.js', ctx });
  assert.deepEqual(calls.map((c) => c.role), ['worker', 'reviewer']);
  assert.equal(calls[0].ctx, ctx);
  assert.match(calls[1].prompt, /Changed src\/a.js/);
  assert.equal(result.isError, false);
  assert.equal(result.usage.input, 2);
  assert.deepEqual(result.details, { approved: true });
  assert.equal(JSON.stringify(result).includes('messages'), false);
});

test('concurrent sibling requests execute completely in sequence', async () => {
  const calls = [];
  let active = 0;
  const delegate = createDelegator(async (role, prompt) => {
    active++;
    assert.equal(active, 1);
    calls.push(`${role}:${prompt.includes('First') ? 'first' : 'second'}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return report(role === 'worker' ? 'Done.' : 'PASS');
  });
  await Promise.all([delegate({ task: 'First' }), delegate({ task: 'Second' })]);
  assert.deepEqual(calls, ['worker:first', 'reviewer:first', 'worker:second', 'reviewer:second']);
});

test('recursive delegation uses a separate child queue', async () => {
  const child = createDelegator(async (role) => report(role === 'worker' ? 'Leaf done.' : 'PASS'));
  const parent = createDelegator(async (role) => {
    if (role === 'worker') {
      const leaf = await child({ task: 'Leaf task' });
      return { report: 'Integrated leaf.', usage: leaf.usage };
    }
    return report('PASS');
  });
  const result = await parent({ task: 'Parent task' });
  assert.equal(result.isError, false);
  assert.equal(result.usage.input, 3);
});

test('failed or malformed review is not approval', async () => {
  for (const verdict of ['FAIL\nMissing test.', 'Looks good.', 'PASSING']) {
    const delegate = createDelegator(async (role) => report(role === 'worker' ? 'Done.' : verdict));
    const result = await delegate({ task: 'Task' });
    assert.equal(result.isError, true);
    assert.equal(result.details.approved, false);
  }
});

test('review exception preserves worker report and usage; queue recovers', async () => {
  let fail = true;
  const delegate = createDelegator(async (role) => {
    if (role === 'reviewer' && fail) {
      fail = false;
      throw Object.assign(new Error('Provider failed'), { usage: report('').usage });
    }
    return report(role === 'worker' ? 'Work exists on disk.' : 'PASS');
  });
  const result = await delegate({ task: 'Task' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Work exists on disk/);
  assert.equal(result.usage.input, 2);
  assert.equal((await delegate({ task: 'Next' })).isError, false);
});

test('cancellation stops before review and prevents queued work from starting', async () => {
  const controller = new AbortController();
  const calls = [];
  const delegate = createDelegator(async (role) => {
    calls.push(role);
    controller.abort();
    return report('Partial work.');
  });
  const result = await delegate({ task: 'Task' }, controller.signal);
  assert.equal(result.isError, true);
  await assert.rejects(delegate({ task: 'Next' }, controller.signal), /abort/i);
  assert.deepEqual(calls, ['worker']);
});

test('discovery returns verified findings directly without a reviewer', async () => {
  const calls = [];
  const phases = [];
  const delegate = createDelegator(async (role, prompt) => {
    calls.push({ role, prompt });
    return { ...report(role === 'discoverer' ? 'src/a.js:4 establishes X; Y unknown.' : 'PASS\nEvidence checked.'),
      logPath: `/logs/${role}.jsonl` };
  });
  const result = await delegate({ task: 'Explore X', mode: 'discover' }, undefined, (phase) => phases.push(phase));
  assert.deepEqual(calls.map((c) => c.role), ['discoverer']);
  assert.deepEqual(phases, ['Discovering']);
  assert.equal(result.isError, false);
  assert.equal(result.usage.input, 1);
  assert.equal(result.details.approved, true);
  assert.deepEqual(result.details.logs, { discoverer: '/logs/discoverer.jsonl' });
  assert.doesNotMatch(result.content[0].text, /Review:/);
  assert.match(result.content[0].text, /^Discovery findings:/);
});

test('discovery does not parse findings as an approval verdict', async () => {
  for (const findings of ['src/a.js:4 supports X; Y unknown.', 'FAIL\nUnsupported claim found.', 'PASSING']) {
    const delegate = createDelegator(async () => report(findings));
    const result = await delegate({ task: 'Gather scoped evidence', mode: 'discover' });
    assert.equal(result.details.approved, true);
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /Discovery findings:/);
  }
});

test('discovery errors preserve usage and logs; queue recovers', async () => {
  let fail = true;
  const delegate = createDelegator(async (role) => {
    assert.equal(role, 'discoverer');
    if (fail) {
      fail = false;
      throw Object.assign(new Error('Evidence unavailable'), {
        usage: report('').usage, logPath: '/logs/discoverer.jsonl',
      });
    }
    return report('Evidence checked; gaps disclosed.');
  });
  const result = await delegate({ task: 'Gather facts', mode: 'discover' });
  assert.equal(result.isError, true);
  assert.equal(result.details.approved, false);
  assert.equal(result.usage.input, 1);
  assert.deepEqual(result.details.logs, { discoverer: '/logs/discoverer.jsonl' });
  assert.equal((await delegate({ task: 'Retry', mode: 'discover' })).isError, false);
});

test('discovery cancellation preserves completed findings without review', async () => {
  const controller = new AbortController();
  const roles = [];
  const delegate = createDelegator(async (role) => {
    roles.push(role);
    controller.abort();
    return { ...report('Partial evidence.'), logPath: '/logs/discoverer.jsonl' };
  });
  const result = await delegate({ task: 'Gather facts', mode: 'discover' }, controller.signal);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Partial evidence/);
  assert.equal(result.usage.input, 1);
  assert.deepEqual(result.details.logs, { discoverer: '/logs/discoverer.jsonl' });
  assert.deepEqual(roles, ['discoverer']);
});

test('invalid modes launch no agent; queue recovers', async () => {
  let calls = 0;
  const delegate = createDelegator(async () => { calls++; return report('PASS'); });
  for (const mode of ['plan', '', null, 42]) {
    await assert.rejects(delegate({ task: 'Task', mode }), /mode must/);
  }
  assert.equal(calls, 0);
  await delegate({ task: 'Task', mode: 'execute' });
  assert.equal(calls, 2);
});

test('discovery recursion defaults to discovery and cannot switch to execution', async () => {
  const roles = [];
  const child = createDelegator(async (role) => { roles.push(role); return report('PASS'); }, { discoveryOnly: true });
  await assert.rejects(child({ task: 'Implement', mode: 'execute' }), /cannot delegate execution/);
  assert.deepEqual(roles, []);
  await child({ task: 'Find evidence' });
  assert.deepEqual(roles, ['discoverer']);
});

test('discovery prompts gather facts without execution decomposition or plan instructions', () => {
  for (const role of ['discoverer']) {
    const prompt = rolePrompts[role];
    assert.match(prompt, /Main retains all decisions/);
    assert.match(prompt, /Do not implement, modify files, write artifacts, propose/);
    assert.match(prompt, /unknowns\/gaps/);
    assert.doesNotMatch(prompt, /Identify that split first|Complete only the|run appropriate\nchecks/);
  }
  assert.equal(rolePrompts['discovery-reviewer'], undefined);
  assert.match(normalized(supervisorPrompt), /discovery needs no predefined split/);
});

test('empty tasks are rejected without launching agents', async () => {
  const delegate = createDelegator(() => assert.fail('Must not run'));
  await assert.rejects(delegate({ task: '  ' }), /non-empty/);
});

const normalized = (prompt) => prompt.replace(/\s+/g, ' ');

test('supervisor and execution worker can skip discovery for small or well-understood tasks', () => {
  for (const prompt of [supervisorPrompt, rolePrompts.worker].map(normalized)) {
    assert.match(prompt, /Discovery is optional, not a required phase before execution/);
    assert.match(prompt, /For small or well-understood tasks, use bounded local reads as needed and proceed directly without a discovery delegation/);
    assert.doesNotMatch(prompt, /gather scoped codebase or external facts before deciding how to proceed/);
  }
});

test('supervisor and execution worker offload substantial discovery without execution split prerequisites', () => {
  for (const prompt of [supervisorPrompt, rolePrompts.worker].map(normalized)) {
    assert.match(prompt, /Offload substantial fact gathering with mode discover rather than broad local exploration/);
    assert.match(prompt, /only lightweight orientation locally/);
    assert.match(prompt, /narrower factual scopes sequentially/);
    assert.match(prompt, /broad, multi-area, or large-output exploration/);
    assert.match(prompt, /discovery needs no predefined split or prerequisite plan/);
    assert.match(prompt, /split rules apply only to execute mode, never to gathering facts in discover mode/);
    assert.match(prompt, /at least two concrete, useful subtasks, each strictly smaller in scope/);
    assert.match(prompt, /focused follow-up discovery for missing details rather than loading transcripts by default/);
  }
  assert.match(normalized(rolePrompts.worker), /For execution only, delegate only if/);
  assert.match(normalized(rolePrompts.worker), /Otherwise this is a leaf task: execute it directly/);
});

test('discovery roles aggressively narrow broad exploration and stop at bounded factual leaves', () => {
  for (const role of ['discoverer']) {
    const prompt = normalized(rolePrompts[role]);
    assert.match(prompt, /Do only lightweight orientation locally/);
    assert.match(prompt, /Aggressively delegate broad, multi-area, or large-output/);
    assert.match(prompt, /into narrower factual scopes sequentially with mode discover only/);
    assert.match(prompt, /Each recursive delegation must strictly narrow the assigned scope/);
    assert.match(prompt, /Never forward the whole assignment unchanged or merely reworded/);
    assert.match(prompt, /split artificially just to delegate/);
    assert.match(prompt, /No predefined split is required/);
    assert.match(prompt, /focused leaf.*bounded searches and targeted reads directly; do not delegate further/);
    assert.doesNotMatch(prompt, /If useful, delegate|at least two concrete|Identify that split first/);
  }
  assert.match(normalized(rolePrompts.discoverer), /Integrate child findings without repeating their exploration/);
});

test('discovery reports preserve evidence and gaps with a soft target and focused follow-ups', () => {
  for (const role of ['discoverer']) {
    const prompt = normalized(rolePrompts[role]);
    assert.match(prompt, /decision-relevant, evidence-linked/);
    assert.match(prompt, /explicit.*gaps/);
    assert.match(prompt, /about 300 words as a soft target/);
    assert.match(prompt, /preserving important scoped evidence and gaps rather than forcing a fixed word limit/);
    assert.match(prompt, /focused follow-up discovery for missing details rather than loading transcripts by default/);
    assert.match(prompt, /inspect only relevant transcript portions when necessary to resolve a specific evidence issue/);
    assert.match(prompt, /Do not.*return raw logs, file dumps, or transcripts/);
    assert.match(prompt, /Use tools only for read-only exploration/);
  }
  assert.match(normalized(rolePrompts.discoverer), /Distinguish verified facts from inference; state coverage and limitations/);
});

test('discovery verifies evidence itself without duplicating every child scope', () => {
  const prompt = normalized(rolePrompts.discoverer);
  assert.match(prompt, /Treat child findings as claims, not proof/);
  assert.match(prompt, /exploration and evidence verification into narrower factual scopes/);
  assert.match(prompt, /Verify decision-relevant claims against relevant codebase or external evidence within discovery itself/);
  assert.match(prompt, /without re-exploring every child scope/);
  assert.match(prompt, /targeted checks for contradictions and unsupported claims/);
  assert.match(prompt, /Report checks actually performed; no separate reviewer or PASS\/FAIL verdict is required/);
});

test('delegate tool description advertises context-preserving discovery contracts', () => {
  // Inspect text without importing the extension's optional Pi peer dependencies.
  const source = readFileSync(new URL('../src/extension.js', import.meta.url), 'utf8');
  const description = source.match(/description: '(Execute a small task[^']*)'/)?.[1];
  assert.ok(description, 'delegate_task description exists');
  assert.match(description, /offload substantial fact gathering with mode discover/);
  assert.match(description, /Discovery is optional: for small or well-understood tasks, use bounded local reads as needed and proceed directly without discovery delegation/);
  assert.match(description, /For substantial exploration, keep local discovery to lightweight orientation/);
  assert.match(description, /Execution receives independent review; discovery verifies its own evidence without a separate review stage/);
  assert.match(description, /lightweight orientation; aggressively delegate broad, multi-area, or large-output exploration and evidence verification into strictly narrower factual scopes/);
  assert.match(description, /Never forward the whole assignment or split artificially/);
  assert.match(description, /focused leaves use bounded searches and targeted reads directly/);
  assert.match(description, /read-only.*compact decision-relevant evidence and explicit gaps.*soft target about 300 words/);
  assert.match(description, /not a plan or raw logs; Main retains all decisions and no predefined split is required/);
  assert.match(description, /Execution split rules apply only to execute mode/);
  assert.match(description, /Calls run sequentially/);
  assert.match(description, /focused follow-up discovery for missing details rather than loading transcripts by default/);
});
