import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";

/* The plan run surfaces, against the real built webview: the run bar and its controls, the step
   list, the preflight card and what it sends, the Header pill on another page, the seam on an
   automatic turn, the note a stopped turn leaves, and the diff on an edit approval. */

interface FixtureWindow extends Window {
  __messages: Array<{ type?: string; [key: string]: unknown }>;
}

function runView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run_1", planId: "plan_1", planTitle: "Migrate billing", status: "running", liveState: "working",
    startedAt: Date.now() - 600_000, elapsedMs: 600_000, activeMs: 540_000, waitingUserMs: 60_000, waitingProviderMs: 0,
    spentUsd: 1.84, spendPartial: false, maxUsd: 5, phaseIndex: 2, phaseCount: 3, phaseTitle: "Ledger",
    stepsDone: 3, stepsTotal: 7, stepPosition: 4,
    currentStep: { phaseId: "p2", stepId: "s2", title: "Backfill invoices" },
    nextStep: { phaseId: "p2", stepId: "s3", title: "Reconcile totals" },
    medianStepMs: 180_000,
    phases: [
      { id: "p1", title: "Schema", status: "completed", steps: [
        { id: "s1", title: "Add columns", status: "completed", attempts: 1, restorable: true, durationMs: 120_000, startedAt: Date.now() - 600_000, endedAt: Date.now() - 480_000, evidence: { checks: ["npm test"], unverified: [], filesChanged: ["db/schema.ts"], at: "" } },
        { id: "s2", title: "Migrate rows", status: "completed", attempts: 2, restorable: true, durationMs: 200_000, evidence: { checks: [], unverified: ["db/migrate.ts"], filesChanged: ["db/migrate.ts"], at: "" } },
      ] },
      { id: "p2", title: "Ledger", status: "in_progress", steps: [
        { id: "s1", title: "Write ledger", status: "completed", attempts: 1, restorable: false },
        { id: "s2", title: "Backfill invoices", status: "in_progress", attempts: 1, restorable: false },
        { id: "s3", title: "Reconcile totals", status: "pending", attempts: 0, restorable: false },
      ] },
      { id: "p3", title: "Cleanup", status: "pending", steps: [
        { id: "s1", title: "Drop old table", status: "pending", attempts: 0, restorable: false },
        { id: "s2", title: "Docs", status: "pending", attempts: 0, restorable: false },
      ] },
    ],
    turns: 4, retries: 0, compactions: 1, pauseRequested: false, hasBaseline: true, hasReport: false,
    whenBlocked: "defer", deferAfterMinutes: 2, allow: ["project_scripts"], tripwiresOn: true,
    decisions: [], openDecisions: 0, autoAllowed: 0, tripwires: [],
    ...overrides,
  };
}

describe("built chat webview — plan runs", () => {
  let browser: Browser;
  let page: Page;
  let server: http.Server;
  const root = path.resolve("out/webview");

  const post = (message: Record<string, unknown>): Promise<void> => page.evaluate((m) => window.postMessage(m, "*"), message);
  const sent = (): Promise<FixtureWindow["__messages"]> => page.evaluate(() => (window as unknown as FixtureWindow).__messages);

  beforeAll(async () => {
    if (!fs.existsSync(path.join(root, "shell.html"))) throw new Error("Run npm run build before npm run test:browser.");
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://fixture").pathname;
      if (pathname === "/") {
        res.setHeader("content-type", "text/html");
        res.end(fs.readFileSync(path.join(root, "shell.html"), "utf8")
          .replaceAll("{{cspSource}}", "'self'").replaceAll("{{nonce}}", "testnonce")
          .replaceAll("{{fontsBase}}", "/fonts").replaceAll("{{scriptUri}}", "/webview.js"));
        return;
      }
      const target = path.resolve(root, `.${pathname}`);
      if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) { res.writeHead(404); res.end(); return; }
      res.setHeader("content-type", pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "application/octet-stream");
      res.end(fs.readFileSync(target));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const executablePath = process.platform === "win32"
      ? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(fs.existsSync)
      : undefined;
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage({ viewport: { width: 680, height: 1000 } });
    await page.addInitScript(() => {
      const win = window as unknown as FixtureWindow & { acquireVsCodeApi: unknown };
      win.__messages = [];
      win.acquireVsCodeApi = () => ({
        postMessage: (m: unknown) => win.__messages.push(m as { type?: string }),
        getState: () => ({}),
        setState: () => undefined,
      });
    });
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await page.getByRole("button", { name: "Settings", exact: true }).waitFor();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("shows where the run is, what it is doing, and what it has cost", async () => {
    await post({ type: "plan_run_state", run: runView() });
    const rail = page.getByRole("region", { name: "Plan run" });
    await rail.waitFor();
    await expect(rail.textContent()).resolves.toContain("Migrate billing");
    await expect(rail.textContent()).resolves.toContain("Step 4/7");
    await expect(rail.textContent()).resolves.toContain("Phase 2/3");
    await expect(rail.textContent()).resolves.toContain("$1.84");
    await expect(rail.textContent()).resolves.toContain("Next: Reconcile totals");
    expect(await page.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3");
  });

  it("pauses and stops through the host, and opens the step list with timings and evidence", async () => {
    await page.getByRole("button", { name: "Pause" }).click();
    await page.getByRole("button", { name: "Stop" }).click();
    const types = (await sent()).map((message) => message.type);
    expect(types).toContain("plan_run_pause");
    expect(types).toContain("plan_run_stop");

    await page.getByRole("button", { name: "Steps" }).click();
    const steps = page.getByRole("list", { name: "Plan steps" });
    await steps.waitFor();
    await page.getByRole("button", { name: /Phase 1/ }).click();
    const text = await steps.textContent();
    expect(text).toContain("Add columns");
    expect(text).toContain("npm test");
    expect(text).toContain("1 unverified");
    expect(text).toContain("tried 2×");
    await page.getByRole("button", { name: "Restore to here" }).first().click();
    expect((await sent()).some((message) => message.type === "plan_run_restore_step" && message.phaseId === "p1" && message.stepId === "s1")).toBe(true);
  });

  it("says plainly when the run needs the user, and offers Resume once paused", async () => {
    await post({ type: "plan_run_state", run: runView({ liveState: "needs_you", status: "waiting_user" }) });
    await page.getByRole("region", { name: "Plan run" }).filter({ hasText: "Waiting for you" }).waitFor();
    await post({ type: "plan_run_state", run: runView({ liveState: "paused", status: "paused", endReason: "Paused by you." }) });
    await page.getByRole("button", { name: "Resume" }).click();
    expect((await sent()).some((message) => message.type === "plan_run_resume")).toBe(true);
  });

  it("counts down to the next attempt while the provider is down, and retries on request", async () => {
    await post({ type: "plan_run_state", run: runView({ liveState: "provider", status: "waiting_provider", providerRetryAt: Date.now() + 90_000 }) });
    await page.getByRole("region", { name: "Plan run" }).filter({ hasText: /trying again in 1m/ }).waitFor();
    await page.getByRole("button", { name: "Retry now" }).click();
    expect((await sent()).some((message) => message.type === "plan_run_retry_provider")).toBe(true);
  });

  it("keeps the run in view from another page through the Header pill", async () => {
    await post({ type: "attention_state", items: [{ id: "gate::a", kind: "approval", severity: "needs_you", source: "chat", title: "Approval needed", at: Date.now() }] });
    await page.getByRole("button", { name: "Conversation history" }).click();
    const pill = page.getByRole("button", { name: /Needs you/ });
    await pill.waitFor();
    await pill.click();
    await page.getByRole("region", { name: "Plan run" }).waitFor();
    await post({ type: "attention_state", items: [] });
  });

  it("reads the plan before a run and sends the limits the user chose", async () => {
    await post({
      type: "plan_run_preflight",
      report: {
        planId: "plan_1", planTitle: "Migrate billing", stepsOpen: 4, stepsTotal: 7, phaseCount: 3,
        findings: [{ level: "warn", message: "2 open steps have no definition of done, so the run cannot tell finished from nearly finished.", fix: "Add acceptance criteria.", examples: ["Docs"] }],
        projects: [{ name: "billing-service", root: "services/billing", files: 4, issues: ["Node 20 is required; 18 is installed."] }],
        moreProjects: 0, approvalMode: "ask", defaultMaxUsd: 5, canStart: true,
        isolation: { available: true, branch: "main", head: "abc1234", dirtyFiles: 2, notes: [] },
      },
    });
    const dialog = page.getByRole("dialog", { name: "Start a plan run" });
    await dialog.waitFor();
    expect(await dialog.textContent()).toContain("no definition of done");
    expect(await dialog.textContent()).toContain("Node 20 is required");
    await page.getByLabel("Time limit in minutes").fill("90");
    await page.getByRole("button", { name: "Start run" }).click();
    const start = (await sent()).find((message) => message.type === "plan_run_start") as { planId?: string; charter?: Record<string, unknown> } | undefined;
    expect(start?.planId).toBe("plan_1");
    // Queue-and-carry-on is the default, with the two routine permissions ticked and tripwires on.
    expect(start?.charter).toMatchObject({ maxUsd: 5, maxMinutes: 90, whenBlocked: "defer", deferAfterMinutes: 2, tripwires: true, notifications: "attention" });
    expect(start?.charter?.allow).toEqual(["install_dependencies", "project_scripts"]);
    expect(start?.charter?.isolated).toBeUndefined();
    expect(start?.charter?.pauseWhenBlockedMinutes).toBeUndefined();
    await page.getByRole("dialog", { name: "Start a plan run" }).waitFor({ state: "detached" });
  });

  it("starts in an isolated copy with the push permission only there, and explains when it cannot", async () => {
    const report = {
      planId: "plan_2", planTitle: "Ship invoices", stepsOpen: 2, stepsTotal: 2, phaseCount: 1, findings: [], projects: [],
      moreProjects: 0, approvalMode: "auto", canStart: true,
      isolation: { available: true, branch: "main", head: "abc1234", dirtyFiles: 3, notes: ["Submodules are not checked out in the copy."] },
    };
    await post({ type: "plan_run_preflight", report });
    const dialog = page.getByRole("dialog", { name: "Start a plan run" });
    await dialog.waitFor();
    const push = dialog.getByRole("checkbox", { name: /push the run's own branch/i });
    expect(await push.isDisabled()).toBe(true);
    await dialog.getByRole("button", { name: "Isolated copy" }).click();
    expect(await dialog.textContent()).toContain("3 uncommitted changes stay here");
    expect(await dialog.textContent()).toContain("Submodules are not checked out");
    await push.check();
    await dialog.getByRole("checkbox", { name: /install the dependencies/i }).uncheck();
    await dialog.getByLabel("When blocked on you").selectOption("pause");
    await dialog.getByRole("button", { name: "Start in a copy" }).click();
    await dialog.waitFor({ state: "detached" });
    const start = (await sent()).filter((message) => message.type === "plan_run_start").at(-1) as { charter?: Record<string, unknown> } | undefined;
    expect(start?.charter).toMatchObject({ isolated: true, whenBlocked: "pause", pauseWhenBlockedMinutes: 30 });
    expect(start?.charter?.allow).toEqual(["project_scripts", "push_run_branch"]);

    await post({ type: "plan_run_preflight", report: { ...report, isolation: { available: false, reason: "This folder is not in a git repository, so an isolated copy cannot be made.", dirtyFiles: 0, notes: [] } } });
    await dialog.waitFor();
    expect(await dialog.getByRole("button", { name: "Isolated copy" }).isDisabled()).toBe(true);
    expect(await dialog.textContent()).toContain("not in a git repository");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
  });

  it("lists queued decisions and sends the user's answers", async () => {
    await post({
      type: "plan_run_state",
      run: runView({
        openDecisions: 2,
        isolation: { branch: "blacksite/run-migrate-billing-a1b2c3", baseBranch: "main", baseHead: "abc1234", sourceRoot: "/w", worktreePath: "/home/u/.blacksite/worktrees/w-a1b2c3" },
        tripwires: [{ at: Date.now(), kind: "mass_delete", title: "Many files were deleted", detail: "The last step deleted 31 files." }],
        decisions: [
          { id: "D1", kind: "approval", description: "Run `git push origin main` (network operation)", tier: "network", stepTitle: "Backfill invoices", at: Date.now() - 300_000, status: "open" },
          { id: "D2", kind: "question", description: "Which database?", at: Date.now() - 60_000, status: "open", questions: [{ question: "Which database?", options: [{ key: "pg", label: "Postgres" }, { key: "my", label: "MySQL" }] }] },
          { id: "D0", kind: "edit", description: "Apply changes to 1 file(s)", at: Date.now() - 900_000, status: "declined", answer: "Declined" },
        ],
      }),
    });
    const rail = page.getByRole("region", { name: "Plan run" });
    await rail.filter({ hasText: "copy" }).waitFor();
    await page.getByRole("button", { name: /Decisions · 2/ }).click();
    const queue = page.getByRole("region", { name: "Queued decisions" });
    await queue.waitFor();
    const text = await queue.textContent();
    expect(text).toContain("git push origin main");
    expect(text).toContain("During “Backfill invoices”");
    expect(text).toContain("declined");

    await queue.getByRole("button", { name: "Approve" }).click();
    expect((await sent()).some((message) => message.type === "plan_run_decision" && message.id === "D1" && message.outcome === "approve")).toBe(true);

    const send = queue.getByRole("button", { name: "Send answer" });
    expect(await send.isDisabled()).toBe(true);
    await queue.getByRole("button", { name: "Postgres" }).click();
    await send.click();
    const answer = (await sent()).find((message) => message.type === "plan_run_decision" && message.id === "D2") as { outcome?: string; answers?: string[][] } | undefined;
    expect(answer).toMatchObject({ outcome: "answer", answers: [["pg"]] });
    await page.getByRole("button", { name: /Decisions · 2/ }).click();
  });

  it("explains an automatic turn with a seam, and leaves a note where a turn stopped short", async () => {
    await post({ type: "stream_start", id: "turn-auto", origin: "conductor", seam: "Continued — the next step is clear" });
    await post({ type: "stream_delta", id: "turn-auto", text: "Working on it." });
    await post({ type: "stream_end", id: "turn-auto", stopReason: "max_iterations", iterations: 40 });
    await post({ type: "run_handoff", id: "turn-auto", reason: "max_iterations", text: "Stopped: Reached the 40-round limit for one request.\nWhere it got to: step 4/7" });
    await page.getByRole("note").filter({ hasText: "Continued — the next step is clear" }).waitFor();
    const note = page.getByRole("note").filter({ hasText: "Stopped at the round limit" });
    await note.waitFor();
    expect(await note.textContent()).toContain("step 4/7");
  });

  it("shows what an edit approval would change in the card that asks", async () => {
    await post({ type: "stream_start", id: "turn-edit" });
    await post({
      type: "stream_approval_pending", id: "turn-edit", toolCallId: "edit_approval_1", tier: "write",
      description: "Apply changes to 1 file(s)",
      previews: [{ path: "src/a.ts", additions: 1, deletions: 1, truncated: false, lines: [
        { kind: "context", text: "const x = 1;", line: 1 }, { kind: "del", text: "const y = 2;" }, { kind: "add", text: "const y = 3;", line: 2 },
      ] }],
    });
    const changes = page.getByLabel("Proposed changes");
    await changes.waitFor();
    const text = await changes.textContent();
    expect(text).toContain("src/a.ts");
    expect(text).toContain("const y = 3;");
    await post({ type: "stream_end", id: "turn-edit", stopReason: "end_turn" });
  });
});
