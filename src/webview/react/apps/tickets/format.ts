/* Ticket-surface formatting. The shared formatRelativeTime is written for prose ("3 minutes
   ago" in a transcript); a dense list needs the same fact in three characters, and mixing the
   two in one column makes the column ragged. */

export function shortRelative(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 6) return `${weeks}w`;
  try {
    return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return `${Math.round(days / 30)}mo`;
  }
}

export function absoluteTime(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  try {
    return new Date(at).toLocaleString([], {
      year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}
