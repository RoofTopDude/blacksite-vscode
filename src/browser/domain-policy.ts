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
  grant(raw: string, scope: "page" | "session"): void {
    const url = researchUrl(raw);
    if (this.settings.deniedDomains.some(d => matchesDomain(url.hostname, d))) throw new BrowserPolicyError("denied", "An explicit deny overrides grants.");
    if (scope === "page") this.pages.add(url.href); else this.sessions.add(url.hostname);
  }
  /** Page grants authorize one retrieval chain; redirects must independently pass policy. */
  consumePage(raw: string): void { this.pages.delete(researchUrl(raw).href); }
  get domains(): string[] { return [...new Set([...this.settings.allowedDomains, ...this.sessions])]; }
}
