import { describe, expect, it, vi } from "vitest";
import { BrowserApprovalCoordinator } from "../../src/browser/approval-coordinator.js";
import { DomainPolicy, readPolicy } from "../../src/browser/domain-policy.js";
import { redactBrowserPayload } from "../../src/browser/privacy.js";
import { ResearchService } from "../../src/browser/research-service.js";

const environment = vi.hoisted(() => ({ config: new Map<string, unknown>(), changed: undefined as undefined | ((e: { affectsConfiguration: () => boolean }) => void) }));
vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  workspace: {
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => environment.config.get(key) ?? fallback, update: async (key: string, value: unknown) => { environment.config.set(key, value); } }),
    onDidChangeConfiguration: (listener: typeof environment.changed) => { environment.changed = listener; return { dispose: () => {} }; },
  },
  window: { showWarningMessage: async () => "Deny" },
}));
import { ResearchHost } from "../../src/browser/research-host.js";

type Posted = { error?: string };
const makeHost = (secrets: Map<string, string>, posted: Posted[] = []) => new ResearchHost({ secrets: {
  get: async (key: string) => secrets.get(key),
  store: async (key: string, value: string) => { secrets.set(key, value); },
  delete: async (key: string) => { secrets.delete(key); },
} } as never, "workspace", (message) => { posted.push((message as { state: Posted }).state); }, () => true, { decide: async () => "{}" }, undefined, undefined);

describe("reading a saved research policy", () => {
  it("drops what it cannot use and says so, instead of rejecting the whole policy", () => {
    const { policy, notes } = readPolicy({ allowedDomains: ["example.com", "not a host", "10.0.0.1"], deniedDomains: "oops", unknownDomainPolicy: "banana", searchProvider: "futureprovider", searchScope: "everywhere" });
    expect(policy).toEqual({ allowedDomains: ["example.com"], deniedDomains: [], unknownDomainPolicy: "ask", searchProvider: "none", searchScope: "approved" });
    expect(notes.join(" ")).toMatch(/not a host/);
    expect(notes.join(" ")).toMatch(/futureprovider/);
    expect(notes.join(" ")).toMatch(/search is limited to approved sites/);
  });

  it("only ever narrows: an explicit deny stays deny, and a missing policy is the default", () => {
    expect(readPolicy({ unknownDomainPolicy: "deny" }).policy.unknownDomainPolicy).toBe("deny");
    expect(readPolicy(undefined).policy).toEqual({ allowedDomains: [], deniedDomains: [], unknownDomainPolicy: "ask", searchProvider: "none", searchScope: "any" });
    expect(readPolicy(null).notes).toEqual([]);
  });
});

describe("the research host when its inputs are not what it expects", () => {
  it("keeps research working when settings name a search provider this build does not know", async () => {
    environment.config.clear();
    environment.config.set("research.searchProvider", "somethingnew");
    const posted: Posted[] = [];
    const host = makeHost(new Map(), posted);
    await host.dispatch("read", { url: "https://x.example/" }).catch(() => undefined);
    await host.send();
    // The old behavior: every unknown site denied at once, with nothing on screen to say why.
    expect(host.policy.settings.unknownDomainPolicy).toBe("ask");
    expect(host.policy.settings.searchProvider).toBe("none");
    expect(posted.at(-1)?.error).toMatch(/somethingnew/);
    host.dispose();
  });

  it("keeps research working when the saved confirmation is unreadable, and tells the user", async () => {
    environment.config.clear();
    const secrets = new Map<string, string>();
    const first = makeHost(secrets);
    await first.dispatch("read", { url: "https://x.example/" }).catch(() => undefined);
    const [key] = [...secrets.keys()];
    secrets.set(key!, "{not json");
    first.dispose();
    const posted: Posted[] = [];
    const second = makeHost(secrets, posted);
    await second.dispatch("read", { url: "https://x.example/" }).catch(() => undefined);
    await second.send();
    expect(second.policy.settings.unknownDomainPolicy).toBe("ask");
    expect(posted.at(-1)?.error).toMatch(/could not be read/);
    second.dispose();
  });

  it("shuts research off loudly, with the reason, when loading fails for a reason nobody anticipated", async () => {
    environment.config.clear();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const posted: Posted[] = [];
    const host = new ResearchHost({ secrets: { get: async () => { throw new Error("secret storage is locked"); }, store: async () => undefined, delete: async () => undefined } } as never, "workspace", (m) => { posted.push((m as { state: Posted }).state); }, () => true, { decide: async () => "{}" }, undefined, undefined);
    const result = await host.dispatch("request_access", { urls: ["https://docs.example.org/"], purpose: "x" }) as { ok: boolean; error: string };
    await host.send();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not be loaded \(secret storage is locked\)/);
    expect(result.error).toMatch(/do not retry other hosts/);
    expect(posted.at(-1)?.error).toBe("secret storage is locked");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
    host.dispose();
  });
});

describe("what a denied request tells the agent", () => {
  const service = (settings: Partial<ConstructorParameters<typeof DomainPolicy>[0]>) => {
    const policy = new DomainPolicy({ allowedDomains: [], deniedDomains: [], unknownDomainPolicy: "ask", searchProvider: "none", ...settings });
    return new ResearchService(new BrowserApprovalCoordinator(policy, { ask: async (p) => ({ id: p.id, decision: "session" }) }), async () => undefined);
  };

  it("names the hosts a deny rule matches, and only those", async () => {
    const result = await service({ deniedDomains: ["bad.com"] }).dispatch("request_access", { urls: ["https://bad.com/a", "https://ok.org/b"], purpose: "x" }) as { error: string };
    expect(result.error).toBe("Research access denied for bad.com. Retry without this host.");
  });

  it("does not blame the sites when unknown sites are simply denied", async () => {
    const result = await service({ unknownDomainPolicy: "deny" }).dispatch("request_access", { urls: ["https://a.com/", "https://b.com/"], purpose: "x" }) as { code: string; error: string };
    expect(result.code).toBe("denied");
    expect(result.error).toMatch(/unknownDomainPolicy is "deny"/);
    expect(result.error).toMatch(/do not retry other hosts/);
    expect(result.error).not.toMatch(/Retry without/);
  });

  it("explains the ten-URL limit with the count it received", async () => {
    const urls = Array.from({ length: 17 }, (_, i) => `https://s${i}.com/`);
    const result = await service({}).dispatch("request_access", { urls, purpose: "x" }) as { error: string };
    expect(result.error).toBe("Request between 1 and 10 URLs per call; this call had 17. Ask for the most useful sources first, in batches of at most ten.");
  });
});

describe("what the execution log keeps of a research failure", () => {
  it("keeps the reason for research tools, with query strings removed", () => {
    const kept = redactBrowserPayload({ ok: false, code: "denied", error: "Research access denied for a.com. See https://a.com/p?token=secret&x=1 for more." }, { keepErrors: true }) as { error: string };
    expect(kept.error).toContain("Research access denied for a.com.");
    expect(kept.error).not.toContain("secret");
    expect(kept.error).toContain("token=%5Bredacted%5D");
  });

  it("still hides the failure text of browser input tools", () => {
    expect(redactBrowserPayload({ ok: false, error: "could not type the value into #pw" })).toEqual({ ok: false, error: "[Browser failure details omitted from transcript; inspect the result code and current state.]" });
  });
});
