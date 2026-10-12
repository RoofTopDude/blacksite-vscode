import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as esbuild from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";

/* @blacksite-agent/llm's core entry promises to run without Node: fetch, Web Streams and Web
   Crypto only, so a browser extension or a worker can use it. Lint keeps Node imports out of the
   source; this proves the bundle actually runs in a browser. It builds the core for the browser,
   loads it into a blank page, streams an Anthropic turn through the real client against a
   stubbed fetch, and signs a Bedrock request with Web Crypto, comparing the signature with one
   the Node signer produced (see packages/llm/test/bedrock-client.spec.ts). */

const ENTRY = `
  import { createModelClient, planThinking, signBedrockRequest } from "@blacksite-agent/llm";
  import { anthropicTextTurn } from "@blacksite-agent/llm/testing";
  window.runLlmSmoke = async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, body: anthropicTextTurn("Hello from the browser") });
    const client = createModelClient({ provider: "anthropic", apiKey: "k" });
    const thinking = planThinking({ model: "claude-sonnet-4-6", provider: "anthropic", configuredMaxTokens: 1024, ceiling: null, thinkingEnabled: false, budgetTokens: 0, effort: undefined, temperature: undefined });
    const events = [];
    for await (const event of client.stream({
      model: "claude-sonnet-4-6", system: "S", systemSummary: "", contextTail: "",
      messages: [{ role: "user", content: "hi" }], tools: { wire: [], deferred: new Set() },
      thinking, conversationId: "c", turnIndex: 0,
    })) events.push(event);
    const RealDate = Date;
    globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ["2025-01-02T03:04:05.000Z"])); } };
    const signed = await signBedrockRequest(
      { region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      "POST", "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages",
      { "content-type": "application/json", "anthropic-version": "2023-06-01" }, '{"a":1}', "bedrock-mantle");
    globalThis.Date = RealDate;
    return { events, authorization: signed.Authorization };
  };
`;

describe("@blacksite-agent/llm in a browser", () => {
  let browser: Browser;
  let page: Page;
  let server: http.Server;

  beforeAll(async () => {
    const built = await esbuild.build({
      stdin: { contents: ENTRY, resolveDir: path.resolve("."), loader: "js" },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      conditions: ["source"],
      logLevel: "silent",
    });
    const executablePath = process.platform === "win32"
      ? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(fs.existsSync)
      : undefined;
    server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>llm</title>"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage();
    // Loopback is a secure context, so crypto.subtle exists exactly as it does in an extension page.
    const { port } = server.address() as { port: number };
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.addScriptTag({ content: built.outputFiles[0]!.text });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("streams a turn and signs a Bedrock request with Web Crypto", async () => {
    const result = await page.evaluate(() => (window as unknown as { runLlmSmoke: () => Promise<{ events: Array<{ type: string; text?: string; reason?: string }>; authorization: string }> }).runLlmSmoke());
    expect(result.events.filter((e) => e.type === "text_delta").map((e) => e.text).join("")).toBe("Hello from the browser");
    expect(result.events).toContainEqual({ type: "stop_reason", reason: "end_turn" });
    expect(result.authorization).toContain("Signature=d8ef1d06a859a84e3e90fdd2aea3e9e998a36d07f934fbf720fc41a27ee22fe2");
  });
});
