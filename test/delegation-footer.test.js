import assert from 'node:assert/strict';
import test from 'node:test';
import { DelegationFooter } from '../src/delegation-footer.js';

function harness() {
  const calls = [];
  const data = {};
  class Footer {
    constructor(session, footerData) { this.session = session; assert.equal(footerData, data); }
    setSession(session) { this.session = session; }
    setAutoCompactEnabled(enabled) { this.auto = enabled; }
  }
  let component;
  const ui = { setFooter(factory) {
    calls.push(factory ? 'install' : 'restore');
    component = factory?.({ requestRender() { calls.push('paint'); } }, {}, data);
  } };
  const footer = new DelegationFooter(Footer);
  return { footer, ui, calls, component: () => component };
}

test('native footer follows recursive focus, cancellation, review and Main', () => {
  const h = harness();
  const worker = { role: 'worker', session: { autoCompactionEnabled: false } };
  const child = { role: 'worker', session: { autoCompactionEnabled: true } };
  const review = { role: 'reviewer', session: { autoCompactionEnabled: true } };
  h.footer.focus(h.ui, worker);
  const component = h.component();
  assert.equal(component.session, worker.session);
  assert.equal(component.auto, false);
  h.footer.focus(h.ui, child);
  assert.equal(h.component(), component, 'Streaming/focus updates reuse native component');
  assert.equal(component.session, child.session);
  h.footer.focus(h.ui, worker); // Cancel or complete recursive child.
  assert.equal(component.session, worker.session);
  h.footer.focus(h.ui, review);
  assert.equal(component.session, review.session);
  h.footer.focus(h.ui, { role: 'main', session: { steer() {} }, waiting: {} });
  assert.equal(h.component(), undefined);
  h.footer.focus(h.ui, undefined);
  assert.equal(h.calls.filter((call) => call === 'restore').length, 1);
});

test('refresh waits for persisted entries and ignores unfocused/disposed sessions', async () => {
  const h = harness();
  const node = { role: 'worker', session: { autoCompactionEnabled: true } };
  h.footer.focus(h.ui, node);
  const before = h.calls.length;
  h.footer.refresh(node);
  assert.equal(h.calls.length, before);
  await Promise.resolve();
  assert.equal(h.calls.length, before + 1);
  h.footer.refresh({ session: {} });
  h.footer.refresh(node);
  h.footer.restore();
  const after = h.calls.length;
  await Promise.resolve();
  assert.equal(h.calls.length, after);
});

test('restores after installation failure and when changing UI contexts', () => {
  const h = harness();
  const node = { role: 'worker', session: {} };
  const broken = { setFooter(factory) {
    if (factory) throw new Error('broken');
    h.calls.push('failure restored');
  } };
  assert.throws(() => h.footer.focus(broken, node), /broken/);
  h.footer.restore();
  assert.ok(h.calls.includes('failure restored'));
  h.footer.focus(h.ui, node);
  h.footer.focus(broken, undefined);
  assert.equal(h.component(), undefined);
});
