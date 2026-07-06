export interface QCardPreview {
  html?: string;
  code: string;
  height?: number;
}

export interface QCardOption {
  key: string;
  label: string;
  description?: string;
  preview?: QCardPreview;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  runtimeType: string;
  runtimePayload?: Record<string, unknown>;
}

export interface ToolInputValidationIssue {
  path: string;
  kind: "missing_required" | "invalid_type";
  message: string;
}

type ToolProperties = Record<string, unknown>;

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });
const arr = (items: unknown, description: string) => ({ type: "array", items, description });
const obj = (description: string, properties?: ToolProperties, required: string[] = []) => ({
  type: "object" as const,
  description,
  ...(properties ? { properties } : {}),
  ...(properties && required.length ? { required } : {}),
});

const schema = (properties: ToolProperties, required: string[] = []) => ({
  type: "object" as const,
  properties,
  ...(required.length ? { required } : {}),
});

const tool = (
  name: string,
  runtimeType: string,
  description: string,
  properties: ToolProperties,
  required: string[] = [],
  runtimePayload?: Record<string, unknown>,
): ToolDefinition => ({
  name,
  runtimeType,
  description,
  input_schema: schema(properties, required),
  ...(runtimePayload ? { runtimePayload } : {}),
});

const githubTool = (
  name: string,
  op: string,
  description: string,
  properties: ToolProperties,
  required: string[] = [],
): ToolDefinition => tool(`github_${name}`, "service.github", description, properties, required, { op });

const gitlabTool = (
  name: string,
  op: string,
  description: string,
  properties: ToolProperties,
  required: string[] = [],
): ToolDefinition => tool(`gitlab_${name}`, "service.gitlab", description, properties, required, { op });

const jiraTool = (
  name: string,
  op: string,
  description: string,
  properties: ToolProperties,
  required: string[] = [],
): ToolDefinition => tool(`jira_${name}`, "service.jira", description, properties, required, { op });

const confluenceTool = (
  name: string,
  op: string,
  description: string,
  properties: ToolProperties,
  required: string[] = [],
): ToolDefinition => tool(`confluence_${name}`, "service.confluence", description, properties, required, { op });

const salesforceTool = (
  name: string,
  op: string,
  description: string,
  properties: ToolProperties,
  required: string[] = [],
): ToolDefinition => tool(`salesforce_${name}`, "service.salesforce", description, properties, required, { op });

const SUBAGENT_SPAWN_TOOL_DESCRIPTION_HINT =
  "Use proactively for independent inspection, verification, broad file triage, or evidence gathering " +
  "so the parent agent can preserve context and stay focused on orchestration and synthesis.";

export const WORKSPACE_TOOLS: ToolDefinition[] = [
  tool(
    "shell_run",
    "system.shell",
    "Execute a one-shot shell command rooted in the current workspace and return stdout/stderr. Use for build, test, lint, install, and scripted tasks.",
    {
      command: str("Binary to run"),
      args: arr({ type: "string" }, "Command arguments"),
      cwd: str("Working directory absolute path or relative to the workspace root; it must stay within the workspace"),
      confirmed: bool("Set true to confirm network or destructive operations after review"),
      timeout: num("Timeout in milliseconds, max 600000"),
      allowedBinaries: arr({ type: "string" }, "Additional binaries to allow beyond defaults"),
    },
    ["command"],
  ),
  tool(
    "process_start",
    "system.process.start",
    "Launch a long-running background process such as a dev server, watcher, or REPL inside the current workspace. Returns a handleId for follow-up process tools.",
    {
      command: str("Binary to run"),
      args: arr({ type: "string" }, "Arguments"),
      cwd: str("Working directory absolute path or relative to the workspace root; it must stay within the workspace"),
      allowStdin: bool("Allow sending input via process_send_input"),
      confirmed: bool("Confirm network or destructive tier"),
      allowedBinaries: arr({ type: "string" }, "Additional allowed binaries"),
    },
    ["command"],
  ),
  tool(
    "process_status",
    "system.process.status",
    "Get the status of a background process by handleId.",
    { handleId: str("Handle from process_start") },
    ["handleId"],
  ),
  tool(
    "process_read_output",
    "system.process.read_output",
    "Read buffered stdout/stderr from a background process. Use cursor for incremental reads.",
    {
      handleId: str("Handle from process_start"),
      cursor: num("Starting cursor position (0 for beginning, omit for latest)"),
      limit: num("Maximum entries to return (1-200, default 40)"),
    },
    ["handleId"],
  ),
  tool(
    "process_send_input",
    "system.process.send_input",
    "Send text to stdin for a running background process. Only works when allowStdin was enabled at launch.",
    {
      handleId: str("Handle from process_start"),
      input: str("Text to write to stdin; append \\n for newline"),
    },
    ["handleId", "input"],
  ),
  tool(
    "process_stop",
    "system.process.stop",
    "Stop a background process by handleId.",
    { handleId: str("Handle from process_start") },
    ["handleId"],
  ),
  tool(
    "file_list",
    "system.list_directory",
    "List files and directories at a workspace path.",
    { path: str("Absolute path or path relative to the workspace root") },
    ["path"],
  ),
  tool(
    "file_read",
    "system.read_file",
    "Read the full contents of a workspace file up to 256 KB.",
    { path: str("Absolute file path or path relative to the workspace root") },
    ["path"],
  ),
  tool(
    "file_edit",
    "editor.apply_edit",
    "Make a surgical edit to an existing file by replacing an exact string. Shows the user a side-by-side diff for approval before applying. Prefer this over file_write when modifying existing files. oldString must match the file exactly (including whitespace) and be unique unless replaceAll is set.",
    {
      path: str("File path, absolute or relative to the workspace root"),
      oldString: str("Exact text to replace, copied verbatim from the file including indentation"),
      newString: str("Replacement text"),
      replaceAll: bool("Replace every occurrence instead of requiring a unique match (default false)"),
    },
    ["path", "oldString", "newString"],
  ),
  tool(
    "file_edit_batch",
    "editor.apply_edit_batch",
    "Apply multiple exact-string edits across one or more existing files in a single reviewed diff. Use for coordinated refactors where several surgical replacements should land together.",
    {
      edits: arr(
        obj("", {
          path: str("File path, absolute or relative to the workspace root"),
          oldString: str("Exact text to replace, copied verbatim from the file including indentation"),
          newString: str("Replacement text"),
          replaceAll: bool("Replace every occurrence instead of requiring a unique match"),
        }, ["path", "oldString", "newString"]),
        "Exact-string edits to apply together",
      ),
    },
    ["edits"],
  ),
  tool(
    "file_write",
    "system.write_file",
    "Write or overwrite a whole file inside the workspace with the provided content. Use for creating new files; prefer file_edit for changing existing files. Avoid rewriting a large existing file in one call — a long write can exceed the response output-token budget and truncate mid-file; make targeted file_edit changes instead. The extension will request approval before applying the write.",
    {
      path: str("Absolute file path or path relative to the workspace root"),
      content: str("Full file content to write"),
      confirmed: bool("Optional approval flag injected by the extension after the user approves the write"),
    },
    ["path", "content"],
  ),
  tool(
    "file_delete",
    "system.delete_path",
    "Delete a file or directory inside the workspace. The extension will request approval before applying this destructive operation.",
    {
      path: str("Absolute path or path relative to the workspace root"),
      confirmed: bool("Optional approval flag injected by the extension after the user approves the delete"),
    },
    ["path"],
  ),
  tool(
    "file_mkdir",
    "system.create_project",
    "Create a directory inside the workspace.",
    { path: str("Directory path to create") },
    ["path"],
  ),
  tool(
    "file_glob",
    "system.glob",
    "Glob files under a directory. Supports **, *, ?, and character ranges. Excludes node_modules, .git, dist, and similar directories by default.",
    {
      path: str("Root directory to search"),
      pattern: str("Glob pattern, for example '**/*.ts' or 'src/**/*.{ts,tsx}'"),
      maxResults: num("Maximum results (default 200, max 1000)"),
    },
    ["path", "pattern"],
  ),
  tool(
    "file_search",
    "system.search_files",
    "Search file contents with a regex pattern. Returns file, line number, and matching text.",
    {
      path: str("Root directory to search — must be a directory, not a single file. To inspect one file, read it instead."),
      pattern: str("Regex pattern to search for"),
      caseSensitive: bool("Case-sensitive search (default false)"),
      include: str("Optional filename filter (substring match)"),
      maxResults: num("Maximum results (default 100, max 500)"),
    },
    ["path", "pattern"],
  ),
  tool(
    "mcp_list_tools",
    "mcp.list_tools",
    "List available tools from an MCP server.",
    {
      server: obj(
        "MCP server config",
        {
          url: str("HTTP URL or stdio command line"),
          apiKey: str("Bearer token for HTTP servers (optional)"),
          headers: obj("Additional HTTP headers (optional)"),
        },
        ["url"],
      ),
    },
    ["server"],
  ),
  tool(
    "mcp_call_tool",
    "mcp.call_tool",
    "Call a tool on an MCP server. Use mcp_list_tools first to discover the tool name and argument schema.",
    {
      server: obj(
        "MCP server config",
        {
          url: str("HTTP URL or stdio command line"),
          apiKey: str("Bearer token for HTTP servers (optional)"),
          headers: obj("Additional HTTP headers (optional)"),
        },
        ["url"],
      ),
      toolName: str("Tool name from mcp_list_tools"),
      args: obj("Tool arguments matching the target tool schema"),
    },
    ["server", "toolName"],
  ),
];

export const DIAGNOSTICS_TOOLS: ToolDefinition[] = [
  tool(
    "report_problems",
    "editor.report_problems",
    "Surface findings (bugs, lint issues, review notes) in VS Code's Problems panel with clickable file locations. Replaces any problems from your previous call. Pass an empty list or clear:true to remove them.",
    {
      problems: arr(
        obj("", {
          path: str("File path, absolute or relative to the workspace root"),
          line: num("1-based line number"),
          endLine: num("1-based end line (defaults to line)"),
          column: num("1-based column (optional)"),
          endColumn: num("1-based end column (optional)"),
          severity: str("error | warning | info | hint (default warning)"),
          message: str("Human-readable problem description"),
          source: str("Optional short source label, for example 'review' or 'lint'"),
        }, ["path", "line", "message"]),
        "Problems to display in the Problems panel",
      ),
      clear: bool("Clear all Blacksite-reported problems"),
    },
  ),
];

const codeTarget = obj(
  "Where in the code to point. Provide `symbol` (preferred) or `line`.",
  {
    path: str("File path, absolute or relative to the workspace root"),
    symbol: str("Symbol to locate by name, for example 'fetchModels' or 'ChatProvider.send' (preferred targeting)"),
    kind: str("Optional kind to disambiguate a symbol: function | method | class | interface | variable | property | constant | enum"),
    line: num("1-based line number (used when symbol is omitted)"),
    column: num("1-based column (optional, with line)"),
    matchText: str("Substring occurring on `line`; the exact column is located from it (robust alternative to column)"),
    firstMatch: bool("If the symbol name matches multiple places, use the first instead of returning candidates"),
  },
  ["path"],
);

export const CODE_INTEL_TOOLS: ToolDefinition[] = [
  tool(
    "code_insert",
    "lsp.insert",
    "Insert code relative to a symbol or line using language-aware targeting, then review the diff before applying. Use this when you need to add imports, methods, branches, or new blocks without relying on brittle full-file text matches.",
    {
      target: codeTarget,
      position: str("Where to insert relative to the target: before | after | start | end"),
      text: str("Text to insert exactly as provided"),
    },
    ["target", "position", "text"],
  ),
  tool(
    "code_symbols",
    "lsp.symbols",
    "List code symbols using the language server. With `path`, returns the document's symbol tree (functions, classes, methods). With `query`, searches symbols across the whole workspace. Use this to map a file or find where something is defined.",
    {
      path: str("File path for a document symbol tree (omit to search the workspace)"),
      query: str("Workspace-wide symbol name search (omit to list a single file)"),
      limit: num("Max results for workspace search (default 100, max 500)"),
    },
  ),
  tool(
    "code_navigate",
    "lsp.navigate",
    "Resolve code relationships with the language server: jump to a definition, type definition, declaration, or implementation, or find all references. Far more reliable than text search for understanding code.",
    {
      target: codeTarget,
      kind: str("definition | typeDefinition | declaration | implementation | references"),
      includeBody: bool("For definition-like kinds, include the full source of the resolved symbol (default false)"),
      context: num("Lines of surrounding context to include in each snippet (0-3, default 0)"),
      limit: num("Max locations to return (default 100, max 500)"),
    },
    ["target", "kind"],
  ),
  tool(
    "code_hierarchy",
    "lsp.hierarchy",
    "Trace the call or type hierarchy around a symbol via the language server. `callers`/`callees` give the functions that call, or are called by, a function (precise — regex/text search cannot do this); `supertypes`/`subtypes` give the classes/interfaces a type extends/implements, or that extend it. Use `callers` before changing a function to see the blast radius, and `supertypes`/`subtypes` to understand an inheritance tree.",
    {
      target: codeTarget,
      kind: str("callers | callees | supertypes | subtypes"),
      limit: num("Max results to return (default 100, max 500)"),
    },
    ["target", "kind"],
  ),
  tool(
    "code_hover",
    "lsp.hover",
    "Get the language server's hover details at a symbol: inferred type, signature, and documentation. Use to understand a type or API without reading the whole file.",
    { target: codeTarget },
    ["target"],
  ),
  tool(
    "code_diagnostics",
    "lsp.diagnostics",
    "Read live diagnostics (errors, warnings) reported by the language servers for one file or the whole workspace. Use after edits to verify nothing broke, then fix what you find.",
    {
      path: str("File path to scope diagnostics (omit for the whole workspace)"),
      severity: str("Minimum severity to include: error | warning | info | hint (includes that level and more severe)"),
      limit: num("Max problems to return (default 100, max 500)"),
    },
  ),
  tool(
    "code_rename",
    "lsp.rename",
    "Rename a symbol everywhere it is used, via the language server (semantically correct across the whole project, unlike find/replace). Shows a diff of all affected files for approval. The result includes diagnostics for the changed files.",
    {
      target: codeTarget,
      newName: str("The new name for the symbol"),
    },
    ["target", "newName"],
  ),
  tool(
    "code_actions",
    "lsp.actions",
    "List or apply the language's own quick-fixes and refactors (add missing import, implement interface, organize imports, fix-all, etc.) for a range. Omit `apply` to list available actions; set `apply` to a returned title to apply it (shown as a diff for approval). The result includes diagnostics for the changed files.",
    {
      path: str("File path"),
      line: num("1-based line number where the action applies"),
      endLine: num("1-based end line for a multi-line range (defaults to line)"),
      only: str("Optional kind filter, for example 'quickfix', 'refactor', or 'source.organizeImports'"),
      apply: str("Title (or title prefix) of the action to apply; omit to only list actions"),
    },
    ["path", "line"],
  ),
  tool(
    "code_format",
    "lsp.format",
    "Format a file (or a line range) with the configured formatter, shown as a diff for approval. Use after editing instead of hand-aligning whitespace.",
    {
      path: str("File path"),
      range: obj("Optional line range to format", { startLine: num("1-based start line"), endLine: num("1-based end line") }, ["startLine", "endLine"]),
    },
    ["path"],
  ),
];

const PLAN_STEP_SHAPE = {
  title: str("Step title"),
  detail: str("Optional implementation detail or verification note"),
  acceptanceCriteria: str("Optional definition-of-done for this specific step"),
};

const PLAN_PHASE_SHAPE = {
  title: str("Phase title"),
  objective: str("Optional objective for this phase"),
  risks: str("Optional current risk or consideration note for this phase"),
  dependsOn: arr({ type: "string" }, "Optional phase IDs this phase assumes are already done (informational only, not enforced)"),
  acceptanceCriteria: arr({ type: "string" }, "Optional definition-of-done bullets for this phase"),
  complexity: str("Optional coarse effort hint: small | medium | large"),
  steps: arr(obj("", PLAN_STEP_SHAPE, ["title"]), "Ordered steps in this phase"),
};

export const PLANNING_TOOLS: ToolDefinition[] = [
  tool(
    "plan_create",
    "planning.create",
    "Create a persistent phased plan for the current task or project slice. Use for multi-phase work where the user should be able to see objectives, current phase, and remaining phases across conversations. For plans with more than 2-3 phases, prefer creating the plan with just the first phase or two, then extend it with plan_update's addPhases once you've made progress — early phases are usually wrong before you've seen the codebase, and authoring every phase up front commits you to guesses before you have the evidence to make them well.",
    {
      title: str("Plan title"),
      summary: str("Short summary of the overall objective"),
      status: str("Optional initial status: draft | active"),
      phases: arr(obj("", PLAN_PHASE_SHAPE, ["title"]), "Ordered phases for this plan"),
    },
    ["title", "phases"],
  ),
  tool(
    "plan_update",
    "planning.update",
    "Update an existing plan: advance status, edit phases/steps, append notes, add/remove/reorder phases and steps, and move a step to a different phase. Prefer this over recreating a plan when scope changes. Status fields accept natural synonyms (e.g. 'in progress', 'done', 'paused') — they are normalized. Do not modify plans the user has put on hold or cancelled unless they resume them. When extending a plan phase-by-phase, add a phaseNote or stepNote explaining what you learned before adding the next phase — that reasoning is what makes incremental planning worth doing instead of just batching everything up front. This is where ongoing progress on a plan belongs: as you complete work, advance phaseStatus/stepStatus and add notes here directly, rather than tracking it in a separate todo_create run and letting the plan itself go stale.",
    {
      planId: str("Plan ID returned by plan_create or plan_list"),
      title: str("Optional new plan title"),
      summary: str("Optional new plan summary"),
      status: str("Optional plan status: draft | active | on_hold | completed | blocked | cancelled"),
      note: str("Optional plan-level note to append"),
      activePhaseId: str("Optional active phase ID"),
      addPhases: arr(obj("", PLAN_PHASE_SHAPE, ["title"]), "Optional new phases to append to the plan"),
      insertPhaseBeforeId: str("Optional existing phase ID — when set, addPhases are inserted immediately before this phase instead of appended to the end"),
      removePhaseId: str("Optional phase ID to remove from the plan"),
      reorderPhaseIds: arr({ type: "string" }, "Optional full reordering of this plan's phase IDs — must include every existing phase ID exactly once"),
      phaseId: str("Optional target phase ID (for phase edits / addSteps / removeStepId / reorderStepIds)"),
      phaseTitle: str("Optional new phase title"),
      phaseObjective: str("Optional new phase objective"),
      phaseStatus: str("Optional phase status: pending | in_progress | completed | blocked"),
      phaseNote: str("Optional phase note to append"),
      phaseRisks: str("Optional new current risk or consideration note for the target phase"),
      phaseDependsOn: arr({ type: "string" }, "Optional replacement list of phase IDs the target phase assumes are already done"),
      phaseAcceptanceCriteria: arr({ type: "string" }, "Optional replacement definition-of-done bullets for the target phase"),
      phaseComplexity: str("Optional coarse effort hint for the target phase: small | medium | large"),
      addSteps: arr(obj("", PLAN_STEP_SHAPE, ["title"]), "Optional new steps to append to the target phase (requires phaseId)"),
      removeStepId: str("Optional step ID or exact title to remove from the target phase"),
      reorderStepIds: arr({ type: "string" }, "Optional full reordering of the target phase's (phaseId) step IDs — must include every existing step ID in that phase exactly once"),
      moveStepId: str("Optional step ID or exact title to move to a different phase (requires moveStepToPhaseId)"),
      moveStepToPhaseId: str("Optional destination phase ID for moveStepId"),
      stepId: str("Optional target step ID or exact step title within the phase"),
      stepTitle: str("Optional new step title"),
      stepDetail: str("Optional new step detail"),
      stepStatus: str("Optional step status: pending | in_progress | completed | blocked"),
      stepNote: str("Optional step note to append"),
      stepAcceptanceCriteria: str("Optional new definition-of-done for the target step"),
    },
    ["planId"],
  ),
  tool(
    "plan_list",
    "planning.list",
    "List existing plans and their phase state. Use before creating a new plan so you continue the current one when appropriate.",
    {
      activeOnly: bool("Only return active/non-cancelled plans (default true)"),
    },
  ),
  tool(
    "todo_create",
    "planning.todoCreate",
    "Create a transient checklist to break down what you're doing right now into concrete sub-steps — impromptu tactical scratch space, not a second tracker. Use it for a single step or investigation that needs 3+ concrete sub-actions, not for the plan's phases as a whole: a plan phase already has its own status and notes, so don't spin up one todo_create run per phase and let that become the thing you actually maintain. If you link planId/phaseId, keep logging real progress on the plan itself via plan_update's phaseStatus/stepStatus/notes — the todo run is a short-lived aid for this step, not a replacement for updating the plan.",
    {
      name: str("Name for this task-items run"),
      planId: str("Optional linked plan ID"),
      phaseId: str("Optional linked phase ID"),
      steps: arr(
        obj("", {
          label: str("Short step label"),
        }, ["label"]),
        "Ordered task-item steps",
      ),
    },
    ["steps"],
  ),
  tool(
    "todo_update",
    "planning.todoUpdate",
    "Update the status of one task-item step. Keep this current while work is actually happening so the user can see active progress.",
    {
      todoId: str("Task-items run ID"),
      stepId: str("Step ID, numeric alias, or exact step label"),
      status: str("Step status: running | done | failed"),
      result: str("Optional evidence or outcome note"),
    },
    ["todoId", "stepId", "status"],
  ),
  tool(
    "todo_status",
    "planning.todoStatus",
    "Return the current status of one task-items run, or the latest active run if todoId is omitted.",
    {
      todoId: str("Optional task-items run ID"),
    },
  ),
  tool(
    "todo_list",
    "planning.todoList",
    "List current task-items runs. Use before creating a new one so you continue existing tracked work when appropriate.",
    {
      activeOnly: bool("Only return active runs (default true)"),
      planId: str("Optional linked plan ID filter"),
    },
  ),
];

export const MEMORY_TOOLS: ToolDefinition[] = [
  tool(
    "memory_append",
    "memory.append",
    "Append a durable, timestamped note to project memory (.blacksite/memory.md). Use for decisions, conventions, gotchas, or facts worth remembering across sessions. Memory is read back into context at the start of future conversations.",
    { note: str("A concise, self-contained fact or decision to remember.") },
    ["note"],
  ),
  tool(
    "memory_read",
    "memory.read",
    "Read the current project memory (.blacksite/memory.md) and project context (.blacksite/context.md).",
    {},
  ),
];

export const DATA_TOOLS: ToolDefinition[] = [
  tool(
    "db_list_objects",
    "data.list_objects",
    "List the local database catalog: tables, views, vector collections, saved queries, and jobs. Inspect this before proposing SQL so you use real object names.",
    {},
  ),
  tool(
    "db_describe_object",
    "data.describe_object",
    "Describe a table or view: columns, types, indexes, row count, and DDL. Use to ground SQL in the real schema.",
    { name: str("Table or view name") },
    ["name"],
  ),
  tool(
    "db_preview_rows",
    "data.preview_rows",
    "Preview rows from a table or view with pagination and an optional case-insensitive text filter. Read-only.",
    {
      name: str("Table or view name"),
      limit: num("Max rows to return (default 50, max 1000)"),
      offset: num("Row offset for pagination"),
      filter: str("Optional case-insensitive filter across text columns"),
    },
    ["name"],
  ),
  tool(
    "db_run_read_query",
    "data.run_read_query",
    "Run a read-only SQL statement (SELECT / WITH / EXPLAIN / read PRAGMA) and return rows. Write or destructive statements are rejected — use db_preview_write_query for those.",
    {
      sql: str("A single read-only SQL statement"),
      maxRows: num("Maximum rows to return (default 200)"),
    },
    ["sql"],
  ),
  tool(
    "db_preview_write_query",
    "data.preview_write_query",
    "Classify a write/DDL statement WITHOUT executing it, returning whether it is a write or destructive and what confirmation it needs. The agent never executes writes directly; surface this to the user for approval.",
    { sql: str("A single SQL statement to classify") },
    ["sql"],
  ),
  tool(
    "db_vector_search",
    "data.vector_search",
    "Semantic nearest-neighbour search over the local vector store. Provide query text (embedded locally) or a raw vector.",
    {
      text: str("Query text to embed and search with"),
      vector: arr({ type: "number" }, "Optional precomputed query vector (overrides text)"),
      topK: num("Number of results (default 10)"),
      collection: str("Optional collection name to scope the search"),
    },
  ),
  tool(
    "db_list_saved_queries",
    "data.list_saved_queries",
    "List saved queries with their names and SQL so you can reuse or continue prior analysis.",
    {},
  ),
];

export const REFERENCE_TOOLS: ToolDefinition[] = [
  tool(
    "reference_list",
    "reference.list",
    "List the files the user has attached to this conversation (permanently stored under .blacksite/reference/<sessionId>/, never fed directly into context). Use this to see what's available before reading or querying an attachment.",
    {},
  ),
  tool(
    "reference_read",
    "reference.read",
    "Read the extracted text of an attached file (PDF, DOCX, PPTX, XLSX, CSV, .log, or other text formats — call reference_list first to see available names). Images have no extractable text; use reference_zoom_image for those instead. Large results are automatically paginated.",
    { name: str("The attachment's file name, exactly as returned by reference_list.") },
    ["name"],
  ),
  tool(
    "reference_query_spreadsheet",
    "reference.query_spreadsheet",
    "Run a jq filter against an attached CSV, TSV, or XLSX file's rows (each row is a JSON object keyed by column header). For XLSX with multiple sheets, pass 'sheet' to pick one by name (defaults to the first sheet) — call reference_list or a plain reference_read to discover sheet layout if unsure. Example filter: '.[] | select(.Revenue | tonumber > 1000)'.",
    {
      name: str("The attachment's file name, exactly as returned by reference_list."),
      filter: str("A jq filter expression, applied to the array of row objects."),
      sheet: str("Optional XLSX sheet name to query (defaults to the first sheet)."),
    },
    ["name", "filter"],
  ),
  tool(
    "reference_zoom_image",
    "reference.zoom_image",
    "Crop a region out of an attached high-resolution image and upscale it for closer inspection. Coordinates are in the original image's pixel space, with (0,0) at the top-left. Use reference_list to see image dimensions context (or start with a guessed region and refine).",
    {
      name: str("The attachment's file name, exactly as returned by reference_list."),
      x: num("Left edge of the crop region, in source-image pixels."),
      y: num("Top edge of the crop region, in source-image pixels."),
      width: num("Width of the crop region, in source-image pixels."),
      height: num("Height of the crop region, in source-image pixels."),
      targetWidth: num("Optional output width in pixels (defaults to 2x the crop width, capped at 1600)."),
      targetHeight: num("Optional output height in pixels (defaults to 2x the crop height, capped at 1600)."),
    },
    ["name", "x", "y", "width", "height"],
  ),
  tool(
    "reference_vector_search",
    "reference.vector_search",
    "Semantic search over this conversation's attached files, when an embedding model is configured (Settings -> Embedding). Supplements reference_read/reference_query_spreadsheet — it does not replace them, and works only for attachments that have finished background embedding.",
    {
      query: str("Natural-language query to search for."),
      topK: num("Number of results to return (default 10)."),
    },
    ["query"],
  ),
  tool(
    "reference_context_read",
    "reference.context_read",
    "Read this conversation's 'Extracted context.md' scratchpad — a persistent, human- and agent-editable notes file scoped to this conversation's attachments.",
    {},
  ),
  tool(
    "reference_context_write",
    "reference.context_write",
    "Append a timestamped entry to this conversation's 'Extracted context.md' scratchpad. Use it to record findings, summaries, or extracted structure from attached files so future turns (and the user, on disk) can see them without re-deriving them.",
    { entry: str("The note or summary to append.") },
    ["entry"],
  ),
];

export const GIT_TOOLS: ToolDefinition[] = [
  tool(
    "git_op",
    "workspace.git",
    "Perform a structured git operation such as status, diff, log, stage, restore, commit, checkout, branch, stash, or push.",
    {
      op: str("Operation: status | diff | log | add | restore | commit | checkout | branch | stash | push"),
      cwd: str("Sub-directory within workspace root (optional)"),
      path: str("File path for diff, log, add, or restore"),
      staged: bool("For diff: show --cached. For restore: unstage instead of discard"),
      all: bool("For add: stage all. For commit: commit all"),
      message: str("Commit message or stash message"),
      author: str("Author override for commit, for example 'Name <email>'"),
      limit: num("For log: number of commits (default 20, max 200)"),
      branch: str("Branch name for checkout or push"),
      create: bool("For checkout: create new branch"),
      action: str("For branch: list | create | delete. For stash: push | pop | list"),
      name: str("For branch create/delete: branch name"),
      remote: str("For push: remote name (default origin)"),
      force: bool("For push: force push"),
      setUpstream: bool("For push: set upstream"),
      confirmed: bool("For push: confirm after review"),
    },
    ["op"],
  ),
];

export const TEST_TOOLS: ToolDefinition[] = [
  tool(
    "test_detect",
    "test.detect",
    "Detect the test framework used in the workspace.",
    { root: str("Workspace root path (defaults to workspace root)") },
  ),
  tool(
    "test_run",
    "test.run",
    "Run the test suite and return pass/fail counts with failure details.",
    {
      root: str("Workspace root (defaults to workspace root)"),
      filter: str("Test name filter or framework-specific pattern"),
      timeoutMs: num("Maximum execution time in milliseconds (default 120000)"),
      cwd: str("Working directory relative to workspace root"),
    },
  ),
];

export const WORKTREE_TOOLS: ToolDefinition[] = [
  tool(
    "worktree_op",
    "worktree.op",
    "Manage git worktrees for isolated subagent execution.",
    {
      op: str("Operation: create | remove | list"),
      taskId: str("For create: readable task identifier for the branch name"),
      path: str("For remove: absolute path to the worktree"),
    },
    ["op"],
  ),
];

export const SUBAGENT_TOOLS: ToolDefinition[] = [
  tool(
    "subagent_spawn",
    "subagent.spawn",
    "Delegate one self-contained lane to an independent subagent so the parent can preserve context and stay focused on orchestration and synthesis. " +
      SUBAGENT_SPAWN_TOOL_DESCRIPTION_HINT + " The subagent runs its own conversation with fresh context and tools, then returns a synthesized answer. Include all necessary context in the task because the delegated lane cannot see the parent conversation.",
    {
      task: str(
        "Clear, self-contained subtask to delegate. Include scope boundaries, expected output, and all necessary context.",
      ),
      context: str("Optional additional context such as code snippets, logs, file paths, or URLs."),
      complexity: str("Optional task complexity hint: auto | standard | complex | deep."),
      label: str("Optional short lane label for the transcript."),
      parallel: bool(
        "Whether to run this subagent in parallel with other parallel subagents in the same turn. Defaults to false.",
      ),
      profileId: str(
        "Optional profile ID to specialize the subagent's focus. Builtin profiles: frontend_ui, backend_api, qa_regression, repo_ops. User-defined profile IDs are also accepted.",
      ),
    },
    ["task"],
  ),
];

export const TRANSCRIPT_TOOLS: ToolDefinition[] = [
  tool(
    "transcript_read",
    "transcript.read",
    "Read the full conversation transcript including messages that have been compressed for context efficiency. " +
    "Use this when you need to recall something from earlier in the conversation that may have been summarised. " +
    "Supports keyword search and message range retrieval.",
    {
      query: str("Optional keyword or phrase to search for across the transcript. Returns matching excerpts."),
      messageRange: obj(
        "Optional: retrieve raw messages from a specific index range.",
        {
          from: num("Message index to start from (0-based, inclusive)"),
          to:   num("Message index to end at (exclusive)"),
        },
      ),
    },
    [],
  ),
];

export const AGENT_MEMORY_TOOLS: ToolDefinition[] = [
  tool(
    "memory_search",
    "memory.semantic_search",
    "Semantically search the agent's persistent memory index — past tool calls, compressed transcript chunks, and memory notes — using natural language. " +
    "Use this to recall what was done in previous sessions, find similar past actions, or locate context that was compressed away. " +
    "Returns ranked results with short content excerpts and ref strings you can share with transcript_read.",
    {
      query: str("Natural language query describing what you are looking for."),
      collections: arr(
        { type: "string", enum: ["tool_calls", "transcript", "memories"] },
        "Which collections to search. Omit to search all three: tool_calls (past actions), transcript (compressed history chunks), memories (saved notes).",
      ),
      topK: num("Maximum results to return (default 5, max 20)."),
    },
    ["query"],
  ),
];

export const RESULT_PAGING_TOOLS: ToolDefinition[] = [
  tool(
    "tool_output_page",
    "session.tool_output_page",
    "Continue reading a previous tool call's output that was too large and got truncated. " +
    "A truncated result ends with a notice giving you the exact toolCallId and offset to pass here — copy them " +
    "verbatim rather than guessing. Prefer narrowing the original call (a smaller range, a tighter filter, a more " +
    "specific query) over paging through everything when that would get you the answer faster. Only works for " +
    "results truncated earlier in this same conversation.",
    {
      toolCallId: str("The tool call id shown in the truncation notice, e.g. \"toolu_01Ab2C…\"."),
      offset: num("Character offset to resume reading from (0-based). Use the offset the notice suggests, or 0 to start from the beginning."),
      limit: num("Maximum characters to return in this page (default 20,000, matching the original truncation size)."),
    },
    ["toolCallId"],
  ),
  tool(
    "tool_output_search",
    "session.tool_output_search",
    "Search within a previous tool call's output that was too large to read in full. Finds matching lines with " +
    "surrounding context, without paging through everything. Prefer this over tool_output_page when you know " +
    "roughly what you're looking for — the truncation notice's line/keyword counts are a good hint. Only works " +
    "for results truncated earlier in this same conversation.",
    {
      toolCallId: str("The tool call id shown in the truncation notice."),
      pattern: str("Case-insensitive substring to search for, e.g. \"AssertionError\"."),
      contextLines: num("Lines of context to include before/after each match (default 2, max 10)."),
      maxMatches: num("Maximum number of matches to return (default 20, max 50)."),
    },
    ["toolCallId", "pattern"],
  ),
];

export const SERVICE_TOOLS: ToolDefinition[] = [
  githubTool(
    "list_issues",
    "list_issues",
    "List issues in a GitHub repository.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      state: str("Issue state filter: open | closed | all (default open)"),
      limit: num("Maximum results (default 30, max 100)"),
    },
    ["owner", "repo"],
  ),
  githubTool(
    "get_issue",
    "get_issue",
    "Fetch a single GitHub issue.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      number: str("Issue number"),
    },
    ["owner", "repo", "number"],
  ),
  githubTool(
    "create_issue",
    "create_issue",
    "Create a GitHub issue.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      title: str("Issue title"),
      body: str("Issue body"),
      labels: arr({ type: "string" }, "Labels"),
    },
    ["owner", "repo", "title"],
  ),
  githubTool(
    "list_prs",
    "list_prs",
    "List pull requests in a GitHub repository.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      state: str("Pull request state filter: open | closed | all (default open)"),
      limit: num("Maximum results (default 30, max 100)"),
    },
    ["owner", "repo"],
  ),
  githubTool(
    "get_pr",
    "get_pr",
    "Fetch a single GitHub pull request.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      number: str("Pull request number"),
    },
    ["owner", "repo", "number"],
  ),
  githubTool(
    "create_pr",
    "create_pr",
    "Create a GitHub pull request.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      title: str("Pull request title"),
      body: str("Pull request body"),
      head: str("Head branch"),
      base: str("Base branch (default main)"),
    },
    ["owner", "repo", "title", "head"],
  ),
  githubTool(
    "list_branches",
    "list_branches",
    "List branches in a GitHub repository.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      limit: num("Maximum results (default 30, max 100)"),
    },
    ["owner", "repo"],
  ),
  githubTool(
    "get_file",
    "get_file",
    "Fetch a file from a GitHub repository.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      path: str("File path"),
      ref: str("Branch, tag, or SHA (optional)"),
    },
    ["owner", "repo", "path"],
  ),
  githubTool(
    "search_code",
    "search_code",
    "Search code with GitHub's code search API.",
    {
      query: str("Code search query"),
    },
    ["query"],
  ),
  githubTool(
    "add_comment",
    "add_comment",
    "Add a comment to a GitHub issue or pull request.",
    {
      owner: str("Repository owner"),
      repo: str("Repository name"),
      number: str("Issue or pull request number"),
      body: str("Comment body"),
    },
    ["owner", "repo", "number", "body"],
  ),

  gitlabTool(
    "list_issues",
    "list_issues",
    "List issues in a GitLab project.",
    {
      host: str("GitLab host URL (default https://gitlab.com)"),
      projectId: str("Project ID or URL-encoded path"),
      state: str("Issue state filter: opened | closed | all (default opened)"),
      limit: num("Maximum results (default 20, max 100)"),
    },
    ["projectId"],
  ),
  gitlabTool(
    "get_issue",
    "get_issue",
    "Fetch a single GitLab issue.",
    {
      host: str("GitLab host URL (default https://gitlab.com)"),
      projectId: str("Project ID or URL-encoded path"),
      iid: str("Issue internal ID"),
    },
    ["projectId", "iid"],
  ),
  gitlabTool(
    "create_issue",
    "create_issue",
    "Create a GitLab issue.",
    {
      host: str("GitLab host URL (default https://gitlab.com)"),
      projectId: str("Project ID or URL-encoded path"),
      title: str("Issue title"),
      description: str("Issue description"),
      labels: arr({ type: "string" }, "Labels"),
    },
    ["projectId", "title"],
  ),
  gitlabTool(
    "list_mrs",
    "list_mrs",
    "List merge requests in a GitLab project.",
    {
      host: str("GitLab host URL (default https://gitlab.com)"),
      projectId: str("Project ID or URL-encoded path"),
      state: str("Merge request state filter: opened | closed | all (default opened)"),
      limit: num("Maximum results (default 20, max 100)"),
    },
    ["projectId"],
  ),
  gitlabTool(
    "get_mr",
    "get_mr",
    "Fetch a single GitLab merge request.",
    {
      host: str("GitLab host URL (default https://gitlab.com)"),
      projectId: str("Project ID or URL-encoded path"),
      iid: str("Merge request internal ID"),
    },
    ["projectId", "iid"],
  ),
  gitlabTool(
    "create_mr",
    "create_mr",
    "Create a GitLab merge request.",
    {
      host: str("GitLab host URL (default https://gitlab.com)"),
      projectId: str("Project ID or URL-encoded path"),
      title: str("Merge request title"),
      description: str("Merge request description"),
      sourceBranch: str("Source branch"),
      targetBranch: str("Target branch (default main)"),
    },
    ["projectId", "title", "sourceBranch"],
  ),
  gitlabTool(
    "list_branches",
    "list_branches",
    "List branches in a GitLab project.",
    {
      host: str("GitLab host URL (default https://gitlab.com)"),
      projectId: str("Project ID or URL-encoded path"),
      limit: num("Maximum results (default 20, max 100)"),
    },
    ["projectId"],
  ),

  jiraTool(
    "list_issues",
    "list_issues",
    "Search Jira issues with JQL.",
    {
      host: str("Jira host URL"),
      jql: str("JQL query"),
      limit: num("Maximum results (default 20, max 100)"),
    },
    ["host", "jql"],
  ),
  jiraTool(
    "get_issue",
    "get_issue",
    "Fetch a single Jira issue.",
    {
      host: str("Jira host URL"),
      key: str("Issue key, for example FOO-123"),
    },
    ["host", "key"],
  ),
  jiraTool(
    "create_issue",
    "create_issue",
    "Create a Jira issue.",
    {
      host: str("Jira host URL"),
      project: str("Project key"),
      summary: str("Issue summary"),
      description: str("Issue description"),
      issueType: str("Issue type (default Task)"),
    },
    ["host", "project", "summary"],
  ),
  jiraTool(
    "update_issue",
    "update_issue",
    "Update fields on a Jira issue.",
    {
      host: str("Jira host URL"),
      key: str("Issue key"),
      fields: obj("Fields to update"),
    },
    ["host", "key", "fields"],
  ),
  jiraTool(
    "add_comment",
    "add_comment",
    "Add a comment to a Jira issue.",
    {
      host: str("Jira host URL"),
      key: str("Issue key"),
      body: str("Comment body"),
    },
    ["host", "key", "body"],
  ),
  jiraTool(
    "list_projects",
    "list_projects",
    "List Jira projects available to the user.",
    {
      host: str("Jira host URL"),
      limit: num("Maximum results (default 50, max 200)"),
    },
    ["host"],
  ),

  confluenceTool(
    "search",
    "search",
    "Search Confluence content with CQL.",
    {
      host: str("Confluence host URL"),
      query: str("CQL query"),
      limit: num("Maximum results (default 20, max 50)"),
    },
    ["host", "query"],
  ),
  confluenceTool(
    "get_page",
    "get_page",
    "Fetch a Confluence page with storage body and version metadata.",
    {
      host: str("Confluence host URL"),
      pageId: str("Page ID"),
    },
    ["host", "pageId"],
  ),
  confluenceTool(
    "create_page",
    "create_page",
    "Create a Confluence page.",
    {
      host: str("Confluence host URL"),
      spaceKey: str("Space key"),
      title: str("Page title"),
      body: str("Page body in Confluence storage format"),
      parentId: str("Parent page ID (optional)"),
    },
    ["host", "spaceKey", "title", "body"],
  ),
  confluenceTool(
    "update_page",
    "update_page",
    "Update a Confluence page.",
    {
      host: str("Confluence host URL"),
      pageId: str("Page ID"),
      title: str("Page title"),
      body: str("Page body in Confluence storage format"),
      version: num("Current page version"),
    },
    ["host", "pageId", "title", "body", "version"],
  ),
  confluenceTool(
    "list_spaces",
    "list_spaces",
    "List Confluence spaces.",
    {
      host: str("Confluence host URL"),
      limit: num("Maximum results (default 25, max 100)"),
    },
    ["host"],
  ),

  salesforceTool(
    "query",
    "query",
    "Run a Salesforce SOQL query.",
    {
      instanceUrl: str("Salesforce instance URL"),
      soql: str("SOQL query"),
    },
    ["instanceUrl", "soql"],
  ),
  salesforceTool(
    "get_object",
    "get_object",
    "Fetch a Salesforce record by object type and ID.",
    {
      instanceUrl: str("Salesforce instance URL"),
      objectType: str("Salesforce object type, for example Account or Contact"),
      id: str("Record ID"),
    },
    ["instanceUrl", "objectType", "id"],
  ),
  salesforceTool(
    "create_object",
    "create_object",
    "Create a Salesforce record.",
    {
      instanceUrl: str("Salesforce instance URL"),
      objectType: str("Salesforce object type"),
      fields: obj("Field values"),
    },
    ["instanceUrl", "objectType", "fields"],
  ),
  salesforceTool(
    "update_object",
    "update_object",
    "Update a Salesforce record.",
    {
      instanceUrl: str("Salesforce instance URL"),
      objectType: str("Salesforce object type"),
      id: str("Record ID"),
      fields: obj("Field values"),
    },
    ["instanceUrl", "objectType", "id", "fields"],
  ),
  salesforceTool(
    "list_objects",
    "list_objects",
    "List available Salesforce objects.",
    {
      instanceUrl: str("Salesforce instance URL"),
    },
    ["instanceUrl"],
  ),
];

export const BROWSER_TOOLS: ToolDefinition[] = [
  tool(
    "browser_navigate",
    "browser.navigate",
    "Navigate the agent's browser page to a URL. A dedicated browser window is launched on first use and reused across calls.",
    {
      url: str("Full URL to navigate to"),
      waitFor: str("Wait condition: load | networkidle (default load)"),
    },
    ["url"],
  ),
  tool(
    "browser_click",
    "browser.click",
    "Click an element in the agent's browser page by CSS selector.",
    {
      selector: str("CSS selector to click"),
    },
    ["selector"],
  ),
  tool(
    "browser_type",
    "browser.type_text",
    "Type text into an input or textarea in the agent's browser page.",
    {
      selector: str("CSS selector of the input or textarea"),
      text: str("Text to type"),
    },
    ["selector", "text"],
  ),
  tool(
    "browser_screenshot",
    "browser.screenshot",
    "Capture a screenshot of the agent's browser page as a base64 PNG.",
    {
      fullPage: bool("Capture the full page instead of the viewport"),
    },
  ),
  tool(
    "browser_get_text",
    "browser.get_text",
    "Extract text from the agent's browser page, optionally scoped to a CSS selector.",
    {
      selector: str("CSS selector to scope extraction (omit for full-page text)"),
    },
  ),
  tool(
    "browser_evaluate",
    "browser.evaluate",
    "Evaluate JavaScript in the agent's browser page and return the result.",
    {
      script: str("JavaScript expression or function body to evaluate"),
    },
    ["script"],
  ),
];

// UI_TOOLS are always injected into the model's tool list and not user-toggleable.
export const UI_TOOLS: ToolDefinition[] = [
  tool(
    "question_card",
    "ui.question_card",
    "Present the user with a question and a set of choices. The agent pauses until the user selects an option. Use when a decision requires user input before proceeding — for example, choosing between package sources, confirming a configuration choice, or selecting a strategy.",
    {
      question: str("The question to ask the user"),
      options: arr(
        obj("", {
          key: str("Unique key returned when this option is selected"),
          label: str("Button label shown to the user"),
          description: str("Optional detail shown below the label to help the user decide"),
          preview: obj("Optional live UI preview rendered in a sandboxed iframe beside the option", {
            html: str("HTML document shell (optional); defaults to an empty white page"),
            code: str("JavaScript module code to execute in the preview; use DOM APIs to render UI into document.body"),
            height: num("Preview iframe height in pixels (optional, default 160)"),
          }, ["code"]),
        }, ["key", "label"]),
        "Two to four options for the user to choose from",
      ),
      context: str("Optional paragraph of context shown above the options"),
    },
    ["question", "options"],
  ),
];

export const GRAPH_TOOLS: ToolDefinition[] = [
  tool(
    "map_relationships",
    "graph.relationships",
    "Look up how one or more files relate on the Codebase Map: what each file imports, what imports it (imported-by), cross-service relationships (API calls, published/subscribed events, shared data/tables, config references) with the peer service and supporting evidence, and any working-memory notes attached to it. Use this to answer \"what are the relations of these files\", to find a change's blast radius before editing, or to discover which services share a database. Returns edges the map already computed from the workspace index — more reliable and cheaper than grepping for import structure. Pass workspace-relative paths (the same ids the map uses).",
    {
      path: str("Workspace-relative path of a single file to inspect"),
      paths: arr({ type: "string" }, "Multiple file paths to inspect at once (use instead of `path`)"),
      limit: num("Max entries per relationship category per file (default 50, max 200)"),
    },
  ),
  tool(
    "map_note_add",
    "graph.add",
    "Attach a working-memory note to the Codebase Map — either to a single file, or (when `to` is given) to a relation between two files (e.g. 'this button handler triggers this service'). Use a file note to record what you learned about it (its role, a gotcha, a non-obvious constraint); use a relation note for a meaningful non-import link worth showing spatially — event flows, IPC/message routes, config-to-consumer links. Before adding, call map_note_list on the file(s) — if a related note already exists, call map_note_update to refine it instead of creating a near-duplicate. Notes are displayed on the map, so keep them to one short sentence.",
    {
      from: str("Workspace-relative path of the file the note is about (or the relation's source file)"),
      to: str("Optional workspace-relative path of the relation's target file — omit for a single-file note"),
      note: str("Short note text, shown on the map"),
    },
    ["from", "note"],
  ),
  tool(
    "map_note_list",
    "graph.list",
    "List the working-memory notes currently attached to the Codebase Map, optionally filtered to those touching one file. Call this before map_note_add to check whether a related note already exists to update instead.",
    {
      path: str("Optional workspace-relative file path filter"),
    },
  ),
  tool(
    "map_note_update",
    "graph.update",
    "Merge new text into an existing map note (from map_note_add or map_note_list), replacing its content while keeping the prior text as a bounded revision history. Prefer this over map_note_add when a related note on the same file/relation already exists, so the map accumulates refined knowledge across runs instead of duplicate notes.",
    {
      id: str("Note id to update"),
      note: str("New note text, replacing the current text"),
    },
    ["id", "note"],
  ),
  tool(
    "map_note_remove",
    "graph.remove",
    "Remove a working-memory note from the Codebase Map by its id (from map_note_add or map_note_list).",
    {
      id: str("Note id to remove"),
    },
    ["id"],
  ),
];

export const ALL_TOOLS: ToolDefinition[] = [
  ...WORKSPACE_TOOLS,
  ...CODE_INTEL_TOOLS,
  ...PLANNING_TOOLS,
  ...GRAPH_TOOLS,
  ...DIAGNOSTICS_TOOLS,
  ...MEMORY_TOOLS,
  ...DATA_TOOLS,
  ...REFERENCE_TOOLS,
  ...GIT_TOOLS,
  ...TEST_TOOLS,
  ...WORKTREE_TOOLS,
  ...SUBAGENT_TOOLS,
  ...TRANSCRIPT_TOOLS,
  ...AGENT_MEMORY_TOOLS,
  ...RESULT_PAGING_TOOLS,
  ...SERVICE_TOOLS,
  ...BROWSER_TOOLS,
  ...UI_TOOLS,
];

const TOOL_DEFINITION_MAP: Record<string, ToolDefinition> = Object.fromEntries(
  ALL_TOOLS.map((toolDef) => [toolDef.name, toolDef]),
);

const LEGACY_TOOL_ROUTES: Array<Pick<ToolDefinition, "name" | "runtimeType" | "runtimePayload">> = [
  { name: "github_op", runtimeType: "service.github" },
  { name: "gitlab_op", runtimeType: "service.gitlab" },
  { name: "jira_op", runtimeType: "service.jira" },
  { name: "confluence_op", runtimeType: "service.confluence" },
  { name: "salesforce_op", runtimeType: "service.salesforce" },
];

const TOOL_ROUTE_MAP: Record<string, Pick<ToolDefinition, "runtimeType" | "runtimePayload">> = Object.fromEntries(
  [...ALL_TOOLS, ...LEGACY_TOOL_ROUTES].map((toolDef) => [
    toolDef.name,
    { runtimeType: toolDef.runtimeType, runtimePayload: toolDef.runtimePayload },
  ]),
);

export function resolveToolDispatch(
  toolName: string,
  input: Record<string, unknown>,
): { runtimeType: string; payload: Record<string, unknown> } {
  const route = TOOL_ROUTE_MAP[toolName];
  if (!route) return { runtimeType: toolName.replace(/_/g, "."), payload: input };
  return {
    runtimeType: route.runtimeType,
    payload: { ...input, ...(route.runtimePayload ?? {}) },
  };
}

export function validateToolInput(toolName: string, input: Record<string, unknown>): ToolInputValidationIssue[] {
  const toolDef = TOOL_DEFINITION_MAP[toolName];
  if (!toolDef) return [];

  const properties = toolDef.input_schema.properties ?? {};
  const required = toolDef.input_schema.required ?? [];
  const issues: ToolInputValidationIssue[] = [];

  for (const key of required) {
    const schema = properties[key] as Record<string, unknown> | undefined;
    const value = input[key];
    if (value === undefined || value === null) {
      issues.push({ path: key, kind: "missing_required", message: `${key} is required.` });
      continue;
    }
    if (schema?.["type"] === "string" && typeof value === "string" && value.trim() === "") {
      issues.push({ path: key, kind: "missing_required", message: `${key} is required.` });
    }
  }

  for (const [key, value] of Object.entries(input)) {
    const schema = properties[key] as Record<string, unknown> | undefined;
    if (!schema || value === undefined || value === null) continue;
    const expected = typeof schema["type"] === "string" ? String(schema["type"]) : "";
    if (!expected || matchesSchemaType(value, expected)) continue;
    issues.push({
      path: key,
      kind: "invalid_type",
      message: `${key} must be ${expected}.`,
    });
  }

  return issues;
}

function matchesSchemaType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string":
    case "number":
    case "boolean":
      return typeof value === expected;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}
