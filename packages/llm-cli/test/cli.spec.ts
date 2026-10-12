import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFixtureEndpoint, runProbe } from "../src/probe.js";
import { demoTools } from "../src/tools.js";
import { openTransport } from "../src/transport.js";

describe("demo tools", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "llm-cli-tools-"));
    await fs.writeFile(path.join(root, "a.txt"), "alpha");
    await fs.mkdir(path.join(root, "sub"));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("reads and lists inside the root", async () => {
    const [read, list] = demoTools(root);
    expect(await read!.run({ path: "a.txt" })).toBe("alpha");
    expect(await list!.run({})).toBe("a.txt\nsub/");
  });

  it("refuses paths that leave the root", async () => {
    const [read, list] = demoTools(root);
    await expect(read!.run({ path: "../outside.txt" })).rejects.toThrow(/outside/);
    await expect(list!.run({ path: path.parse(root).root })).rejects.toThrow(/outside/);
  });
});

describe("probe --fixture", () => {
  it("passes every check against the scripted Anthropic endpoint", async () => {
    const restore = installFixtureEndpoint();
    const previous = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "fixture";
    try {
      const checks = await runProbe(() => openTransport({ provider: "anthropic", model: "claude-sonnet-4-6" }), { label: "anthropic", model: "claude-sonnet-4-6", thinking: true, maxTokens: 4096 });
      expect(checks.map((check) => [check.name, check.status])).toEqual([
        ["answers a plain prompt", "pass"],
        ["calls a tool", "pass"],
        ["uses the tool result", "pass"],
        ["replays reasoning", "pass"],
        ["reports token usage", "pass"],
      ]);
    } finally {
      restore();
      if (previous === undefined) delete process.env["ANTHROPIC_API_KEY"]; else process.env["ANTHROPIC_API_KEY"] = previous;
    }
  });

  it("explains a missing key instead of failing on the request", async () => {
    const previous = process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    try {
      await expect(openTransport({ provider: "openai", model: "gpt-4.1" })).rejects.toThrow("Set OPENAI_API_KEY");
    } finally {
      if (previous !== undefined) process.env["OPENAI_API_KEY"] = previous;
    }
  });
});
