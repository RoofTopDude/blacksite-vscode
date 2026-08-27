import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BaseContextStore, summarizeWorkspaceRulesForPrompt } from "../../src/base-context-store.js";
import { buildWorkspaceContextBlock, type WorkspaceSnapshot } from "../../src/workspace-context.js";

let root: string;
let store: BaseContextStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-workspace-rules-"));
  store = new BaseContextStore(root);
  store.ensureInitialized();
});

afterEach(() => {
  store.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

function snapshot(workspaceRules: string): WorkspaceSnapshot {
  return {
    workspaceRoot: root, allRoots: [root], openFiles: [], diagnosticSummary: "No diagnostics",
    diagnosticDetails: "", gitStatusSummary: "", baseContext: "", structuredBaseContext: "",
    workspaceRules, projectMemory: "", uiPreferenceSummary: "", planningSummary: "", ticketSummary: "",
  };
}

describe("Workspace Rules editor storage", () => {
  it("persists normalized rules separately from factual Base Context topics", () => {
    let notifications = 0;
    store.onDidChange(() => { notifications += 1; });

    store.writeWorkspaceRules("- Run focused tests\r\n- Preserve public APIs\0");

    expect(store.read().topics).toEqual([]);
    expect(store.readWorkspaceRules()).toBe("- Run focused tests\n- Preserve public APIs");
    expect(summarizeWorkspaceRulesForPrompt(root)).toContain("Preserve public APIs");
    expect(fs.existsSync(store.workspaceRulesPath())).toBe(true);
    expect(notifications).toBe(1);
  });

  it("places workspace rules in the live prompt with their precedence guidance", () => {
    const context = buildWorkspaceContextBlock(snapshot("- Never force-push.\n- Verify changed behavior."));
    expect(context).toContain("Workspace rules (.blacksite/workspace-rules.md");
    expect(context).toContain("Never force-push.");
    expect(context).toContain("higher-priority instructions");
  });
});
