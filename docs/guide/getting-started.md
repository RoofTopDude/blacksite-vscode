# Getting Started

Blacksite is a VS Code extension that puts an agentic coding assistant next to your editor — one
that can read and edit files, run commands, query your language servers, and navigate a rendered
map of your codebase.

It is **bring-your-own-key**. You connect your own Anthropic, OpenAI, OpenRouter, or AWS Bedrock
account, and that provider bills you for tokens directly. There is no Blacksite server in the
path, and no telemetry.

This page takes you from a fresh install to a first useful request in about five minutes.
You do not need to know what an agent loop, model provider, or context window is before starting;
each term is explained when it first matters.

---

## Before you start

You need two things:

- **VS Code 1.85 or newer.** Check with **Help → About**.
- **An API key** for at least one of: Anthropic, OpenAI, OpenRouter, or AWS Bedrock credentials.

If you have never obtained a model API key before, OpenRouter is the shortest path — one key gives
you access to models from several vendors, so you can try a few without opening four accounts.

---

## 1. Install the extension

Blacksite is distributed as a `.vsix` file rather than through the VS Code Marketplace.

Download the latest `.vsix` from the [releases page](https://github.com/RoofTopDude/blacksite-vscode/releases),
then install it:

```bash
code --install-extension blacksite-vscode-<version>.vsix
```

Or from inside VS Code: open the **Extensions** view, click the **⋯** menu at the top of the
sidebar, and choose **Install from VSIX…**.

Reload the window when prompted. A Blacksite icon appears in the activity bar on the left.

> **On updates.** Blacksite checks GitHub for newer releases on startup and can install them in
> place. If you would rather pin versions yourself, set `blacksite.updates.checkOnStartup` to
> `false`. This never touches the Marketplace.

---

## 2. Add your API key

Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **Blacksite: Set API Key**.
Pick your provider and paste the key.

Keys are stored in VS Code's `SecretStorage`, which is backed by your operating system's keychain.
They are never written into `settings.json`, into your workspace, or into any log file.

If you use AWS Bedrock, Blacksite reads the standard AWS credential chain instead of asking for a
pasted key — environment variables, shared config profiles, SSO, and instance roles all work.

See [Providers, Keys & Models](providers-and-models.html) for the details of each provider,
including how to choose a model.

---

## 3. Open a workspace and let the index build

Blacksite works against an open workspace folder, not against loose files. Open the project you
want to work on.

The first time you open a workspace, Blacksite indexes it — walking files, resolving imports per
language, and detecting relationships between services. On a normal repository this takes seconds;
on a very large monorepo it can take longer, and it runs in the background either way.

Run **Blacksite: Open Codebase Map** to watch it happen. Files appear as stars, imports as arcs
between them, and detected services as territories. That index is not just a picture — it is a
queryable graph, and the agent has tools to ask it questions.

---

## 4. Ask for something

Click the Blacksite icon in the activity bar to open the Chat panel, and type a request.

Good first requests are ones where being wrong is cheap and the answer teaches you something about
your own project:

- *"Give me a tour of this codebase. What are the main areas and how do they connect?"*
- *"What happens when a user submits the login form? Trace it end to end."*
- *"Which files would I have to touch to add a new field to the settings object?"*

Notice what happens while it works. The transcript shows each tool call as it runs — which file was
read, which map query was issued, which command was executed. Nothing is hidden behind a spinner.

When the agent wants to change a file, you get a diff to approve first. When it wants to run a
command that touches the network or destroys something, you get a modal prompt. See
[Approvals & Safety](approvals-and-safety.html) for exactly where those gates sit.

---

## 5. Learn the six views

Blacksite is not only a chat box. The activity bar group holds six views, each backed by
durable state in your workspace:

| View | What it holds | Guide |
| --- | --- | --- |
| **Chat** | The agent conversation, tool log, approvals, and settings | [Working with Chat](working-with-chat.html) |
| **Plans** | Multi-phase plans with per-step state that survive session boundaries | [Plans & Context](plans-and-context.html) |
| **Tickets** | Follow-up work to triage, map, discuss, and turn into plans | [Tickets & the Board](tickets-and-board.html) |
| **Base Context** | Curated topics and file snippets that ride along in every request | [Plans & Context](plans-and-context.html) |
| **Data** | An embedded SQLite workbench with query editor and vector search | [Data Workbench](data-workbench.html) |
| **Map** | The rendered codebase graph, with search, filters, and live agent traces | [Using the Codebase Map](map-guide.html) |

There is also a **Ticket Board** in an editor tab and a **Notes** timeline
(**Blacksite: Open Map Notes Timeline**) for durable annotations attached to files and
relationships.

---

## 6. Point at code without describing it

Three shortcuts save you from paraphrasing code into the chat box:

- **Select code → right-click → Explain Selection** (or `Ctrl+Shift+E` / `Cmd+Shift+E`).
- **Right-click a file** in the explorer → **Ask About This File**, **Attach File To Chat**, or
  **Add File To Base Context**.
- **Type `@` in the chat input** to mention a workspace file by name.

For a problem in the Problems panel, use the lightbulb code action **Fix with Blacksite** — it hands
the agent the diagnostic, its location, and its source.

---

## Where things live on disk

Everything Blacksite persists lives in a `.blacksite/` directory at your workspace root:

```
.blacksite/
  base-context.json    curated topics and pinned file references
  planning.json        plans, phases, and their state
  tickets.json         the workspace ticket queue and its history
  reference/           files you attached to conversations
  ...                  the codebase index, map notes, execution logs, and the embedded database
```

Nothing there is required to build or run your project. Add it to `.gitignore` if you would rather
not commit it—or deliberately commit `base-context.json`, `planning.json`, and `tickets.json` when
your team wants to share that working context.

---

## Next steps

- **[Working with Chat](working-with-chat.html)** — request profiles, slash commands, attachments,
  and how compaction keeps long sessions alive.
- **[Using the Codebase Map](map-guide.html)** — what the map actually shows, and the queries the
  agent runs against it.
- **[Settings & Commands](settings-and-commands.html)** — every `blacksite.*` setting, explained.
- **[Learn](../../learn.html)** — the concepts behind agentic coding tools, if you want to know
  *why* any of this is built the way it is.
