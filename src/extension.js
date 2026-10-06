import { createCurrentTaskOutput } from './current-task-output.js';
import { runDelegateList } from './delegate-list.js';
import { createStandaloneExecutor } from './standalone-runner.js';
import { matchesKey, parseKey } from '@earendil-works/pi-tui';

/** Injectable boundaries keep startup/cancellation tests independent of models. */
export function registerCli(pi, {
  runList = runDelegateList, createExecutor = createStandaloneExecutor,
  host = process, write = (text) => process.stderr.write(`${text}\n`),
} = {}) {
  pi.registerFlag('delegate-list', { type: 'string', description: 'Execute unchecked Markdown tasks with fresh workers and reviewers.' });
  let started = false;
  let controller;
  pi.on('session_shutdown', () => controller?.abort(new Error('Pi session shut down.')));
  pi.on('session_start', async (event, ctx) => {
    if (event.reason !== 'startup' || started) return;
    const path = pi.getFlag('delegate-list');
    if (path === undefined) return;
    started = true;
    controller = new AbortController();
    const cancel = () => controller.abort(new Error('Cancelled by user.'));
    let removeInput;
    const onOutput = ctx.mode === 'tui' && ctx.hasUI
      ? createCurrentTaskOutput(ctx.ui, ctx.cwd) : undefined;
    const report = (text, error = false, progress = false) => {
      try {
        if (ctx.mode === 'tui' && ctx.hasUI) {
          if (error) ctx.ui.notify(text, 'error');
          return;
        }
      } catch { /* Display failures must not interrupt execution. */ }
      write(text);
    };
    const setTaskStatus = (text) => {
      try {
        if (ctx.mode === 'tui' && ctx.hasUI) ctx.ui.setStatus('delegate-list', text);
      } catch { /* Display failures must not interrupt execution. */ }
    };
    let taskNumber = 0;
    let result;
    try {
      host.on('SIGINT', cancel);
      if (ctx.mode === 'tui' && ctx.hasUI) {
        removeInput = ctx.ui.onTerminalInput((data) => {
          if (matchesKey(data, 'ctrl+c') || parseKey(data) === 'ctrl+escape') {
            cancel();
            return { consume: true };
          }
        });
      }
      report(`delegate-list: ${path}`);
      const { execute } = createExecutor({ cwd: ctx.cwd, model: ctx.model,
        thinkingLevel: ctx.thinkingLevel, signal: controller.signal,
        onOutput });
      result = await runList(path, { cwd: ctx.cwd, signal: controller.signal,
        execute: (params, signal) => {
          setTaskStatus(`delegate-list: running task #${++taskNumber}`);
          return execute(params, signal);
        } });
    } catch (error) {
      result = { isError: true, content: [{ type: 'text', text: `delegate-list failed: ${error?.message ?? error}` }] };
    } finally {
      host.off('SIGINT', cancel);
      removeInput?.();
      setTaskStatus(undefined);
    }
    if (result.isError) host.exitCode = controller.signal.aborted ? 130 : 1;
    report(result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n'), result.isError);
    controller = undefined;
    // Print/JSON naturally exit after this awaited startup handler. Their
    // shutdown hook is a no-op in Pi 0.99.2; RPC has an orderly shutdown hook.
    if (ctx.mode === 'rpc') ctx.shutdown();
  });
}

export default function (pi) { registerCli(pi); }
