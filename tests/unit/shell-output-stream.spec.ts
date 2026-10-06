import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runShellCommand } from "../../packages/local-runtime/src/shell.js";
import { LocalRuntime } from "../../packages/local-runtime/src/runtime.js";

/* A shell command's output reaches the caller while the command runs — the chat's terminal
   view depends on it — decoded whole even when a character straddles two pipe reads, and
   identical to what the final result captures. */

describe("shell output streaming", () => {
  let root = "";
  let script = "";

  beforeAll(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "bls-stream-")));
    script = path.join(root, "talk.js");
    fs.writeFileSync(script, [
      "process.stdout.write('first line\\n');",
      "process.stderr.write('a warning\\n');",
      /* "é" is two UTF-8 bytes; send them in separate writes so they arrive in separate reads. */
      "setTimeout(() => process.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0xc3])), 120);",
      "setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0x0a])), 240);",
      "setTimeout(() => process.stdout.write('last line\\n'), 360);",
    ].join("\n"));
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("delivers decoded chunks before the command ends, matching the captured result", async () => {
    const chunks: Array<{ stream: string; text: string; at: number }> = [];
    const result = await runShellCommand(
      { command: process.execPath, args: [script], shell: false }, root, 10_000, undefined, undefined,
      (stream, text) => chunks.push({ stream, text, at: Date.now() }),
    );
    const finished = Date.now();
    expect(result.exitCode).toBe(0);
    const stdout = chunks.filter((c) => c.stream === "stdout").map((c) => c.text).join("");
    const stderr = chunks.filter((c) => c.stream === "stderr").map((c) => c.text).join("");
    expect(stdout).toBe(result.stdout);
    expect(stderr).toBe(result.stderr);
    expect(stdout).toBe("first line\ncafé\nlast line\n");
    expect(stdout).not.toContain("�");
    expect(stderr).toBe("a warning\n");
    /* The first line was in hand well before the process exited. */
    expect(finished - chunks[0]!.at).toBeGreaterThan(200);
  });

  it("forwards output through LocalRuntime only when a listener is passed", async () => {
    const runtime = new LocalRuntime(root, { allowedCommands: ["node"] });
    const seen: string[] = [];
    const response = await runtime.handleMessage(
      { type: "system.shell", payload: { command: "node", args: [script], confirmed: true, allowedBinaries: ["node"] } },
      undefined,
      { onOutput: (_stream, text) => seen.push(text) },
    );
    expect((response.result as { exitCode?: number }).exitCode).toBe(0);
    expect(seen.join("")).toContain("last line");
    /* No listener: the call behaves exactly as before. */
    const quiet = await runtime.handleMessage({ type: "system.shell", payload: { command: "node", args: ["--version"], confirmed: true, allowedBinaries: ["node"] } });
    expect((quiet.result as { stdout?: string }).stdout).toMatch(/^v\d/);
  });
});
