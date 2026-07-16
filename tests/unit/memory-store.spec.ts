import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory-store.js";

let root: string;
let store: MemoryStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-"));
  store = new MemoryStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("ensureInitialized", () => {
  it("creates context.md, memory.md, ui-preferences.json, and sessions/ from scratch", () => {
    store.ensureInitialized();
    expect(fs.existsSync(store.contextPath())).toBe(true);
    expect(fs.existsSync(store.memoryPath())).toBe(true);
    expect(fs.existsSync(store.uiPreferencesPath())).toBe(true);
    expect(fs.existsSync(path.join(root, ".blacksite", "sessions"))).toBe(true);
    expect(store.readUiPreferences()).toEqual({ schemaVersion: 1, updatedAt: null, preferences: [] });
  });

  it("does not clobber existing content on repeat calls", () => {
    store.ensureInitialized();
    fs.writeFileSync(store.contextPath(), "# Project Context\n\ncustom note\n", "utf8");
    store.ensureInitialized();
    expect(store.readContext()).toContain("custom note");
  });
});

describe("readContext / readMemory", () => {
  it("returns empty string when the files don't exist yet", () => {
    expect(store.readContext()).toBe("");
    expect(store.readMemory()).toBe("");
  });
});

describe("appendMemory", () => {
  it("appends a timestamped section, preserving prior entries", () => {
    store.ensureInitialized();
    store.appendMemory("first entry");
    store.appendMemory("  second entry with padding  \n");
    const content = store.readMemory();
    expect(content).toContain("first entry");
    expect(content).toContain("second entry with padding");
    // trims trailing/leading whitespace from each entry
    expect(content).not.toContain("padding  \n");
    expect(content.indexOf("first entry")).toBeLessThan(content.indexOf("second entry"));
  });
});

describe("UI preferences", () => {
  it("round-trips a written document", () => {
    store.ensureInitialized();
    store.writeUiPreferences({
      schemaVersion: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      preferences: [{ elementKey: "btn", componentName: "Toolbar" }],
    });
    const reloaded = store.readUiPreferences();
    expect(reloaded.preferences).toHaveLength(1);
    expect(reloaded.preferences[0]).toMatchObject({ elementKey: "btn", componentName: "Toolbar" });
  });

  it("falls back to defaults when the file is corrupt", () => {
    store.ensureInitialized();
    fs.writeFileSync(store.uiPreferencesPath(), "{not json", "utf8");
    expect(store.readUiPreferences()).toEqual({ schemaVersion: 1, updatedAt: null, preferences: [] });
  });

  it("upsertUiPreference inserts new entries at the front and updates matching ones in place", () => {
    store.ensureInitialized();
    store.upsertUiPreference({ elementKey: "a", componentName: "C", elementType: "button" });
    store.upsertUiPreference({ elementKey: "b", componentName: "C", elementType: "button" });
    let prefs = store.readUiPreferences().preferences;
    expect(prefs.map((p) => p.elementKey)).toEqual(["b", "a"]);

    store.upsertUiPreference({ elementKey: "a", componentName: "C", elementType: "button", selection: { optionId: "x" } });
    prefs = store.readUiPreferences().preferences;
    expect(prefs).toHaveLength(2);
    const a = prefs.find((p) => p.elementKey === "a");
    expect(a?.selection?.optionId).toBe("x");
  });

  it("treats entries with all-empty key parts as distinct, not a shared match", () => {
    store.ensureInitialized();
    store.upsertUiPreference({});
    store.upsertUiPreference({});
    expect(store.readUiPreferences().preferences).toHaveLength(2);
  });
});

describe("sessions", () => {
  it("saves and lists sessions by id", () => {
    store.ensureInitialized();
    store.saveSession("abc", [{ role: "user", content: "hi" }]);
    store.saveSession("def", []);
    expect(store.listSessions().sort()).toEqual(["abc", "def"]);

    const raw = fs.readFileSync(path.join(root, ".blacksite", "sessions", "abc.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.sessionId).toBe("abc");
    expect(parsed.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("listSessions returns an empty array when the sessions dir doesn't exist", () => {
    expect(store.listSessions()).toEqual([]);
  });
});
