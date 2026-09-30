import assert from 'node:assert/strict';
import test from 'node:test';
import { DelegationView } from '../src/delegation-view.js';
import { createDelegationWidgets } from '../src/delegation-renderer.js';

// Main is a routing node, not a worker: it has neither text nor a message.
// Both completion and cancellation must be able to render it.
for (const cancel of [false, true]) {
  test(`renders Main after child ${cancel ? 'cancellation' : 'completion'}`, async () => {
    class Text {
      constructor(text = '') { this.text = text; }
      render() { return this.text.split('\n'); }
      invalidate() {}
    }
    const theme = { fg: (_color, text) => text, style: (text) => text };
    const frames = [];
    const view = new DelegationView((node) => {
      if (!node) return;
      const widgets = createDelegationWidgets(node, {
        Text, AssistantMessageComponent: Text, ToolExecutionComponent: Text,
      });
      frames.push(widgets.content({}, theme).render(80));
      widgets.indicator({}, theme).render(80);
    });
    const parent = { role: 'main', session: { steer() {} } };
    const scope = view.open(parent);
    const node = view.enter(scope, {}, 'worker', 'Test');
    if (cancel) {
      assert.equal(view.cancel(), true);
      await view.input('Do something else');
    }
    view.leave(node);
    await view.finish(scope);
    assert.ok(frames.some((lines) => lines[0] === 'Main'));
    assert.equal(view.focus, undefined);
    assert.equal(view.scopes.size, 0);
  });
}
