import * as fs from "fs";
import * as path from "path";

const DIR = ".blacksite";
const CONTEXT_FILE = "context.md";
const MEMORY_FILE = "memory.md";
const UI_PREFERENCES_FILE = "ui-preferences.json";
const SESSIONS_DIR = "sessions";

export interface UiPreferenceEntry {
  elementKey?: string;
  elementType?: string;
  componentName?: string;
  selection?: {
    optionId?: string;
    optionLabel?: string;
    rationale?: string;
  };
  technicalDetails?: {
    tokens?: string[];
    componentPath?: string;
    cssProperties?: Record<string, string | number | boolean>;
    notes?: string[];
  };
  lastConfirmedAt?: string;
}

export interface UiPreferencesDocument {
  schemaVersion: number;
  updatedAt: string | null;
  preferences: UiPreferenceEntry[];
}

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function defaultUiPreferencesDocument(): UiPreferencesDocument {
  return {
    schemaVersion: 1,
    updatedAt: null,
    preferences: [],
  };
}

export class MemoryStore {
  private readonly dir: string;

  constructor(workspaceRoot: string) {
    this.dir = path.join(workspaceRoot, DIR);
  }

  ensureInitialized(): void {
    ensureDir(this.dir);
    ensureDir(path.join(this.dir, SESSIONS_DIR));

    const contextPath = this.contextPath();
    if (!fs.existsSync(contextPath)) {
      fs.writeFileSync(
        contextPath,
        `# Project Context\n\nAdd persistent notes about this project here.\nBlacksite reads this file at the start of each conversation.\n`,
        "utf8",
      );
    }

    const memPath = this.memoryPath();
    if (!fs.existsSync(memPath)) {
      fs.writeFileSync(memPath, `# Project Memory\n\n`, "utf8");
    }

    const uiPreferencesPath = this.uiPreferencesPath();
    if (!fs.existsSync(uiPreferencesPath)) {
      fs.writeFileSync(
        uiPreferencesPath,
        `${JSON.stringify(defaultUiPreferencesDocument(), null, 2)}\n`,
        "utf8",
      );
    }
  }

  contextPath(): string {
    return path.join(this.dir, CONTEXT_FILE);
  }

  memoryPath(): string {
    return path.join(this.dir, MEMORY_FILE);
  }

  uiPreferencesPath(): string {
    return path.join(this.dir, UI_PREFERENCES_FILE);
  }

  readContext(): string {
    try { return fs.readFileSync(this.contextPath(), "utf8"); } catch { return ""; }
  }

  readMemory(): string {
    try { return fs.readFileSync(this.memoryPath(), "utf8"); } catch { return ""; }
  }

  readUiPreferences(): UiPreferencesDocument {
    try {
      const raw = fs.readFileSync(this.uiPreferencesPath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<UiPreferencesDocument>;
      return {
        schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
        preferences: Array.isArray(parsed.preferences) ? parsed.preferences as UiPreferenceEntry[] : [],
      };
    } catch {
      return defaultUiPreferencesDocument();
    }
  }

  writeUiPreferences(document: UiPreferencesDocument): void {
    const normalized: UiPreferencesDocument = {
      schemaVersion: typeof document.schemaVersion === "number" ? document.schemaVersion : 1,
      updatedAt: document.updatedAt ?? new Date().toISOString(),
      preferences: Array.isArray(document.preferences) ? document.preferences : [],
    };
    try {
      fs.writeFileSync(this.uiPreferencesPath(), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    } catch { /* ignore */ }
  }

  upsertUiPreference(entry: UiPreferenceEntry): void {
    const current = this.readUiPreferences();
    const key = `${entry.elementKey ?? ""}::${entry.componentName ?? ""}::${entry.elementType ?? ""}`;
    const nextEntry: UiPreferenceEntry = {
      ...entry,
      lastConfirmedAt: entry.lastConfirmedAt ?? new Date().toISOString(),
    };
    const existingIndex = current.preferences.findIndex((item) => {
      const itemKey = `${item.elementKey ?? ""}::${item.componentName ?? ""}::${item.elementType ?? ""}`;
      return itemKey === key && itemKey !== "::::";
    });
    if (existingIndex >= 0) current.preferences.splice(existingIndex, 1, nextEntry);
    else current.preferences.unshift(nextEntry);

    this.writeUiPreferences({
      schemaVersion: current.schemaVersion || 1,
      updatedAt: new Date().toISOString(),
      preferences: current.preferences,
    });
  }

  appendMemory(entry: string): void {
    const timestamp = new Date().toISOString().slice(0, 16);
    const text = `\n## ${timestamp}\n\n${entry.trim()}\n`;
    try { fs.appendFileSync(this.memoryPath(), text, "utf8"); } catch { /* ignore */ }
  }

  saveSession(sessionId: string, messages: unknown[]): void {
    try {
      ensureDir(path.join(this.dir, SESSIONS_DIR));
      const file = path.join(this.dir, SESSIONS_DIR, `${sessionId}.json`);
      fs.writeFileSync(file, JSON.stringify({ sessionId, messages, savedAt: Date.now() }, null, 2), "utf8");
    } catch { /* ignore */ }
  }

  listSessions(): string[] {
    try {
      const dir = path.join(this.dir, SESSIONS_DIR);
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(".json", ""));
    } catch { return []; }
  }
}
