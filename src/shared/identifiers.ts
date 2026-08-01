/**
 * Identifier and timestamp helpers for the `.blacksite/` document stores.
 *
 * Both of these existed as byte-identical private copies in five files apiece. That is the
 * kind of duplication that only shows up when it matters: hardening ID generation, or moving
 * to a different timestamp precision, would otherwise mean finding every copy — and a copy
 * that got missed produces IDs that collide with nothing else's, silently.
 */

/** The single timestamp format every store writes: ISO 8601, UTC, millisecond precision. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A sortable, prefixed identifier: `<prefix>_<base36 millis>_<base36 random>`.
 *
 * The time component keeps IDs roughly ordered by creation, which is what makes them readable
 * in a document you may have to hand-edit. The random suffix is what separates two records
 * created in the same millisecond.
 */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
