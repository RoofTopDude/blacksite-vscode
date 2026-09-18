import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ChromiumRunner } from "../../src/chromium-runner.js";
import { BrowserApprovalCoordinator } from "../../src/browser/approval-coordinator.js";
import { DomainPolicy } from "../../src/browser/domain-policy.js";
import type { BrowserDecision, BrowserProposal } from "../../src/browser/approval-types.js";
import { workspace } from "vscode";

describe("real Chromium shared approval boundary", () => {
  let server: http.Server;
  let deniedServer: http.Server;
  let origin: string;
  let deniedOrigin: string;
  let deniedRequests = 0;
  let inputEvents = 0;
  let runner: ChromiumRunner;
  let decide: (p: BrowserProposal) => Promise<BrowserDecision>;
  const serve = (s: http.Server) => new Promise<string>(r => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
  beforeAll(async () => {
    deniedServer = http.createServer((_req, res) => { deniedRequests++; res.end("denied"); });
    deniedOrigin = await serve(deniedServer);
    server = http.createServer((req, res) => {
      if (req.url === "/redirect") { res.writeHead(302, { Location: deniedOrigin }); res.end(); return; }
      if (req.url?.startsWith("/event")) { inputEvents++; res.end("ok"); return; }
      res.setHeader("content-type", "text/html");
      res.end(`<title>Fixture</title><form><label>Search<input name="q" id="q" oninput="fetch('/event')"></label><label>Notes<textarea id="notes"></textarea></label><select id="pick"><option value="one">One</option><option value="two">Two</option></select><input type="checkbox" id="check"><button>Submit</button></form><script>setTimeout(()=>fetch('${deniedOrigin}/delayed').catch(()=>{}),100);</script>`);
    });
    origin = await serve(server);
    vi.spyOn(workspace, "getConfiguration").mockReturnValue({ get: (key: string) => key === "browserHeadless" ? true : undefined } as never);
    runner = new ChromiumRunner();
    decide = async p => ({ id: p.id, decision: "allow" });
    runner.setApprovalCoordinator(new BrowserApprovalCoordinator(new DomainPolicy(), { ask: p => decide(p) }));
  });
  afterAll(async () => { await runner?.dispose(); await Promise.all([server, deniedServer].map(s => new Promise<void>(r => s?.close(() => r())))); });
  const dispatch = async (action: string, payload: Record<string, unknown>) => runner.dispatch(action, payload, undefined, { localOnly: true, allowedOrigins: [origin] }) as Promise<any>;
  it("navigates local fixtures while blocking redirect destinations and delayed background traffic", async () => {
    const navigation = await dispatch("navigate", { url: origin });
    if (!navigation.ok) throw new Error(JSON.stringify(navigation));
    await new Promise(r => setTimeout(r, 300));
    expect(deniedRequests).toBe(0);
    await dispatch("navigate", { url: `${origin}/redirect` });
    expect(deniedRequests).toBe(0);
    expect(await runner.dispatch("navigate", { url: "https://example.com" })).toMatchObject({ ok: false, code: "capability_unavailable" });
  });
  it("emits zero input events before approval; human edits are the only values executed", async () => {
    const navigation = await dispatch("navigate", { url: origin });
    if (!navigation.ok) throw new Error(JSON.stringify(navigation));
    let pending!: BrowserProposal;
    let finish!: (d: BrowserDecision) => void;
    decide = p => { pending = p; return new Promise(r => { finish = r; }); };
    const eventsBefore = inputEvents;
    const fill = dispatch("fill_form", { fields: [{ selector: "#q", value: "proposed" }, { selector: "#notes", value: "line1\nline2" }, { selector: "#pick", value: "two" }, { selector: "#check", value: true }] });
    await vi.waitFor(() => expect(pending).toBeDefined());
    expect(inputEvents).toBe(eventsBefore); expect(pending.fields).toHaveLength(4);
    finish({ id: pending.id, decision: "edit", values: ["human correction", "line1\nline2", "two", true] });
    expect(await fill).toMatchObject({ ok: true, executedValues: ["human correction", "line1\nline2", "two", true], submitted: false });
    await vi.waitFor(() => expect(inputEvents).toBe(eventsBefore + 1));
    const snapshot = await dispatch("snapshot", {});
    expect(snapshot.elements.find((e: any) => e.label === "Search").value).toBe("human correction");
  });
  it("denied nested input hard-stops even continueOnError batches", async () => {
    decide = async p => ({ id: p.id, decision: "deny" });
    const result = await dispatch("run_script", { continueOnError: true, steps: [{ action: "type", selector: "#q", text: "denied" }, { action: "type", selector: "#notes", text: "must not execute" }] });
    expect(result).toMatchObject({ ok: false, skipped: [1], stepCount: 1 });
    expect(await dispatch("key", { key: "Control+V" })).toMatchObject({ ok: false, code: "denied" });
    expect(await dispatch("evaluate", { script: "document.querySelector('#q').value='bypass'" })).toMatchObject({ ok: false, code: "denied" });
  });
  it("rejects a node replaced while approval is pending", async () => {
    decide = async p => ({ id: p.id, decision: "allow" });
    await dispatch("evaluate", { script: "setTimeout(() => { const e=document.querySelector('#q'); e.outerHTML=e.outerHTML; }, 300);" });
    decide = async p => { await new Promise(r => setTimeout(r, 600)); return { id: p.id, decision: "allow" }; };
    expect(await dispatch("type_text", { selector: "#q", text: "stale" })).toMatchObject({ ok: false, code: "stale_target", completed: [] });
  });
  it("blocks popup initial requests, cross-origin frames and websocket setup", async () => {
    decide = async p => ({ id: p.id, decision: "allow" });
    expect(await dispatch("navigate", { url: origin })).toMatchObject({ ok: true });
    const triggered = await dispatch("evaluate", { script: `window.open('${deniedOrigin}/popup'); const frame=document.createElement('iframe'); frame.src='${deniedOrigin}/frame'; document.body.append(frame); new WebSocket('${deniedOrigin.replace('http:', 'ws:')}/socket');` });
    expect(triggered).toMatchObject({ ok: true });
    await new Promise(r => setTimeout(r, 300));
    expect(deniedRequests).toBe(0);
    expect((await dispatch("tabs", {})).tabs.length).toBeGreaterThan(1);
  });
  it("reports completed fields on partial entry and never replays them", async () => {
    decide = async p => ({ id: p.id, decision: "allow" });
    await dispatch("evaluate", { script: "document.querySelector('#q').oninput=()=>document.querySelector('#notes')?.remove()" });
    const result = await dispatch("fill_form", { fields: [{ selector: "#q", value: "first" }, { selector: "#notes", value: "second" }] });
    expect(result).toMatchObject({ ok: false, code: "partial_execution", completed: [0], blockedStep: 1, replaySafe: false });
  });
  it("requires manual handling for protected fields and prevents their capture", async () => {
    await dispatch("evaluate", { script: "document.querySelector('#q').type='password'; document.querySelector('#q').value='private'" });
    expect(await dispatch("type_text", { selector: "#q", text: "must not enter" })).toMatchObject({ ok: false, code: "manual_required" });
    expect(await dispatch("screenshot", {})).toMatchObject({ ok: false, code: "manual_required" });
    const snapshot = await dispatch("snapshot", {});
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });
});
