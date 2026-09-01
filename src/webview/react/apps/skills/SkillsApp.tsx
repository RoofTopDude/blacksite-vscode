import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BookOpen, FileText, Plus, Sparkles, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PanelHeader } from "@/components/PanelHeader";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { post, onMessage } from "@/lib/bridge";

type Origin = "workspace" | "user" | "bundled";
type Severity = "error" | "warning";

interface Issue { severity: Severity; field: string; message: string }

interface Skill {
  name: string;
  description: string;
  origin: Origin;
  enabled: boolean;
  available: boolean;
  unavailableReason?: string;
  mode?: string;
  scope: string[];
  requires: string[];
  files: string[];
  shadows: Origin[];
  bodyLines: number;
  issues: Issue[];
}

interface Draft {
  name: string;
  description: string;
  body: string;
  scope: string;
  requires: string;
  mode: string;
}

const EMPTY_DRAFT: Draft = { name: "", description: "", body: "", scope: "", requires: "", mode: "" };

const ORIGIN_LABEL: Record<Origin, string> = {
  workspace: "workspace",
  user: "personal",
  bundled: "built-in",
};

/** The origin badge doubles as the answer to "why can't I delete this one". */
const ORIGIN_HINT: Record<Origin, string> = {
  workspace: "Committed in .blacksite/skills — shared with everyone on this repository.",
  user: "Private to you, in ~/.blacksite/skills.",
  bundled: "Ships with Blacksite. Copy it to the workspace to make a version this repo owns.",
};

function splitList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function SkillsApp() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [workspaceDir, setWorkspaceDir] = useState(".blacksite/skills");
  const [descriptionMax, setDescriptionMax] = useState(600);
  const [recommendedBodyLines, setRecommendedBodyLines] = useState(500);

  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [shadowWarning, setShadowWarning] = useState<string | undefined>();
  const [agentPrompt, setAgentPrompt] = useState("");
  const lintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const off = onMessage((msg) => {
      if (msg.type === "skills_state") {
        setSkills(Array.isArray(msg.skills) ? msg.skills : []);
        if (typeof msg.workspaceDir === "string") setWorkspaceDir(msg.workspaceDir);
        if (typeof msg.descriptionMax === "number") setDescriptionMax(msg.descriptionMax);
        if (typeof msg.recommendedBodyLines === "number") setRecommendedBodyLines(msg.recommendedBodyLines);
      } else if (msg.type === "skill_lint") {
        setIssues(Array.isArray(msg.issues) ? msg.issues : []);
        setShadowWarning(typeof msg.shadowWarning === "string" ? msg.shadowWarning : undefined);
      } else if (msg.type === "skill_saved") {
        setComposing(false);
        setDraft(EMPTY_DRAFT);
        setIssues([]);
      } else if (msg.type === "skill_scaffold") {
        setComposing(true);
        setDraft({ ...EMPTY_DRAFT, body: typeof msg.body === "string" && msg.body ? msg.body : String(msg.starter ?? "") });
      }
    });
    post({ type: "ready" });
    return () => {
      off();
      if (lintTimer.current) clearTimeout(lintTimer.current);
    };
  }, []);

  /* Lint is debounced and host-side so the panel and the store can never disagree about
     what is valid — the alternative is a second copy of the rules drifting in the webview. */
  function updateDraft(patch: Partial<Draft>): void {
    setDraft((current) => {
      const next = { ...current, ...patch };
      if (lintTimer.current) clearTimeout(lintTimer.current);
      lintTimer.current = setTimeout(() => {
        post({
          type: "lint_draft",
          name: next.name,
          description: next.description,
          body: next.body,
          scope: splitList(next.scope),
          requires: splitList(next.requires),
          mode: next.mode,
        });
      }, 250);
      return next;
    });
  }

  function saveDraft(): void {
    post({
      type: "save_draft",
      name: draft.name,
      description: draft.description,
      body: draft.body,
      scope: splitList(draft.scope),
      requires: splitList(draft.requires),
      mode: draft.mode,
    });
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const canSave = draft.name.trim() !== "" && draft.description.trim() !== "" && errors.length === 0;

  const grouped = useMemo(() => {
    const order: Origin[] = ["workspace", "user", "bundled"];
    return order
      .map((origin) => ({ origin, items: skills.filter((skill) => skill.origin === origin) }))
      .filter((group) => group.items.length > 0);
  }, [skills]);

  const activeCount = skills.filter((skill) => skill.enabled && skill.available).length;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-border px-3 py-2.5">
        <PanelHeader
          title="Skills"
          eyebrow="Procedures the agent loads on demand"
          sub={
            skills.length === 0
              ? "No skills installed yet."
              : `${activeCount} of ${skills.length} available to the agent · authored in ${workspaceDir}`
          }
          actions={
            <Button size="sm" variant={composing ? "ghost" : "default"} onClick={() => setComposing((open) => !open)}>
              {composing ? <X className="size-3.5" /> : <Plus className="size-3.5" />}
              {composing ? "Close" : "New skill"}
            </Button>
          }
        />
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {composing && (
          <div className="mb-4 rounded-md border border-border bg-surface p-3">
            <div className="mb-3 rounded border border-border/70 bg-background/40 p-2.5">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
                <Sparkles className="size-3.5" /> Describe it and let the agent draft it
              </div>
              <Textarea
                rows={2}
                value={agentPrompt}
                placeholder="e.g. How we cut a release here: version bump, changelog entry in the house voice, package the vsix, verify it…"
                onChange={(event) => setAgentPrompt(event.target.value)}
              />
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">
                  Composes the request in chat. You send it, and review the draft before it saves.
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!agentPrompt.trim()}
                  onClick={() => { post({ type: "draft_with_agent", prompt: agentPrompt }); setAgentPrompt(""); }}
                >
                  Draft in chat
                </Button>
              </div>
            </div>

            <div className="grid gap-2.5">
              <div>
                <Label htmlFor="skill-name">Name</Label>
                <Input
                  id="skill-name"
                  value={draft.name}
                  placeholder="release-cut"
                  onChange={(event) => updateDraft({ name: event.target.value.toLowerCase() })}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">Lowercase kebab-case. Also the folder name.</p>
              </div>

              <div>
                <Label htmlFor="skill-description">Description</Label>
                <Textarea
                  id="skill-description"
                  rows={3}
                  value={draft.description}
                  placeholder="Cut a release: version bump, changelog section, package and verify the vsix. Use when the user asks to release, cut a version, or publish a build."
                  onChange={(event) => updateDraft({ description: event.target.value })}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {draft.description.length}/{descriptionMax} · This is the only part the agent sees before loading —
                  it decides whether the skill is ever used. Say what it does <em>and</em> what should trigger it.
                </p>
              </div>

              <div>
                <Label htmlFor="skill-body">Procedure</Label>
                <Textarea
                  id="skill-body"
                  rows={10}
                  className="font-mono text-[11px]"
                  value={draft.body}
                  placeholder={"# What this covers\n\nWhen this applies, and when it does not.\n\n## Steps\n\n1. …"}
                  onChange={(event) => updateDraft({ body: event.target.value })}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Markdown. Keep it under ~{recommendedBodyLines} lines; move deep detail into reference/ files.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <Label htmlFor="skill-scope">Scope globs</Label>
                  <Input
                    id="skill-scope"
                    value={draft.scope}
                    placeholder="package.json, CHANGELOG.md"
                    onChange={(event) => updateDraft({ scope: event.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="skill-requires">Requires</Label>
                  <Input
                    id="skill-requires"
                    value={draft.requires}
                    placeholder="service:github, db"
                    onChange={(event) => updateDraft({ requires: event.target.value })}
                  />
                </div>
              </div>
            </div>

            {shadowWarning && (
              <p className="mt-2.5 flex items-start gap-1.5 text-[11px] text-warning">
                <AlertTriangle className="mt-px size-3 shrink-0" />{shadowWarning}
              </p>
            )}
            {(errors.length > 0 || warnings.length > 0) && (
              <ul className="mt-2.5 space-y-1">
                {[...errors, ...warnings].map((issue, index) => (
                  <li
                    key={`${issue.field}-${index}`}
                    className={`text-[11px] ${issue.severity === "error" ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    <span className="font-medium">{issue.field}</span> — {issue.message}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => { setComposing(false); setDraft(EMPTY_DRAFT); setIssues([]); }}>
                Cancel
              </Button>
              <Button size="sm" disabled={!canSave} onClick={saveDraft}>Save skill</Button>
            </div>
          </div>
        )}

        {skills.length === 0 && !composing && (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center">
            <BookOpen className="mx-auto mb-2 size-5 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              Skills are procedures the agent loads when a task matches them. Create one for work that recurs.
            </p>
          </div>
        )}

        {grouped.map((group) => (
          <section key={group.origin} className="mb-4">
            <h2 className="eyebrow mb-1.5" title={ORIGIN_HINT[group.origin]}>
              {ORIGIN_LABEL[group.origin]} · {group.items.length}
            </h2>
            <div className="space-y-1.5">
              {group.items.map((skill) => (
                <SkillRow key={skill.name} skill={skill} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function SkillRow({ skill }: { skill: Skill }) {
  const [expanded, setExpanded] = useState(false);
  const blocking = skill.issues.filter((issue) => issue.severity === "error");

  return (
    <div className="rounded-md border border-border bg-surface px-2.5 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 text-left"
            onClick={() => setExpanded((open) => !open)}
          >
            <span className="truncate text-xs font-medium text-foreground">{skill.name}</span>
            {skill.mode && <span className="shrink-0 text-[10px] text-muted-foreground">{skill.mode}</span>}
            {skill.shadows.length > 0 && (
              <span className="shrink-0 text-[10px] text-muted-foreground" title={`Overrides the ${skill.shadows.join(" and ")} copy.`}>
                overrides {skill.shadows.join(", ")}
              </span>
            )}
          </button>
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{skill.description}</p>
        </div>
        <Switch
          checked={skill.enabled}
          aria-label={`Enable ${skill.name}`}
          onCheckedChange={(enabled: boolean) => post({ type: "set_enabled", name: skill.name, enabled })}
        />
      </div>

      {!skill.available && skill.unavailableReason !== "disabled" && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-warning">
          <AlertTriangle className="mt-px size-3 shrink-0" />{skill.unavailableReason}
        </p>
      )}
      {blocking.map((issue, index) => (
        <p key={index} className="mt-1.5 text-[11px] text-destructive">
          <span className="font-medium">{issue.field}</span> — {issue.message}
        </p>
      ))}

      {expanded && (
        <div className="mt-2 space-y-1.5 border-t border-border/60 pt-2">
          {skill.scope.length > 0 && <Detail label="Scope" value={skill.scope.join(", ")} />}
          {skill.requires.length > 0 && <Detail label="Requires" value={skill.requires.join(", ")} />}
          {skill.files.length > 0 && <Detail label="Bundled files" value={skill.files.join(", ")} />}
          <Detail label="Body" value={`${skill.bodyLines} lines`} />
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <Button size="sm" variant="ghost" onClick={() => post({ type: "open_skill", name: skill.name })}>
              <FileText className="size-3.5" />Open SKILL.md
            </Button>
            {skill.origin === "workspace" && (
              <Button size="sm" variant="ghost" onClick={() => post({ type: "delete_skill", name: skill.name })}>
                <Trash2 className="size-3.5" />Delete
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5 text-[11px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground/80">{value}</span>
    </div>
  );
}
