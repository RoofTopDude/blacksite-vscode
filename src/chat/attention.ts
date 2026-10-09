/**
 * One place that knows what needs the user.
 *
 * An approval waiting in a lane, a question card, a conductor that asked instead of continuing, a
 * run that finished or stalled, a ticket loop that parked a ticket: each used to be visible only
 * where it happened, and only if the chat was open. The attention center collects them so the
 * view badge, the status bar, the Header pill and the toasts all read the same list.
 *
 * Pure — no vscode. The surfaces that show it live in attention-surfaces.ts.
 */

export type AttentionKind =
  | "approval"
  | "question"
  | "conductor_ask"
  | "conductor_halt"
  | "run_done"
  | "run_failed"
  | "run_stalled"
  | "run_paused"
  | "run_interrupted"
  | "provider_wait"
  | "budget"
  | "loop_parked"
  | "loop_ended";

/**
 * needs_you: the work cannot go on without a person. error: it stopped badly. success: it
 * finished. info: worth knowing, never worth an interruption.
 */
export type AttentionSeverity = "needs_you" | "error" | "success" | "info";

export type AttentionSource = "chat" | "lane" | "run" | "loop";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  source: AttentionSource;
  title: string;
  detail?: string;
  at: number;
  /** Which lane raised it, when it came from one. */
  lane?: string;
}

const SEVERITY_ORDER: Record<AttentionSeverity, number> = { needs_you: 0, error: 1, success: 2, info: 3 };

export type AttentionListener = (items: readonly AttentionItem[]) => void;

export class AttentionCenter {
  private readonly _items = new Map<string, AttentionItem>();
  private readonly _listeners = new Set<AttentionListener>();
  /** Ids already announced outside the chat, so a state republished twice is not toasted twice. */
  private readonly _announced = new Set<string>();

  /** Add or update an item. Returns true when it is new (so a surface knows to announce it). */
  raise(item: AttentionItem): boolean {
    const isNew = !this._items.has(item.id);
    this._items.set(item.id, item);
    this._emit();
    return isNew;
  }

  resolve(id: string): void {
    if (this._items.delete(id)) {
      this._announced.delete(id);
      this._emit();
    }
  }

  resolveWhere(predicate: (item: AttentionItem) => boolean): void {
    let changed = false;
    for (const [id, item] of this._items) {
      if (!predicate(item)) continue;
      this._items.delete(id);
      this._announced.delete(id);
      changed = true;
    }
    if (changed) this._emit();
  }

  /** Items that need the user, then failures, then good news, newest first within each. */
  list(): AttentionItem[] {
    return [...this._items.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.at - a.at);
  }

  /** What the view badge counts: things waiting on a person, and failures. Not good news. */
  count(): number {
    let n = 0;
    for (const item of this._items.values()) if (item.severity === "needs_you" || item.severity === "error") n += 1;
    return n;
  }

  get(id: string): AttentionItem | undefined {
    return this._items.get(id);
  }

  /** Mark an item as announced; returns false if it already was. */
  markAnnounced(id: string): boolean {
    if (this._announced.has(id)) return false;
    this._announced.add(id);
    return true;
  }

  onChange(listener: AttentionListener): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  private _emit(): void {
    const snapshot = this.list();
    for (const listener of this._listeners) {
      try { listener(snapshot); } catch { /* a broken surface must not stop the others */ }
    }
  }
}

export type NotificationLevel = "attention" | "all" | "off";

export interface NotifyContext {
  windowFocused: boolean;
  chatVisible: boolean;
}

/**
 * Whether an item should interrupt the user outside the chat. A user who is looking at the chat
 * already sees it; the point is the user who walked away, or is in another file.
 */
export function shouldNotify(item: AttentionItem, level: NotificationLevel, context: NotifyContext): boolean {
  if (level === "off") return false;
  const watching = context.windowFocused && context.chatVisible;
  if (watching) return false;
  if (level === "all") return true;
  return item.severity === "needs_you" || item.severity === "error" || item.kind === "run_done";
}

/** The one line the status bar shows for the most pressing item. */
export function describeTopItem(items: readonly AttentionItem[]): string | undefined {
  const top = items[0];
  if (!top) return undefined;
  const extra = items.length - 1;
  return extra > 0 ? `${top.title} (+${extra})` : top.title;
}
