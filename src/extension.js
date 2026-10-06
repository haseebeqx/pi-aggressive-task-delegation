import registerInteractiveDelegation from './interactive-delegation.js';
import { runDelegateList } from './delegate-list.js';
import { createStandaloneExecutor } from './standalone-runner.js';
import { runNativeList } from './native-list.js';

/** Injectable boundaries keep startup/cancellation tests independent of models. */
export function registerCli(pi, {
  runList = runDelegateList, createExecutor = createStandaloneExecutor,
  host = process, write = (text) => process.stderr.write(`${text}\n`),
} = {}) {
  pi.registerFlag('delegate-list', { type: 'string', description: 'Execute unchecked Markdown tasks in fresh Pi sessions.' });
  pi.registerCommand('delegate-list-run', {
    description: 'Run the startup Markdown list in native Pi sessions.',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui' || !ctx.hasUI) return;
      const path = pi.getFlag('delegate-list');
      if (path !== undefined) {
        // Let startup binding finish before replacing its session runtime.
        await new Promise(resolve => setImmediate(resolve));
        await runNativeList(path, ctx, { runList, host });
      }
    },
  });
  let started = false;
  let controller;
  let cleanup = () => {};
  pi.on('session_shutdown', (event) => {
    // Each replacement reloads this factory. Relay shutdown to the active
    // native runner without retaining an outgoing extension API/context.
    host.emit('delegate-list-session-shutdown', event);
    controller?.abort(new Error('Pi session shut down.'));
    cleanup();
  });
  pi.on('session_start', async (event, ctx) => {
    if (event.reason !== 'startup' || started) return;
    const path = pi.getFlag('delegate-list');
    if (path === undefined) return;
    started = true;
    const interactive = ctx.mode === 'tui' && ctx.hasUI;
    if (interactive) {
      // Lifecycle contexts cannot replace sessions. Dispatch a command through
      // the supported prompt flow and return before it starts switching.
      pi.sendUserMessage('/delegate-list-run', { expandPromptTemplates: true });
      return;
    }
    controller = new AbortController();
    const activeController = controller;
    const cancel = () => activeController.abort(new Error('Cancelled by user.'));
    const report = write;
    let cleaned = false;
    cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      host.off('SIGINT', cancel);
    };
    let result;
    try {
      host.on('SIGINT', cancel);
      report(`delegate-list: ${path}`);
      const renderOutput = ({ reset, task, role, event }) => {
        if (reset) write(`delegate-list task: ${task}`);
        else if (event.type === 'tool_execution_start') write(`${role}: running ${event.toolName}`);
        else if (event.type === 'tool_execution_end') write(`${role}: ${event.toolName} ${event.isError ? 'failed' : 'finished'}`);
        else if (event.type === 'message_end' && event.message?.role === 'assistant') {
          const text = event.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
          if (text) write(`${role}: ${text}`);
        }
      };
      const onOutput = (output) => {
        if (!cleaned) renderOutput(output);
      };
      const { execute } = createExecutor({ cwd: ctx.cwd, model: ctx.model,
        thinkingLevel: ctx.thinkingLevel, signal: activeController.signal, onOutput });
      result = await runList(path, { cwd: ctx.cwd, signal: activeController.signal,
        execute: (params, signal) => {
          return execute(params, signal);
        } });
    } catch (error) {
      result = { isError: true, content: [{ type: 'text', text: `delegate-list failed: ${error?.message ?? error}` }] };
    } finally {
      cleanup();
      cleanup = () => {};
    }
    if (result.isError) host.exitCode = activeController.signal.aborted ? 130 : 1;
    report(result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n'), result.isError);
    controller = undefined;
    // Print/JSON naturally exit after this awaited startup handler. Their
    // shutdown hook is a no-op in Pi 0.99.2; RPC has an orderly shutdown hook.
    if (ctx.mode === 'rpc') ctx.shutdown();
  });
}

export default function (pi) {
  registerInteractiveDelegation(pi);
  registerCli(pi);
}
