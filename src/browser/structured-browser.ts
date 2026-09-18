import { randomUUID } from "node:crypto";
import type { ElementHandle, Frame, Page } from "playwright-core";
import type { BrowserApprovalCoordinator } from "./approval-coordinator.js";
import { BrowserPolicyError, cancelled, type BrowserField } from "./approval-types.js";
import { redactedUrl } from "./domain-policy.js";


const elementMetadata = (el: any) => ({ label: el.getAttribute("aria-label") || el.labels?.[0]?.textContent || el.getAttribute("name") || el.textContent?.slice(0, 200) || el.tagName, type: el.type || el.tagName.toLowerCase(), value: el.type === "password" ? "" : (el.isContentEditable ? el.textContent : el.value) ?? "", checked: !!el.checked, connected: el.isConnected, protected: el.type === "password" || el.type === "file" || /password|one-time-code|cc-|credit.?card|otp|secret|token/i.test([el.autocomplete, el.name, el.id, el.getAttribute("aria-label")].join(" ")), form: el.form ? { action: el.form.action, method: el.form.method } : null });
type Metadata = { label: string; type: string; value: string; checked: boolean; connected: boolean; protected: boolean; form: { action: string; method: string } | null };
interface Target { handle: ElementHandle; frame: Frame; document: string; metadata: Metadata }

/** Stable handles and host-issued document IDs bind proposals to actual nodes, not selectors. */
export class StructuredBrowser {
  private refs = new Map<string, Target>();
  private documents = new WeakMap<Frame, string>();
  private frameIds = new WeakMap<Frame, string>();
  private observed = new WeakSet<Page>();
  constructor(private approvals: () => BrowserApprovalCoordinator | undefined) {}
  private observe(page: Page): void {
    if (this.observed.has(page)) return;
    this.observed.add(page);
    page.on("framenavigated", frame => { this.documents.set(frame, randomUUID()); });
  }
  private document(frame: Frame): string {
    if (!this.documents.has(frame)) this.documents.set(frame, randomUUID());
    return this.documents.get(frame)!;
  }
  frameId(frame: Frame): string { if (!this.frameIds.has(frame)) this.frameIds.set(frame, randomUUID()); return this.frameIds.get(frame)!; }
  private frame(page: Page, p: Record<string, unknown>): Frame {
    this.observe(page);
    if (!p.frame) return page.mainFrame();
    const frame = page.frames().find(f => this.frameId(f) === p.frame);
    if (!frame) throw new BrowserPolicyError("stale_target", "Frame is no longer available. Take a fresh snapshot.");
    return frame;
  }
  async assertNoProtectedData(page: Page): Promise<void> {
    for (const frame of page.frames()) {
      const sensitive = await frame.evaluate(() => {
        const doc = (globalThis as any).document;
        return [...doc.querySelectorAll("input,textarea")].some((el: any) => el.value && (el.type === "password" || /one-time-code|cc-|credit.?card|otp|secret|token/i.test([el.autocomplete, el.name, el.id].join(" "))));
      });
      if (sensitive) throw new BrowserPolicyError("manual_required", "This page contains protected field values. Clear them or use manual control before capture, script execution or automated submission.");
    }
  }
  async snapshot(page: Page, p: Record<string, unknown>): Promise<unknown> {
    const frame = this.frame(page, p);
    for (const target of this.refs.values()) await target.handle.dispose().catch(() => {});
    this.refs.clear();
    const handles = await frame.$$("input,textarea,select,button,a[href],[contenteditable=true],[role=button],[role=checkbox]");
    const elements = [];
    for (const handle of handles.slice(0, 200)) {
      const metadata = await handle.evaluate(elementMetadata) as Metadata;
      const ref = randomUUID();
      this.refs.set(ref, { handle, frame, document: this.document(frame), metadata });
      elements.push({ ref, label: metadata.label, type: metadata.type, protected: metadata.protected, value: metadata.protected ? "[manual entry only]" : metadata.value.slice(0, 1000), checked: metadata.checked });
    }
    for (const handle of handles.slice(200)) await handle.dispose();
    return { ok: true, document: this.document(frame), frame: this.frameId(frame), url: redactedUrl(frame.url()), title: await page.title(), frames: page.frames().map(f => ({ frame: this.frameId(f), url: redactedUrl(f.url()) })), elements, truncated: handles.length > 200 };
  }
  private async target(page: Page, p: Record<string, unknown>): Promise<Target> {
    const frame = this.frame(page, p);
    if (typeof p.ref === "string") {
      const target = this.refs.get(p.ref);
      if (!target || target.frame !== frame) throw new BrowserPolicyError("stale_target", "Unknown reference or wrong frame. Take a fresh snapshot.");
      await this.check(target);
      return { ...target, metadata: await target.handle.evaluate(elementMetadata) as Metadata };
    }
    if (typeof p.selector !== "string" || !p.selector) throw new BrowserPolicyError("target_not_found", "Supply an element ref or unique selector.");
    const locator = frame.locator(p.selector);
    const count = await locator.count();
    if (count !== 1) throw new BrowserPolicyError(count ? "ambiguous_target" : "target_not_found", `Selector matched ${count} targets.`);
    const handle = await locator.elementHandle();
    if (!handle) throw new BrowserPolicyError("target_not_found", "Target disappeared.");
    return { handle, frame, document: this.document(frame), metadata: await handle.evaluate(elementMetadata) as Metadata };
  }
  private async check(target: Target, original?: Metadata): Promise<void> {
    if (target.frame.isDetached() || this.document(target.frame) !== target.document) throw new BrowserPolicyError("stale_target", "Document changed while approval was pending.");
    const now = await target.handle.evaluate(elementMetadata) as Metadata;
    if (!now.connected || now.protected || (original && JSON.stringify(now) !== JSON.stringify(original))) throw new BrowserPolicyError("stale_target", "Target or reviewed field changed. Inspect the page before retrying.");
  }
  private coordinator(): BrowserApprovalCoordinator {
    const coordinator = this.approvals();
    if (!coordinator) throw new BrowserPolicyError("approval_required", "No independent browser approver is available. This lane must pause for human input.");
    return coordinator;
  }
  async fill(page: Page, p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const fields = Array.isArray(p.fields) ? p.fields as Record<string, unknown>[] : [{ ...p, value: p.text }];
    if (!fields.length || fields.length > 30) throw new Error("A form proposal must have 1–30 fields.");
    const targets = await Promise.all(fields.map(f => this.target(page, { frame: p.frame, ...f })));
    const proposalFields: BrowserField[] = fields.map((f, i) => {
      const target = targets[i]!;
      if (target.metadata.protected) throw new BrowserPolicyError("manual_required", "Passwords, OTPs, uploads and payment/secret fields require manual entry.");
      const type = target.metadata.type;
      const value = f.value;
      if ((type === "checkbox" || type === "radio") ? typeof value !== "boolean" : typeof value !== "string") throw new Error("Text/select values must be strings; checkbox/radio values must be booleans.");
      if (typeof value === "string" && value.length > 100_000) throw new Error("Input exceeds the 100,000 character review limit.");
      return { target: String(f.ref ?? f.selector), label: target.metadata.label, type, mode: f.mode === "append" ? "append" : "replace", value: f.mode === "append" && typeof value === "string" ? target.metadata.value + value : value as string | boolean };
    });
    const frame = targets[0]!.frame;
    if (targets.some(t => t.frame !== frame)) throw new Error("A form proposal must target one frame.");
    const coordinator = this.coordinator();
    const approved = await coordinator.approve({ kind: "input", operation: "fill", origin: new URL(frame.url()).origin, url: redactedUrl(frame.url()), title: await page.title(), document: targets[0]!.document, purpose: "Enter these exact final values. Entry can trigger autosave or suggestions and exposes values to this page. This does not submit the form.", fields: proposalFields }, signal);
    const completed: number[] = [];
    try {
      for (const target of targets) await this.check(target, target.metadata);
      for (let i = 0; i < targets.length; i++) {
        cancelled(signal);
        coordinator.assertCurrent(approved, signal);
        const target = targets[i]!;
        await this.check(target, target.metadata);
        coordinator.assertCurrent(approved, signal);
        const value = approved.fields[i]!.value;
        if (typeof value === "boolean") await target.handle.setChecked(value, { timeout: 10_000 });
        else if (target.metadata.type.startsWith("select")) await target.handle.selectOption(value, { timeout: 10_000 });
        else await target.handle.fill(value, { timeout: 10_000 });
        completed.push(i);
      }
      return { ok: true, proposalId: approved.id, executedValues: approved.fields.map(f => f.value), completed, submitted: false };
    } catch (e) {
      return { ok: false, code: completed.length ? "partial_execution" : e instanceof BrowserPolicyError ? e.code : "entry_failed", completed, blockedStep: completed.length, skipped: fields.map((_, i) => i).filter(i => i > completed.length), error: e instanceof Error ? e.message : "Entry failed; inspect state before retrying.", replaySafe: false };
    }
  }
  async click(page: Page, p: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const target = await this.target(page, p);
    if (target.metadata.protected) throw new BrowserPolicyError("manual_required", "Protected targets require manual interaction.");
    await this.assertNoProtectedData(page);
    const formValues = (el: any) => el.form ? [...el.form.elements].map((field: any) => ({ target: field.name || field.id || field.tagName, label: field.getAttribute("aria-label") || field.labels?.[0]?.textContent || field.name || field.tagName, type: field.type || field.tagName.toLowerCase(), mode: "replace" as const, value: ["checkbox", "radio"].includes(field.type) ? !!field.checked : String(field.value ?? "") })) : [];
    const fields = await target.handle.evaluate(formValues) as BrowserField[];
    if (fields.length > 100 || JSON.stringify(fields).length > 100_000) throw new BrowserPolicyError("manual_required", "Form is too large for automated submission review.");
    await this.coordinator().approve({ kind: "action", operation: "click", origin: new URL(target.frame.url()).origin, url: redactedUrl(target.frame.url()), title: await page.title(), document: target.document, purpose: `Click ${target.metadata.label}. This may submit a form or change external state. ${target.metadata.form ? JSON.stringify({ ...target.metadata.form, action: redactedUrl(target.metadata.form.action) }) : "Destination/effect is not verified."}`, fields }, signal);
    cancelled(signal);
    await this.check(target, target.metadata);
    if (JSON.stringify(fields) !== JSON.stringify(await target.handle.evaluate(formValues))) throw new BrowserPolicyError("stale_target", "Form values changed during submission review.");
    await target.handle.click({ timeout: 10_000 });
    return { ok: true, clicked: target.metadata.label, replaySafe: false };
  }
  async approveAction(page: Page, action: string, p: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const frame = this.frame(page, p);
    const document = this.document(frame);
    const script = action === "evaluate" || action === "capture_matrix";
    await this.coordinator().approve({ kind: script ? "script" : "action", operation: action, origin: frame.url() === "about:blank" ? "local-preview" : new URL(frame.url()).origin, url: redactedUrl(frame.url()), title: await page.title(), document, purpose: script ? "Privileged local test script. This can transmit data, modify fields and bypass exact-value entry review. Only approve trusted local test code." : `Local browser ${action}; may trigger page events or submission.`, fields: [{ target: action, label: "Exact operation payload", type: "operation", mode: "replace", value: JSON.stringify(p, null, 2) }] }, signal);
    cancelled(signal);
    if (document !== this.document(frame)) throw new BrowserPolicyError("stale_target", "Page navigated during approval.");
  }
}
