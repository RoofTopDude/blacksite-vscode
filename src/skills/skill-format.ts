// SKILL.md parsing, serialization, and authoring lint.
//
// A skill file is YAML frontmatter followed by a Markdown body. The frontmatter is
// deliberately parsed by a small hand-written reader rather than a YAML dependency:
// the accepted shape is a fixed, flat set of scalars and string lists, and a full YAML
// parser would accept far more than that (anchors, nested maps, type coercion) from a
// file that can arrive through a pull request. Anything outside the accepted shape is
// reported as a lint issue instead of being silently interpreted.
//
// The `description` is the only part of a skill that sits in context every turn, before
// the skill is ever loaded — it is the entire discovery surface. lintSkill() therefore
// spends most of its rules on that one field.

export type SkillMode = "plan" | "review" | "debug";

export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: number;
  /** Workspace globs or `area:<name>` hints that make this skill relevant. */
  scope?: string[];
  /** Capability tokens that must be present for the skill to be loadable — e.g.
   *  `mcp:linear`, `service:github`, `db`, `browser`. */
  requires?: string[];
  /** May only NARROW a delegated lane's tools. Never widens the catalog. */
  allowedTools?: string[];
  /** Request-mode affinity. A hint for the roster, never a mode switch. */
  mode?: SkillMode;
}

export type SkillIssueSeverity = "error" | "warning";

export interface SkillIssue {
  severity: SkillIssueSeverity;
  field: string;
  message: string;
}

export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter;
  body: string;
  issues: SkillIssue[];
}

/** Hard caps. `description` rides in every turn's context, so it is the tightest. */
export const MAX_DESCRIPTION_CHARS = 600;
export const MAX_NAME_CHARS = 64;
export const MAX_SKILL_BODY_CHARS = 60_000;
/** Progressive-disclosure guidance: past this, content belongs in `reference/`. */
export const RECOMMENDED_BODY_LINES = 500;

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCALAR_KEYS = new Set(["name", "description", "version", "mode"]);
const LIST_KEYS = new Set(["scope", "requires", "allowed-tools"]);
const KNOWN_KEYS = new Set([...SCALAR_KEYS, ...LIST_KEYS, "origin"]);
const MODES: readonly string[] = ["plan", "review", "debug"];

/**
 * Control characters other than tab/newline, stripped from every parsed field.
 *
 * Built through the RegExp constructor rather than a literal so this source file stays
 * free of the bytes it is matching. A skill description is rendered straight into the
 * prompt's roster, and an embedded escape or newline there is how a roster row could be
 * made to impersonate a different section of the context block.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g");

function sanitizeField(value: string): string {
  return value.replace(CONTROL_CHARS, "").trim();
}

/** Collapse a description to a single line — it is rendered as one roster row. */
function flattenDescription(value: string): string {
  return sanitizeField(value).replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ");
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseFlowList(value: string): string[] {
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((entry) => sanitizeField(stripQuotes(entry)))
    .filter(Boolean);
}

interface RawFrontmatter {
  values: Map<string, string | string[]>;
  issues: SkillIssue[];
}

/**
 * Read the fixed frontmatter shape: `key: scalar`, `key: [a, b]`, a `- item` block list,
 * and `>`/`|` block scalars. Indented continuation lines belong to the key above them;
 * anything else is reported rather than guessed at.
 */
function readFrontmatter(lines: string[]): RawFrontmatter {
  const values = new Map<string, string | string[]>();
  const issues: SkillIssue[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim() || line.trimStart().startsWith("#")) { index += 1; continue; }

    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      issues.push({ severity: "warning", field: "frontmatter", message: `Ignored unparseable line: ${line.trim().slice(0, 80)}` });
      index += 1;
      continue;
    }

    const key = match[1]!.toLowerCase();
    const rest = match[2]!.trim();
    index += 1;

    if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-") {
      const collected: string[] = [];
      while (index < lines.length && (!lines[index]!.trim() || /^\s+/.test(lines[index]!))) {
        collected.push(lines[index]!.trim());
        index += 1;
      }
      const joined = rest.startsWith(">") ? collected.join(" ") : collected.join("\n");
      values.set(key, joined.trim());
      continue;
    }

    if (rest.startsWith("[")) { values.set(key, parseFlowList(rest)); continue; }

    if (!rest) {
      const collected: string[] = [];
      while (index < lines.length && /^\s*-\s+/.test(lines[index]!)) {
        collected.push(sanitizeField(stripQuotes(lines[index]!.replace(/^\s*-\s+/, ""))));
        index += 1;
      }
      values.set(key, collected.filter(Boolean));
      continue;
    }

    values.set(key, stripQuotes(rest));
  }

  for (const key of values.keys()) {
    if (!KNOWN_KEYS.has(key)) {
      issues.push({ severity: "warning", field: key, message: `Unknown frontmatter key '${key}' — ignored.` });
    }
  }

  return { values, issues };
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  const single = sanitizeField(value);
  return single ? [single] : [];
}

/**
 * Split a SKILL.md into frontmatter and body. Never throws: a malformed file yields
 * issues plus whatever could be recovered, so the Skills panel can show the user a
 * broken skill and what is wrong with it rather than silently omitting it.
 */
export function parseSkillFile(raw: string, fallbackName = ""): ParsedSkillFile {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const issues: SkillIssue[] = [];

  const fenced = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!fenced) {
    return {
      frontmatter: { name: fallbackName, description: "" },
      body: text.trim(),
      issues: [{ severity: "error", field: "frontmatter", message: "Missing YAML frontmatter. A skill must start with a '---' block declaring name and description." }],
    };
  }

  const { values, issues: rawIssues } = readFrontmatter(fenced[1]!.split("\n"));
  issues.push(...rawIssues);

  const name = sanitizeField(String(values.get("name") ?? fallbackName)).toLowerCase();
  const description = flattenDescription(String(values.get("description") ?? ""));

  const frontmatter: SkillFrontmatter = { name, description };

  const versionRaw = values.get("version");
  if (versionRaw !== undefined && !Array.isArray(versionRaw)) {
    const parsed = Number(versionRaw);
    if (Number.isFinite(parsed) && parsed > 0) frontmatter.version = Math.floor(parsed);
    else issues.push({ severity: "warning", field: "version", message: "version must be a positive number — ignored." });
  }

  const modeRaw = values.get("mode");
  if (modeRaw !== undefined && !Array.isArray(modeRaw)) {
    const mode = sanitizeField(modeRaw).toLowerCase();
    if (mode && mode !== "auto") {
      if (MODES.includes(mode)) frontmatter.mode = mode as SkillMode;
      else issues.push({ severity: "warning", field: "mode", message: `mode must be one of ${MODES.join(", ")} — ignored.` });
    }
  }

  const scope = asList(values.get("scope"));
  if (scope.length) frontmatter.scope = scope;
  const requires = asList(values.get("requires"));
  if (requires.length) frontmatter.requires = requires;
  const allowedTools = asList(values.get("allowed-tools"));
  if (allowedTools.length) frontmatter.allowedTools = allowedTools;

  const body = text.slice(fenced[0].length).trim();
  return { frontmatter, body, issues };
}

/**
 * Authoring lint. Split from parsing because the panel runs it against a draft the user
 * is still typing, where an empty description is expected rather than a failure.
 *
 * The description rules are the point of this function. A skill whose description does
 * not say when to use it is never loaded, and that failure is invisible — the skill just
 * silently never fires — so it is worth warning about loudly at authoring time.
 */
export function lintSkill(frontmatter: SkillFrontmatter, body: string): SkillIssue[] {
  const issues: SkillIssue[] = [];

  if (!frontmatter.name) {
    issues.push({ severity: "error", field: "name", message: "name is required." });
  } else if (!NAME_PATTERN.test(frontmatter.name)) {
    issues.push({ severity: "error", field: "name", message: "name must be lowercase kebab-case (letters, digits, single hyphens)." });
  } else if (frontmatter.name.length > MAX_NAME_CHARS) {
    issues.push({ severity: "error", field: "name", message: `name must be ${MAX_NAME_CHARS} characters or fewer.` });
  }

  const description = frontmatter.description;
  if (!description) {
    issues.push({ severity: "error", field: "description", message: "description is required — it is the only part of the skill the agent sees before loading it, and the whole basis on which it decides to load." });
  } else {
    if (description.length > MAX_DESCRIPTION_CHARS) {
      issues.push({ severity: "error", field: "description", message: `description must be ${MAX_DESCRIPTION_CHARS} characters or fewer — it rides in every turn's context.` });
    }
    if (description.length < 40) {
      issues.push({ severity: "warning", field: "description", message: "description is very short. Say both what the skill does and the situations that should trigger it." });
    }
    if (!/\b(use|when|for|apply|triggers?|reach for)\b/i.test(description)) {
      issues.push({ severity: "warning", field: "description", message: "description does not name a trigger. Add a clause like \"Use when the user asks to …\" so the agent can tell whether it applies." });
    }
    if (/^\s*(?:I |You should |This skill (?:will|can) help you)\b/i.test(description)) {
      issues.push({ severity: "warning", field: "description", message: "Write the description in the third person, describing the skill rather than addressing the reader." });
    }
  }

  if (!body.trim()) {
    issues.push({ severity: "error", field: "body", message: "A skill needs a body: the procedure the agent should follow once it loads." });
  } else {
    if (body.length > MAX_SKILL_BODY_CHARS) {
      issues.push({ severity: "error", field: "body", message: `Body exceeds ${MAX_SKILL_BODY_CHARS} characters. Move detail into reference/ files the body points at.` });
    }
    const lineCount = body.split("\n").length;
    if (lineCount > RECOMMENDED_BODY_LINES) {
      issues.push({ severity: "warning", field: "body", message: `Body is ${lineCount} lines. Past roughly ${RECOMMENDED_BODY_LINES}, move detail into reference/ files so it loads only when needed.` });
    }
  }

  for (const token of frontmatter.requires ?? []) {
    if (!/^(mcp:[\w.-]+|service:[a-z]+|db|browser|lsp|data)$/i.test(token)) {
      issues.push({ severity: "warning", field: "requires", message: `Unrecognized requirement '${token}'. Expected mcp:<id>, service:<name>, db, browser, or lsp.` });
    }
  }

  return issues;
}

/** Render frontmatter + body back to a SKILL.md. Round-trips parseSkillFile. */
export function serializeSkillFile(frontmatter: SkillFrontmatter, body: string): string {
  const lines: string[] = ["---", `name: ${frontmatter.name}`];

  const description = flattenDescription(frontmatter.description);
  // Folded block scalar for anything that would wrap awkwardly on one line, so the file
  // stays readable in an editor while parsing back to the same single-line string.
  if (description.length > 88) {
    lines.push("description: >");
    for (const chunk of wrapText(description, 88)) lines.push(`  ${chunk}`);
  } else {
    lines.push(`description: ${description}`);
  }

  if (frontmatter.version !== undefined) lines.push(`version: ${frontmatter.version}`);
  if (frontmatter.mode) lines.push(`mode: ${frontmatter.mode}`);
  if (frontmatter.scope?.length) lines.push(`scope: [${frontmatter.scope.map((s) => JSON.stringify(s)).join(", ")}]`);
  if (frontmatter.requires?.length) lines.push(`requires: [${frontmatter.requires.map((s) => JSON.stringify(s)).join(", ")}]`);
  if (frontmatter.allowedTools?.length) lines.push(`allowed-tools: [${frontmatter.allowedTools.map((s) => JSON.stringify(s)).join(", ")}]`);

  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else { out.push(current); current = word; }
  }
  if (current) out.push(current);
  return out;
}

const REGEX_META = ".+^${}()|[]\\";

/**
 * Translate a glob to a regex source. Scans character by character rather than running a
 * chain of `.replace()` passes: the chained form needs placeholder sentinels to keep `**`
 * from being eaten by the `*` rule, and a sentinel that appears in a real path silently
 * corrupts the pattern.
 */
function globToRegExpSource(glob: string): string {
  let out = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") { out += "(?:.*/)?"; index += 2; }
        else { out += ".*"; index += 1; }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (REGEX_META.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Match a scope entry against a workspace-relative path. Supports `*`, `**`, and `?`.
 * `area:<name>` entries name a Codebase Map area rather than a path and never match here.
 */
export function scopeMatchesPath(scopeEntry: string, relativePath: string): boolean {
  const entry = scopeEntry.trim();
  if (!entry || entry.startsWith("area:")) return false;
  try {
    return new RegExp(`^${globToRegExpSource(entry)}$`, "i").test(relativePath);
  } catch {
    return false;
  }
}
