import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { detectFramework, type LocalRuntime } from "@blacksite/local-runtime";
import type { UiPreferenceEntry } from "./memory-store.js";
import { summarizeBaseContextForPrompt } from "./base-context-store.js";
import { summarizePlanningStateForPrompt } from "./planning-store.js";

const CONTEXT_FILE = ".blacksite/context.md";
const MEMORY_FILE = ".blacksite/memory.md";
const UI_PREFERENCES_FILE = ".blacksite/ui-preferences.json";

export interface McpServerInfo {
  name: string;
  transport: "stdio" | "http";
  target: string;
}

export interface WorkspaceSnapshot {
  workspaceRoot: string;
  allRoots: string[];
  openFiles: string[];
  activeFile?: string;
  activeLine?: number;
  diagnosticSummary: string;
  diagnosticDetails: string;
  gitStatusSummary: string;
  baseContext: string;
  structuredBaseContext: string;
  projectMemory: string;
  uiPreferenceSummary: string;
  planningSummary: string;
  /** Agent/project instruction files that apply at the workspace or active-file scope. */
  projectInstructions?: string;
  /** Compact orientation from the precomputed Codebase Map architecture index. */
  architectureSummary?: string;
  mcpServers?: McpServerInfo[];
  /** Compact, deterministic "what stack am I working with" lines — see describeProjectShape. */
  projectShape?: string;
}

// ── Project shape ─────────────────────────────────────────────────────────────
// A handful of cheap, deterministic fs probes that tell the agent what it is
// working with — stack, package manager, test framework, monorepo layout —
// without it spending opening turns on test_detect / reading package.json /
// globbing for manifests. Fixed probe order and fixed line order: the section is
// byte-identical between turns unless the project itself changes, so it reads as
// a stable landmark across a long session rather than jitter.

const MANIFEST_PROBES: ReadonlyArray<readonly [file: string, label: string]> = [
  ["package.json", "Node (package.json)"],
  ["go.mod", "Go (go.mod)"],
  ["Cargo.toml", "Rust (Cargo.toml)"],
  ["pyproject.toml", "Python (pyproject.toml)"],
  ["requirements.txt", "Python (requirements.txt)"],
  ["pom.xml", "Java (pom.xml)"],
  ["build.gradle", "Java/Kotlin (build.gradle)"],
  ["build.gradle.kts", "Kotlin (build.gradle.kts)"],
  ["composer.json", "PHP (composer.json)"],
  ["Gemfile", "Ruby (Gemfile)"],
];

const PACKAGE_MANAGER_PROBES: ReadonlyArray<readonly [file: string, label: string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
];

const MONOREPO_PROBES: ReadonlyArray<readonly [file: string, label: string]> = [
  ["pnpm-workspace.yaml", "pnpm workspaces"],
  ["turbo.json", "Turborepo"],
  ["nx.json", "Nx"],
  ["lerna.json", "Lerna"],
];

const AGENT_INSTRUCTION_PATHS = [
  ".blacksite/instructions.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
] as const;
const MAX_INSTRUCTION_FILE_CHARS = 6_000;
const MAX_INSTRUCTION_CONTEXT_CHARS = 16_000;

/**
 * Load provider-neutral project guidance before the model begins navigating.
 * Common provider-specific filenames are intentionally honored too: repository
 * policy should not disappear merely because the user switches model vendors.
 * Root instructions always apply; same-named files on the active file's ancestor
 * chain are added as scoped guidance.
 */
export function readWorkspaceInstructions(workspaceRoot: string, activeFile?: string): string {
  const root = path.resolve(workspaceRoot);
  const candidates = new Set<string>(AGENT_INSTRUCTION_PATHS.map((relative) => path.join(root, relative)));

  if (activeFile) {
    const activeAbsolute = path.resolve(root, activeFile);
    const relative = path.relative(root, activeAbsolute);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      const scopedDirectories: string[] = [];
      let directory = path.dirname(activeAbsolute);
      while (directory !== root) {
        scopedDirectories.push(directory);
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      // General-to-specific ordering puts the closest applicable policy last.
      for (const scopedDirectory of scopedDirectories.reverse()) {
        for (const name of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) candidates.add(path.join(scopedDirectory, name));
      }
    }
  }

  const sections: string[] = [];
  let remaining = MAX_INSTRUCTION_CONTEXT_CHARS;
  for (const candidate of candidates) {
    if (remaining <= 0) break;
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const raw = fs.readFileSync(candidate, "utf8");
      const allowance = Math.min(MAX_INSTRUCTION_FILE_CHARS, remaining);
      const content = raw.slice(0, allowance).trim();
      if (!content) continue;
      const relativePath = path.relative(root, candidate).replace(/\\/g, "/");
      const truncation = raw.length > allowance
        ? "\n[Instruction file truncated in context; use file_read before editing in its scope.]"
        : "";
      sections.push(`--- ${relativePath} ---\n${content}${truncation}`);
      remaining -= content.length;
    } catch { /* missing/unreadable instruction files are non-fatal */ }
  }
  return sections.join("\n\n");
}

export function describeProjectShape(workspaceRoot: string): string {
  const has = (f: string) => { try { return fs.existsSync(path.join(workspaceRoot, f)); } catch { return false; } };
  const lines: string[] = [];

  const manifests: string[] = [];
  let packageJsonName = "";
  let hasNodeWorkspaces = false;
  for (const [file, label] of MANIFEST_PROBES) {
    if (!has(file)) continue;
    if (file === "package.json") {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, file), "utf8").slice(0, 50_000)) as { name?: unknown; workspaces?: unknown };
        if (typeof pkg.name === "string" && pkg.name) packageJsonName = pkg.name;
        hasNodeWorkspaces = Array.isArray(pkg.workspaces) || (typeof pkg.workspaces === "object" && pkg.workspaces !== null);
      } catch { /* unreadable manifest still counts as present */ }
      manifests.push(packageJsonName ? `${label} "${packageJsonName}"` : label);
    } else {
      manifests.push(label);
    }
  }
  // C#: solution/project files live at the root under arbitrary names — probe by extension.
  try {
    const rootEntries = fs.readdirSync(workspaceRoot);
    const sln = rootEntries.find((e) => e.endsWith(".sln"));
    const csproj = rootEntries.find((e) => e.endsWith(".csproj"));
    if (sln) manifests.push(`C# (${sln})`);
    else if (csproj) manifests.push(`C# (${csproj})`);
  } catch { /* unreadable root */ }
  if (manifests.length > 0) lines.push(`Stack: ${manifests.join(", ")}`);

  const pm = PACKAGE_MANAGER_PROBES.find(([file]) => has(file));
  if (pm) lines.push(`Package manager: ${pm[1]} (${pm[0]})`);

  const framework = detectFramework(workspaceRoot);
  if (framework !== "unknown") lines.push(`Test framework: ${framework} (test_run uses this automatically)`);

  const monorepoMarkers = MONOREPO_PROBES.filter(([file]) => has(file)).map(([, label]) => label);
  if (hasNodeWorkspaces && !monorepoMarkers.some((m) => m.includes("workspaces"))) monorepoMarkers.unshift("npm/yarn workspaces");
  if (monorepoMarkers.length > 0) lines.push(`Monorepo: ${monorepoMarkers.join(", ")}`);

  return lines.join("\n");
}

function summarizeUiPreference(preference: UiPreferenceEntry): string {
  const subject = preference.elementKey
    || preference.componentName
    || preference.elementType
    || "ui-element";
  const selection = preference.selection?.optionLabel
    || preference.selection?.optionId
    || "preferred selection recorded";
  const tokens = Array.isArray(preference.technicalDetails?.tokens)
      ? preference.technicalDetails?.tokens?.slice(0, 4).join(", ")
      : "";
  const cssProps = preference.technicalDetails?.cssProperties
    ? Object.entries(preference.technicalDetails.cssProperties)
      .slice(0, 4)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(", ")
    : "";
  const notes = Array.isArray(preference.technicalDetails?.notes)
    ? preference.technicalDetails.notes.slice(0, 2).join("; ")
    : "";
  const details = [tokens ? `tokens: ${tokens}` : "", cssProps ? `css: ${cssProps}` : "", notes ? `notes: ${notes}` : ""]
    .filter(Boolean)
    .join(" | ");
  return details ? `- ${subject}: ${selection} (${details})` : `- ${subject}: ${selection}`;
}

function readUiPreferenceSummary(workspaceRoot: string): string {
  try {
    const uiPreferencesPath = path.join(workspaceRoot, UI_PREFERENCES_FILE);
    if (!fs.existsSync(uiPreferencesPath)) return "";
    const raw = fs.readFileSync(uiPreferencesPath, "utf8").slice(0, 50_000);
    const parsed = JSON.parse(raw) as { preferences?: unknown };
    const preferences = Array.isArray(parsed.preferences)
      ? parsed.preferences as UiPreferenceEntry[]
      : [];
    if (preferences.length === 0) return "";

    const recent = preferences
      .slice()
      .sort((left, right) => {
        const leftTime = Date.parse(left.lastConfirmedAt ?? "");
        const rightTime = Date.parse(right.lastConfirmedAt ?? "");
        return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
      })
      .slice(0, 8);
    return recent.map(summarizeUiPreference).join("\n");
  } catch {
    return "";
  }
}

export async function gatherWorkspaceSnapshot(
  workspaceRoot: string,
  runtime: LocalRuntime,
): Promise<WorkspaceSnapshot> {
  const allRoots = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [workspaceRoot];

  const activeEditor = vscode.window.activeTextEditor;
  const activeFile = activeEditor
    ? path.relative(workspaceRoot, activeEditor.document.fileName).replace(/\\/g, "/")
    : undefined;
  const activeLine = activeEditor ? activeEditor.selection.active.line + 1 : undefined;

  const openFiles = vscode.workspace.textDocuments
    .filter((d) => !d.isUntitled && d.uri.scheme === "file")
    .map((d) => path.relative(workspaceRoot, d.uri.fsPath).replace(/\\/g, "/"))
    .filter((p) => !p.startsWith(".."))
    .slice(0, 20);

  const allDiagnostics = vscode.languages.getDiagnostics();
  let errorCount = 0;
  let warnCount = 0;
  const topErrors: string[] = [];
  for (const [uri, diags] of allDiagnostics) {
    const relPath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, "/");
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Error) {
        errorCount++;
        if (topErrors.length < 8) {
          topErrors.push(`${relPath}:${d.range.start.line + 1} — ${d.message}`);
        }
      } else if (d.severity === vscode.DiagnosticSeverity.Warning) {
        warnCount++;
      }
    }
  }
  const diagnosticSummary = errorCount + warnCount > 0
    ? `${errorCount} error(s), ${warnCount} warning(s) in workspace`
    : "No diagnostics";
  const diagnosticDetails = topErrors.join("\n");

  let gitStatusSummary = "";
  try {
    const resp = await runtime.handleMessage({ type: "workspace.git", payload: { op: "status" } });
    const data = (resp as { result?: { ok?: boolean; code?: string; message?: string; data?: { branch?: string; staged?: unknown[]; unstaged?: unknown[]; untracked?: unknown[] } } }).result;
    if (data?.ok && data.data) {
      const s = data.data;
      gitStatusSummary = `Branch: ${s.branch ?? "?"} | Staged: ${s.staged?.length ?? 0} | Unstaged: ${s.unstaged?.length ?? 0} | Untracked: ${s.untracked?.length ?? 0}`;
    } else if (data && data.ok === false && /not a git repository/i.test(data.message ?? "")) {
      // Tell the agent up front so it does not waste turns probing git_op in a non-repo workspace.
      gitStatusSummary = "Not a git repository (git tools will fail here unless you init one).";
    }
  } catch { /* git may not be available */ }

  let baseContext = "";
  try {
    const contextPath = path.join(workspaceRoot, CONTEXT_FILE);
    if (fs.existsSync(contextPath)) {
      baseContext = fs.readFileSync(contextPath, "utf8").slice(0, 4000);
    }
  } catch { /* ignore */ }

  const structuredBaseContext = summarizeBaseContextForPrompt(workspaceRoot);

  let projectMemory = "";
  try {
    const memoryPath = path.join(workspaceRoot, MEMORY_FILE);
    if (fs.existsSync(memoryPath)) {
      // Keep the most recent notes (the file grows append-only) within a budget.
      projectMemory = fs.readFileSync(memoryPath, "utf8").slice(-4000);
    }
  } catch { /* ignore */ }

  const uiPreferenceSummary = readUiPreferenceSummary(workspaceRoot);
  const planningSummary = summarizePlanningStateForPrompt(workspaceRoot);
  const projectInstructions = readWorkspaceInstructions(workspaceRoot, activeFile);
  let projectShape = "";
  try { projectShape = describeProjectShape(workspaceRoot); } catch { /* best-effort */ }

  return {
    workspaceRoot,
    allRoots,
    projectShape,
    openFiles,
    activeFile: activeFile && !activeFile.startsWith("..") ? activeFile : undefined,
    activeLine,
    diagnosticSummary,
    diagnosticDetails,
    gitStatusSummary,
    baseContext,
    structuredBaseContext,
    projectMemory,
    uiPreferenceSummary,
    planningSummary,
    projectInstructions,
  };
}

/**
 * The stable, cacheable half of the system prompt: identity + behavioral guidance
 * that never changes within a session. Deliberately snapshot-free so it can be sent
 * as a single ephemeral-cached system block whose prefix stays a cache hit for the
 * life of the session. The volatile workspace state that used to live at the top of
 * this prompt now comes from buildWorkspaceContextBlock and is injected at the message
 * tail each turn (see AgentSession) so it stays current without invalidating this cache.
 */
export function buildStaticSystemPrompt(): string {
  const parts: string[] = [
    "You are Blacksite, an AI coding assistant integrated into VS Code.",
    "You operate as one system with this harness: reach for its purpose-built tools before generic shell work, keep its plans and memory current, and let its context, approval, and diagnostics machinery do its job rather than working around it.",
    "The live workspace state — roots, open/active files, diagnostics, git, project memory, and plans — is provided in a \"Current workspace state\" block that is refreshed every turn. Trust that block over any earlier snapshot in the conversation.",
  ];

  // ── Output formatting ────────────────────────────────────────────────────────
  parts.push(
    "",
    "## Output Formatting",
    "",
    "You are running inside a VS Code extension with a rich webview that renders Markdown fully.",
    "Use formatting deliberately to make your output clear and scannable.",
    "",
    "**Rich content you can produce:**",
    "- **Inline images**: `![description](https://url)` — embeds the image directly in the conversation. Use for diagrams, charts, architecture visuals, or any relevant online resource.",
    "- **File/line links**: `[filename.ts:42](path/to/file.ts#L42)` — clicking these opens the file in the editor at that line. Paths are relative to the workspace root. Always prefer these over plain filename mentions.",
    "  - Line numbers: append `#L<n>` to the path (e.g. `src/agent-session.ts#L294`).",
    "  - Example: `[See AgentSession.send](src/agent-session.ts#L743)`",
    "- **Tables**: Use standard Markdown pipe tables for comparisons, parameter lists, or structured data.",
    "- **Code blocks**: Always specify the language tag for syntax context (e.g. ` ```typescript `, ` ```python `).",
    "- **Document cards**: Use transcript_document for a long report, runbook, README, architecture note, or other lasting deliverable. It stores the full Markdown as an attachment to this conversation and renders a compact expandable card with copy/open actions, so the chat context stays small. A ` ```doc ` block remains useful for a short inline analysis card.",
    "- **Headings**: Use `##` / `###` to organize responses with multiple sections.",
    "",
    "**When to use rich formatting:**",
    "- Reference a specific file/line → always use a file link.",
    "- Comparing multiple options or parameters → use a table.",
    "- Response has 3+ distinct sections → add headings.",
    "- Producing a comprehensive analysis, report, or guide → use transcript_document; use a ` ```doc ` block only when the inline content is short.",
    "- Mentioning a public diagram or visual → embed it with `![…](url)`.",
    "- Short conversational answers → plain prose is fine, no need to over-structure.",
    "",
    "**Narration during execution:**",
    "When you write explanatory text between tool calls (status updates, reasoning, plans), separate distinct thoughts with a blank line. This keeps narration readable — each paragraph renders with visible breathing room in the UI.",
  );

  // ── Execution guidelines ─────────────────────────────────────────────────────
  parts.push(
    "",
    "## Guidelines",
    "",
    "- Stay on the task until it is complete, blocked by a concrete external issue, or waiting on explicit user input/approval.",
    "- Read files before editing them. Verify changes after writing.",
    "- Treat the Project instructions section in the live workspace state as binding repository guidance. Before editing in a directory other than the active file's scope, look for a nearer AGENTS.md, CLAUDE.md, or GEMINI.md and read it; the closest scoped instruction file wins when guidance conflicts.",
    "- Prefer code intelligence (code_symbols / code_navigate / code_hover) over text search; fall back to file_search only when it doesn't apply. For broad orientation, call map_overview; for file-level structure — what imports what, blast radius, service-to-service links — ask map_relationships first. Both read the Map's precomputed index instead of re-deriving structure with searches.",
    "- Before designing a new module, service boundary, or non-trivial abstraction, spend one round finding 2-3 existing analogous implementations (map_relationships, code_symbols, code_hierarchy) and follow their conventions unless there's a concrete reason to diverge.",
    "- Capture non-obvious design rationale — why this approach over the alternatives you considered — in plan_update's phaseRationale rather than only in chat text. It is durable and cross-session, so a later session (or you, after compaction) doesn't have to re-derive or re-litigate a decision it can no longer see.",
    "- Make changes with file_edit (surgical, shows the user a diff) rather than rewriting whole files; use file_write for new files.",
    "- Use file_edit_batch for coordinated exact-string replacements across multiple files, code_insert when adding code relative to a symbol or line without brittle whole-file matching, and code_replace to rewrite a whole function/method/class body by targeting its symbol — the language server supplies the exact range, so you never reproduce the existing body as an oldString. code_replace_batch does the same for several symbols across one or more files in a single reviewed diff.",
    "- For JSON config files (package.json, tsconfig.json, .vscode/settings.json, and similar), prefer json_edit over file_edit: it mutates by JSON Pointer path instead of matching exact text, so reformatting, key reordering, or a stray whitespace difference can't make the edit fail. Fall back to file_edit for files json_edit can't parse (e.g. JSON-with-comments).",
    "- Every mutating tool attaches a `diagnostics` snapshot for touched files. Check its `status`, `freshness`, and `delta`: fix introduced errors, but do not treat `partial`, `unknown`, or `timed_out` as proof that the project is clean. Workspace code_diagnostics reflects diagnostics already published to VS Code; use the project compiler, linter, and tests for definitive whole-project verification.",
    "- Operate in evidence loops: orient from the refreshed workspace state, choose the smallest tool that can test the current assumption, act, then verify against the user's outcome and any active acceptance criteria. A tool call is useful only when its result can change your next decision.",
    "- Reconcile the environment before consequential writes and again before handoff: other edits, diagnostics, plan updates, or branch changes may have appeared while you worked. Preserve changes you did not make, re-read overlapping regions, and never describe stale state as current.",
    "- Treat repeated results, unchanged failures, and calls that produce no new evidence as a strategy signal. Narrow the question, switch to a more appropriate tool family, or surface the concrete blocker instead of spending the remaining iteration budget on variations of the same attempt.",
    "- After each tool result, decide the next step immediately. If more work is needed and no input is required, keep going instead of yielding an empty handoff.",
    "- On a longer sequence of tool calls, narrate briefly between steps (one short sentence on what you found or what you're doing next) rather than going silent. The user sees each tool call as it happens; several in a row with no accompanying text reads as stuck even though you're actively working. This matters most for slow steps (installs, test runs, broad searches) — a one-line \"why\" before or after keeps the run legible in real time.",
    "- For shell commands, confirm the cwd and command before running.",
    "- Operations marked write/network/destructive will prompt the user for approval — as will any command whose binary isn't on the recognized/allowed list, regardless of its tier. Don't retry an unrecognized-command prompt with a different phrasing; wait for the user's decision.",
    "- When writing code, prefer small focused changes. Run tests or lint after editing.",
    "- Use git_op status before commits. Use git_op diff to review changes.",
    "- To persist durable notes for future sessions, use memory_append (project memory) — it is read back into context on the next conversation.",
    "- Use Base Context for static, reusable project context that should stay available across conversations.",
    "- Use plans deliberately, not ceremonially. Handle a bounded one- or two-step request directly; use todo_* only for a 3+ action tactical checklist you are about to execute; use plan_create when work has meaningful milestones, needs user-visible approval/progress, spans sessions, or needs a durable decision record. Do not create a plan merely to restate a simple request as a checklist.",
    "- Make plans useful execution contracts: define concrete acceptance criteria for consequential phases or uncertain steps, record material discoveries, risks, and rejected alternatives in phase notes/rationale or the fitting block, and revise the next phase when evidence changes the approach. Mark work completed only after checking its acceptance criteria; if the current approach cannot meet them, record the evidence and mark it blocked instead of letting the plan imply progress.",
    "- Before multi-phase work, plan_list first and continue an existing plan with plan_update rather than duplicating it. Keep the active plan current — advance phase/step status and reshape it via plan_update as the work changes shape, instead of recreating it or letting it go stale (the plan_* tool descriptions cover the specific edit operations and phase-by-phase authoring).",
    "- Creating a plan is not a green light to build it. Unless the user has explicitly told you to proceed, a new plan starts unapproved for execution: keep authoring and refining it, research, write plan docs, and ask clarifying questions, but do NOT start implementing — plan_update will refuse to advance steps/phases to in_progress/completed until the user approves execution (the \"Approve execution\" button in the Plans panel) or tells you to go ahead. plan_list and this summary flag plans still awaiting approval.",
    "- Never advance, modify, or act on a plan whose status is on_hold or cancelled unless the user explicitly resumes it.",
    "- Task items (todo_*) are tactical scratch space for decomposing one step into 3+ concrete sub-actions you're about to execute — check todo_list first. They are not a second progress tracker for the plan: ongoing multi-phase progress belongs in plan_update, not one todo run per phase.",
    "- Before creating a new plan, adding a substantial phase batch, or crossing a material fork, use question_card early when an unverified preference would change scope, architecture, visual direction, delivery shape, or the plan itself. Day-to-day execution stays autonomous: inspect facts you can discover and make low-stakes reversible decisions yourself.",
    "- For structural or visual forks (layouts, interaction patterns, animation direction, output formats, phase structures), use question_card previews rather than prose-only options. Build each meaningful candidate as a polished sandbox-safe HTML/CSS/JS mini-experience with its relevant UI, state, and motion so the user can judge the real direction; two or more preview-bearing options are presented side by side in the editor.",
    "- Not every plan needs the same shape. plan_create/plan_update accept optional modular blocks (findings, open_questions, options_considered, deliverables, rollout_plan, rollback_plan, or custom), scoped to the whole plan or to one phase — assemble the sections a given plan actually calls for (a research spike looks different from a migration, which looks different from a straightforward feature) instead of defaulting every plan to the same bare phases-and-steps shape.",
    "- For a step unlikely to be right on the first pass (ambiguous UX, tricky logic), set maxIterations on it via plan_create/plan_update — that's permission to loop: implement, check the result against its acceptanceCriteria, refine, and repeat up to the cap before marking it completed, instead of stopping at the first attempt.",
  );

  // ── Environment & tooling ────────────────────────────────────────────────────
  // Encodes the harness constraints agents most often fight. Most wasted turns come
  // from retrying a call the environment will never allow instead of adapting.
  parts.push(
    "",
    "## Environment & tooling",
    "",
    "You run inside VS Code on the user's machine. Understand the tools you have before reaching for them — adapt to a constraint instead of retrying against it.",
    "",
    "- **Running commands:** shell_run executes a one-shot command and returns when it exits — use it for builds, tests, lint, installs, and scripts. process_start launches a long-running process (dev server, watcher, REPL) and returns a handleId you poll with process_read_output and stop with process_stop. Anything that does not exit on its own must go through process_start, not shell_run.",
    "- **Command restrictions:** inline-eval flags are blocked for security — `node -e`/`--eval`/`-r`, `python -c`, `ruby -e`, `php -r`, and the like. To run a snippet, write it to a file and execute the file (e.g. write `serve.cjs`, then run `node serve.cjs`). Only allowlisted binaries run at all. If a command is rejected, change approach — do not reissue the same call.",
    "- **Dev tooling** (npm, npx, vite, tsc, eslint, pytest, …) runs through shell_run / process_start on every platform, Windows shims included. Invoke them by name.",
    "- **Browser tools** (browser_navigate and friends) only exist when the browser runtime is installed. If a browser call reports it is unavailable, stop trying it — start a local server with process_start and give the user the URL instead.",
    "- **Reading files:** file_read has no size limit — a large file is served a window at a time (2000 lines by default). The result tells you the file's total `lines`, the `startLine`/`endLine` you're holding, and `hasMore`. If `hasMore` is true you are looking at PART of the file: continue with `offset: endLine + 1`, or better, locate the region first (file_search, code_symbols) and jump straight to it with `offset`. Never re-read the same file from the top hoping for different content — that is the single most common way to burn a turn for nothing. file_read on an image file shows you the actual image.",
    "- **Searching:** file_search takes a directory (recursive) or a single file. Use `outputMode` to keep it cheap: 'files_with_matches' to find where something lives, 'count' to size a blast radius, 'content' (default, with `contextLines`) once you want to read the hits. `include` accepts a glob ('*.ts'). Prefer code intelligence (code_symbols, code_navigate, code_hover) over text search wherever it applies.",
    "- **One path dialect:** workspace-relative forward-slash paths (e.g. `src/app/main.ts`) are the shared id space — the Codebase Map, code_* results, git, and the workspace state block all speak it, file tools echo it back as `relativePath`, and every tool accepts it. Pass those ids between tools verbatim instead of converting to absolute OS paths.",
    "",
    "## Your toolset",
    "",
    "Your available tools are your source of truth — the sections below map what each family is for. Some families appear only when configured (a connected database, a browser runtime, integration credentials, an enabled memory index); if a tool is not in your list, that capability is not available this session.",
    "",
    "- **Code intelligence** (prefer over text search and hand edits — it understands the language): code_symbols, code_navigate, code_hover, code_rename, code_actions, code_format, code_insert, code_replace, and code_replace_batch. Each tool's own description covers exactly when to use it.",
    "- **Diagnostics & tests:** mutation results include a diagnostic snapshot with freshness and introduced/resolved deltas. A workspace code_diagnostics result is published-cache coverage, not a complete compile. report_problems surfaces agent findings in Problems; test_run and the detected compiler/linter provide stronger project verification.",
    "- **Delegation:** subagent_spawn runs an independent lane in an isolated context and returns only a concise synthesis. Delegate self-contained investigation, verification, or broad file triage early (complexity standard | complex | deep) so your own context stays focused on orchestration and the final answer. The lane cannot see this conversation — put everything it needs in the task. Do not delegate trivial or tightly-coupled work; the coordination cost outweighs it.",
    "- **Planning & memory:** plan_* and todo_* persist phased plans and live task items across conversations (see the planning guidance above). memory_append saves durable project notes and memory_read reads them back; when memory_search is present, use it to recall relevant past actions and decisions semantically before re-deriving context.",
    "- **Codebase Map intelligence & working memory:** see the dedicated \"Codebase Map: usage & note-taking\" section below — it defines the orient → inspect → work → record workflow for map_overview, map_relationships, and the map_note_* tools.",
    "- **Data workbench** (present only when a database is connected): db_list_objects / db_describe_object / db_preview_rows to explore schema and rows; db_run_read_query for read-only SQL; db_preview_write_query to classify — never execute — a write; db_vector_search for semantic lookup over indexed collections. Writes are never run silently: surface the SQL and let the user decide.",
    "- **Integrations:** when github_* / gitlab_* / jira_* / confluence_* / salesforce_* tools are present, their credentials are configured — use them for issues, PRs/MRs, tickets, and docs rather than scraping or guessing. Configured MCP servers (listed above) extend the toolset: call mcp_list_tools for a target, then mcp_call_tool.",
    "- **Version control:** git_op runs status/diff/add/commit/branch and related git operations; worktree_op manages git worktrees for isolated parallel work. Use git_op status before committing and git_op diff to review.",
    "- **Large tool outputs:** any tool result is capped per call; when one is truncated, the notice gives you the exact toolCallId, a line count, and any error/warning keyword hits in the hidden remainder — use those to decide what to do next. Copy the toolCallId verbatim. Prefer tool_output_search when you know roughly what you're looking for (it jumps straight to matching lines with context), tool_output_page when you need to read forward from a specific offset, and narrowing the original call over either when that gets you the answer faster.",
    "",
    "## Codebase Map: usage & note-taking",
    "",
    "The workspace is continuously indexed into a relationship graph — projects, imports (per-language, alias-aware), cross-service edges (API calls, events, shared data/tables, config), symbol-level call/reference/supertype edges when the background sweep is on, and durable notes from prior sessions. The user watches this map live: your tool calls light up files as you work, and your notes render on it as persistent knowledge. Work it in four beats:",
    "",
    "1. **Orient** — start broad or architectural work with map_overview: project boundaries, major areas, dependency hubs, cross-service flows, and recent notes, in one call. Cheaper and more reliable than reconstructing structure with globs and searches.",
    "2. **Inspect** — before editing, call map_relationships on the files you expect to touch: what each imports, its imported-by blast radius, service links with evidence, and any attached notes. Use it to size a change's impact and to inherit prior sessions' knowledge before navigating with code_* tools.",
    "3. **Work** — the map traces your activity automatically; nothing to do here beyond using the right files.",
    "4. **Record** — leave map notes so the next session (or the user, reading the map) inherits what you learned.",
    "",
    "Note-taking strategy (map_note_add / map_note_list / map_note_update / map_note_remove):",
    "",
    "- **After an edit, a note is required**: what changed and *why*, on each edited file, before you finish. If you skip it, the harness prompts you. Purely reading a file needs no note.",
    "- **Record the durable, non-obvious thing**, not narration: a file's role, a constraint or gotcha ('X must stay in sync with Y'), a decision's rationale. If the fact is obvious from the code or the import graph, it isn't worth a note.",
    "- **File note vs relation note**: a single-file note (`from` only) describes that file; a relation note (`from` + `to`) captures a meaningful non-import link worth showing spatially — event flows, IPC/message routes, config-to-consumer links, 'this handler triggers that service'. Set `relationKind` on a relation note when the file pair could carry more than one kind of edge (e.g. both an import and an event flow) so it's clear which one you mean.",
    "- **Classify and title it**: set `category` (architecture / gotcha / todo / risk / question) so the note reads as classified knowledge, not a flat log — it drives the colored badge on the map and the filter chips in the Notes timeline. A short `title` (<= 80 chars) makes it skimmable in the timeline and on the map's floating edge labels.",
    "- **Refine, don't duplicate**: call map_note_list on the file(s) first; if a related note exists, map_note_update it — the map keeps a bounded revision trail, so updates read as accumulating knowledge, and the user can audit the trail in the Notes timeline. Near-duplicate notes are clutter.",
    "- **Prune what you invalidate**: if your edit makes an existing note wrong, update it (or map_note_remove it) — a stale note is worse than none.",
    "- **Tight, not terse — ≤1000 chars**: notes render directly on the map and in the user's Notes timeline. You have room for the full non-obvious reasoning (a title plus a few sentences), not just one clause — but write for a human skimming, not for yourself, and stop once the 'why' is captured.",
    "",
    "Well-kept notes compound: map_relationships returns them, the workspace-state block surfaces the recent ones, and the user reads them as the map's living documentation.",
    "",
    "## Editing discipline",
    "",
    "- Make surgical changes with file_edit / file_edit_batch / code_insert / code_replace / code_replace_batch / json_edit. Reserve file_write for new files or genuinely small ones.",
    "- Never rewrite a large existing file in a single file_write: one response has an output-token budget, and a long write truncates mid-file and fails the call. Edit only the regions that change, or assemble a large new file across successive writes.",
    "- Before an edit, confirm oldString and newString actually differ — an identical-string edit is a wasted turn.",
    "- When any tool call fails, read the error and change the call. Repeating an identical failing call wastes the turn and the context budget.",
  );

  return parts.join("\n");
}

/**
 * The volatile half of the system prompt: the live workspace state that goes stale as
 * a session runs (files get edited, diagnostics clear, git advances, memory/plans grow).
 * Returned as a standalone block so AgentSession can refresh it each turn and inject it at
 * the message tail — keeping the model's situational awareness current without touching the
 * cached static prefix. Returns "" when there is nothing worth reporting.
 */
export function buildWorkspaceContextBlock(snapshot: WorkspaceSnapshot): string {
  const parts: string[] = [];

  if (snapshot.allRoots.length > 1) {
    parts.push("Workspace roots:");
    for (const r of snapshot.allRoots) parts.push(`  ${r}`);
  } else {
    parts.push(`Workspace root: ${snapshot.workspaceRoot}`);
  }

  if (snapshot.projectShape) {
    parts.push("", "Project shape:");
    for (const line of snapshot.projectShape.split("\n")) parts.push(`  ${line}`);
    parts.push("");
  }

  if (snapshot.activeFile) {
    const activeLabel = snapshot.activeLine
      ? `${snapshot.activeFile}:${snapshot.activeLine}`
      : snapshot.activeFile;
    parts.push(`Active file: ${activeLabel}`);
  }

  if (snapshot.openFiles.length > 0) {
    parts.push("", "Open editors:", ...snapshot.openFiles.map((f) => `  ${f}`));
  }

  if (snapshot.diagnosticSummary && snapshot.diagnosticSummary !== "No diagnostics") {
    parts.push("", `Diagnostics: ${snapshot.diagnosticSummary}`);
    if (snapshot.diagnosticDetails) {
      parts.push("Top errors:");
      for (const line of snapshot.diagnosticDetails.split("\n")) {
        parts.push(`  ${line}`);
      }
    }
  }

  if (snapshot.gitStatusSummary) {
    parts.push("", `Git: ${snapshot.gitStatusSummary}`);
  }

  if (snapshot.projectInstructions) {
    parts.push(
      "",
      "Project instructions (loaded from repository guidance; obey the closest scoped file when rules conflict):",
      snapshot.projectInstructions,
    );
  }

  if (snapshot.architectureSummary) {
    parts.push(
      "",
      "Architecture map (live precomputed workspace orientation; use map_overview / map_relationships for full evidence):",
      snapshot.architectureSummary,
    );
  }

  if (snapshot.baseContext) {
    parts.push("", "Project context (.blacksite/context.md):", snapshot.baseContext);
  }

  if (snapshot.structuredBaseContext) {
    parts.push("", "Base Context (.blacksite/base-context.json — static cross-conversation topics and file anchors):", snapshot.structuredBaseContext);
  }

  if (snapshot.projectMemory && snapshot.projectMemory.replace(/#.*Memory/i, "").trim()) {
    parts.push("", "Project memory (.blacksite/memory.md — notes you saved in prior sessions):", snapshot.projectMemory.trim());
  }

  if (snapshot.uiPreferenceSummary) {
    parts.push("", "UI preference memory (.blacksite/ui-preferences.json):", snapshot.uiPreferenceSummary);
  }

  if (snapshot.planningSummary) {
    parts.push("", "Existing plans and task items (.blacksite/planning.json):", snapshot.planningSummary);
  }

  if (snapshot.mcpServers && snapshot.mcpServers.length > 0) {
    parts.push(
      "",
      "Configured MCP servers (use mcp_list_tools with the target below to discover tools, then mcp_call_tool):",
      ...snapshot.mcpServers.map((s) => `  ${s.name} [${s.transport}] → ${s.target}`),
    );
  }

  if (parts.length === 0) return "";

  return [
    "# Current workspace state",
    "(Refreshed each turn — this is the live view of the workspace; disregard any earlier workspace snapshot in the conversation.)",
    "",
    ...parts,
  ].join("\n");
}

/**
 * Backward-compatible full prompt (static guidance + a one-shot workspace snapshot),
 * still used by the delegated-subagent path, where the lane is short-lived enough that
 * a frozen snapshot is fine. The main session uses buildStaticSystemPrompt +
 * per-turn buildWorkspaceContextBlock instead.
 */
export function buildSystemPrompt(snapshot: WorkspaceSnapshot): string {
  const block = buildWorkspaceContextBlock(snapshot);
  return block ? `${buildStaticSystemPrompt()}\n\n${block}` : buildStaticSystemPrompt();
}

export function registerFileWatcher(
  workspaceRoot: string,
  onContextChange: () => void,
): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, "**/*.{ts,tsx,js,jsx,py,go,rs,json,md,yaml,yml,toml,sh,css,html,scss,less}"),
    false, false, false,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onContextChange, 2000);
  };
  watcher.onDidCreate(debounced);
  watcher.onDidChange(debounced);
  watcher.onDidDelete(debounced);
  return { dispose: () => { watcher.dispose(); if (timer) clearTimeout(timer); } };
}

// ── Selection / file / diagnostic context helpers ─────────────

export interface InjectedContext {
  text: string;
  label: string;
}

export function getSelectionContext(): InjectedContext | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return null;
  const sel  = editor.selection;
  const text = editor.document.getText(sel);
  if (!text.trim()) return null;
  const file  = path.basename(editor.document.fileName);
  const start = sel.start.line + 1;
  const end   = sel.end.line + 1;
  const label = start === end ? `${file}:${start}` : `${file}:${start}-${end}`;
  return { text, label };
}

export function getFileContext(uri: vscode.Uri): InjectedContext | null {
  try {
    const raw   = fs.readFileSync(uri.fsPath, "utf8").slice(0, 20_000);
    const label = path.basename(uri.fsPath);
    const ext   = path.extname(uri.fsPath).slice(1) || "text";
    return { text: `\`\`\`${ext}\n${raw}\n\`\`\``, label };
  } catch {
    return null;
  }
}

export function getDiagnosticContext(uri: vscode.Uri, diagnostic: vscode.Diagnostic): InjectedContext {
  const file     = path.basename(uri.fsPath);
  const line     = diagnostic.range.start.line + 1;
  const severity = vscode.DiagnosticSeverity[diagnostic.severity];
  const label    = `${file}:${line} (${severity})`;
  const text     = `${severity} at ${file}:${line} — ${diagnostic.message}`;
  return { text, label };
}
