import { delegationDescription } from './role-prompts.js';
import {
  AssistantMessageComponent, ToolExecutionComponent, FooterComponent,
  createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager,
  createBashToolDefinition, createEditToolDefinition, createFindToolDefinition,
  createGrepToolDefinition, createLsToolDefinition, createPowerShellToolDefinition,
  createReadToolDefinition, createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Text } from '@earendil-works/pi-tui';
import { createDelegationWidgets, updateDelegationMessage } from './delegation-renderer.js';
import { DelegationView } from './delegation-view.js';
import { DelegationFooter } from './delegation-footer.js';
import { DelegationTranscript, OUTPUT_ENTRY, createTranscriptComponent } from './delegation-transcript.js';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { allocateLogDirectory, seedPrivateSession } from './log-storage.js';
import { inheritTools } from './inherited-tools.js';
import {
  addUsage, createDelegator, emptyUsage, rolePrompts, supervisorPrompt,
} from './interactive-workflow.js';

function delegationTool(runAgent, discoveryOnly = false) {
  const delegate = createDelegator(runAgent, { discoveryOnly });
  return {
    name: 'delegate_task',
    label: 'pi aggressive task delegation',
    description: delegationDescription,
    parameters: Type.Object({
      task: Type.String({ minLength: 1, description: 'Concrete execution task and acceptance criteria, or discovery scope/questions.' }),
      mode: Type.Optional(Type.Union([Type.Literal('execute'), Type.Literal('discover')], {
        description: 'Defaults to execute; discovery children default to discover and cannot execute.',
      })),
      review: Type.Optional(Type.Boolean({ default: true, description: 'Independent execution review (default true). Set false only when risk and concrete worker verification justify skipping; ignored for discovery.' })),
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
  let terminalUI;
  let lastPaint = 0;
  const footer = new DelegationFooter(FooterComponent, (error) => disableUI(error));
  // Use public definitions only for presentation. Execution still goes through
  // the supervisor's executeTool bridge (including validation/permission hooks).
  const rendererFactories = new Map([
    ['read', createReadToolDefinition], ['edit', createEditToolDefinition],
    ['write', createWriteToolDefinition], ['bash', createBashToolDefinition],
    ['powershell', createPowerShellToolDefinition], ['grep', createGrepToolDefinition],
    ['find', createFindToolDefinition], ['ls', createLsToolDefinition],
  ]);
  const components = {
    AssistantMessageComponent, ToolExecutionComponent, Text,
    resolveToolDefinition: (name, cwd) => rendererFactories.get(name)?.(cwd),
  };
  const transcript = new DelegationTranscript((type, data) => pi.appendEntry(type, data), randomUUID);
  pi.registerEntryRenderer(OUTPUT_ENTRY, (entry, _options, theme) =>
    createTranscriptComponent(() => transcript.records.get(entry.data.id) ?? entry.data,
      components, { requestRender: () => terminalUI?.requestRender() }, theme));
  pi.on('session_start', (_event, ctx) => {
    transcript.restore(ctx.sessionManager.getBranch());
    ui = ctx.hasUI && ctx.mode === 'tui' ? ctx.ui : undefined;
  });
  pi.on('session_tree', (_event, ctx) => {
    transcript.restore(ctx.sessionManager.getBranch());
  });
  const disableUI = (error) => {
    const failedUI = ui;
    ui = undefined;
    terminalUI = undefined;
    // Rendering must never throw back into the SDK's event dispatch: that can
    // interrupt persistence/settlement and leave prompt() waiting indefinitely.
    try {
      footer.restore();
      failedUI?.setWidget('delegation', undefined);
      failedUI?.setWidget('delegation-indicator', undefined);
      failedUI?.notify(`Delegation display disabled: ${error.message}`, 'warning');
    } catch { /* The UI itself may be broken; model execution must continue. */ }
  };
  const view = new DelegationView((node) => {
    if (!ui) return;
    try {
      footer.focus(ui, node);
      if (!node) {
        ui.setWidget('delegation', undefined);
        ui.setWidget('delegation-indicator', undefined);
        return;
      }
      const widgets = createDelegationWidgets(node, components);
      ui.setWidget('delegation', (tui, theme) => {
        terminalUI = tui;
        return widgets.content(tui, theme);
      });
      ui.setWidget('delegation-indicator', widgets.indicator, { placement: 'belowEditor' });
    } catch (error) {
      disableUI(error);
    }
  });

  // A child receives a new conversation, never a copy of its parent's messages.
  // Persist it separately; return its log path and authoritative session ID.
  async function runAgent(role, prompt, signal, parentCtx, scope, task) {
    signal?.throwIfAborted();
    const loader = new DefaultResourceLoader({
      cwd: parentCtx.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPrompt: [rolePrompts[role]],
    });
    await loader.reload();
    signal?.throwIfAborted();
    const parentSession = parentCtx.sessionManager?.getSessionFile() ??
      parentCtx.sessionManager?.getSessionId() ?? ephemeralParent;
    const logDirectory = allocateLogDirectory(getAgentDir(), parentCtx.cwd, parentSession, role);
    let sessionManager = SessionManager.create(parentCtx.cwd, logDirectory);
    try {
      const logPath = seedPrivateSession(sessionManager);
      sessionManager = SessionManager.open(logPath, logDirectory);
      sessionManager.appendCustomEntry('delegation', { role, parentSession });
      let node;
      const { session } = await createAgentSession({
        cwd: parentCtx.cwd,
        model: parentCtx.model,
        thinkingLevel: parentCtx.thinkingLevel,
        resourceLoader: loader,
        sessionManager,
        ...inheritTools(parentCtx, makeTool(parentCtx, () => node, role.startsWith('discover')),
          { discoveryOnly: role.startsWith('discover') }),
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
      node.cwd = parentCtx.cwd;
      const abort = () => {
        // Agent-only abort leaves session-level retry/compaction work alive.
        void session.abort().catch(() => {});
      };
      signal?.addEventListener('abort', abort, { once: true });
      const usage = emptyUsage();
      node.usage = usage;
      // Accumulate usage as events arrive, including nested delegation results.
      let assistantRecord;
      let toolRecord;
      const unsubscribe = session.subscribe((event) => {
        footer.refresh(node);
        if (event.type === 'message_end' &&
            (event.message.role === 'assistant' || event.message.role === 'toolResult')) {
          addUsage(usage, event.message.usage);
          view.update(node);
        }
        if (updateDelegationMessage(node, event)) {
          try {
            if (ui) {
              if (event.type.startsWith('message_')) {
                const content = { message: structuredClone(node.message), streaming: node.streaming };
                if (event.type === 'message_start' || !assistantRecord) {
                  assistantRecord = transcript.start(node, 'assistant', content);
                } else transcript.update(assistantRecord, content);
                if (event.type === 'message_end') transcript.update(assistantRecord, content, true);
              } else {
                const content = { tool: structuredClone(node.tool) };
                if (event.type === 'tool_execution_start' || !toolRecord) {
                  toolRecord = transcript.start(node, 'tool', content);
                } else transcript.update(toolRecord, content);
                if (event.type === 'tool_execution_end') transcript.update(toolRecord, content, true);
              }
            }
            // Bound streaming work, but always paint boundaries and final content.
            if (event.type !== 'message_update' || Date.now() - lastPaint > 100) {
              lastPaint = Date.now();
              view.update(node);
              terminalUI?.requestRender();
            }
          } catch (error) {
            disableUI(error);
          }
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
        return { report, usage, logPath: sessionManager.getSessionFile(),
          sessionId: sessionManager.getSessionId?.() };
      } catch (error) {
        const logPath = sessionManager.getSessionFile();
        if (logPath && existsSync(logPath)) error.logPath = logPath;
        error.usage = usage;
        throw error;
      } finally {
        // Preserve partial output even when cancellation prevents a final event.
        try {
          if (assistantRecord?.streaming) transcript.update(assistantRecord, { streaming: false }, true);
          if (toolRecord && (!toolRecord.tool.result || toolRecord.tool.partial)) transcript.update(toolRecord, {}, true);
        } catch (error) {
          disableUI(error);
        }
        unsubscribe();
        signal?.removeEventListener('abort', abort);
        activeSessions.delete(session);
        view.leave(node);
        session.dispose();
      }
    } catch (error) {
      error.sessionId = sessionManager.getSessionId?.();
      throw error;
    }
  }

  function makeTool(inheritedCtx, getParent, discoveryOnly = false) {
    // A separate queue per context serializes siblings without blocking recursion.
    let scope;
    let task;
    const tool = delegationTool((role, prompt, signal, ctx) =>
      runAgent(role, prompt, signal, inheritedCtx ? {
        ...inheritedCtx, ...ctx,
        // The SDK supplies these via non-enumerable getters; spreading ctx
        // alone would silently keep the parent's bridge during recursion.
        tools: ctx.tools,
        executeTool: ctx.executeTool,
        modelRegistry: inheritedCtx.modelRegistry,
        thinkingLevel: inheritedCtx.thinkingLevel,
      } : ctx, scope, task), discoveryOnly);
    const execute = tool.execute;
    // Keep scope allocation inside a per-context queue, not before it.
    let tail = Promise.resolve();
    tool.execute = (id, params, signal, onUpdate, ctx) => {
      const result = tail.then(async () => {
        if (ctx.hasUI && ctx.mode === 'tui') ui = ctx.ui;
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
  pi.registerShortcut?.('ctrl+escape', {
    description: 'Cancel delegated task and return to parent',
    handler: (ctx) => {
      if (!view.cancel()) ctx.ui.notify('No delegated task is focused.', 'info');
    },
  });
  pi.registerCommand('delegate-tasks', {
    description: 'Divide and execute a task sequentially while preserving supervisor context.',
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify('Usage: /delegate-tasks <task>', 'info');
        return;
      }
      pi.sendUserMessage(`${supervisorPrompt}\n\nTask:\n${args.trim()}`);
    },
  });
  pi.on('session_shutdown', () => {
    view.shutdown();
    for (const session of activeSessions) void session.abort().catch(() => {});
  });
}
