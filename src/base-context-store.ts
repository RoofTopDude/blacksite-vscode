import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { atomicWriteJson, ensureDir, readJsonDocument } from "./shared/durable-file.js";
import { newId, nowIso } from "./shared/identifiers.js";

const BASE_CONTEXT_FILE = "base-context.json";
const BLACKSITE_DIR = ".blacksite";
const BASE_CONTEXT_SCHEMA_VERSION = 1;
const MAX_TOPIC_TITLE = 120;
const MAX_TOPIC_NOTES = 16_000;
const MAX_PROMPT_CHARS = 6_000;
const MAX_TOPIC_FILES = 6;

export interface BaseContextFileRef {
  id: string;
  path: string;
  addedAt: string;
}

export interface BaseContextTopic {
  id: string;
  title: string;
  notes: string;
  enabled: boolean;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  files: BaseContextFileRef[];
}

export interface BaseContextDocument {
  schemaVersion: number;
  updatedAt: string | null;
  topics: BaseContextTopic[];
}

function defaultDocument(): BaseContextDocument {
  return {
    schemaVersion: BASE_CONTEXT_SCHEMA_VERSION,
    updatedAt: null,
    topics: [],
  };
}

function normalizeFileRef(value: unknown): BaseContextFileRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const filePath = typeof record.path === "string" ? normalizeStoredPath(record.path) : "";
  if (!filePath) return null;
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId("bc_file"),
    path: filePath,
    addedAt: typeof record.addedAt === "string" && record.addedAt ? record.addedAt : nowIso(),
  };
}

function normalizeTopic(value: unknown): BaseContextTopic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? cleanTitle(record.title) : "";
  if (!title) return null;
  const files = Array.isArray(record.files)
    ? record.files.map(normalizeFileRef).filter((file): file is BaseContextFileRef => file !== null).slice(0, MAX_TOPIC_FILES)
    : [];
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : newId("bc_topic"),
    title,
    notes: typeof record.notes === "string" ? record.notes.slice(0, MAX_TOPIC_NOTES) : "",
    enabled: record.enabled !== false,
    pinned: record.pinned === true,
    createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt : nowIso(),
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : nowIso(),
    files,
  };
}

function normalizeDocument(value: unknown): BaseContextDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaultDocument();
  const record = value as Record<string, unknown>;
  return {
    schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : BASE_CONTEXT_SCHEMA_VERSION,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    topics: Array.isArray(record.topics)
      ? record.topics.map(normalizeTopic).filter((topic): topic is BaseContextTopic => topic !== null)
      : [],
  };
}

function cleanTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_TOPIC_TITLE);
}

function normalizeStoredPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function relativeToWorkspace(workspaceRoot: string, filePath: string): string | null {
  const absolute = path.resolve(filePath);
  const relative = path.relative(workspaceRoot, absolute).replace(/\\/g, "/");
  if (!relative || relative.startsWith("..")) return null;
  return normalizeStoredPath(relative);
}

function sortTopics(topics: BaseContextTopic[]): BaseContextTopic[] {
  return topics.slice().sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

function shortText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
}

function readTextSnippet(filePath: string, maxChars: number): string {
  try {
    const raw = fs.readFileSync(filePath, "utf8").replace(/\0/g, "");
    return shortText(raw, maxChars);
  } catch {
    return "";
  }
}

export function summarizeBaseContextForPrompt(workspaceRoot: string, maxChars = MAX_PROMPT_CHARS): string {
  const filePath = path.join(workspaceRoot, BLACKSITE_DIR, BASE_CONTEXT_FILE);
  if (!fs.existsSync(filePath)) return "";
  const document = normalizeDocument(readJsonDocument(filePath));
  const enabledTopics = sortTopics(document.topics).filter((topic) => topic.enabled);
  if (enabledTopics.length === 0) return "";

  const sections: string[] = [];
  let remaining = maxChars;
  for (const topic of enabledTopics) {
    const lines = [`- ${topic.title}`];
    if (topic.notes.trim()) {
      lines.push(`  Notes: ${shortText(topic.notes, 600)}`);
    }
    for (const file of topic.files.slice(0, 3)) {
      const absolute = path.join(workspaceRoot, file.path);
      const snippet = readTextSnippet(absolute, 900);
      if (snippet) {
        lines.push(`  File ${file.path}: ${snippet}`);
      } else {
        lines.push(`  File ${file.path}`);
      }
    }
    const block = lines.join("\n");
    if (block.length > remaining && sections.length > 0) break;
    sections.push(block.slice(0, remaining));
    remaining -= block.length + 1;
    if (remaining <= 180) break;
  }

  return sections.join("\n");
}

export class BaseContextStore implements vscode.Disposable {
  private readonly _emitter = new vscode.EventEmitter<BaseContextDocument>();

  readonly onDidChange = this._emitter.event;

  constructor(private readonly _workspaceRoot: string) {}

  dispose(): void {
    this._emitter.dispose();
  }

  ensureInitialized(): void {
    ensureDir(path.join(this._workspaceRoot, BLACKSITE_DIR));
    if (!fs.existsSync(this.filePath())) {
      atomicWriteJson(this.filePath(), defaultDocument());
    }
  }

  filePath(): string {
    return path.join(this._workspaceRoot, BLACKSITE_DIR, BASE_CONTEXT_FILE);
  }

  read(): BaseContextDocument {
    return normalizeDocument(readJsonDocument(this.filePath()));
  }

  createTopic(title = "New topic"): BaseContextTopic {
    const document = this.read();
    const timestamp = nowIso();
    const topic: BaseContextTopic = {
      id: newId("bc_topic"),
      title: cleanTitle(title) || "New topic",
      notes: "",
      enabled: true,
      pinned: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      files: [],
    };
    document.topics.unshift(topic);
    this.write(document);
    return topic;
  }

  updateTopic(topicId: string, patch: Partial<Pick<BaseContextTopic, "title" | "notes" | "enabled" | "pinned">>): BaseContextDocument {
    const document = this.read();
    const topic = document.topics.find((entry) => entry.id === topicId);
    if (!topic) return document;

    if (typeof patch.title === "string") {
      const title = cleanTitle(patch.title);
      if (title) topic.title = title;
    }
    if (typeof patch.notes === "string") topic.notes = patch.notes.slice(0, MAX_TOPIC_NOTES);
    if (typeof patch.enabled === "boolean") topic.enabled = patch.enabled;
    if (typeof patch.pinned === "boolean") topic.pinned = patch.pinned;
    topic.updatedAt = nowIso();
    this.write(document);
    return document;
  }

  deleteTopic(topicId: string): BaseContextDocument {
    const document = this.read();
    document.topics = document.topics.filter((topic) => topic.id !== topicId);
    this.write(document);
    return document;
  }

  addFile(topicId: string, filePath: string): BaseContextDocument {
    const relative = relativeToWorkspace(this._workspaceRoot, filePath);
    if (!relative) throw new Error("Only workspace files can be attached to Base Context.");

    const document = this.read();
    const topic = document.topics.find((entry) => entry.id === topicId);
    if (!topic) throw new Error("Topic not found.");
    if (topic.files.some((file) => file.path === relative)) return document;
    if (topic.files.length >= MAX_TOPIC_FILES) throw new Error(`Each topic supports up to ${MAX_TOPIC_FILES} files.`);

    topic.files.push({
      id: newId("bc_file"),
      path: relative,
      addedAt: nowIso(),
    });
    topic.updatedAt = nowIso();
    this.write(document);
    return document;
  }

  removeFile(topicId: string, fileId: string): BaseContextDocument {
    const document = this.read();
    const topic = document.topics.find((entry) => entry.id === topicId);
    if (!topic) return document;
    topic.files = topic.files.filter((file) => file.id !== fileId);
    topic.updatedAt = nowIso();
    this.write(document);
    return document;
  }

  private write(document: BaseContextDocument): void {
    const normalized = normalizeDocument({
      ...document,
      schemaVersion: BASE_CONTEXT_SCHEMA_VERSION,
      updatedAt: nowIso(),
      topics: document.topics,
    });
    atomicWriteJson(this.filePath(), normalized);
    this._emitter.fire(normalized);
  }
}
