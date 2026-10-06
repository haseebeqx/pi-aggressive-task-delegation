# Pi aggressive task delegation

CLI-only sequential Markdown task execution with fresh worker sessions and independent review. Requires Node.js 22+ and Pi (tested with `0.99.2`).

## Install and run

```sh
pi install npm:@haseebeqx/pi-aggressive-task-delegation
pi --delegate-list tmp/tasks.md
pi --model sonnet:high --delegate-list "path with spaces/tasks.md"
# One-shot, non-interactive (no prompt needed):
pi --print --delegate-list tmp/tasks.md
# Without installing:
pi -e npm:@haseebeqx/pi-aggressive-task-delegation --delegate-list tmp/tasks.md
```

The flag is a literal path, not an `@file` reference. It runs once on actual startup,
never on reload or session switching. Without the flag this extension does nothing.
There are no public delegation tools or slash commands and no supervisor prompt or
Main model turn. Do not supply a prompt, file reference, or piped input alongside
the flag: Pi can process those separately after startup.

Each item is executed and independently reviewed before its checkbox is saved and
the next starts. Workers may recursively delegate smaller tasks with fresh sessions;
discovery is available internally, not as a launcher tool. Items receive only their
own assignment and source path, not prior reports or Main history.

## Task files

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
lost. Avoid concurrent writes during that brief update window.

## Progress, cancellation, and exit

TUI shows phase notifications and a status containing the final outcome; it stays
open afterward. Ctrl+C or Ctrl+Esc during execution cancels the list. Non-TUI
progress and final counts/errors go to stderr (JSON/RPC stdout stays protocol-only).
SIGINT and session shutdown abort active work; cancellation does not undo edits.
Print/JSON startup awaits completion and then Pi exits naturally. RPC requests
orderly shutdown after completion. This extension never calls `process.exit()`.
Failure sets `process.exitCode = 1`, cancellation sets `130`. Print/JSON preserve
that status in tested Pi. TUI/RPC host shutdown can override exit status; do not
rely on their exit code for automation. Use print mode instead.

## Execution, trust, and privacy

- Agents share the working directory and OS permissions. No sandbox, rollback,
  branch isolation, or security-enforced read-only reviewer/discovery boundary.
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
- Decomposition and concise reporting are model instructions, not hard budgets or
  recursion limits. A failed review stops the list, with no automatic retry.
- Detailed worker/reviewer/discovery JSONL transcripts persist under
  `<Pi agent directory>/delegation-logs/` (normally `~/.pi/agent/`). Internal
  delegation reports include log paths; launcher output is only phases and
  counts/errors, not full transcripts. Logs may contain sensitive assignments,
  instructions and tool output; they are not automatically deleted. Remove unwanted
  run directories manually. POSIX managed directories/files use `0700`/`0600`,
  not encryption; Windows requires appropriate account ACLs.

## License

MIT
