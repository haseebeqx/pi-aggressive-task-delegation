import { Type } from 'typebox';
import { emptyUsage, addUsage } from './workflow.js';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Intentionally line-based: each checkbox is one self-contained assignment.
export function uncheckedTasks(text) {
  const tasks = [];
  let offset = 0;
  let fence;
  for (const line of text.split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
    } else if (!fence) {
      const match = /^(\s*(?:[-+*]|\d+[.)])\s+\[) (\]\s+)(.*)/.exec(line);
      if (match) {
        const task = match[3].trim();
        if (!task) throw new Error('Unchecked tasks must have non-empty text.');
        tasks.push({ task, offset: offset + match[1].length });
      }
    }
    offset += line.length;
  }
  return tasks;
}

export function registerDelegateList(pi, makeTool) {
  let running = false;
  const outcome = (completed, error, usage) => ({
    content: [{ type: 'text', text: error
      ? `delegate-list stopped after ${completed} item(s): ${error}`
      : `delegate-list: ${completed} item(s) completed.` }],
    details: { completed }, isError: Boolean(error), usage,
  });
  const run = async (name, ctx, signal, waitForIdle = false) => {
      if (running) return outcome(0, 'A delegate-list run is already active.');
      running = true;
      let completed = 0;
      const usage = emptyUsage();
      try {
        if (waitForIdle) await ctx.waitForIdle();
        signal?.throwIfAborted();
        if (!name?.trim()) throw new Error('Expected a Markdown file path.');
        const path = resolve(ctx.cwd, name);
        if (!/\.(md|markdown)$/i.test(path)) throw new Error('Expected a .md or .markdown file.');
        if (!statSync(path).isFile()) throw new Error('Expected a regular file.');
        let expected = readFileSync(path, 'utf8');
        const refresh = (message) => {
          const current = readFileSync(path, 'utf8');
          const suffix = current.slice(expected.length);
          // An append must not change the meaning of an existing final line.
          const boundary = !expected || expected.endsWith('\n') ||
            suffix.startsWith('\n') || suffix.startsWith('\r\n');
          if (!current.startsWith(expected) || (suffix && !boundary)) throw new Error(message);
          expected = current;
        };
        const parent = { role: 'main', procedural: true, session: { steer: async () => {} } };
        const tool = makeTool(undefined, () => parent);
        while (true) {
          signal?.throwIfAborted();
          refresh('Todo file changed; stopping without overwriting it.');
          const item = uncheckedTasks(expected)[0];
          if (!item) break;
          const result = await tool.execute(randomUUID(), {
            task: item.task, mode: 'execute',
            context: `Todo source: ${path}. Complete only this item. Do not edit the todo source; checkbox updates are managed by the list runner.`,
          }, signal, undefined, ctx);
          addUsage(usage, result.usage);
          signal?.throwIfAborted();
          if (result.isError || result.details?.approved !== true) throw new Error(result.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') || 'Delegation did not succeed.');
          // No await between the fresh read and write: preserve safe appends,
          // but never overwrite changes to the previously observed text.
          refresh('Todo file changed; successful item left unchecked to avoid a conflict.');
          expected = expected.slice(0, item.offset) + 'x' + expected.slice(item.offset + 1);
          writeFileSync(path, expected, 'utf8');
          completed++;
        }
        return outcome(completed, undefined, usage);
      } catch (error) {
        return outcome(completed, String(error?.message ?? error).slice(0, 1000), usage);
      } finally { running = false; }
  };
  pi.registerTool({
    name: 'delegate_list', label: 'Delegate list',
    description: 'Process independent, self-contained unchecked Markdown tasks strictly in file order. Each fresh worker and review must succeed and its checkbox must be saved before the next starts. Accepts append-only additions, including during the last item; stops immediately when no unchecked tasks remain, without waiting for future additions. Existing text edits or appends extending an unterminated line are conflicts. Stops on failure, cancellation, or conflict. No prior item reports are forwarded.',
    parameters: Type.Object({ path: Type.String({ minLength: 1, description: 'Markdown file path, relative to cwd or absolute.' }) }),
    execute: (_id, params, signal, _update, ctx) => run(params.path, ctx, signal),
  });
  pi.registerCommand('delegate-list', {
    description: 'Execute unchecked Markdown tasks sequentially and mark reviewed successes.',
    handler: async (args, ctx) => {
      let name = args.trim();
      if (!name) { ctx.ui.notify('Usage: /delegate-list <markdown-file>', 'info'); return; }
      if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) name = name.slice(1, -1);
      const result = await run(name, ctx, ctx.signal, true);
      ctx.ui.notify(result.content[0].text, result.isError ? 'error' : 'info');
    },
  });
}
