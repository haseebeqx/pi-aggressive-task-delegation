import { runListCommand } from './list-command.js';
import { emptyUsage, addUsage } from './workflow.js';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// Intentionally line-based: each checkbox is one self-contained assignment.
function listEntries(text) {
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
      const command = /^!(.*)/.exec(line);
      if (command) {
        const text = command[1].replace(/\r$/, '');
        if (!text.trim()) throw new Error('Shell commands must have non-empty text.');
        tasks.push({ kind: 'command', command: text, text, offset });
      }
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
function checkboxTasks(text) {
  return listEntries(text).filter(item => item.kind !== 'command');
}

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

const outcome = (completed, error, usage, items = [], commands = []) => {
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
  for (const command of commands) {
    lines.push(`Shell [${command.completed ? 'completed' : 'not completed'}]: !${command.command}${command.exitCode != null ? ` (exit ${command.exitCode})` : ''}`);
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    details: { completed, items, ...(commands.length ? { commands } : {}) }, isError: Boolean(error), usage,
  };
};

const activePaths = new Set();

/** Execute and persist approved tasks in order. execute(params, signal) must
 * return a reviewed tool result with details.approved === true on success.
 * Paths are literal (no shell quotes or @ references). Concurrent runs of the
 * same resolved path are rejected; independent files may run concurrently. */
export async function runDelegateList(name, { cwd = process.cwd(), execute, signal, onCommandOutput = ({ text }) => process.stderr.write(text) } = {}) {
  const key = typeof name === 'string' && name.trim() ? resolve(cwd, name) : undefined;
  if (activePaths.has(key)) return outcome(0, 'A delegate-list run is already active.');
  activePaths.add(key);
  let completed = 0;
  const items = [];
  const commands = [];
  let snapshot;
  let consumed = [];
  const usage = emptyUsage();
  try {
    signal?.throwIfAborted();
    if (typeof execute !== 'function') throw new Error('Expected an executor function.');
    if (typeof name !== 'string' || !name.trim()) throw new Error('Expected a task file path.');
    const path = resolve(cwd, name);
    if (!statSync(path).isFile()) throw new Error('Expected a regular file.');
    while (true) {
      signal?.throwIfAborted();
      const before = readFileSync(path, 'utf8');
      const entries = listEntries(before);
      const shellItems = entries.filter(item => item.kind === 'command');
      if (snapshot !== undefined && snapshot !== before) {
        const oldShellItems = listEntries(snapshot).filter(item => item.kind === 'command');
        consumed = consumed.flatMap(original => {
          const old = oldShellItems.filter(item => item.text === original.text);
          const latest = shellItems.filter(item => item.text === original.text);
          if (!latest.length) return [];
          if (old.length !== 1 || latest.length !== 1) {
            throw new Error('Consumed shell command identity is ambiguous after a live edit. Stop and rerun with distinct command lines.');
          }
          return latest;
        });
      }
      snapshot = before;
      const previousItems = entries.filter(item => item.kind !== 'command');
      const item = entries.find(item => item.kind === 'command'
        ? !consumed.some(done => done.offset === item.offset) : !item.checked);
      if (!item) break;
      if (item.kind === 'command') {
        const attempt = { command: item.command, completed: false };
        commands.push(attempt);
        onCommandOutput({ command: item.command, stream: 'label', text: `delegate-list shell: !${item.command}\n` });
        const result = await runListCommand(item.command, { cwd, signal, onOutput: (stream, text) =>
          onCommandOutput({ command: item.command, stream, text }) });
        Object.assign(attempt, result);
        signal?.throwIfAborted();
        if (result.exitCode !== 0) throw new Error(`Shell command failed: !${item.command} (${result.exitCode == null ? result.signal : `exit ${result.exitCode}`})`);
        attempt.completed = true;
        consumed.push(item);
        continue;
      }
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
        const updated = latest.slice(0, current.offset) + 'x' + latest.slice(current.offset + 1);
        writeFileSync(path, updated, 'utf8');
        // Our own checkbox write preserves offsets and command identity.
        if (snapshot === latest) snapshot = updated;
      }
      attempt.completed = true;
      completed++;
    }
    return outcome(completed, undefined, usage, items, commands);
  } catch (error) {
    return outcome(completed, String(error?.message ?? error).slice(0, 1000), usage, items, commands);
  } finally { activePaths.delete(key); }
}
