# Pi aggressive task delegation

A Pi extension that keeps the supervisor's context focused by delegating work
and independent review to fresh agent sessions. Delegation runs sequentially,
including recursive subtasks.

## Install

Requires Node.js 22+ and Pi. Tested with Pi `0.99.1`.

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
/divide Implement validation for the signup form and add tests
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
parent chain. It shows recent assistant text and tool activity, plus completed
response usage (input/output/cache tokens and estimated cost). Streaming token
counts are not exact; usage updates when responses finish. Full transcripts stay
in the child logs rather than entering the supervisor's context.

While a child is visible, ordinary input (including image attachments) steers
that session at its next turn boundary, not the main supervisor. Recursive
children have their own parent: `Main → Worker A → Worker B`.

Use **Ctrl+Esc** or **`/delegate-cancel`** to cancel the visible delegation and
its descendants. Some terminals cannot distinguish Ctrl+Esc; use the command
there. Focus and input return to the immediate parent (B → A, not B → Main).
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
  not to modify files, but have access to `bash` for verification.
- Workers use the supervisor's selected model, thinking level, and provider
  credentials. Child sessions load project instructions and skills, but no
  other extensions.
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
