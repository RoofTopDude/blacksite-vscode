import { describe, expect, it, vi } from "vitest";
const environment = vi.hoisted(() => ({ config: new Map<string, unknown>(), changed: undefined as undefined | ((e: { affectsConfiguration: () => boolean }) => void) }));
vi.mock("vscode", () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => environment.config.get(key) ?? fallback,
      update: async (key: string, value: unknown) => { environment.config.set(key, value); environment.changed?.({ affectsConfiguration: () => true }); },
    }),
    onDidChangeConfiguration: (listener: typeof environment.changed) => { environment.changed = listener; return { dispose: () => {} }; },
  },
  window: { showWarningMessage: async () => "Deny" },
}));
import { ResearchHost } from "../../src/browser/research-host.js";
import { stripImagesForPersistence } from "../../src/agent-session.js";
import type { ResearchUiState } from "../../src/browser/approval-types.js";

function setup() {
  environment.config.clear();
  const secrets = new Map<string, string>();
  let state!: ResearchUiState;
  const host = new ResearchHost({ secrets: {
    get: async (key: string) => secrets.get(key),
    store: async (key: string, value: string) => { secrets.set(key, value); },
    delete: async (key: string) => { secrets.delete(key); },
  } } as any, "workspace", message => { state = (message as { state: ResearchUiState }).state; }, () => true, { decide: async () => "{}" });
  return { host, state: () => state };
}
describe("trusted browser host UI", () => {
  it("file edits cannot widen grants, remove a deny, or restore revoked permission", async () => {
    const { host, state } = setup();
    try {
      await host.handle({ type: "research_save", policy: { allowedDomains: ["example.com"], deniedDomains: ["private.example.com"], unknownDomainPolicy: "ask", searchProvider: "brave" } });
      expect(host.policy.status("https://example.com")).toBe("allow");
      environment.config.set("research.allowedDomains", ["example.com", "evil.com"]);
      environment.config.set("research.deniedDomains", []);
      environment.changed?.({ affectsConfiguration: () => true });
      await host.handle({ type: "research_get" });
      expect(host.policy.status("https://evil.com")).toBe("ask");
      expect(host.policy.status("https://private.example.com")).toBe("deny");
      environment.config.set("research.allowedDomains", []);
      environment.changed?.({ affectsConfiguration: () => true });
      await host.handle({ type: "research_get" });
      environment.config.set("research.allowedDomains", ["example.com"]);
      environment.changed?.({ affectsConfiguration: () => true });
      await host.handle({ type: "research_get" });
      expect(state().policy.allowedDomains).toEqual([]);
    } finally { host.dispose(); }
  });
  it("keeps proposals transient and rejects duplicate and stale UI replies", async () => {
    const { host, state } = setup();
    try {
      await host.handle({ type: "research_get" });
      const promise = host.coordinator.approve({ kind: "input", operation: "search", origin: "https://example.com", url: "https://example.com?q=secret", title: "Search", document: "doc", purpose: "Search", fields: [{ target: "q", label: "query", type: "text", mode: "replace", value: "exact secret" }] });
      await vi.waitFor(() => expect(state().pending).toHaveLength(1));
      const id = state().pending[0]!.id;
      expect(state().pending[0]!.url).not.toContain("q=secret");
      await host.handle({ type: "browser_decision", decision: { id, decision: "allow" } });
      expect((await promise).fields[0]!.value).toBe("exact secret");
      await host.handle({ type: "browser_decision", decision: { id, decision: "allow" } });
      expect(state().pending).toHaveLength(0);
      expect(state().audits).toHaveLength(1);
      expect(JSON.stringify(state().audits)).not.toContain("exact secret");
    } finally { host.dispose(); }
  });
  it("redacts browser inputs and results in persisted transcripts without mutating executor history", () => {
    const messages: any = [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "browser_type", input: { selector: "#q", text: "secret value" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: '{"executedValues":["secret value"]}' }] }];
    expect(JSON.stringify(stripImagesForPersistence(messages))).not.toContain("secret value");
    expect(messages[0].content[0].input.text).toBe("secret value");
  });
});
