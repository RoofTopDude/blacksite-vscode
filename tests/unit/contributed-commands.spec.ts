/* Every command package.json puts in the Command Palette must have a handler.

   "Blacksite: Manage Hooks" shipped in 1.26.0 as a palette entry with nothing registered behind
   it, so it answered "command 'blacksite.manageHooks' not found" for five releases. A static
   check is enough to catch that class of mistake: each contributed id must appear in a
   registerCommand call, as a literal or through a constant holding it. */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "webview") continue; // webviews cannot register commands
      sourceFiles(full, out);
    } else if (/\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("contributed commands", () => {
  it("are all registered", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { contributes: { commands: Array<{ command: string }> } };
    const source = sourceFiles(path.join(root, "src")).map((file) => fs.readFileSync(file, "utf8")).join("\n");

    const registered = new Set<string>();
    for (const match of source.matchAll(/registerCommand\(\s*["'`]([^"'`]+)["'`]/g)) registered.add(match[1]!);
    // registerCommand(SOME_CONSTANT, …) where `const SOME_CONSTANT = "blacksite.x"` (exported or not).
    const constants = new Map<string, string>();
    for (const match of source.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*["'`]([^"'`]+)["'`]/g)) constants.set(match[1]!, match[2]!);
    for (const match of source.matchAll(/registerCommand\(\s*([A-Z][A-Z0-9_]*)\b/g)) {
      const value = constants.get(match[1]!);
      if (value) registered.add(value);
    }

    const missing = manifest.contributes.commands.map((entry) => entry.command).filter((id) => !registered.has(id));
    expect(missing).toEqual([]);
  });
});
