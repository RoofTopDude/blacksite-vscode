import { timingSafeEqual } from "node:crypto";

/** Constant-time comparison for the loopback bridge bearer token. Kept independent of the
 * browser protocol package so the security boundary has a small, directly testable surface. */
export function isBridgeRequestAuthorized(header: string | undefined, token: string): boolean {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
