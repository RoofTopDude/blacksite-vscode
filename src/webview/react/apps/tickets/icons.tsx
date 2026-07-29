/* The ticket glyph set.
 *
 * Status and priority are the two properties read at a glance across a list of hundreds, so
 * both are drawn as SHAPE first and colour second: the status ring fills as work progresses,
 * the priority bars grow as it matters more. Someone scanning in greyscale, or with a red-green
 * deficiency, still gets the ordering — which a row of coloured dots would not give them.
 *
 * Drawn inline rather than pulled from lucide because none of these exist there: the
 * progressively-filled ring is the whole idea, and approximating it with a generic circle icon
 * would lose the one thing it communicates.
 */

import { STATUS_TONE, type TicketAssignee, type TicketPriority, type TicketStatus } from "./types";

/** How much of the ring is filled, per status — the "progress" the shape encodes. */
const STATUS_FILL: Record<TicketStatus, number> = {
  triage: 0, backlog: 0, in_progress: 0.5, blocked: 0.5, review: 0.8, done: 1, cancelled: 1,
};

const RADIUS = 5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function StatusIcon({ status, size = 14, className }: {
  status: TicketStatus; size?: number; className?: string;
}) {
  const tone = STATUS_TONE[status];
  const fill = STATUS_FILL[status];
  const dashed = status === "backlog" || status === "triage";

  return (
    <svg
      className={`ticket-status-icon ${className ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      role="img"
      aria-label={status.replace(/_/g, " ")}
      style={{ color: tone }}
    >
      <circle
        cx="7" cy="7" r={RADIUS}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={dashed ? "2.2 2.2" : undefined}
        opacity={status === "cancelled" ? 0.55 : 1}
      />
      {/* The fill arc is stroked at half the radius so it reads as a pie without needing a
          second path — it starts at 12 o'clock and sweeps clockwise like every progress ring. */}
      {fill > 0 && fill < 1 && (
        <circle
          cx="7" cy="7" r={RADIUS / 2}
          stroke="currentColor"
          strokeWidth={RADIUS}
          strokeDasharray={`${(CIRCUMFERENCE / 2) * fill} ${CIRCUMFERENCE}`}
          transform="rotate(-90 7 7)"
        />
      )}
      {status === "done" && (
        <>
          <circle cx="7" cy="7" r={RADIUS} fill="currentColor" opacity="0.22" />
          <path d="M4.6 7.2 6.3 8.9 9.5 5.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {status === "cancelled" && (
        <path d="M4.9 4.9 9.1 9.1M9.1 4.9 4.9 9.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.7" />
      )}
      {status === "blocked" && (
        <path d="M4.4 7h5.2" stroke="var(--background)" strokeWidth="1.6" strokeLinecap="round" />
      )}
      {status === "triage" && <circle cx="7" cy="7" r="1.7" fill="currentColor" />}
    </svg>
  );
}

const PRIORITY_BARS: Record<TicketPriority, number> = { urgent: 3, high: 3, normal: 2, low: 1 };

export function PriorityIcon({ priority, size = 14, className }: {
  priority: TicketPriority; size?: number; className?: string;
}) {
  const filled = PRIORITY_BARS[priority];
  const tone = priority === "urgent" ? "var(--s-err)"
    : priority === "high" ? "var(--s-warn)"
      : priority === "normal" ? "var(--muted-foreground)"
        : "var(--muted-foreground)";

  if (priority === "urgent") {
    return (
      <svg
        className={`ticket-priority-icon is-urgent ${className ?? ""}`}
        width={size} height={size} viewBox="0 0 14 14" role="img" aria-label="urgent priority"
        style={{ color: tone }}
      >
        <rect x="1.5" y="1.5" width="11" height="11" rx="3" fill="currentColor" opacity="0.9" />
        <rect x="6.35" y="3.6" width="1.3" height="4.6" rx="0.65" fill="var(--background)" />
        <rect x="6.35" y="9.2" width="1.3" height="1.3" rx="0.65" fill="var(--background)" />
      </svg>
    );
  }

  return (
    <svg
      className={`ticket-priority-icon is-${priority} ${className ?? ""}`}
      width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={`${priority} priority`}
      style={{ color: tone }}
    >
      {[0, 1, 2].map((index) => (
        <rect
          key={index}
          x={1.8 + index * 4}
          y={9.4 - index * 2.6}
          width="2.8"
          height={3 + index * 2.6}
          rx="0.9"
          fill="currentColor"
          opacity={index < filled ? 1 : 0.22}
        />
      ))}
    </svg>
  );
}

/** Assignment is a two-party question here, so the avatar is a glyph rather than initials:
 *  a person outline for the user, the agent's diamond for the agent, a dashed ring for neither. */
export function AssigneeIcon({ assignee, size = 14, className }: {
  assignee: TicketAssignee; size?: number; className?: string;
}) {
  const label = assignee === "agent" ? "assigned to the agent"
    : assignee === "user" ? "assigned to you" : "unassigned";
  return (
    <svg
      className={`ticket-assignee-icon is-${assignee} ${className ?? ""}`}
      width={size} height={size} viewBox="0 0 14 14" fill="none" role="img" aria-label={label}
    >
      {assignee === "unassigned" && (
        <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" opacity="0.55" />
      )}
      {assignee === "user" && (
        <>
          <circle cx="7" cy="5.2" r="2.1" fill="currentColor" />
          <path d="M2.9 12a4.1 4.1 0 0 1 8.2 0Z" fill="currentColor" />
        </>
      )}
      {assignee === "agent" && (
        <>
          <circle cx="7" cy="7" r="5.4" fill="currentColor" opacity="0.16" />
          <path d="M7 2.6 9.3 7 7 11.4 4.7 7Z" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/** Origin marks: the queue should say where an item came from without a legend. */
export function OriginMark({ origin }: { origin: string }) {
  const map: Record<string, { glyph: string; title: string }> = {
    agent: { glyph: "◆", title: "Filed by the agent" },
    map_note: { glyph: "◎", title: "Promoted from a Codebase Map note" },
    diagnostic: { glyph: "⚠", title: "From a diagnostic or TODO sweep" },
    review: { glyph: "✓", title: "Raised in review" },
  };
  const entry = map[origin];
  if (!entry) return null;
  return <span className="ticket-origin" title={entry.title} aria-label={entry.title}>{entry.glyph}</span>;
}
