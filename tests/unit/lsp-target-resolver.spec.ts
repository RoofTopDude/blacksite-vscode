import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { TargetResolver, type FlatCodeSymbol } from "../../src/lsp/target-resolver.js";
import { WorkspaceIdentity } from "../../src/lsp/workspace-identity.js";

let root = "";
let uri: vscode.Uri;
const lines = ["function same() {}", "", "function same(value: string) {}"];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksite-target-"));
  fs.writeFileSync(path.join(root, "sample.ts"), lines.join("\n"));
  uri = vscode.Uri.file(path.join(root, "sample.ts"));
  vscode.workspace.workspaceFolders = [{ name: "root", index: 0, uri: vscode.Uri.file(root) }];
  (vscode.workspace as any).openTextDocument = async () => documentMock();
});

afterEach(() => {
  vscode.workspace.workspaceFolders = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("TargetResolver", () => {
  it("uses line to disambiguate duplicate symbols", async () => {
    const resolver = makeResolver(symbols());
    const result = await resolver.resolve({ path: "sample.ts", symbol: "same", line: 3 });
    expect(result).toMatchObject({ ok: true, symbolName: "same", position: { line: 2 } });
  });

  it("fails closed when matchText is stale", async () => {
    const result = await makeResolver([]).resolve({ path: "sample.ts", line: 1, matchText: "missing" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Current line") });
  });

  it("rejects firstMatch for mutations", async () => {
    const result = await makeResolver(symbols()).resolve({ path: "sample.ts", symbol: "same", firstMatch: true }, { mutation: true });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("not allowed") });
  });

  it("returns stable qualified candidates instead of guessing an overload", async () => {
    const result = await makeResolver(symbols()).resolve({ path: "sample.ts", symbol: "same" });
    expect(result).toMatchObject({ ok: false, ambiguous: true });
    if (!result.ok) {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates?.[0]).toMatchObject({ name: "same", qualifiedName: "same", kind: "function", line: 1 });
      expect(result.candidates?.[0]?.id).toContain("#1:10:11:same");
    }
  });

  it("validates 1-based lines and columns without clamping", async () => {
    await expect(makeResolver([]).resolve({ path: "sample.ts", line: 0 })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("positive") });
    await expect(makeResolver([]).resolve({ path: "sample.ts", line: 99 })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("out of range") });
    await expect(makeResolver([]).resolve({ path: "sample.ts", line: 1, column: 999 })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("out of range") });
  });
});

function makeResolver(values: FlatCodeSymbol[]): TargetResolver {
  return new TargetResolver(new WorkspaceIdentity(root), async () => ({ status: "ok", value: values, durationMs: 1, attempts: 1 }));
}

function symbols(): FlatCodeSymbol[] {
  return [0, 2].map((line) => ({
    name: "same",
    kind: 11,
    kindName: "function",
    selection: new vscode.Position(line, 9),
    range: new vscode.Range(line, 0, line, lines[line]!.length),
    uri,
  }));
}

function documentMock() {
  return {
    uri,
    version: 7,
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line]! }),
  };
}
