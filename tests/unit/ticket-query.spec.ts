/* The webview's search/filter/sort/group layer. Pure functions over pushed state, so they are
   testable without a DOM — and worth testing, because this is the part that has to stay correct
   when the queue reaches several hundred tickets. */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS, applyFilters, groupTickets, matchesQuery, sortTickets,
  activeFilterCount, clearFilters, toggleIn, type Filters,
} from "@/apps/tickets/query";
import type { Ticket } from "@/apps/tickets/types";

let counter = 0;

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  counter += 1;
  return {
    id: `BLK-${counter}`,
    title: `Ticket ${counter}`,
    status: "backlog",
    statusSource: "manual",
    priority: "normal",
    labels: [],
    acceptanceCriteria: [],
    territory: { files: [], areas: [] },
    references: [],
    blockedBy: [],
    blocks: [],
    relatedTo: [],
    assignee: "unassigned",
    origin: "agent",
    events: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function filters(overrides: Partial<Filters> = {}): Filters {
  return { ...DEFAULT_FILTERS, ...overrides };
}

describe("matchesQuery", () => {
  it("searches every field a ticket says something in", () => {
    const subject = ticket({
      title: "Retry backoff drifts",
      description: "The gateway TTL moved under us",
      labels: ["networking"],
      acceptanceCriteria: ["ceiling is read, not hardcoded"],
      territory: { files: ["src/gateway/retry.ts"], areas: [] },
      references: [{ url: "https://example.com/x", title: "upstream thread" }],
    });
    for (const term of ["retry", "gateway", "networking", "hardcoded", "retry.ts", "upstream"]) {
      expect(matchesQuery(subject, term)).toBe(true);
    }
    expect(matchesQuery(subject, "unrelated")).toBe(false);
  });

  it("requires every term, so two words narrow", () => {
    const subject = ticket({ title: "Retry backoff drifts from gateway TTL" });
    expect(matchesQuery(subject, "retry gateway")).toBe(true);
    expect(matchesQuery(subject, "retry elephant")).toBe(false);
  });

  it("scopes a #term to labels", () => {
    const labelled = ticket({ title: "nothing in the title", labels: ["auth"] });
    const titled = ticket({ title: "auth is broken" });
    expect(matchesQuery(labelled, "#auth")).toBe(true);
    expect(matchesQuery(titled, "#auth")).toBe(false);
  });

  it("scopes an @term to the assignee, with @me meaning the user", () => {
    expect(matchesQuery(ticket({ assignee: "agent" }), "@agent")).toBe(true);
    expect(matchesQuery(ticket({ assignee: "user" }), "@me")).toBe(true);
    expect(matchesQuery(ticket({ assignee: "agent" }), "@me")).toBe(false);
  });

  it("matches everything when the query is empty", () => {
    expect(matchesQuery(ticket(), "   ")).toBe(true);
  });
});

describe("applyFilters", () => {
  const pool = [
    ticket({ status: "triage", priority: "urgent" }),
    ticket({ status: "backlog", assignee: "user" }),
    ticket({ status: "in_progress", labels: ["graph"] }),
    ticket({ status: "done" }),
    ticket({ status: "cancelled" }),
  ];

  it("defaults to the open slice", () => {
    expect(applyFilters(pool, filters()).map((entry) => entry.status))
      .toEqual(["triage", "backlog", "in_progress"]);
  });

  it("lets an explicit status filter override the scope tab rather than intersecting", () => {
    // Picking "Done" while sitting on the Open tab must show done tickets, not an empty list.
    const result = applyFilters(pool, filters({ scope: "open", statuses: ["done"] }));
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("done");
  });

  it("ANDs across filter kinds and ORs within one", () => {
    const result = applyFilters(pool, filters({ scope: "all", statuses: ["triage", "backlog"], priorities: ["urgent"] }));
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("triage");
  });

  it("matches an area filter against declared areas and files beneath them", () => {
    const byFile = ticket({ territory: { files: ["src/graph/layout.ts"], areas: [] } });
    const byArea = ticket({ territory: { files: [], areas: ["src/graph"] } });
    const elsewhere = ticket({ territory: { files: ["src/chat.ts"], areas: [] } });
    const result = applyFilters([byFile, byArea, elsewhere], filters({ areas: ["src/graph"] }));
    expect(result).toHaveLength(2);
  });

  it("counts the mine scope as open work the user owns", () => {
    const mine = ticket({ assignee: "user", status: "backlog" });
    const closed = ticket({ assignee: "user", status: "done" });
    expect(applyFilters([mine, closed], filters({ scope: "mine" }))).toEqual([mine]);
  });
});

describe("sortTickets", () => {
  it("orders by priority, then most recently updated", () => {
    const low = ticket({ priority: "low", updatedAt: "2026-03-01T00:00:00.000Z" });
    const urgent = ticket({ priority: "urgent", updatedAt: "2026-01-01T00:00:00.000Z" });
    const normalOld = ticket({ priority: "normal", updatedAt: "2026-01-01T00:00:00.000Z" });
    const normalNew = ticket({ priority: "normal", updatedAt: "2026-02-01T00:00:00.000Z" });
    expect(sortTickets([low, urgent, normalOld, normalNew], "priority", new Map()))
      .toEqual([urgent, normalNew, normalOld, low]);
  });

  it("follows the document order for manual rank", () => {
    const first = ticket();
    const second = ticket();
    const rank = new Map([[second.id, 0], [first.id, 1]]);
    expect(sortTickets([first, second], "manual", rank)).toEqual([second, first]);
  });

  it("does not mutate its input", () => {
    const pool = [ticket({ priority: "low" }), ticket({ priority: "urgent" })];
    const snapshot = [...pool];
    sortTickets(pool, "priority", new Map());
    expect(pool).toEqual(snapshot);
  });
});

describe("groupTickets", () => {
  it("emits every status in canonical order, including empty ones", () => {
    const groups = groupTickets([ticket({ status: "backlog" })], "status");
    expect(groups.map((group) => group.key))
      .toEqual(["triage", "backlog", "in_progress", "blocked", "review", "done", "cancelled"]);
    expect(groups.find((group) => group.key === "backlog")?.tickets).toHaveLength(1);
  });

  it("puts a multi-labelled ticket in every one of its label groups", () => {
    const groups = groupTickets([ticket({ labels: ["a", "b"] })], "label");
    expect(groups.map((group) => group.key).sort()).toEqual(["a", "b"]);
  });

  it("gives label-less tickets their own bucket rather than dropping them", () => {
    const groups = groupTickets([ticket({ labels: ["a"] }), ticket()], "label");
    expect(groups.find((group) => group.key === "__none")?.tickets).toHaveLength(1);
  });

  it("groups by area using declared areas and the directories of declared files", () => {
    const groups = groupTickets([
      ticket({ territory: { files: ["src/graph/layout.ts"], areas: [] } }),
      ticket({ territory: { files: [], areas: ["src/graph"] } }),
    ], "area");
    expect(groups.find((group) => group.key === "src/graph")?.tickets).toHaveLength(2);
  });

  it("collapses to a single group when grouping is off", () => {
    const groups = groupTickets([ticket(), ticket()], "none");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.tickets).toHaveLength(2);
  });
});

describe("filter chip bookkeeping", () => {
  it("counts every active dimension", () => {
    expect(activeFilterCount(filters({ statuses: ["done"], labels: ["a", "b"] }))).toBe(3);
  });

  it("clears the dimensions without touching the query, scope, grouping, or sort", () => {
    const before = filters({ query: "x", scope: "all", groupBy: "label", sortBy: "title", labels: ["a"] });
    const after = clearFilters(before);
    expect(after.labels).toEqual([]);
    expect(after).toMatchObject({ query: "x", scope: "all", groupBy: "label", sortBy: "title" });
  });

  it("toggles a value in and back out", () => {
    expect(toggleIn(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleIn(["a", "b"], "a")).toEqual(["b"]);
  });
});
