import { domainToASCII } from "node:url";
import { isIP } from "node:net";
import { parse } from "tldts";
import { BrowserPolicyError } from "./approval-types.js";

import type { ResearchPolicy } from "./approval-types.js";
export type { ResearchPolicy } from "./approval-types.js";
export const EMPTY_POLICY: ResearchPolicy = { allowedDomains: [], deniedDomains: [], unknownDomainPolicy: "ask", searchProvider: "none" };
export function normalizeDomain(raw: string): string {
  if (typeof raw !== "string" || /[\s/:@*?#\\%]/u.test(raw)) throw new Error("Enter a hostname without a scheme, path, wildcard or credentials.");
  const host = domainToASCII(raw.replace(/\.$/, "").toLowerCase());
  const parsed = parse(host, { allowPrivateDomains: true });
  if (!host || host.length > 253 || isIP(host) || !parsed.domain || (!parsed.isIcann && !parsed.isPrivate)
    || host.split(".").some(l => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) {
    throw new Error("Use a public hostname below a public or shared-hosting suffix.");
  }
  return host;
}
export function matchesDomain(host: string, entry: string): boolean { return host === entry || host.endsWith(`.${entry}`); }
/**
 * The registrable domain a human actually means when they approve a source: "wikipedia.org"
 * for "en.wikipedia.org", so one decision covers the whole site rather than each subdomain
 * asking again.
 *
 * Private suffixes are honored, which is the part that makes this safe on shared hosting:
 * the registrable domain of "alice.github.io" is "alice.github.io", not "github.io", so
 * approving one tenant of github.io / vercel.app / pages.dev / s3.amazonaws.com never
 * approves another's.
 */
export function baseDomain(raw: string): string {
  const host = normalizeDomain(raw);
  // normalizeDomain already rejected anything without a public or private suffix.
  return parse(host, { allowPrivateDomains: true }).domain ?? host;
}
export function normalizePolicy(value: ResearchPolicy): ResearchPolicy {
  if (!Array.isArray(value.allowedDomains) || !Array.isArray(value.deniedDomains)
    || !["ask", "deny"].includes(value.unknownDomainPolicy) || !["none", "brave"].includes(value.searchProvider)) throw new Error("Invalid research policy.");
  return { ...value, allowedDomains: [...new Set(value.allowedDomains.map(normalizeDomain))], deniedDomains: [...new Set(value.deniedDomains.map(normalizeDomain))] };
}
export function researchUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.port || url.username || url.password) throw new BrowserPolicyError("denied", "Research requires HTTPS on port 443 without embedded credentials. Use an explicitly scoped local browser for local testing.");
  url.hostname = normalizeDomain(url.hostname);
  url.hash = "";
  return url;
}
export function redactedUrl(raw: string): string {
  try { const u = new URL(raw); u.username = ""; u.password = ""; u.hash = ""; for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, "[redacted]"); return u.href; } catch { return "[invalid URL]"; }
}
export class DomainPolicy {
  version = 0;
  private sessions = new Set<string>();
  private pages = new Set<string>();
  constructor(public settings: ResearchPolicy = { ...EMPTY_POLICY }) { this.replace(settings); }
  replace(settings: ResearchPolicy): void { this.settings = normalizePolicy(settings); this.revoke(); }
  revoke(): void { this.version++; this.sessions.clear(); this.pages.clear(); }
  status(raw: string): "allow" | "ask" | "deny" {
    const url = researchUrl(raw);
    if (this.settings.deniedDomains.some(d => matchesDomain(url.hostname, d))) return "deny";
    if (this.pages.has(url.href) || [...this.settings.allowedDomains, ...this.sessions].some(d => matchesDomain(url.hostname, d))) return "allow";
    return this.settings.unknownDomainPolicy;
  }
  /** A session grant is registrable-domain wide: approving one Wikipedia article approves
   *  Wikipedia. A page grant stays exact — it is the deliberate one-shot. */
  grant(raw: string, scope: "page" | "session"): void {
    const url = researchUrl(raw);
    if (this.settings.deniedDomains.some(d => matchesDomain(url.hostname, d))) throw new BrowserPolicyError("denied", "An explicit deny overrides grants.");
    if (scope === "page") this.pages.add(url.href); else this.sessions.add(baseDomain(url.hostname));
  }
  /** Spend a page grant. Returns whether one was actually in effect, which is what lets a
   *  caller decide if a redirect is still inside the retrieval the human approved. */
  consumePage(raw: string): boolean { return this.pages.delete(researchUrl(raw).href); }
  /**
   * Extend a spent page grant onto a redirect the publisher itself performed inside its own
   * registrable domain — wikipedia.org/wiki/X to en.wikipedia.org/wiki/X is one retrieval, and
   * charging the human a second approval for the server's own hop is noise, not consent.
   *
   * Cross-site hops get nothing and re-enter policy on their own, and an explicit deny on the
   * target still wins.
   */
  followRedirect(from: string, to: string): void {
    const source = researchUrl(from);
    const target = researchUrl(to);
    if (baseDomain(source.hostname) !== baseDomain(target.hostname)) return;
    if (this.settings.deniedDomains.some(d => matchesDomain(target.hostname, d))) return;
    this.pages.add(target.href);
  }
  get domains(): string[] { return [...new Set([...this.settings.allowedDomains, ...this.sessions])]; }
}
