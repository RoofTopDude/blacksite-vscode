import { useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import {
  Bot, BookOpen, Brain, ChevronRight, ChevronsDown, Check, Cloud, Code2, Copy, Database,
  FileEdit, FilePlus2, FileSearch2, FileText, FileX2, FlaskConical, FolderGit2,
  FolderOpen, GitBranch, GitPullRequest, Globe, ListTodo, MessageCircleQuestion,
  Puzzle, Search, Server, ShieldAlert, ShieldCheck, Terminal, Workflow, Wrench,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { countLabel, formatDuration, shortText, toolStateText } from "@/lib/format";
import { tokenizeJson, type JsonToken } from "@/lib/json-highlight";
import { formatDetailValue } from "@/lib/tool-presentation";
import { approvalBinaryOf, toolCallLiveElapsedMs, toolGroupsOf, toolStateClass, turnIsLive, type ToolCall, type Turn } from "@/lib/chat-model";
import { toolIconCategory, type ToolIconCategory } from "@/lib/tool-icons";
import type { ApprovalDecision } from "@/lib/protocol";
import { actions } from "@/lib/store";
import { useLiveClock } from "@/lib/use-live-clock";
import { SignalDot, StatusPill, toneStyle, toolStateTone, type SignalTone } from "./signal";
import { TranscriptDocumentCard } from "./TranscriptDocumentCard";

// ── Tool category icon ────────────────────────────────────────────────────────
// Purely a "what kind of thing is this" glyph — neutral/muted so it never competes
// with the StatusChip's color language, which is the only place status is signaled.

const CATEGORY_ICON: Record<ToolIconCategory, LucideIcon> = {
  "file-read": FileText,
  "file-write": FilePlus2,
  "file-edit": FileEdit,
  "file-delete": FileX2,
  "file-browse": FolderOpen,
  "file-search": FileSearch2,
  shell: Terminal,
  process: Server,
  git: GitBranch,
  worktree: FolderGit2,
  code: Code2,
  diagnostics: ShieldAlert,
  test: FlaskConical,
  browser: Globe,
  memory: Brain,
  plan: Workflow,
  todo: ListTodo,
  delegate: Bot,
  page: ChevronsDown,
  search: Search,
  mcp: Puzzle,
  data: Database,
  "integration-issue": GitPullRequest,
  "integration-docs": BookOpen,
  "integration-cloud": Cloud,
  question: MessageCircleQuestion,
  approval: ShieldCheck,
  default: Wrench,
};

export function ToolIcon({ toolName, className }: { toolName: string; className?: string }) {
  const Icon = CATEGORY_ICON[toolIconCategory(toolName)];
  return <Icon className={cn("size-3 shrink-0 text-muted-foreground/70", className)} />;
}

function StatusChip({ state }: { state: ReturnType<typeof toolStateClass> }) {
  const alive = state === "running" || state === "pending";
  return (
    <StatusPill tone={toolStateTone(state)} className={cn("font-mono text-[9px]", alive && "live-breathe")}>
      {toolStateText(state)}
    </StatusPill>
  );
}

function ChangeStat({ additions, deletions }: { additions: number; deletions: number }) {
  if (additions <= 0 && deletions <= 0) return null;
  return (
    <span className="ml-auto flex shrink-0 gap-1.5 font-mono text-[10px]">
      {additions > 0 && <span style={{ color: "var(--s-ok)" }}>+{additions}</span>}
      {deletions > 0 && <span style={{ color: "var(--s-err)" }}>-{deletions}</span>}
    </span>
  );
}

function JsonView({ tokens }: { tokens: JsonToken[] }) {
  return (
    <>
      {tokens.map((t, i) => (t.cls === "ws" ? t.text : <span key={i} className={`jt-${t.cls}`}>{t.text}</span>))}
    </>
  );
}

function DetailCard({ title, value, empty, error }: { title: string; value: string; empty?: boolean; error?: boolean }) {
  const [copied, setCopied] = useState(false);
  // Error results stay uniformly red — a syntax-highlighted error payload would bury
  // "this failed" under a rainbow of JSON token colors, right where legibility matters most.
  const tokens = !empty && !error ? tokenizeJson(value) : null;
  const copyText = tokens ? tokens.map((t) => t.text).join("") : value;

  function copy(e: MouseEvent): void {
    e.stopPropagation();
    navigator.clipboard.writeText(copyText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard unavailable */ });
  }

  return (
    <div className="chat-sunken overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1">
        <span className="eyebrow">{title}</span>
        {!empty && (
          <button
            type="button"
            onClick={copy}
            title="Copy to clipboard"
            className="chat-interactive flex shrink-0 items-center gap-1 rounded px-1 text-[9px] font-medium text-muted-foreground hover:text-foreground"
          >
            {copied ? <Check className="size-2.5" style={{ color: "var(--s-ok)" }} /> : <Copy className="size-2.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      <div className={cn("detail-pre p-2", empty && "italic opacity-60", error && "text-[color:var(--s-err)]")}>
        {tokens ? <JsonView tokens={tokens} /> : value}
      </div>
    </div>
  );
}

function approvalSummary(call: ToolCall): string {
  if (call.approvalState === "pending") return "Waiting for approval";
  if (call.approvalState === "denied") return "Denied by user";
  if (call.approvalState === "granted") {
    if (call.approvalDecision === "allow_all") return "Approved for session";
    if (call.approvalDecision === "allow_always") return "Always allowed";
    return "Approved";
  }
  return "";
}

function approvalTierLabel(call: ToolCall): string {
  // An unrecognized binary's tier is a low-confidence guess — the more useful signal
  // to show is *why* it's pending, so it takes over this slot instead of stacking both.
  if (call.approvalUnrecognized) return "unrecognized command";
  return call.approvalTier ? call.approvalTier.replace(/_/g, "-") : "";
}

/**
 * Shared Allow / Always-allow / Allow-All / Deny row. Used inline here in ToolLog and,
 * via the same turnId/toolCallId/binary props, in the docked PendingBar — so the
 * project-vs-all-projects "always allow" scope choice only needs implementing once.
 */
export function ApprovalButtons({ turnId, toolCallId, binary }: { turnId: string; toolCallId: string; binary: string }) {
  const answer = (decision: ApprovalDecision, command?: string, scope?: "workspace" | "global") => {
    actions.answerApproval(turnId, toolCallId, decision, command, scope);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="xs" onClick={() => answer("allow")}>Allow</Button>
        <Button type="button" size="xs" variant="outline" onClick={() => answer("allow_all")}>Allow All</Button>
        <Button type="button" size="xs" variant="destructive" onClick={() => answer("deny")}>Deny</Button>
      </div>
      {/* The "always allow" decision is one scope choice, not two independent
          options — grouping them under a single "Always allow <binary>" label
          reads as a coherent unit instead of repeating the binary name twice. */}
      {binary && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-white/[0.02] px-1.5 py-1">
          <span className="shrink-0 text-[10px] text-muted-foreground">
            Always allow <span className="font-mono text-foreground">{binary}</span>
          </span>
          <div className="ml-auto flex gap-1">
            <Button type="button" size="xs" variant="outline" onClick={() => answer("allow_always", binary, "workspace")}>This project</Button>
            <Button type="button" size="xs" variant="outline" onClick={() => answer("allow_always", binary, "global")}>All projects</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ApprovalActions({ call }: { call: ToolCall }) {
  if (call.approvalState !== "pending") return null;

  return (
    <div className="reveal-in border-t border-border px-2 py-2">
      <div className="text-[10px] leading-snug text-muted-foreground">
        {call.approvalDescription || "This tool is waiting for your approval."}
      </div>
      <div className="mt-2">
        <ApprovalButtons turnId={call.parentTurnId} toolCallId={call.id} binary={approvalBinaryOf(call)} />
      </div>
    </div>
  );
}

function ToolEntry({ call, parentLive }: { call: ToolCall; parentLive: boolean }) {
  const [open, setOpen] = useState(call.approvalState === "pending");
  const state = toolStateClass(call);
  // Gate ticking on the parent turn actually being live, not just this call's own
  // state — a restored/historical transcript can contain an orphaned call that never
  // got a paired result (interrupted mid-turn) and would otherwise still read
  // "running" forever, which would tick a duration for something that isn't really
  // happening anymore.
  const isLive = parentLive && call.elapsedMs == null && (state === "running" || state === "pending");
  const now = useLiveClock(isLive);
  const liveElapsed = toolCallLiveElapsedMs(call, now);
  const input = formatDetailValue(call.input, "No input");
  const result = call.approvalState === "pending" && !call.result
    ? { text: call.approvalDescription || "Waiting for user approval.", empty: true }
    : formatDetailValue(call.result, call.state === "running" ? "Pending…" : "No result");

  const previewParts: string[] = [];
  const transcriptDocument = call.toolName === "transcript_document";
  const approvalText = approvalSummary(call);
  if (approvalText) previewParts.push(approvalText);
  const tierText = approvalTierLabel(call);
  if (tierText) previewParts.push(tierText);
  if (call.preview) previewParts.push(call.preview);

  return (
    <div id={`tool-${call.id}`} className="chat-surface overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="chat-interactive flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-white/[0.03]"
      >
        <ToolIcon toolName={call.toolName} />
        <StatusChip state={state} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-foreground">{call.label || call.displayName}</div>
          <div className="truncate text-[10px] text-muted-foreground">{previewParts.join(" · ") || "No preview available"}</div>
        </div>
        {liveElapsed != null && (
          <span className={cn("shrink-0 font-mono text-[9.5px] tabular-nums text-muted-foreground", isLive && "text-[color:var(--s-info)]")}>
            {formatDuration(liveElapsed)}
          </span>
        )}
        <ChevronRight className={cn("disclosure size-3 shrink-0 text-muted-foreground", open && "rotate-90")} />
      </button>

      {call.change && (
        <div className="px-2 pb-1.5">
          <div className="chat-sunken px-2 py-1">
            <div className="flex items-center gap-1.5">
              <span className="eyebrow" style={{ color: "var(--primary)" }}>{call.change.verb}</span>
              <span className="truncate font-mono text-[10px] text-foreground" title={call.change.path}>{call.change.path}</span>
              <ChangeStat additions={call.change.additions} deletions={call.change.deletions} />
            </div>
            {call.change.secondary && <div className="mt-0.5 text-[9.5px] text-muted-foreground">{call.change.secondary}</div>}
          </div>
        </div>
      )}

      {call.mediaDataUrl && (
        <div className="px-2 pb-1.5">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); actions.openLightbox(call.mediaDataUrl, call.mediaLabel || call.label || call.displayName); }}
            className="chat-interactive flex w-full items-center gap-2 rounded-md border border-border bg-black/15 p-1.5 text-left hover:border-primary/40"
          >
            <img src={call.mediaDataUrl} alt={call.mediaLabel || call.label} className="fade-in size-10 shrink-0 rounded object-cover" />
            <div className="min-w-0">
              <div className="truncate text-[10.5px] font-medium text-foreground">{call.mediaLabel || "Preview available"}</div>
              <div className="truncate text-[9.5px] text-muted-foreground">{call.preview || call.label}</div>
            </div>
          </button>
        </div>
      )}

      <ApprovalActions call={call} />

      {transcriptDocument && <div className="px-2 pb-2"><TranscriptDocumentCard result={call.result} /></div>}

      {open && (
        <div className="reveal-in grid gap-1.5 px-2 pb-2">
          <DetailCard title="Input" value={input.text} empty={input.empty} />
          {!transcriptDocument && <DetailCard title="Result" value={result.text} empty={result.empty} error={state === "fail"} />}
        </div>
      )}
    </div>
  );
}

function ToolGroup({ group, parentLive }: { group: ReturnType<typeof toolGroupsOf>[number]; parentLive: boolean }) {
  const [open, setOpen] = useState(true);
  const latest = group.calls[group.calls.length - 1];
  const summary = latest ? (latest.preview || latest.label || latest.displayName) : "";
  const tone = toolStateTone(group.state);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="chat-interactive flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-white/[0.035]"
      >
        <ChevronRight className={cn("disclosure size-3 shrink-0 text-muted-foreground", open && "rotate-90")} />
        <ToolIcon toolName={group.key} />
        <SignalDot tone={tone} pulse={parentLive && group.state === "running"} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-semibold text-foreground">{group.displayName}</div>
          {summary && <div className="truncate text-[9.5px] text-muted-foreground">{summary}</div>}
        </div>
        <span className="shrink-0 rounded-full bg-white/10 px-1.5 text-[9px] font-mono text-muted-foreground">{group.calls.length}</span>
      </button>
      {open && (
        <div className="reveal-in tool-rail mt-1 flex flex-col gap-1">
          {group.calls.map((call) => <ToolEntry key={call.id} call={call} parentLive={parentLive} />)}
        </div>
      )}
    </div>
  );
}

const DIAG_TONE: Record<string, SignalTone> = { error: "err", warn: "warn" };

export function ToolLog({ turn }: { turn: Turn }) {
  const parentLive = turnIsLive(turn);
  const groups = toolGroupsOf(turn);
  // Delegated-lane spawns render as their own card below (see LaneTile), not as a row
  // here — excluded from these stats too so the "N tool calls" summary matches what
  // actually expands underneath it.
  const calls = turn.toolCallList.filter((c) => c.toolName !== "subagent_spawn");
  const running = calls.filter((c) => toolStateClass(c) === "running").length;
  const pending = calls.filter((c) => toolStateClass(c) === "pending").length;
  const failed = calls.filter((c) => toolStateClass(c) === "fail").length;
  const needsSummary = calls.length >= 2 || pending > 0 || failed > 0;
  const [expanded, setExpanded] = useState(false);

  const recentChanges = calls.filter((c) => c.change).slice(-3).reverse();

  if (!calls.length && !turn.diagnostics.length) return null;

  const shellTitle = pending > 0 ? "Approval required"
    : running > 0 || turn.status === "streaming" ? "Live execution"
      : failed > 0 ? "Execution finished with issues" : "Execution captured";
  const latest = calls[calls.length - 1];
  const latestText = latest ? (latest.change ? `${latest.change.verb} · ${latest.change.path}` : (latest.preview || latest.label || latest.displayName)) : "";

  const showGroups = !needsSummary || expanded;

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {turn.diagnostics.length > 0 && (
        <div className="flex flex-col gap-1">
          {turn.diagnostics.map((d, i) => (
            <div
              key={i}
              className="fade-in flex items-start gap-1.5 rounded-full border px-2 py-1 text-[10px] leading-snug"
              style={toneStyle(DIAG_TONE[d.level] ?? "info")}
            >
              <span className="shrink-0">{d.level === "error" ? "✕" : d.level === "warn" ? "⚠" : "ℹ"}</span>
              <span className="break-words">{d.message}</span>
            </div>
          ))}
        </div>
      )}

      {needsSummary && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="chat-surface chat-interactive px-2 py-1.5 text-left hover:bg-white/[0.045]"
        >
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="eyebrow">Execution</div>
              <div className="truncate text-[11px] font-semibold text-foreground">{shellTitle}</div>
              {latestText && <div className="truncate text-[10px] text-muted-foreground">Latest · {shortText(latestText, 110)}</div>}
            </div>
            <span className="shrink-0 text-[10px] text-primary">{expanded ? "Hide" : "Inspect"}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            <Chip tone={running > 0 ? "info" : "idle"}>{countLabel(calls.length, "tool call")}</Chip>
            {turn.approvalCount > 0 && <Chip tone="warn">{countLabel(turn.approvalCount, "approval")}</Chip>}
            {failed > 0 && <Chip tone="err">{failed} failed</Chip>}
            {turn.iterations > 0 && <Chip tone="idle">{countLabel(turn.iterations, "iteration")}</Chip>}
          </div>
          {recentChanges.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-0.5">
              {recentChanges.map((c, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[10px]">
                  <span className="text-muted-foreground">{c.change!.verb}</span>
                  <span className="truncate font-mono text-foreground" title={c.change!.path}>{c.change!.path}</span>
                  <ChangeStat additions={c.change!.additions} deletions={c.change!.deletions} />
                </div>
              ))}
            </div>
          )}
        </button>
      )}

      {showGroups && (
        <div className={cn("flex flex-col gap-1", needsSummary && "reveal-in")}>
          {groups.map((group) => <ToolGroup key={group.key} group={group} parentLive={parentLive} />)}
        </div>
      )}
    </div>
  );
}

function Chip({ children, tone }: { children: ReactNode; tone: SignalTone }) {
  const style: CSSProperties = tone === "idle"
    ? { color: "var(--muted-foreground)", background: "rgba(255,255,255,0.06)", borderColor: "var(--border)" }
    : toneStyle(tone);
  return <span className="rounded-full border px-1.5 py-px text-[9px] font-medium" style={style}>{children}</span>;
}
