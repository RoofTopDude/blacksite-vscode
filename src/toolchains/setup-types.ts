/* Shapes shared by the toolchain setup's extension side and its Settings panel. No imports, so the
   webview can use them without pulling in Node modules. */

export type Toolchain = "Python" | "Node" | "Java" | "Go" | ".NET" | "Rust" | "C/C++";

/** Where a fact came from: a workspace-relative file, and the line when there is one. */
export interface Evidence {
  file: string;
  line?: number;
}

export interface ToolchainInstall {
  toolchain: string;
  /** The name it answers to on PATH (`python3`), or the path when found off PATH. */
  command: string;
  path: string;
  version?: string;
  /** Where it came from, in a word: PATH, pyenv, Homebrew, py launcher. */
  source: string;
}

export type VerdictKind = "ok" | "auto" | "use_other" | "too_old" | "missing" | "no_env" | "eol" | "extension" | "info";

export interface VerdictItem {
  kind: VerdictKind;
  toolchain?: Toolchain;
  message: string;
  evidence?: Evidence;
  /** The install that satisfies (or that was checked). */
  install?: Pick<ToolchainInstall, "path" | "version" | "source">;
}

export interface ProjectVerdict {
  dir: string;
  display: string;
  inPlay: boolean;
  needsAttention: boolean;
  toolchains: Toolchain[];
  items: VerdictItem[];
}

export interface ToolchainOverview {
  toolchain: Toolchain;
  projectCount: number;
  installs: Array<ToolchainInstall & { satisfiesCount: number; endOfLife: boolean }>;
  /** Projects no installed version satisfies. */
  unsatisfied: string[];
  latest?: string;
  summary: string;
}

/** What a recommendation would do, before it is turned into concrete script steps. */
export type RecommendationIntent =
  | { kind: "system"; toolchain: Toolchain; version: string }
  | { kind: "project_toolchain"; toolchain: "Node" | "Java" | ".NET"; version: string; project: string }
  | { kind: "venv"; project: string; interpreter?: string; version: string }
  | { kind: "deps"; project: string; argv: string[]; label: string }
  | { kind: "tool"; tool: "uv" | "pnpm" | "yarn" | "poetry" | "pipenv" }
  | { kind: "extension"; id: string }
  | { kind: "workspace_folders"; projects: string[] };

export interface Recommendation {
  id: string;
  title: string;
  /** One or two sentences: why this, and why at this scope. */
  why: string;
  selected: boolean;
  intent: RecommendationIntent;
  /** Projects (display paths) this helps. */
  projects: string[];
  toolchain?: Toolchain;
  /** Set when it cannot run here; shown instead of a checkbox. */
  blocked?: string;
  /** Recommendations it needs to run first (ids). */
  needs?: string[];
}

export interface SetupReport {
  projects: ProjectVerdict[];
  toolchains: ToolchainOverview[];
  recommendations: Recommendation[];
  truncated: boolean;
}

/** One step of a plan, as the panel shows it while and after the terminal runs it. */
export interface SetupRunStep {
  id: string;
  title: string;
  project?: string;
  phase: "prerequisite" | "system" | "project" | "dependencies";
  /** Commands as the preview prints them. */
  commands: string[];
  target: string;
  elevation: "none" | "admin" | "sudo";
  undo: string;
  exitCode?: number;
  skipped?: boolean;
}

export interface ProjectSetupState {
  status: "idle" | "scanning" | "ready" | "planning" | "running" | "done" | "error";
  error?: string;
  platform: string;
  report?: SetupReport;
  machine?: { installs: ToolchainInstall[]; managers: string[]; missing: string[]; probedAt: number };
  /** The plan for the current selection, built for the Review step before anything runs. */
  preview?: { ids: string[]; steps: SetupRunStep[]; extensions: string[]; workspaceFolders: string[]; problems: string[]; added: string[] };
  /** Opened for one toolchain or project (from a missing-command offer or the map). */
  focus?: { toolchain?: string; project?: string };
  run?: {
    steps: SetupRunStep[];
    extensions: Array<{ id: string; ok: boolean; error?: string }>;
    workspaceFolders: string[];
    problems: string[];
    declined?: boolean;
    finished: boolean;
    /** Projects needing attention before the run, for the before/after view. */
    attentionBefore: string[];
  };
}
