import { useState, type CSSProperties, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { countLabel, formatDuration, shortText, toolStateText, type ToolState } from "@/lib/format";
import { formatDetailValue } from "@/lib/tool-presentation";
import { toolGroupsOf, toolStateClass, type ToolCall, type Turn } from "@/lib/chat-model";
import type { ApprovalDecision } from "@/lib/protocol";
import { actions } from "@/lib/store";

const SIGNAL: Record<ToolState, string> = {
  running: "var(--s-info)",
  ok: "var(--s-ok)",
  fail: "var(--s-err)",
  pending: "var(--s-warn)",
};

function signalStyle(state: ToolState): CSSProperties {
  const c = SIGNAL[state];
  return {
    color: c,
    background: `color-mix(in srgb, ${c} 14%, transparent)`,
    borderColor: `color-mix(in srgb, ${c} 28%, transparent)`,
  };
}

function StatusChip({ state }: { state: ToolState }) {
  return (
    <span
      className="shrink-0 rounded-full border px-1.5 py-px font-mono text-[9px] font-semibold leading-tight"
      style={signalStyle(state)}
    >
      {toolStateText(state)}
    </span>
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

function DetailCard({ title, value, empty, error }: { title: string; value: string; empty?: boolean; error?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-black/15">
      <div className="border-b border-border px-2 py-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className={cn("detail-pre p-2", empty && "italic opacity-60", error && "text-[color:var(--s-err)]")}>{value}</div>
    </div>
  );
}

function approvalSummary(call: ToolCall): string {
  if (call.approvalState === "pending") return "Waiting for approval";
  if (call.approvalState === "denied") return "Denied by user";
  if (call.approvalState === "granted") {
    return call.approvalDecision === "allow_all" ? "Approved for session" : "Approved";
  }
  return "";
}

function approvalTierLabel(tier: string): string {
  return tier ? tier.replace(/_/g, "-") : "";
}

function ApprovalActions({ call }: { call: ToolCall }) {
  if (call.approvalState !== "pending") return null;

  const answer = (decision: ApprovalDecision) => {
    actions.answerApproval(call.parentTurnId, call.id, decision);
  };

  return (
    <div className="border-t border-border px-2 py-2">
      <div className="text-[10px] leading-snug text-muted-foreground">
        {call.approvalDescription || "This tool is waiting for your approval."}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button type="button" size="xs" onClick={() => answer("allow")}>Allow</Button>
        <Button type="button" size="xs" variant="outline" onClick={() => answer("allow_all")}>Allow All</Button>
        <Button type="button" size="xs" variant="destructive" onClick={() => answer("deny")}>Deny</Button>
      </div>
    </div>
  );
}

function ToolEntry({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(call.approvalState === "pending");
  const state = toolStateClass(call);
  const input = formatDetailValue(call.input, "No input");
  const result = call.approvalState === "pending" && !call.result
    ? { text: call.approvalDescription || "Waiting for user approval.", empty: true }
    : formatDetailValue(call.result, call.state === "running" ? "Pending…" : "No result");

  const previewParts: string[] = [];
  const approvalText = approvalSummary(call);
  if (approvalText) previewParts.push(approvalText);
  const tierText = approvalTierLabel(call.approvalTier);
  if (tierText) previewParts.push(tierText);
  if (call.preview) previewParts.push(call.preview);

  return (
    <div className="rounded-md border border-border bg-white/[0.015]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-white/[0.03]"
      >
        <StatusChip state={state} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-foreground">{call.label || call.displayName}</div>
          <div className="truncate text-[10px] text-muted-foreground">{previewParts.join(" · ") || "No preview available"}</div>
        </div>
        {call.elapsedMs != null && <span className="shrink-0 font-mono text-[9.5px] text-muted-foreground">{formatDuration(call.elapsedMs)}</span>}
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>

      {call.change && (
        <div className="px-2 pb-1.5">
          <div className={cn("rounded-md border border-border bg-black/10 px-2 py-1")}>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: "var(--primary)" }}>{call.change.verb}</span>
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
            className="flex w-full items-center gap-2 rounded-md border border-border bg-black/15 p-1.5 text-left hover:border-primary/40"
          >
            <img src={call.mediaDataUrl} alt={call.mediaLabel || call.label} className="size-10 shrink-0 rounded object-cover" />
            <div className="min-w-0">
              <div className="truncate text-[10.5px] font-medium text-foreground">{call.mediaLabel || "Preview available"}</div>
              <div className="truncate text-[9.5px] text-muted-foreground">{call.preview || call.label}</div>
            </div>
          </button>
        </div>
      )}

      <ApprovalActions call={call} />

      {open && (
        <div className="grid gap-1.5 px-2 pb-2">
          <DetailCard title="Input" value={input.text} empty={input.empty} />
          <DetailCard title="Result" value={result.text} empty={result.empty} error={state === "fail"} />
        </div>
      )}
    </div>
  );
}

function ToolGroup({ group }: { group: ReturnType<typeof toolGroupsOf>[number] }) {
  const [open, setOpen] = useState(true);
  const latest = group.calls[group.calls.length - 1];
  const summary = latest ? (latest.preview || latest.label || latest.displayName) : "";
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 bg-white/[0.025] px-2 py-1.5 text-left hover:bg-white/[0.045]"
      >
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: SIGNAL[group.state] }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-semibold text-foreground">{group.displayName}</div>
          {summary && <div className="truncate text-[9.5px] text-muted-foreground">{summary}</div>}
        </div>
        <span className="shrink-0 rounded-full bg-white/10 px-1.5 text-[9px] font-mono text-muted-foreground">{group.calls.length}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-1 p-1">
          {group.calls.map((call) => <ToolEntry key={call.id} call={call} />)}
        </div>
      )}
    </div>
  );
}

export function ToolLog({ turn }: { turn: Turn }) {
  const groups = toolGroupsOf(turn);
  const calls = turn.toolCallList;
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
              className="flex items-start gap-1.5 rounded-full border px-2 py-1 text-[10px] leading-snug"
              style={signalStyle(d.level === "error" ? "fail" : d.level === "warn" ? "pending" : "running")}
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
          className="rounded-md border border-border bg-white/[0.025] px-2 py-1.5 text-left hover:bg-white/[0.045]"
        >
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">Execution</div>
              <div className="truncate text-[11px] font-semibold text-foreground">{shellTitle}</div>
              {latestText && <div className="truncate text-[10px] text-muted-foreground">Latest · {shortText(latestText, 110)}</div>}
            </div>
            <span className="shrink-0 text-[10px] text-primary">{expanded ? "Hide" : "Inspect"}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            <Chip tone={running > 0 ? "live" : ""}>{countLabel(calls.length, "tool call")}</Chip>
            {turn.approvalCount > 0 && <Chip tone="warn">{countLabel(turn.approvalCount, "approval")}</Chip>}
            {failed > 0 && <Chip tone="error">{failed} failed</Chip>}
            {turn.iterations > 0 && <Chip>{countLabel(turn.iterations, "iteration")}</Chip>}
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

      {showGroups && groups.map((group) => <ToolGroup key={group.key} group={group} />)}
    </div>
  );
}

function Chip({ children, tone = "" }: { children: ReactNode; tone?: "" | "live" | "warn" | "error" }) {
  const style: CSSProperties = tone === "live" ? signalStyle("running")
    : tone === "warn" ? signalStyle("pending")
      : tone === "error" ? signalStyle("fail")
        : { color: "var(--muted-foreground)", background: "rgba(255,255,255,0.06)", borderColor: "var(--border)" };
  return <span className="rounded-full border px-1.5 py-px text-[9px] font-medium" style={style}>{children}</span>;
}
