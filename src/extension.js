import {
  createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
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

  // A child receives a new conversation, never a copy of its parent's messages.
  // Persist it separately; only the log path is returned to the caller.
  async function runAgent(role, prompt, signal, parentCtx) {
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
    const { session } = await createAgentSession({
      cwd: parentCtx.cwd,
      model: parentCtx.model,
      thinkingLevel: parentCtx.thinkingLevel,
      resourceLoader: loader,
      sessionManager,
      tools: role === 'worker'
        ? ['read', 'bash', 'edit', 'write', 'delegate_task']
        : ['read', 'bash', 'grep', 'find', 'ls'],
      customTools: role === 'worker' ? [makeTool(parentCtx)] : [],
    }).catch((error) => {
      error.logPath = logPath;
      throw error;
    });
    // Use the parent's configured provider and request-time credentials rather
    // than assuming a subprocess or a separate authentication configuration.
    session.agent.streamFunction = (model, context, options) =>
      parentCtx.modelRegistry.streamSimple(model, context, options);
    session.agent.toolExecution = 'sequential';
    activeSessions.add(session);
    const abort = () => session.agent.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const usage = emptyUsage();
    // Accumulate usage as events arrive, including nested delegation results.
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_end' &&
          (event.message.role === 'assistant' || event.message.role === 'toolResult')) {
        addUsage(usage, event.message.usage);
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
      session.dispose();
    }
  }

  function makeTool(inheritedCtx) {
    // A separate queue per context serializes siblings without blocking recursion.
    return delegationTool((role, prompt, signal, ctx) =>
      runAgent(role, prompt, signal, inheritedCtx ?? ctx));
  }

  pi.registerTool(makeTool());
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
    for (const session of activeSessions) session.agent.abort();
  });
}
