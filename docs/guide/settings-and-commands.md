# Settings & Commands

Everything Blacksite exposes, in one place. Settings live under the `blacksite.*` namespace; open
them with **Preferences: Open Settings** and search for `blacksite`, or edit `settings.json`
directly.

Several settings are also reachable from the **Settings** panel inside the Blacksite sidebar, which
writes to the same values.

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

## Updates

Blacksite updates from its own published releases, not the VS Code Marketplace. **No credentials
are involved** — releases are public, and the updater never sends or asks for a token.

The check reads a static release manifest published with the site, falling back to the GitHub
releases API only if that is unreachable. The manifest is one CDN request rather than a call
against GitHub's unauthenticated limit of 60 requests per hour per IP, which a single office
behind one NAT can exhaust.

| Setting | Default | What it does |
| --- | --- | --- |
| `blacksite.updates.checkOnStartup` | `true` | Check for newer releases on startup |
| `blacksite.updates.includePrerelease` | `false` | Allow prerelease builds. Only the GitHub API lists prereleases, so this bypasses the manifest |
| `blacksite.updates.manifestUrl` | `https://blacksite-agent.com/latest.json` | Release manifest checked first |
| `blacksite.updates.repository` | `""` | Owner/repo used as the fallback source. Blank uses the repository declared in the package |

---

## MCP

| Setting | Default | What it does |
| --- | --- | --- |
| `blacksite.mcpServers` | `[]` | Configured MCP servers. Managed via **Blacksite: Manage MCP Servers** |

Each entry has `id`, `name`, `transport` (`stdio` or `http`), `command` or `url`, and `enabled`.
Editing by hand works, but the command is easier and validates as it goes.

---

## Commands

All available from the command palette under the **Blacksite** category.

### Chat

| Command | What it does |
| --- | --- |
| **Open Chat Panel** | Focus the chat view |
| **Clear Chat** | Start a fresh conversation |
| **Cancel Current Run** | Stop the agent between tool calls |
| **Compact Conversation History** | Summarize older history to reclaim context |
| **Set API Key** | Store a provider key in `SecretStorage` |
| **Show Execution Logs** | Open the execution log for this workspace |

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
Base Context, Attach File To Chat.

**Explorer right-click menu** — Ask About This File, Add File To Base Context, Attach File To Chat.

---

## Files on disk

| Path | Contents |
| --- | --- |
| `.blacksite/base-context.json` | Curated topics and file references |
| `.blacksite/planning.json` | Plans, phases, and state |
| `.blacksite/reference/<sessionId>/` | Files attached to a conversation |
| `.blacksite/` (other) | Codebase index, map notes, execution logs, embedded database |

See [Plans & Context](plans-and-context.html#committing-them) for what is worth committing.

---

## Related

- [Providers, Keys & Models](providers-and-models.html)
- [Approvals & Safety](approvals-and-safety.html)
- [Troubleshooting](troubleshooting.html)
