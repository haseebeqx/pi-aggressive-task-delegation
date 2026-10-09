import { matchesKey, parseKey } from '@earendil-works/pi-tui';
import { supervisorPrompt } from './interactive-workflow.js';
import { runDelegateList } from './delegate-list.js';

// Replacement contexts are command-only. Never switch from session_start or
// reuse the outgoing runtime's pi API after a successful replacement.
export async function runNativeList(path, ctx, { runList = runDelegateList, host = process } = {}) {
  const cwd = ctx.cwd;
  const controller = new AbortController();
  let current = ctx;
  let removeInput;
  let switching = false;
  const cancel = () => {
    if (controller.signal.aborted) return;
    controller.abort(new Error('Cancelled by user.'));
    try { current.abort(); } catch { /* replacement or shutdown invalidated it */ }
  };
  const shutdown = (event) => {
    if (!(switching && event.reason === 'new')) cancel();
  };
  host.on('SIGINT', cancel);
  host.on('delegate-list-session-shutdown', shutdown);
  let result;
  try {
    current.ui.notify(`delegate-list: ${path}`, 'info');
    result = await runList(path, { cwd, signal: controller.signal,
      execute: async (params) => {
        const sessionIds = {}, logs = {};
        let taskContext;
        try {
          controller.signal.throwIfAborted();
          await current.waitForIdle();
          removeInput?.();
          removeInput = undefined;
          switching = true;
          let replacement;
          try {
            replacement = await current.newSession({ withSession: async (fresh) => {
              current = fresh;
              taskContext = fresh;
              const sessionId = fresh.sessionManager.getSessionId?.();
              if (sessionId) sessionIds.supervisor = sessionId;
              controller.signal.throwIfAborted();
              fresh.ui.setStatus('delegate-list', `delegated task #${params.taskNumber}`);
              removeInput = fresh.ui.onTerminalInput(data => {
                if (matchesKey(data, 'ctrl+c') || parseKey(data) === 'ctrl+escape') {
                  cancel();
                  return { consume: true };
                }
              });
            } });
          } finally { switching = false; }
          if (replacement.cancelled) throw new Error('New session cancelled.');
          controller.signal.throwIfAborted();
          // Same supervisor workflow as /delegate-tasks, submitted as a normal
          // user prompt. Unlike pi.sendUserMessage, this supported replacement
          // context method is awaitable through retries and final settlement.
          await current.sendUserMessage(`${supervisorPrompt}\n\nTask:\n${params.task}\n\nRelevant context:\n${params.context}`);
          controller.signal.throwIfAborted();
          const last = current.sessionManager.getBranch().findLast(entry =>
            entry.type === 'message' && entry.message.role === 'assistant')?.message;
          if (!last || ['error', 'aborted', 'pending', 'deferred'].includes(last.stopReason)) {
            throw new Error(last?.errorMessage || 'Native item did not complete (error or abort).');
          }
          return { details: { approved: true, sessionIds, logs }, content: [] };
        } catch (error) {
          // Return failure metadata rather than throwing it away. The list runner
          // still applies its normal error/cancellation gate before marking.
          return { isError: true, details: { approved: false, sessionIds, logs },
            content: [{ type: 'text', text: error.message }] };
        } finally {
          // Raw branch entries retain tool-result details even after compaction.
          // A shutdown/switch may invalidate the context; keep already known IDs.
          try {
            let call = 0;
            for (const entry of taskContext?.sessionManager.getBranch() ?? []) {
              const message = entry.type === 'message' && entry.message;
              if (message?.role !== 'toolResult' || message.toolName !== 'delegate_task') continue;
              const label = `delegate_task #${++call}${message.toolCallId ? ` (${message.toolCallId})` : ''}`;
              for (const [target, values] of [[sessionIds, message.details?.sessionIds], [logs, message.details?.logs]]) {
                for (const [role, value] of Object.entries(values ?? {})) {
                  if (value) target[`${label} ${role}`] = value;
                }
              }
            }
          } catch { /* stale context: metadata is best effort */ }
        }
      },
    });
  } catch (error) {
    result = { isError: true, content: [{ type: 'text', text: `delegate-list failed: ${error.message}` }] };
  } finally {
    host.off('SIGINT', cancel);
    host.off('delegate-list-session-shutdown', shutdown);
    removeInput?.();
    // A user-initiated session switch can invalidate this context too.
    try { current.ui.setStatus('delegate-list', undefined); } catch { /* stale context */ }
  }
  if (result.isError) host.exitCode = controller.signal.aborted ? 130 : 1;
  try {
    current.ui.notify(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), result.isError ? 'error' : 'info');
  } catch { /* host shut down or switched away */ }
  return result;
}
