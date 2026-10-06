import assert from 'node:assert/strict';
import test from 'node:test';
import { DelegationView } from '../src/delegation-view.js';

function setup() {
  const frames = [];
  const inputs = [];
  const view = new DelegationView((node) => frames.push(node));
  const session = (name) => ({ steer: async (text, images) => inputs.push({ name, text, images }) });
  const root = { role: 'main', session: session('main') };
  const aScope = view.open(root);
  const a = view.enter(aScope, session('a'), 'worker', 'A');
  const bScope = view.open(a);
  const b = view.enter(bScope, session('b'), 'worker', 'B');
  return { view, root, aScope, a, bScope, b, frames, inputs, session };
}

test('input targets the visible child, including images', async () => {
  const { view, inputs } = setup();
  const images = [{ type: 'image', data: 'example' }];
  assert.equal(await view.input('change approach', images), true);
  assert.deepEqual(inputs, [{ name: 'b', text: 'change approach', images }]);
});

test('cancellation focuses immediate parent and waits for its input', async () => {
  const { view, a, b, bScope, inputs } = setup();
  assert.equal(view.cancel(), true);
  assert.equal(bScope.controller.signal.aborted, true);
  assert.equal(view.focus, a);
  assert.equal(a.waiting, bScope);
  view.leave(b); // Child unwinding must not steal focus.
  let finished = false;
  const finish = view.finish(bScope).then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  await view.input('use another approach');
  await finish;
  assert.equal(view.focus, a);
  assert.equal(a.waiting, undefined);
  assert.equal(inputs[0].name, 'a');
});

test('input arriving before child cleanup still releases the wait', async () => {
  const { view, bScope } = setup();
  view.cancel();
  await view.input('continue differently');
  await view.finish(bScope);
  assert.equal(view.scopes.has(bScope), false);
});

test('cancelling waiting parent cancels descendants and returns to main', async () => {
  const { view, root, aScope, bScope, inputs } = setup();
  view.cancel();
  const childFinish = view.finish(bScope);
  view.cancel();
  await childFinish;
  assert.equal(aScope.controller.signal.aborted, true);
  assert.equal(view.focus, root);
  let done = false;
  const parentFinish = view.finish(aScope).then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  await view.input('stop this approach');
  await parentFinish;
  assert.equal(inputs[0].name, 'main');
  assert.equal(view.focus, undefined);
});

test('normal completion returns focus; shutdown and external abort release waits', async () => {
  const { view, a, b, bScope } = setup();
  view.leave(b);
  await view.finish(bScope);
  assert.equal(view.focus, a);
  const controller = new AbortController();
  const scope = view.open(a, controller.signal);
  view.enter(scope, { steer() {} }, 'reviewer', 'review');
  view.cancel();
  const finish = view.finish(scope);
  controller.abort();
  await finish;
  view.shutdown();
  assert.equal(view.focus, undefined);
  assert.equal(await view.input('normal main input'), false);
});

test('procedural parent cancellation finishes without replacement input', async () => {
  const view = new DelegationView();
  const parent = { role: 'main', procedural: true, session: { steer() {} } };
  const scope = view.open(parent);
  view.enter(scope, { steer() {} }, 'worker', 'item');
  assert.equal(view.cancel(), true);
  await view.finish(scope);
  assert.equal(scope.controller.signal.aborted, true);
  assert.equal(view.focus, undefined);
  assert.equal(parent.waiting, undefined);
});
