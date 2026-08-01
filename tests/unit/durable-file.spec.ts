import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  atomicWriteFile,
  atomicWriteJson,
  ensureDir,
  readJsonDocument,
  readJsonFile,
} from "../../src/shared/durable-file.js";
import { TicketStore } from "../../src/ticket-store.js";
import { PlanningStore } from "../../src/planning-store.js";
import { BaseContextStore } from "../../src/base-context-store.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-durable-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("atomicWriteFile", () => {
  it("creates missing parent directories", () => {
    const target = path.join(root, "nested", "deeper", "doc.json");
    atomicWriteFile(target, "hello");
    expect(fs.readFileSync(target, "utf8")).toBe("hello");
  });

  it("leaves no temporary files behind", () => {
    const target = path.join(root, "doc.json");
    atomicWriteFile(target, "one");
    atomicWriteFile(target, "two");
    const strays = fs.readdirSync(root).filter((name) => name.endsWith(".tmp"));
    expect(strays).toEqual([]);
  });

  it("preserves the previous contents as .bak", () => {
    const target = path.join(root, "doc.json");
    atomicWriteFile(target, "first");
    expect(fs.existsSync(`${target}.bak`)).toBe(false);
    atomicWriteFile(target, "second");
    expect(fs.readFileSync(target, "utf8")).toBe("second");
    expect(fs.readFileSync(`${target}.bak`, "utf8")).toBe("first");
  });

  it("skips the backup copy when it is turned off", () => {
    const target = path.join(root, "doc.json");
    atomicWriteFile(target, "first", { backup: false });
    atomicWriteFile(target, "second", { backup: false });
    expect(fs.readFileSync(target, "utf8")).toBe("second");
    // The rename still replaced the file wholesale; only the extra copy is gone.
    expect(fs.existsSync(`${target}.bak`)).toBe(false);
  });

  it("round-trips JSON through atomicWriteJson", () => {
    const target = path.join(root, "doc.json");
    atomicWriteJson(target, { a: 1, b: ["x"] });
    expect(readJsonFile(target)).toEqual({ a: 1, b: ["x"] });
    expect(fs.readFileSync(target, "utf8").endsWith("\n")).toBe(true);
  });
});

describe("readJsonDocument recovery", () => {
  it("reads the primary file when it parses", () => {
    const target = path.join(root, "doc.json");
    atomicWriteJson(target, { value: "current" });
    expect(readJsonDocument(target)).toEqual({ value: "current" });
  });

  it("falls back to .bak when the primary file is a torn write", () => {
    const target = path.join(root, "doc.json");
    atomicWriteJson(target, { value: "good" });
    atomicWriteJson(target, { value: "newer" });
    // Simulate a crash partway through a write: valid prefix, no closing brace.
    fs.writeFileSync(target, '{"value": "ne', "utf8");
    expect(readJsonDocument(target)).toEqual({ value: "good" });
  });

  it("returns null for an absent document even when a stale .bak exists", () => {
    const target = path.join(root, "doc.json");
    atomicWriteJson(target, { value: "one" });
    atomicWriteJson(target, { value: "two" });
    fs.rmSync(target);
    // Deleting a document is a deliberate reset; a backup must not resurrect it.
    expect(readJsonDocument(target)).toBeNull();
  });

  it("returns null when both the primary and the backup are unparseable", () => {
    const target = path.join(root, "doc.json");
    atomicWriteFile(target, "not json");
    atomicWriteFile(target, "still not json");
    expect(readJsonDocument(target)).toBeNull();
  });
});

describe("ensureDir", () => {
  it("is idempotent", () => {
    const dir = path.join(root, "a", "b");
    ensureDir(dir);
    ensureDir(dir);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });
});

describe("store durability", () => {
  it("recovers tickets from the backup after a torn write", () => {
    const store = new TicketStore(root, () => [], () => false, () => []);
    store.ensureInitialized();
    const filed = store.fileTicket({ title: "Survives a crash" }, { sessionId: "s1" }) as { ok: boolean };
    expect(filed.ok).toBe(true);
    // A second mutation is what promotes the ticket-bearing document into .bak.
    store.fileTicket({ title: "Second ticket" }, { sessionId: "s1" });

    fs.writeFileSync(store.filePath(), '{"schemaVersion": 1, "tick', "utf8");

    const titles = store.read().tickets.map((ticket) => ticket.title);
    expect(titles).toContain("Survives a crash");
    store.dispose();
  });

  it("recovers plans from the backup after a torn write", () => {
    const store = new PlanningStore(root);
    store.ensureInitialized();
    store.createPlan({ title: "Plan one", phases: [{ title: "Phase" }] }, { sessionId: "s1" });
    store.createPlan({ title: "Plan two", phases: [{ title: "Phase" }] }, { sessionId: "s1" });

    fs.writeFileSync(store.filePath(), '{"schemaVersion": 2, "pla', "utf8");

    const titles = store.read().plans.map((plan) => plan.title);
    expect(titles).toContain("Plan one");
    store.dispose();
  });

  it("recovers base context from the backup after a torn write", () => {
    const store = new BaseContextStore(root);
    store.ensureInitialized();
    store.createTopic("Topic one");
    store.createTopic("Topic two");

    fs.writeFileSync(store.filePath(), '{"schemaVersion": 1, "top', "utf8");

    const titles = store.read().topics.map((topic) => topic.title);
    expect(titles).toContain("Topic one");
    store.dispose();
  });
});
