# Pi aggressive task delegation

Interactive task delegation and sequential Markdown task execution with fresh worker sessions and independent review. Requires Node.js 22+ and Pi (native session API verified with `1.0.4`; compatibility with every Pi version is not guaranteed).

Two entry points:

- `/delegate-tasks <task>` keeps the current conversation as Main and routes substantive work to fresh workers after brief bounded orientation.
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
The command keeps Main in the current context and delegates substantive implementation
or context-heavy investigation by default after brief bounded orientation. Trivial
localized edits and cheap lookups may stay local.
Delegated execution has independent review by default; scoped read-only discovery is optional.
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
before its checkbox is saved and the next starts. Workers execute directly by default,
using recursive delegation only for a substantial, strictly smaller context-isolated scope;
scoped discovery is available through `delegate_task` with `mode: "discover"`. Items receive only their
own assignment and source path, not prior reports or Main history.

## Delegation tool and interactive controls

`delegate_task` is model-callable; it is not a slash command. `/delegate-tasks`
submits the Main routing policy and your task. Main delegates substantive scopes by
default; trivial local work is exempt. The always-present tool description carries
this role-specific policy even for ordinary prompts without the command.
It does not replace the current session or erase its history.

| Parameter | Meaning |
| --- | --- |
| `task` | Required non-empty assignment and acceptance criteria, or factual discovery questions. |
| `mode` | `"execute"` (default) runs a worker, with independent review by default; `"discover"` runs a fact-gatherer without a separate reviewer. |
| `review` | Optional boolean, default `true`. Set `false` to skip independent execution review; ignored for discovery. |
| `context` | Optional relevant paths, user/project requirements, decisions, and concise verified worker reports; no history is copied automatically. |

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

User requirements take precedence over this extension's prompt guidance when they
conflict, including workflow, scope, methods, and output format. Relevant requirements
must be carried into every child assignment, not silently dropped or reinterpreted.
This applies to Main, workers, discovery agents, and reviewers. Platform safety rules
and hard tool constraints still apply; agents must explain conflicts they cannot satisfy.
For example, prompt guidance cannot bypass the non-interactive whole-item review gate
or make discovery tools permit blocked writes.

Main **delegates substantive implementation or context-heavy investigation by default**
after brief bounded orientation: read applicable project instructions and only enough
targeted files to route the task. Observable triggers are a multi-file change,
meaningful implementation plus tests, or broad investigation. Hand off before broad
exploration or implementation; do not solve the task before delegation. Main may
assign the whole cohesive scope without manufacturing subtasks. Trivial localized
edits, cheap lookups, and focused questions may stay local; knowing how to do a
substantive task is not an exemption. Do not delegate trivial work just to add calls.
Honor explicit user **and applicable project/AGENTS.md delegation requirements**,
including restrictions on using workers, and propagate them to every child.

Main owns goals, cross-task constraints, breakdown, and integration; workers own
implementation choices within scope. Pass concise outcomes, acceptance criteria,
relevant paths, user/project requirements, decisions, and verified prior worker
reports—not transcripts. Favor outcomes over prescribed steps except for concrete
constraints or risks. Workers **execute their assignment directly**, including
multi-step work. Recursive delegation is exceptional: only a substantial, strictly
smaller context-isolated scope may justify it. Workers must not forward the whole
assignment unchanged or reworded, manufacture splits, or create supervisor chains.
The Main whole-scope handoff is not this prohibited child forwarding.

Discovery is optional, not a prerequisite. Main's initial reads/searches are bounded
routing or cheap fact checks, not broad exploration before handoff. Use discovery
for substantial bounded investigations benefiting from context isolation; use execution
directly when implementation is ready to assign. Discovery agents gather facts directly
and stop when their questions are answered. They stay read-only and verify evidence
without a separate reviewer; recursive discovery requires a substantial strictly
narrower factual scope and cannot delegate execution. All calls are sequential,
in dependency order when needed, never parallel.

Independent review defaults to true. Use `review:false` for low-risk, narrow work
with concrete worker verification, or to avoid redundant nested reviews. Retain
review for risky, security-sensitive or broad changes, uncertain verification, or
explicit user requirements. Skipping review never skips worker verification.
Integrate a review-skipped worker report with that limitation; do not call it PASS
or independent approval. Non-interactive task-list whole-item review remains mandatory.

After independent execution review returns PASS, integrate without routinely repeating
exploration, review, or leaf edits; targeted risk/integration checks and new evidence
still matter. Fix narrow review failures directly; delegate substantial remaining work using the
role-specific routing policy. Never claim success with unresolved failures. These are prompt guidance, not enforced execution
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

### Shell setup and teardown

Plain lines starting with `!` in column one execute the remaining text as a shell
command, sequentially among checkbox tasks, in **Pi's working directory** (not
necessarily the task file's directory). No bullet or dot is needed:

```markdown
!start-server
- [ ] Test the signup page against the running server and fix validation
!stop-server
```

Commands are not model assignments, do not start sessions, and never go through
AI review. The existing checkbox review rules still apply. Only column-one `!`
lines outside fenced code blocks run; `- [ ] !something` is still an AI task.
Empty command lines are rejected before work starts.

A foreground command must exit before the next entry starts. For a long-running
server, background it and redirect **all standard streams**, save its PID, and
wait for readiness in the setup command. For example, on POSIX shells:

```markdown
!npm run dev </dev/null >.delegate-server.log 2>&1 & echo $! >.delegate-server.pid
!n=0; until curl -fsS http://localhost:3000/ >/dev/null; do n=$((n+1)); [ "$n" -lt 30 ] || exit 1; sleep 1; done
- [ ] Verify and fix signup validation using http://localhost:3000
!kill "$(cat .delegate-server.pid)" && rm .delegate-server.pid
```

Use a server-specific stop command if its launcher spawns subprocesses; killing
an npm launcher PID may not stop its server. Each line gets a new shell (`/bin/sh`
on POSIX, the default Node shell on Windows), inherited environment, and closed
stdin. `cd`/`export` do not carry over to other lines; use files or combine operations
on one line. `&` alone is insufficient if background processes keep output pipes open.

Stdout and stderr stream to TUI notifications or the non-interactive stderr sink
(including JSON/RPC; stdout stays protocol-only). Command labels and exit statuses
appear in the final summary; command output is not passed to models or stored in
AI transcript logs. Output may contain secrets. There is no output buffer or timeout.
A nonzero exit, spawn failure, or cancellation stops the list immediately: later
commands, **including teardown**, do not run. There is no rollback or automatic
cleanup; stop background services manually after failure. Cancellation sends TERM
then, if still running after one second, KILL to the foreground process group on
POSIX (the direct shell on Windows); detached services are your responsibility.

Command consumption is **in memory for this run only**; shell lines are never
modified. Every new invocation reruns all commands, even around already-checked
tasks. Make setup/teardown idempotent. Within a run, unchanged duplicate command
lines each execute once. Live edits are reread before choosing the next entry:
unique unchanged consumed commands follow shifts/reordering; new or revised lines
run in current source order. Deleted consumed lines lose their identity. If an
external edit makes a consumed duplicate ambiguous, the list stops rather than
risk rerunning side effects or skipping a new command. Use distinct command text
for live-editable lists. Checkbox identity/persistence rules below are unchanged.

**Trusted shell input only:** running a list executes its `!` lines directly with
your OS permissions, without confirmation, model review, sandboxing, or Pi tool
permission hooks. Trust the entire file and anyone who can edit it while running.

Bullets (`-`, `+`, `*`) and numbered items (`1.` or `1)`) are supported; checked
items (`[x]` or `[X]`) and fenced code examples are skipped. The footer's `#n` is
the checkbox item's position, including already checked items, not the number
completed during this run. Continuation lines/headings are not task context.
Empty unchecked items are rejected before work starts. After successful completion,
the runner waits for checkbox persistence before starting
the next item. Only that checkbox's space changes to `x`; formatting and line endings remain
unchanged. Failure or cancellation stops the list with remaining
items unchecked. There are no automatic retries or rollback of worker edits.
Rerun the command to resume unchecked items.

You may insert tasks anywhere, edit pending or completed items, reorder or delete
items, and change checkboxes while the runner is active. The file is reread before
choosing each task and before marking approved work; latest external text and line
endings are preserved. Checking an item externally skips it; unchecking a completed
item queues it again.

An in-flight task is marked only if its exact task text is unchanged and can be
safely identified in the latest file, even after shifts or reordering. Editing or
deleting that task leaves the latest file untouched; the runner continues with the
latest unchecked tasks, so revised text must execute and pass independent review
again. Duplicate task text is ambiguous across edits: the runner leaves that
approval unmarked rather than checking an unrelated occurrence, then executes the
latest unchecked items afresh. Unchanged duplicate lists are processed normally.
Use distinct self-contained task descriptions to avoid redundant execution.

The runner finishes as soon as a fresh read finds no unchecked tasks or unconsumed commands; it does not
wait for future additions. Additions after that completion cutoff require another
run. File updates are not protected by filesystem locking: an external write
between the runner's read and checkbox write could be lost. Avoid concurrent writes
during that brief update window.

## Progress, cancellation, and exit

TUI uses a fresh normal session for each item and shows `delegated task #n`
at the bottom. The status clears on completion or failure; Pi stays open on the
last item's session, with a final notification. Final list output associates available
session IDs and transcript log paths with each attempted task, including failed or
cancelled tasks. Interactive output includes the supervisor ID and child metadata
from `delegate_task` results, labelled by call number and tool-call ID when available;
use these real session IDs to inspect tool calls manually. Missing IDs are omitted.
Ctrl+C or Ctrl+Esc during execution cancels the list. Non-TUI
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

`npm test` covers list parsing/persistence, live editing and duplicate safety, review gates,
cancellation, tool inheritance, UI focus/transcript handling, and SDK integration.
The offline smoke test is not an end-to-end model execution test. `npm run prepack`
runs syntax checks and the test suite before packaging.

## License

MIT
