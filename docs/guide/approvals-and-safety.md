# Approvals & Safety

Browser input and research use separate, structured approvals. Generic Allow All, terminal
auto-approval and loop reviewers cannot grant browser input or domain access. See
[Browser & Research](browser-research.md) for exact-value review, explicit reviewer delegation,
domain policy, privacy and the public-rendering limitation.

An agent that can edit files and run commands is a genuinely powerful thing to point at a
repository. This page is the honest account of where the limits are, who enforces them, and what
you are trusting.

Read it before you turn off a gate.

In plain language: the model can propose an action, but the extension decides whether that action is
allowed and when you must approve it. You do not need security terminology to follow this page;
each gate is described by what you will actually see in VS Code.

---

## The one structural fact

**The model cannot do anything.** It produces text. When it wants to act, it emits a structured
request — a tool name and some arguments — and Blacksite decides whether and how to honour it.

Everything below is a decision made by the extension in that gap, not by the model's judgement.
This is also why "the AI deleted my files" is always a harness bug: the harness chose to run the
command.

---

## Gate 1: file edits

Every edit the agent makes is shown as a **diff before it touches disk.** You approve, reject, or
open the full preview.

This applies to the whole editing surface — whole-file writes, surgical text edits, batch edits,
JSON pointer edits, and the language-server-targeted `code_insert` / `code_replace` / `code_rename`
tools. There is no path that writes a file without passing through it.

After an approved edit, diagnostics are collected and fed back into the loop, so the agent learns
immediately if it broke something.

---

## Gate 2: sensitive commands

Terminal commands are classified into tiers, and the sensitive ones raise a **modal prompt** naming
the tool and the exact operation:

| Tier | Meaning |
| --- | --- |
| **file-write** | The command writes to the filesystem |
| **network** | The command reaches the network |
| **destructive** | The command removes or overwrites something |

Your options:

- **Allow** — this one call.
- **Allow all this turn** — this call, and later operations of the *same kind and tier*, until
  the current turn ends. The kinds are file edits, terminal commands, external service
  mutations, and Execution Run sequences, and each tier (file-write, network, destructive) is
  separate. So allowing all network commands does not allow a destructive one, and allowing all
  edits never allows a command. For a command Blacksite does not recognize, the grant covers
  repeat runs of that same executable only. Nothing carries over to your next message.
- **Deny** — refuse; the agent gets the refusal and continues.

Approval is always granted by the extension. The model cannot mark its own call as approved:
the approval flag is set by the host after you answer, and one supplied in a tool call is
discarded.

In chat Auto mode, reviewable calls from one assistant tool batch are grouped by tool. Distinct
groups are reviewed concurrently, with one decision recorded for each call. A batch decision
applies only to that call; the runtime still checks its actual approval tier before it runs.
Routine workspace edits that Auto mode can settle by fixed rules do not need a model review.

Choosing to always allow a command persists its **binary** to `blacksite.permissions.autoApprove`,
so it stops asking in this project. Note that this is per binary, not per command line: allowing
`git` allows every `git` invocation, not just the one you approved.

### Ticket Loops: approvals while you are away

Ticket Loop lanes do not open an approval prompt and wait for you. Every gated operation is sent
to a separate, no-tools continuation reviewer with the ticket title, description, acceptance
criteria, declared territory, and the user's original request.

- Routine workspace file creation and edits that are scoped, required, and reversible are normally
  approved automatically.
- Destructive, credential-bearing, irreversible, external, ambiguous, or out-of-scope actions are
  denied.
- A denial moves that ticket to `blocked`, records the rationale in the loop lane and ticket
  history, frees its worker slot, and lets the loop begin the next safe ticket.
- Reviewer failure or unreadable output fails closed by blocking the ticket. It never becomes
  implied permission and never halts unrelated lanes.

The Loops workbench shows these decisions inline with each subagent's tool activity. Releasing a
blocked ticket is an explicit user action after inspection; a loop never writes a permanent
`allow_always` permission.

---

## The three lists

Three settings shape what happens before a prompt is ever shown. All are resource-scoped, so they
can differ per workspace — but because a repository can ship its own `.vscode/settings.json`, a
workspace file can only tighten the policy on its own:

- `deniedCommands` and `allowedCommands` apply from any scope. A deny only restricts, and an
  allowed binary still gets the code-execution prompt unless it is also auto-approved.
- `autoApprove` entries in your **user** settings apply as written. Entries in a **workspace**
  file apply only after you choose **Always allow → This project** for that binary on this
  machine; that confirmation is stored locally, never in the repository. A cloned repository that
  lists `autoApprove` entries therefore cannot pre-approve anything for you.
- `allowEvalFlags` is read from user settings only.

```jsonc
{
  // Extra binaries the agent may run, on top of the built-in allowlist.
  "blacksite.permissions.allowedCommands": ["docker-compose", "just"],

  // Binaries the agent may never run. Wins over everything.
  "blacksite.permissions.deniedCommands": ["curl", "ssh", "aws"],

  // Binaries whose sensitive operations skip the prompt.
  "blacksite.permissions.autoApprove": ["git", "npm"]
}
```

**Precedence: deny wins.** A binary in `deniedCommands` cannot be rescued by the allowlist or by
auto-approve. Use it for anything you never want executed unattended — outbound network tools,
credential-bearing CLIs, deployment commands.

**Auto-approve is a real trade.** Adding `git` means `git push --force` no longer prompts. Adding
`npm` means `npm publish` no longer prompts. Both are reasonable for some workflows and reckless for
others. Decide deliberately rather than by clicking "always allow" when you are in a hurry.

A defensible starting point for most projects:

```jsonc
{
  "blacksite.permissions.deniedCommands": ["ssh", "scp", "aws", "gcloud", "kubectl"],
  "blacksite.permissions.autoApprove": ["npm", "node"]
}
```

---

## The eval-flag exception

`blacksite.permissions.allowEvalFlags` is off by default and should usually stay off.

Inline-eval arguments — `node -e`, `python -c`, `ruby -e`, and friends — let a command line carry
arbitrary code. That routes around command-level gating entirely: the shell cannot distinguish
`node build.js` from `node -e "<anything at all>"`, so allowing `node` while allowing eval flags is
effectively allowing arbitrary execution.

Blacksite blocks those flags by default for that reason. Enabling the setting is a considered choice
to accept arbitrary code execution from the agent, and it is labelled that way in the settings UI.

---

## Reading outside the workspace

Globally installed software lives outside your project: Python and its standard library, packages
in `site-packages`, a global `node_modules`, SDKs. The agent can use it:

- **Installed toolchains are readable without asking.** These are the directories on your
  `PATH`, plus the library folders of the installs they belong to (for example `Lib` and
  `site-packages` next to `python.exe`, or `lib` beside a `bin` folder). File reads, searches
  and listings work there directly. So do read-only commands such as `cat`, `ls` or `rg`, and
  "go to definition" into library code.
- **Anywhere else outside the workspace asks first.** Reading a file you mention elsewhere on disk,
  or a command whose argument points outside the project, is shown to you with the exact path
  before it happens.
- **Writing outside the workspace is never allowed.** This applies to toolchains too, so the agent
  cannot modify an installed interpreter or package.

Never treated as a toolchain: your home directory as a whole, other projects, a service's
`etc`/`var` folders, user data such as `~/.local/share`, and credential stores (`.ssh`, `.aws`,
`.docker`, `.kube` and similar), even when one sits inside an install folder.

Two settings adjust this, both in the settings reference:

- `blacksite.permissions.readToolchains` turns the automatic toolchain access off. Any settings
  file can turn it off.
- `blacksite.permissions.readableRoots` adds folders of your own, such as `~/.pyenv/versions`.
  It is read from user settings only.

---

## Databases: reads and writes are different

The agent **cannot execute a write against your database.** It can classify one — `db_preview_write_query`
returns whether a statement is a write or destructive and what confirmation it needs — and surface
that to you. Executing it is your action, in the Query tab.

Read queries (`SELECT`, `WITH`, `EXPLAIN`, read `PRAGMA`) run directly, and are capped by
`blacksite.data.maxQueryRows`.

---

## The browser

The agent's browser runs **headed by default**. You can see the page, watch the clicks, and close
the window.

`blacksite.browserHeadless` hides it. That is convenient for automated runs and worse for oversight
— an agent driving a browser invisibly is an agent you cannot correct mid-action. Prefer headed
unless you have a reason.

`browser_evaluate` and `browser_run_script` execute JavaScript in the page. If you have the agent
navigate to an authenticated application, it is acting as you, with your session.

---

## MCP servers are third parties

Tools from connected MCP servers are subject to the same approval gates as built-in ones — but the
server itself is code you did not write, running in your loop, seeing whatever you pass it.

Extend an MCP server the trust you would extend to a dependency you install. Prefer stdio servers
you can read over remote HTTP ones you cannot.

How MCP approvals work:

- **Each call asks**, naming the server and the tool. **Allow all this turn** covers further calls
  of that one tool on that one server until the turn ends. It does not cover other tools, other
  servers, or network shell commands such as `git push`.
- **Always allow** on the approval card (or the **Ask / Always** control beside a tool in **Manage
  MCP Servers**) runs that tool without asking from then on, in every project. Switch it back in the
  same place.
- **Run tools the server marks read-only without asking** is a per-server switch. The read-only
  label comes from the server itself, so turn it on only for a server you trust to label its tools
  honestly.
- A tool the server marks **destructive** is gated as a destructive operation, and auto mode never
  approves it on its own.
- Listing a server's tools or resources is not gated: it sends only the request, and Blacksite
  lists enabled servers in the background anyway so the agent knows what each one offers.

**Importing servers** (**Blacksite: Import MCP Servers…**) reads other clients' config files,
including a repository's `.vscode/mcp.json` and `.mcp.json`. Nothing found there is added on its
own: every server is shown with its full command line or URL, and only the ones you pick are added.
Credentials found in those files (environment variables and headers that look like tokens or keys)
are moved into `SecretStorage` rather than copied into settings.

---

## What leaves your machine

This is the part worth being precise about, because Blacksite's whole point is sending your code to
a model.

**Goes to your configured provider:**

- Your messages, and the conversation history.
- Workspace context relevant to the request: files, selections, diagnostics, terminal output.
- Whatever a tool call retrieves — file contents the agent read, command output, query results.
- Your enabled Base Context topics, on every request.

**Goes nowhere else:**

- There is no Blacksite server. Requests go from your machine directly to the provider's API.
- No telemetry is collected. Not usage, not errors, not anonymized metrics.

**Stays local:**

- The codebase index and map.
- Plans, base context, map notes, agent memory.
- Execution logs.
- The embedded database and vector store.
- Attached reference files.

**Your keys:** in VS Code's `SecretStorage` (your OS keychain). Never in settings, never in logs,
never in the workspace.

### The part you have to check yourself

Your provider's data-retention and training policies apply to everything Blacksite sends them.
Blacksite cannot change that and does not try to. If you are working under a confidentiality
obligation, read your provider's terms and configure your account accordingly — that is the layer
where those controls exist.

---

## Lifecycle hooks

Hooks run your own scripts at fixed points in the agent lifecycle. Manage them on the Hooks
page (**Blacksite: Manage Hooks**, or **Hooks** in the view switcher): it lists every hook by
event with whether its program can be found, adds and edits them, sets their order, runs one
once with a sample payload so you can see what the agent would do, and shows recent runs. It
also lists any entry the agent would reject, with the reason, so you can fix or remove it.

The page writes the `blacksite.hooks.commands` setting in your **user** Settings JSON, which
you can also edit by hand. Workspace settings cannot register scripts, and hooks run only in
trusted workspaces. They apply to normal chat, continued runs, and delegated lanes.

```json
"blacksite.hooks.commands": [
  {
    "event": "PreToolUse",
    "command": "node",
    "args": ["/absolute/path/to/check-path.mjs"],
    "tools": ["file_write", "file_edit", "file_delete"],
    "timeoutMs": 5000
  },
  {
    "event": "PostToolUse",
    "command": "npx",
    "args": ["prettier", "--check", "src"],
    "tools": ["file_*"]
  }
]
```

If a hook seems to do nothing, run **Blacksite: Check Lifecycle Hooks** from the command
palette. It lists every entry, where each command was found (or that it was not), and any
mistake in the setting, without running a script. Every hook that runs is also logged in the
**Blacksite Hooks** output channel with its event, tool, exit status and duration, but never
the data it was given, so a hook that works leaves a trace too.

### Starting the program

`command` is an executable name or path, with literal arguments: no shell expands them.
Names are looked up on your `PATH`, and use a script's interpreter, not the script:
`node`, `python`, or `pwsh` with `-NoProfile -File` and the script path in `args`. Use an
absolute script path, and escape backslashes in Windows JSON paths.

On Windows, `npm`, `npx`, `prettier`, `eslint` and other `.cmd` and `.bat` programs work
by name. They are found through `PATH` and `PATHEXT` and run through `cmd.exe`, with each
argument quoted. Arguments for a `.cmd` or `.bat` program cannot contain a double quote, a
percent sign or a line break; use `node` or `pwsh` to run the script yourself instead.
A bare name is never taken from the workspace folder. Scripts run with the workspace as their
working directory and inherit the host environment, plus `BLACKSITE_HOOK_EVENT`,
`BLACKSITE_SESSION_ID`, `BLACKSITE_WORKSPACE` and, for tool events, `BLACKSITE_TOOL_NAME`.

### Events

| Event | When it runs | What a failure does |
| --- | --- | --- |
| `UserPromptSubmit` | Before a user submission enters the model conversation. Internal continuations and delegated task instructions do not count as user submissions. | Blocks the submission. |
| `PreToolUse` | After tool validation, before dispatch, including parallel delegation. | Blocks the tool, even with Allow All. The model receives the reason. |
| `PostToolUse` | After dispatch returns, including failed results, before diagnostics and edit after-snapshots. Calls rejected by validation or pre-hooks do not dispatch and do not trigger this event. | Warns in the transcript; does not undo the tool. Exit status 2 also tells the model (below). |
| `Stop` | Once per run when it finishes, fails, or is cancelled. | Warns in the transcript while it is open. Exit status 2 sends the agent back to work (below). |
| `Notification` | When the agent stops to wait for you: an approval card or a question card. It does not wait for the script. | Warns; never blocks. Use it to play a sound or show a desktop notice. |

Hooks execute in configuration order for each event. `tools` matches tool names exactly, or
with `*` wildcards (`file_*` matches every `file_` tool); omit it to match every tool. It
applies to the tool events only. Separate delegated lanes may run hooks concurrently.
Each script receives one JSON object on **stdin**, followed by a newline:

```json
{
  "version": 1,
  "event": "PreToolUse",
  "sessionId": "session-id",
  "workspaceRoot": "/path/to/project",
  "toolCallId": "call-id",
  "toolName": "file_write",
  "toolInput": { "path": "src/example.ts", "content": "..." }
}
```

`UserPromptSubmit` adds `prompt`; `PostToolUse` adds `result` and `ok`; `Stop` adds
`stopReason` and, when the run is already continuing because of an earlier Stop hook,
`stopHookActive: true`; `Notification` adds `notificationType` (`approval` or `question`) and
`message`. Tool input is the model's original input, without injected service credentials.
Hook data may contain source code, prompt text, and tool output: configure scripts you trust.

### Exit codes and output

Exit **0** to continue. On `UserPromptSubmit` and `PreToolUse`, any other exit status, a launch
error, or a timeout blocks; the first blocking hook ends the event and later hooks do not run.
Write the reason to stderr; up to 16 KiB of combined output is retained as feedback. Hooks
default to a 10-second timeout, configurable from 100 ms to 60 seconds, with up to 32
entries. Cancellation terminates active hook processes; Stop scripts still run under their
own timeout.

The other events cannot block, so exit status 2 is how a script talks to the agent:

| Event | Exit status 2, or `{"decision":"block","reason":"..."}` on stdout with exit 0 | Any other failure |
| --- | --- | --- |
| `PostToolUse` | The text is added to that tool's result as `hook_feedback`, so the model reads what your linter or formatter found next to the result it belongs to. It is also shown as a warning. | A warning for you only. |
| `Stop` | The agent continues, told "A Stop hook asked you to keep working" and your text. Only a run that finished on its own can be continued, at most twice per run; `stopHookActive` is true on the later checks. | A warning for you only. |

A script that exits 0 may also print one JSON object: `additionalContext` adds text for the
model, to the submitted prompt on `UserPromptSubmit` or to the tool result on
`PostToolUse`. Any other output on success is ignored. Output can stop a step or add text; it
cannot grant approval or change a tool's arguments.

For example, `check-path.mjs` can reject edits to a protected directory:

```js
let text = "";
for await (const chunk of process.stdin) text += chunk;
const event = JSON.parse(text);
const path = String(event.toolInput?.path ?? "").replaceAll("\\", "/");
if (path.split("/").includes("secrets")) {
  console.error("The secrets directory is protected.");
  process.exitCode = 2;
}
```

This example checks the `path` field of the selected tools; a policy covering batch edits,
renames, or shell commands must also check those tools and their arguments. A formatter
should check `ok` before editing. Post-tool changes to files already tracked by the edit
journal are included in the after-snapshot. Changes to other files, or changes made by
prompt/pre/stop hooks, are not automatically journaled.

### Mistakes in the setting

Every entry is checked before any script runs. A `PreToolUse` or `UserPromptSubmit` step
is blocked while an entry is broken, because a broken entry may have been meant as a safety
check; the message names the entry and the field, and points to the setting. An entry for
an event that cannot block, such as `PostToolUse` or `Stop`, does not stop anything: the
others still run, and the mistake is reported as a warning when the run ends. Keys from other
tools are not read; `matcher` becomes `tools` and `timeout` becomes `timeoutMs`.

Hooks are user-authorized programs with your user rights, including during plan mode.
They do not provide an OS sandbox or replace existing tool approvals.

## Practical advice

**Work on a branch.** Not because the agent is reckless, but because reviewing a diff you can throw
away is a better position than reviewing one you cannot.

**Watch the map while it works.** Live traces show you which files it is touching. Wandering into an
unexpected area is the earliest signal that a request was misunderstood.

**Read the execution log when something goes wrong.** **Blacksite: Show Execution Logs** has every
tool call, its input, and its result. It is far more informative than reconstructing events from the
transcript.

**Keep deny lists sharp and auto-approve lists short.** The prompts are the product working. Turning
them all off converts a supervised tool into an unsupervised one.

**Do not point it at production credentials.** An agent with your AWS profile is an agent with your
AWS account. If a workspace has live credentials in its environment, deny the CLIs that use them.

---

## Related

- [Settings & Commands](settings-and-commands.html) — the permission settings in context
- [Working with Chat](working-with-chat.html) — how approvals appear in the transcript
- [Tool Reference](tool-reference.html) — everything that can be gated
