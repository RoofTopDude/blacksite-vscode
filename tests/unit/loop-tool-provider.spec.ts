import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopToolService } from "../../src/loops/loop-tool-provider.js";
import { LoopStore } from "../../src/loops/loop-store.js";
import type { LoopSupervisor } from "../../src/loops/loop-supervisor.js";
import type { Ticket } from "../../src/ticket-store.js";

function ticket(id: string): Ticket {
  return {
    id,
    title: `Ticket ${id}`,
    status: "backlog",
    statusSource: "manual",
    priority: "normal",
    complexity: "small",
    labels: [],
    acceptanceCriteria: ["verified"],
    territory: { files: [`src/${id}.ts`], areas: [] },
    references: [],
    runIds: [],
    blockedBy: [],
    blocks: [],
    relatedTo: [],
    assignee: "agent",
    origin: "user",
    events: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  } as Ticket;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-loop-tools-"));
  roots.push(root);
  const store = new LoopStore(root);
  store.ensureInitialized();
  const supervisor = { pause: vi.fn(), stop: vi.fn() } as unknown as LoopSupervisor;
  const changed = vi.fn();
  const service = new LoopToolService(store, supervisor, () => [ticket("A")], () => ["src/A.ts"], changed);
  return { store, supervisor, service, changed };
}

describe("LoopToolService", () => {
  it("creates an inert, inspectable draft with bounded recommendations", async () => {
    const { store, service, changed } = harness();
    const result = await service.dispatch("propose", {
      title: "Clear the ready queue",
      ticketIds: ["A"],
      maxTickets: 4,
      maxUsd: 2,
    }, { sessionId: "parent" });

    expect(result).toMatchObject({ ok: true, status: "draft", matchedTickets: ["A"], sessionId: "parent" });
    expect(store.read().loops[0]?.definition.status).toBe("draft");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("lists loops through control but refuses an agent-authored start", async () => {
    const { service } = harness();
    const proposal = await service.dispatch("propose", { title: "Queue", ticketIds: ["A"] }, { sessionId: "parent" });
    const loopId = String(proposal["loopId"]);

    expect(await service.dispatch("control", { action: "list" }, { sessionId: "parent" }))
      .toMatchObject({ ok: true, loops: [expect.objectContaining({ loopId, status: "draft" })] });
    expect(await service.dispatch("control", { action: "start", loopId }, { sessionId: "parent" }))
      .toMatchObject({ ok: false, error: "An agent cannot start a loop." });
  });

  it("can lower a ceiling but cannot widen one", async () => {
    const { service } = harness();
    const proposal = await service.dispatch("propose", {
      title: "Queue",
      ticketIds: ["A"],
      maxTickets: 4,
      maxUsd: 2,
    }, { sessionId: "parent" });
    const loopId = String(proposal["loopId"]);

    const result = await service.dispatch("control", {
      action: "lower_ceilings",
      loopId,
      maxTickets: 20,
      maxUsd: 1,
    }, { sessionId: "parent" });
    expect(result["ceilings"]).toMatchObject({ maxTickets: 4, maxUsd: 1 });
  });
});
