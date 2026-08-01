import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  TicketStore,
  isOpenStatus,
  normalizeLabel,
  normalizeTicketDocument,
  normalizeTicketPriority,
  normalizeTicketStatus,
  rankTickets,
  reconcileTicket,
  createTerritoryResolver,
  resolveTerritory,
  summarizeTicketsForPrompt,
  ticketsTouchingFiles,
  type LinkedPlanState,
  type Ticket,
} from "../../src/ticket-store.js";
import { TICKET_TOOLS, resolveToolDispatch } from "../../src/tools/definitions.js";

const AGENT = { sessionId: "s1" };
const USER = { sessionId: "webview" };

let root: string;
let store: TicketStore;
let plans: LinkedPlanState[];
let agentMayClose: boolean;
let indexed: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-ticket-"));
  plans = [];
  agentMayClose = false;
  indexed = [];
  store = new TicketStore(root, () => plans, () => agentMayClose, () => indexed);
  store.ensureInitialized();
});

afterEach(() => {
  store.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

function file(payload: Record<string, unknown> = {}, ctx = AGENT) {
  return store.fileTicket({ title: "A ticket", ...payload }, ctx) as { ok: boolean; ticketId: string; error?: string };
}

function get(id: string): Ticket {
  const found = store.read().tickets.find((ticket) => ticket.id === id);
  if (!found) throw new Error(`no ticket ${id}`);
  return found;
}

describe("status and priority normalizers", () => {
  it("accepts the synonym families a model actually reaches for", () => {
    expect(normalizeTicketStatus("wip")).toBe("in_progress");
    expect(normalizeTicketStatus("in progress")).toBe("in_progress");
    expect(normalizeTicketStatus("won't fix")).toBe(null); // apostrophe is not a separator
    expect(normalizeTicketStatus("wont_fix")).toBe("cancelled");
    expect(normalizeTicketStatus("closed")).toBe("done");
    expect(normalizeTicketStatus("needs review")).toBe("review");
    expect(normalizeTicketStatus("nonsense")).toBe(null);
  });

  it("maps priority aliases including ticket-tracker shorthand", () => {
    expect(normalizeTicketPriority("P0")).toBe("urgent");
    expect(normalizeTicketPriority("critical")).toBe("urgent");
    expect(normalizeTicketPriority("medium")).toBe("normal");
    expect(normalizeTicketPriority("nice to have")).toBe("low");
  });

  it("classifies which statuses count as open", () => {
    expect(isOpenStatus("triage")).toBe(true);
    expect(isOpenStatus("review")).toBe(true);
    expect(isOpenStatus("done")).toBe(false);
    expect(isOpenStatus("cancelled")).toBe(false);
  });
});

describe("labels", () => {
  it("normalizes to one shape so near-duplicates cannot coexist", () => {
    expect(normalizeLabel("Auth Service")).toBe("auth-service");
    expect(normalizeLabel("  AUTH  ")).toBe("auth");
    expect(normalizeLabel("auth!!!")).toBe("auth");
  });

  it("dedupes after normalizing and caps the count", () => {
    const { ticketId } = file({ labels: ["Auth", "auth", "AUTH", ...Array.from({ length: 12 }, (_, i) => `l${i}`)] });
    const ticket = get(ticketId);
    expect(ticket.labels.filter((l) => l === "auth")).toHaveLength(1);
    expect(ticket.labels.length).toBeLessThanOrEqual(8);
  });
});

describe("filing", () => {
  it("requires only a title", () => {
    const res = file();
    expect(res.ok).toBe(true);
    expect(res.ticketId).toBe("BLK-1");
  });

  it("rejects a ticket with no title", () => {
    const res = store.fileTicket({ title: "   " }, AGENT) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
  });

  it("lands agent-filed tickets in triage and user-filed in backlog", () => {
    expect(get(file({}, AGENT).ticketId).status).toBe("triage");
    expect(get(file({}, USER).ticketId).status).toBe("backlog");
  });

  it("mints sequential ids that are never reused, including by closed tickets", () => {
    const first = file().ticketId;
    file();
    store.deleteTicket(first);
    expect(file().ticketId).toBe("BLK-3");
  });

  it("records provenance and a pinned created event", () => {
    const { ticketId } = file({ origin: "map_note", originRef: "note_7" });
    const ticket = get(ticketId);
    expect(ticket.origin).toBe("map_note");
    expect(ticket.originRef).toBe("note_7");
    expect(ticket.events[0]?.kind).toBe("created");
  });
});

describe("the contract: a ticket has no steps", () => {
  it("accepts no step-like field on file or update", () => {
    const { ticketId } = file({ steps: [{ title: "one" }], subtasks: ["a"], progress: 40 });
    const stored = get(ticketId) as unknown as Record<string, unknown>;
    for (const forbidden of ["steps", "subtasks", "progress", "checklist", "phases"]) {
      expect(stored[forbidden], `"${forbidden}" must never be storable on a ticket`).toBeUndefined();
    }
    store.updateTicket({ ticketId, steps: [{ title: "two" }], progress: 90 }, AGENT);
    const after = get(ticketId) as unknown as Record<string, unknown>;
    expect(after.steps).toBeUndefined();
    expect(after.progress).toBeUndefined();
  });
});

describe("status derivation from a linked plan", () => {
  function linked(planState: Partial<LinkedPlanState> = {}): string {
    const { ticketId } = file();
    plans = [{ id: "p1", status: "active", executionApproved: true, phases: [], ...planState }];
    store.updateTicket({ ticketId, planId: "p1" }, AGENT);
    return ticketId;
  }

  it("follows a plan whose phase is in progress", () => {
    const id = linked({ phases: [{ id: "ph1", status: "in_progress" }] });
    expect(get(id).status).toBe("in_progress");
  });

  it("reports blocked when a phase is blocked and none is in progress", () => {
    const id = linked({ phases: [{ id: "ph1", status: "blocked" }] });
    expect(get(id).status).toBe("blocked");
  });

  it("prefers in_progress over blocked when a plan has both", () => {
    const id = linked({ phases: [{ id: "a", status: "blocked" }, { id: "b", status: "in_progress" }] });
    expect(get(id).status).toBe("in_progress");
  });

  it("holds at backlog while the plan is unapproved for execution", () => {
    const id = linked({ executionApproved: false, phases: [{ id: "ph1", status: "in_progress" }] });
    expect(get(id).status).toBe("backlog");
  });

  it("reports blocked for a plan on hold", () => {
    const id = linked({ status: "on_hold", phases: [{ id: "ph1", status: "in_progress" }] });
    expect(get(id).status).toBe("blocked");
  });

  it("lands on review — never done — when every phase completes", () => {
    const id = linked({ phases: [{ id: "a", status: "completed" }, { id: "b", status: "completed" }] });
    expect(get(id).status).toBe("review");
  });

  it("never derives done, even for a completed plan", () => {
    const id = linked({ status: "completed", phases: [{ id: "a", status: "completed" }] });
    expect(get(id).status).not.toBe("done");
    expect(get(id).status).toBe("review");
  });

  it("clears the link and notes it when the plan disappears", () => {
    const id = linked({ phases: [{ id: "ph1", status: "in_progress" }] });
    plans = [];
    const ticket = get(id);
    expect(ticket.planId).toBeUndefined();
    expect(ticket.status).toBe("backlog");
    expect(ticket.events.some((e) => e.kind === "link" && /no longer exists/.test(e.body ?? ""))).toBe(true);
  });

  it("clears the link when the plan is cancelled outright", () => {
    const id = linked({ phases: [] });
    plans = [{ id: "p1", status: "cancelled", executionApproved: true, phases: [] }];
    expect(get(id).planId).toBeUndefined();
  });

  it("stops following the plan once a status is set by hand", () => {
    const id = linked({ phases: [{ id: "ph1", status: "in_progress" }] });
    expect(get(id).status).toBe("in_progress");
    store.updateTicket({ ticketId: id, status: "blocked" }, USER);
    expect(get(id).statusSource).toBe("manual");
    plans = [{ id: "p1", status: "active", executionApproved: true, phases: [{ id: "ph1", status: "completed" }] }];
    expect(get(id).status).toBe("blocked");
  });

  it("hands status back to the plan when the link is re-established", () => {
    const { ticketId } = file();
    store.updateTicket({ ticketId, status: "blocked" }, USER);
    plans = [{ id: "p1", status: "active", executionApproved: true, phases: [{ id: "ph1", status: "in_progress" }] }];
    store.updateTicket({ ticketId, planId: "p1" }, AGENT);
    expect(get(ticketId).statusSource).toBe("derived");
    expect(get(ticketId).status).toBe("in_progress");
  });

  it("is a no-op for a ticket with no plan", () => {
    const ticket = get(file().ticketId);
    expect(reconcileTicket(ticket, [])).toBe(false);
  });
});

/* Plan deletion is the lifecycle hazard the design flagged: clearCompleted and deletePlan
   remove a plan without knowing tickets point at it. Derivation-on-read is what makes that
   safe — the ticket store never trusts a stored link, it re-resolves one every read. */
describe("lifecycle safety when a plan disappears", () => {
  it("survives a plan being cleared out from under a linked ticket", () => {
    const { ticketId } = file();
    plans = [{ id: "p1", status: "active", executionApproved: true, phases: [{ id: "ph1", status: "in_progress" }] }];
    store.updateTicket({ ticketId, planId: "p1", phaseId: "ph1" }, AGENT);
    expect(get(ticketId).status).toBe("in_progress");

    plans = []; // clearCompleted / deletePlan
    const ticket = get(ticketId);
    expect(ticket.planId).toBeUndefined();
    expect(ticket.phaseId).toBeUndefined();
    expect(ticket.status).toBe("backlog");
    expect(ticket.title).toBe("A ticket");
  });

  it("leaves a closed ticket closed when its plan vanishes", () => {
    const { ticketId } = file({}, USER);
    plans = [{ id: "p1", status: "active", executionApproved: true, phases: [] }];
    store.updateTicket({ ticketId, planId: "p1" }, AGENT);
    store.updateTicket({ ticketId, status: "done" }, USER);
    plans = [];
    expect(get(ticketId).status).toBe("done");
  });
});

describe("the close gate", () => {
  it("refuses an agent closing a ticket by default, naming the setting", () => {
    const { ticketId } = file();
    const res = store.updateTicket({ ticketId, status: "done" }, AGENT) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("agentMayClose");
    expect(get(ticketId).status).not.toBe("done");
  });

  it("lets the agent move to review without permission", () => {
    const { ticketId } = file();
    expect((store.updateTicket({ ticketId, status: "review" }, AGENT) as { ok: boolean }).ok).toBe(true);
  });

  it("allows the user to close regardless of the setting", () => {
    const { ticketId } = file();
    expect((store.updateTicket({ ticketId, status: "done" }, USER) as { ok: boolean }).ok).toBe(true);
    expect(get(ticketId).closedAt).toBeTruthy();
  });

  it("permits the agent to close once the user enables it", () => {
    agentMayClose = true;
    const { ticketId } = file();
    expect((store.updateTicket({ ticketId, status: "done" }, AGENT) as { ok: boolean }).ok).toBe(true);
  });
});

describe("reopening", () => {
  it("clears closedAt and records a reopened event", () => {
    const { ticketId } = file();
    store.updateTicket({ ticketId, status: "done" }, USER);
    expect(get(ticketId).closedAt).toBeTruthy();
    store.updateTicket({ ticketId, status: "backlog" }, USER);
    const ticket = get(ticketId);
    expect(ticket.closedAt).toBeUndefined();
    expect(ticket.events.some((event) => event.kind === "reopened")).toBe(true);
  });
});

describe("links", () => {
  it("writes the reverse side of a related link", () => {
    const a = file({ title: "A" }).ticketId;
    const b = file({ title: "B" }).ticketId;
    store.updateTicket({ ticketId: a, relatedTo: [b] }, USER);
    expect(get(b).relatedTo).toContain(a);
  });

  it("removes the reverse side too", () => {
    const a = file({ title: "A" }).ticketId;
    const b = file({ title: "B" }).ticketId;
    store.updateTicket({ ticketId: a, relatedTo: [b] }, USER);
    store.updateTicket({ ticketId: a, relatedTo: [] }, USER);
    expect(get(b).relatedTo).not.toContain(a);
  });

  it("drops self-reference and unknown ids", () => {
    const a = file({ title: "A" }).ticketId;
    store.updateTicket({ ticketId: a, blockedBy: [a, "BLK-999"] }, USER);
    expect(get(a).blockedBy).toEqual([]);
  });

  it("rejects a direct two-cycle in blockedBy", () => {
    const a = file({ title: "A" }).ticketId;
    const b = file({ title: "B" }).ticketId;
    store.updateTicket({ ticketId: a, blockedBy: [b] }, USER);
    store.updateTicket({ ticketId: b, blockedBy: [a] }, USER);
    expect(get(b).blockedBy).toEqual([]);
    expect(get(a).blockedBy).toEqual([b]);
  });

  it("clears dangling links when a ticket is deleted", () => {
    const a = file({ title: "A" }).ticketId;
    const b = file({ title: "B" }).ticketId;
    store.updateTicket({ ticketId: a, blockedBy: [b] }, USER);
    store.deleteTicket(b);
    expect(get(a).blockedBy).not.toContain(b);
  });
});

describe("the activity timeline", () => {
  it("coalesces rapid same-kind system events into one, keeping the original from", () => {
    const { ticketId } = file();
    store.updateTicket({ ticketId, priority: "high" }, USER);
    store.updateTicket({ ticketId, priority: "urgent" }, USER);
    store.updateTicket({ ticketId, priority: "low" }, USER);
    const priorityEvents = get(ticketId).events.filter((event) => event.kind === "priority");
    expect(priorityEvents).toHaveLength(1);
    expect(priorityEvents[0]?.from).toBe("normal");
    expect(priorityEvents[0]?.to).toBe("low");
  });

  it("never coalesces comments", () => {
    const { ticketId } = file();
    store.commentOnTicket({ ticketId, body: "first" }, AGENT);
    store.commentOnTicket({ ticketId, body: "second" }, AGENT);
    expect(get(ticketId).events.filter((event) => event.kind === "comment")).toHaveLength(2);
  });

  it("requires a body on a comment", () => {
    const { ticketId } = file();
    expect((store.commentOnTicket({ ticketId, body: "  " }, AGENT) as { ok: boolean }).ok).toBe(false);
  });

  it("prunes system events before comments and never drops created", () => {
    const events = [
      { id: "created", at: "2020-01-01T00:00:00.000Z", actor: "agent", kind: "created" },
      ...Array.from({ length: 400 }, (_, i) => ({
        id: `sys${i}`, at: `2021-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        actor: "system", kind: "status", from: "a", to: "b",
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `c${i}`, at: "2022-01-01T00:00:00.000Z", actor: "agent", kind: "comment", body: `comment ${i}`,
      })),
    ];
    const { document } = normalizeTicketDocument({
      tickets: [{ id: "BLK-1", title: "T", status: "backlog", events }],
    });
    const kept = document.tickets[0]!.events;
    expect(kept.length).toBeLessThanOrEqual(200);
    expect(kept.filter((e) => e.kind === "comment")).toHaveLength(5);
    expect(kept.some((e) => e.kind === "created")).toBe(true);
  });
});

describe("territory", () => {
  it("normalizes the path dialect and dedupes", () => {
    const { ticketId } = file({ files: ["./src\\a.ts", "src/a.ts", "src/b.ts"] });
    expect(get(ticketId).territory.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("strips a trailing slash from an area", () => {
    const { ticketId } = file({ areas: ["src/graph/"] });
    expect(get(ticketId).territory.areas).toEqual(["src/graph"]);
  });

  it("resolves an area to its members without matching a sibling prefix", () => {
    const resolved = resolveTerritory(
      { files: [], areas: ["src/graph"] },
      ["src/graph/layout.ts", "src/graph/model.ts", "src/graphics/paint.ts"],
    );
    expect(resolved.files).toContain("src/graph/layout.ts");
    expect(resolved.files).not.toContain("src/graphics/paint.ts");
    expect(resolved.areas[0]).toMatchObject({ area: "src/graph", files: 2 });
  });

  it("flags a declared file missing from the index instead of dropping it", () => {
    const resolved = resolveTerritory({ files: ["src/gone.ts", "src/here.ts"], areas: [] }, ["src/here.ts"]);
    expect(resolved.staleFiles).toEqual(["src/gone.ts"]);
    expect(resolved.files).toEqual(["src/here.ts"]);
  });

  it("treats an empty index as unknown rather than declaring everything stale", () => {
    const resolved = resolveTerritory({ files: ["src/a.ts"], areas: [] }, []);
    expect(resolved.staleFiles).toEqual([]);
    expect(resolved.files).toEqual(["src/a.ts"]);
  });

  it("reports a count instead of a membership list for an over-broad area", () => {
    const many = Array.from({ length: 250 }, (_, i) => `src/f${i}.ts`);
    const resolved = resolveTerritory({ files: [], areas: ["src"] }, many);
    expect(resolved.areas[0]?.truncated).toBe(true);
    expect(resolved.areas[0]?.files).toBe(250);
    expect(resolved.files).toHaveLength(0);
  });
});

describe("createTerritoryResolver", () => {
  /* The batch resolver exists so a tickets refresh stops rebuilding the whole index once per
     ticket. It has to stay observably identical to the single-shot function it replaced —
     including the order of resolved.files, which the surfaces render directly. */
  const index = [
    "src/graph/layout.ts",
    "src/graph/model.ts",
    "src/graph/scene/renderer.ts",
    "src/graphics/paint.ts",
    "src/ticket-store.ts",
    "docs/guide.md",
  ];

  const territories = [
    { files: [], areas: ["src/graph"] },
    { files: ["src/ticket-store.ts"], areas: [] },
    { files: ["src/ticket-store.ts", "src/deleted.ts"], areas: ["docs"] },
    { files: [], areas: ["src/graph/scene"] },
    { files: [], areas: ["src/ticket-store.ts"] },
    { files: [], areas: ["nope"] },
    { files: [], areas: [] },
  ];

  it("matches resolveTerritory exactly, result for result", () => {
    const resolver = createTerritoryResolver(index);
    for (const territory of territories) {
      expect(resolver.resolve(territory)).toEqual(resolveTerritory(territory, index));
    }
  });

  it("matches on an empty index too", () => {
    const resolver = createTerritoryResolver([]);
    for (const territory of territories) {
      expect(resolver.resolve(territory)).toEqual(resolveTerritory(territory, []));
    }
  });

  it("returns the same answer when reused across many territories", () => {
    const resolver = createTerritoryResolver(index);
    const first = resolver.resolve(territories[0]!);
    for (const territory of territories) resolver.resolve(territory);
    expect(resolver.resolve(territories[0]!)).toEqual(first);
  });

  it("counts a nested area without double-counting its parent", () => {
    const resolver = createTerritoryResolver(index);
    expect(resolver.resolve({ files: [], areas: ["src/graph"] }).areas[0]).toMatchObject({ files: 3 });
    expect(resolver.resolve({ files: [], areas: ["src/graph/scene"] }).areas[0]).toMatchObject({ files: 1 });
  });
});

describe("ticketsTouchingFiles", () => {
  it("matches an open ticket by exact file and by containing area", () => {
    const byFile = file({ title: "file", files: ["src/a.ts"] }).ticketId;
    const byArea = file({ title: "area", areas: ["src/graph"] }).ticketId;
    file({ title: "unrelated", files: ["src/z.ts"] });
    const hits = ticketsTouchingFiles(store.read().tickets, ["src/a.ts", "src/graph/layout.ts"]);
    expect(hits.map((t) => t.id).sort()).toEqual([byArea, byFile].sort());
  });

  it("ignores closed tickets", () => {
    const { ticketId } = file({ files: ["src/a.ts"] }, USER);
    store.updateTicket({ ticketId, status: "done" }, USER);
    expect(ticketsTouchingFiles(store.read().tickets, ["src/a.ts"])).toHaveLength(0);
  });
});

describe("summarizeTicketsForPrompt", () => {
  it("is empty when nothing is open", () => {
    expect(summarizeTicketsForPrompt(root)).toBe("");
  });

  it("leads with tickets touching the open files, then queue posture", () => {
    file({ title: "Retry drifts", files: ["src/provider-retry.ts"], priority: "high" });
    file({ title: "Something else" });
    const summary = summarizeTicketsForPrompt(root, ["src/provider-retry.ts"]);
    expect(summary).toContain("Open tickets touching your current files:");
    expect(summary).toContain("Retry drifts");
    expect(summary).toContain("Queue: 2 open");
  });

  it("reports triage backlog awaiting review", () => {
    file();
    expect(summarizeTicketsForPrompt(root)).toContain("in triage awaiting your review");
  });

  it("respects the character budget", () => {
    for (let i = 0; i < 30; i += 1) file({ title: `Ticket number ${i} with a fairly long title`, files: ["src/a.ts"] });
    expect(summarizeTicketsForPrompt(root, ["src/a.ts"]).length).toBeLessThanOrEqual(800);
  });
});

describe("listing", () => {
  it("defaults to open tickets and reports the pre-limit count", () => {
    const { ticketId } = file({}, USER);
    store.updateTicket({ ticketId, status: "done" }, USER);
    file({ title: "still open" }, USER);
    const res = store.listTickets({}) as { matched: number; tickets: Array<{ id: string }> };
    expect(res.matched).toBe(1);
  });

  it("filters by area, matching files underneath it", () => {
    file({ title: "in graph", files: ["src/graph/layout.ts"] });
    file({ title: "elsewhere", files: ["src/chat.ts"] });
    const res = store.listTickets({ area: "src/graph" }) as { matched: number };
    expect(res.matched).toBe(1);
  });

  it("ranks by priority when asked", () => {
    file({ title: "low", priority: "low" });
    file({ title: "urgent", priority: "urgent" });
    const res = store.listTickets({ rankBy: "priority" }) as { tickets: Array<{ title: string }> };
    expect(res.tickets[0]?.title).toBe("urgent");
  });
});

describe("promotion", () => {
  it("returns a plan seed carrying the ticket's resolved territory", () => {
    indexed = ["src/a.ts", "src/graph/layout.ts"];
    const { ticketId } = file({ title: "Fix retry", description: "Body", files: ["src/a.ts"], areas: ["src/graph"] });
    const res = store.promoteTicket({ ticketId }) as { ok: boolean; seed: { title: string; firstPhaseFiles: string[] } };
    expect(res.ok).toBe(true);
    expect(res.seed.title).toBe("Fix retry");
    expect(res.seed.firstPhaseFiles).toContain("src/graph/layout.ts");
  });

  it("refuses to promote a ticket that already has a plan", () => {
    const { ticketId } = file();
    plans = [{ id: "p1", status: "active", executionApproved: true, phases: [] }];
    store.updateTicket({ ticketId, planId: "p1" }, AGENT);
    const res = store.promoteTicket({ ticketId }) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain("already linked");
  });
});

describe("ranking for what to pick up next", () => {
  it("puts urgent ahead of low and explains why", () => {
    file({ title: "low", priority: "low" });
    file({ title: "urgent", priority: "urgent" });
    const ranked = rankTickets(store.read().tickets);
    expect(ranked[0]?.ticket.title).toBe("urgent");
    expect(ranked[0]?.reasons).toContain("urgent priority");
  });

  it("ranks blocked tickets last but keeps them visible with their blockers", () => {
    const blocker = file({ title: "blocker" }).ticketId;
    const blocked = file({ title: "blocked one", priority: "urgent" }).ticketId;
    store.updateTicket({ ticketId: blocked, blockedBy: [blocker] }, USER);
    const ranked = rankTickets(store.read().tickets);
    expect(ranked[ranked.length - 1]?.ticket.id).toBe(blocked);
    expect(ranked[ranked.length - 1]?.blockedByOpen).toEqual([blocker]);
  });

  it("stops treating a ticket as blocked once its blocker closes", () => {
    const blocker = file({ title: "blocker" }, USER).ticketId;
    const blocked = file({ title: "blocked one" }, USER).ticketId;
    store.updateTicket({ ticketId: blocked, blockedBy: [blocker] }, USER);
    store.updateTicket({ ticketId: blocker, status: "done" }, USER);
    const entry = rankTickets(store.read().tickets).find((r) => r.ticket.id === blocked);
    expect(entry?.blockedByOpen).toEqual([]);
  });

  it("lets a long-untouched ticket rise without overtaking a fresh urgent one", () => {
    const stale = file({ title: "stale", priority: "normal" }).ticketId;
    file({ title: "fresh urgent", priority: "urgent" });
    const tickets = store.read().tickets.map((ticket) => (
      ticket.id === stale ? { ...ticket, updatedAt: "2020-01-01T00:00:00.000Z" } : ticket
    ));
    const ranked = rankTickets(tickets);
    expect(ranked[0]?.ticket.title).toBe("fresh urgent");
    expect(ranked.find((r) => r.ticket.id === stale)?.reasons.join()).toMatch(/untouched/);
  });

  it("distinguishes an empty queue from a fully blocked one", () => {
    const blocker = file({ title: "blocker" }).ticketId;
    const blocked = file({ title: "blocked" }).ticketId;
    store.updateTicket({ ticketId: blocked, blockedBy: [blocker] }, USER);
    store.updateTicket({ ticketId: blocker, status: "blocked" }, USER);
    const res = store.nextTickets({}) as { openCount: number; blockedCount: number };
    expect(res.openCount).toBe(2);
    expect(res.blockedCount).toBe(2);
  });

  it("restricts candidates to an area when asked", () => {
    file({ title: "in graph", files: ["src/graph/layout.ts"] });
    file({ title: "elsewhere", files: ["src/chat.ts"] });
    const res = store.nextTickets({ area: "src/graph" }) as { candidates: Array<{ title: string }> };
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]?.title).toBe("in graph");
  });

  it("excludes closed tickets from the ranking entirely", () => {
    const { ticketId } = file({}, USER);
    store.updateTicket({ ticketId, status: "done" }, USER);
    expect(rankTickets(store.read().tickets)).toHaveLength(0);
  });
});

describe("corruption tolerance", () => {
  it("salvages valid tickets and reports how many were dropped", () => {
    fs.writeFileSync(path.join(root, ".blacksite", "tickets.json"), JSON.stringify({
      schemaVersion: 1,
      tickets: [
        { id: "BLK-1", title: "Good", status: "backlog" },
        { id: "BLK-2" },
        "not an object",
        { id: "BLK-1", title: "Duplicate id", status: "backlog" },
      ],
    }), "utf8");
    const { document, dropped } = store.readWithDiagnostics();
    expect(document.tickets).toHaveLength(1);
    expect(dropped).toBe(3);
  });

  it("returns an empty document for unparseable json rather than throwing", () => {
    fs.writeFileSync(path.join(root, ".blacksite", "tickets.json"), "{not json", "utf8");
    expect(store.read().tickets).toEqual([]);
  });
});

describe("acceptance criteria", () => {
  it("keeps them as plain statements — deduplicated, trimmed, capped", () => {
    const { ticketId } = file({
      acceptanceCriteria: ["  Retry ceiling reads the gateway TTL  ", "Retry ceiling reads the gateway TTL", "", "Second"],
    });
    expect(get(ticketId).acceptanceCriteria).toEqual(["Retry ceiling reads the gateway TTL", "Second"]);
  });

  it("caps the list at 20 rather than rejecting the call", () => {
    const { ticketId } = file({ acceptanceCriteria: Array.from({ length: 40 }, (_, index) => `c${index}`) });
    expect(get(ticketId).acceptanceCriteria).toHaveLength(20);
  });

  it("records one timeline entry when the set changes, and none when it doesn't", () => {
    const { ticketId } = file({ acceptanceCriteria: ["one"] });
    store.updateTicket({ ticketId, acceptanceCriteria: ["one"] }, USER);
    expect(get(ticketId).events.filter((event) => event.kind === "criteria")).toHaveLength(0);
    store.updateTicket({ ticketId, acceptanceCriteria: ["one", "two"] }, USER);
    expect(get(ticketId).events.filter((event) => event.kind === "criteria")).toHaveLength(1);
  });

  it("carries them into the plan seed so the two can't state different bars", () => {
    const { ticketId } = file({ acceptanceCriteria: ["No new public API"] });
    const promoted = store.promoteTicket({ ticketId }) as { seed: { acceptanceCriteria: string[] } };
    expect(promoted.seed.acceptanceCriteria).toEqual(["No new public API"]);
  });
});

describe("references", () => {
  it("accepts http(s) urls and workspace paths", () => {
    const { ticketId } = file({
      references: [{ url: "https://example.com/issues/4", title: "Upstream" }, { url: "docs/spec.md" }],
    });
    expect(get(ticketId).references).toEqual([
      { url: "https://example.com/issues/4", title: "Upstream" },
      { url: "docs/spec.md" },
    ]);
  });

  it("drops schemes that must never reach a webview anchor", () => {
    const { ticketId } = file({
      references: [
        { url: "javascript:alert(1)" },
        { url: "data:text/html,<script>x</script>" },
        { url: "vscode://evil" },
        { url: "https://ok.example" },
      ],
    });
    expect(get(ticketId).references.map((reference) => reference.url)).toEqual(["https://ok.example"]);
  });

  it("de-duplicates by url", () => {
    const { ticketId } = file({ references: [{ url: "docs/a.md" }, { url: "docs/a.md", title: "again" }] });
    expect(get(ticketId).references).toHaveLength(1);
  });
});

describe("assignment", () => {
  it("normalizes the synonyms a model reaches for, defaulting to unassigned", () => {
    expect(get(file({ assignee: "me" }).ticketId).assignee).toBe("user");
    expect(get(file({ assignee: "AI" }).ticketId).assignee).toBe("agent");
    expect(get(file({}).ticketId).assignee).toBe("unassigned");
  });

  it("ranks work handed to the agent above work the user kept", () => {
    const mine = file({ title: "the agent's", assignee: "agent" }).ticketId;
    file({ title: "theirs", assignee: "user" });
    expect(rankTickets(store.read().tickets)[0]?.ticket.id).toBe(mine);
  });

  it("names agent-assigned tickets in the per-turn prompt block", () => {
    file({ title: "Fix the drift", assignee: "agent" });
    expect(summarizeTicketsForPrompt(root)).toContain("Assigned to you");
  });
});

describe("relation graph", () => {
  it("derives blocks as the exact inverse of blockedBy", () => {
    const first = file({ title: "first" }).ticketId;
    const second = file({ title: "second", blockedBy: [first] }).ticketId;
    expect(get(first).blocks).toEqual([second]);
    expect(get(second).blockedBy).toEqual([first]);
  });

  it("writes the other end when `blocks` is the direction that was learned", () => {
    const first = file({ title: "first" }).ticketId;
    const second = file({ title: "second" }).ticketId;
    store.updateTicket({ ticketId: first, blocks: [second] }, USER);
    expect(get(second).blockedBy).toEqual([first]);
    expect(get(first).blocks).toEqual([second]);
  });

  it("lets a blocks edge be removed from either end and stay removed", () => {
    const first = file({ title: "first" }).ticketId;
    const second = file({ title: "second", blockedBy: [first] }).ticketId;

    store.updateTicket({ ticketId: first, blocks: [] }, USER);
    expect(get(second).blockedBy).toEqual([]);
    expect(get(first).blocks).toEqual([]);

    store.updateTicket({ ticketId: second, blockedBy: [first] }, USER);
    store.updateTicket({ ticketId: second, blockedBy: [] }, USER);
    expect(get(first).blocks).toEqual([]);
  });

  it("keeps relatedTo symmetric and heals a one-sided document on read", () => {
    fs.writeFileSync(path.join(root, ".blacksite", "tickets.json"), JSON.stringify({
      schemaVersion: 2,
      tickets: [
        { id: "BLK-1", title: "One", status: "backlog", relatedTo: ["BLK-2"] },
        { id: "BLK-2", title: "Two", status: "backlog" },
      ],
    }), "utf8");
    expect(get("BLK-2").relatedTo).toEqual(["BLK-1"]);
  });

  it("drops relations pointing at tickets that no longer exist", () => {
    const first = file({ title: "first" }).ticketId;
    const second = file({ title: "second", blockedBy: [first] }).ticketId;
    store.deleteTicket(first);
    expect(get(second).blockedBy).toEqual([]);
  });

  it("refuses a duplicateOf that names no ticket, and clears one on request", () => {
    const original = file({ title: "original" }).ticketId;
    const copy = file({ title: "copy" }).ticketId;
    expect(store.updateTicket({ ticketId: copy, duplicateOf: "BLK-999" }, USER).ok).toBe(false);
    store.updateTicket({ ticketId: copy, duplicateOf: original }, USER);
    expect(get(copy).duplicateOf).toBe(original);
    store.updateTicket({ ticketId: copy, duplicateOf: "" }, USER);
    expect(get(copy).duplicateOf).toBeUndefined();
  });

  it("clears duplicateOf when the ticket it points at is deleted", () => {
    const original = file({ title: "original" }).ticketId;
    const copy = file({ title: "copy" }).ticketId;
    store.updateTicket({ ticketId: copy, duplicateOf: original }, USER);
    store.deleteTicket(original);
    expect(get(copy).duplicateOf).toBeUndefined();
  });
});

describe("search and paging", () => {
  it("matches free text across title, description, labels, criteria, and territory", () => {
    file({ title: "Retry backoff drifts", description: "The gateway TTL moved" });
    file({ title: "Unrelated", labels: ["retry"] });
    file({ title: "Also unrelated", acceptanceCriteria: ["gateway is reachable"] });
    file({ title: "Nothing to do with it", files: ["src/quiet.ts"] });

    expect((store.listTickets({ query: "gateway" }) as { matched: number }).matched).toBe(2);
    expect((store.listTickets({ query: "retry" }) as { matched: number }).matched).toBe(2);
    expect((store.listTickets({ query: "quiet.ts" }) as { matched: number }).matched).toBe(1);
  });

  it("requires every term, so two words narrow rather than widen", () => {
    file({ title: "Retry backoff drifts from gateway TTL" });
    file({ title: "Retry the upload" });
    expect((store.listTickets({ query: "retry gateway" }) as { matched: number }).matched).toBe(1);
  });

  it("reports nextOffset only while more matches remain", () => {
    for (let index = 0; index < 7; index += 1) file({ title: `Ticket ${index}` });
    const first = store.listTickets({ limit: 5 }) as { tickets: unknown[]; nextOffset?: number; matched: number };
    expect(first.matched).toBe(7);
    expect(first.tickets).toHaveLength(5);
    expect(first.nextOffset).toBe(5);
    const second = store.listTickets({ limit: 5, offset: 5 }) as { tickets: unknown[]; nextOffset?: number };
    expect(second.tickets).toHaveLength(2);
    expect(second.nextOffset).toBeUndefined();
  });

  it("filters by assignee", () => {
    file({ title: "mine", assignee: "agent" });
    file({ title: "theirs", assignee: "user" });
    expect((store.listTickets({ assignee: "agent" }) as { matched: number }).matched).toBe(1);
  });
});

describe("reading one ticket in full", () => {
  it("returns the whole timeline and the resolved territory", () => {
    indexed = ["src/a.ts"];
    const { ticketId } = file({ files: ["src/a.ts", "src/gone.ts"] });
    store.commentOnTicket({ ticketId, body: "Root cause is the cache key." }, AGENT);
    const result = store.getTicket({ ticketId }) as {
      ok: boolean;
      ticket: { events: Array<{ kind: string }>; resolvedFiles: string[]; staleFiles: string[] };
    };
    expect(result.ok).toBe(true);
    expect(result.ticket.resolvedFiles).toEqual(["src/a.ts"]);
    expect(result.ticket.staleFiles).toEqual(["src/gone.ts"]);
    expect(result.ticket.events.some((event) => event.kind === "comment")).toBe(true);
  });

  it("is case-tolerant on the id, and says so when there is no such ticket", () => {
    const { ticketId } = file({});
    expect((store.getTicket({ ticketId: ticketId.toLowerCase() }) as { ok: boolean }).ok).toBe(true);
    expect((store.getTicket({ ticketId: "nope" }) as { ok: boolean }).ok).toBe(false);
  });
});

describe("schema tolerance", () => {
  it("reads a v1 document as a valid v2 one, with the new fields defaulted", () => {
    fs.writeFileSync(path.join(root, ".blacksite", "tickets.json"), JSON.stringify({
      schemaVersion: 1,
      tickets: [{ id: "BLK-1", title: "Old", status: "backlog", labels: ["x"] }],
    }), "utf8");
    const ticket = get("BLK-1");
    expect(ticket.acceptanceCriteria).toEqual([]);
    expect(ticket.references).toEqual([]);
    expect(ticket.blocks).toEqual([]);
    expect(ticket.assignee).toBe("unassigned");
    expect(ticket.labels).toEqual(["x"]);
  });
});

describe("complexity", () => {
  it("can be un-sized again, which also drops the basis that explained it", () => {
    const { ticketId } = file({ complexity: "large", complexityBasis: "touches the cache format" });
    store.updateTicket({ ticketId, complexity: "" }, USER);
    expect(get(ticketId).complexity).toBeUndefined();
    expect(get(ticketId).complexityBasis).toBeUndefined();
  });

  it("ignores an unrecognizable size rather than clearing one that was set", () => {
    const { ticketId } = file({ complexity: "medium" });
    store.updateTicket({ ticketId, complexity: "enormous" }, USER);
    expect(get(ticketId).complexity).toBe("medium");
  });
});

/* The tool catalog and the store are joined only by a string: definitions.ts names a
   runtime type ("tickets.file"), resolveToolDispatch strips the prefix, and dispatch()
   switches on what is left. Nothing structural keeps the two in step — a renamed op or a
   new ticket tool with no case would fail only at runtime, in front of the user, as
   "Unknown ticket operation". This is the same seam that left the whole family
   unadvertised; assert it instead of trusting the next edit to touch both files. */
describe("tool catalog ↔ store dispatch", () => {
  it("routes every advertised ticket tool to a real operation", async () => {
    const unknown: string[] = [];
    for (const tool of TICKET_TOOLS) {
      const { runtimeType } = resolveToolDispatch(tool.name, {});
      expect(runtimeType.startsWith("tickets.")).toBe(true);
      const op = runtimeType.slice("tickets.".length);
      // Called with empty input on purpose: a missing id is a normal, well-worded failure,
      // whereas an unrouted op is the defect being guarded against.
      const result = await store.dispatch(op, {}, AGENT);
      if (/unknown ticket operation/i.test(String(result.error ?? ""))) unknown.push(tool.name);
    }
    expect(unknown).toEqual([]);
  });
});
