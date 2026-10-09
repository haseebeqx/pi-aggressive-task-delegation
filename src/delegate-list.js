import { emptyUsage, addUsage } from './workflow.js';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// Intentionally line-based: each checkbox is one self-contained assignment.
function checkboxTasks(text) {
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
        const task = match[4].trim();
        if (match[2] === ' ' && !task) throw new Error('Unchecked tasks must have non-empty text.');
        tasks.push({
          task, offset: offset + match[1].length, taskNumber,
          checked: match[2] !== ' ', text: match[4].replace(/\r$/, ''),
        });
      }
    }
    offset += line.length;
  }
  return tasks;
}

// Keep the public parser's original shape. Identity matching includes checked
// items too: an unchecked duplicate must not borrow a completed item's approval.
export function uncheckedTasks(text) {
  return checkboxTasks(text).filter(item => !item.checked)
    .map(({ task, offset, taskNumber }) => ({ task, offset, taskNumber }));
}

function approvedItem(before, after, original, previousItems, latestItems) {
  // A stable snapshot gives duplicate lines an unambiguous position.
  if (before === after) return latestItems.find(item => item.offset === original.offset);
  // Across edits, only a task whose exact text is unique in both snapshots can
  // be followed through shifts/reordering. Never guess among duplicate tasks.
  const previous = previousItems.filter(item => item.text === original.text);
  const latest = latestItems.filter(item => item.text === original.text);
  return previous.length === 1 && latest.length === 1 ? latest[0] : undefined;
}

const outcome = (completed, error, usage, items = []) => {
  const summary = error
    ? `delegate-list stopped after ${completed} item(s): ${error}`
    : `delegate-list: ${completed} item(s) completed.`;
  const lines = [summary];
  for (const item of items) {
    lines.push(`Task ${item.taskNumber} [${item.completed ? 'completed' : 'not completed'}]: ${item.task}`);
    for (const [role, sessionId] of Object.entries(item.sessionIds)) {
      if (sessionId) lines.push(`  ${role} session ID: ${sessionId}`);
    }
    for (const [role, log] of Object.entries(item.logs)) {
      if (log) lines.push(`  ${role} transcript log: ${log}`);
    }
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    details: { completed, items }, isError: Boolean(error), usage,
  };
};

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
  const items = [];
  const usage = emptyUsage();
  try {
    signal?.throwIfAborted();
    if (typeof execute !== 'function') throw new Error('Expected an executor function.');
    if (typeof name !== 'string' || !name.trim()) throw new Error('Expected a Markdown file path.');
    const path = resolve(cwd, name);
    if (!/\.(md|markdown)$/i.test(path)) throw new Error('Expected a .md or .markdown file.');
    if (!statSync(path).isFile()) throw new Error('Expected a regular file.');
    while (true) {
      signal?.throwIfAborted();
      const before = readFileSync(path, 'utf8');
      const previousItems = checkboxTasks(before);
      const item = previousItems.find(item => !item.checked);
      if (!item) break;
      const attempt = {
        taskNumber: item.taskNumber, task: item.task, completed: false,
        sessionIds: {}, logs: {},
      };
      items.push(attempt);
      const result = await execute({
        task: item.task, mode: 'execute', review: true, taskNumber: item.taskNumber,
        context: `Todo source: ${path}. Complete only this item. Do not edit the todo source; checkbox updates are managed by the list runner.`,
      }, signal);
      attempt.sessionIds = { ...(result?.details?.sessionIds ?? {}) };
      attempt.logs = { ...(result?.details?.logs ?? {}) };
      addUsage(usage, result.usage);
      signal?.throwIfAborted();
      if (result.isError || result.details?.approved !== true ||
          result.details?.reviewStatus === 'skipped' || result.details?.independentApproved === false) throw new Error(result.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') || 'Delegation did not succeed.');
      // No await between the fresh read and write. Update only the safely
      // identified checkbox in the latest text, never a stale source offset.
      const latest = readFileSync(path, 'utf8');
      const current = approvedItem(before, latest, item, previousItems, checkboxTasks(latest));
      // Edited/deleted/ambiguous tasks retain no approval. A fresh iteration
      // executes the latest unchecked task (including revised text) again.
      if (!current) continue;
      if (!current.checked) {
        writeFileSync(path, latest.slice(0, current.offset) + 'x' + latest.slice(current.offset + 1), 'utf8');
      }
      attempt.completed = true;
      completed++;
    }
    return outcome(completed, undefined, usage, items);
  } catch (error) {
    return outcome(completed, String(error?.message ?? error).slice(0, 1000), usage, items);
  } finally { activePaths.delete(key); }
}
