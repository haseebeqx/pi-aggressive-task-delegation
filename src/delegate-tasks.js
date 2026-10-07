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
    description: 'Delegate an execution task to a fresh worker and independent reviewer, or gather scoped read-only facts with mode discover. Call sequentially and pass only relevant context. Main may delegate a single task; workers require at least two useful, strictly smaller subtasks or must execute directly. Discovery returns evidence and gaps, not implementation.',
    parameters: Type.Object({
      task: Type.String({ minLength: 1 }),
      mode: Type.Optional(Type.Union([Type.Literal('execute'), Type.Literal('discover')])),
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
