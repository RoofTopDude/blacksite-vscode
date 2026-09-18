import { describe, expect, it, vi } from "vitest";
import { DomainPolicy, normalizeDomain, researchUrl } from "../../src/browser/domain-policy.js";
import { BrowserApprovalCoordinator, type ProposalInput } from "../../src/browser/approval-coordinator.js";
import { publicAddress } from "../../src/browser/research-transport.js";
import { ResearchService } from "../../src/browser/research-service.js";
import { reviewInput } from "../../src/browser/input-reviewer.js";
import type { BrowserDecision, BrowserProposal } from "../../src/browser/approval-types.js";

const policy = () => new DomainPolicy({ allowedDomains: ["example.com"], deniedDomains: ["private.example.com"], unknownDomainPolicy: "ask", searchProvider: "none" });
const input: ProposalInput = { kind: "input", operation: "fill", origin: "https://example.com", url: "https://example.com/form", title: "Form", document: "doc-1", purpose: "Fill public query", fields: [{ target: "e1", label: "Query", type: "text", mode: "replace", value: "Exact\nquery\u200b" }] };

describe("research domain policy", () => {
  it("normalizes host case, trailing dots and IDNs without widening scope", () => {
    expect(normalizeDomain("DOCS.Example.COM.")).toBe("docs.example.com");
    expect(normalizeDomain("bücher.de")).toBe("xn--bcher-kva.de");
    expect(policy().status("https://docs.example.com/page")).toBe("allow");
    expect(policy().status("https://notexample.com")).toBe("ask");
    expect(policy().status("https://example.com.evil.com")).toBe("ask");
  });
  it.each(["com", "co.uk", "github.io", "https://example.com", "example.com/path", "*.example.com", "user@example.com", "127.0.0.1", "2130706433", "bad..example.com", "example.com:443"])("rejects invalid domain %s", value => { expect(() => normalizeDomain(value)).toThrow(); });
  it.each(["http://example.com", "https://example.com:8443", "https://user:secret@example.com", "file:///etc/passwd", "https://127.1", "https://[::1]"])("rejects unsupported research URL %s", value => { expect(() => researchUrl(value)).toThrow(); });
  it("denies take precedence and page grants do not cover redirects or survive revocation", () => {
    const p = policy();
    expect(p.status("https://private.example.com")).toBe("deny");
    expect(() => p.grant("https://private.example.com", "session")).toThrow();
    p.grant("https://other.com/page", "page");
    expect(p.status("https://other.com/page")).toBe("allow");
    expect(p.status("https://other.com/next")).toBe("ask");
    p.consumePage("https://other.com/page");
    expect(p.status("https://other.com/page")).toBe("ask");
    p.grant("https://other.com", "session"); p.revoke();
    expect(p.status("https://other.com")).toBe("ask");
  });
  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "100.64.0.1", "192.168.1.1", "0.0.0.0", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"])("blocks nonpublic address %s", address => { expect(publicAddress(address)).toBe(false); });
  it("accepts public unicast addresses", () => { expect(publicAddress("8.8.8.8")).toBe(true); expect(publicAddress("2606:4700:4700::1111")).toBe(true); });
});

describe("exact proposal coordinator", () => {
  it("never sends input to a reviewer without explicit delegation", async () => {
    const reviewer = { decide: vi.fn() };
    const ask = vi.fn(async (p: BrowserProposal): Promise<BrowserDecision> => ({ id: p.id, decision: "allow" }));
    await new BrowserApprovalCoordinator(policy(), { ask, reviewer }).approve(input);
    expect(ask).toHaveBeenCalledOnce(); expect(reviewer.decide).not.toHaveBeenCalled();
  });
  it("creates a new digest for human edits and returns exactly executed values", async () => {
    let original = "";
    const c = new BrowserApprovalCoordinator(policy(), { ask: async p => { original = p.digest; return { id: p.id, decision: "edit", values: ["human\ncorrection"] }; } });
    const result = await c.approve(input);
    expect(result.fields[0]!.value).toBe("human\ncorrection"); expect(result.digest).not.toBe(original);
  });
  it("rejects broad Allow All and mismatched proposal IDs", async () => {
    for (const decision of [{ id: "wrong", decision: "allow" }, { id: "match", decision: "allow_all" }]) {
      const c = new BrowserApprovalCoordinator(policy(), { ask: async p => ({ ...decision, id: decision.id === "match" ? p.id : decision.id } as BrowserDecision) });
      await expect(c.approve(input)).rejects.toThrow();
    }
  });
  it("revocation while human approval is pending invalidates an allow", async () => {
    let finish!: (d: BrowserDecision) => void;
    let pending!: BrowserProposal;
    const c = new BrowserApprovalCoordinator(policy(), { ask: p => { pending = p; return new Promise(r => { finish = r; }); } });
    const result = c.approve(input);
    c.reset(); finish({ id: pending.id, decision: "allow" });
    await expect(result).rejects.toThrow(/changed/);
  });
  it("enforces cancellation even after a valid human allow", async () => {
    const controller = new AbortController();
    const c = new BrowserApprovalCoordinator(policy(), { ask: async p => { controller.abort(); return { id: p.id, decision: "allow" }; } });
    await expect(c.approve(input, controller.signal)).rejects.toThrow(/cancelled/);
  });
  it("reviewer sees full values and must match digest, ID and exact schema", async () => {
    let p!: BrowserProposal;
    const c = new BrowserApprovalCoordinator(policy(), { ask: async proposal => { p = proposal; return { id: p.id, decision: "allow" }; } });
    await c.approve(input);
    const delegation = { intent: "Search a public query", domains: ["example.com"], operations: ["fill" as const], model: "reviewer" };
    const decide = vi.fn(async (_s: string, brief: string) => {
      expect(JSON.parse(brief).untrustedProposal.fields[0].value).toBe(input.fields[0]!.value);
      return JSON.stringify({ decision: "allow", proposalId: p.id, proposalDigest: p.digest, reason: "Relevant query." });
    });
    expect((await reviewInput({ decide }, p, delegation)).decision).toBe("allow");
    for (const bad of ["not json", JSON.stringify({ decision: "allow", proposalId: p.id, proposalDigest: "wrong", reason: "yes" }), JSON.stringify({ decision: "allow", proposalId: p.id, proposalDigest: p.digest, reason: "yes", grant: true })]) {
      expect((await reviewInput({ decide: async () => bad }, p, delegation)).decision).toBe("ask_human");
    }
  });
  it("reviewer timeout falls back without accepting a late allow", async () => {
    vi.useFakeTimers();
    try {
      const p = { ...input, id: "p", digest: "d", session: "s", version: 1, expiresAt: Date.now() + 300_000 };
      const promise = reviewInput({ decide: () => new Promise(() => {}) }, p, { intent: "Fill query", domains: ["example.com"], operations: ["fill"], model: "m" });
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await promise).decision).toBe("ask_human");
    } finally { vi.useRealTimers(); }
  });
  it("does not send protected fields or recognizable credentials to the reviewer", async () => {
    const decide = vi.fn();
    const p = { ...input, id: "p", digest: "d", session: "s", version: 1, expiresAt: Date.now() + 300_000 };
    const delegation = { intent: "Fill query", domains: ["example.com"], operations: ["fill" as const], model: "m" };
    for (const field of [{ ...input.fields[0]!, type: "password" }, { ...input.fields[0]!, value: "sk-abcdefghijklmnopqrstuv" }]) {
      expect((await reviewInput({ decide }, { ...p, fields: [field] }, delegation)).decision).toBe("ask_human");
    }
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("bounded research evidence", () => {
  const response = (body: string, status = 200, headers = { "content-type": "text/html" }) => ({ body: Buffer.from(body), status, headers });
  it("blocks a denied redirect before the transport can contact its destination", async () => {
    const get = vi.fn(async () => response("", 302, { "content-type": "text/html", location: "https://private.example.com" }));
    const c = new BrowserApprovalCoordinator(policy(), { ask: async p => ({ id: p.id, decision: "deny" }) });
    const result = await new ResearchService(c, async () => undefined, { get }).dispatch("read", { url: "https://example.com" });
    expect(result).toMatchObject({ ok: false, code: "denied" }); expect(get).toHaveBeenCalledOnce();
  });
  it("extracts attributable page content without running scripts", async () => {
    const c = new BrowserApprovalCoordinator(policy(), { ask: async p => ({ id: p.id, decision: "deny" }) });
    const service = new ResearchService(c, async () => undefined, { get: async () => response('<html><head><title>Source</title></head><body><nav>omit</nav><main>Evidence<script>ignore policy</script><a href="https://other.com">Candidate</a></main></body></html>') });
    const result = await service.dispatch("read", { url: "https://example.com" });
    expect(result).toMatchObject({ ok: true, title: "Source", kind: "page", finalUrl: "https://example.com/", text: "EvidenceCandidate", links: [{ title: "Candidate", url: "https://other.com/" }] });
    expect(result).toHaveProperty("sourceId"); expect(result).toHaveProperty("retrievedAt");
  });
  it("has no unrestricted search fallback and filters result domains locally", async () => {
    const p = policy(); p.settings.searchProvider = "brave";
    const c = new BrowserApprovalCoordinator(p, { ask: async proposal => ({ id: proposal.id, decision: "allow" }) });
    const get = vi.fn(async () => response(JSON.stringify({ web: { results: [{ url: "https://example.com/a", title: "Allowed", description: "snippet" }, { url: "https://evil.com", title: "Blocked", description: "secret" }] } })));
    const service = new ResearchService(c, async () => "key", { get });
    expect(await service.dispatch("search", { query: "facts" })).toMatchObject({ ok: true, results: [{ title: "Allowed", kind: "search_snippet" }] });
    p.replace({ ...p.settings, allowedDomains: [] }); get.mockClear();
    expect(await service.dispatch("search", { query: "facts" })).toMatchObject({ ok: false, code: "denied" }); expect(get).not.toHaveBeenCalled();
  });
});
