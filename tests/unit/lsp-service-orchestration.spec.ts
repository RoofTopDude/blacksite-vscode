import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { LspService, type LspContext } from "../../src/lsp-service.js";
import type { WorkspaceEditApplier } from "../../src/workspace-edit-applier.js";

describe("LspService orchestration", () => {
  const root = process.cwd();
  const uri = vscode.Uri.file(path.join(root, "package.json"));
  const applier = {
    confirmCommand: async () => true,
  } as unknown as WorkspaceEditApplier;

  beforeEach(() => {
    vscode.workspace.workspaceFolders = [{ name: "fixture", index: 0, uri: vscode.Uri.file(root) }];
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(document(uri) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vscode.workspace.workspaceFolders = undefined;
  });

  it("builds a bounded, cycle-safe hierarchy graph with call-site ranges", async () => {
    const [a, b, c] = [item("a", 0), item("b", 1), item("c", 2)];
    vi.spyOn(vscode.commands, "executeCommand").mockImplementation(async (_command: string, subject?: unknown) => {
      if (_command === "vscode.prepareCallHierarchy") return [a];
      if (_command === "vscode.provideOutgoingCalls") {
        if (subject === a) return [{ to: b, fromRanges: [new vscode.Range(0, 2, 0, 4)] }];
        if (subject === b) return [
          { to: c, fromRanges: [new vscode.Range(1, 1, 1, 3)] },
          { to: a, fromRanges: [new vscode.Range(1, 4, 1, 6)] },
        ];
        return [];
      }
      return [];
    });
    const service = new LspService(root, applier);

    const result = await service.dispatch("hierarchy", {
      target: { path: "package.json", line: 1 },
      kind: "callees",
      depth: 3,
      limit: 10,
    }, { autoApprove: true });

    expect(result.ok).toBe(true);
    const graph = result["graph"] as { status: string; nodes: Array<{ symbol: string }>; edges: unknown[]; depthReached: number; truncated: boolean };
    expect(graph).toMatchObject({ status: "complete", depthReached: 2, truncated: false });
    expect(graph.nodes.map((node) => node.symbol).sort()).toEqual(["a", "b", "c"]);
    expect(graph.edges).toHaveLength(3);
    expect(result["results"]).toEqual([
      expect.objectContaining({ symbol: "b", callSites: [{ line: 1, column: 3, endLine: 1, endColumn: 5 }] }),
    ]);
  });

  it("shares a per-document symbol query across concurrent navigation body loads", async () => {
    let symbolQueries = 0;
    const symbol = {
      name: "body",
      kind: 11,
      range: new vscode.Range(0, 0, 3, 10),
      selectionRange: new vscode.Range(0, 0, 0, 4),
      detail: "",
      children: [],
    };
    vi.spyOn(vscode.commands, "executeCommand").mockImplementation(async (command: string) => {
      if (command === "vscode.executeDefinitionProvider") {
        return [
          { uri, range: new vscode.Range(1, 0, 1, 2) },
          { uri, range: new vscode.Range(2, 0, 2, 2) },
        ];
      }
      if (command === "vscode.executeDocumentSymbolProvider") {
        symbolQueries += 1;
        return [symbol];
      }
      return [];
    });
    const service = new LspService(root, applier);

    const result = await service.dispatch("navigate", {
      target: { path: "package.json", line: 1 },
      kind: "definition",
      includeBody: true,
    }, { autoApprove: true });

    expect(result.ok).toBe(true);
    expect(result["locations"]).toHaveLength(2);
    expect(symbolQueries).toBe(1);
  });

  it("observes workspace files touched by an unpreviewable command", async () => {
    const changed = vscode.Uri.file(path.join(root, "changed.ts"));
    const created = vscode.Uri.file(path.join(root, "created.ts"));
    vi.spyOn(vscode.commands, "executeCommand").mockImplementation(async () => {
      vscode.workspace.__fireTextDocument(changed);
      vscode.workspace.__fireCreateFiles([created]);
      return { done: true };
    });
    const service = new LspService(root, applier);
    const runCommand = (service as unknown as {
      _runCommand(command: vscode.Command, ctx: LspContext, approved: boolean): Promise<{ status: string; touchedUris: vscode.Uri[] }>;
    })._runCommand.bind(service);

    const outcome = await runCommand({ title: "Synthetic mutation", command: "fixture.mutate" }, { autoApprove: true }, true);

    expect(outcome.status).toBe("ok");
    expect(outcome.touchedUris.map((entry) => entry.toString()).sort()).toEqual([changed.toString(), created.toString()].sort());
  });

  function item(name: string, line: number): vscode.CallHierarchyItem {
    return {
      name,
      kind: 11,
      uri,
      range: new vscode.Range(line, 0, line, 8),
      selectionRange: new vscode.Range(line, 0, line, name.length),
      detail: "fixture",
    } as vscode.CallHierarchyItem;
  }
});

function document(uri: vscode.Uri): Record<string, unknown> {
  const lines = ["function a() {}", "function b() {}", "function c() {}", "end"];
  return {
    uri,
    version: 1,
    lineCount: lines.length,
    isDirty: false,
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
    getText: () => lines.join("\n"),
    offsetAt: (position: vscode.Position) => lines.slice(0, position.line).join("\n").length + position.character,
    save: async () => true,
  };
}
