# Approvals & Safety

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

---

## The three lists

Three settings shape what happens before a prompt is ever shown. All are resource-scoped, so they
can differ per workspace.

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
