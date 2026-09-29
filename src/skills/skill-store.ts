// Discovery, precedence, and persistence for skills.
//
// Four origins, in precedence order when two skills share a name:
//
//   workspace  .blacksite/skills, then the cross-tool folders .agents/skills, .claude/skills and
//              .github/skills                                    committed, shared with the team
//   user       ~/.blacksite/skills, then ~/.agents/skills, ~/.claude/skills, ~/.copilot/skills
//                                                                private to this machine
//   plugin     <plugin>/skills of each enabled Agent Plugin (see src/plugins/)
//   bundled    <extension>/skills                                first-party harness fluency
//
// The cross-tool folders are the ones adopters of the Agent Skills standard share (Claude Code,
// Codex, Copilot and VS Code read the same set), so a skill written for any of them works here
// unchanged. Blacksite's own folder comes first within each origin, and it is the only one
// Blacksite writes to or deletes from: the others belong to other tools.
//
// Workspace wins because a repository's own procedure should beat a personal habit and a
// shipped default when working in that repository. The losing copies are not discarded —
// they are recorded on the winner as `shadows`, so the Skills panel can tell the user which
// copy is live rather than leaving them to wonder why an edit had no effect.
//
// The store owns files and enable/disable state only. It does not know what the session has
// loaded (that is AgentSession's) and it does not know which capabilities exist (the caller
// supplies those to buildSkillRoster), so it stays constructible and testable without vscode.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  lintSkill,
  parseSkillFile,
  scopeMatchesPath,
  serializeSkillFile,
  type SkillFrontmatter,
  type SkillIssue,
} from "./skill-format.js";

export type SkillOrigin = "workspace" | "user" | "plugin" | "bundled";

/** Skill folders within the workspace, in precedence order. The first is Blacksite's own. */
export const WORKSPACE_SKILL_FOLDERS: readonly string[] = [".blacksite/skills", ".agents/skills", ".claude/skills", ".github/skills"];
/** Skill folders under the home directory, in precedence order. The first is Blacksite's own. */
export const USER_SKILL_FOLDERS: readonly string[] = [".blacksite/skills", ".agents/skills", ".claude/skills", ".copilot/skills"];

/** One place skills are read from. */
interface SkillSource {
  origin: SkillOrigin;
  dir: string;
  /** Where it is, for people: ".claude/skills", "~/.agents/skills", "plugin: tidy-tools", "built-in". */
  location: string;
  /** Blacksite's own writable folder, the only one it writes to or deletes from. */
  managed: boolean;
}

/** An enabled Agent Plugin's skills folder (see src/plugins/plugin-registry.ts). */
export interface PluginSkillSource {
  plugin: string;
  dir: string;
}

export interface SkillRecord extends SkillFrontmatter {
  origin: SkillOrigin;
  /** Absolute path to the skill's directory. */
  dir: string;
  /** The folder it came from, for people (see SkillSource.location). */
  location: string;
  /** True only in Blacksite's own workspace folder, the one place it may delete or rewrite. */
  managed: boolean;
  /** Origins holding a same-named copy this one outranks. */
  shadows: SkillOrigin[];
  /** Folders holding a same-named copy this one outranks, including within its own origin. */
  shadowedLocations: string[];
  enabled: boolean;
  /** Parse + lint problems. A record with an `error` issue is listed but not loadable. */
  issues: SkillIssue[];
  /** Relative paths of bundled reference/asset files, for `skill_read({ file })`. */
  files: string[];
  bodyLines: number;
}

export interface SkillReadResult {
  record: SkillRecord;
  body: string;
}

const SKILL_FILE = "SKILL.md";
const STATE_FILE = ".blacksite/skills-state.json";
const WORKSPACE_SKILLS_DIR = WORKSPACE_SKILL_FOLDERS[0]!;
const USER_SKILLS_DIR = USER_SKILL_FOLDERS[0]!;
/** Subdirectories whose contents `skill_read({ file })` will serve. */
const ASSET_DIRS = ["reference", "assets", "scripts"] as const;
const MAX_ASSET_BYTES = 512 * 1024;
const MAX_FILES_LISTED = 60;

interface SkillsState { disabled: string[] }

function safeReadJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch { return fallback; }
}

function listAssetFiles(dir: string): string[] {
  const out: string[] = [];
  for (const sub of ASSET_DIRS) {
    const base = path.join(dir, sub);
    const walk = (current: string, prefix: string): void => {
      if (out.length >= MAX_FILES_LISTED) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        if (out.length >= MAX_FILES_LISTED) return;
        // A symlink inside a skill could point anywhere; it is never listed and
        // resolveAssetPath re-checks containment before reading regardless.
        if (entry.isSymbolicLink()) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
        else if (entry.isFile()) out.push(`${sub}/${rel}`);
      }
    };
    walk(base, "");
  }
  return out.sort();
}

export class SkillStore {
  private _cache: SkillRecord[] | null = null;

  constructor(
    private readonly _workspaceRoot: string,
    /** Absolute path to the extension's shipped `skills/` directory, when packaged. */
    private readonly _bundledDir?: string,
    /** Overridable for tests; defaults to the real home directory. */
    private readonly _homeDir: string = os.homedir(),
    /** Skills folders of enabled Agent Plugins, read on every listing so enabling one applies. */
    private readonly _pluginSources: () => readonly PluginSkillSource[] = () => [],
  ) {}

  /** Drop the parse cache. Called by the file watcher and after every write. */
  invalidate(): void { this._cache = null; }

  workspaceSkillsDir(): string { return path.join(this._workspaceRoot, WORKSPACE_SKILLS_DIR); }
  userSkillsDir(): string { return path.join(this._homeDir, USER_SKILLS_DIR); }

  /** Every folder skills are read from, highest precedence first. */
  private _sources(): SkillSource[] {
    const sources: SkillSource[] = [
      ...WORKSPACE_SKILL_FOLDERS.map((folder, index) => ({
        origin: "workspace" as const,
        dir: path.join(this._workspaceRoot, folder),
        location: folder,
        managed: index === 0,
      })),
      ...USER_SKILL_FOLDERS.map((folder) => ({
        origin: "user" as const,
        dir: path.join(this._homeDir, folder),
        location: `~/${folder}`,
        managed: false,
      })),
    ];
    for (const plugin of this._pluginSources()) {
      sources.push({ origin: "plugin", dir: plugin.dir, location: `plugin: ${plugin.plugin}`, managed: false });
    }
    if (this._bundledDir) sources.push({ origin: "bundled", dir: this._bundledDir, location: "built-in", managed: false });
    return sources;
  }

  private _stateFile(): string { return path.join(this._workspaceRoot, STATE_FILE); }

  private _readState(): SkillsState {
    const state = safeReadJson<SkillsState>(this._stateFile(), { disabled: [] });
    return { disabled: Array.isArray(state.disabled) ? state.disabled.map(String) : [] };
  }

  private _writeState(state: SkillsState): void {
    const file = this._stateFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    } catch { /* enable/disable is a preference; failing to persist must not throw */ }
  }

  /**
   * Every skill across all three origins, shadowed duplicates already resolved.
   * Sorted by name so the roster is byte-identical between turns unless a skill
   * actually changed — the same stability the project-shape block aims for.
   */
  list(): SkillRecord[] {
    if (this._cache) return this._cache.map((record) => ({ ...record }));

    const disabled = new Set(this._readState().disabled);
    const byName = new Map<string, SkillRecord>();

    for (const { origin, dir, location, managed } of this._sources()) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { continue; }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = path.join(dir, entry.name);
        const file = path.join(skillDir, SKILL_FILE);
        let raw: string;
        try { raw = fs.readFileSync(file, "utf8"); }
        catch { continue; }

        const { frontmatter, body, issues } = parseSkillFile(raw, entry.name.toLowerCase());
        const name = frontmatter.name || entry.name.toLowerCase();
        const allIssues = [...issues, ...lintSkill({ ...frontmatter, name }, body)];

        const existing = byName.get(name);
        if (existing) {
          // A higher-precedence source was seen first; record this one as shadowed.
          if (origin !== existing.origin && !existing.shadows.includes(origin)) existing.shadows.push(origin);
          if (!existing.shadowedLocations.includes(location)) existing.shadowedLocations.push(location);
          continue;
        }

        byName.set(name, {
          ...frontmatter,
          name,
          origin,
          dir: skillDir,
          location,
          managed,
          shadows: [],
          shadowedLocations: [],
          enabled: !disabled.has(name),
          issues: allIssues,
          files: listAssetFiles(skillDir),
          bodyLines: body ? body.split("\n").length : 0,
        });
      }
    }

    this._cache = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    return this._cache.map((record) => ({ ...record }));
  }

  find(name: string): SkillRecord | null {
    const target = name.trim().toLowerCase();
    return this.list().find((record) => record.name === target) ?? null;
  }

  /** The winning copy's frontmatter plus body, or null when the name is unknown. */
  read(name: string): SkillReadResult | null {
    const record = this.find(name);
    if (!record) return null;
    try {
      const raw = fs.readFileSync(path.join(record.dir, SKILL_FILE), "utf8");
      return { record, body: parseSkillFile(raw, record.name).body };
    } catch {
      return null;
    }
  }

  /**
   * Resolve a bundled reference/asset path, refusing anything that escapes the skill
   * directory. Both the requested path and its realpath are checked: the first stops
   * `../` traversal, the second stops a symlink planted inside the skill from serving
   * a file elsewhere on the machine.
   */
  resolveAssetPath(record: SkillRecord, requested: string): string | null {
    const cleaned = requested.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (!cleaned || path.isAbsolute(cleaned)) return null;
    if (!ASSET_DIRS.some((dir) => cleaned === dir || cleaned.startsWith(`${dir}/`))) return null;

    const skillDir = path.resolve(record.dir);
    const target = path.resolve(skillDir, cleaned);
    const contains = (root: string, candidate: string): boolean =>
      candidate === root || candidate.startsWith(root + path.sep);
    if (!contains(skillDir, target)) return null;

    try {
      const realRoot = fs.realpathSync(skillDir);
      const realTarget = fs.realpathSync(target);
      if (!contains(realRoot, realTarget)) return null;
      if (!fs.statSync(realTarget).isFile()) return null;
      return realTarget;
    } catch {
      return null;
    }
  }

  readAsset(name: string, file: string): { path: string; content: string; truncated: boolean } | null {
    const record = this.find(name);
    if (!record) return null;
    const resolved = this.resolveAssetPath(record, file);
    if (!resolved) return null;
    try {
      const stat = fs.statSync(resolved);
      const handle = fs.readFileSync(resolved);
      const truncated = stat.size > MAX_ASSET_BYTES;
      return {
        path: file.replace(/\\/g, "/"),
        content: handle.subarray(0, MAX_ASSET_BYTES).toString("utf8"),
        truncated,
      };
    } catch {
      return null;
    }
  }

  /**
   * Create or update a workspace skill. Deliberately the only writable origin:
   * `~/.blacksite/skills` is the user's private space and bundled skills ship read-only.
   * Writing a name that a bundled skill already uses produces a workspace copy that
   * shadows it — reported back so the caller can say so rather than implying an in-place edit.
   */
  write(name: string, markdown: string): { path: string; shadowsBundled: boolean; issues: SkillIssue[] } {
    const parsed = parseSkillFile(markdown, name);
    const frontmatter: SkillFrontmatter = { ...parsed.frontmatter, name: name.trim().toLowerCase() };
    const issues = [...parsed.issues, ...lintSkill(frontmatter, parsed.body)];
    const blocking = issues.filter((issue) => issue.severity === "error");
    if (blocking.length) {
      throw new Error(`Skill '${name}' is not valid: ${blocking.map((issue) => `${issue.field}: ${issue.message}`).join(" ")}`);
    }

    const existing = this.find(frontmatter.name);
    const shadowsBundled = !!existing && !existing.managed;

    const dir = path.join(this.workspaceSkillsDir(), frontmatter.name);
    const file = path.join(dir, SKILL_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, serializeSkillFile(frontmatter, parsed.body), "utf8");
    this.invalidate();

    return { path: path.relative(this._workspaceRoot, file).replace(/\\/g, "/"), shadowsBundled, issues };
  }

  setEnabled(name: string, enabled: boolean): void {
    const target = name.trim().toLowerCase();
    const state = this._readState();
    const disabled = new Set(state.disabled);
    if (enabled) disabled.delete(target);
    else disabled.add(target);
    this._writeState({ disabled: [...disabled].sort() });
    this.invalidate();
  }

  /** Delete a skill in Blacksite's own workspace folder. Skills anywhere else (personal, plugin,
   *  built-in, or another tool's folder such as .claude/skills) are never removed here. */
  remove(name: string): boolean {
    const record = this.find(name);
    if (!record || !record.managed) return false;
    try {
      fs.rmSync(record.dir, { recursive: true, force: true });
      this.invalidate();
      return true;
    } catch {
      return false;
    }
  }
}

// ── Roster rendering ──────────────────────────────────────────────────────────

export interface SkillRosterOptions {
  /** Capability tokens this session actually has: `db`, `browser`, `lsp`, `mcp:<id>`, `service:<name>`. */
  capabilities: ReadonlySet<string>;
  /** Skill names already loaded into the session's working context. */
  loaded: readonly string[];
  /** Workspace-relative paths of the open/active files, for scope hints. */
  focusFiles: readonly string[];
}

export interface SkillAvailability {
  record: SkillRecord;
  available: boolean;
  /** Why the skill cannot be loaded, when `available` is false. */
  reason?: string;
  scopeMatch?: string;
}

/**
 * Decide, per skill, whether this session could load it and whether the open files
 * suggest it. Kept separate from the rendering below so the Skills panel can show the
 * same availability the agent sees without parsing prose.
 */
export function resolveSkillAvailability(
  records: readonly SkillRecord[],
  options: SkillRosterOptions,
): SkillAvailability[] {
  return records.map((record) => {
    const blocking = record.issues.filter((issue) => issue.severity === "error");
    if (blocking.length) {
      return { record, available: false, reason: `invalid: ${blocking[0]!.field}` };
    }
    if (!record.enabled) return { record, available: false, reason: "disabled" };

    const missing = (record.requires ?? []).filter((token) => !options.capabilities.has(token.toLowerCase()));
    if (missing.length) {
      return { record, available: false, reason: `requires ${missing.join(", ")} — not available this session` };
    }

    const scopeMatch = (record.scope ?? [])
      .flatMap((entry) => options.focusFiles.filter((file) => scopeMatchesPath(entry, file)))
      .at(0);

    return { record, available: true, ...(scopeMatch ? { scopeMatch } : {}) };
  });
}

/**
 * The "Skills available" section of the live workspace block.
 *
 * One line per skill: the description is the agent's entire basis for deciding to load,
 * so it is reproduced whole rather than truncated. Unavailable skills are still listed,
 * with their reason — the same posture as an unconfigured integration, and for the same
 * reason: an agent that cannot see why a capability is missing will keep reaching for it.
 */
export function buildSkillRoster(
  records: readonly SkillRecord[],
  options: SkillRosterOptions,
): string {
  const resolved = resolveSkillAvailability(records, options);
  if (!resolved.length) return "";

  const loaded = new Set(options.loaded.map((name) => name.toLowerCase()));
  const lines: string[] = [];

  for (const entry of resolved) {
    if (!entry.available && entry.reason === "disabled") continue;
    const notes: string[] = [];
    if (loaded.has(entry.record.name)) notes.push("already loaded");
    if (entry.scopeMatch) notes.push(`scope match: ${entry.scopeMatch}`);
    if (entry.record.mode) notes.push(`suits ${entry.record.mode} work`);
    if (!entry.available && entry.reason) notes.push(`UNAVAILABLE — ${entry.reason}`);
    const suffix = notes.length ? ` [${notes.join("; ")}]` : "";
    lines.push(`  ${entry.record.name} — ${entry.record.description}${suffix}`);
  }

  if (!lines.length) return "";

  const header = "Skills available (procedures you can load on demand; call skill_read with the name before doing work one covers):";
  const loadedLine = options.loaded.length
    ? `\nLoaded into your working context this session: ${[...options.loaded].sort().join(", ")}`
    : "";
  return `${header}\n${lines.join("\n")}${loadedLine}`;
}
