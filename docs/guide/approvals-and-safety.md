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
- **Allow All** — the rest of this run.
- **Deny** — refuse; the agent gets the refusal and continues.

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
