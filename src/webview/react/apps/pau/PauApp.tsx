import { useEffect, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  actions, initPauStore, usePauStore, selectedReceipt,
  type PauReceiptEvent, type PauTopHog, type PauCacheObservation, type PauEconomics, type PauPlan,
} from "./store";

const GRADE_TONE: Record<string, string> = {
  A: "var(--s-ok)", B: "var(--s-info)", C: "var(--s-warn)", D: "var(--s-err)",
};

const SEVERITY_TONE: Record<string, string> = {
  low: "var(--s-ok)", watch: "var(--s-info)", medium: "var(--s-warn)", high: "var(--s-warn)", severe: "var(--s-err)",
};

function toneStyle(tone: string): CSSProperties {
  return {
    color: tone,
    background: `color-mix(in srgb, ${tone} 14%, transparent)`,
    borderColor: `color-mix(in srgb, ${tone} 28%, transparent)`,
  };
}

function Chip({ children, tone }: { children: ReactNode; tone: string }) {
  return (
    <span className="inline-flex items-center rounded-full border px-1.5 py-px text-2xs font-semibold" style={toneStyle(tone)}>
      {children}
    </span>
  );
}

function pct(value: number | null | undefined): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function relativeTime(at: number): string {
  const deltaS = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (deltaS < 5) return "just now";
  if (deltaS < 60) return `${deltaS}s ago`;
  const deltaM = Math.round(deltaS / 60);
  if (deltaM < 60) return `${deltaM}m ago`;
  return `${Math.round(deltaM / 60)}h ago`;
}

function Meter({ label, value, tone = "var(--primary)" }: { label: string; value: number | null; tone?: string }) {
  const clamped = value == null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between text-2xs text-muted-foreground">
        <span className="eyebrow">{label}</span>
        <span className="font-mono text-foreground">{pct(value)}</span>
      </div>
      <div className="pau-meter-track">
        <div className="pau-meter-fill" style={{ width: `${clamped * 100}%`, background: tone }} />
      </div>
    </div>
  );
}

function DisabledState() {
  return (
    <div className="fade-in flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-sm font-semibold text-foreground">PAU metrics are off</div>
      <div className="max-w-[280px] text-xs leading-relaxed text-muted-foreground">
        Beta, read-only instrumentation that measures what's consuming the agent's context window
        each turn — token load, duplication, replay, and hog segments. It never changes what's
        sent to the model. Off by default while this gets real-world testing.
      </div>
      <Button size="xs" variant="outline" onClick={() => actions.openSettings()}>
        Enable in Settings
      </Button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="fade-in flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="live-breathe text-sm text-muted-foreground">Waiting for the next turn…</div>
      <div className="max-w-[260px] text-xs text-muted-foreground">
        A receipt appears here once a turn completes.
      </div>
    </div>
  );
}

function SkippedDetail({ reason }: { reason: string }) {
  const unsupported = reason.includes("bedrock-unsupported");
  return (
    <div className="chat-sunken flex flex-col gap-1.5 p-3">
      <Chip tone="var(--muted-foreground)">Not measured</Chip>
      <div className="text-xs leading-relaxed text-muted-foreground">
        {unsupported
          ? "Bedrock Converse isn't supported yet — its message shape has no matching adapter. Switch to the Mantle API to measure Bedrock sessions, or use Anthropic/OpenAI directly."
          : `Skipped: ${reason}`}
      </div>
    </div>
  );
}

function TopHogsTable({ hogs }: { hogs: PauTopHog[] }) {
  if (hogs.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="eyebrow text-muted-foreground">Hog segments</span>
      <div className="flex flex-col gap-1">
        {hogs.map((hog) => (
          <div key={hog.id} className="chat-sunken flex items-center gap-1.5 px-2 py-1 text-xs">
            <Chip tone={SEVERITY_TONE[hog.hogSeverity] || "var(--muted-foreground)"}>{hog.hogSeverity}</Chip>
            <span className="truncate font-mono text-foreground" title={hog.source || hog.type}>{hog.source || hog.type}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">{hog.tokens.toLocaleString()} tok</span>
            <span className="shrink-0 font-mono text-foreground">{pct(hog.pauShare)} PAU</span>
            {hog.replayCount > 0 && <Chip tone="var(--s-info)">×{hog.replayCount + 1}</Chip>}
          </div>
        ))}
      </div>
    </div>
  );
}

function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `${Math.round(value)}`;
}

/**
 * Observed cache behaviour plus, when rates are resolvable, the verdict on whether caching has
 * paid for its own write premium. An unpriced provider still gets the top half — the counts come
 * from the provider's own usage numbers and need no rate table.
 */
function CachePanel({ cache, economics }: { cache?: PauCacheObservation; economics?: PauEconomics }) {
  if (!cache) return null;
  const amortized = economics?.amortized;
  const verdict = economics?.known === false
    ? { tone: "var(--muted-foreground)", label: "unpriced" }
    : amortized == null
      ? { tone: "var(--muted-foreground)", label: "no writes yet" }
      : amortized
        ? { tone: "var(--s-ok)", label: "amortized" }
        : { tone: "var(--s-warn)", label: "below break-even" };

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2.5">
      <div className="flex items-center gap-1.5">
        <span className="eyebrow text-muted-foreground">Cache</span>
        <Chip tone={verdict.tone}>{verdict.label}</Chip>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Meter label="Hit ratio" value={cache.hitRatio} tone="var(--s-ok)" />
        <Meter label="Prefix stable" value={cache.stablePrefixRatio} tone="var(--s-info)" />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
        <span>
          reads/write{" "}
          <span className="font-mono text-foreground">
            {cache.readsPerWrite == null ? "—" : cache.readsPerWrite.toFixed(2)}
          </span>
          {economics?.breakEvenReads != null && (
            <> vs <span className="font-mono text-foreground">{economics.breakEvenReads.toFixed(2)}</span> needed</>
          )}
        </span>
        {cache.invalidatedTokens > 0 && (
          <span>
            invalidated <span className="font-mono text-[color:var(--s-warn)]">{compact(cache.invalidatedTokens)}</span> tok
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Advisory only — the plan is shown to a person and never enters the model's context. Actions
 * the library ranked as worthwhile but whose blast radius makes them net-negative are marked
 * rather than hidden: the disagreement is the interesting part.
 */
function PlanPanel({ plan }: { plan?: PauPlan }) {
  if (!plan || plan.actions.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
      <div className="flex items-center gap-1.5">
        <span className="eyebrow text-muted-foreground">Suggested</span>
        <Chip tone="var(--muted-foreground)">{plan.policy}</Chip>
        {plan.demotedByCache > 0 && (
          <Chip tone="var(--s-warn)">{plan.demotedByCache} cache-negative</Chip>
        )}
        {!plan.priced && <Chip tone="var(--muted-foreground)">unranked</Chip>}
      </div>
      <div className="flex flex-col gap-1">
        {plan.actions.slice(0, 6).map((action) => (
          <div
            key={action.segmentId}
            className="chat-sunken flex flex-col gap-0.5 px-2 py-1.5 text-xs"
            title={action.reason}
          >
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-foreground">{action.action}</span>
              <span className="truncate text-muted-foreground" title={action.source || action.segmentId}>
                {action.source || action.segmentId}
              </span>
              {action.cache.priced && (
                <span
                  className="ml-auto shrink-0 font-mono"
                  style={{ color: action.cacheNegative ? "var(--s-err)" : "var(--s-ok)" }}
                >
                  {action.cache.netITE >= 0 ? "+" : "−"}{compact(Math.abs(action.cache.netITE))}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-2xs text-muted-foreground">
              <span>saves {compact(action.currentTokenSavings)} tok</span>
              {action.blastTokens > 0 && <span>rewrites {compact(action.blastTokens)}</span>}
              <span>{action.confidence} confidence</span>
            </div>
          </div>
        ))}
      </div>
      <div className="text-2xs text-muted-foreground">
        Advisory. {plan.governanceLockedSegments > 0 && `${plan.governanceLockedSegments} segment(s) locked by governance. `}
        Nothing here is applied automatically.
      </div>
    </div>
  );
}

function ReceiptDetail({ event }: { event: PauReceiptEvent }) {
  const { receipt } = event;
  if (receipt.skipped) return <SkippedDetail reason={receipt.reason} />;

  return (
    <div className="chat-sunken pau-card-in flex flex-col gap-2.5 p-3">
      <div className="flex items-center gap-1.5">
        <Chip tone={GRADE_TONE[receipt.tokenAccountingGrade] || "var(--muted-foreground)"}>
          Grade {receipt.tokenAccountingGrade}
        </Chip>
        <span className="truncate font-mono text-xs text-foreground" title={receipt.model}>{receipt.model || "model"}</span>
        <span className="ml-auto shrink-0 text-2xs text-muted-foreground">{relativeTime(event.at)}</span>
      </div>

      <div className="flex items-end gap-3">
        <div className="flex flex-col">
          <span className="pau-health-value" style={{ color: healthColor(receipt.contextHealthScore) }}>
            {Math.round(receipt.contextHealthScore)}
          </span>
          <span className="eyebrow text-muted-foreground">Context health</span>
        </div>
        <div className="flex flex-col text-xs text-muted-foreground">
          <span className="font-mono text-foreground">{receipt.totalTokens.toLocaleString()} tokens</span>
          <span className="font-mono text-foreground">{Math.round(receipt.totalPAU).toLocaleString()} PAU</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Meter label="Raw utilization" value={receipt.rawUtilization} />
        <Meter label="PAU utilization" value={receipt.pauUtilization} tone="var(--s-info)" />
        <Meter label="Duplicate tokens" value={receipt.duplicateTokenRatio} tone="var(--s-warn)" />
        <Meter label="Replay overhead" value={receipt.replayOverheadRatio} tone="var(--s-warn)" />
      </div>

      <TopHogsTable hogs={receipt.topHogs} />

      <CachePanel cache={receipt.cache} economics={receipt.economics} />

      <PlanPanel plan={receipt.plan} />

      {receipt.warnings.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-border pt-2">
          {receipt.warnings.map((warning, i) => (
            <div key={i} className="text-2xs text-[color:var(--s-warn)]">⚠ {warning}</div>
          ))}
        </div>
      )}

      <div className="text-2xs text-muted-foreground">{receipt.tokenAccountingNote}</div>
    </div>
  );
}

function healthColor(score: number): string {
  if (score >= 75) return "var(--s-ok)";
  if (score >= 50) return "var(--s-info)";
  if (score >= 25) return "var(--s-warn)";
  return "var(--s-err)";
}

function HistoryList({ receipts, selectedIndex }: { receipts: PauReceiptEvent[]; selectedIndex: number | null }) {
  if (receipts.length <= 1) return null;
  const effectiveIndex = selectedIndex ?? receipts.length - 1;
  return (
    <div className="flex flex-col gap-1">
      <span className="eyebrow text-muted-foreground">History</span>
      <div className="flex flex-col-reverse gap-0.5">
        {receipts.map((event, index) => {
          const active = index === effectiveIndex;
          const r = event.receipt;
          return (
            <button
              key={`${event.at}-${index}`}
              type="button"
              onClick={() => actions.select(index === receipts.length - 1 ? null : index)}
              className="pau-history-row"
              data-active={active || undefined}
            >
              <span className="w-12 shrink-0 text-left text-2xs text-muted-foreground">{relativeTime(event.at)}</span>
              {r.skipped ? (
                <span className="truncate text-2xs text-muted-foreground">skipped</span>
              ) : (
                <>
                  <span className="font-mono text-2xs text-foreground">{r.totalTokens.toLocaleString()} tok</span>
                  <span className="ml-auto shrink-0 font-mono text-2xs" style={{ color: healthColor(r.contextHealthScore) }}>
                    {Math.round(r.contextHealthScore)}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function PauApp() {
  const s = usePauStore();

  useEffect(() => { initPauStore(); }, []);

  const current = selectedReceipt();

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="text-sm font-semibold text-foreground">Context Receipts</span>
        <Chip tone="var(--s-info)">Beta</Chip>
        {s.receipts.length > 0 && (
          <Button size="xs" variant="outline" className="ml-auto" onClick={() => actions.clear()}>
            Clear
          </Button>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
        {!s.ready ? null : !s.enabled ? (
          <DisabledState />
        ) : s.receipts.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {current && <ReceiptDetail event={current} />}
            <HistoryList receipts={s.receipts} selectedIndex={s.selectedIndex} />
          </>
        )}
      </div>
    </div>
  );
}
