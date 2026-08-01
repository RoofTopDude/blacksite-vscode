/* A tool the model is never told about is a tool that does not exist. The ticket family
   shipped defined in ALL_TOOLS, dispatchable in AgentSession, toggleable in settings, and
   summarized in the workspace-state block every turn — but _getTools() never pushed it, so
   the agent could read the queue and had no way to touch it. Nothing structural connects
   the catalog to the advertisement list, so assert the correspondence here instead of
   relying on whoever adds the next family remembering both places. */

import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/agent-session.js";
import { loadCheckpoint } from "../../src/checkpoint.js";
import { ALL_TOOLS, LOOP_TOOLS, TICKET_TOOLS } from "../../src/tools/definitions.js";

function createFakeContext() {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: <T>(key: string, defaultValue?: T): T | undefined => (store.has(key) ? (store.get(key) as T) : defaultValue),
      update: async (key: string, value: unknown): Promise<void> => { if (value === undefined) store.delete(key); else store.set(key, value); },
    },
  } as Parameters<typeof loadCheckpoint>[0];
}

type Opts = ConstructorParameters<typeof AgentSession>[0];

function createSession(overrides: Partial<Opts> = {}) {
  return new AgentSession({
    apiKey: "test-key",
    model: "claude-sonnet-4-6",
    systemPrompt: "Test system prompt",
    workspaceRoot: "C:/workspace",
    runtime: { handleMessage: vi.fn(async () => ({ result: { ok: true } })) } as unknown as Opts["runtime"],
    context: createFakeContext(),
    provider: "anthropic",
    checkpointingEnabled: false,
    ...overrides,
  });
}

/** _getTools is the private source of truth for what every provider path sends. */
function advertisedNames(session: AgentSession): string[] {
  return (session as unknown as { _getTools(): Array<{ name: string }> })._getTools().map((tool) => tool.name);
}

/** Every provider-gated family wired on at once, so the advertised set should be the
 *  whole catalog. Truthiness is all _getTools checks, except the two capability probes. */
function fullyWiredOverrides(): Partial<Opts> {
  const stub = <T>() => ({}) as T;
  return {
    lspProvider: stub(),
    diagnosticsProvider: stub(),
    planningProvider: stub(),
    ticketProvider: stub(),
    memoryProvider: { append: () => undefined, readMemory: () => "", readContext: () => "" },
    agentMemoryIndex: stub(),
    graphProvider: stub(),
    subagentProvider: { spawn: vi.fn(), followUp: vi.fn() } as unknown as Opts["subagentProvider"],
    transcriptProvider: stub(),
    transcriptDocumentProvider: stub(),
    referenceProvider: stub(),
    dataProvider: stub(),
    sequenceProvider: stub(),
    loopProvider: stub(),
    browserRunner: { available: () => true } as unknown as Opts["browserRunner"],
    editProvider: stub(),
    // undefined configuredServices means "no credential info" ⇒ advertise every integration.
    configuredServices: undefined,
  };
}

describe("AgentSession tool advertisement", () => {
  it("advertises every tool in the catalog when all providers are wired", () => {
    const advertised = new Set(advertisedNames(createSession(fullyWiredOverrides())));
    const missing = ALL_TOOLS.map((tool) => tool.name).filter((name) => !advertised.has(name));
    expect(missing).toEqual([]);
  });

  it("advertises the ticket family when a ticket provider backs it", () => {
    const advertised = advertisedNames(createSession({ ticketProvider: {} as Opts["ticketProvider"] }));
    for (const tool of TICKET_TOOLS) expect(advertised).toContain(tool.name);
  });

  it("withholds the ticket family when no ticket provider is available", () => {
    const advertised = advertisedNames(createSession());
    for (const tool of TICKET_TOOLS) expect(advertised).not.toContain(tool.name);
  });

  it("still honours the user's disabled-tool toggles for ticket tools", () => {
    const advertised = advertisedNames(createSession({
      ticketProvider: {} as Opts["ticketProvider"],
      disabledTools: ["ticket_sweep"],
    }));
    expect(advertised).toContain("ticket_file");
    expect(advertised).not.toContain("ticket_sweep");
  });

  it("advertises supervised loop controls only when the parent host wires them", () => {
    const parent = advertisedNames(createSession({ loopProvider: {} as Opts["loopProvider"] }));
    const delegated = advertisedNames(createSession());
    for (const tool of LOOP_TOOLS) {
      expect(parent).toContain(tool.name);
      expect(delegated).not.toContain(tool.name);
    }
  });
});
