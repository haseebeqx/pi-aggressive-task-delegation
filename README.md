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

### Procedural todo lists

```text
/delegate-list tasks.md
/delegate-list "path with spaces/tasks.md"
```

The agent can invoke the same runner with `delegate_list({ "path": "tasks.md" })`.
The path is required. The tool returns a compact completion/error outcome and
accepts cancellation from its calling turn; it never waits for Main to become idle.

Both entry points directly delegate each unchecked Markdown task in file order—no
supervisor model turn or automatic task splitting by Main. Each item uses the
existing fresh worker + independent reviewer workflow (including recursive
worker delegation). Only the item's text and source path are passed; prior
reports and parent conversation history are not forwarded.

Use a regular `.md` or `.markdown` file, relative to the working directory or an
absolute path. Tasks are independent/unrelated; each must be self-contained on one line:

```markdown
- [ ] Add signup validation in src/signup.js and test malformed addresses
- [ ] Fix date formatting in src/calendar.js and test timezone handling
```

Bullets (`-`, `+`, `*`) and numbered items are supported; checked items and fenced
code examples are skipped. Continuation lines/headings are not task context.
Empty unchecked items are rejected before work starts. After a successful review,
the runner waits for reviewed success and checkbox persistence before starting
the next item. Only that checkbox's space changes to `x`; formatting and line endings remain
unchanged. Failure, cancellation, or file conflicts stop the list with remaining
items unchecked. There are no automatic retries or rollback of worker edits.
Rerun the command to resume unchecked items.

You may append tasks while the runner is active, including while its last item is
in flight. The file is reread before execution and marking; append-only additions
are preserved when checking off the current item and discovered sequentially.
If the file has no final newline, begin the appended content with a newline
(`LF` or `CRLF`) rather than extending the existing line. Changes to any existing
text (including checkboxes), truncation, or unsafe line-extending appends cause an
explicit conflict without overwriting edits; even a successful item remains
unchecked on conflict. The runner finishes as soon as a fresh read finds no
unchecked tasks; it does not wait for future additions. Additions after that
completion cutoff require another run. File updates are not protected by filesystem
locking: an external write between the runner's read and checkbox write could be
lost. Avoid concurrent writes during that brief update window. A shared tool/command guard allows only one list run
to be active. Ctrl+Esc cancels a focused list item without waiting for a replacement
instruction or sending a message to Main. `/delegate-tasks` remains unchanged.
Command outcomes are UI notifications, not messages injected into Main's context;
tool outcomes contain only completion counts or a bounded error, not item summaries;
child transcripts retain detailed output.

### Optional discovery

Discovery is not a required phase before execution. For small or well-understood
tasks, supervisors and workers can use bounded local reads as needed and proceed
directly without a discovery delegation. Substantial fact gathering is still
offloaded to keep broad exploration out of their context.

`delegate_task` accepts optional `mode: "execute" | "discover"` (default:
`"execute"`). Main can gather initial information through discovery without a
predefined task breakdown or prerequisite split, then retain all decisions about
approach and execution:

```json
{
  "mode": "discover",
  "task": "Investigate signup validation: relevant code, behavior, tests, constraints, and applicable external API documentation",
  "context": "Gather facts and unknowns only; Main will decide what to change."
}
```

Discovery uses a fresh discovery agent that verifies evidence as part of discovery,
without a separate reviewer.
It gathers comprehensive information within the requested scope and returns compact
findings linked to files/symbols/lines or external URLs/passages, plus coverage,
unknowns and gaps. It does not implement, impose a plan, or prescribe a task split.
The discovery agent checks scope, coverage and evidence, including targeted checks
of child findings, and reports verification actually performed. No `PASS`/`FAIL`
verdict is required; disclosed unknowns do not make discovery fail. Main decides
whether gaps require further investigation.
Supervisors and workers offload substantial fact gathering instead of filling their
own context with broad exploration. Discovery agents do lightweight
orientation, then aggressively delegate broad, multi-area, or large-output searches
and evidence checks into strictly narrower factual scopes. Focused leaves use bounded
searches and targeted reads directly; recursion must not forward the same assignment
or create artificial splits. Child calls default to `discover`, and explicitly
switching to `execute` is rejected before agents run.
Discovery reports aim for about 300 words (a soft target), preserving decision-relevant
evidence and explicit gaps. Parents integrate findings without repeating exploration;
missing details prompt focused follow-up discovery rather than loading full transcripts.
These are prompt-level instructions, not enforced context limits or delegation quotas.
Reports need no new artifacts: existing transcript paths preserve detailed evidence.
Sequential runs, cancellation, usage accounting and the live UI work as in execution.

**Read-only policy is not a sandbox.** Discovery agents are
instructed not to mutate files or external state. Direct inherited tools named
`write`, `edit`, and `apply_patch` are blocked before forwarding. Shell remains
available for exploration (`ls`, `rg`, `find`, etc.); arbitrary shell commands and
inherited custom/MCP tools cannot be safely classified generically and remain
prompt-enforced read-only. Aliases, tool orchestrators and nested calls may bypass
the name guard. Do not treat it as a security boundary; use supervisor permission
hooks or an OS sandbox for untrusted tools. Avoid installs and tests that write
caches/artifacts during discovery. Pi still persists its ordinary transcript logs.

## Live delegated sessions

In interactive Pi, a live panel identifies the focused worker/reviewer and its
parent chain. Assistant responses use Pi's normal Markdown, code highlighting,
and thinking formatting. Built-in tool calls and output use Pi's native renderers,
including syntax-highlighted reads/writes and colored edit diffs. Other inherited
tools use Pi's generic tool panel: the public tool bridge does not expose their
custom renderers.
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
- Worker, reviewer and discovery transcripts persist under
  `<Pi agent directory>/delegation-logs/` (normally `~/.pi/agent/`). Tool results
  include their paths in text and `details.logs` for on-demand inspection.
- Logs may contain sensitive assignments, instructions, messages, and tool
  results. They are not automatically deleted. Remove unwanted run directories
  manually. Managed directories and files use owner-only permissions on POSIX
  (`0700`/`0600`); this is not encryption. Windows requires appropriate account
  ACLs.

## License

MIT
