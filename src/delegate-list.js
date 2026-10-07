import { emptyUsage, addUsage } from './workflow.js';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// Intentionally line-based: each checkbox is one self-contained assignment.
export function uncheckedTasks(text) {
  const tasks = [];
  let offset = 0;
  let taskNumber = 0;
  let fence;
  for (const line of text.split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
    } else if (!fence) {
      const match = /^(\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\]\s+)(.*)/.exec(line);
      if (match) {
        taskNumber++;
        if (match[2] === ' ') {
          const task = match[4].trim();
          if (!task) throw new Error('Unchecked tasks must have non-empty text.');
          tasks.push({ task, offset: offset + match[1].length, taskNumber });
        }
      }
    }
    offset += line.length;
  }
  return tasks;
}

const outcome = (completed, error, usage) => ({
    content: [{ type: 'text', text: error
      ? `delegate-list stopped after ${completed} item(s): ${error}`
      : `delegate-list: ${completed} item(s) completed.` }],
    details: { completed }, isError: Boolean(error), usage,
  });

const activePaths = new Set();

/** Execute and persist approved tasks in order. execute(params, signal) must
 * return a reviewed tool result with details.approved === true on success.
 * Paths are literal (no shell quotes or @ references). Concurrent runs of the
 * same resolved path are rejected; independent files may run concurrently. */
export async function runDelegateList(name, { cwd = process.cwd(), execute, signal } = {}) {
  const key = typeof name === 'string' && name.trim() ? resolve(cwd, name) : undefined;
  if (activePaths.has(key)) return outcome(0, 'A delegate-list run is already active.');
  activePaths.add(key);
  let completed = 0;
  const usage = emptyUsage();
  try {
    signal?.throwIfAborted();
    if (typeof execute !== 'function') throw new Error('Expected an executor function.');
    if (typeof name !== 'string' || !name.trim()) throw new Error('Expected a Markdown file path.');
    const path = resolve(cwd, name);
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
    while (true) {
      signal?.throwIfAborted();
      refresh('Todo file changed; stopping without overwriting it.');
      const item = uncheckedTasks(expected)[0];
      if (!item) break;
      const result = await execute({
        task: item.task, mode: 'execute', taskNumber: item.taskNumber,
        context: `Todo source: ${path}. Complete only this item. Do not edit the todo source; checkbox updates are managed by the list runner.`,
      }, signal);
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
  } finally { activePaths.delete(key); }
}
