# Pi aggressive task delegation

Interactive task delegation and sequential Markdown task execution with fresh worker sessions and independent review. Requires Node.js 22+ and Pi (native session API verified with `1.0.4`; compatibility with every Pi version is not guaranteed).

Two entry points:

- `/delegate-tasks <task>` keeps the current conversation as Main and delegates smaller tasks into fresh contexts.
- `--delegate-list <path>` processes unchecked Markdown items sequentially, starting fresh for each item.

Fresh contexts isolate conversation history, **not the filesystem or OS permissions**.

## Install and run

```sh
pi install npm:@haseebeqx/pi-aggressive-task-delegation
# Or install for this project only:
# pi install --local npm:@haseebeqx/pi-aggressive-task-delegation
pi --delegate-list tmp/tasks.md
pi --model sonnet:high --delegate-list "path with spaces/tasks.md"
# One-shot, non-interactive (no prompt needed):
pi --print --delegate-list tmp/tasks.md
# Without installing:
pi -e npm:@haseebeqx/pi-aggressive-task-delegation --delegate-list tmp/tasks.md
```

Configure a working Pi model and credentials before running. For non-interactive
lists, use normal SDK auth storage/environment rather than a request-only `--api-key`
override (see [Execution, trust, and privacy](#execution-trust-and-privacy)).

To use the existing conversation instead of a list, start `pi` and enter:

```text
/delegate-tasks Add signup validation and tests, preserving the existing public API
```

Update or remove the installed package with:

```sh
pi update npm:@haseebeqx/pi-aggressive-task-delegation
pi remove npm:@haseebeqx/pi-aggressive-task-delegation
```

The flag is a literal path, not an `@file` reference. It runs once on actual startup,
never on reload or session switching. The interactive `/delegate-tasks <task>`
command and `delegate_task` tool are available with or without the flag.
The command keeps Main as a context-preserving supervisor, delegating smaller
execution tasks sequentially with independent review and scoped read-only discovery.
In interactive mode, each item starts a fresh regular Pi session in the current
window. The item supervisor uses Pi's normal chat, tools, and permissions, with
`delegated task #n` added to the footer. Nested delegation adds its own focused
worker/reviewer/discovery display and input routing (see below). Each item starts through
the same supervisor prompt workflow as `/delegate-tasks`, without carrying over the previous conversation.
Startup dispatches an internal command because Pi only exposes session replacement
to command contexts, not startup lifecycle handlers. Do not supply additional startup
prompts alongside the flag. Session-switch vetoes stop the list.
An item is checked off when its normal agent run settles without an error or abort;
interactive lists do not impose a separate whole-item reviewer gate.
Non-interactive lists retain fresh workers and mandatory independent whole-item review:
items must pass before being checked off. Per-delegation `review:false` does not
bypass this gate; nested delegations may still choose their own review setting.
In non-interactive mode the flag does not start a Main model turn. Do not supply a prompt, file reference, or piped input alongside
the flag: Pi can process those separately after startup.

Each item finishes (and, in non-interactive mode, passes independent review)
before its checkbox is saved and the next starts. Workers recursively delegate useful splits into smaller tasks with fresh sessions;
scoped discovery is available through `delegate_task` with `mode: "discover"`. Items receive only their
own assignment and source path, not prior reports or Main history.

## Delegation tool and interactive controls

`delegate_task` is model-callable; it is not a slash command. `/delegate-tasks`
submits supervisor guidance and your task to Main, which chooses how to split it.
It does not replace the current session or erase its history.

| Parameter | Meaning |
| --- | --- |
| `task` | Required non-empty assignment and acceptance criteria, or factual discovery questions. |
| `mode` | `"execute"` (default) runs a worker, with independent review by default; `"discover"` runs a fact-gatherer without a separate reviewer. |
| `review` | Optional boolean, default `true`. Set `false` to skip independent execution review; ignored for discovery. |
| `context` | Optional relevant paths, constraints, decisions, and concise prior summaries; no history is copied automatically. |

Example tool arguments:

```json
{
  "task": "Identify signup validation entry points and existing malformed-email tests; return evidence and gaps, without edits.",
  "mode": "discover",
  "context": "Focus on src/signup.js and related tests."
}
```

Execution returns the worker report, an independent reviewer report when enabled,
aggregate usage, and transcript log paths. Independent approval requires the
reviewer's trimmed report to begin with `PASS` on its own line; `FAIL` or a malformed
verdict is not approval. With `review:false`, successful worker completion returns
without reviewer calls, logs, usage/cost, or review progress; the report explicitly
says independent review was skipped. Worker failure or cancellation still fails.

Execution metadata distinguishes completion from independent approval:
- `details.approved` is the legacy success gate, **not** proof of independent review.
- `details.completed` is the same successful delegation gate: true after PASS, or
  after successful worker completion with `review:false`; false on failure.
- `details.reviewStatus` is `passed`, `failed`, `skipped`, `not-run` (review never
  reached, e.g. worker failure), or `error` (review interrupted or failed to run).
- `details.independentApproved` is true only for an independent PASS.

Discovery returns findings and log paths, not an independent PASS verdict; its
metadata is unchanged and does not include these new execution-only fields.
Discovery children default to `discover` and cannot delegate execution. Sibling calls are serialized per context;
recursive children have their own queues.

In the TUI, the focused child shows streaming assistant/tool output and uses Pi's
native footer for its session. Typed input (including images) steers the currently
focused child. Normal completion returns focus to its parent; recursive delegation
returns to the immediate parent, not necessarily Main. Delegated display records
are persisted in the parent session for restoration on resume/tree navigation.

**Ctrl+Esc** cancels the focused delegation and returns focus to its immediate
parent. The parent waits for your replacement instruction before continuing; type
what it should do next. This is different from a running `--delegate-list`, where
Ctrl+C or Ctrl+Esc cancels the entire list. Cancellation does not undo edits.

## Supervisor guidance

Main owns goals, cross-task constraints, breakdown, and integration; workers own
implementation choices within their scope. Assignments favor outcomes and acceptance
criteria over prescribed steps, except for concrete constraints or risks. Main must
delegate substantive execution by default, including small self-contained tasks;
it may delegate a single task without a split. Workers MUST delegate whenever at
least two concrete, useful, strictly smaller execution subtasks exist: task size,
ease, or speed are not opt-outs. Genuine leaves execute directly, even when hard.
Never forward a whole worker assignment unchanged or merely reworded, or manufacture
splits to delegate; each recursive execution step must reduce scope.

Discovery is optional, not a prerequisite. When facts are needed, do only lightweight
local orientation, then delegate separable factual questions even for small tasks.
Focused factual leaves allow direct bounded lookups; already-known tasks need no
discovery. Discovery agents MUST delegate whenever useful strictly narrower factual
scopes exist, with no two-subtask threshold or artificial splitting. Focused leaves
use targeted reads/searches directly. Discovery stays read-only and verifies evidence
without a separate reviewer. All delegation is sequential, never parallel.

Independent review defaults to true. Use `review:false` for low-risk, narrow work
with concrete worker verification, or to avoid redundant nested reviews. Retain
review for risky, security-sensitive or broad changes, uncertain verification, or
explicit user requirements. Skipping review never skips worker verification.
Integrate a review-skipped worker report with that limitation; do not call it PASS
or independent approval. Non-interactive task-list whole-item review remains mandatory.

After independent execution review returns PASS, integrate without routinely repeating
exploration, review, or leaf edits; targeted risk/integration checks and new evidence
still matter. Failed review calls for a focused delegated correction, not a success
claim with unresolved failures. These are prompt guidance, not enforced execution
limits. A `delegate_task` review failure returns findings for the caller
to address; it does not itself shut down Main. A failed whole-item review in a
non-interactive list stops that list.

## Task files

Use a regular `.md` or `.markdown` file, relative to the working directory or an
absolute path. Tasks are independent/unrelated; each must be self-contained on one line:

```markdown
- [ ] Add signup validation in src/signup.js and test malformed addresses
- [ ] Fix date formatting in src/calendar.js and test timezone handling
```

Bullets (`-`, `+`, `*`) and numbered items (`1.` or `1)`) are supported; checked
items (`[x]` or `[X]`) and fenced code examples are skipped. The footer's `#n` is
the checkbox item's position, including already checked items, not the number
completed during this run. Continuation lines/headings are not task context.
Empty unchecked items are rejected before work starts. After successful completion,
the runner waits for checkbox persistence before starting
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
lost. Avoid concurrent writes during that brief update window.

## Progress, cancellation, and exit

TUI uses a fresh normal session for each item and shows `delegated task #n`
at the bottom. The status clears on completion or failure; Pi stays open on the
last item's session, with a final notification. Ctrl+C or Ctrl+Esc during execution cancels the list. Non-TUI
output goes to stderr: task labels, tool start/end events, completed assistant text
from workers/reviewers/discovery agents, and final counts/errors. It is not a raw
transcript stream, but can include substantive reports and sensitive information.
JSON/RPC stdout stays protocol-only.
SIGINT and session shutdown abort active work; cancellation does not undo edits.
Print/JSON startup awaits completion and then Pi exits naturally. RPC requests
orderly shutdown after completion. This extension never calls `process.exit()`.
Failure sets `process.exitCode = 1`, cancellation sets `130`. Print/JSON preserve
that status in tested Pi. TUI/RPC host shutdown can override exit status; do not
rely on their exit code for automation. Use print mode instead.

## Execution, trust, and privacy

Agents share the working directory and OS permissions. There is no sandbox,
rollback, branch isolation, or security-enforced read-only boundary. Reviewers are
instructed not to edit. The inherited-tool discovery path blocks tools named
`write`, `edit`, and `apply_patch`, but shell commands and other custom tools can
still mutate the workspace. Read-only guidance is not a security guarantee.

### Host `delegate_task` children (including interactive list items)

- Each child has a fresh conversation and reloads project instructions and skills;
  it does not reload extensions, prompt templates, or themes.
- Selected model and thinking level are passed to the child. Model streaming uses
  the parent's live model registry, including its configured provider and
  request-time credentials.
- Callable parent tools are bridged through `ctx.executeTool`, preserving argument
  validation and parent permission hooks. This includes callable custom/MCP tools
  and tools exposed through codemode or deferred discovery; they are presented
  directly to the child. Parent-only extension tools can therefore be available
  without reloading their extensions or opening new MCP connections. Recursion uses
  a child-local `delegate_task`, not the parent's delegation queue.

Interactive list supervisors use fresh normal host sessions; their delegated
children follow the same rules above.

### Non-interactive list workers and their descendants

These use the standalone SDK executor, not the parent's live tool bridge.

- Selected model and thinking level are passed to each independent session.
  Credentials use normal SDK auth storage/environment; Main registry/runtime
  credentials and request-only `--api-key` overrides are not forwarded.
- Each child loads its own project instructions, skills, normal extensions and
  tool resources, excluding this launcher. Codemode, tool search and MCP factories
  are supplied explicitly, subject to settings. Main tools, permission hooks,
  MCP connections and explicit Main-only `-e` paths are not inherited. Configure
  required extensions in normal settings/discovery. MCP connections can start
  asynchronously. Child permission extensions run through their own SDK pipeline.
- Independent resource discovery follows normal SDK trust rules without interactive
  trust dialogs; saved/global decisions matter. Main-only CLI trust/resource/tool
  overrides are not forwarded. Project trust is not a sandbox.

### Logs and limits

- Decomposition and concise reporting are model instructions, not hard budgets or
  recursion limits. Delegation adds model calls and review costs; there is no fixed
  token, time, or recursion budget. A failed non-interactive whole-item review stops
  the list, with no automatic retry.
- Detailed worker/reviewer/discovery JSONL transcripts persist under
  `<Pi agent directory>/delegation-logs/` (normally `~/.pi/agent/delegation-logs/`). Internal
  delegation reports include log paths; non-interactive launcher output also
  includes completed assistant text and tool event summaries, but not full raw
  JSONL transcripts. Logs may contain sensitive assignments,
  instructions and tool output; they are not automatically deleted. Remove unwanted
  run directories manually. POSIX managed directories/files use `0700`/`0600`,
  not encryption; Windows requires appropriate account ACLs.

## Development

From a checkout with Node.js 22+ and Pi's host peer dependencies available:

```sh
npm install
npm run check
npm test
# Load the checkout for a manual interactive test:
pi -e ./src/extension.js
# Offline startup/protocol smoke test (requires the pi executable):
npm run test:smoke
```

`npm test` covers list parsing/persistence, conflicts and live appends, review gates,
cancellation, tool inheritance, UI focus/transcript handling, and SDK integration.
The offline smoke test is not an end-to-end model execution test. `npm run prepack`
runs syntax checks and the test suite before packaging.

## License

MIT
