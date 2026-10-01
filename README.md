# Pi aggressive task delegation

A Pi extension that keeps the supervisor's context focused by delegating work
and independent review to fresh agent sessions. Delegation runs sequentially,
including recursive subtasks.

## Install

Requires Node.js 22+ and Pi. Tested with Pi `0.99.2`.

```sh
pi install npm:@haseebeqx/pi-aggressive-task-delegation
```

To try it without installing:

```sh
pi -e npm:@haseebeqx/pi-aggressive-task-delegation
```

## Usage

In Pi:

```text
/delegate-tasks Implement validation for the signup form and add tests
```

The supervisor splits divisible work into smaller tasks in dependency order.
Indivisible tasks are executed directly. Each delegated task runs in a fresh
worker session, followed by a separate reviewer that returns `PASS` or `FAIL`.
Workers can delegate smaller subtasks recursively.

Only concise reports, review findings, usage, and transcript log paths return
to the caller—not the full child histories. Failed reviews are reported as
errors; the supervisor is instructed to request focused corrections, with no
automatic retry loop.

The agent can also call `delegate_task` directly:

```json
{
  "task": "Add email validation and tests; reject malformed addresses",
  "context": "Relevant files: src/signup.js, test/signup.test.js. Preserve the existing API."
}
```

## Live delegated sessions

In interactive Pi, a live panel identifies the focused worker/reviewer and its
parent chain. Assistant responses use Pi's normal Markdown, code highlighting,
and thinking formatting; tool calls and output use Pi's native tool panels.
An orange **Delegated task** indicator appears below the input area while a
worker or reviewer is focused. The panel does not show token or cost stats.
Pi's native footer temporarily shows the focused worker/reviewer's token counts,
cost, context usage, and model. It follows recursive delegation and returns to
the supervisor's footer when focus returns to Main or delegation ends. Usage
updates after completed responses, not as exact streaming token counts. Aggregate
usage is still returned in tool results and included in Pi's supervisor totals.
This temporarily replaces any other extension's custom footer; afterward Pi's
built-in footer is restored.
Full transcripts stay in the child logs rather than entering the supervisor's context.

While a child is visible, ordinary input (including image attachments) steers
that session at its next turn boundary, not the main supervisor. Recursive
children have their own parent: `Main → Worker A → Worker B`.

Use **Ctrl+Esc** to cancel the visible delegation and its descendants.
Focus and input return to the immediate parent (B → A, not B → Main).
The parent waits at the delegation boundary and the panel asks what it should do
instead. Your next instruction is queued to that parent before it continues.
Cancelling a worker also skips its review. Cancellation does **not** undo edits.

The live panel is a bounded recent-output view, not a full interactive replacement
for Pi's session transcript. Slash commands and shell escapes remain Pi controls;
ordinary submitted messages are routed to the focused session. Non-interactive
runs still return the usual concise reports, usage, and log paths.

## Execution and privacy

- All agents share the working directory. Changes take effect immediately;
  there is no sandbox, rollback, or branch isolation. Reviewers are instructed
  not to modify files; their tool access is not a read-only security boundary.
- Workers and reviewers inherit the tools listed in the supervisor's Pi tool
  context: active `direct` tools and registered `deferred`/`codemode` tools,
  including extension web/search and connected MCP tools with those exposures.
  Deferred/codemode tools are exposed directly in children. `delegate_task` is
  replaced with a child-local instance so recursion keeps fresh contexts.
- Workers use the supervisor's selected model, thinking level, and provider
  credentials. Child sessions load project instructions and skills. Other
  extensions are not reloaded: inherited tools run through the supervisor's live
  runtime, preserving its tool validation, permission hooks, credentials and MCP
  connections without restarting extension UI or lifecycle handlers.
- Inheritance uses Pi's public `ctx.tools` / `ctx.executeTool` API (tested with
  `0.99.2`). `hidden`, inactive `direct`, and `model-only` tools are excluded from
  `ctx.tools` and cannot be forwarded through `ctx.executeTool`, even when a
  `model-only` tool is active. `pi.getAllTools()` provides metadata, not an
  executable hook-preserving alternative. Calling a raw tool definition's
  `execute()` would bypass the supervisor's validation and tool hooks, so this
  extension does not use that workaround. `delegate_task` is supplied locally,
  not forwarded. The tool snapshot is taken when each child starts; later
  registrations are not added to an already-running child. Supervisor exposure
  changes/withdrawals still apply to forwarded calls. Tool-specific session state, UI and nested tool execution
  remain supervisor-bound, not isolated child state. Tools that change the
  supervisor's active loadout do not change an existing child's declarations.
  General supervisor event handlers are not installed in children; tool hooks
  apply to forwarded calls, not child-local delegation. Nested tool usage is
  counted by Pi in the supervisor rather than again in child reports/footer.
- Task decomposition and report brevity are model instructions, not enforced
  limits. There is no hard recursion, budget, or retry limit.
- Worker and reviewer transcripts persist under
  `<Pi agent directory>/delegation-logs/` (normally `~/.pi/agent/`). Tool results
  include their paths in text and `details.logs` for on-demand inspection.
- Logs may contain sensitive assignments, instructions, messages, and tool
  results. They are not automatically deleted. Remove unwanted run directories
  manually. Managed directories and files use owner-only permissions on POSIX
  (`0700`/`0600`); this is not encryption. Windows requires appropriate account
  ACLs.

## License

MIT
