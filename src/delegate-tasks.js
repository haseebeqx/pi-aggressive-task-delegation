import { reviewGuidance } from './review-policy.js';
import { Type } from 'typebox';
import { createStandaloneExecutor } from './standalone-runner.js';
import { supervisorPrompt } from './workflow.js';

/** Shared entry point for interactive supervisors and isolated list workers. */
export function registerDelegateTasks(pi, {
  createExecutor = createStandaloneExecutor, discoveryOnly = false,
} = {}) {
  // One executor/queue per session; replacement sessions must not reuse it.
  let executor;
  pi.on('session_start', () => { executor = undefined; });
  pi.registerTool({
    name: 'delegate_task',
    label: 'Delegate task',
    description: `Delegate an execution task to a fresh worker and optional independent reviewer, or gather scoped read-only facts with mode discover. Call sequentially and pass only relevant context. Main must delegate substantive execution by default, including small self-contained tasks, and may delegate a single task. Workers MUST delegate whenever at least two concrete, useful, strictly smaller execution subtasks exist; size, ease, or speed are not opt-outs. Genuine leaves execute directly. Never forward a whole worker assignment or split artificially. Discovery is optional: use only lightweight local orientation, delegate separable factual questions even for small tasks, and allow direct focused leaf lookups or already-known tasks without discovery. Discovery agents MUST recurse whenever useful strictly narrower factual scopes exist, without artificial splits or execution; no two-subtask threshold applies. Discovery returns verified evidence and gaps, not implementation or a plan. After independent execution review passes, integrate without routinely repeating work; on failure delegate focused correction before proceeding. ${reviewGuidance}`,
    parameters: Type.Object({
      task: Type.String({ minLength: 1 }),
      mode: Type.Optional(Type.Union([Type.Literal('execute'), Type.Literal('discover')])),
      review: Type.Optional(Type.Boolean({ default: true, description: 'Independent execution review (default true). Set false only when risk and concrete worker verification justify skipping; ignored for discovery.' })),
      context: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      executor ??= createExecutor({ cwd: ctx.cwd, model: ctx.model,
        thinkingLevel: ctx.thinkingLevel, discoveryOnly });
      const result = await executor.execute(params, signal, (phase) => onUpdate?.({
        content: [{ type: 'text', text: `${phase}: ${params.task}` }], details: undefined,
      }));
      // Pi treats thrown executions as errors; isError alone is not sufficient.
      if (result.isError) throw Object.assign(new Error(result.content
        .filter((part) => part.type === 'text').map((part) => part.text).join('\n')), {
        usage: result.usage,
      });
      return result;
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
}
