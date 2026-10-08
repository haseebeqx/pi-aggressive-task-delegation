import { registerDelegateTasks } from './delegate-tasks.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { allocateLogDirectory, seedPrivateSession } from './log-storage.js';
import { createDelegator, rolePrompts, emptyUsage, addUsage } from './workflow.js';

export const launcherExtensionPath = fileURLToPath(new URL('./extension.js', import.meta.url));

/**
 * Independent, sequential worker/reviewer executor. No Main session or tools are used.
 * modelRuntime is the documented SDK model/auth runtime, used for prompt auth
 * preflight as well as streaming and non-chat models. When omitted, each SDK
 * session creates its own runtime using standard auth storage/environment.
 * A selected model does not inherit Main registry credentials or providers.
 * Standard discovery/trust rules apply, without interactive permission dialogs;
 * loaded permission extensions still validate/block calls through the SDK pipeline.
 * Built-in MCP/codemode/search factories are added explicitly, respecting settings
 * exclusions and replacements. MCP starts on bindExtensions; servers may connect
 * asynchronously. No Main-only CLI extension paths or MCP connections are inherited.
 * sdk is an optional dependency-injection seam for tests. execute returns the
 * createDelegator result (details.approved is the legacy success gate; independentApproved identifies review approval).
 */
export function createStandaloneExecutor({ cwd = process.cwd(), model, modelRuntime,
  thinkingLevel, signal: lifetimeSignal, onProgress, onOutput, agentDir,
  sdk: injectedSdk, discoveryOnly = false } = {}) {
  const parent = randomUUID();
  const sdkPromise = injectedSdk ? Promise.resolve(injectedSdk) : import('@earendil-works/pi-coding-agent');
  const runAgent = async (role, assignment, signal) => {
    onProgress?.(`${role}: initializing`);
    const sdk = await sdkPromise;
    signal?.throwIfAborted();
    const directory = agentDir ?? sdk.getAgentDir();
    const settings = sdk.SettingsManager.create(cwd, directory);
    // Package discovery reads scoped settings, not applyOverrides. A read-only
    // facade excludes the launcher in BOTH scopes, including after trust reload.
    // extensionsOverride is too late: extension factories have already executed.
    const settingsManager = new Proxy(settings, { get(target, key) {
      const value = target[key];
      if (['getGlobalSettings', 'getProjectSettings', 'getSettings'].includes(key)) {
        return () => { const base = value.call(target); return { ...base,
          extensions: [...(base.extensions ?? []), `-${launcherExtensionPath}`] }; };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: directory, settingsManager,
      appendSystemPromptOverride: (base) => [...base, rolePrompts[role]],
      extensionFactories: [
        { name: 'aggressive-task-delegation', factory: (pi) => registerDelegateTasks(pi, {
          discoveryOnly: role === 'discoverer',
          createExecutor: (options) => createStandaloneExecutor({ ...options,
            agentDir: directory, modelRuntime, sdk, onOutput }),
        }) },
        { name: 'codemode', builtin: true, replaceable: true, factory: sdk.createCodemodeExtension() },
        { name: 'tool-search', builtin: true, replaceable: true, factory: sdk.createToolSearchExtension() },
        { name: 'mcp', builtin: true, replaceable: true, factory: sdk.createMcpExtension() },
      ],
    });
    const logDirectory = allocateLogDirectory(directory, cwd, parent, role);
    const logPath = seedPrivateSession(sdk.SessionManager.create(cwd, logDirectory));
    const sessionManager = sdk.SessionManager.open(logPath, logDirectory);
    const usage = emptyUsage();
    let session, unsubscribe;
    let abortPending;
    const abort = () => { abortPending = Promise.resolve(session.abort()).catch(() => {}); };
    try {
      await loader.reload();
      signal?.throwIfAborted();
      ({ session } = await sdk.createAgentSession({ cwd, agentDir: directory, model,
        modelRuntime, thinkingLevel, settingsManager, resourceLoader: loader, sessionManager }));
      unsubscribe = session.subscribe((event) => {
        // Forward the child's stream; it never enters the Main transcript.
        try { onOutput?.({ role, event, toolDefinition: event.toolName ? session.getToolDefinition?.(event.toolName) : undefined }); } catch { /* Rendering must not fail a task. */ }
        if (event.type === 'tool_execution_start') onProgress?.(`${role}: running ${event.toolName}`);
        if (event.type === 'tool_execution_end') onProgress?.(`${role}: ${event.toolName} ${event.isError ? 'failed' : 'finished'}`);
        if (event.type === 'message_start' && event.message.role === 'assistant') onProgress?.(`${role}: responding`);
        if (event.type === 'message_end' &&
            ['assistant', 'toolResult'].includes(event.message.role)) addUsage(usage, event.message.usage);
      });
      signal?.addEventListener('abort', abort, { once: true });
      signal?.throwIfAborted();
      await session.bindExtensions({});
      signal?.throwIfAborted();
      await session.prompt(assignment, { expandPromptTemplates: false });
      signal?.throwIfAborted();
      const last = session.messages.findLast((message) => message.role === 'assistant');
      if (!last || ['error', 'aborted'].includes(last.stopReason)) {
        throw new Error(last?.errorMessage || `${role} did not complete.`);
      }
      const report = last.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim();
      if (!report) throw new Error(`${role} returned no report.`);
      return { report, usage, logPath };
    } catch (cause) {
      const error = new Error(cause?.message ?? String(cause), { cause });
      Object.assign(error, { usage, logPath });
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      await abortPending;
      unsubscribe?.();
      try {
        if (session) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      } finally { session?.dispose(); }
    }
  };
  const delegate = createDelegator(runAgent, { discoveryOnly });
  return { execute(params, signal, progress = onProgress) {
    try { onOutput?.({ task: params.task, reset: true }); } catch { /* Display only. */ }
    const signals = [lifetimeSignal, signal].filter(Boolean);
    return delegate(params, signals.length ? AbortSignal.any(signals) : undefined, progress);
  } };
}
