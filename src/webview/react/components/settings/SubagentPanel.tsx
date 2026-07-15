import { useEffect, useState } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight, ChevronsUpDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import type { ProviderName, SubagentProfile } from "@/lib/protocol";
import { Field, Note, Row, Section, Segmented } from "./common";
import { PROVIDER_TABS } from "./helpers";
import { ModelPickerList } from "./ModelPickerList";

// ── Builtin profiles (mirrored from builtin-subagent-profiles.ts) ─────────────

const BUILTIN_PROFILES: SubagentProfile[] = [
  {
    id: "frontend_ui",
    name: "Frontend UI",
    description: "UI-facing implementation and browser-surface verification.",
    systemPromptAddition:
      "Focus on browser-facing behavior, UI state wiring, styling integrity, and user-visible regressions. Prefer concise observations tied to concrete surfaces and verification steps.",
    builtin: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  },
  {
    id: "backend_api",
    name: "Backend API",
    description: "Server, runtime, schema, and integration work.",
    systemPromptAddition:
      "Focus on backend behavior, contracts, process execution, local services, and failure handling. Prefer concrete command paths, data flow checks, and minimal verification sets.",
    builtin: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  },
  {
    id: "qa_regression",
    name: "QA Regression",
    description: "Targeted verification and failure reproduction.",
    systemPromptAddition:
      "Focus on reproducing defects, selecting the smallest credible regression coverage, and surfacing behavior deltas with exact evidence.",
    builtin: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  },
  {
    id: "repo_ops",
    name: "Repo Ops",
    description: "Git, local tooling, and operator-focused repo workflows.",
    systemPromptAddition:
      "Focus on repository operations, local command execution, workspace state, and safe confirmation handling for network or destructive actions.",
    builtin: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function nanoid(): string {
  return `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Profile card ───────────────────────────────────────────────────────────────

interface ProfileCardProps {
  profile: SubagentProfile;
  onDelete?: () => void;
  onEdit?: (profile: SubagentProfile) => void;
}

function ProfileCard({ profile, onDelete, onEdit }: ProfileCardProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={cn("rounded-md border border-border bg-white/[0.02]", expanded && "border-primary/30")}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
      >
        {expanded
          ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[11.5px] font-medium text-foreground">{profile.name}</span>
            {profile.builtin && (
              <span className="rounded bg-primary/15 px-1 py-px text-[8.5px] font-semibold uppercase tracking-wide text-primary">
                builtin
              </span>
            )}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">{profile.description}</div>
        </div>
        {!profile.builtin && onDelete && (
          <button
            type="button"
            title="Delete profile"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="chat-interactive ml-1 shrink-0 rounded p-0.5 text-muted-foreground hover:text-[color:var(--s-err)]"
          >
            <Trash2 className="size-3" />
          </button>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border px-2 pb-2 pt-1.5">
          {profile.systemPromptAddition && (
            <div className="mb-1.5 rounded bg-white/[0.03] px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
              {profile.systemPromptAddition}
            </div>
          )}
          {!profile.builtin && onEdit && (
            <Button size="xs" variant="outline" onClick={() => onEdit(profile)}>Edit</Button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Profile editor ─────────────────────────────────────────────────────────────

interface ProfileEditorProps {
  initial?: Partial<SubagentProfile>;
  onSave: (profile: SubagentProfile) => void;
  onCancel: () => void;
}

function ProfileEditor({ initial, onSave, onCancel }: ProfileEditorProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [promptAddition, setPromptAddition] = useState(initial?.systemPromptAddition ?? "");
  const valid = name.trim().length > 0;

  const handleSave = () => {
    if (!valid) return;
    const now = new Date().toISOString();
    onSave({
      id: initial?.id ?? nanoid(),
      name: name.trim(),
      description: description.trim(),
      systemPromptAddition: promptAddition.trim() || undefined,
      builtin: false,
      createdAt: initial?.createdAt ?? now,
      updatedAt: now,
    });
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 p-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-primary">
        {initial?.id ? "Edit Profile" : "New Profile"}
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-muted-foreground">Name</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Security Auditor" className="h-7 text-[11px]" autoFocus />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-muted-foreground">Description</label>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short description of this profile's focus" className="h-7 text-[11px]" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-[10px] text-muted-foreground">System Prompt Addition</label>
        <textarea
          value={promptAddition}
          onChange={(e) => setPromptAddition(e.target.value)}
          placeholder="Extra instructions appended to the subagent's system prompt when this profile is active…"
          rows={4}
          className="w-full resize-none rounded-md border border-border bg-white/[0.03] px-2 py-1.5 text-[11px] leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
      </div>
      <div className="flex gap-1.5">
        <Button size="xs" onClick={handleSave} disabled={!valid}>Save</Button>
        <Button size="xs" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// ── Inline model picker (subagent) ─────────────────────────────────────────────

interface SubagentModelPickerProps {
  provider: ProviderName;
  selectedModel: string;
  onSelect: (model: string | undefined) => void;
}

function SubagentModelPicker({ provider, selectedModel, onSelect }: SubagentModelPickerProps) {
  const store = useStore();
  const [open, setOpen] = useState(false);

  const models = store.providerModels[provider] ?? [];
  const loading = store.providerModelsLoading[provider] ?? false;
  const keySet = !!store.keyStatus[provider];

  // Refresh on every open so the catalog is never stale — TTL-guarded in the store,
  // and the cached list stays rendered while the refresh runs.
  useEffect(() => {
    if (open && keySet) actions.refreshModels(provider);
  }, [open, provider, keySet]);

  const selectedName = models.find((m) => m.id === selectedModel)?.name ?? selectedModel;

  return (
    <div className="flex flex-col gap-1.5">
      {/* Current selection + toggle */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex flex-1 items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors",
            selectedModel
              ? "border-primary/40 bg-primary/5 text-foreground"
              : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground",
          )}
        >
          <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {selectedModel ? (selectedName !== selectedModel ? `${selectedName}` : selectedModel) : "Inherit parent model"}
          </span>
          {selectedModel && selectedName !== selectedModel && (
            <span className="ml-auto shrink-0 text-[9px] text-muted-foreground/60">{selectedModel}</span>
          )}
        </button>
        {selectedModel && (
          <button
            type="button"
            title="Clear model — inherit parent"
            onClick={() => onSelect(undefined)}
            className="chat-interactive shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            if (!open) setOpen(true);
            actions.refreshModels(provider, { force: true });
          }}
          disabled={loading}
          title="Refresh model list"
        >
          Browse
        </Button>
      </div>

      {!keySet && (
        <div className="text-[9.5px] text-[color:var(--s-warn)]">
          No API key for {provider} — set it in the Model tab to browse live models.
        </div>
      )}

      {/* Inline picker (expandable) */}
      {open && (
        <div className="rounded-md border border-border bg-white/[0.02] p-2">
          <ModelPickerList
            models={models}
            selectedId={selectedModel}
            onSelect={(id) => {
              onSelect(id === selectedModel ? undefined : id);
              setOpen(false);
            }}
            provider={provider}
            loading={loading}
            onRefresh={() => actions.refreshModels(provider, { force: true })}
            maxHeightClass="max-h-[240px]"
          />
        </div>
      )}
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export function SubagentPanel() {
  const store = useStore();
  const { settings } = store;
  const subagentCfg = settings.subagent;
  const userProfiles = (subagentCfg?.profiles ?? []).filter((p) => !p.builtin);
  const allProfiles = [...BUILTIN_PROFILES, ...userProfiles];

  const subProvider = subagentCfg?.provider;
  const subModel = subagentCfg?.model ?? "";
  const maxConcurrent = subagentCfg?.maxConcurrent ?? 4;

  const [editing, setEditing] = useState<Partial<SubagentProfile> | null>(null);
  const [showNew, setShowNew] = useState(false);

  const handleSave = (profile: SubagentProfile) => {
    actions.upsertSubagentProfile(profile);
    setEditing(null);
    setShowNew(false);
  };

  const PROVIDER_WITH_INHERIT = [
    { id: "inherit" as const, label: "Inherit" },
    ...PROVIDER_TABS,
  ];

  return (
    <Section>
      <Field
        label="Subagent Provider"
        hint="Override which provider and model runs in delegated lanes. 'Inherit' uses the parent session's provider."
      >
        <Note>
          Use a cheaper or faster model for subagents while the parent uses a more capable one.
          A separate API key per provider is used automatically when configured.
        </Note>
        <div className="mt-1 flex flex-col gap-2">
          <Segmented
            options={PROVIDER_WITH_INHERIT}
            value={(subProvider ?? "inherit") as "inherit" | "anthropic" | "openrouter" | "openai"}
            onChange={(id) => {
              const p = id === "inherit" ? undefined : (id as ProviderName);
              actions.setSubagentProvider(p, undefined);
            }}
          />

          {subProvider && (
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-muted-foreground">Subagent Model</label>
              <SubagentModelPicker
                provider={subProvider}
                selectedModel={subModel}
                onSelect={(model) => actions.setSubagentProvider(subProvider, model)}
              />
            </div>
          )}
        </div>
      </Field>

      <Separator />

      <Field label="Max Concurrent Lanes" hint="Maximum parallel subagent lanes per turn (1–8). Default: 4.">
        <Row label="Concurrent limit">
          <Input
            type="number" min={1} max={8}
            value={maxConcurrent}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!isNaN(n) && n >= 1 && n <= 8) actions.setSubagentMaxConcurrent(n);
            }}
            className="h-7 w-16 text-[11px]"
          />
        </Row>
      </Field>

      <Separator />

      <Field label="Profiles">
        <Note>
          Profiles specialize a subagent lane's focus with a custom system prompt addition.
          Pass <code className="rounded bg-primary/15 px-1 text-[9.5px] text-primary">profileId</code> to{" "}
          <code className="rounded bg-primary/15 px-1 text-[9.5px] text-primary">subagent_spawn</code> to activate one.
        </Note>

        <div className="flex flex-col gap-1.5">
          {allProfiles.map((profile) => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              onDelete={() => actions.deleteSubagentProfile(profile.id)}
              onEdit={(p) => { setShowNew(false); setEditing(p); }}
            />
          ))}
        </div>

        {(showNew || editing) && (
          <ProfileEditor
            initial={editing ?? undefined}
            onSave={handleSave}
            onCancel={() => { setEditing(null); setShowNew(false); }}
          />
        )}

        {!showNew && !editing && (
          <Button
            size="xs"
            variant="outline"
            className="w-full"
            onClick={() => { setEditing(null); setShowNew(true); }}
          >
            <Plus className="size-3" /> New Profile
          </Button>
        )}
      </Field>
    </Section>
  );
}
