/**
 * The post-run report: what this run touched, and whether it matched what it promised.
 *
 * Deliberately not another event list — the stream above and the sidebar's timeline are both
 * already that. A raw trace tells you what happened in order; it does not tell you whether your
 * workspace is dirty right now, which files got written that nobody declared, or which host the
 * run talked to that was not on the manifest. Those are the questions this answers, in the order
 * a person actually asks them.
 */
import { AlertTriangle, CheckCircle2, FileWarning, Images, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InspectionReport as Report } from "./messages";

const CLASS_LABEL: Record<string, string> = {
  destructive: "Destructive",
  external_mutation: "External mutation",
  workspace_write: "Workspace writes",
  process: "Processes",
  network_write: "Network writes",
  network_read: "Network reads",
  workspace_read: "Workspace reads",
};

function classTone(effectClass: string): string {
  if (effectClass === "destructive" || effectClass === "external_mutation") return "var(--s-err)";
  if (effectClass === "workspace_write" || effectClass === "process") return "var(--s-warn)";
  return "var(--s-info)";
}

export function InspectionReport({
  report,
  onSeek,
}: {
  report: Report;
  onSeek: (sequenceNumber: number) => void;
}) {
  return (
    <div className="theater-report min-h-0 overflow-y-auto px-5 py-4">
      {/* Verdict — the one thing worth reading if you read nothing else. */}
      <section className={cn("theater-verdict", report.dirty && "is-dirty")}>
        {report.dirty
          ? <ShieldAlert className="size-4 shrink-0" aria-hidden />
          : <CheckCircle2 className="size-4 shrink-0" aria-hidden />}
        <p className="text-sm">{report.verdict}</p>
      </section>

      {/* Blast radius — what it touched, most consequential first. */}
      {report.blastRadius.length > 0 && (
        <section className="theater-report-section">
          <h2>Blast radius</h2>
          <div className="theater-effects">
            {report.blastRadius.map((group) => (
              <details key={group.class} className="theater-effect">
                <summary style={{ ["--effect-tone" as string]: classTone(group.class) }}>
                  <span className="theater-effect-name">{CLASS_LABEL[group.class] ?? group.class}</span>
                  <span className="theater-effect-count tabular-nums">{group.count}</span>
                  {group.irreversibleCount > 0 && (
                    <span className="theater-effect-flag">
                      <FileWarning className="size-3" aria-hidden />
                      {group.irreversibleCount} irreversible
                    </span>
                  )}
                </summary>
                <ul>
                  {group.entities.map((entity) => (
                    <li key={`${entity.scheme}:${entity.id}`}>
                      <span className="theater-entity-scheme">{entity.scheme}</span>
                      <span className="truncate">{entity.workspacePath ?? entity.id}</span>
                    </li>
                  ))}
                  {group.entities.length === 0 && group.descriptions.map((description) => (
                    <li key={description}><span className="truncate">{description}</span></li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </section>
      )}

      {/* Promise vs reality — the middle bucket is the one people actually read. */}
      {report.promise && (
        <section className="theater-report-section">
          <h2>Promise vs reality</h2>
          <div className="theater-promise">
            <PromiseBucket
              tone="warn"
              title="Beyond declaration"
              hint="Happened, but the preflight manifest did not say it would."
              items={report.promise.beyondDeclaration}
              emphasise
            />
            <PromiseBucket tone="ok" title="As declared" items={report.promise.asDeclared} />
            <PromiseBucket tone="idle" title="Declared, never happened" items={report.promise.neverHappened} />
          </div>
        </section>
      )}

      {/* Evidence — assertions, diagnostics, anomalies; each seeks the timeline. */}
      {report.evidence.length > 0 && (
        <section className="theater-report-section">
          <h2>Evidence</h2>
          <ul className="theater-evidence">
            {report.evidence.map((row, index) => (
              <li key={row.eventId ?? `${row.kind}-${index}`}>
                <button
                  type="button"
                  disabled={row.sequenceNumber === undefined}
                  onClick={() => row.sequenceNumber !== undefined && onSeek(row.sequenceNumber)}
                  title={row.sequenceNumber !== undefined ? "Jump to this moment" : undefined}
                >
                  <AlertTriangle
                    className="size-3 shrink-0"
                    style={{ color: row.severity === "error" ? "var(--s-err)" : "var(--s-warn)" }}
                    aria-hidden
                  />
                  <span className="theater-evidence-kind">{row.kind}</span>
                  <span className="truncate">{row.label}</span>
                  {row.detail && <span className="theater-evidence-detail truncate">{row.detail}</span>}
                  {row.sequenceNumber !== undefined && (
                    <span className="theater-evidence-seq tabular-nums">#{row.sequenceNumber}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Perspective sweeps — several frames captured as one comparable set. */}
      {report.perspectives.length > 0 && (
        <section className="theater-report-section">
          <h2>Perspective sets</h2>
          <ul className="theater-perspectives">
            {report.perspectives.map((set) => (
              <li key={set.observationId}>
                <button type="button" onClick={() => onSeek(set.sequenceNumber)}>
                  <Images className="size-3.5 shrink-0" aria-hidden />
                  <span>{set.frameCount} frames</span>
                  <span className="theater-evidence-seq tabular-nums">#{set.sequenceNumber}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function PromiseBucket({
  title,
  hint,
  items,
  tone,
  emphasise,
}: {
  title: string;
  hint?: string;
  items: string[];
  tone: "ok" | "warn" | "idle";
  emphasise?: boolean;
}) {
  // An empty "beyond declaration" bucket is itself the finding — it means the run stayed inside
  // what it promised, which is worth stating rather than hiding.
  if (items.length === 0 && !emphasise) return null;
  return (
    <div className={cn("theater-bucket", `is-${tone}`, emphasise && "is-emphasised")}>
      <h3>{title}<span className="tabular-nums">{items.length}</span></h3>
      {hint && <p className="theater-bucket-hint">{hint}</p>}
      {items.length === 0
        ? <p className="theater-bucket-empty">Nothing — the run stayed within its declared effects.</p>
        : <ul>{items.map((item) => <li key={item} className="truncate">{item}</li>)}</ul>}
    </div>
  );
}
