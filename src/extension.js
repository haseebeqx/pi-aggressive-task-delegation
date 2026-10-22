import registerInteractiveDelegation from './interactive-delegation.js';
import { runDelegateList } from './delegate-list.js';
import { createStandaloneExecutor } from './standalone-runner.js';
import { runNativeList } from './native-list.js';
import { resolve } from 'node:path';
import { readFileSync, statSync } from 'node:fs';

/** Injectable boundaries keep startup/cancellation tests independent of models. */
export function registerCli(pi, {
  runList = runDelegateList, createExecutor = createStandaloneExecutor,
  host = process, write = (text) => process.stderr.write(`${text}\n`),
} = {}) {
  // Existing flag for startup execution
  pi.registerFlag('delegate-list', { type: 'string', description: 'Execute Markdown checkbox tasks and !shell commands sequentially at startup.' });
  
  // New flag for follow-up execution after current run completes
  pi.registerFlag('delegate-list-followup', { type: 'string', description: 'Queue a Markdown checkbox task file to execute after the current run settles.' });

  // Command to run the startup list in interactive sessions
  pi.registerCommand('delegate-list-run', {
    description: 'Run the startup Markdown list in native Pi sessions.',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui' || !ctx.hasUI) return;
      const path = pi.getFlag('delegate-list');
      if (path !== undefined) {
        await new Promise(resolve => setImmediate(resolve));
        await runNativeList(path, ctx, { runList, host });
      }
    },
  });

  // Command to queue a todo file for follow-up execution
  pi.registerCommand('delegate-list-queue', {
    description: 'Queue a Markdown todo file to execute after the current run completes.',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui' || !ctx.hasUI) {
        ctx.ui?.notify('delegate-list-queue requires interactive mode', 'error');
        return;
      }
      const path = args.trim();
      if (!path) {
        ctx.ui.notify('Usage: /delegate-list-queue <path-to-todo-file>', 'error');
        return;
      }
      await queueFollowUpTodo(ctx, path);
      ctx.ui.notify(`Queued ${path} for execution after current run completes`, 'info');
    },
  });

  // Command to view queued follow-up todos
  pi.registerCommand('delegate-list-queued', {
    description: 'Show queued follow-up todo files.',
    handler: async (_args, ctx) => {
      const queued = getQueuedFollowUpTodos(ctx);
      if (queued.length === 0) {
        ctx.ui.notify('No todo files queued for follow-up execution', 'info');
        return;
      }
      ctx.ui.notify(`Queued todo files:\n${queued.map((p, i) => `${i + 1}. ${p}`).join('\n')}`, 'info');
    },
  });

  // Command to clear queued follow-up todos
  pi.registerCommand('delegate-list-clear-queue', {
    description: 'Clear all queued follow-up todo files.',
    handler: async (_args, ctx) => {
      clearQueuedFollowUpTodos(ctx);
      ctx.ui.notify('Cleared all queued follow-up todo files', 'info');
    },
  });

  let started = false;
  let controller;
  let cleanup = () => {};
  pi.on('session_shutdown', (event) => {
    host.emit('delegate-list-session-shutdown', event);
    controller?.abort(new Error('Pi session shut down.'));
    cleanup();
  });

  // Handle startup delegate-list flag
  pi.on('session_start', async (event, ctx) => {
    if (event.reason !== 'startup' || started) return;
    const path = pi.getFlag('delegate-list');
    if (path === undefined) return;
    started = true;
    const interactive = ctx.mode === 'tui' && ctx.hasUI;
    if (interactive) {
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
        onCommandOutput: ({ text }) => { if (!cleaned) write(text); },
        execute: (params, signal) => execute(params, signal) });
    } catch (error) {
      result = { isError: true, content: [{ type: 'text', text: `delegate-list failed: ${error?.message ?? error}` }] };
    } finally {
      cleanup();
      cleanup = () => {};
    }
    if (result.isError) host.exitCode = activeController.signal.aborted ? 130 : 1;
    report(result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n'), result.isError);
    controller = undefined;
    if (ctx.mode === 'rpc') ctx.shutdown();
  });

  // Handle follow-up delegate-list flag: queue for execution after current run
  pi.on('session_start', async (event, ctx) => {
    if (event.reason !== 'startup') return;
    const followUpPath = pi.getFlag('delegate-list-followup');
    if (followUpPath === undefined) return;
    await queueFollowUpTodo(ctx, followUpPath);
    await ctx.session.sendUserMessage(`/delegate-list-run-queued`, { deliverAs: 'followUp', expandPromptTemplates: true });
  });

  // Handle agent_settled to execute queued todo files
  pi.on('agent_settled', async (event, ctx) => {
    const queued = getQueuedFollowUpTodos(ctx);
    if (queued.length === 0) return;
    
    for (const path of queued) {
      try {
        // Validate file exists
        if (!statSync(path).isFile()) {
          write(`delegate-list follow-up skipped: ${path} is not a regular file`);
          continue;
        }
        ctx.ui?.notify(`Starting follow-up delegate-list: ${path}`, 'info');
        
        const { execute } = createExecutor({ cwd: ctx.cwd, model: ctx.model,
          thinkingLevel: ctx.thinkingLevel, signal: ctx.signal, onOutput: (output) => {
            if (output.reset) write(`delegate-list task: ${output.task}`);
            else if (output.event?.type === 'tool_execution_start') write(`${output.role}: running ${output.event.toolName}`);
            else if (output.event?.type === 'tool_execution_end') write(`${output.role}: ${output.event.toolName} ${output.event.isError ? 'failed' : 'finished'}`);
            else if (output.event?.type === 'message_end' && output.event?.message?.role === 'assistant') {
              const text = output.event.message.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
              if (text) write(`${output.role}: ${text}`);
            }
          } });
        
        await runList(path, { cwd: ctx.cwd, signal: ctx.signal,
          onCommandOutput: ({ text }) => write(text),
          execute: (params, signal) => execute(params, signal) });
      } catch (error) {
        write(`delegate-list follow-up failed for ${path}: ${error?.message ?? error}`);
      }
    }
    
    clearQueuedFollowUpTodos(ctx);
  });

  // Command to execute queued todos (triggered via followUp)
  pi.registerCommand('delegate-list-run-queued', {
    description: 'Execute all queued follow-up todo files (internal command).',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui' || !ctx.hasUI) return;
      // The actual execution happens in agent_settled handler
      // This command just serves as a trigger point
    },
  });
}

// Session-scoped storage for queued follow-up todo files
const FOLLOW_UP_TODO_KEY = 'delegate-list-followup-todos';

function getQueuedFollowUpTodos(ctx) {
  const entries = ctx.sessionManager.getBranch();
  const entry = entries.find(e => e.type === 'custom' && e.customType === FOLLOW_UP_TODO_KEY);
  if (!entry) return [];
  try {
    return JSON.parse(entry.content);
  } catch {
    return [];
  }
}

async function queueFollowUpTodo(ctx, path) {
  const queued = getQueuedFollowUpTodos(ctx);
  const resolvedPath = path.startsWith('/') ? path : resolve(ctx.cwd, path);
  if (!queued.includes(resolvedPath)) {
    queued.push(resolvedPath);
    ctx.appendEntry({
      type: 'custom',
      customType: FOLLOW_UP_TODO_KEY,
      content: JSON.stringify(queued),
    });
  }
}

function clearQueuedFollowUpTodos(ctx) {
  ctx.appendEntry({
    type: 'custom',
    customType: FOLLOW_UP_TODO_KEY,
    content: JSON.stringify([]),
  });
}

export default function (pi) {
  registerInteractiveDelegation(pi);
  registerCli(pi);
}
