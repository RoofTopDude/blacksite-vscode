import { describe, expect, it, vi } from "vitest";
import { AttentionCenter, describeTopItem, shouldNotify, type AttentionItem } from "../../src/chat/attention.js";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return { id: "a", kind: "approval", severity: "needs_you", source: "chat", title: "Approval needed", at: 1, ...overrides };
}

describe("AttentionCenter", () => {
  it("orders what needs a person before failures before good news", () => {
    const center = new AttentionCenter();
    center.raise(item({ id: "done", kind: "run_done", severity: "success", at: 5 }));
    center.raise(item({ id: "fail", kind: "run_failed", severity: "error", at: 4 }));
    center.raise(item({ id: "ask", severity: "needs_you", at: 1 }));
    center.raise(item({ id: "ask2", severity: "needs_you", at: 3 }));
    expect(center.list().map((entry) => entry.id)).toEqual(["ask2", "ask", "fail", "done"]);
  });

  it("counts only what is waiting on a person or failed", () => {
    const center = new AttentionCenter();
    center.raise(item({ id: "1" }));
    center.raise(item({ id: "2", severity: "error" }));
    center.raise(item({ id: "3", severity: "success", kind: "run_done" }));
    center.raise(item({ id: "4", severity: "info", kind: "provider_wait" }));
    expect(center.count()).toBe(2);
  });

  it("reports a new item once and updates an existing one in place", () => {
    const center = new AttentionCenter();
    expect(center.raise(item())).toBe(true);
    expect(center.raise(item({ title: "Approval needed (edited)" }))).toBe(false);
    expect(center.list()).toHaveLength(1);
    expect(center.list()[0]!.title).toBe("Approval needed (edited)");
  });

  it("notifies listeners on every change and survives a throwing listener", () => {
    const center = new AttentionCenter();
    const seen = vi.fn();
    center.onChange(() => { throw new Error("boom"); });
    const off = center.onChange(seen);
    center.raise(item());
    center.resolve("a");
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen.mock.calls[1]![0]).toEqual([]);
    off();
    center.raise(item({ id: "b" }));
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("resolves by predicate and lets a resolved item be announced again", () => {
    const center = new AttentionCenter();
    center.raise(item({ id: "run:1:a", source: "run" }));
    center.raise(item({ id: "run:1:b", source: "run" }));
    center.raise(item({ id: "chat:1" }));
    expect(center.markAnnounced("run:1:a")).toBe(true);
    expect(center.markAnnounced("run:1:a")).toBe(false);
    center.resolveWhere((entry) => entry.source === "run");
    expect(center.list().map((entry) => entry.id)).toEqual(["chat:1"]);
    center.raise(item({ id: "run:1:a", source: "run" }));
    expect(center.markAnnounced("run:1:a")).toBe(true);
  });
});

describe("shouldNotify", () => {
  const away = { windowFocused: false, chatVisible: true };
  const watching = { windowFocused: true, chatVisible: true };

  it("never interrupts a user who is looking at the chat", () => {
    expect(shouldNotify(item(), "all", watching)).toBe(false);
  });

  it("interrupts a user who is away for what needs them, what failed, and a finished run", () => {
    expect(shouldNotify(item(), "attention", away)).toBe(true);
    expect(shouldNotify(item({ severity: "error", kind: "run_failed" }), "attention", away)).toBe(true);
    expect(shouldNotify(item({ severity: "success", kind: "run_done" }), "attention", away)).toBe(true);
    expect(shouldNotify(item({ severity: "info", kind: "provider_wait" }), "attention", away)).toBe(false);
  });

  it("interrupts a user in another editor even if the window has focus", () => {
    expect(shouldNotify(item(), "attention", { windowFocused: true, chatVisible: false })).toBe(true);
  });

  it("respects off and all", () => {
    expect(shouldNotify(item(), "off", away)).toBe(false);
    expect(shouldNotify(item({ severity: "info", kind: "provider_wait" }), "all", away)).toBe(true);
  });
});

describe("describeTopItem", () => {
  it("names the most pressing item and how many more there are", () => {
    expect(describeTopItem([])).toBeUndefined();
    expect(describeTopItem([item({ title: "Approval needed" })])).toBe("Approval needed");
    expect(describeTopItem([item({ title: "Approval needed" }), item({ id: "b" }), item({ id: "c" })])).toBe("Approval needed (+2)");
  });
});
