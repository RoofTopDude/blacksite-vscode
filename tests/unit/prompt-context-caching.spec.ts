/*
  The prompt-context path runs once per tool-call round-trip, not once per user message,
  so its disk reads are cached. These tests pin the property that makes that safe: a cache
  must never hide a write the agent itself just made mid-turn.
*/
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { summarizeWorkspaceRulesForPrompt } from "../../src/base-context-store.js";
import {
  describeProjectShape,
  invalidateWorkspaceContextCache,
  readWorkspaceInstructions,
} from "../../src/workspace-context.js";

let root: string;

/* mtime has one-second granularity on some filesystems, so a rewrite inside the same
   second can land with an unchanged mtime. Every rewrite here also changes the file's
   length, which is the other half of the cache key — this helper keeps that explicit
   rather than leaving it as an accident of the fixture strings. */
function writeRules(body: string): void {
  fs.writeFileSync(path.join(root, ".blacksite", "workspace-rules.md"), body, "utf8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bls-prompt-cache-"));
  fs.mkdirSync(path.join(root, ".blacksite"), { recursive: true });
  invalidateWorkspaceContextCache();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("summarizeWorkspaceRulesForPrompt caching", () => {
  it("returns an empty string when no rules file exists", () => {
    expect(summarizeWorkspaceRulesForPrompt(root)).toBe("");
  });

  it("serves the same content on a repeat call without the file changing", () => {
    writeRules("Always run the linter.\n");
    expect(summarizeWorkspaceRulesForPrompt(root)).toBe("Always run the linter.");
    expect(summarizeWorkspaceRulesForPrompt(root)).toBe("Always run the linter.");
  });

  it("picks up an edit made on disk between round-trips", () => {
    writeRules("Always run the linter.\n");
    expect(summarizeWorkspaceRulesForPrompt(root)).toBe("Always run the linter.");

    // A hand edit in the editor never goes through BaseContextStore.write(), so a cache
    // keyed on this store's own writes would serve the stale rule here.
    writeRules("Never run the linter without --fix first.\n");
    expect(summarizeWorkspaceRulesForPrompt(root)).toBe("Never run the linter without --fix first.");
  });

  it("goes back to empty when the rules file is deleted", () => {
    writeRules("Temporary rule.\n");
    expect(summarizeWorkspaceRulesForPrompt(root)).toBe("Temporary rule.");

    fs.rmSync(path.join(root, ".blacksite", "workspace-rules.md"));
    expect(summarizeWorkspaceRulesForPrompt(root)).toBe("");
  });

  it("applies the character budget per call rather than baking it into the cache", () => {
    writeRules("abcdefghij");
    expect(summarizeWorkspaceRulesForPrompt(root, 4)).toBe("abcd");
    // Same file, different budget — a cache storing the already-budgeted string would
    // return the 4-char slice again here.
    expect(summarizeWorkspaceRulesForPrompt(root, 8)).toBe("abcdefgh");
  });
});

describe("workspace instruction + project-shape caching", () => {
  it("reads instructions once and serves them again from cache", () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Prefer small commits.\n", "utf8");
    expect(readWorkspaceInstructions(root)).toContain("Prefer small commits.");
    expect(readWorkspaceInstructions(root)).toContain("Prefer small commits.");
  });

  it("reflects an instruction-file edit after the watcher invalidates", () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Prefer small commits.\n", "utf8");
    expect(readWorkspaceInstructions(root)).toContain("Prefer small commits.");

    fs.writeFileSync(path.join(root, "AGENTS.md"), "Prefer descriptive commits.\n", "utf8");
    // Still cached — the file watcher drives invalidation for this one, not mtime.
    expect(readWorkspaceInstructions(root)).toContain("Prefer small commits.");

    invalidateWorkspaceContextCache();
    expect(readWorkspaceInstructions(root)).toContain("Prefer descriptive commits.");
  });

  it("caches a negative instruction-file probe so a missing file is not re-statted", () => {
    expect(readWorkspaceInstructions(root)).toBe("");
    // Creating the file without invalidating must not change the answer: proves the miss
    // was cached rather than re-probed on every round-trip.
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Appeared later.\n", "utf8");
    expect(readWorkspaceInstructions(root)).toBe("");

    invalidateWorkspaceContextCache();
    expect(readWorkspaceInstructions(root)).toContain("Appeared later.");
  });

  it("recomputes project shape only after invalidation", () => {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x" }), "utf8");
    const first = describeProjectShape(root);
    expect(describeProjectShape(root)).toBe(first);

    invalidateWorkspaceContextCache();
    expect(describeProjectShape(root)).toBe(first);
  });
});
