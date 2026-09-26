import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { WorkspaceIdentity } from "../../src/lsp/workspace-identity.js";

const created: string[] = [];

afterEach(() => {
  vscode.workspace.workspaceFolders = undefined;
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("WorkspaceIdentity", () => {
  it("rejects absolute paths outside every workspace root", () => {
    const root = makeRoot("one");
    vscode.workspace.workspaceFolders = [folder("one", root, 0)];
    const identity = new WorkspaceIdentity(root);
    expect(identity.resolve(path.join(os.tmpdir(), "outside.ts"))).toMatchObject({ ok: false, error: expect.stringContaining("outside") });
  });

  it("returns ambiguity when the same relative path exists in multiple roots", () => {
    const first = makeRoot("first");
    const second = makeRoot("second");
    write(first, "src/index.ts");
    write(second, "src/index.ts");
    vscode.workspace.workspaceFolders = [folder("first", first, 0), folder("second", second, 1)];
    const result = new WorkspaceIdentity(first).resolve("src/index.ts");
    expect(result).toMatchObject({ ok: false, ambiguous: true });
    if (!result.ok) expect(result.candidates).toHaveLength(2);
  });

  it("uses rootId to disambiguate and returns root-qualified identity", () => {
    const first = makeRoot("first");
    const second = makeRoot("second");
    write(first, "src/index.ts");
    write(second, "src/index.ts");
    vscode.workspace.workspaceFolders = [folder("first", first, 0), folder("second", second, 1)];
    expect(new WorkspaceIdentity(first).resolve("src/index.ts", "second")).toMatchObject({
      ok: true,
      value: { rootId: "second", path: "src/index.ts" },
    });
  });

  it("rejects traversal and non-file provider URIs", () => {
    const root = makeRoot("safe");
    vscode.workspace.workspaceFolders = [folder("safe", root, 0)];
    const identity = new WorkspaceIdentity(root);
    expect(identity.resolve("../escape.ts")).toMatchObject({ ok: false, error: expect.stringContaining("escapes") });
    expect(identity.fromUri(vscode.Uri.parse("untitled:buffer.ts"))).toMatchObject({ ok: false, error: expect.stringContaining("non-file") });
  });

  it("refuses a path that leaves the workspace through a symbolic link", () => {
    // A repository can ship `linked -> <somewhere outside>`: lexically inside, physically not.
    // "junction" makes a directory link on Windows without elevation and is ignored elsewhere.
    const root = makeRoot("linked");
    const outside = makeRoot("outside");
    write(outside, "secret.ts");
    fs.symlinkSync(outside, path.join(root, "linked"), "junction");
    write(root, "inside/real.ts");
    fs.symlinkSync(path.join(root, "inside"), path.join(root, "alias"), "junction");
    vscode.workspace.workspaceFolders = [folder("linked", root, 0)];
    const identity = new WorkspaceIdentity(root);

    for (const input of ["linked/secret.ts", "linked/new-file.ts", path.join(root, "linked", "secret.ts")]) {
      expect(identity.resolve(input), input).toMatchObject({ ok: false, error: expect.stringContaining("symbolic link") });
    }
    expect(identity.fromUri(vscode.Uri.file(path.join(root, "linked", "secret.ts")))).toMatchObject({ ok: false });
    // A link that stays inside the workspace keeps working.
    expect(identity.resolve("alias/real.ts")).toMatchObject({ ok: true, value: { path: "alias/real.ts" } });
  });
});

function makeRoot(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `blacksite-${name}-`));
  created.push(directory);
  return directory;
}

function write(root: string, relative: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, "export {};\n");
}

function folder(name: string, root: string, index: number) {
  return { name, index, uri: vscode.Uri.file(root) };
}
