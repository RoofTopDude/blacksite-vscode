# Settings & Commands

Everything Blacksite exposes, in one place. Settings live under the `blacksite.*` namespace; open
them with **Preferences: Open Settings** and search for `blacksite`, or edit `settings.json`
directly.

Several settings are also reachable from the **Settings** panel inside the Blacksite sidebar, which
writes to the same values.

The defaults are intended to be usable. If you are looking for a button or command, jump to
[Commands](#commands); the settings tables are technical reference for the cases where you
deliberately want different behavior.

---

## Provider and model

| Setting | Default | What it does |
| --- | --- | --- |
| `blacksite.provider` | `anthropic` | Which provider to use: `anthropic`, `openrouter`, `openai`, `bedrock` |
| `blacksite.bedrockApi` | `converse` | Bedrock API path. `converse` for live model listing and dated inference profiles; `mantle` for the Anthropic-native Messages endpoint required by the newest Claude models |
| `blacksite.model` | `""` | Model override. Empty uses the provider default |
| `blacksite.workspaceRoot` | `""` | Workspace root for the local runtime. Empty uses the first workspace folder |

API keys are **not** settings. They live in `SecretStorage` — see
[Providers, Keys & Models](providers-and-models.html).

---

## Permissions

These four control what the agent may execute. Each is scoped to the resource, so you can set them
per workspace.

| Setting | Default | What it does |
| --- | --- | --- |
| `blacksite.permissions.allowedCommands` | `[]` | Extra terminal binaries the agent may run, added to the built-in allowlist. Compared by command name, case-insensitive |
| `blacksite.permissions.deniedCommands` | `[]` | Binaries the agent may **never** run. Overrides both the allowlist and auto-approve |
| `blacksite.permissions.autoApprove` | `[]` | Binaries whose network/destructive operations run without a prompt. Populated by choosing "Always allow" on an approval |
| `blacksite.permissions.allowEvalFlags` | `false` | ⚠️ Permits inline-eval arguments (`node -e`, `python -c`, `ruby -e`, …) that are blocked by default |

**Deny beats everything.** If a binary is in `deniedCommands`, no allowlist entry and no auto-approve
decision will let it run.

`allowEvalFlags` deserves its warning. Enabling it lets the agent execute arbitrary code passed
directly on a command line — which routes around the tool-level gating entirely, because the shell
does not know the difference between `node build.js` and `node -e "<anything>"`. Leave it off unless
you have a specific reason and understand what you are trading.

Full discussion in [Approvals & Safety](approvals-and-safety.html).

---

## Codebase Map

| Setting | Default | Range | What it does |
| --- | --- | --- | --- |
| `blacksite.graph.performanceProfile` | `balanced` | `safe`, `balanced`, `large`, `extreme`, `custom` | Capacity profile for indexing and rendering |
| `blacksite.graph.maxIndexedFiles` | `0` | 0–250,000 | Advanced: max files scanned. `0` uses the profile |
| `blacksite.graph.maxRenderedStars` | `0` | 0–100,000 | Advanced: max stars rendered. `0` uses the profile |
| `blacksite.graph.maxRelationshipEdges` | `0` | 0–150,000 | Advanced: max relationship edges sent to the map. `0` uses the profile |
| `blacksite.graph.maxNodes` | `4000` | 100–20,000 | Legacy cap. Prefer the profile and advanced caps |
| `blacksite.graph.neighborhoods` | `auto` | `auto`, `on`, `off` | Whether distinct codebases get their own territories |
| `blacksite.graph.backgroundSymbols` | `false` | | Background-index call/reference/inheritance relationships via language servers. Higher cost; runs on an idle budget and pauses while you edit |
| `blacksite.graph.excludeDotDirectories` | `true` | | Skip directories whose name begins with a dot (`.vscode-test`, `.pytest_cache`, `.gradle`, …). Dot-*files* like `.env` are always kept. `.git`, `.blacksite`, `.next`, and `.venv` are never indexed either way |
| `blacksite.graph.dotDirectoryAllowlist` | `[]` | | Dot-directories to index anyway, e.g. `[".github"]`. Matched by directory name at any depth; the leading dot is optional |
| `blacksite.graph.traceFadeSeconds` | `45` | 2–3600 | How long agent activity traces take to fade |
| `blacksite.graph.traceShellEvents` | `true` | | Show shell/terminal activity as working-directory pulses |

The three advanced caps default to `0` meaning "use the profile". Set them only when a profile does
not give you what you need.

---

## Data workbench

| Setting | Default | What it does |
| --- | --- | --- |
| `blacksite.data.previewPageSize` | `50` | Rows per page in the table preview |
| `blacksite.data.maxQueryRows` | `500` | Max rows returned by a read query |
| `blacksite.data.enableAssistant` | `true` | Enable the natural-language database assistant |
| `blacksite.data.backendMode` | `exact_local` | Vector backend: `exact_local` (SQLite, zero dependencies) or `pgvector_container` (local Postgres + pgvector sidecar) |

---

## Browser

| Setting | Default | What it does |
| --- | --- | --- |
| `blacksite.browserHeadless` | `false` | Run the agent's browser without a visible window |

Headed by default, so you can watch what the agent does.

---

## Execution Runs

| Setting | Default | What it does |
| --- | --- | --- |
| `blacksite.runs.temporaryRetentionDays` | `7` | Age limit for unpinned exploratory runs |
| `blacksite.runs.standardRetentionDays` | `30` | Age limit for unpinned standard runs |
| `blacksite.runs.maxRuns` | `500` | Maximum unpinned run count per workspace |
| `blacksite.runs.video.enabled` | `false` | Allow the agent to explicitly record local browser video evidence. Recordings never start implicitly |
| `blacksite.runs.video.maxDiskMb` | `512` | Workspace disk budget for unpreserved browser recordings. Extracted keyframes don't count against it |
| `blacksite.runs.video.degradeAfterDays` | `1` | Days before an unpreserved recording is reduced in frame rate and resolution, when ffmpeg is available |
| `blacksite.runs.video.deleteAfterDays` | `3` | Days before an unpreserved recording is deleted. Extracted and user-flagged keyframes remain |
| `blacksite.runs.video.keyframeIntervalMs` | `500` | Interval between retained adjacent keyframes sampled while browser video is recording |

Pinned baselines, active runs, and evidence referenced by active plans or open tickets are
protected from automatic cleanup.

---

## Tickets

| Setting | Default | What it does |
| --- | --- | --- |
| `blacksite.tickets.idPrefix` | `BLK` | Prefix for ticket ids, e.g. `BLK-12`. Ticket ids leak into commit messages and branch names, so a project-specific prefix is often worth setting. Changing it does not renumber existing tickets |
| `blacksite.tickets.agentMayClose` | `false` | Allow the agent to move tickets to Done itself. Off by default — the agent files, updates, comments, and moves work to Review, but closing stays your call |

---

## Updates

Blacksite updates from its own published releases, not the VS Code Marketplace. **No credentials
are involved** — releases are public, and the updater never sends or asks for a token.

The check reads a static release manifest published with the site, falling back to the GitHub
releases API only if that is unreachable. The manifest is one CDN request rather than a call
against GitHub's unauthenticated limit of 60 requests per hour per IP, which a single office
behind one NAT can exhaust.

| Setting | Default | What it does |
| --- | --- | --- |
| `blacksite.updates.checkOnStartup` | `true` | Check for newer releases on startup, then every 3 hours while the window is open |
| `blacksite.updates.includePrerelease` | `false` | Allow prerelease builds. Only the GitHub API lists prereleases, so this bypasses the manifest |
| `blacksite.updates.manifestUrl` | `https://rooftopdude.github.io/blacksite-vscode/latest.json` | Release manifest checked first |
| `blacksite.updates.repository` | `""` | Owner/repo used as the fallback source. Blank uses the repository declared in the package |

---

## MCP

| Setting | Default | What it does |
| --- | --- | --- |
| `blacksite.mcpServers` | `[]` | Configured MCP servers. Managed via **Blacksite: Manage MCP Servers** |

Each entry has `id`, `name`, `transport` (`stdio` or `http`), `command` or `url`, and `enabled`.
Optionally: `auth` (`mode` of `none`/`oauth`/`bearer`/`header`, plus `headerName`, `scopes`,
`clientId`, `redirectUri`), `env` for stdio servers, `headers` for HTTP ones, and `transportHint`
to pin a protocol revision instead of probing for it.

The setting is application-scoped on purpose: a repository's `.vscode/settings.json` cannot
register a server, because that would let a cloned repo nominate a process for the extension to
launch.

Credentials never appear here. Tokens, OAuth grants, and secret environment values live in VS Code
SecretStorage, and per-tool permissions live in extension state — so this setting stays safe to
sync. Editing by hand works, but the command is easier and validates as it goes.

---

## Integrations

Trusted destinations for the built-in GitLab, Jira, Confluence, and Salesforce tools. All are
application-scoped, so a workspace cannot silently point them somewhere else, and the credential
itself always lives in SecretStorage — these settings only name where it is allowed to go.

| Setting | Default | What it does |
| --- | --- | --- |
| `blacksite.integrations.gitlabHost` | `https://gitlab.com` | Trusted HTTPS origin that may receive the stored GitLab token |
| `blacksite.integrations.jiraHost` | `""` | Trusted HTTPS Jira origin, e.g. `https://example.atlassian.net`. Required before Jira tools are exposed to the agent |
| `blacksite.integrations.confluenceHost` | `""` | Trusted HTTPS Confluence origin. Required before Confluence tools are exposed to the agent |
| `blacksite.integrations.salesforceInstanceUrl` | `""` | Trusted HTTPS Salesforce instance origin. Required before Salesforce tools are exposed to the agent |

---

## Plan continuation

| Setting | Default | What it does |
| --- | --- | --- |
| `blacksite.planContinuation.enabled` | `false` | Automatically continue an approved plan when a turn ends without finishing it. A separate agent, holding your original prompts verbatim, decides whether to continue, escalate, or halt. Off by default — this spends model calls and agent turns with nobody watching |
| `blacksite.planContinuation.maxConsecutive` | `5` | How many times in a row the plan may be continued before stopping to check in. Resets whenever you send a message |

---

## PAU (Beta)

| Setting | Default | What it does |
| --- | --- | --- |
| `blacksite.pau.enabled` | `false` | Measure what's consuming the agent's context window each turn — token load, duplication, replay across turns, hog segments — using the [PAU Profiler](https://github.com/RoofTopDude/pau-profiler) library, shown in the PAU panel. Read-only: it does not change what is sent to the model or how compaction behaves. Off by default while this gets real-world testing |

---

## Preview

| Setting | Default | What it does |
| --- | --- | --- |
| `blacksite.preview.projectStylesheet` | `[]` | Workspace-relative CSS files that question-card previews render against, so a preview uses the project's own design tokens and component classes instead of hand-written CSS. Leave empty to auto-detect common build output or a conventional source entry such as `src/index.css`, `src/globals.css`, or `app/globals.css` |

---

## Commands

All available from the command palette under the **Blacksite** category.

### Chat

| Command | What it does |
| --- | --- |
| **Open Chat Panel** | Focus the chat view |
| **Clear Chat** | Start a fresh conversation |
| **Stop Response** | Stop the agent between tool calls |
| **Compact Conversation History** | Summarize older history to reclaim context |
| **Set API Key** | Store a provider key in `SecretStorage` |
| **Show Execution Logs** | Open the execution log for this workspace |
| **Move Chat to the Right Side Bar** | Move the Chat view to VS Code's secondary side bar |

### Code

| Command | What it does |
| --- | --- |
| **Explain Selection** | Explain the selected code (`Ctrl+Shift+E` / `Cmd+Shift+E`) |
| **Ask About This File** | Start a request scoped to a file |
| **Fix with Blacksite** | Code action on a diagnostic — hands the agent the problem |
| **Attach File To Chat** | Attach a file to the current conversation |
| **Add File To Base Context** | Add a file reference to a Base Context topic |
| **Clear Problems** | Clear Blacksite-reported entries from the Problems panel |

### Map

| Command | What it does |
| --- | --- |
| **Open Codebase Map** | Open the map in the sidebar |
| **Open Codebase Map in Editor** | Open the map as a full editor tab |
| **Rebuild Codebase Map Index** | Force a full reindex |
| **Open Map Notes Timeline** | Browse durable notes with git history and diffs |

### Execution Runs

| Command | What it does |
| --- | --- |
| **Open Execution Runs** | Focus Run Explorer for retained timelines, evidence, and comparisons |
| **Approve External Application for Read-Only Capture** | Authorize an external app window for read-only browser evidence capture |

### Tickets

| Command | What it does |
| --- | --- |
| **Open Tickets** | Open the compact workspace queue |
| **Open Ticket Board** | Open the full-width board in an editor tab |
| **File a Ticket** | Record follow-up work, using the current file as territory when available |
| **Propose Triage Tickets** | Ask the agent to sweep for issues worth filing and stage them as triage tickets |

### Ticket Loops

| Command | What it does |
| --- | --- |
| **Open Ticket Loops** | Focus the Loops view |
| **New Ticket Loop** | Create a loop that works a set of tickets automatically |

Once a loop exists, its Start, Pause, Stop, Release Parked Ticket, and Delete actions are the icon
buttons on that loop in the view — they operate on a specific loop, so they live inline rather than
in the command palette.

### PAU (Beta)

| Command | What it does |
| --- | --- |
| **Open PAU Panel (Beta)** | Open the PAU panel. Requires `blacksite.pau.enabled` |

### Data

| Command | What it does |
| --- | --- |
| **Open Data Workbench** | Open the Data view |
| **Refresh Data Catalog** | Re-read the schema |
| **Run Database Query** | Run a query |
| **Open Saved Query** | Open a previously saved query |

### Other

| Command | What it does |
| --- | --- |
| **Manage MCP Servers** | Add, edit, enable, or disable MCP servers |
| **Close Browser Window** | Close the agent's browser |
| **Check For Extension Updates** | Check GitHub for a newer release |

---

## Keyboard and context menus

**`Ctrl+Shift+E` / `Cmd+Shift+E`** — Explain Selection, when there is a selection.

**Editor right-click menu** — Explain Selection (with a selection), Ask About This File, Add File To
Base Context, Attach File To Chat, and File a Ticket.

**Explorer right-click menu** — Ask About This File, Add File To Base Context, Attach File To Chat.

---

## Files on disk

| Path | Contents |
| --- | --- |
| `.blacksite/base-context.json` | Curated topics and file references |
| `.blacksite/planning.json` | Plans, phases, and state |
| `.blacksite/tickets.json` | Ticket queue, links, comments, and activity history |
| `.blacksite/reference/<sessionId>/` | Files attached to a conversation |
| `.blacksite/` (other) | Codebase index, map notes, execution logs, embedded database |

See [Plans & Context](plans-and-context.html#committing-them) for what is worth committing.

---

## Related

- [Providers, Keys & Models](providers-and-models.html)
- [Approvals & Safety](approvals-and-safety.html)
- [Troubleshooting](troubleshooting.html)
