# Tool Reference

A **tool** is a capability the model can ask Blacksite to use: read a file, search the map, update a
plan, or run a command. The request is structured, checked by the extension, and shown in the
transcript.

This is a technical lookup, not required reading. You never call these tools directly. Knowing what
exists can still help you ask for a capability clearly instead of hoping the agent improvises it.

Every family below is a real group in the tool catalog.

---

## Workspace

File and shell operations. The load-bearing ones.

| Tool | Purpose |
| --- | --- |
| `file_read` | Read a file, or a range of it |
| `file_write` | Write a whole file |
| `file_edit`, `file_edit_batch` | Surgical text edits, one or many |
| `json_edit` | Structured edit of a JSON document by pointer |
| `file_list`, `file_glob` | Directory listing and glob matching |
| `file_search`, `search`, `search_code` | Text and code search across the workspace |
| `file_move`, `file_copy`, `file_delete`, `file_mkdir` | Filesystem operations |
| `shell_run` | Run a terminal command |
| `process_start`, `process_status`, `process_read_output`, `process_send_input`, `process_stop` | Long-running processes: dev servers, watchers, REPLs |

Edits are diffed and approved before touching disk. Shell commands are classified and gated — see
[Approvals & Safety](approvals-and-safety.html).

The process family is what lets the agent start your dev server, read its output as it runs, send it
input, and stop it — rather than blocking forever on a command that never exits.

---

## Code intelligence (LSP)

Queries against your installed language servers. This is the family that separates "the agent
pattern-matched on text" from "the agent asked the same thing your editor asks".

| Tool | Purpose |
| --- | --- |
| `code_symbols` | Symbols in a file or across the workspace |
| `code_navigate` | Definition, references, implementations, type definition |
| `code_hierarchy` | Call hierarchy and type hierarchy |
| `code_hover`, `code_inlay_hints` | Types and signatures at a position |
| `code_diagnostics` | Errors and warnings |
| `code_insert`, `code_replace`, `code_replace_batch` | Language-aware edits targeted by *symbol*, not line number |
| `code_rename` | The editor's own rename refactor |
| `code_actions` | Quick fixes and refactors offered by the language server |
| `code_format` | Format through the configured formatter |

The targeting model is worth understanding: these tools take a **symbol name** in preference to a
line number. `src/agent-session.ts` + `ChatProvider.send` is stable across edits in a way that
`line 412` is not. Mutating tools refuse ambiguous matches and require exact disambiguation; read
tools can take the first match.

After every edit, diagnostics are collected and fed straight back — so the agent finds out it broke
the build before you do.

Design detail in [LSP Code Intelligence](../lsp-code-intelligence.html).

---

## Codebase Map

| Tool | Purpose |
| --- | --- |
| `map_overview` | Orient in the whole workspace: projects, areas, hubs, cross-service flows, structural findings |
| `map_find` | Enumerate files with filters and ranking |
| `map_relationships` | One hop out from a file, across every layer |
| `map_impact` | Transitive blast radius, N hops, with the edge chain back to the seed |
| `map_path` | Shortest concrete chains connecting two files |
| `map_note_add`, `map_note_list`, `map_note_update`, `map_note_remove` | Durable annotations on files and relations |

Covered fully in [Using the Codebase Map](map-guide.html).

---

## Planning

| Tool | Purpose |
| --- | --- |
| `plan_create`, `plan_update`, `plan_list` | Multi-phase plans and their state |
| `plan_doc_write`, `plan_doc_read`, `plan_doc_list` | Documents attached to a plan or phase |
| `todo_create`, `todo_update`, `todo_status`, `todo_list` | Lightweight in-session checklists |

---

## Tickets

| Tool | Purpose |
| --- | --- |
| `ticket_file` | Record an out-of-scope outcome without widening the current task |
| `ticket_list`, `ticket_update` | Find and maintain work in the local queue |
| `ticket_get` | Read one ticket in full, including its whole comment history |
| `ticket_comment` | Add durable findings or decisions to a ticket's activity timeline |
| `ticket_next` | Rank unblocked work and explain why it rose to the top |
| `ticket_promote` | Turn a ticket's outcome and map territory into the seed for a plan |
| `ticket_sweep` | Propose triage candidates from existing diagnostics and TODO markers (never files them) |

See [Tickets & the Board](tickets-and-board.html) for the everyday workflow.

---

## Diagnostics

| Tool | Purpose |
| --- | --- |
| `report_problems` | Publish findings into the VS Code Problems panel |
| `add_comment` | Attach an inline comment at a code location |

The agent can put its findings where you already look for problems, instead of only in chat. Clear
them with **Blacksite: Clear Problems**.

---

## Memory

| Tool | Purpose |
| --- | --- |
| `memory_append`, `memory_read`, `memory_search` | Durable project knowledge across sessions |

---

## Data

`db_list_objects`, `db_describe_object`, `db_preview_rows`, `db_run_read_query`,
`db_preview_write_query`, `db_vector_search`, `db_list_saved_queries` — see
[Data Workbench](data-workbench.html).

---

## References (attachments)

| Tool | Purpose |
| --- | --- |
| `reference_list`, `reference_read` | List and read files you attached |
| `reference_zoom_image` | Inspect a region of an image at higher fidelity |
| `reference_query_spreadsheet` | Query a spreadsheet as data |
| `reference_vector_search` | Semantic search across attachments |
| `reference_context_read`, `reference_context_write` | Durable notes about an attachment |

Attachments are stored on disk and retrieved on demand rather than pasted into context. That is why
attaching something large is cheap.

---

## Git, tests, worktrees

| Tool | Purpose |
| --- | --- |
| `git_op` | Status, diff, log, blame, branch, stage, commit |
| `test_detect` | Work out how this project runs tests |
| `test_run` | Run them, scoped |
| `worktree_op` | Manage git worktrees for isolated parallel work |

`test_detect` before `test_run` is the pattern that makes this work across projects with different
runners.

---

## Subagents

| Tool | Purpose |
| --- | --- |
| `subagent_spawn` | Run independent work in a separate context and return the result |
| `subagent_followup` | Resume a finished lane with a new message, keeping its context |

Used for inspection, verification, broad file triage, and evidence gathering — so the parent agent
preserves its context for orchestration and synthesis. Four built-in profiles: **Frontend UI**,
**Backend API**, **QA Regression**, **Repo Ops**.

### Complexity sets the budget

Every lane is rated `standard`, `complex`, or `deep`, and that rating sets its time and
tool-round budget. The rating reflects the *work required* rather than the length of the
request — a one-line task can be the deep one.

| Rating | Suits | Roughly |
| --- | --- | --- |
| `standard` | A bounded lookup or single-file change | Under 6 tool calls |
| `complex` | Multi-file investigation, or a change needing verification | 6–10 tool calls |
| `deep` | Broad triage in unfamiliar territory, or iterative build/test cycles | 10+ tool calls |

### Sequential and parallel

Both are first-class, and the agent picks per situation:

- **Sequential** (the default) runs one lane at a time. Often the right call: the first result
  frequently changes what the second task should even be, and it keeps synthesis to one thing.
- **Parallel** fans out several lanes issued in the same turn, each marked `parallel: true`,
  up to **Max concurrent** in Settings → Subagents. Worth it when the lanes are genuinely
  independent and wall-clock time is what you want back.

The trade runs in both directions: fanning out pays for every lane's context even when the
first answer makes the rest moot, and lands several results at once to synthesise. Sequencing
pays the sum of the latencies rather than the slowest one. Lanes that would write to
overlapping files stay sequential.

### When a lane does not finish

A lane that runs out of time or ends without an answer returns what it gathered rather than
just a status: `partialAnswer`, `executionTrace`, `filesTouched`, `toolRounds`, and a
`failureKind` of `timeout`, `cancelled`, `no_answer`, or `error`.

That distinction shapes what happens next. A **timeout** was still making progress when its
budget ran out, so it is worth resuming or re-running narrowed. A **no_answer** ran to
completion, so the same request would land the same way and is better restated. Frequently
`partialAnswer` already covers the task and no further lane is needed.

### Following up

`subagent_followup` re-opens a finished lane using the `subRequestId` from its result. The lane
still holds the files it read and the reasoning behind its answer, so a follow-up costs a single
message where a new lane would start from nothing. Follow-ups run one at a time, get their own
budget, and the most recent lanes stay resumable.

---

## Transcript and result paging

| Tool | Purpose |
| --- | --- |
| `transcript_read` | Read back earlier in the current conversation |
| `transcript_document` | Write a long deliverable as a navigable document |
| `tool_output_page` | Page through a large tool result |
| `tool_output_search` | Search within a large tool result |

The paging family is why one enormous grep result cannot exhaust your context window.

---

## Service integrations

Read/write operations against external systems, when configured:

- **GitHub** — `github_get_pr`, `github_list_prs`, `github_create_pr`, `github_get_issue`,
  `github_list_issues`, `github_create_issue`, `github_update_issue`, `github_get_file`,
  `github_list_branches`
- **GitLab** — the equivalent surface for merge requests, issues, and projects
- **Jira** — issues: get, list, create, update
- **Confluence** — pages and spaces: get, list, create, update
- **Salesforce** — objects: get, list, create, update

---

## Execution Runs

| Tool | Purpose |
| --- | --- |
| `sequence_discover` | Find routes, stories, tests, files, and reachable local surfaces |
| `sequence_execute` | Execute one approved, bounded linear sequence and retain its evidence |
| `sequence_inspect` | Seek to a step, event, anomaly, checkpoint, entity, or semantic match without rerunning |
| `sequence_compare` | Align two runs and report channel-scoped candidate differences |
| `sequence_resume` | Conservatively replay a repeatable setup/tail; marker-only checkpoints and unsafe effects are rejected |
| `sequence_search` | Search run history by text, lineage, work item, surface, file, status, or anomaly |

These tools return compact IDs and summaries; full event windows and artifacts stay local until
the agent asks for a focused inspection. Browser sequences are limited to loopback development
origins, and process actions use the same approval policy as their standalone equivalents.

---

## Browser

| Tool | Purpose |
| --- | --- |
| `browser_navigate` | Open a URL |
| `browser_click`, `browser_type` | Interact with the page |
| `browser_get_text`, `browser_screenshot` | Read what is there |
| `browser_evaluate`, `browser_run_script` | Execute JavaScript in the page |

Runs headed by default so you can watch what it does — set `blacksite.browserHeadless` to `true` to
hide the window. Close it with **Blacksite: Close Browser Window**.

Headed is the better default. An agent driving a browser invisibly is an agent you cannot correct.

---

## UI

| Tool | Purpose |
| --- | --- |
| `question_card` | Ask a structured question with options, implications, and optional previews |

---

## MCP

| Tool | Purpose |
| --- | --- |
| `mcp_list_tools`, `mcp_call_tool` | Discover and call tools from connected MCP servers |

See [Providers, Keys & Models](providers-and-models.html#mcp-servers).

---

## Turning families off

Tool group toggles live in the Blacksite settings. Disabling a family removes those tools from the
catalog entirely — the model is not told they exist, so it cannot ask for them and cannot be
disappointed.

Worth doing when a family is irrelevant to your work: fewer tools is a smaller prompt and a smaller
decision space.

---

## Related

- [Working with Chat](working-with-chat.html) — how tools show up in the transcript
- [Approvals & Safety](approvals-and-safety.html) — which calls are gated
- [Provider-Neutral Agent Environment](../agent-environment.html) — how tool schemas are converted
  per provider
