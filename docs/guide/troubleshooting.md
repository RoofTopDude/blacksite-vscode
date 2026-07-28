# Troubleshooting

Symptoms, likely causes, and what to try. Where a fix is a setting, the setting name links back to
[Settings & Commands](settings-and-commands.html).

---

## Setup

### The Blacksite icon isn't in the activity bar

The extension didn't activate. Reload the window (**Developer: Reload Window**). If it still isn't
there, check **Extensions** for Blacksite and confirm it is enabled and not showing an error.

Blacksite requires **VS Code 1.85 or newer** — check **Help → About**. An older version installs the
VSIX happily and then fails to activate.

### "No API key configured"

Run **Blacksite: Set API Key** and pick the provider that matches `blacksite.provider`. Keys are
stored per provider, so a key saved for Anthropic does nothing while the provider is set to OpenAI.

### Bedrock authentication fails

Blacksite uses the standard AWS credential chain. Test it independently:

```bash
aws sts get-caller-identity
```

If that fails, Blacksite will too. If it succeeds but Blacksite doesn't, check that the profile
you're relying on is the *default* one — Blacksite reads the chain, not a Blacksite-specific profile
setting.

### A model I expect isn't in the list

Two common causes:

1. **Bedrock, newest Claude models** — switch `blacksite.bedrockApi` to `mantle`. The Converse API
   doesn't carry the newest models; the Anthropic-native Messages endpoint does.
2. **Account access** — model availability is per account and per region. Check your provider
   console.

You can always override directly with `blacksite.model` or `/model <name>`, which bypasses the
picker entirely.

---

## The agent

### It stopped mid-task

Check for an unanswered prompt first — a modal approval or a question card blocks the loop until you
respond. The transcript will show where it stopped.

If it genuinely ended early, `/retry` resends your last message. If it ends early *repeatedly* on the
same request, the request is probably too large for one turn; break it into steps, or switch to the
**Plan** profile and get a plan first.

### It edited the wrong thing

Diffs are approved before they land, so the change is reviewable — but if one slipped through, `git
diff` and revert.

The usual root cause is ambiguous scope. "Fix the login bug" gives the agent a search problem;
"the session token isn't refreshed in `src/auth/session.ts` — trace why" gives it a location. Use
`@` mentions and **Attach File To Chat** rather than describing files in prose.

### It's using stale knowledge of a file

Blacksite tells the agent when it's editing from a stale copy, but you can force the issue: mention
the file explicitly, or ask it to re-read before changing. If the *index* is stale rather than the
file read, run **Blacksite: Rebuild Codebase Map Index**.

### It keeps asking for approvals

Working as designed. If a specific binary is safe in your project, choose "always allow" once — it
persists to [`blacksite.permissions.autoApprove`](settings-and-commands.html#permissions).

Before you add anything broad, read
[Approvals & Safety](approvals-and-safety.html#the-three-lists): auto-approving `git` also
auto-approves `git push --force`.

### It refuses to run a command

Check `blacksite.permissions.deniedCommands` — deny overrides everything else.

If the command carries an inline-eval flag (`node -e`, `python -c`), it's blocked by default; see
[the eval-flag exception](approvals-and-safety.html#the-eval-flag-exception) before enabling it.

If the binary simply isn't in the built-in allowlist, add it to
`blacksite.permissions.allowedCommands`.

### Responses are getting slow or expensive

Long conversations carry a large prefix. Two things help:

- **`/compact`** — summarize older history and reclaim context. Costs one model call, buys back
  room.
- **`/clear`** — start fresh when the new task genuinely doesn't need the old context.

The **Inspector** (ⓘ in the chat header) shows how full the window is and what the last turn cost.
Note that a long conversation is usually cheaper than its token count suggests, because most of the
prefix is a cache hit — a *fresh* conversation re-pays for the whole prefix.

### The context window keeps overflowing

Reduce what's riding along:

- Disable Base Context topics that aren't relevant to the current work.
- Prefer attachments over pasting file contents — attachments are retrieved on demand.
- Disable tool families you don't use; the catalog itself takes space.

---

## Codebase Map

### The map is empty or missing files

The index may still be building — it runs in the background on first open. Give it a moment on a
large repository.

If it's finished and files are still missing, you're likely hitting a cap. Raise
`blacksite.graph.performanceProfile` from `balanced` to `large` or `extreme`, or set
`blacksite.graph.maxIndexedFiles` explicitly.

Force a rebuild with **Blacksite: Rebuild Codebase Map Index**.

### The map is slow

Lower `blacksite.graph.performanceProfile` to `safe`, or cap
`blacksite.graph.maxRenderedStars` directly.

Above 6,000 nodes Blacksite switches from force-directed layout to a linear-time packing, so very
large graphs stay responsive — but rendering tens of thousands of stars is still work. Turn off
`blacksite.graph.backgroundSymbols` if it's on; it's the most expensive layer.

### Relationships I know exist aren't drawn

Service edges require the client side of a call to be **verified** before an edge is drawn. That's
deliberate — it means a line is a call that plausibly exists rather than two strings that rhyme, at
the cost of missing some real relationships.

For a relationship that matters and can't be detected, attach a **relation note**. Notes are
first-class graph edges: they render on the map and are traversable by `map_impact` and `map_path`.

### `map_relationships` returns no symbol relations

`blacksite.graph.backgroundSymbols` is off (the default). The result carries
`symbolRelationsUnavailable: true` in that case, so "not analyzed" is distinguishable from "none".
Turn it on if you want symbol-level precision and can afford the indexing cost.

---

## Data workbench

### "Database engine unavailable"

A SQLite binding isn't present. The rest of Blacksite works normally — chat, map, plans, and context
don't depend on the database. The Data view reconnects once a binding is available.

### The agent references tables that don't exist

Its catalog is stale. Run **Blacksite: Refresh Data Catalog**.

### A query returns fewer rows than expected

Read queries are capped by `blacksite.data.maxQueryRows` (default 500), and previews by
`blacksite.data.previewPageSize` (default 50). Raise either, or narrow the query.

### The agent won't run a write

By design. The agent classifies write and DDL statements without executing them and hands the result
to you. Run it yourself in the Query tab.

---

## Language intelligence

### Code intelligence tools return nothing

They query your installed language servers. If VS Code itself can't do **Go to Definition** in that
file, neither can Blacksite.

Check that the language extension is installed and has finished initializing — most language servers
need a moment after a window opens, and some need a project file (`tsconfig.json`, `go.mod`) to
activate at all.

### Rename didn't catch everything

`code_rename` uses the language server's own rename refactor — it's the same operation as VS Code's
`F2`, with the same coverage. Anything it missed, the editor would have missed too. Dynamic
references (string-keyed lookups, reflection) are the usual culprits, and text search is the fallback
for those.

---

## Updates

### Update check fails

Blacksite updates from its own published releases, not the Marketplace. Failures are usually network
or proxy related — **no credentials are involved**, so a failure is never an auth problem and there
is no token to configure.

The updater reads the static `latest.json` published with the site first, and only falls back to
`api.github.com` if that is unreachable. The API allows 60 unauthenticated requests per hour per IP,
which several developers behind one corporate NAT will exhaust — a `403` or `429` from GitHub means
that limit, not a permissions problem, and it resolves on its own.

If your proxy blocks the site, point `blacksite.updates.manifestUrl` somewhere reachable that serves
the same manifest, or rely on the GitHub fallback via `blacksite.updates.repository`.

Turn the check off with `blacksite.updates.checkOnStartup: false` and install VSIXs manually if your
network makes it unreliable.

### I want prerelease builds

`blacksite.updates.includePrerelease: true`.

---

## Getting more detail

**Blacksite: Show Execution Logs** opens the execution log for this workspace: every tool call, its
input, its result, and its timing. When something went wrong several steps back, this is far more
informative than reconstructing it from the transcript.

For extension-level errors, **Developer: Toggle Developer Tools** shows the webview console, and the
**Output** panel has a Blacksite channel.

If something looks like a genuine bug, the source is public —
[open an issue](https://github.com/RoofTopDude/blacksite-vscode/issues) with the relevant execution
log excerpt.

---

## Related

- [Settings & Commands](settings-and-commands.html)
- [Approvals & Safety](approvals-and-safety.html)
- [Getting Started](getting-started.html)
