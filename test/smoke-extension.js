// Real Pi loader/lifecycle, with offline model-independent adapter boundaries.
import assert from 'node:assert/strict';
import { registerCli } from '../src/extension.js';
export default function (pi) {
  let calls = 0;
  registerCli(pi, {
    createExecutor: (options) => {
      assert.ok(options.cwd);
      assert.ok(options.signal);
      return { execute: async () => { throw new Error('Empty fixture must not execute'); } };
    },
    runList: async (path, options) => {
      assert.equal(path, 'smoke.md');
      assert.equal(typeof options.execute, 'function');
      assert.equal(++calls, 1);
      return { isError: false, content: [{ type: 'text', text: 'CLI adapter SDK smoke passed.' }] };
    },
  });
}
