import {
  createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { DelegationView } from './delegation-view.js';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { allocateLogDirectory, seedPrivateSession } from './log-storage.js';
import {
  addUsage, createDelegator, emptyUsage, reviewerPrompt, supervisorPrompt, workerPrompt,
} from './workflow.js';

function delegationTool(runAgent) {
  const delegate = createDelegator(runAgent);
  return {
    name: 'delegate_task',
    label: 'pi aggressive task delegation',
    description: 'Execute one small task in a fresh worker context, then independently review it. Returns only concise reports. Workers can recursively delegate. Calls run sequentially. On failure, delegate a focused correction with the findings.',
    parameters: Type.Object({
      task: Type.String({ minLength: 1, description: 'Concrete task and acceptance criteria.' }),
      context: Type.Optional(Type.String({ description: 'Only relevant paths, requirements, decisions, and prior summaries. No transcripts.' })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return delegate({ ...params, ctx }, signal, (phase) => onUpdate?.({
        content: [{ type: 'text', text: `${phase}: ${params.task}` }],
        details: undefined,
      }));
    },
  };
}

export default function taskDivider(pi) {
  const activeSessions = new Set();
  const ephemeralParent = randomUUID();
  let ui;
  let lastPaint = 0;
  const view = new DelegationView((node) => {
    if (!ui) return;
    if (!node) {
      ui.setWidget('delegation', undefined);
      return;
    }
    const path = [];
    for (let current = node; current; current = current.parent) {
      path.unshift(current.role === 'main' ? 'Main' : `${current.role}: ${current.task}`);
    }
    const usage = node.usage ?? emptyUsage();
    ui.setWidget('delegation', [
      `Delegated session · ${path.join(' → ')}`,
      node.waiting ? 'Cancelled child. What should this parent do instead? Type your instruction.'
        : `${node.activity || 'Working'} · Input steers this session · Ctrl+Esc / /delegate-cancel: return to parent`,
      `Tokens: ${usage.input} in / ${usage.output} out / ${usage.cacheRead} cache read / ${usage.cacheWrite} cache write · Cost: $${usage.cost.total.toFixed(4)}`,
      ...node.text.split('\n').slice(-8),
    ]);
  });

  // A child receives a new conversation, never a copy of its parent's messages.
  // Persist it separately; only the log path is returned to the caller.
  async function runAgent(role, prompt, signal, parentCtx, scope, task) {
    signal?.throwIfAborted();
    const loader = new DefaultResourceLoader({
      cwd: parentCtx.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPrompt: [role === 'worker' ? workerPrompt : reviewerPrompt],
    });
    await loader.reload();
    signal?.throwIfAborted();
    const parentSession = parentCtx.sessionManager?.getSessionFile() ??
      parentCtx.sessionManager?.getSessionId() ?? ephemeralParent;
    const logDirectory = allocateLogDirectory(getAgentDir(), parentCtx.cwd, parentSession, role);
    const freshManager = SessionManager.create(parentCtx.cwd, logDirectory);
    const logPath = seedPrivateSession(freshManager);
    const sessionManager = SessionManager.open(logPath, logDirectory);
    sessionManager.appendCustomEntry('delegation', { role, parentSession });
    let node;
    const { session } = await createAgentSession({
      cwd: parentCtx.cwd,
      model: parentCtx.model,
      thinkingLevel: parentCtx.thinkingLevel,
      resourceLoader: loader,
      sessionManager,
      tools: role === 'worker'
        ? ['read', 'bash', 'edit', 'write', 'delegate_task']
        : ['read', 'bash', 'grep', 'find', 'ls'],
      customTools: role === 'worker' ? [makeTool(parentCtx, () => node)] : [],
    }).catch((error) => {
      error.logPath = logPath;
      throw error;
    });
    if (signal?.aborted) {
      session.dispose();
      const error = new Error('Delegated session cancelled before starting.');
      error.logPath = logPath;
      throw error;
    }
    // Use the parent's configured provider and request-time credentials rather
    // than assuming a subprocess or a separate authentication configuration.
    session.agent.streamFunction = (model, context, options) =>
      parentCtx.modelRegistry.streamSimple(model, context, options);
    session.agent.toolExecution = 'sequential';
    activeSessions.add(session);
    node = view.enter(scope, session, role, task);
    const abort = () => session.agent.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const usage = emptyUsage();
    node.usage = usage;
    // Accumulate usage as events arrive, including nested delegation results.
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_end' &&
          (event.message.role === 'assistant' || event.message.role === 'toolResult')) {
        addUsage(usage, event.message.usage);
        view.update(node);
      }
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        node.text = (node.text + event.assistantMessageEvent.delta).slice(-4000);
        // Bound rendering work without creating a timer per stream event.
        if (Date.now() - lastPaint > 100) {
          lastPaint = Date.now();
          view.update(node);
        }
      }
      if (event.type === 'tool_execution_start') {
        node.activity = `Tool: ${event.toolName} ${JSON.stringify(event.args).slice(0, 300)}`;
        view.update(node);
      }
      if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
        const result = event.partialResult ?? event.result;
        const text = result?.content?.filter((part) => part.type === 'text')
          .map((part) => part.text).join('\n');
        if (text) node.text = text.slice(-4000);
        node.activity = `Tool: ${event.toolName}${event.type === 'tool_execution_end' ? ' finished' : ''}`;
        view.update(node);
      }
    });
    try {
      signal?.throwIfAborted();
      await session.prompt(prompt);
      signal?.throwIfAborted();
      const last = session.messages.findLast((message) => message.role === 'assistant');
      if (!last || last.stopReason === 'error' || last.stopReason === 'aborted') {
        throw new Error(last?.errorMessage || `${role} did not complete.`);
      }
      const report = last.content.filter((part) => part.type === 'text')
        .map((part) => part.text).join('\n').trim();
      if (!report) throw new Error(`${role} returned no report.`);
      return { report, usage, logPath: sessionManager.getSessionFile() };
    } catch (error) {
      const logPath = sessionManager.getSessionFile();
      if (logPath && existsSync(logPath)) error.logPath = logPath;
      error.usage = usage;
      throw error;
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', abort);
      activeSessions.delete(session);
      view.leave(node);
      session.dispose();
    }
  }

  function makeTool(inheritedCtx, getParent) {
    // A separate queue per context serializes siblings without blocking recursion.
    let scope;
    let task;
    const tool = delegationTool((role, prompt, signal, ctx) =>
      runAgent(role, prompt, signal, inheritedCtx ? {
        ...inheritedCtx, ...ctx,
        modelRegistry: inheritedCtx.modelRegistry,
        thinkingLevel: inheritedCtx.thinkingLevel,
      } : ctx, scope, task));
    const execute = tool.execute;
    // Keep scope allocation inside a per-context queue, not before it.
    let tail = Promise.resolve();
    tool.execute = (id, params, signal, onUpdate, ctx) => {
      const result = tail.then(async () => {
        if (ctx.hasUI) ui = ctx.ui;
        const parent = getParent?.() ?? { role: 'main', session: {
          steer: (text, images) => pi.sendUserMessage(
            images?.length ? [{ type: 'text', text }, ...images] : text,
            { deliverAs: 'steer' }),
        } };
        scope = view.open(parent, signal);
        task = params.task;
        try {
          const result = await execute(id, params, scope.controller.signal, onUpdate, ctx);
          if (scope.cancelled) {
            result.isError = true;
            result.content[0].text = `Cancelled by user. Do not retry automatically. Follow the user's replacement instruction.\n${result.content[0].text}`;
          }
          return result;
        } finally {
          await view.finish(scope);
        }
      });
      tail = result.catch(() => {});
      return result;
    };
    return tool;
  }

  pi.registerTool(makeTool());
  pi.on('input', async (event) => {
    if (event.source === 'extension') return { action: 'continue' };
    if (await view.input(event.text, event.images)) return { action: 'handled' };
    return { action: 'continue' };
  });
  const cancel = (_args, ctx) => {
    if (!view.cancel()) ctx.ui.notify('No delegated task is focused.', 'info');
  };
  pi.registerCommand('delegate-cancel', {
    description: 'Cancel the visible delegated task and return to its immediate parent.',
    handler: cancel,
  });
  pi.registerShortcut?.('ctrl+escape', {
    description: 'Cancel delegated task and return to parent',
    handler: (ctx) => cancel('', ctx),
  });
  pi.registerCommand('divide', {
    description: 'Divide and execute a task sequentially while preserving supervisor context.',
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify('Usage: /divide <task>', 'info');
        return;
      }
      pi.sendUserMessage(`${supervisorPrompt}\n\nTask:\n${args.trim()}`);
    },
  });
  pi.on('session_shutdown', () => {
    view.shutdown();
    for (const session of activeSessions) session.agent.abort();
  });
}
