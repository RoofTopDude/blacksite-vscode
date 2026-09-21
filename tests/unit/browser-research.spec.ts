import { describe, expect, it, vi } from "vitest";
import { baseDomain, DomainPolicy, normalizeDomain, researchUrl } from "../../src/browser/domain-policy.js";
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
    for (const field of [{ ...input.fields[0]!, type: "password" }, { ...input.fields[0]!, value: "sk-" + "a".repeat(24) }]) {
      expect((await reviewInput({ decide }, { ...p, fields: [field] }, delegation)).decision).toBe("ask_human");
    }
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("one decision per request", () => {
  const response = (body: string, status = 200, headers = { "content-type": "text/html" }) => ({ body: Buffer.from(body), status, headers });
  const openPolicy = () => new DomainPolicy({ allowedDomains: [], deniedDomains: ["private.example.com"], unknownDomainPolicy: "ask", searchProvider: "none" });

  it("authorizes a batch of URLs with a single card that lists every new host", async () => {
    const asked: BrowserProposal[] = [];
    const p = openPolicy();
    const c = new BrowserApprovalCoordinator(p, { ask: async proposal => { asked.push(proposal); return { id: proposal.id, decision: "session" }; } });
    const service = new ResearchService(c, async () => undefined, { get: async () => response("") });
    const urls = ["https://a.com/one", "https://a.com/two", "https://b.com/x", "https://c.com/y"];
    expect(await service.dispatch("request_access", { urls, purpose: "Compare three sources" })).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.urls).toEqual(urls);
    expect(asked[0]!.title).toBe("3 domains");
    for (const url of urls) expect(p.status(url)).toBe("allow");
  });

  it("drops already-approved URLs from the card and asks for nothing when all are covered", async () => {
    const ask = vi.fn(async (proposal: BrowserProposal): Promise<BrowserDecision> => ({ id: proposal.id, decision: "session" }));
    const c = new BrowserApprovalCoordinator(policy(), { ask });
    const service = new ResearchService(c, async () => undefined, { get: async () => response("") });
    await service.dispatch("request_access", { urls: ["https://example.com/a", "https://new.org/b"], purpose: "Mixed" });
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0]![0].urls).toEqual(["https://new.org/b"]);
    ask.mockClear();
    expect(await service.dispatch("request_access", { urls: ["https://example.com/a"], purpose: "Already covered" })).toMatchObject({ ok: true });
    expect(ask).not.toHaveBeenCalled();
  });

  it("names every denied host at once instead of failing one URL at a time", async () => {
    const p = new DomainPolicy({ allowedDomains: [], deniedDomains: ["bad.com", "worse.com"], unknownDomainPolicy: "ask", searchProvider: "none" });
    const ask = vi.fn(async (proposal: BrowserProposal): Promise<BrowserDecision> => ({ id: proposal.id, decision: "session" }));
    const service = new ResearchService(new BrowserApprovalCoordinator(p, { ask }), async () => undefined, { get: async () => response("") });
    const result = await service.dispatch("request_access", { urls: ["https://ok.com/a", "https://bad.com/b", "https://worse.com/c"], purpose: "Mixed" }) as { code: string; error: string };
    expect(result.code).toBe("denied");
    expect(result.error).toContain("bad.com, worse.com");
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks once for a first read of an unapproved host that carries a query", async () => {
    const asked: BrowserProposal[] = [];
    const c = new BrowserApprovalCoordinator(openPolicy(), { ask: async proposal => { asked.push(proposal); return { id: proposal.id, decision: "session" }; } });
    const get = vi.fn(async () => response("<html><body><main>Evidence</main></body></html>"));
    const service = new ResearchService(c, async () => undefined, { get });
    expect(await service.dispatch("read", { url: "https://docs.org/search?q=widgets&lang=en" })).toMatchObject({ ok: true, text: "Evidence" });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.kind).toBe("domain");
    expect(asked[0]!.fields.map(f => [f.label, f.value])).toEqual([["q", "widgets"], ["lang", "en"]]);
    expect(get.mock.calls[0]![0].href).toBe("https://docs.org/search?q=widgets&lang=en");
  });

  it("still reviews the exact query on a host policy already allows", async () => {
    const asked: BrowserProposal[] = [];
    const c = new BrowserApprovalCoordinator(policy(), { ask: async proposal => { asked.push(proposal); return { id: proposal.id, decision: "allow" }; } });
    const service = new ResearchService(c, async () => undefined, { get: async () => response("<html><body><main>Evidence</main></body></html>") });
    expect(await service.dispatch("read", { url: "https://example.com/s?q=widgets" })).toMatchObject({ ok: true });
    expect(asked.map(a => a.kind)).toEqual(["input"]);
  });

  it("sends the human's corrected query, not the proposed one, from a merged card", async () => {
    const c = new BrowserApprovalCoordinator(openPolicy(), { ask: async proposal => ({ id: proposal.id, decision: "session", values: ["corrected"] }) });
    const get = vi.fn(async () => response("<html><body><main>Evidence</main></body></html>"));
    await new ResearchService(c, async () => undefined, { get }).dispatch("read", { url: "https://docs.org/search?q=widgets" });
    expect(get).toHaveBeenCalledOnce();
    expect(get.mock.calls[0]![0].href).toBe("https://docs.org/search?q=corrected");
  });

  it("refuses values that do not match the fields on the card that was shown", async () => {
    const c = new BrowserApprovalCoordinator(openPolicy(), { ask: async proposal => ({ id: proposal.id, decision: "session", values: ["a", "b"] }) });
    const get = vi.fn(async () => response(""));
    const result = await new ResearchService(c, async () => undefined, { get }).dispatch("read", { url: "https://docs.org/search?q=widgets" });
    expect(result).toMatchObject({ ok: false, code: "denied" });
    expect(get).not.toHaveBeenCalled();
  });

  it("persists every host of a batch in one attested write", async () => {
    const persistDomains = vi.fn(async () => {});
    const c = new BrowserApprovalCoordinator(openPolicy(), { ask: async proposal => ({ id: proposal.id, decision: "workspace" }), persistDomains });
    const service = new ResearchService(c, async () => undefined, { get: async () => response("") });
    await service.dispatch("request_access", { urls: ["https://a.com/1", "https://a.com/2", "https://b.com/3"], purpose: "Two hosts" });
    expect(persistDomains).toHaveBeenCalledOnce();
    expect(persistDomains).toHaveBeenCalledWith(["a.com", "b.com"], "workspace");
  });

  it("carries the calling tool onto the proposal so the approval can be shown on that call", async () => {
    const asked: BrowserProposal[] = [];
    const c = new BrowserApprovalCoordinator(openPolicy(), { ask: async proposal => { asked.push(proposal); return { id: proposal.id, decision: "deny" }; } });
    const service = new ResearchService(c, async () => undefined, { get: async () => response("") });
    await service.dispatch("request_access", { urls: ["https://a.com/1"], purpose: "Anchored" }, undefined, { toolCallId: "call-7", toolName: "web_request_access" });
    expect(asked[0]!.anchor).toEqual({ toolCallId: "call-7", toolName: "web_request_access" });
  });
});

describe("approval is per registrable domain", () => {
  const response = (body: string, status = 200, headers = { "content-type": "text/html" }) => ({ body: Buffer.from(body), status, headers });
  const open = () => new DomainPolicy({ allowedDomains: [], deniedDomains: [], unknownDomainPolicy: "ask", searchProvider: "none" });

  it("resolves the domain a human means, keeping shared-hosting tenants apart", () => {
    expect(baseDomain("en.wikipedia.org")).toBe("wikipedia.org");
    expect(baseDomain("de.m.wikipedia.org")).toBe("wikipedia.org");
    expect(baseDomain("docs.example.co.uk")).toBe("example.co.uk");
    // Private suffixes: one tenant of a shared host must never speak for another.
    expect(baseDomain("alice.github.io")).toBe("alice.github.io");
    expect(baseDomain("foo.vercel.app")).toBe("foo.vercel.app");
  });

  it("covers every page and subdomain of the site once the session grant is made", () => {
    const p = open();
    p.grant("https://en.wikipedia.org/wiki/Ada_Lovelace", "session");
    for (const url of ["https://en.wikipedia.org/wiki/Other", "https://de.wikipedia.org/wiki/Etwas", "https://wikipedia.org/", "https://en.m.wikipedia.org/wiki/X"]) {
      expect(p.status(url)).toBe("allow");
    }
    expect(p.status("https://wikimedia.org/")).toBe("ask");
  });

  it("does not let one shared-hosting tenant approve another", () => {
    const p = open();
    p.grant("https://alice.github.io/docs", "session");
    expect(p.status("https://alice.github.io/other")).toBe("allow");
    expect(p.status("https://bob.github.io/docs")).toBe("ask");
    // The bare shared suffix is not a nameable destination at all, let alone a grantable one.
    expect(() => p.status("https://github.io/")).toThrow();
    expect(() => p.grant("https://github.io/", "session")).toThrow();
  });

  it("keeps a settings block winning over a site-wide grant", () => {
    const p = new DomainPolicy({ allowedDomains: [], deniedDomains: ["fr.wikipedia.org"], unknownDomainPolicy: "ask", searchProvider: "none" });
    p.grant("https://en.wikipedia.org/wiki/X", "session");
    expect(p.status("https://de.wikipedia.org/wiki/X")).toBe("allow");
    expect(p.status("https://fr.wikipedia.org/wiki/X")).toBe("deny");
  });

  it("keeps the one-shot grant exact, but carries it across the publisher's own redirect", () => {
    const p = open();
    p.grant("https://wikipedia.org/wiki/X", "page");
    expect(p.status("https://wikipedia.org/wiki/Y")).toBe("ask");
    expect(p.consumePage("https://wikipedia.org/wiki/X")).toBe(true);
    expect(p.consumePage("https://wikipedia.org/wiki/X")).toBe(false);
    p.followRedirect("https://wikipedia.org/wiki/X", "https://en.wikipedia.org/wiki/X");
    expect(p.status("https://en.wikipedia.org/wiki/X")).toBe("allow");
    // Off-site and denied hops get nothing.
    p.followRedirect("https://wikipedia.org/wiki/X", "https://tracker.example.com/x");
    expect(p.status("https://tracker.example.com/x")).toBe("ask");
  });

  it("reads a second page of an approved site without asking again", async () => {
    const ask = vi.fn(async (proposal: BrowserProposal): Promise<BrowserDecision> => ({ id: proposal.id, decision: "session" }));
    const service = new ResearchService(new BrowserApprovalCoordinator(open(), { ask }), async () => undefined, { get: async () => response("<html><body><main>Evidence</main></body></html>") });
    expect(await service.dispatch("read", { url: "https://en.wikipedia.org/wiki/Ada_Lovelace" })).toMatchObject({ ok: true });
    expect(await service.dispatch("read", { url: "https://de.wikipedia.org/wiki/Etwas" })).toMatchObject({ ok: true });
    expect(await service.dispatch("read", { url: "https://wikipedia.org/" })).toMatchObject({ ok: true });
    expect(ask).toHaveBeenCalledOnce();
  });

  it("follows a one-shot read through a same-site redirect on a single approval", async () => {
    const ask = vi.fn(async (proposal: BrowserProposal): Promise<BrowserDecision> => ({ id: proposal.id, decision: "page" }));
    const get = vi.fn()
      .mockResolvedValueOnce(response("", 301, { "content-type": "text/html", location: "https://en.wikipedia.org/wiki/X" }))
      .mockResolvedValueOnce(response("<html><body><main>Evidence</main></body></html>"));
    const service = new ResearchService(new BrowserApprovalCoordinator(open(), { ask }), async () => undefined, { get });
    expect(await service.dispatch("read", { url: "https://wikipedia.org/wiki/X" })).toMatchObject({ ok: true, text: "Evidence" });
    expect(ask).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("collapses a batch of same-site URLs into one domain on the card", async () => {
    const asked: BrowserProposal[] = [];
    const c = new BrowserApprovalCoordinator(open(), { ask: async proposal => { asked.push(proposal); return { id: proposal.id, decision: "session" }; } });
    const service = new ResearchService(c, async () => undefined, { get: async () => response("") });
    await service.dispatch("request_access", { urls: ["https://en.wikipedia.org/wiki/A", "https://de.wikipedia.org/wiki/B", "https://commons.wikimedia.org/wiki/C"], purpose: "Three articles" });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.domains).toEqual(["wikipedia.org", "wikimedia.org"]);
    expect(asked[0]!.title).toBe("2 domains");
  });

  it("persists the registrable domain, not the subdomain that happened to be read first", async () => {
    const persistDomains = vi.fn(async () => {});
    const c = new BrowserApprovalCoordinator(open(), { ask: async proposal => ({ id: proposal.id, decision: "global" }), persistDomains });
    await new ResearchService(c, async () => undefined, { get: async () => response("") }).dispatch("request_access", { urls: ["https://en.wikipedia.org/wiki/A"], purpose: "One article" });
    expect(persistDomains).toHaveBeenCalledWith(["wikipedia.org"], "global");
  });

  it("restricts a search to the approved site, not the one subdomain that was read", async () => {
    const p = open(); p.settings.searchProvider = "brave";
    p.grant("https://en.wikipedia.org/wiki/X", "session");
    let sent = "";
    const c = new BrowserApprovalCoordinator(p, { ask: async proposal => { sent = String(proposal.fields[0]!.value); return { id: proposal.id, decision: "allow" }; } });
    const get = vi.fn(async () => response(JSON.stringify({ web: { results: [] } })));
    await new ResearchService(c, async () => "key", { get }).dispatch("search", { query: "ada lovelace" });
    expect(sent).toContain("site:wikipedia.org");
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
