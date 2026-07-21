/* Map Notes timeline: pure webview helpers (filtering, day grouping, relative
   time) and the host provider's git-log parser. */

import { describe, expect, it } from "vitest";
import type { GraphAnnotation } from "@/lib/graph/protocol";
import {
  filterNotes,
  groupNotesByDay,
  isRelationNote,
  noteMatchesQuery,
  relativeTime,
} from "@/lib/notes/timeline";
import { parseNoteFileLog } from "../../src/notes-timeline-provider.js";

function note(overrides: Partial<GraphAnnotation> & { id: string }): GraphAnnotation {
  return {
    scope: "node",
    from: "src/a.ts",
    kind: "ai",
    author: "agent",
    note: "a note",
    createdAt: "2026-07-15T10:00:00.000Z",
    updatedAt: "2026-07-15T10:00:00.000Z",
    ...overrides,
  };
}

describe("isRelationNote", () => {
  it("treats explicit edge scope and legacy to-bearing rows as relations", () => {
    expect(isRelationNote(note({ id: "1", scope: "edge", to: "src/b.ts" }))).toBe(true);
    expect(isRelationNote({ scope: undefined, to: "src/b.ts" })).toBe(true);
    expect(isRelationNote(note({ id: "2" }))).toBe(false);
  });
});

describe("noteMatchesQuery / filterNotes", () => {
  const notes: GraphAnnotation[] = [
    note({ id: "n1", from: "src/auth/session.ts", note: "Owns token refresh; keep in sync with gateway TTL", updatedAt: "2026-07-16T08:00:00.000Z", category: "gotcha" }),
    note({ id: "n2", scope: "edge", from: "src/ui/button.tsx", to: "services/billing/api.py", note: "Checkout click triggers billing charge", title: "Checkout to billing", relationKind: "event", updatedAt: "2026-07-15T09:00:00.000Z", category: "architecture" }),
    note({ id: "n3", from: "docs/README.md", note: "Generated — edit the template instead", updatedAt: "2026-07-10T09:00:00.000Z" }),
  ];

  it("AND-matches terms across note text and both endpoint paths", () => {
    expect(noteMatchesQuery(notes[1]!, "billing checkout")).toBe(true);
    expect(noteMatchesQuery(notes[1]!, "billing missing-term")).toBe(false);
    expect(noteMatchesQuery(notes[0]!, "")).toBe(true);
  });

  it("also matches on the note's title", () => {
    expect(noteMatchesQuery(notes[1]!, "checkout to billing")).toBe(true);
  });

  it("filters by scope and sorts most-recent first", () => {
    expect(filterNotes(notes, "all", "").map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    expect(filterNotes(notes, "relation", "").map((n) => n.id)).toEqual(["n2"]);
    expect(filterNotes(notes, "file", "").map((n) => n.id)).toEqual(["n1", "n3"]);
    expect(filterNotes(notes, "all", "billing").map((n) => n.id)).toEqual(["n2"]);
  });

  it("filters by category", () => {
    expect(filterNotes(notes, "all", "", "architecture").map((n) => n.id)).toEqual(["n2"]);
    expect(filterNotes(notes, "all", "", "gotcha").map((n) => n.id)).toEqual(["n1"]);
    expect(filterNotes(notes, "all", "", "risk")).toEqual([]);
    expect(filterNotes(notes, "all", "", "all").map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
  });
});

describe("groupNotesByDay", () => {
  it("labels today/yesterday and groups consecutive same-day notes", () => {
    const now = new Date("2026-07-16T12:00:00");
    const sorted = filterNotes([
      note({ id: "a", updatedAt: "2026-07-16T08:00:00" }),
      note({ id: "b", updatedAt: "2026-07-16T07:00:00" }),
      note({ id: "c", updatedAt: "2026-07-15T22:00:00" }),
      note({ id: "d", updatedAt: "2026-07-01T10:00:00" }),
    ], "all", "");
    const groups = groupNotesByDay(sorted, now);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", groups[2]!.label]);
    expect(groups[0]!.notes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(groups[2]!.label).not.toBe("Today");
    expect(groups[2]!.notes.map((n) => n.id)).toEqual(["d"]);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-07-16T12:00:00.000Z");
  it("formats ISO strings and epoch seconds", () => {
    expect(relativeTime("2026-07-16T11:59:40.000Z", now)).toBe("just now");
    expect(relativeTime("2026-07-16T11:30:00.000Z", now)).toBe("30m ago");
    expect(relativeTime("2026-07-16T02:00:00.000Z", now)).toBe("10h ago");
    expect(relativeTime("2026-07-10T12:00:00.000Z", now)).toBe("6d ago");
    expect(relativeTime(Date.parse("2026-05-16T12:00:00.000Z") / 1000, now)).toBe("2mo ago");
    expect(relativeTime("not a date", now)).toBe("");
  });
});

describe("parseNoteFileLog", () => {
  it("parses hash/epoch/author/subject rows and skips malformed lines", () => {
    const stdout = [
      "0123abc\t1752600000\tMorgan\tFix session refresh",
      "not-a-hash\t123\tX\tskip me",
      "89abcdef0123456789abcdef0123456789abcdef\t1752500000\tAgent\tSubject\twith\ttabs",
      "",
    ].join("\n");
    const commits = parseNoteFileLog(stdout);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({ hash: "0123abc", at: 1752600000, author: "Morgan", subject: "Fix session refresh" });
    expect(commits[1]!.subject).toBe("Subject\twith\ttabs");
  });
});
