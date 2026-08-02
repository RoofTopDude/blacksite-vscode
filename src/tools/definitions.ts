/** One in-memory edit applied while building a mount preview. See src/preview-build.ts. */
export interface QCardPreviewPatch {
  file: string;
  find: string;
  replace: string;
  all?: boolean;
}

/** Renders a preview from the project's real component source rather than from hand-written DOM
 *  code. See src/preview-build.ts for why this exists. */
export interface QCardPreviewMount {
  entry: string;
  export?: string;
  props?: unknown;
  patch?: QCardPreviewPatch[];
  renderer?: "react" | "dom";
}

export interface QCardPreview {
  html?: string;
  /** Authored JS/TS module code. Optional when `mount` is supplied; the host bundles either form
   *  into this field before the preview reaches either rendering surface. */
  code?: string;
  /** Workspace-relative package/directory used to resolve imports in authored `code`. */
  resolveFrom?: string;
  mount?: QCardPreviewMount;
  /** CSS from a mount build's component-level imports; host-populated, never sent by the agent. */
  mountCss?: string;
  height?: number;
  /** Hint that this preview is complex/large enough to warrant opening full-page by default —
   *  agent discretion, on top of the UI's own size-based auto-expand heuristic. */
  expandHint?: boolean;
}

export interface QCardOption {
  key: string;
  label: string;
  description?: string;
  preview?: QCardPreview;
}

export interface QCardQuestion {
  question: string;
  options: QCardOption[];
  context?: string;
  multiSelect?: boolean;
  /** Stable identity for the thing being decided ("chat.message-bubble", "map.node-card"), used
   *  to persist the answer into .blacksite/ui-preferences.json and to supersede an earlier answer
   *  about the same element rather than stacking a second one beside it. Optional: a preview-
   *  bearing question is recorded either way, under a key derived from its text — the key only
   *  makes the identity survive rewording. */
  preferenceKey?: string;
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
  kind: "missing_required" | "invalid_type" | "invalid_enum";
  message: string;
}

type ToolProperties = Record<string, unknown>;

const str = (description: string) => ({ type: "string", description });
/** A string property constrained to a fixed set of values. The `enum` is both advertised
 *  to the model (so it's guided to a valid choice) and enforced by {@link validateToolInput}. */
const enumStr = (description: string, values: string[]) => ({ type: "string", description, enum: values });
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
    "Execute a one-shot command rooted in the current workspace and return stdout/stderr. Use for build, test, lint, install, and scripted tasks. " +
      "`command` is the executable only and `args` holds each argument separately (e.g. command \"npm\", args [\"run\",\"build\"]) — it is NOT a shell line, so pipes, redirects, &&/||/; chaining, globs, and $(…) are not interpreted. " +
      "To chain steps or use shell features, invoke a shell explicitly: command \"bash\", args [\"-lc\", \"cmd1 && cmd2\"] (or command \"cmd\", args [\"/c\", \"…\"] on Windows), or issue separate shell_run calls.",
    {
      command: str("Executable/binary to run (not a full shell line — no operators)"),
      args: arr({ type: "string" }, "Command arguments, one per array element"),
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
    "Read a workspace file. By default returns the first 2000 lines; there is no file-size limit — a large file is served a window at a time, so page through it with `offset` rather than re-reading it whole. " +
      "The result echoes `relativePath` (the workspace-relative id other tools use), `lines` (the file's TOTAL line count, not the window's), `startLine`/`endLine` (the window you're holding), and `hasMore`. " +
      "When `hasMore` is true you are looking at part of the file — read on with `offset: endLine + 1`, or jump straight to the region you need (file_search / code_symbols give you its line number) instead of paging from the top. " +
      "UTF-8/UTF-16 byte-order marks are decoded transparently (the result's `encoding`/`bom` fields flag non-plain-UTF-8 files). " +
      "Image files (.png/.jpg/.gif/.webp/.bmp) are returned as a real picture you can see, not text.",
    {
      path: str("Absolute file path or path relative to the workspace root"),
      offset: num("1-based line to start reading from (default 1). Use with the previous result's `endLine` to continue, or with a known line number to jump straight to a region."),
      limit: num("Maximum lines to return (default 2000, max 5000)"),
      lineNumbers: bool("Prefix each line with its number (default false). Useful for picking a line range to pass to code_replace/code_actions — but do NOT copy a numbered line into file_edit's oldString, since the prefix is not part of the file."),
      maxLineChars: num("Per-line character cap before clipping (default 2000, max 20000). When the result notice says lines were clipped, re-read with a larger maxLineChars and a small limit to see the full line — never copy a clipped line (marked \"… (line truncated)\") into file_edit."),
    },
    ["path"],
  ),
  tool(
    "file_edit",
    "editor.apply_edit",
    "Make a surgical edit to an existing file by replacing an exact string. Shows the user a side-by-side diff for approval before applying. Prefer this over file_write when modifying existing files. oldString must match the file exactly (including whitespace) and be unique unless replaceAll or expectedReplacements is set. Line-ending differences are handled for you: a \\n-style oldString matches CRLF files, and newString is written with the file's own line endings.",
    {
      path: str("File path, absolute or relative to the workspace root"),
      oldString: str("Exact text to replace, copied verbatim from the file including indentation. Must NOT include line-number prefixes — they are not part of the file. Use file_read's default (unnumbered) output, or a file_search hit's `text` field, which already excludes the \"path:line:\" prefix."),
      newString: str("Replacement text, exactly as it should appear in the file (no line-number prefixes)"),
      replaceAll: bool("Replace every occurrence instead of requiring a unique match (default false)"),
      expectedReplacements: num("Assert the exact number of locations oldString should match — the edit fails (changing nothing) if the real count differs, then replaces all of them. Use for refactors where you know the blast radius, instead of a blind replaceAll."),
    },
    ["path", "oldString", "newString"],
  ),
  tool(
    "file_move",
    "editor.rename_path",
    "Move or rename a file (or directory) through VS Code's rename pipeline, which lets language servers update import paths in every referencing file — unlike a shell `mv`, which silently breaks importers. Shows the operation for approval. Use this for any rename/move of source files; check the returned diagnostics afterwards.",
    {
      source: str("Existing path, absolute or relative to the workspace root"),
      destination: str("New path, absolute or relative to the workspace root"),
      overwrite: bool("Replace the destination if it already exists (default false)"),
    },
    ["source", "destination"],
  ),
  tool(
    "file_copy",
    "system.copy_path",
    "Copy a file or directory inside the workspace (recursive for directories). Refuses to replace an existing destination unless overwrite is set. The extension will request approval before applying the copy, like every other mutating file op. Use for scaffolding from a template instead of a read + write round-trip.",
    {
      source: str("Existing path, absolute or relative to the workspace root"),
      destination: str("Destination path, absolute or relative to the workspace root"),
      overwrite: bool("Replace the destination if it already exists (default false)"),
      confirmed: bool("Optional approval flag injected by the extension after the user approves the copy"),
    },
    ["source", "destination"],
  ),
  tool(
    "file_edit_batch",
    "editor.apply_edit_batch",
    "Apply multiple exact-string edits across one or more existing files in a single reviewed diff. Use for coordinated refactors where several surgical replacements should land together.",
    {
      edits: arr(
        obj("", {
          path: str("File path, absolute or relative to the workspace root"),
          oldString: str("Exact text to replace, copied verbatim from the file including indentation. Must NOT include line-number prefixes — they are not part of the file."),
          newString: str("Replacement text, exactly as it should appear in the file (no line-number prefixes)"),
          replaceAll: bool("Replace every occurrence instead of requiring a unique match"),
          expectedReplacements: num("Assert the exact number of locations this edit's oldString should match; fails without changing anything if the count differs, then replaces all of them"),
        }, ["path", "oldString", "newString"]),
        "Exact-string edits to apply together",
      ),
    },
    ["edits"],
  ),
  tool(
    "json_edit",
    "editor.json_edit",
    "Apply structural mutations to a plain-JSON file (package.json, tsconfig.json, .vscode/settings.json, and similar) by JSON Pointer path instead of matching exact text. Immune to the reformatting, key reordering, or stray whitespace differences that make file_edit's exact-string match fail on config files. Shows a diff for approval and returns diagnostics, like every other mutating tool. Only supports plain JSON — a file with // comments (JSONC) fails to parse; use file_edit for those.",
    {
      path: str("File path, absolute or relative to the workspace root"),
      operations: arr(
        obj("", {
          op: enumStr("Operation to apply at `pointer`.", ["set", "merge", "remove"]),
          pointer: str("RFC 6901 JSON Pointer to the target location, e.g. \"/scripts/build\" or \"/dependencies/react\" (empty string \"\" means the document root — only valid for merge). \"/foo/-\" appends to the array at /foo."),
          value: { description: "New value at `pointer` for set/merge — any JSON value (object, array, string, number, boolean, or null). Required for set/merge, omitted for remove. merge shallow-merges an object's keys into the existing value at `pointer` without disturbing its other keys; set replaces the value at `pointer` entirely." },
        }, ["op", "pointer"]),
        "Ordered structural operations to apply together in one diff",
      ),
    },
    ["path", "operations"],
  ),
  tool(
    "file_write",
    "system.write_file",
    "Write or overwrite a whole file inside the workspace with the provided content. Use for creating new files; prefer file_edit for changing existing files. To land a LARGE generated file, do not write it in one call — a long write can exceed the response output-token budget and truncate mid-file. Instead write the first chunk with mode 'overwrite', then continue with mode 'append' calls until done (each append result echoes the running `sizeBytes`). The extension will request approval before applying the write. The result includes `diagnostics` (language-server errors/warnings for the written file) — check it instead of making a separate code_diagnostics call.",
    {
      path: str("Absolute file path or path relative to the workspace root"),
      content: str("File content to write (or the next chunk, with mode 'append')"),
      mode: enumStr("'overwrite' (default) replaces the whole file; 'append' adds content to the end — use it to land large files in chunks.", ["overwrite", "append"]),
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
    "Glob files under a directory. Supports **, *, ?, and character ranges. Results are sorted most-recently-modified first, so the files a task is actually about surface at the top. Excludes node_modules, .git, dist, and similar directories by default; the result's `skipped` field reports when excluded or depth-limited directories were pruned, so an empty result is never silently non-exhaustive.",
    {
      path: str("Root directory to search"),
      pattern: str("Glob pattern, for example '**/*.ts' or 'src/**/*.{ts,tsx}'"),
      maxResults: num("Maximum results (default 200, max 1000)"),
      includeExcluded: bool("Also descend into the default-excluded directories (node_modules, dist, …) — e.g. when locating a file inside a dependency (default false)"),
      extraExcludes: arr({ type: "string" }, "Additional directory names to prune (e.g. ['target', 'build'])"),
    },
    ["path", "pattern"],
  ),
  tool(
    "file_search",
    "system.search_files",
    "Search file contents with a regex pattern. Returns the file, line number, and matching text for each hit (plus surrounding lines when `contextLines` is set). " +
      "Pass a directory to search a tree, or a single file path to search just that file. " +
      "Use `outputMode` to control cost: 'content' (default) returns matching lines; 'files_with_matches' returns only the paths (cheap way to find where something lives before reading); 'count' returns per-file tallies (cheap way to size a refactor's blast radius). " +
      "A `skipped` field in the result means the scan was NOT exhaustive (over-size files, depth-pruned or excluded directories) — treat 'no matches' as unproven and widen with maxFileBytes/includeExcluded when it matters.",
    {
      path: str("Directory to search recursively, or a single file to search just that file"),
      pattern: str("Regex pattern to search for"),
      caseSensitive: bool("Case-sensitive search (default false)"),
      include: str("Optional file filter — a glob ('*.ts', '**/*.spec.ts') or a plain substring ('service')"),
      outputMode: enumStr("What to return.", ["content", "files_with_matches", "count"]),
      contextLines: num("Lines of surrounding context to include before/after each match (0-10, default 0). Applies to outputMode 'content'."),
      multiline: bool("Let the pattern span multiple lines (`.` matches newlines). Default false — the scan is line-by-line."),
      maxResults: num("Maximum results (default 100, max 500)"),
      maxFileBytes: num("Per-file size cap in bytes (default 524288, max 8388608). Raise it to search bundled/generated files the default cap skips — the result's skipped.largeFiles reports how many were passed over."),
      includeExcluded: bool("Also search inside the default-excluded directories (node_modules, dist, …) (default false)"),
      extraExcludes: arr({ type: "string" }, "Additional directory names to prune (e.g. ['target', 'build'])"),
    },
    ["path", "pattern"],
  ),
  tool(
    "mcp_list_tools",
    "mcp.list_tools",
    "List available tools from an enabled MCP server configured by the user. Use the server ID shown in workspace context.",
    {
      serverId: str("Configured MCP server ID from workspace context"),
    },
    ["serverId"],
  ),
  tool(
    "mcp_call_tool",
    "mcp.call_tool",
    "Call a tool on an MCP server. Use mcp_list_tools first to discover the tool name and argument schema.",
    {
      serverId: str("Configured MCP server ID from workspace context"),
      toolName: str("Tool name from mcp_list_tools"),
      args: obj("Tool arguments matching the target tool schema"),
    },
    ["serverId", "toolName"],
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
    rootId: str("Workspace-root identifier returned by a prior code_* result; required when the same relative path exists in multiple roots"),
    symbol: str("Symbol to locate by name, for example 'fetchModels' or 'ChatProvider.send' (preferred targeting)"),
    kind: str("Optional kind to disambiguate a symbol: function | method | class | interface | variable | property | constant | enum"),
    line: num("1-based line number (used when symbol is omitted)"),
    column: num("1-based column (optional, with line)"),
    matchText: str("Substring occurring on `line`; the exact column is located from it (robust alternative to column)"),
    firstMatch: bool("Read operations only: use the first symbol match. Mutating tools reject this and require exact disambiguation."),
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
      position: enumStr("Where to insert relative to the target.", ["before", "after", "start", "end"]),
      text: str("Text to insert exactly as provided"),
    },
    ["target", "position", "text"],
  ),
  tool(
    "code_replace",
    "lsp.replace",
    "Replace a symbol's complete language-server range — or an explicit line range — with new text. A symbol range commonly includes its declaration as well as its body. Shows the diff for approval and returns diagnostics.",
    {
      target: codeTarget,
      endLine: num("Only used when target has no `symbol` (a line-only target): extends the replacement through this 1-based line, inclusive, instead of just the anchor line. Ignored when targeting by symbol — the language server's own range is used."),
      text: str("Replacement text for the resolved range"),
    },
    ["target", "text"],
  ),
  tool(
    "code_replace_batch",
    "lsp.replaceBatch",
    "Replace several symbols' bodies — or explicit line ranges — across one or more files in a single reviewed diff, each targeted and resolved independently exactly like code_replace. Use this for a coordinated refactor where multiple symbol-targeted rewrites (different new bodies for different symbols) should land together, instead of one code_replace call and approval per symbol. Edits within the same file must not target overlapping ranges. Returns diagnostics for every touched file, like every other mutating code_* tool.",
    {
      edits: arr(
        obj("", {
          target: codeTarget,
          endLine: num("Only used when this edit's target has no `symbol`: extends the replacement through this 1-based line, inclusive."),
          text: str("Replacement text for this edit's resolved range"),
        }, ["target", "text"]),
        "Symbol/line-targeted replacements to apply together",
      ),
    },
    ["edits"],
  ),
  tool(
    "code_symbols",
    "lsp.symbols",
    "List code symbols using the language server. With `path`, returns the document's symbol tree (functions, classes, methods). With `query`, searches symbols across the whole workspace. Use this to map a file or find where something is defined.",
    {
      path: str("File path for a document symbol tree (omit to search the workspace)"),
      rootId: str("Workspace-root identifier when `path` is ambiguous in a multi-root workspace"),
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
      kind: enumStr("Relationship to resolve.", ["definition", "typeDefinition", "declaration", "implementation", "references"]),
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
        kind: enumStr("Hierarchy direction to trace.", ["callers", "callees", "supertypes", "subtypes"]),
        depth: num("Traversal depth from 1 to 4 (default 1). Results include a bounded, cycle-safe node/edge graph."),
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
    "Read diagnostics published to VS Code. File results report freshness; workspace results report published-cache coverage and remain partial unless every relevant file has been analyzed. Use compiler, linter, and test tools for definitive whole-project verification.",
    {
      path: str("File path to scope diagnostics (omit for the whole workspace)"),
        rootId: str("Workspace-root identifier when `path` is ambiguous in a multi-root workspace"),
        severity: enumStr("Minimum severity to include (includes that level and more severe).", ["error", "warning", "info", "hint"]),
        limit: num("Max problems to return (default 100, max 500)"),
        activateWorkspace: bool("Explicitly open a bounded set of source files before collecting workspace diagnostics. More complete than the published cache, but still not a compiler/test guarantee."),
        activationLimit: num("Maximum source files to activate when activateWorkspace is true (default 200, max 500)."),
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
    "List or apply the language's own quick-fixes and refactors for a range. Omit `apply` to receive stable action IDs; pass a returned `actionId` (preferred) or an exact unique title to apply. Prefixes are never auto-selected. Text edits are diffed; command-backed portions require explicit approval.",
    {
      path: str("File path"),
      rootId: str("Workspace-root identifier when `path` is ambiguous in a multi-root workspace"),
      line: num("1-based line number where the action applies"),
      endLine: num("1-based end line for a multi-line range (defaults to line)"),
      only: str("Optional kind filter, for example 'quickfix', 'refactor', or 'source.organizeImports'"),
      apply: str("Stable actionId from a listing call (preferred), or an exact unique action title; omit to list actions"),
    },
    ["path", "line"],
  ),
  tool(
    "code_format",
    "lsp.format",
    "Format a file (or a line range) with the configured formatter, shown as a diff for approval. Use after editing instead of hand-aligning whitespace.",
    {
      path: str("File path"),
      rootId: str("Workspace-root identifier when `path` is ambiguous in a multi-root workspace"),
      range: obj("Optional line range to format", { startLine: num("1-based start line"), endLine: num("1-based end line") }, ["startLine", "endLine"]),
    },
    ["path"],
  ),
  tool(
    "code_inlay_hints",
    "lsp.inlayHints",
    "Get inferred type and parameter-name inlay hints for a file or line range from the language server. Useful for understanding untyped or dynamically-typed code (Python, JS) where types aren't visible in the source text.",
    {
      path: str("File path"),
      rootId: str("Workspace-root identifier when `path` is ambiguous in a multi-root workspace"),
      range: obj("Optional line range to scope the hints (defaults to the whole file)", { startLine: num("1-based start line"), endLine: num("1-based end line") }, ["startLine", "endLine"]),
      limit: num("Max hints to return (default 100, max 500)"),
    },
    ["path"],
  ),
];

const PLAN_STEP_SHAPE = {
  title: str("Step title"),
  detail: str("Optional implementation detail or verification note"),
  acceptanceCriteria: str("Optional definition-of-done for this specific step"),
  maxIterations: num("Optional cap (2-6) on inline self-review passes for this step. Set it when the step is genuinely unlikely to be right on the first pass — ambiguous UX, tricky logic, something worth a second look — not for mechanical one-shot edits. When set, don't mark the step completed after a single attempt: check the result against acceptanceCriteria, refine, and repeat up to the cap, logging what changed each pass with stepNote; if you exhaust the cap without meeting the bar, mark it blocked (not completed) and say why in stepNote."),
};

const PLAN_BLOCK_SHAPE = {
  kind: str("Block kind. Recommended vocabulary: findings (research/investigation results), open_questions (things still unresolved), options_considered (alternatives weighed and why one was picked — for when there were 3+ real options worth recording beyond the single `rationale` field), deliverables (what ships and in what form), rollout_plan (cutover/deployment sequencing), rollback_plan (how to undo if it goes wrong), or custom for anything else. Unrecognized values are stored as custom, never rejected."),
  label: str("Optional heading override, shown instead of the title-cased kind. Effectively required for kind 'custom' — it's the only thing distinguishing one custom block from another."),
  body: str("Block content"),
};

const PLAN_PHASE_SHAPE = {
  title: str("Phase title"),
  objective: str("Optional objective for this phase"),
  rationale: str("Optional design rationale for this phase — why this approach over alternatives you considered. Durable and cross-session, unlike chat text, so a later session doesn't have to re-derive or re-litigate the decision blind"),
  risks: str("Optional current risk or consideration note for this phase"),
  dependsOn: arr({ type: "string" }, "Optional phase IDs this phase assumes are already done (informational only, not enforced)"),
  acceptanceCriteria: arr({ type: "string" }, "Optional definition-of-done bullets for this phase"),
  complexity: str("Optional coarse effort hint: small | medium | large"),
  files: arr({ type: "string" }, "Optional map territory: the workspace-relative files this phase expects to touch, as Codebase Map ids (e.g. 'src/graph/layout.ts'). Set it once you know the surface area — usually right after map_relationships/map_impact on the phase's entry points. It is carried in the plan summary you see on every later turn, so a resumed session goes straight from 'which phase am I on' to the files, instead of re-deriving them from the objective. Declarative intent, not a restriction: touching something outside the list is fine, and worth updating the list to reflect."),
  blocks: arr(obj("", PLAN_BLOCK_SHAPE, ["kind", "body"]), "Optional modular content blocks scoped to this phase — attach only the kinds this phase actually needs (see plan_create's description)."),
  steps: arr(obj("", PLAN_STEP_SHAPE, ["title"]), "Ordered steps in this phase"),
};

export const PLANNING_TOOLS: ToolDefinition[] = [
  tool(
    "plan_create",
    "planning.create",
    "Create a persistent phased plan for the current task or project slice. Use for multi-phase work where the user should be able to see objectives, current focus, and remaining phases across conversations. For plans with more than 2-3 phases, prefer creating the plan with just the first phase or two, then extend it with plan_update's addPhases once you've made progress — early phases are usually wrong before you've seen the codebase, and authoring every phase up front commits you to guesses before you have the evidence to make them well. Before creating a plan for anything nontrivial or ambiguous, check for genuine open forks — competing approaches, unclear scope, an unspecified deliverable shape, what kind of outcome the user actually wants out of this — and ask via question_card rather than guessing; for a structural or visual fork (comparing layouts, output formats, phase structures), render the candidates in question_card's preview instead of describing them in prose. Not every plan needs the same shape: use `blocks` (and per-phase `blocks`) to assemble the sections this specific plan calls for — a research spike might carry findings/open_questions, a migration might carry rollout_plan/rollback_plan — instead of defaulting every plan to bare phases and steps. Phase and step order communicates the intended shape, but it is not an execution lock: work whichever phase or step is appropriate for the evidence and satisfied dependencies, and set activePhaseId plus its status so the plan reflects that focus. Creating a plan does not authorize you to start building it: unless the user has explicitly told you to proceed, leave executionApproved off — author and refine the plan, research, write plan docs, and ask clarifying questions, but wait for the user to approve execution (they click \"Approve execution\" in the Plans panel) before you begin implementing.",
    {
      title: str("Plan title"),
      summary: str("Short summary of the overall objective"),
      status: str("Optional initial status: draft | active"),
      executionApproved: bool("Set true ONLY if the user has already explicitly told you to go ahead and implement (e.g. 'just build it', 'you don't need to check with me first'). Default false — after creating a plan you may keep refining it, researching, writing docs, and asking questions, but must NOT advance steps/phases to in_progress/completed until the user approves execution (the 'Approve execution' button in the Plans panel) or you grant it later via plan_update's executionApproved once they say so."),
      agentCanArchive: bool("Set true ONLY if the user has explicitly said you may archive this plan yourself once it's done (e.g. 'archive it when you're finished', 'you don't need to ask'). Default false — the user archives plans themselves from the Plans panel. You can grant this later via plan_update instead if permission comes up mid-conversation rather than at creation."),
      blocks: arr(obj("", PLAN_BLOCK_SHAPE, ["kind", "body"]), "Optional modular content blocks scoped to the whole plan (e.g. deliverables, open_questions) rather than one phase."),
      phases: arr(obj("", PLAN_PHASE_SHAPE, ["title"]), "Ordered phases for this plan"),
    },
    ["title", "phases"],
  ),
  tool(
    "plan_update",
    "planning.update",
    "Update an existing plan: move execution focus, advance status, edit phases/steps, append notes, add/remove/reorder phases and steps, move a step to a different phase, and add/remove modular blocks. Prefer this over recreating a plan when scope changes. Status fields accept natural synonyms (e.g. 'in progress', 'done', 'paused') — they are normalized. Do not modify plans the user has put on hold or cancelled unless they resume them. When extending a plan phase-by-phase, add a phaseNote or stepNote explaining what you learned before adding the next phase — that reasoning is what makes incremental planning worth doing instead of just batching everything up front. This is where ongoing progress on a plan belongs: as you complete work, advance phaseStatus/stepStatus and add notes here directly, rather than tracking it in a separate todo_create run and letting the plan itself go stale. Before adding a substantial new phase batch (addPhases), the same question_card guidance from plan_create applies — check for open forks before committing to a direction. blocks/phaseBlocks upsert: a block whose kind+label matches an existing one replaces it instead of duplicating, so re-adding a 'findings' block updates it in place. Any phase or step may be worked when its real dependencies and current evidence permit it; order is informative, not enforced. Set activePhaseId to the phase you choose and keep its phase/step statuses current. phaseStatus:'completed' is accepted only after that phase's steps are completed, so a contradictory roll-up never silently overwrites detailed progress. status:'archived' is normally rejected — it only succeeds if the user already granted this plan agentCanArchive (set at plan_create, or via agentCanArchive here) because they explicitly said you could archive it yourself; otherwise archiving is the user's own action from the Plans panel. Execution gate: until this plan is execution-approved, plan_update refuses to advance any step or phase to in_progress/completed — the user approves execution from the Plans panel, or tells you to proceed (in which case set executionApproved:true, optionally on the same call that starts the first step). Editing the plan's shape (add/remove/reorder phases and steps, notes, rationale, blocks) and writing docs stay allowed while unapproved.",
    {
      planId: str("Plan ID returned by plan_create or plan_list"),
      title: str("Optional new plan title"),
      summary: str("Optional new plan summary"),
      status: str("Optional plan status: draft | active | on_hold | completed | blocked | cancelled | archived (archived requires agentCanArchive — see above)"),
      executionApproved: bool("Optional — set true only when the user has just explicitly told you to go ahead and start implementing this plan; set false to pause execution again. Until it's true, advancing any step/phase to in_progress/completed is rejected. The user can also toggle this from the Plans panel."),
      agentCanArchive: bool("Optional — set true only when the user has just explicitly granted you permission to archive this plan yourself; set false to give that permission back up (though the user can always do this from the Plans panel too)."),
      note: str("Optional plan-level note to append"),
      blocks: arr(obj("", PLAN_BLOCK_SHAPE, ["kind", "body"]), "Optional new/updated plan-level blocks (upsert by kind+label)"),
      removeBlockId: str("Optional plan-level block ID to remove"),
      activePhaseId: str("Optional phase ID to make the current execution focus. Any non-completed phase may be selected; phase order does not restrict this."),
      addPhases: arr(obj("", PLAN_PHASE_SHAPE, ["title"]), "Optional new phases to append to the plan"),
      insertPhaseBeforeId: str("Optional existing phase ID — when set, addPhases are inserted immediately before this phase instead of appended to the end"),
      removePhaseId: str("Optional phase ID to remove from the plan"),
      reorderPhaseIds: arr({ type: "string" }, "Optional full reordering of this plan's phase IDs — must include every existing phase ID exactly once"),
      phaseId: str("Optional target phase ID (for phase edits / addSteps / removeStepId / reorderStepIds)"),
      phaseTitle: str("Optional new phase title"),
      phaseObjective: str("Optional new phase objective"),
      phaseStatus: str("Optional phase status: pending | in_progress | completed | blocked"),
      phaseNote: str("Optional phase note to append"),
      phaseRationale: str("Optional new design rationale for the target phase — why this approach over alternatives you considered"),
      phaseRisks: str("Optional new current risk or consideration note for the target phase"),
      phaseDependsOn: arr({ type: "string" }, "Optional replacement list of phase IDs the target phase assumes are already done"),
      phaseAcceptanceCriteria: arr({ type: "string" }, "Optional replacement definition-of-done bullets for the target phase"),
      phaseComplexity: str("Optional coarse effort hint for the target phase: small | medium | large"),
      phaseFiles: arr({ type: "string" }, "Optional replacement map territory for the target phase — the workspace-relative files it expects to touch (see the phase `files` field). Send the full intended list; it replaces the previous one. Worth updating whenever investigation changes the phase's real surface area, since this is what the plan summary shows you on later turns."),
      phaseBlocks: arr(obj("", PLAN_BLOCK_SHAPE, ["kind", "body"]), "Optional new/updated blocks for the target phase (upsert by kind+label)"),
      removePhaseBlockId: str("Optional phase-level block ID to remove from the target phase"),
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
      stepMaxIterations: num("Optional cap (2-6) on inline self-review passes for the target step; 0 clears it. Set it when the step is genuinely unlikely to be right on the first pass, not for mechanical one-shot edits — see the step maxIterations field description above for the full loop discipline."),
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
    "Create a transient checklist to break down what you're doing right now into concrete sub-steps — impromptu tactical scratch space, not a second tracker. Use it for a single step or investigation that needs 3+ concrete sub-actions, not for the plan's phases as a whole: a plan phase already has its own status and notes, so don't spin up one todo_create run per phase and let that become the thing you actually maintain. If you link planId/phaseId, the link is reference-only: todo updates never advance, complete, or block the plan. Keep logging real progress on the plan itself via plan_update's phaseStatus/stepStatus/notes; the todo run is a short-lived aid, not a replacement for updating the plan. A linked plan and phase must both exist and must not be on hold, cancelled, or archived.",
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
  tool(
    "plan_doc_write",
    "planning.docWrite",
    "Create or update a full-length markdown documentation doc attached to a plan or one of its phases — research findings, a design/decision writeup, a spec, or freeform notes worth preserving. Unlike plan_update's `blocks` (short blurbs meant to stay inline in your own prompt context), this is for real documentation: it persists on disk in the project until the user deletes it, and you read it back on demand with plan_doc_read rather than it riding along in every plan_list call. Pass `docId` (from a prior plan_doc_write/plan_doc_list result) to update an existing doc in place instead of creating a new one; omit phaseId to attach at the plan level.",
    {
      planId: str("Plan ID returned by plan_create or plan_list"),
      phaseId: str("Optional phase ID to scope this doc to one phase instead of the whole plan"),
      docId: str("Optional existing doc ID to update instead of creating a new one"),
      kind: str("Doc kind: research (investigation/findings), reference, decision (design rationale/ADR), notes, spec, or custom. Unrecognized values are stored as custom, never rejected."),
      title: str("Doc title"),
      body: str("Markdown content, up to ~50,000 characters"),
    },
    ["planId", "kind", "title", "body"],
  ),
  tool(
    "plan_doc_read",
    "planning.docRead",
    "Read the full markdown content of one documentation doc attached to a plan or phase, by id. Use plan_doc_list or plan_list first to find valid doc IDs.",
    {
      planId: str("Plan ID"),
      docId: str("Doc ID"),
    },
    ["planId", "docId"],
  ),
  tool(
    "plan_doc_list",
    "planning.docList",
    "List the documentation docs attached to a plan (and, if phaseId is given, just that one phase) — metadata only (title, kind, size, timestamps). Use plan_doc_read for full content.",
    {
      planId: str("Plan ID"),
      phaseId: str("Optional — scope the listing to one phase instead of the whole plan"),
    },
    ["planId"],
  ),
];

export const TICKET_TOOLS: ToolDefinition[] = [
  tool(
    "ticket_file",
    "tickets.file",
    "File a unit of work into the project's local ticket queue. Use this the moment you notice real work that is OUTSIDE the scope of what you were asked to do — a bug, a missing test, a fragile assumption, a TODO that matters — instead of widening your current task, or mentioning it only in chat where it is lost to compaction. Filing is cheap and correct mid-task: file it, then carry on with what you were actually doing. A ticket records an OUTCOME, not a procedure: it has no steps, no checklist, and no progress field, because progress belongs to a plan (see ticket_promote). Set `files`/`areas` to what it concerns so it is locatable on the Codebase Map and joinable to plan territory — `areas` is right when the concern is a whole directory ('src/graph' covers everything under it) and avoids enumerating files that will be stale next month. Before filing, call ticket_list on the same area: if a near-duplicate exists, call ticket_update to sharpen it rather than creating a second one. Do NOT file a ticket for work you are about to do in this turn — just do it.",
    {
      title: str("One line stating the outcome, not the activity. 'Retry backoff drifts from gateway TTL', not 'look into retry stuff'."),
      description: str("Optional Markdown body: what is wrong or missing, why it matters, and what done looks like. Renders as Markdown, so a `src/foo.ts:42` link becomes clickable."),
      priority: enumStr("Optional priority (default normal)", ["urgent", "high", "normal", "low"]),
      complexity: enumStr("Optional coarse effort hint. Deliberately not a numeric estimate.", ["small", "medium", "large"]),
      complexityBasis: str("Optional one clause on why that complexity, e.g. 'touches the serialized cache format'."),
      acceptanceCriteria: arr({ type: "string" }, "Optional definition-of-done bullets: the observable conditions that make this ticket satisfied. State outcomes you could check ('retry ceiling is read from the gateway TTL, not a constant'), never steps to perform — a ticket has no procedure, and the plan you promote it into is where sequencing belongs. This is the bar you check your own work against before moving the ticket to 'review'."),
      labels: arr({ type: "string" }, "Optional short tags, normalized to kebab-case. Call ticket_list first and reuse an existing label rather than coining a near-duplicate."),
      files: arr({ type: "string" }, "Optional workspace-relative Codebase Map ids this ticket concerns, e.g. 'src/graph/layout.ts'."),
      areas: arr({ type: "string" }, "Optional directory prefixes this ticket concerns, e.g. 'src/graph'. Prefer an area over enumerating many files under it."),
      references: arr(obj("", {
        url: str("An https:// URL or a workspace-relative path"),
        title: str("Optional short label for the link"),
      }, ["url"]), "Optional outward pointers: an upstream issue, a spec, a PR, a design doc. For files this ticket is ABOUT, use `files`/`areas` instead — those resolve against the Codebase Map and this does not."),
      relatedTo: arr({ type: "string" }, "Optional ticket ids this one is associated with. The reverse side is written automatically."),
      blockedBy: arr({ type: "string" }, "Optional ticket ids that must close first. Informational, never enforced."),
      duplicateOf: str("Optional id of an existing ticket this duplicates. Prefer ticket_update on the original when you notice the overlap before filing."),
      assignee: enumStr("Who owns the outcome. Leave unset unless the user said whose it is — do not assign yourself work they haven't handed you.", ["unassigned", "user", "agent"]),
      origin: enumStr("Where this came from. Defaults to 'agent'.", ["agent", "user", "map_note", "diagnostic", "review"]),
      originRef: str("Optional id of the source — a map note id, a diagnostic key — when origin is not 'agent'."),
      status: enumStr("Optional starting status. Agent-filed tickets land in 'triage' by default so the user can accept them.", ["triage", "backlog"]),
    },
    ["title"],
  ),
  tool(
    "ticket_update",
    "tickets.update",
    "Update one ticket, field by field — pass ticketId plus only what you are changing. A ticket LINKED TO A PLAN takes its status from that plan automatically: do not maintain progress here and in plan_update both. Setting `status` by hand detaches the ticket from its plan's status until you re-link it, so prefer advancing the plan and letting the ticket follow. Setting `planId` links a plan and hands status derivation back to it — that is what you call after plan_create when starting work on a ticket. Moving a ticket to 'done' is normally the user's action; you may move it to 'review' when the work is finished and awaiting their verification.",
    {
      ticketId: str("Ticket id, e.g. 'BLK-12'"),
      title: str("Optional new title"),
      description: str("Optional new Markdown body (replaces the current one)"),
      status: enumStr("Optional new status. 'done' is normally user-only — use 'review' when work is finished.", ["triage", "backlog", "in_progress", "blocked", "review", "done", "cancelled"]),
      priority: enumStr("Optional new priority", ["urgent", "high", "normal", "low"]),
      complexity: enumStr("Optional new complexity", ["small", "medium", "large"]),
      complexityBasis: str("Optional new one-clause basis for the complexity"),
      acceptanceCriteria: arr({ type: "string" }, "Optional replacement definition-of-done bullets (replaces, not merges). Sharpening these on a vague ticket before you start is usually worth more than any other edit you can make to it."),
      labels: arr({ type: "string" }, "Optional replacement label list (replaces, not merges)"),
      files: arr({ type: "string" }, "Optional replacement file territory (replaces)"),
      areas: arr({ type: "string" }, "Optional replacement area territory (replaces)"),
      references: arr(obj("", {
        url: str("An https:// URL or a workspace-relative path"),
        title: str("Optional short label for the link"),
      }, ["url"]), "Optional replacement list of outward reference links (replaces, not merges)"),
      assignee: enumStr("Optional new owner. Move a ticket to 'agent' only when the user hands it to you.", ["unassigned", "user", "agent"]),
      planId: str("Optional plan id to link — hands status derivation to that plan. Pass an empty string to unlink."),
      phaseId: str("Optional phase id, when one phase rather than the whole plan satisfies this ticket"),
      blockedBy: arr({ type: "string" }, "Optional replacement list of blocking ticket ids"),
      blocks: arr({ type: "string" }, "Optional replacement list of ticket ids THIS ticket blocks — the same edge written from the other end. The matching blockedBy is maintained for you; set whichever direction you actually learned."),
      relatedTo: arr({ type: "string" }, "Optional replacement list of related ticket ids. The reverse side is written automatically."),
      duplicateOf: str("Optional id of the ticket this duplicates. Pass an empty string to clear. Mark the duplicate and cancel it rather than deleting — the duplicate often holds the better description."),
      note: str("Optional short note appended to the ticket's activity timeline"),
    },
    ["ticketId"],
  ),
  tool(
    "ticket_get",
    "tickets.get",
    "Read one ticket in full: its description, acceptance criteria, relations, resolved map territory, and its entire activity timeline including every comment. ticket_list gives you the shape of the queue; this gives you the story of one item. Call it before starting work on a ticket someone else (or an earlier session) filed — the comments are where the investigation that has already happened lives, and repeating it is the most common way a session wastes its first ten turns.",
    {
      ticketId: str("Ticket id, e.g. 'BLK-12'"),
    },
    ["ticketId"],
  ),
  tool(
    "ticket_list",
    "tickets.list",
    "List tickets in the project queue. Call this before filing a new one (to update a near-duplicate instead), before starting unprompted work in an area (to see what is already known), and when the user asks what is outstanding. Defaults to open tickets only. The response carries `matched` (how many satisfied the filter) and `nextOffset` (present only when more remain) — check them rather than assuming one page was the whole queue.",
    {
      query: str("Optional free text, matched against id, title, description, labels, acceptance criteria, and territory. All terms must appear. This is the right filter when you know roughly what the ticket says but not where it lives."),
      status: enumStr("Optional exact status filter", ["triage", "backlog", "in_progress", "blocked", "review", "done", "cancelled"]),
      priority: enumStr("Optional priority filter", ["urgent", "high", "normal", "low"]),
      assignee: enumStr("Optional owner filter. 'agent' is the work the user has handed to you.", ["unassigned", "user", "agent"]),
      label: str("Optional label filter"),
      area: str("Optional directory prefix filter, e.g. 'src/graph' — matches tickets scoped to that area or to any file under it"),
      file: str("Optional exact file filter — matches tickets naming that file or an area containing it"),
      planId: str("Optional linked-plan filter"),
      openOnly: bool("Only open tickets (default true; ignored when an exact status is given)"),
      rankBy: enumStr("Optional ranking: 'priority' (urgent first, then most recent) or 'recent'", ["priority", "recent"]),
      limit: num("Maximum tickets to return (default 25, max 100)"),
      offset: num("Skip this many matches before the page. Pass the previous response's `nextOffset` to continue; narrowing the filter is usually better than paging."),
    },
  ),
  tool(
    "ticket_comment",
    "tickets.comment",
    "Leave a comment on a ticket's activity timeline. This is where investigation findings belong: root causes, dead ends you ruled out, evidence with file references. A later session — or you, after compaction — will look for that reasoning on the ticket, not in a chat transcript it can no longer see. Use it to record progress on a ticket you are investigating BEFORE a plan exists, which is the gap between filing something and starting it. Comments are Markdown and are never auto-pruned.",
    {
      ticketId: str("Ticket id, e.g. 'BLK-12'"),
      body: str("Markdown comment body, up to ~4,000 characters"),
    },
    ["ticketId", "body"],
  ),
  tool(
    "ticket_next",
    "tickets.next",
    "Ask the queue what to pick up next. Returns ranked candidates, each carrying the factors that produced its position (priority, blocked state, complexity, how long it has sat untouched) so you can state a defensible reason for the choice rather than asserting one. Blocked tickets are reported separately rather than hidden — 'everything is blocked on BLK-9' is a different answer from 'there is nothing to do', and the two should not be confused. Use it when the user asks what to work on, or when you finish a plan and there is no obvious next task.",
    {
      area: str("Optional directory prefix to restrict the answer to, e.g. 'src/graph'"),
      limit: num("How many candidates to return (default 3, max 10)"),
    },
  ),
  tool(
    "ticket_promote",
    "tickets.promote",
    "Turn a ticket into the seed for a plan. Call this when you are about to START work on a ticket: it returns the ticket's title, body, and resolved map territory, so the plan begins with real files instead of a guess. The seed is close to plan_create's shape but not identical — map it: `title`/`summary` go straight through, `firstPhaseFiles` becomes the first phase's `files`, and `acceptanceCriteria`/`complexity` belong on that phase, not the plan. `labels` and `references` have no plan equivalent; leave them on the ticket, or carry the references into a plan block if the plan needs them. Then call ticket_update with the new planId so the ticket's status follows the plan from then on. The plan becomes the execution record; the ticket stays the durable outcome.",
    {
      ticketId: str("Ticket id to promote, e.g. 'BLK-12'"),
    },
    ["ticketId"],
  ),
  tool(
    "ticket_sweep",
    "tickets.sweep",
    "Propose triage tickets from published warnings/errors and TODO/FIXME/XXX/BUG markers already present in the workspace. This never files tickets: it is a bounded, deduplicated suggestion pass, so the queue cannot fill itself. Review the returned proposals with the user; only file the ones they accept, into status 'triage' with the supplied stable key as originRef (`sweep:<key>`). Use this for a deliberate backlog sweep, not before every edit.",
    {
      area: str("Optional directory prefix to scan, e.g. 'src/graph'"),
      includeMarkers: bool("Scan TODO/FIXME/XXX/BUG markers (default true)"),
      includeDiagnostics: bool("Include VS Code warning/error diagnostics (default true)"),
      testFailures: arr(obj("", {
        file: str("Workspace-relative failing test or source file"),
        message: str("Failure assertion/message from a preceding test_run"),
        line: num("Optional 1-based failure line"),
        source: str("Optional test runner/framework"),
      }, ["file", "message"]), "Optional concrete failures from a preceding test_run. The sweep does not run tests itself."),
      limit: num("Maximum proposals to return (default 25, max 100)"),
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
      op: enumStr("Operation to perform.", ["status", "diff", "log", "add", "restore", "commit", "checkout", "branch", "stash", "push"]),
      cwd: str("Sub-directory within workspace root (optional)"),
      path: str("File path for diff, log, add, or restore"),
      staged: bool("For diff: show --cached. For restore: unstage instead of discard"),
      all: bool("For add: stage all. For commit: commit all"),
      message: str("Commit message or stash message"),
      author: str("Author override for commit, for example 'Name <email>'"),
      limit: num("For log: number of commits (default 20, max 200)"),
      branch: str("Branch name for checkout or push"),
      create: bool("For checkout: create new branch"),
      action: enumStr("For branch: list | create | delete. For stash: push | pop | list.", ["list", "create", "delete", "push", "pop"]),
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
      op: enumStr("Operation to perform.", ["create", "remove", "list"]),
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
      SUBAGENT_SPAWN_TOOL_DESCRIPTION_HINT + " The subagent runs its own conversation with fresh context and tools, then returns a synthesized answer. Include all necessary context in the task because the delegated lane cannot see the parent conversation. If this lane is doing the work for one specific step of a tracked plan (see plan_create/plan_update), pass planId/phaseId/stepId together to link it: the step is marked in_progress the moment the lane starts, and blocked automatically (with the error as a step note) if the lane fails. On success, review the lane's answer yourself against that step's acceptance criteria and call plan_update to mark it completed — a successful lane records its answer as a step note but doesn't mark the step done on your behalf, the same way a maxIterations step isn't marked done after a single pass without checking.",
    {
      task: str(
        "Clear, self-contained subtask to delegate. Include scope boundaries, expected output, and all necessary context.",
      ),
      context: str("Optional additional context such as code snippets, logs, file paths, or URLs."),
      complexity: enumStr(
        "Rate the delegated task's complexity — this sets the lane's time and tool-round budget, so an under-rated task gets killed mid-work and an over-rated one holds resources it never needs. " +
        "Rate by how much *work* the task requires, not how long the prompt is. " +
        "standard: a bounded lookup or single-file change, roughly under 6 tool calls. " +
        "complex: multi-file investigation or a change needing verification, roughly 6-10 tool calls. " +
        "deep: broad triage across an unfamiliar area, or work requiring iterative build/test cycles, 10+ tool calls. " +
        "auto (the default) infers from prompt length only, which is a poor proxy — prefer rating explicitly.",
        ["auto", "standard", "complex", "deep"],
      ),
      label: str("Optional short lane label for the transcript."),
      parallel: bool(
        "Set true to fan this lane out concurrently with the other parallel-marked lanes issued in the SAME assistant turn. Defaults to false (one lane at a time). " +
        "To fan out, emit several subagent_spawn calls together in one turn, each with parallel: true — a lane marked parallel on its own still just runs alone. " +
        "Choose fan-out when the lanes are genuinely independent: each has everything it needs up front, none needs another's findings, and you mainly want wall-clock time back (surveying several areas at once, verifying several hypotheses, gathering evidence from unrelated parts of the tree). " +
        "Choose sequential when a later lane's task depends on what an earlier one finds, when the first result may make the rest unnecessary, or when the lanes would edit overlapping files — concurrent writes to the same file interleave unpredictably. " +
        "Costs of fanning out: every lane's full context is built and paid for even if the first answer makes the others moot, and several lanes' results land at once, which is a larger synthesis burden than reading one. " +
        "Costs of sequencing: total latency is the sum of the lanes rather than the slowest one. " +
        "Neither is the default-correct choice; pick by whether the lanes actually depend on each other.",
      ),
      profileId: str(
        "Optional profile ID to specialize the subagent's focus. Builtin profiles: frontend_ui, backend_api, qa_regression, repo_ops. User-defined profile IDs are also accepted.",
      ),
      planId: str("Optional — link this lane to one step of a tracked plan. Requires phaseId and stepId together; a partial link is ignored."),
      phaseId: str("Required alongside planId — the phase containing the target step."),
      stepId: str("Required alongside planId — the step this lane's work belongs to."),
    },
    ["task"],
  ),
  tool(
    "subagent_followup",
    "subagent.followup",
    "Send a follow-up message to a subagent lane that already finished, resuming it with everything it had in context — the files it read, the commands it ran, the reasoning behind its answer. " +
    "Pass the subRequestId returned by that lane's subagent_spawn result. " +
    "Prefer this over spawning a fresh lane whenever the new task builds on work the old lane already did: a new lane starts blank and would have to rediscover all of it, and you would have to restate context the finished lane still holds. " +
    "Good uses: asking for detail the synthesis left out, asking it to double-check or extend a specific finding, or continuing after a failure once you have read its executionTrace and want it to resume from where it stopped rather than start over. " +
    "Spawn a fresh lane instead when the new task is genuinely unrelated — carrying an old lane's context into unrelated work only pollutes it. " +
    "A follow-up gets its own fresh time and tool-round budget; rate `complexity` for the follow-up work itself, not the original task. " +
    "Follow-ups always run one at a time, since a follow-up is by definition a reaction to a result you have already read. " +
    "Only the most recent lanes stay resumable — if the id has been retired, spawn a new lane and include what you learned.",
    {
      subRequestId: str("The subRequestId from the finished lane's subagent_spawn result."),
      message: str(
        "What to ask the lane next. It retains its own context, so reference its prior work directly instead of restating it — but state any NEW information it could not have seen, since it still cannot read the parent conversation.",
      ),
      complexity: enumStr(
        "Complexity of this follow-up specifically (not the original task). Same tiers as subagent_spawn: standard | complex | deep. A narrow clarification is usually standard even when the original lane was deep.",
        ["auto", "standard", "complex", "deep"],
      ),
    },
    ["subRequestId", "message"],
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

/** Long-form deliverables live as conversation-scoped attachments rather than
    inflating the live transcript/context window. */
export const TRANSCRIPT_DOCUMENT_TOOLS: ToolDefinition[] = [
  tool(
    "transcript_document",
    "transcript.document",
    "Create a rich Markdown document attached permanently to this conversation. Use this for long reports, runbooks, architecture notes, setup guides, README drafts, and other user-facing deliverables instead of placing the full document in chat text. The chat shows a compact expandable card with copy and open-in-editor actions.",
    {
      title: str("Document title shown on its transcript card."),
      subtitle: str("Optional one-line context under the title."),
      docType: str("Optional category: documentation | report | runbook | readme | architecture | setup_guide | user_guide | reference | analysis | general."),
      status: str("Optional status: complete | partial | draft."),
      summary: str("Optional concise description of the document."),
      filename: str("Optional Markdown filename. .md is added if omitted."),
      markdown: str("Full Markdown document. Use this or sections."),
      sections: arr(
        obj("", {
          heading: str("Section heading."),
          content: str("Section Markdown."),
          level: num("Heading level from 2 to 4; defaults to 2."),
        }, ["heading", "content"]),
        "Ordered sections, as an alternative to a complete markdown string.",
      ),
      sources: arr({ type: "string" }, "Optional evidence files, URLs, or source notes."),
      warnings: arr({ type: "string" }, "Optional caveats or incomplete areas."),
    },
    ["title"],
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
      jql: str("JQL query"),
      limit: num("Maximum results (default 20, max 100)"),
    },
    ["jql"],
  ),
  jiraTool(
    "get_issue",
    "get_issue",
    "Fetch a single Jira issue.",
    {
      key: str("Issue key, for example FOO-123"),
    },
    ["key"],
  ),
  jiraTool(
    "create_issue",
    "create_issue",
    "Create a Jira issue.",
    {
      project: str("Project key"),
      summary: str("Issue summary"),
      description: str("Issue description"),
      issueType: str("Issue type (default Task)"),
    },
    ["project", "summary"],
  ),
  jiraTool(
    "update_issue",
    "update_issue",
    "Update fields on a Jira issue.",
    {
      key: str("Issue key"),
      fields: obj("Fields to update"),
    },
    ["key", "fields"],
  ),
  jiraTool(
    "add_comment",
    "add_comment",
    "Add a comment to a Jira issue.",
    {
      key: str("Issue key"),
      body: str("Comment body"),
    },
    ["key", "body"],
  ),
  jiraTool(
    "list_projects",
    "list_projects",
    "List Jira projects available to the user.",
    {
      limit: num("Maximum results (default 50, max 200)"),
    },
    [],
  ),

  confluenceTool(
    "search",
    "search",
    "Search Confluence content with CQL.",
    {
      query: str("CQL query"),
      limit: num("Maximum results (default 20, max 50)"),
    },
    ["query"],
  ),
  confluenceTool(
    "get_page",
    "get_page",
    "Fetch a Confluence page with storage body and version metadata.",
    {
      pageId: str("Page ID"),
    },
    ["pageId"],
  ),
  confluenceTool(
    "create_page",
    "create_page",
    "Create a Confluence page.",
    {
      spaceKey: str("Space key"),
      title: str("Page title"),
      body: str("Page body in Confluence storage format"),
      parentId: str("Parent page ID (optional)"),
    },
    ["spaceKey", "title", "body"],
  ),
  confluenceTool(
    "update_page",
    "update_page",
    "Update a Confluence page.",
    {
      pageId: str("Page ID"),
      title: str("Page title"),
      body: str("Page body in Confluence storage format"),
      version: num("Current page version"),
    },
    ["pageId", "title", "body", "version"],
  ),
  confluenceTool(
    "list_spaces",
    "list_spaces",
    "List Confluence spaces.",
    {
      limit: num("Maximum results (default 25, max 100)"),
    },
    [],
  ),

  salesforceTool(
    "query",
    "query",
    "Run a Salesforce SOQL query.",
    {
      soql: str("SOQL query"),
    },
    ["soql"],
  ),
  salesforceTool(
    "get_object",
    "get_object",
    "Fetch a Salesforce record by object type and ID.",
    {
      objectType: str("Salesforce object type, for example Account or Contact"),
      id: str("Record ID"),
    },
    ["objectType", "id"],
  ),
  salesforceTool(
    "create_object",
    "create_object",
    "Create a Salesforce record.",
    {
      objectType: str("Salesforce object type"),
      fields: obj("Field values"),
    },
    ["objectType", "fields"],
  ),
  salesforceTool(
    "update_object",
    "update_object",
    "Update a Salesforce record.",
    {
      objectType: str("Salesforce object type"),
      id: str("Record ID"),
      fields: obj("Field values"),
    },
    ["objectType", "id", "fields"],
  ),
  salesforceTool(
    "list_objects",
    "list_objects",
    "List available Salesforce objects.",
    {},
    [],
  ),
];

export const BROWSER_TOOLS: ToolDefinition[] = [
  tool(
    "browser_navigate",
    "browser.navigate",
    "Navigate the agent's browser page to a URL. A dedicated browser window is launched on first use and reused across calls.",
    {
      url: str("Full URL to navigate to"),
      waitFor: enumStr("Wait condition (default load).", ["load", "networkidle"]),
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
  tool(
    "browser_run_script",
    "browser.run_script",
    "Run a sequence of browser actions against the agent's browser page in ONE call, returning every step's result together — including all screenshots, each attached as a real image in step order. Use this instead of many separate browser_* calls for any multi-step visual walkthrough (load a page, screenshot, click a button, screenshot again) so you can review the whole sequence at once instead of paying one round trip per step. "
      + "Beyond the pointer *destination* actions (click, type), this drives the pointer itself: `mouse_path` moves the cursor along a list of waypoints with interpolation, so hover states, drag thresholds, pointermove handlers, canvas/WebGL orbit controls and game input all see the intermediate positions rather than a teleport. `drag` is press-move-release over the same path shape, `scroll` sends wheel deltas, `hover` parks the cursor on a selector or coordinate, and `key` presses keys at page level — with `holdMs` for a held input like a movement key, which a press cannot express. "
      + "`capture_matrix` answers a question one screenshot cannot: what the same subject looks like from several perspectives. Give it named perspectives - each optionally running a script (orbit a 3D camera, change a material, toggle a state), setting a viewport size for a breakpoint sweep, or scrolling - and every frame lands in ONE observation so they stay comparable to each other instead of scattering across separate captures. Use settleMs whenever a transition or re-render has to land first. "
      + "Stops at the first failed step unless continueOnError is set. Max 25 steps per call.",
    {
      steps: arr(
        obj("One browser action, executed in order", {
          action: enumStr("The browser action this step performs.", ["navigate", "click", "type", "wait", "screenshot", "get_text", "evaluate", "mouse_path", "drag", "hover", "scroll", "key", "capture_matrix"]),
          label: str("Optional short label for this step, echoed back with its result for readability"),
          url: str("For navigate: full URL to load"),
          waitFor: enumStr("For navigate: wait condition (default load).", ["load", "networkidle"]),
          selector: str("For click/type/get_text/wait: CSS selector"),
          text: str("For type: text to enter (the field is clicked first, then filled)"),
          timeoutMs: num("For wait: milliseconds to wait when no selector is given (default 1000, max 30000); with selector, max time to wait for it to appear (default 10000, max 30000)"),
          fullPage: bool("For screenshot: capture the full page instead of the viewport"),
          script: str("For evaluate: JavaScript expression or function body to run"),
          path: arr(
            obj("A viewport coordinate the cursor passes through", { x: num("Viewport x"), y: num("Viewport y") }, ["x", "y"]),
            "For mouse_path/drag: ordered waypoints in viewport coordinates. The cursor jumps to the first without interpolating (so a run starts from a known position) and then interpolates between the rest. Max 64.",
          ),
          stepsPerLeg: num("For mouse_path/drag: interpolation steps between consecutive waypoints (default 12, max 60). Higher is smoother and slower — each step is a round trip to the browser."),
          button: enumStr("For mouse_path: hold this button down for the whole path, turning it into a drag. Omit for a plain move.", ["left", "right", "middle"]),
          deltaX: num("For scroll: horizontal wheel delta in pixels"),
          deltaY: num("For scroll: vertical wheel delta in pixels"),
          x: num("For hover: viewport x, when hovering a coordinate instead of a selector"),
          y: num("For hover: viewport y, when hovering a coordinate instead of a selector"),
          key: str("For key: a single key to press, e.g. 'Enter', 'ArrowLeft', 'Control+S'"),
          keys: arr(str("A key to press"), "For key: several keys pressed in order (max 32)"),
          holdMs: num("For key: hold each key down this long instead of tapping it (max 5000). This is how a movement input like 'W for 400ms' is expressed."),
          perspectives: arr(
            obj("One perspective to capture", {
              label: str("Name for this perspective, e.g. 'front', 'three-quarter', 'mobile'. Returned with the frame so a later comparison is between named viewpoints rather than anonymous images."),
              script: str("JavaScript run before this capture. The general case, and the one that drives a 3D view: orbit or reposition the camera, re-render, then capture."),
              width: num("Viewport width for this capture (200-4096) - use with height for a responsive breakpoint sweep"),
              height: num("Viewport height for this capture (200-4096)"),
              scrollY: num("Scroll to this vertical position before capturing, for long documents"),
            }, ["label"]),
            "For capture_matrix: up to 12 perspectives, captured in order into a single observation",
          ),
          settleMs: num("For capture_matrix: wait this long after applying each perspective before capturing (max 2000). Needed whenever a transition, animation or WebGL re-render has to land first, or you capture the previous state."),
        }, ["action"]),
        "Ordered browser actions to run in sequence",
      ),
      continueOnError: bool("Keep running remaining steps after a failed step instead of stopping there (default false)"),
    },
    ["steps"],
  ),
];

export const SEQUENCE_TOOLS: ToolDefinition[] = [
  tool(
    "sequence_discover",
    "sequence.discover",
    "Discover stable, addressable application surfaces before executing a retained run. " +
      "For the browser adapter this scans filesystem/router conventions, Storybook stories, browser tests, and (when an entrypoint is supplied) runtime links. Results are bounded and include confidence and reachability separately.",
    {
      target: obj("Adapter target", {
        adapter: enumStr("Adapter to discover.", ["browser", "workspace", "process", "test", "desktop"]),
        entrypoint: str("Optional browser base URL used for runtime-link discovery"),
        workspace: str("Workspace selector; use 'current' for this workspace"),
      }, ["adapter"]),
      sources: arr(enumStr("Discovery source.", ["filesystem", "router", "storybook", "tests", "runtime"]), "Sources to inspect"),
      include: arr(enumStr("Surface kinds to include.", ["routes", "stories", "tests", "files"]), "Surface kinds to return"),
      refresh: bool("Ignore any cached discovery result"),
      limit: num("Maximum surfaces to return (default 50, max 200)"),
      cursor: str("Opaque continuation cursor from a previous discovery result"),
    },
    ["target"],
  ),
  tool(
    "sequence_execute",
    "sequence.execute",
    "Compile, authorize, execute, and retain one bounded linear sequence. Every completed step and failure is stored as an Execution Run; the compact result returns stable IDs for targeted sequence_inspect calls instead of copying the full trace into context. " +
      "Use adapter/action/params on each step (for example browser + navigate + {url}), and keep external or destructive effects out of sequences.",
    {
      title: str("Human-readable run title"),
      target: obj("Primary sequence target", {
        adapter: enumStr("Primary adapter.", ["browser", "workspace", "process", "test", "desktop"]),
        entrypoint: str("Browser base URL or other adapter entrypoint"),
        workspace: str("Workspace selector; use 'current' for this workspace"),
      }, ["adapter"]),
      steps: arr(
        obj("One bounded action", {
          id: str("Stable semantic step ID; generated when omitted"),
          label: str("Human-readable step label"),
          adapter: enumStr("Adapter override for this step.", ["browser", "workspace", "process", "test", "desktop"]),
          action: str("Adapter action, e.g. navigate, screenshot, video_start, video_stop, read_file, start, run"),
          params: obj("Adapter-specific action parameters"),
          depends_on: arr({ type: "string" }, "Earlier stable step IDs this step depends on"),
          capture: bool("Capture a before/after observation for this step"),
          checkpoint: bool("Request a logical checkpoint after success"),
          entity_refs: arr(obj("Related stable entity", {
            scheme: str("Entity scheme"),
            id: str("Stable entity identifier"),
            workspacePath: str("Normalized workspace-relative path when applicable"),
            label: str("Optional label"),
          }, ["scheme", "id"]), "Related routes, files, tests, or other entities"),
          assertions: arr(obj("Post-action assertion", {
            type: str("Assertion type, e.g. result_ok, url_contains, text_contains, selector_exists"),
            expected: str("Expected value"),
            selector: str("Optional CSS selector"),
            message: str("Failure message"),
          }, ["type"]), "Assertions evaluated after the action"),
        }, ["action"]),
        "Ordered linear steps (default maximum 40)",
      ),
      capture_profile: enumStr("Evidence detail.", ["minimal", "standard", "diagnostic", "visual", "full"]),
      failure_policy: obj("Failure handling", {
        mode: enumStr("Failure mode.", ["stop_and_capture", "continue_safe", "collect_all"]),
        retain_partial: bool("Persist completed and failure evidence"),
      }),
      limits: obj("Hard resource limits", {
        max_steps: num("Maximum accepted steps, capped by the adapter"),
        max_duration_ms: num("Whole-run timeout in milliseconds"),
        max_artifact_bytes: num("Maximum artifact bytes retained for this run"),
      }),
      plan_id: str("Optional linked plan ID"),
      phase_id: str("Optional linked plan phase ID"),
      ticket_ids: arr({ type: "string" }, "Optional linked ticket IDs"),
      parent_run_id: str("Optional parent run for lineage"),
      baseline_run_id: str("Optional comparison baseline"),
      retention_class: enumStr("Retention policy.", ["temporary", "standard", "pinned"]),
      lane_id: str("Optional parent/delegated lane ID"),
    },
    ["title", "target", "steps"],
  ),
  tool(
    "sequence_inspect",
    "sequence.inspect",
    "Seek into a retained Execution Run without rerunning the target. Returns a bounded synchronized event window, observation metadata, entity references, and optionally one requested visual artifact as a real image.",
    {
      run_id: str("Execution Run ID"),
      seek: obj("Cursor selector", {
        step_id: str("Stable step ID"),
        step_ordinal: num("Zero-based step ordinal"),
        event_id: str("Event ID"),
        observation_id: str("Observation ID"),
        sequence_number: num("Host-assigned event sequence number"),
        monotonic_timestamp_ns: str("Host-assigned monotonic timestamp in decimal nanoseconds"),
        checkpoint_id: str("Checkpoint ID"),
        entity_id: str("Stable entity ID"),
        anomaly_type: str("Anomaly type, e.g. uncaught_exception"),
        query: str("Deterministic semantic text query across indexed steps/events"),
        phase: enumStr("Step boundary to inspect.", ["before", "after", "failure"]),
      }),
      channels: arr(enumStr("Evidence channel.", ["action", "visual", "log", "application_event", "network", "state", "filesystem", "diagnostic", "assertion", "metric", "artifact"]), "Channels to include"),
      window: obj("Bounded event window", {
        before_events: num("Events before the resolved cursor (default 25)"),
        after_events: num("Events after the resolved cursor (default 50)"),
        before_ms: num("Time before cursor"),
        after_ms: num("Time after cursor"),
      }),
      detail: enumStr("Response detail.", ["summary", "standard", "diagnostic"]),
      artifact_id: str("Optional retained artifact ID to inspect, including a sampled or user-flagged video keyframe"),
      include_artifact_data: bool("Attach the selected visual artifact for direct model inspection"),
    },
    ["run_id"],
  ),
  tool(
    "sequence_compare",
    "sequence.compare",
    "Semantically align and compare two retained runs. Reports candidate visual, structural, behavioral, and operational differences with confidence and evidence references; it does not automatically declare differences to be defects.",
    {
      left_run_id: str("Left/base run ID"),
      right_run_id: str("Right/candidate run ID"),
      alignment: enumStr("Alignment strategy.", ["semantic", "step_id", "ordinal"]),
      scope: obj("Optional comparison scope", {
        surface: str("Stable surface/route ID"),
        step_ids: arr({ type: "string" }, "Stable step IDs"),
      }),
      channels: arr(enumStr("Comparison channel.", ["visual", "structure", "behavior", "log", "network", "performance", "filesystem"]), "Channels to compare"),
    },
    ["left_run_id", "right_run_id"],
  ),
  tool(
    "sequence_resume",
    "sequence.resume",
    "Continue a retained partial run only when its adapter and side-effect ledger make logical resume safe. Unsafe or unsupported resumes are rejected with a narrowed replacement-sequence recommendation.",
    {
      run_id: str("Partial run ID"),
      from_checkpoint_id: str("Optional checkpoint ID to validate; marker-only checkpoints are rejected unless an adapter can restore them"),
      replacement_steps: arr(obj("Replacement step", {
        id: str("Stable step ID"),
        adapter: str("Adapter"),
        action: str("Action"),
        params: obj("Action parameters"),
      }, ["action"]), "Optional replacement tail"),
    },
    ["run_id"],
  ),
  tool(
    "sequence_search",
    "sequence.search",
    "Search retained Execution Runs and visual history by natural-language text and structured workspace, plan, ticket, surface, file, status, anomaly, lineage, or time filters. Returns compact summaries and stable run IDs.",
    {
      query: str("Natural-language or indexed text query"),
      scope: obj("Structured filters", {
        workspace: str("Workspace selector"),
        plan_id: str("Plan ID"),
        phase_id: str("Plan phase ID"),
        ticket_id: str("Ticket ID"),
        surface: str("Surface/route ID"),
        file: str("Normalized workspace-relative file"),
        status: str("Run status"),
        anomaly: str("Anomaly type"),
        parent_run_id: str("Lineage parent"),
        from: str("ISO start timestamp"),
        to: str("ISO end timestamp"),
      }),
      limit: num("Maximum results (default 10, max 50)"),
      cursor: str("Opaque continuation cursor"),
    },
  ),
  tool(
    "sequence_annotate",
    "sequence.annotate",
    "Create or update a durable note anchored to retained run evidence. Use this only for a finding, decision, or disposition that should survive the current turn; nearby annotations are returned by sequence_inspect.",
    {
      run_id: str("Execution Run ID"),
      action: enumStr("Annotation operation.", ["create", "update", "resolve"]),
      annotation_id: str("Existing annotation ID for update or resolve"),
      kind: enumStr("Annotation kind.", ["note", "finding", "decision", "false_positive"]),
      status: enumStr("Annotation disposition.", ["open", "accepted", "dismissed"]),
      body: str("Concise durable annotation text"),
      anchor: obj("Stable evidence anchor", {
        sequence_number: num("Event sequence number"),
        step_id: str("Step ID"),
        event_id: str("Event ID"),
        observation_id: str("Observation ID"),
        entity: obj("Optional related entity", {
          scheme: str("Entity scheme"),
          id: str("Entity ID"),
        }, ["scheme", "id"]),
      }),
    },
    ["run_id", "action"],
  ),
];

/**
 * Parent-agent controls for supervised ticket loops. A proposal only creates an inert draft;
 * starting or widening an unattended run remains an explicit user action in the Loops view.
 */
export const LOOP_TOOLS: ToolDefinition[] = [
  tool(
    "loop_propose",
    "loop.propose",
    "Analyze the durable ticket queue and create an inert Ticket Loop draft for the user to review. " +
      "Use this when several related open tickets can be drained as a long-horizon operation. The result includes the exact matched tickets, first schedulable wave, blockers, territory conflicts, a conservative cost range, and recommended concurrency. " +
      "This never starts work: present the proposal and let the user start it from the Loops view.",
    {
      title: str("Human-readable objective for the loop"),
      ticketIds: arr({ type: "string" }, "Optional exact ticket IDs; combine with the filters below"),
      statuses: arr(enumStr("Ticket status.", ["triage", "backlog", "in_progress", "blocked", "review"]), "Statuses to include; defaults to backlog and triage"),
      labels: arr({ type: "string" }, "Labels that matched tickets must carry"),
      priorities: arr(enumStr("Ticket priority.", ["urgent", "high", "normal", "low"]), "Priorities to include"),
      areas: arr({ type: "string" }, "Ticket areas to include"),
      respectBlockedBy: bool("Withhold tickets while their open blockers remain; defaults true"),
      concurrency: num("Requested worker count; clamped to the safe host maximum"),
      maxTickets: num("Stop after this many dispatches"),
      maxUsd: num("Stop when estimated model spend reaches this amount"),
      maxWallClockMinutes: num("Stop after this many wall-clock minutes"),
      maxConsecutiveFailures: num("Stop after this many consecutive failed lanes; defaults to 3"),
    },
    ["title"],
  ),
  tool(
    "loop_control",
    "loop.control",
    "Inspect subagent lanes and per-execution spend, or make a running Ticket Loop safer. The parent agent may list or inspect loops, pause or stop one, or lower its ceilings after reviewing progress. " +
      "It cannot start a draft, resume a paused loop, increase concurrency, or raise a ceiling; those decisions remain with the user.",
    {
      action: enumStr("Control action.", ["list", "inspect", "pause", "stop", "lower_ceilings"]),
      loopId: str("Loop ID; omitted only for list"),
      maxTickets: num("Tighter total-ticket ceiling"),
      maxUsd: num("Tighter estimated-spend ceiling"),
      maxWallClockMinutes: num("Tighter wall-clock ceiling"),
      maxConsecutiveFailures: num("Tighter consecutive-failure ceiling"),
    },
    ["action"],
  ),
];

// UI_TOOLS are always injected into the model's tool list and not user-toggleable.
export const UI_TOOLS: ToolDefinition[] = [
  tool(
    "question_card",
    "ui.question_card",
    "Present the user with one or more questions before proceeding. The agent pauses until every question is answered or declined. Use this willingly at material forks where an unverified user preference would change the product posture, plan, scope, architecture, interaction model, visual/art direction, fidelity envelope, or delivery shape; do not ask for information you can inspect or for low-stakes choices you can decide safely. Ask at the altitude of the consequential decision, not for isolated implementation trivia. Pass a single-item `questions` array for one question, or multiple related items to gather a coherent decision in one pause. Set `multiSelect` when more than one option can be selected. "
      + "Make each option a coherent, opinionated direction with materially different product, experience, visual, and technical consequences. Recommend the strongest option when the evidence supports one and name real tradeoffs; never offer several cosmetic variants of the same safe idea. "
      + "For visual or interaction choices, put a real sandboxed preview on each meaningful candidate — show the composition, states, interaction and motion rather than describing them. Two or more preview-bearing options open in an editor comparison stage with their visual evidence expanded and a focus mode for inspecting one candidate at full width. "
      + "Ground the previews in this project before drawing: inspect current components/screens, screenshots and reference images, stored UI preferences, design tokens, fonts, icons/assets, product domain, target viewport, accessibility, and rendering constraints. Preserve the project's visual language when it has one; when it does not, derive distinct art directions from the product rather than falling back to a generic dashboard or Blacksite's own aesthetic. "
      + "A preview should be a prototype of the change you would actually ship, not a sketch standing in for it. Do not lower the proposal's ambition because a simpler preview is easier to author. Four things make high fidelity achievable. "
      + "(1) The project's own compiled stylesheet is already loaded in every preview — its design tokens, component classes and utility layer all work. Call `ui_design_tokens` first to see exactly which class names and variables exist, then compose the preview from them instead of writing a parallel visual system in hand-rolled CSS. "
      + "(2) When the option changes something that already exists, use `mount` rather than `code`: name the real component or renderer entry and express the change as a `patch`. The preview then *is* the project rendering under that edit, including bundled UI, 2D/3D libraries and imported visual assets, so it cannot drift from what you would implement. Reach for `code` only for something genuinely new. "
      + "(3) Choose the rendering medium the idea deserves. DOM/CSS is not the ceiling: use SVG for authored vector composition, Canvas 2D for raster/procedural scenes and dense visualisation, and the project's renderer or WebGL/WebGPU for real 3D. Use procedural geometry/textures or inlined data assets when a network asset is unavailable. A 3D direction must demonstrate deliberate geometry, camera, lighting, materials, depth, motion, and interaction/state wherever those are part of the decision — labelled wireframe boxes are not evidence of a production 3D direction. "
      + "(4) Render it before you send it. `ui_preview_render` returns a screenshot of the preview exactly as the user will see it — inspect composition, crop, hierarchy, typography, responsive fit, state, 2D finish, and 3D camera/lighting/material readability; fix what is weak and re-render until it is decision-ready. An unrendered preview is a guess. "
      + "The surface is also pre-themed: it carries the user's live editor theme, the product font stack, a box-sizing reset and styled scrollbars. Where the project's own tokens do not cover something, compose with `--bs-bg`, `--bs-fg`, `--bs-muted`, `--bs-accent`, `--bs-surface`, `--bs-border`, `--bs-danger`, `--bs-warning`, `--bs-success`, `--bs-radius`, `--bs-gap`, `--bs-font`, `--bs-mono` (the full `--vscode-*` palette is bridged in too). Hardcoded hex colours are usually a mistake for project UI because they break in the other theme; deliberate art, illustration, game, data, and 3D palettes may use authored colours when colour is part of the direction. Spend the effort on representative content and the states needed to judge the choice, and set `height` to whatever the design genuinely needs instead of compressing it to fit."
      + "Set `preferenceKey` on any question about how something should look or behave. A preview-bearing question's answer is recorded to .blacksite/ui-preferences.json automatically, and the key is what lets a later answer supersede this one instead of accumulating beside it.",
    {
      questions: arr(
        obj("", {
          question: str("The question to ask the user"),
          context: str("Optional paragraph of context shown above this question's options"),
          multiSelect: bool("Allow selecting more than one option for this question (default: single-select). Selections stay editable until the user submits the complete question card."),
          preferenceKey: str("Stable identity for the element being decided, e.g. \"chat.message-bubble\" or \"runs.timeline-density\". Set this on visual/interaction questions: the answer to a preview-bearing question is persisted to .blacksite/ui-preferences.json, and this key is what lets a later decision about the same element replace the earlier one rather than pile up next to it. Omit for non-visual questions."),
          options: arr(
            obj("", {
              key: str("Unique key returned when this option is selected"),
              label: str("Button label shown to the user"),
              description: str("Optional detail shown below the label to help the user decide"),
              preview: obj("Optional live 2D/3D preview rendered in a sandboxed iframe. Use it when an option's UI, composition, interaction, art direction, visualisation, spatial treatment, or animation is consequential; make it a convincing runnable artefact, not a static placeholder. Supply either `mount` (preferred for anything that already exists) or `code`. Two or more preview-bearing options are shown together in an adaptive editor comparison stage.", {
                html: str("Optional custom document shell. Rarely needed — omit it and render into the pre-themed default body. A custom shell still receives the theme baseline and the project stylesheet, so use this only for document-level structure you cannot build from code."),
                code: str("JavaScript/TypeScript module code to execute in the preview. Static package and relative imports are bundled from the workspace, including imported CSS and visual assets; packages must already be installed. The final self-contained bundle has a 4 MB safety budget, so prefer browser-focused/tree-shakeable imports and optimised textures/models over whole-library or raw production-size assets. Render into document.body with the medium appropriate to the proposal: DOM/CSS, SVG, Canvas 2D, WebGL/WebGPU, or a combination. The project's compiled stylesheet is already loaded, so use its real classes (see ui_design_tokens) and tokens for project UI. Animation and local pointer/keyboard interaction are encouraged when they prove the direction. Avoid network resources. Omit when using `mount`."),
                resolveFrom: str("Optional workspace-relative app/package directory (or a file inside it) used as the import-resolution context for `code`. Set this in monorepos when dependencies belong to e.g. `apps/web` instead of the workspace root."),
                mount: obj("Render the project's real component or rendering entry instead of reimplementing it — the faithful option whenever the thing being decided already exists in the codebase. The entry and its installed dependencies, imported CSS, images, fonts, and visual/model assets are bundled from the workspace with `patch` applied in memory; the working tree is never modified. Because the preview is the real project surface under the real edit, it cannot drift from what you would ship, and the patch you write here is the change itself.", {
                  entry: str("Workspace-relative module to render, e.g. \"src/webview/react/components/chat/QuestionCard.tsx\"."),
                  export: str("Named export to render. Defaults to the default export."),
                  props: obj("JSON-serialisable props for the component. Pass representative data — a component rendered with empty props usually shows none of what the decision is about."),
                  renderer: enumStr("\"react\" (default for .tsx/.jsx) mounts via react-dom. \"dom\" calls the export directly as fn(container, props) for non-React projects.", ["react", "dom"]),
                  patch: arr(
                    obj("", {
                      file: str("Workspace-relative file to edit in memory."),
                      find: str("Exact snippet to replace — copy it verbatim from the file. The build fails rather than rendering a preview missing its own change, so read the file first."),
                      replace: str("Replacement text."),
                      all: bool("Replace every occurrence. Without it, `find` must match exactly once."),
                    }, ["file", "find", "replace"]),
                    "The edits this option proposes, applied in memory for the duration of the build. Omit to preview the component exactly as it stands today — useful as the 'keep it as-is' option in a comparison.",
                  ),
                }, ["entry"]),
                height: num("Preview iframe height in pixels (optional, default 260). Size this to the real composition: compact components may fit at 260, while complete screens, animated scenes, data visualisations, and 3D worlds should commonly use 420-900. Do not crop an ambitious direction to preserve a small card. Anything over 320 opens full-page automatically inline; the editor comparison stage respects heights up to 900."),
                expandHint: bool("Optional — set true when density, motion, interaction, or 2D/3D detail deserves a large stage. A single preview opens full-page automatically; comparison sets still show every candidate together and let the user focus one at full editor width."),
              }),
            }, ["key", "label"]),
            "One to four options for this question",
          ),
        }, ["question", "options"]),
        "One to four questions to ask together as a set",
      ),
    },
    ["questions"],
  ),
  tool(
    "ui_design_tokens",
    "ui.design_tokens",
    "Inventory the design system a question-card preview will be rendered against: the CSS custom properties (tokens) the project defines with their resolved values, its component class names grouped by prefix, the utility families available, and the font stacks in use. "
      + "Previews already load this stylesheet, so these class names and variables work verbatim inside one — but only if you use the names that actually exist. Guessing produces markup that renders unstyled, which is indistinguishable from a low-effort preview and is the main reason to hand-write CSS instead. Call this before authoring any preview whose styling should match the product. "
      + "`origin` tells you whose design system you are looking at: \"workspace\"/\"configured\" means the project in the editor, \"extension\" means Blacksite's own (correct only when Blacksite is what you are working on), and \"none\" means no stylesheet was found. In either fallback case, inspect the project's source components, screenshots, assets, fonts and domain yourself before authoring; use --bs-* only as a neutral rendering substrate, never as permission to make an unrelated project look like Blacksite. "
      + "Every class family is listed, but a family may be sampled: each group carries its true `total`, and `truncated` reports whether anything was withheld. When a group shows fewer classes than its total, use `filter` to search the complete inventory rather than assuming the rest are absent.",
    {
      filter: str("Case-insensitive substring; returns only tokens and classes containing it. Searches the complete inventory, not just the capped listing — use it to confirm whether a specific class or variable exists."),
      limit: num("Maximum component classes returned (default 400, max 1500)."),
    },
  ),
  tool(
    "ui_preview_render",
    "ui.preview_render",
    "Render a question-card 2D/3D preview headlessly and return a screenshot of it, at the exact viewport the user-facing frame will receive. "
      + "Use this before putting any consequential preview in front of the user. Previews are otherwise authored blind — no look at the result — so the alternative is guessing. Render it, inspect the image rather than merely checking `ok`: correct runtime errors, crop, composition, hierarchy, typography, responsive fit, representative state, animation settle point, 2D finish, and 3D geometry/camera/lighting/material readability. Re-render until it is a strong, decision-ready candidate you would actually ship; a technically successful but visually lazy render is not done. "
      + "Takes the same `html`/`code`/`mount` payload as a question_card preview, so what you check is exactly what gets sent. `previewErrors` returns uncaught exceptions from inside the sandbox, and a failed `mount` build returns the build error — both are usually enough to fix the problem without further investigation. "
      + "Requires the local browser runtime; if it is unavailable, author conservatively and say so rather than shipping an unverified complex preview.",
    {
      code: str("JavaScript/TypeScript module code to render, identical to a preview's `code`. Installed package imports, relative modules, CSS, and visual assets are bundled from the workspace."),
      html: str("Optional custom document shell, identical to a preview's `html`."),
      resolveFrom: str("Optional workspace-relative app/package directory (or file within it) used to resolve imports in `code`; use this for monorepos whose dependencies are not owned by the root."),
      mount: obj("Render the project's real component, identical to a preview's `mount`. Build failures (missing entry, a `patch` whose `find` does not match) are returned as errors so you can correct them before the user ever sees the question.", {
        entry: str("Workspace-relative module to render."),
        export: str("Named export to render. Defaults to the default export."),
        props: obj("JSON-serialisable props for the component."),
        renderer: enumStr("\"react\" (default for .tsx/.jsx) or \"dom\".", ["react", "dom"]),
        patch: arr(
          obj("", {
            file: str("Workspace-relative file to edit in memory."),
            find: str("Exact snippet to replace, copied verbatim from the file."),
            replace: str("Replacement text."),
            all: bool("Replace every occurrence."),
          }, ["file", "find", "replace"]),
          "Edits applied in memory for this render only.",
        ),
      }, ["entry"]),
      width: num("Viewport width in pixels (default 720, the inline chat frame's width)."),
      height: num("Viewport height in pixels (default 260). Match the `height` you intend to set on the preview so you see the same crop the user will."),
      settleMs: num("Milliseconds to wait before capturing (default 350, max 3000). Raise it for a preview with an entry animation you want to capture settled."),
    },
  ),
];

export const GRAPH_TOOLS: ToolDefinition[] = [
  tool(
    "map_overview",
    "graph.overview",
    "Orient yourself in the whole workspace using the Codebase Map's precomputed architecture index. Returns detected projects and project-to-project references, major code areas, dependency hubs, cross-service flows, structural findings (cross-project cycles, orphan files, single-access pockets), index coverage, and recent durable map notes. Use this before a broad or architectural change; then map_find to enumerate an area it named, map_relationships for the specific files you expect to touch, and map_impact to size what a change reaches. This is more accurate and cheaper than reconstructing repository structure with repeated globs and text searches. Every ranked section is capped by `limit` — treat it as the top of a list, not the whole list, and drill in with map_find rather than assuming what was omitted doesn't exist.",
    {
      limit: num("Maximum entries in each ranked section (default 10, max 30)"),
    },
  ),
  tool(
    "map_find",
    "graph.find",
    "Enumerate files on the Codebase Map with filters and ranking — the drill-down for map_overview's ranked-and-truncated summaries. Answers \"which files are actually in this area\", \"what are the biggest/most-connected files under src/graph\", \"which Python files have no dependents\", and (when the git heat layer is on) \"what has churned most recently here\" — without globbing the filesystem and re-deriving structure the index already holds. Every returned file carries its area, language, dependent/dependency counts, size, and recent-commit count, so one call gives you both the file list and the reason to care about each entry. `matched` reports how many files passed the filter before `limit`, so you always know whether you are seeing everything.",
    {
      area: str("Restrict to files under this directory / map area (e.g. 'src/graph'). Combine with the other filters to narrow further."),
      contains: str("Restrict to paths containing this substring (case-insensitive)"),
      glob: str("Restrict to paths matching this glob — `**` spans directories, `*` and `?` do not (e.g. 'src/**/*.test.ts')"),
      langs: arr({ type: "string" }, "Restrict to these language buckets (file-extension based, e.g. ['ts','tsx'])"),
      minDegree: num("Only files with at least this many total links (dependents + dependencies)"),
      minChurn: num("Only files with at least this many commits in the map's recent git window (needs the git heat layer)"),
      sortBy: enumStr(
        "Ranking: degree (total links, default), dependents (most depended on — the risky ones), dependencies (most coupled outward), churn (most-changed), recency (most recently committed), size, or path (alphabetical)",
        ["degree", "dependents", "dependencies", "churn", "recency", "size", "path"],
      ),
      limit: num("Max files to return (default 50, max 200)"),
    },
  ),
  tool(
    "map_impact",
    "graph.impact",
    "Size the real blast radius of changing one or more files: the TRANSITIVE set of files that depend on them (or that they depend on), N hops out, with the concrete edge chain that connects each one back to the seed. This is the multi-hop version of map_relationships — use it instead of calling map_relationships repeatedly to fan out by hand. Run it BEFORE changing a shared contract, a widely-imported module, a config file, or anything map_overview listed as a dependency hub: `byDepth` and `areas` tell you at a glance whether a change is contained to one area or reaches across the system, and `files` is ordered nearest-and-most-connected first so the entries that matter come first. Traverses the import, cross-service, and symbol layers together (direction-normalized, so mixed-layer chains read consistently); add 'note' to `layers` to let durable map notes bridge relationships the indexers can't see. Check `truncated` — a true value means the radius is larger than what was returned.",
    {
      path: str("Workspace-relative path of a single seed file"),
      paths: arr({ type: "string" }, "Multiple seed files to treat as one change set (use instead of `path`)"),
      direction: enumStr(
        "dependents = what breaks if the seeds change (default, the usual pre-change question); dependencies = what the seeds themselves rely on; both = the full neighborhood",
        ["dependents", "dependencies", "both"],
      ),
      depth: num("How many hops to walk out (default 3, max 6). Depth 1 is what map_relationships already gives you."),
      layers: arr({ type: "string" }, "Relationship layers to traverse: import, service, symbol, note. Default ['import','service','symbol']."),
      limit: num("Max distinct files to reach before stopping (default 200, max 1000)"),
    },
  ),
  tool(
    "map_path",
    "graph.routes",
    "Show how two files are actually connected on the Codebase Map: the shortest concrete chains between them, one entry per hop with the edge kind and layer that links each pair. Use it when you know where a behavior starts and where it ends but not what sits in between (\"how does this webview message reach the store\", \"what connects this route handler to that table\"), or to verify that two modules are — or are not — coupled. Searches undirected by default, because \"how are these related\" is usually a relatedness question; set directedOnly to follow dependency arrows strictly (from depends on … depends on to). An empty `routes` with a populated `hint` means no connection was found within the limits, not that the query failed.",
    {
      from: str("Workspace-relative path of the starting file"),
      to: str("Workspace-relative path of the destination file"),
      maxHops: num("Longest chain to consider (default 5, max 8). Raise it before concluding two files are unconnected."),
      maxRoutes: num("How many distinct routes to return, shortest first (default 3, max 10)"),
      layers: arr({ type: "string" }, "Relationship layers to traverse: import, service, symbol, note. Default ['import','service','symbol']."),
      directedOnly: bool("Follow dependency direction strictly instead of treating links as bidirectional (default false)"),
    },
    ["from", "to"],
  ),
  tool(
    "map_relationships",
    "graph.relationships",
    "Look up how one or more files relate on the Codebase Map, one hop out: what each file imports, what imports it (imported-by), cross-service relationships (API calls, published/subscribed events, shared data/tables, config references) with the peer service and supporting evidence, the file's own map area/language/recent-commit count, and any working-memory notes attached to it. Use this to answer \"what are the relations of these files\" and to inherit prior sessions' knowledge before editing. Returns edges the map already computed from the workspace index — more reliable and cheaper than grepping for import structure. Pass workspace-relative paths (the same ids the map uses). For a change's true blast radius use map_impact instead — this tool stops at direct neighbours, and a shared module's real reach is several hops further out. On every layer, `direction: outbound` means this file depends on the peer and `inbound` means the peer depends on it. Symbol-level relations (inheritance/implements/call/reference) appear under `symbolRelations` only when the optional background symbol sweep is enabled; the top-level `symbolLayer` field reports whether it is active, and files carry `symbolRelationsUnavailable: true` when it is off — an empty `symbolRelations` then means \"not analyzed\", not \"none\".",
    {
      path: str("Workspace-relative path of a single file to inspect"),
      paths: arr({ type: "string" }, "Multiple file paths to inspect at once (use instead of `path`)"),
      limit: num("Max entries per relationship category per file (default 50, max 200)"),
    },
  ),
  tool(
    "map_note_add",
    "graph.add",
    "Attach a working-memory note to the Codebase Map — either to a single file, or (when `to` is given) to a relation between two files (e.g. 'this button handler triggers this service'). Use a file note to record what you learned about it (its role, a gotcha, a non-obvious constraint); use a relation note for a meaningful non-import link worth showing spatially — event flows, IPC/message routes, config-to-consumer links. Record the durable, non-obvious 'why' — a fact obvious from the code or import graph isn't worth a note. Give it a `category` so it reads as classified knowledge, not a flat log; for a relation note, set `relationKind` to say which relationship it's about when the file pair could carry more than one (an import AND an event flow, say) — this is descriptive metadata, not a strict edge match, so pick the closest kind. A short `title` makes it skimmable in the timeline and on the map's floating edge labels. Before adding, call map_note_list on the file(s) — if a related note already exists, call map_note_update to refine it instead of creating a near-duplicate. Notes render on the map and in the user's Notes timeline; body text has room for the full non-obvious reasoning (not just one clause), but stay tight — this is a note, not a report.",
    {
      from: str("Workspace-relative path of the file the note is about (or the relation's source file)"),
      to: str("Optional workspace-relative path of the relation's target file — omit for a single-file note"),
      note: str("Note body — the durable, non-obvious 'why'. Up to ~1000 characters; a few tight sentences, not a single clause."),
      title: str("Optional short heading (<= 80 chars) so the note is skimmable in a list, e.g. 'Retry backoff must match gateway TTL'"),
      category: enumStr("What kind of insight this is", ["architecture", "gotcha", "todo", "risk", "question"]),
      relationKind: enumStr("Only meaningful when `to` is set: which relationship this note is about, when the file pair carries more than one kind of edge", ["import", "api", "event", "data", "config", "call", "reference", "inheritance", "other"]),
    },
    ["from", "note"],
  ),
  tool(
    "map_note_list",
    "graph.list",
    "List the working-memory notes currently attached to the Codebase Map, optionally filtered to those touching one file and/or a category. Call this before map_note_add to check whether a related note already exists to update instead.",
    {
      path: str("Optional workspace-relative file path filter"),
      category: enumStr("Optional category filter", ["architecture", "gotcha", "todo", "risk", "question"]),
    },
  ),
  tool(
    "map_note_update",
    "graph.update",
    "Merge new text into an existing map note (from map_note_add or map_note_list), replacing its content while keeping the prior text as a bounded revision history. Prefer this over map_note_add when a related note on the same file/relation already exists, so the map accumulates refined knowledge across runs instead of duplicate notes. title/category/relationKind are optional patches applied alongside the text replacement — omit any you don't want to change.",
    {
      id: str("Note id to update"),
      note: str("New note text, replacing the current text"),
      title: str("Optional new short heading (<= 80 chars)"),
      category: enumStr("Optional new category", ["architecture", "gotcha", "todo", "risk", "question"]),
      relationKind: enumStr("Optional new relation kind (edge-scoped notes only)", ["import", "api", "event", "data", "config", "call", "reference", "inheritance", "other"]),
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
  ...TICKET_TOOLS,
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
  ...TRANSCRIPT_DOCUMENT_TOOLS,
  ...AGENT_MEMORY_TOOLS,
  ...RESULT_PAGING_TOOLS,
  ...SERVICE_TOOLS,
  ...BROWSER_TOOLS,
  ...SEQUENCE_TOOLS,
  ...LOOP_TOOLS,
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
  // The type annotation promises an object, but streamed arguments can decode to
  // anything — answer a non-object with one clean issue instead of throwing mid-dispatch.
  if (input === null || input === undefined || typeof input !== "object" || Array.isArray(input)) {
    return [{ path: "", kind: "invalid_type", message: "Tool arguments must be a JSON object." }];
  }
  const issues: ToolInputValidationIssue[] = [];
  validateObjectAgainstSchema(input, toolDef.input_schema as unknown as Record<string, unknown>, "", issues);
  return issues;
}

/**
 * Validate one object level against its schema and recurse into nested objects and array
 * items, so a malformed entry deep inside e.g. file_edit_batch's `edits` or
 * browser_run_script's `steps` is answered with a precise, path-qualified error
 * ("edits[1].path is required.") instead of failing opaquely at runtime after its valid
 * siblings already executed. Nested schemas without declared `properties` (free-form
 * objects like jira `fields`) are passed through unchecked.
 */
function validateObjectAgainstSchema(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  pathPrefix: string,
  issues: ToolInputValidationIssue[],
): void {
  const properties = (schema["properties"] ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [];
  const at = (key: string) => (pathPrefix ? `${pathPrefix}.${key}` : key);

  for (const key of required) {
    const propSchema = properties[key] as Record<string, unknown> | undefined;
    const propValue = value[key];
    if (propValue === undefined || propValue === null) {
      issues.push({ path: at(key), kind: "missing_required", message: `${at(key)} is required.` });
      continue;
    }
    if (propSchema?.["type"] === "string" && typeof propValue === "string" && propValue.trim() === "") {
      issues.push({ path: at(key), kind: "missing_required", message: `${at(key)} is required.` });
    }
  }

  for (const [key, propValue] of Object.entries(value)) {
    const propSchema = properties[key] as Record<string, unknown> | undefined;
    if (!propSchema || propValue === undefined || propValue === null) continue;
    validateValueAgainstSchema(propValue, propSchema, at(key), issues);
  }
}

function validateValueAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  issues: ToolInputValidationIssue[],
): void {
  const expected = typeof schema["type"] === "string" ? String(schema["type"]) : "";
  if (expected && !matchesSchemaType(value, expected)) {
    issues.push({ path, kind: "invalid_type", message: `${path} must be ${expected}.` });
    return;
  }
  const enumValues = Array.isArray(schema["enum"]) ? (schema["enum"] as unknown[]) : null;
  if (enumValues && enumValues.length > 0 && !enumValues.includes(value)) {
    issues.push({
      path,
      kind: "invalid_enum",
      message: `${path} must be one of: ${enumValues.map((v) => String(v)).join(", ")}.`,
    });
    return;
  }
  if (expected === "object" && schema["properties"]) {
    validateObjectAgainstSchema(value as Record<string, unknown>, schema, path, issues);
  } else if (expected === "array" && Array.isArray(value)) {
    const items = schema["items"] as Record<string, unknown> | undefined;
    if (items) {
      value.forEach((item, i) => {
        if (item === undefined || item === null) return;
        validateValueAgainstSchema(item, items, `${path}[${i}]`, issues);
      });
    }
  }
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

/**
 * Schema-driven, best-effort repair of a tool call's arguments before validation and
 * dispatch. Models — especially through the OpenAI wire format, where every argument
 * travels as JSON text the model composes — routinely send near-miss values: a number as
 * "5", a boolean as "true", an issue number as 42 where the schema wants a string, a whole
 * array as its JSON-stringified form, or an enum member with the wrong case ("Status").
 * Each of those used to bounce the call back with a validation error and cost a full model
 * turn to repair. Every coercion here is loss-free and unambiguous — anything questionable
 * is left untouched for validateToolInput to report. Returns a new object; never throws,
 * never mutates the input.
 */
export function coerceToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  // Streamed arguments can legally decode to null (a known slop pattern for no-arg calls)
  // or to a non-object despite the type annotation — normalize null/undefined to the
  // empty-args object the model meant, and pass anything else through untouched for
  // validateToolInput to report, instead of letting Object.entries throw and take the
  // whole turn's tool execution down with it.
  if (input === null || input === undefined) return {};
  if (typeof input !== "object" || Array.isArray(input)) return input;
  const toolDef = TOOL_DEFINITION_MAP[toolName];
  if (!toolDef) return input;
  return coerceObject(input, toolDef.input_schema as unknown as Record<string, unknown>);
}

function coerceObject(value: Record<string, unknown>, schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema["properties"] ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, propValue] of Object.entries(value)) {
    const propSchema = properties[key] as Record<string, unknown> | undefined;
    out[key] = propSchema ? coerceValue(propValue, propSchema) : propValue;
  }
  return out;
}

function coerceValue(value: unknown, schema: Record<string, unknown>): unknown {
  if (value === undefined || value === null) return value;
  const expected = typeof schema["type"] === "string" ? String(schema["type"]) : "";
  const enumValues = Array.isArray(schema["enum"]) ? (schema["enum"] as unknown[]) : null;

  switch (expected) {
    case "string": {
      // Scalars stringify losslessly ("42", "true"); objects/arrays don't — leave those.
      if (typeof value === "number" || typeof value === "boolean") value = String(value);
      if (enumValues && typeof value === "string" && !enumValues.includes(value)) {
        const needle = value.trim().toLowerCase();
        const hit = enumValues.find((v) => typeof v === "string" && v.toLowerCase() === needle);
        if (hit !== undefined) value = hit;
      }
      return value;
    }
    case "number": {
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
      return value;
    }
    case "boolean": {
      if (typeof value === "string") {
        const lowered = value.trim().toLowerCase();
        if (lowered === "true") return true;
        if (lowered === "false") return false;
      }
      return value;
    }
    case "array": {
      let arrValue = value;
      if (typeof arrValue === "string" && arrValue.trim().startsWith("[")) {
        try {
          const parsed = JSON.parse(arrValue) as unknown;
          if (Array.isArray(parsed)) arrValue = parsed;
        } catch { /* not JSON — leave for validation to report */ }
      }
      const items = schema["items"] as Record<string, unknown> | undefined;
      if (Array.isArray(arrValue) && items) return arrValue.map((item) => coerceValue(item, items));
      return arrValue;
    }
    case "object": {
      let objValue = value;
      if (typeof objValue === "string" && objValue.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(objValue) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) objValue = parsed;
        } catch { /* not JSON — leave for validation to report */ }
      }
      if (objValue && typeof objValue === "object" && !Array.isArray(objValue) && schema["properties"]) {
        return coerceObject(objValue as Record<string, unknown>, schema);
      }
      return objValue;
    }
    default:
      return value;
  }
}

/**
 * Nearest tool name for an unknown one, so a near-miss call ("file_reed", "fileRead",
 * "Shell_Run") gets a self-correcting "did you mean" hint instead of only a generic
 * unknown-tool error. Matches case-insensitively with underscores/dots/dashes normalized
 * away, then falls back to an edit-distance scan bounded relative to the name's length —
 * far-off names return undefined rather than a misleading suggestion. Pass `candidates`
 * (the session's actually-advertised tool names) so the hint never recommends a tool that
 * is disabled or unavailable in this session — that would cost the model a second wasted
 * turn; the ALL_TOOLS default is only a fallback for callers with no session context.
 */
export function suggestToolName(unknownName: string, candidates?: readonly string[]): string | undefined {
  const canon = (s: string) => s.toLowerCase().replace(/[._-]/g, "");
  const target = canon(unknownName);
  if (!target) return undefined;
  const names = candidates ?? ALL_TOOLS.map((t) => t.name);
  let best: { name: string; distance: number } | undefined;
  for (const name of names) {
    const candidate = canon(name);
    if (candidate === target) return name;
    const distance = editDistance(target, candidate);
    if (!best || distance < best.distance) best = { name, distance };
  }
  const maxDistance = Math.max(2, Math.floor(target.length / 4));
  return best && best.distance <= maxDistance ? best.name : undefined;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 8) return Number.MAX_SAFE_INTEGER;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length]!;
}
