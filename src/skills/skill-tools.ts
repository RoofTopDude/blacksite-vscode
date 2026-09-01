// Implements the skill_* tools over SkillStore, mirroring how reference-tools.ts backs the
// reference_* family: the store owns files, this owns the agent-facing contract.
//
// The one subtlety worth stating plainly is what skill_read returns. It does NOT return the
// skill body as the tool result. The body is handed back to AgentSession through
// `loadedBody`, which injects it at the message tail from the next turn onward (see
// AgentSession._dynamicContext). Returning it as a tool result *as well* would put two full
// copies in context, and the tool-result copy is the one that disappears at compaction —
// exactly when a long run most needs the procedure it is following. One copy, in the durable
// place, is the whole point.

import type { SkillRecord, SkillStore } from "./skill-store.js";
import { resolveSkillAvailability } from "./skill-store.js";
import { lintSkill, parseSkillFile } from "./skill-format.js";

export interface SkillToolContext {
  sessionId: string;
  /** Names already loaded in the calling session. */
  loaded: readonly string[];
}

export interface SkillDispatchResult extends Record<string, unknown> {
  /** Set on a successful `read` with no `file`: the body for AgentSession to inject. */
  loadedBody?: { name: string; markdown: string };
}

/** Capability tokens the session can satisfy, resolved by the host at dispatch time. */
export type SkillCapabilityProvider = () => ReadonlySet<string>;

function summarize(record: SkillRecord): Record<string, unknown> {
  return {
    name: record.name,
    description: record.description,
    origin: record.origin,
    ...(record.mode ? { mode: record.mode } : {}),
    ...(record.scope?.length ? { scope: record.scope } : {}),
    ...(record.requires?.length ? { requires: record.requires } : {}),
    ...(record.files.length ? { files: record.files } : {}),
    ...(record.shadows.length ? { shadows: record.shadows } : {}),
  };
}

export class SkillToolProvider {
  constructor(
    private readonly _store: SkillStore,
    private readonly _capabilities: SkillCapabilityProvider,
    /** Notifies the host (Skills panel) that a write changed the catalog. */
    private readonly _onChanged?: () => void,
  ) {}

  async dispatch(
    op: string,
    payload: Record<string, unknown>,
    ctx: SkillToolContext,
  ): Promise<SkillDispatchResult> {
    switch (op) {
      case "list":  return this._list(ctx);
      case "read":  return this._read(payload, ctx);
      case "write": return this._write(payload);
      default:      return { ok: false, error: `Unknown skill operation '${op}'.` };
    }
  }

  private _list(ctx: SkillToolContext): SkillDispatchResult {
    const records = this._store.list();
    const resolved = resolveSkillAvailability(records, {
      capabilities: this._capabilities(),
      loaded: ctx.loaded,
      focusFiles: [],
    });
    const loaded = new Set(ctx.loaded.map((name) => name.toLowerCase()));

    return {
      ok: true,
      total: resolved.length,
      loaded: [...loaded].sort(),
      skills: resolved.map((entry) => ({
        ...summarize(entry.record),
        available: entry.available,
        ...(entry.reason ? { unavailableReason: entry.reason } : {}),
        loaded: loaded.has(entry.record.name),
      })),
    };
  }

  private _read(payload: Record<string, unknown>, ctx: SkillToolContext): SkillDispatchResult {
    const name = String(payload["name"] ?? "").trim().toLowerCase();
    if (!name) return { ok: false, error: "skill_read requires a 'name'." };

    const record = this._store.find(name);
    if (!record) {
      const available = this._store.list().map((entry) => entry.name);
      return {
        ok: false,
        error: available.length
          ? `No skill named '${name}'. Available: ${available.join(", ")}`
          : `No skill named '${name}'. No skills are installed in this workspace.`,
      };
    }

    const file = payload["file"] ? String(payload["file"]).trim() : "";
    if (file) {
      const asset = this._store.readAsset(name, file);
      if (!asset) {
        return {
          ok: false,
          error: `'${file}' is not a readable file bundled with skill '${name}'.`
            + (record.files.length ? ` Available: ${record.files.join(", ")}` : " This skill bundles no reference files."),
        };
      }
      return {
        ok: true, name, file: asset.path, content: asset.content,
        ...(asset.truncated ? { truncated: true, note: "File exceeded the read cap and was cut short." } : {}),
      };
    }

    // Availability is enforced here, not just advertised in the roster: the roster is a
    // hint the model may act on a turn late, and a disabled skill must not load anyway.
    const [availability] = resolveSkillAvailability([record], {
      capabilities: this._capabilities(),
      loaded: ctx.loaded,
      focusFiles: [],
    });
    if (availability && !availability.available) {
      return { ok: false, error: `Skill '${name}' cannot be loaded: ${availability.reason}.` };
    }

    const result = this._store.read(name);
    if (!result?.body) return { ok: false, error: `Skill '${name}' has no readable body.` };

    if (ctx.loaded.some((entry) => entry.toLowerCase() === name)) {
      return {
        ok: true, name, alreadyLoaded: true,
        note: `Skill '${name}' is already in your working context — its procedure is in the context block at the end of this conversation. Do not re-read it.`,
      };
    }

    return {
      ok: true,
      name,
      loaded: true,
      origin: record.origin,
      ...(record.files.length ? { bundledFiles: record.files } : {}),
      note: `Skill '${name}' is now part of your working context and stays there for the rest of this session — you will find its procedure under "Active skills" in the context block at the end of this conversation, refreshed every turn. Follow it for work it covers.`
        + (record.files.length ? ` Read its bundled files with skill_read({ name: "${name}", file: "…" }) when the procedure points you at one.` : ""),
      loadedBody: { name, markdown: result.body },
    };
  }

  private _write(payload: Record<string, unknown>): SkillDispatchResult {
    const name = String(payload["name"] ?? "").trim().toLowerCase();
    const markdown = String(payload["markdown"] ?? "");
    if (!name) return { ok: false, error: "skill_write requires a 'name'." };
    if (!markdown.trim()) return { ok: false, error: "skill_write requires the full SKILL.md content in 'markdown'." };

    const existing = this._store.find(name);
    if (existing?.origin === "user") {
      return {
        ok: false,
        error: `'${name}' is one of the user's personal skills (~/.blacksite/skills). Those are theirs to edit — pick a different name, or ask them to change it.`,
      };
    }

    // Lint before touching disk so a rejected skill leaves no half-written directory,
    // and so the model gets the specific field back rather than a generic failure.
    const parsed = parseSkillFile(markdown, name);
    const issues = [...parsed.issues, ...lintSkill({ ...parsed.frontmatter, name }, parsed.body)];
    const errors = issues.filter((issue) => issue.severity === "error");
    if (errors.length) {
      return {
        ok: false,
        error: `Skill '${name}' was rejected: ${errors.map((issue) => `${issue.field} — ${issue.message}`).join(" ")}`,
        issues: errors,
      };
    }

    try {
      const written = this._store.write(name, markdown);
      this._onChanged?.();
      const warnings = issues.filter((issue) => issue.severity === "warning");
      return {
        ok: true,
        name,
        path: written.path,
        origin: "workspace",
        ...(written.shadowsBundled
          ? { note: `A ${existing?.origin} skill named '${name}' already existed. This workspace copy shadows it rather than editing it in place; the original is unchanged.` }
          : {}),
        ...(warnings.length ? { warnings } : {}),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
