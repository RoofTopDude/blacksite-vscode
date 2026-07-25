import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import {
  X, CornerDownLeft, Slash, Paperclip, FileText, Loader2, ClipboardCheck, SearchCode, Wrench, GitBranchPlus,
  Image, AudioLines, FileCode, FileArchive, FileSpreadsheet, Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import { estimateTokens } from "@/lib/tokens";
import { formatBytes } from "@/lib/format";
import { userPromptHistory, type RecalledPrompt } from "@/lib/chat-model";
import {
  isSlashInput, matchSlashCommands, parseSlashInput, resolveSlashCommand,
  slashQuery, slashUsage, type SlashCommandDef,
} from "@/lib/slash-commands";
import { PendingBar } from "./PendingBar";
import { QuickSettings } from "./QuickSettings";
import { SlashHelp } from "./SlashHelp";
import type { ReferenceAttachmentInfo, RequestMode } from "@/lib/protocol";

interface MentionState { open: boolean; query: string; start: number; active: number; }

const CLOSED: MentionState = { open: false, query: "", start: -1, active: 0 };

const BLUEPRINTS = [
  {
    id: "plan",
    mode: "plan",
    label: "Plan",
    icon: GitBranchPlus,
    prompt: "Planning goal:\n\nContext:\n- \n\nConstraints and non-goals:\n- \n\nPlease research the relevant code and produce an implementation-ready, phase-by-phase plan. Surface material decisions as focused questions and do not implement yet.",
  },
  {
    id: "fix",
    mode: "debug",
    label: "Fix",
    icon: Wrench,
    prompt: "Problem:\n\nObserved behavior:\n\nExpected behavior:\n\nRelevant files or errors:\n- \n\nPlease reproduce or trace the issue, make the fix, and run targeted validation.",
  },
  {
    id: "review",
    mode: "review",
    label: "Review",
    icon: ClipboardCheck,
    prompt: "Review focus:\n- Bugs or regressions\n- Missing validation\n- UX or maintainability risks\n\nScope:\n\nPlease lead with findings, include file/line references, and separate assumptions from confirmed issues.",
  },
  {
    id: "trace",
    mode: "review",
    label: "Trace",
    icon: SearchCode,
    prompt: "Trace this workflow end to end:\n\nEntry point:\n\nState or message path:\n\nWhat I need to understand:\n\nPlease map the contracts, likely failure points, and the safest change path.",
  },
] as const;

const MODE_OPTIONS: ReadonlyArray<{ id: RequestMode; label: string; title: string }> = [
  { id: "auto", label: "Auto", title: "Infer a specialized profile only when the request is unambiguous" },
  { id: "plan", label: "Plan", title: "Research and author a durable plan without implementation" },
  { id: "review", label: "Review", title: "Perform evidence-led, read-only review by default" },
  { id: "debug", label: "Debug", title: "Reproduce, isolate root cause, fix, and validate" },
];

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // dataUrl looks like "data:<mime>;base64,<data>" — strip the prefix.
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

const MAX_WEBVIEW_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MAX_WEBVIEW_ATTACHMENT_FILES = 12;
const MAX_WEBVIEW_ATTACHMENT_BATCH_BYTES = 64 * 1024 * 1024;

async function attachPastedFiles(files: File[]): Promise<void> {
  const eligible = files.filter((file) => file.size > 0 && file.size <= MAX_WEBVIEW_ATTACHMENT_BYTES);
  if (eligible.length === 0) {
    actions.setAttachError(`Select a non-empty file smaller than ${Math.floor(MAX_WEBVIEW_ATTACHMENT_BYTES / 1024 / 1024)} MB.`);
    return;
  }
  const batchBytes = eligible.reduce((total, file) => total + file.size, 0);
  if (eligible.length > MAX_WEBVIEW_ATTACHMENT_FILES || batchBytes > MAX_WEBVIEW_ATTACHMENT_BATCH_BYTES) {
    actions.setAttachError(`Attach up to ${MAX_WEBVIEW_ATTACHMENT_FILES} files totaling ${Math.floor(MAX_WEBVIEW_ATTACHMENT_BATCH_BYTES / 1024 / 1024)} MB at a time.`);
    return;
  }
  const payload: Array<{ name: string; mimeType: string; base64: string }> = [];
  for (const file of eligible) {
    try {
      const base64 = await readFileAsBase64(file);
      payload.push({ name: file.name || "pasted-file", mimeType: file.type || "application/octet-stream", base64 });
    } catch {
      // Keep a corrupt clipboard entry from blocking the rest of this batch.
    }
  }
  if (payload.length) actions.attachPastedFiles(payload);
  else actions.setAttachError("The selected file could not be read by VS Code.");
}

function AttachmentIcon({ kind }: { kind: ReferenceAttachmentInfo["kind"] }) {
  const Icon = kind === "image"
    ? Image
    : kind === "audio"
      ? AudioLines
      : kind === "code"
        ? FileCode
        : kind === "data"
          ? FileSpreadsheet
          : kind === "archive"
            ? FileArchive
            : FileText;
  return <Icon className="size-3.5 shrink-0 text-primary" />;
}

function attachmentLabel(attachment: ReferenceAttachmentInfo): string {
  switch (attachment.kind) {
    case "image": return "Image";
    case "audio": return "Audio";
    case "video": return "Video";
    case "document": return "Document";
    case "code": return "Code";
    case "data": return "Data";
    case "archive": return "Archive";
    default: return "File";
  }
}

export function InputDock() {
  const store = useStore();
  const running = store.chat.running;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [mention, setMention] = useState<MentionState>(CLOSED);
  const [slashActive, setSlashActive] = useState(0);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const selected = useRef<Set<string>>(new Set());
  const reqTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Composer history: how far back through this conversation's prompts the user
     has walked. null = editing a live draft. The draft is stashed on the first
     Up so walking back and forward again returns exactly what was typed. */
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draftBeforeHistory = useRef("");
  const promptHistory = userPromptHistory(store.chat);

  // Files that match the active mention query (stale responses ignored).
  const items = mention.open && store.mentionQuery === mention.query ? store.mentionItems : [];
  const active = Math.min(mention.active, Math.max(items.length - 1, 0));

  // Slash-command palette — derived synchronously from the input (commands are local).
  const slashFragment = !mention.open ? slashQuery(value) : null;
  const slashOpen = slashFragment !== null && isSlashInput(value);
  const slashItems = slashOpen ? matchSlashCommands(slashFragment ?? "") : [];
  const sActive = Math.min(slashActive, Math.max(slashItems.length - 1, 0));

  function autoResize(): void {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  useEffect(() => { autoResize(); }, [value]);
  useEffect(() => { taRef.current?.focus(); }, [store.focusNonce]);
  useEffect(() => { setSlashActive(0); }, [slashFragment]);

  function tokenBeforeCaret(el: HTMLTextAreaElement): { query: string; start: number } | null {
    const caret = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, caret);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!m) return null;
    return { query: m[2]!, start: caret - m[2]!.length };
  }

  function onInput(next: string): void {
    setValue(next);
    /* Typing turns a recalled prompt back into a draft of its own — otherwise a
       later Down-arrow would discard the user's edits to restore a stale stash. */
    if (historyIndex !== null) setHistoryIndex(null);
    const el = taRef.current;
    if (!el) return;
    // Defer so selectionStart reflects the new value.
    requestAnimationFrame(() => {
      const token = tokenBeforeCaret(el);
      if (!token) { setMention(CLOSED); return; }
      setMention({ open: true, query: token.query, start: token.start, active: 0 });
      if (reqTimer.current) clearTimeout(reqTimer.current);
      reqTimer.current = setTimeout(() => actions.requestFiles(token.query), 90);
    });
  }

  function pick(index: number): void {
    const file = items[index];
    const el = taRef.current;
    if (!file || !el) return;
    const end = el.selectionStart ?? value.length;
    const insert = `@${file} `;
    const next = value.slice(0, mention.start) + insert + value.slice(end);
    setValue(next);
    selected.current.add(file);
    setMention(CLOSED);
    requestAnimationFrame(() => {
      const caret = mention.start + insert.length;
      el.focus();
      el.setSelectionRange(caret, caret);
      autoResize();
    });
  }

  function pickSlash(index: number): void {
    const def = slashItems[index];
    if (!def) return;
    if (def.arg && def.arg !== "none") {
      // Argument commands (e.g. /model) — pre-fill and let the user type the argument.
      const next = `/${def.name} `;
      setValue(next);
      requestAnimationFrame(() => {
        const el = taRef.current;
        el?.focus();
        el?.setSelectionRange(next.length, next.length);
      });
      return;
    }
    actions.runSlashCommand(def.name, "");
    setValue("");
    setMention(CLOSED);
  }

  function applyBlueprint(prompt: string, mode: RequestMode): void {
    actions.setRequestMode(mode);
    setValue((current) => {
      const trimmed = current.trim();
      return trimmed ? `${current.trimEnd()}\n\n${prompt}` : prompt;
    });
    setMention(CLOSED);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      autoResize();
    });
  }

  function submit(): void {
    /* Any send ends the recall session — the composer is about to be cleared,
       so a stashed draft from before the walk is no longer what "forward" means. */
    setHistoryIndex(null);
    draftBeforeHistory.current = "";
    const text = value.trim();
    if (!text && store.pendingAttachments.length === 0) {
      // Empty send flushes a queued follow-up left over from an errored turn.
      if (!running && store.queuedMessage) actions.flushQueuedNow();
      return;
    }
    if (!text) {
      // Attachment-only send — no slash command / queue routing applies.
      actions.sendMessage("", []);
      setValue("");
      setMention(CLOSED);
      return;
    }
    const parsed = parseSlashInput(text);
    if (parsed && resolveSlashCommand(parsed.name)) {
      actions.runSlashCommand(parsed.name, parsed.arg);
      setValue("");
      setMention(CLOSED);
      return;
    }
    if (running) {
      actions.queueMessage(text);
      setValue("");
      setMention(CLOSED);
      return;
    }
    const mentions = [...selected.current].filter((p) => text.includes(`@${p}`));
    selected.current.clear();
    actions.sendMessage(text, mentions);
    setValue("");
    setMention(CLOSED);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (mention.open && items.length) {
      if (event.key === "ArrowDown") { setMention((m) => ({ ...m, active: (active + 1) % items.length })); event.preventDefault(); return; }
      if (event.key === "ArrowUp") { setMention((m) => ({ ...m, active: (active - 1 + items.length) % items.length })); event.preventDefault(); return; }
      if (event.key === "Enter" || event.key === "Tab") { pick(active); event.preventDefault(); return; }
      if (event.key === "Escape") { setMention(CLOSED); event.preventDefault(); return; }
    }
    if (slashOpen && slashItems.length) {
      if (event.key === "ArrowDown") { setSlashActive((a) => (a + 1) % slashItems.length); event.preventDefault(); return; }
      if (event.key === "ArrowUp") { setSlashActive((a) => (a - 1 + slashItems.length) % slashItems.length); event.preventDefault(); return; }
      if (event.key === "Tab") { pickSlash(sActive); event.preventDefault(); return; }
      if (event.key === "Enter") { pickSlash(sActive); event.preventDefault(); return; }
      if (event.key === "Escape") { setValue(""); event.preventDefault(); return; }
    }
    /* Prompt history, the terminal convention: Up from the very start of the
       composer walks back through what you've already asked, Down walks
       forward, Escape abandons the recall and restores your draft. Gated on a
       collapsed caret at offset 0 so it never steals Up from someone moving
       through a multi-line message they're still writing — and placed after the
       mention/slash handlers above, which own the arrows while a popup is open. */
    if (event.key === "Escape" && historyIndex !== null) {
      setValue(draftBeforeHistory.current);
      setHistoryIndex(null);
      event.preventDefault();
      return;
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && promptHistory.length > 0) {
      const el = event.currentTarget;
      const caretAtStart = el.selectionStart === 0 && el.selectionEnd === 0;
      /* Down is gated at the *end* for the same reason Up is gated at the
         start: a recalled prompt lands with the caret at its end, so without
         this a multi-line recall could be walked upward line by line but never
         back down — Down would jump forward in history from the middle of the
         text instead of moving the caret. */
      const caretAtEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
      if (event.key === "ArrowUp" && caretAtStart) {
        if (historyIndex === null) draftBeforeHistory.current = value;
        const next = historyIndex === null ? promptHistory.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(next);
        setRecalled(promptHistory[next]);
        event.preventDefault();
        return;
      }
      if (event.key === "ArrowDown" && historyIndex !== null && caretAtEnd) {
        const next = historyIndex + 1;
        if (next >= promptHistory.length) {
          setHistoryIndex(null);
          setRecalled({ text: draftBeforeHistory.current, mentions: [] });
        } else {
          setHistoryIndex(next);
          setRecalled(promptHistory[next]);
        }
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
  }

  /** Drop a recalled prompt into the composer with the caret at the end, so the
   *  next keystroke edits it rather than landing mid-text. */
  function setRecalled(entry: RecalledPrompt | undefined): void {
    const text = entry?.text ?? "";
    setValue(text);
    setMention(CLOSED);
    /* Re-arm the recalled prompt's @-mentions. The text alone isn't enough:
       `submit` only sends files that were picked from the mention popup, so a
       recalled "review @src/a.ts" would otherwise go out with no file attached
       — asking a different question than the one being recalled. Adding rather
       than replacing keeps any file the user had already picked in the draft;
       submit's own `text.includes("@" + path)` filter drops whichever ones no
       longer appear in what is actually sent. */
    for (const path of entry?.mentions ?? []) selected.current.add(path);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.setSelectionRange(text.length, text.length);
    });
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void attachPastedFiles(files);
  }

  function onDrop(event: DragEvent<HTMLElement>): void {
    const files = Array.from(event.dataTransfer?.files ?? []);
    event.preventDefault();
    setIsDraggingFiles(false);
    if (files.length) void attachPastedFiles(files);
  }

  function onDragEnter(event: DragEvent<HTMLElement>): void {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    setIsDraggingFiles(true);
  }

  function onDragLeave(event: DragEvent<HTMLElement>): void {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    setIsDraggingFiles(false);
  }

  const placeholder = running
    ? "Agent is working — press Enter to queue a follow-up…"
    : "Ask about your code…  (@ files · / commands · paste or drop images, audio, docs, and more)";

  // aria-activedescendant target for whichever completion popover is open.
  const activeOptionId = mention.open && items.length
    ? `mention-opt-${active}`
    : slashOpen && slashItems.length ? `slash-opt-${sActive}` : undefined;

  const showBlueprints = !value.trim() && !running && !store.chat.hasMessages && store.pendingAttachments.length === 0 && !store.pendingCtx;

  return (
    <div
      className={cn("relative flex flex-col gap-1.5 border-t border-border bg-white/[0.015] p-2", running && "dock-live", isDraggingFiles && "border-primary/60 bg-primary/[0.055]")}
      onDragEnter={onDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {store.slashHelpOpen && <SlashHelp />}

      {mention.open && (
        <div
          id="mention-listbox"
          role="listbox"
          aria-label="Workspace files"
          className="menu-pop absolute inset-x-2 bottom-full z-20 mb-1.5 max-h-[220px] overflow-y-auto rounded-lg border border-primary/30 bg-popover p-1"
        >
          {items.length === 0 ? (
            <div className="px-2.5 py-2 text-center text-sm text-muted-foreground">No matching files</div>
          ) : items.map((file, index) => {
            const slash = file.lastIndexOf("/");
            const name = slash >= 0 ? file.slice(slash + 1) : file;
            const dir = slash >= 0 ? file.slice(0, slash) : "";
            return (
              <div
                key={file}
                id={`mention-opt-${index}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(e) => { e.preventDefault(); pick(index); }}
                className={cn("chat-interactive flex cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1.5 hover:bg-white/5", index === active && "border-primary/30 bg-primary/10")}
              >
                <FileText className="size-3 shrink-0 text-muted-foreground/70" />
                <span className="truncate text-base font-medium text-foreground">{name}</span>
                <span className="ml-auto max-w-[55%] truncate font-mono text-sm text-muted-foreground">{dir}</span>
              </div>
            );
          })}
        </div>
      )}

      {slashOpen && slashItems.length > 0 && (
        <div
          id="slash-listbox"
          role="listbox"
          aria-label="Slash commands"
          className="menu-pop absolute inset-x-2 bottom-full z-20 mb-1.5 max-h-[240px] overflow-y-auto rounded-lg border border-primary/30 bg-popover p-1"
        >
          {slashItems.map((def: SlashCommandDef, index) => (
            <div
              key={def.name}
              id={`slash-opt-${index}`}
              role="option"
              aria-selected={index === sActive}
              onMouseDown={(e) => { e.preventDefault(); pickSlash(index); }}
              className={cn("chat-interactive flex cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1.5 hover:bg-white/5", index === sActive && "border-primary/30 bg-primary/10")}
            >
              <Slash className="size-3 shrink-0 text-primary" />
              <span className="shrink-0 font-mono text-base font-medium text-foreground">{slashUsage(def)}</span>
              <span className="ml-auto truncate text-sm text-muted-foreground">{def.summary}</span>
            </div>
          ))}
        </div>
      )}

      <PendingBar />

      {showBlueprints && (
        <div className="fade-in grid grid-cols-4 gap-1.5">
          {BLUEPRINTS.map((blueprint) => {
            const Icon = blueprint.icon;
            return (
              <button
                key={blueprint.id}
                type="button"
                title={`Start a structured ${blueprint.label.toLowerCase()} prompt`}
                onClick={() => applyBlueprint(blueprint.prompt, blueprint.mode)}
                className="lift flex min-w-0 flex-col items-center gap-1 rounded-md border border-border bg-white/[0.025] px-1.5 py-2 text-muted-foreground hover:border-primary/35 hover:bg-primary/10 hover:text-foreground"
              >
                <Icon className="size-3.5 text-primary" />
                <span className="truncate text-xs font-semibold">{blueprint.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {store.pendingCtx && (
        <div className="fade-in flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2 py-1">
          <Paperclip className="size-3 shrink-0 text-primary" />
          <span className="flex-1 truncate font-mono text-sm text-foreground">{store.pendingCtx.label}</span>
          <button type="button" onClick={() => actions.setPendingCtx(null)} className="chat-interactive text-muted-foreground hover:text-foreground" title="Clear">
            <X className="size-3" />
          </button>
        </div>
      )}

      {(store.pendingAttachments.length > 0 || store.attaching || store.attachError) && (
        <div className="fade-in flex flex-wrap items-stretch gap-1.5">
          {store.pendingAttachments.map((a) => (
            <div
              key={a.id}
              className="group flex min-w-[180px] max-w-full items-start gap-1.5 rounded-lg border border-primary/30 bg-primary/[0.075] px-2 py-1.5 text-sm text-foreground"
              title={`${a.name} (${formatBytes(a.byteSize)})${a.handling ? ` · ${a.handling}` : ""}`}
            >
              <AttachmentIcon kind={a.kind} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1">
                  <span className="max-w-[185px] truncate font-medium">{a.name}</span>
                  <span className="shrink-0 rounded border border-primary/20 bg-primary/10 px-1 py-px text-2xs font-semibold uppercase tracking-wide text-primary">{attachmentLabel(a)}</span>
                </span>
                <span className="mt-0.5 block truncate text-2xs leading-snug text-muted-foreground">
                  {a.handling ?? formatBytes(a.byteSize)}
                </span>
              </span>
              <button type="button" onClick={() => actions.removeAttachment(a.id)} className="chat-interactive mt-px text-muted-foreground hover:text-foreground" title={`Remove ${a.name}`}>
                <X className="size-3" />
              </button>
            </div>
          ))}
          {store.attaching && (
            <span className="flex items-center gap-1 rounded-md border border-border bg-white/5 px-2 py-1 text-sm text-muted-foreground">
              <Loader2 className="size-3 shrink-0 animate-spin" />
              Importing attachment…
            </span>
          )}
          {store.attachError && (
            <span className="flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-sm text-destructive">
              {store.attachError}
              <button type="button" onClick={() => actions.clearAttachError()} className="chat-interactive text-muted-foreground hover:text-foreground" title="Dismiss">
                <X className="size-3" />
              </button>
            </span>
          )}
        </div>
      )}

      {store.queuedMessage && (
        <div className="fade-in flex items-center gap-1.5 rounded-md border border-[color:var(--s-warn)]/35 bg-[color:var(--s-warn)]/10 px-2 py-1">
          <CornerDownLeft className="size-3 shrink-0 text-[color:var(--s-warn)]" />
          <span className="shrink-0 text-2xs font-semibold uppercase tracking-wide text-[color:var(--s-warn)]">{running ? "Queued" : "Pending"}</span>
          <span className="flex-1 truncate text-sm text-foreground">{store.queuedMessage}</span>
          {!running && (
            <button type="button" onClick={() => actions.flushQueuedNow()} className="shrink-0 text-xs font-medium text-primary hover:underline" title="Send now">Send</button>
          )}
          <button type="button" onClick={() => actions.clearQueuedMessage()} className="chat-interactive text-muted-foreground hover:text-foreground" title="Discard queued message">
            <X className="size-3" />
          </button>
        </div>
      )}

      <QuickSettings />

      <div className="flex items-center gap-1" role="group" aria-label="Request profile">
        <span className="mr-0.5 shrink-0 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Mode</span>
        {MODE_OPTIONS.map((mode) => (
          <button
            key={mode.id}
            type="button"
            title={mode.title}
            aria-pressed={store.requestMode === mode.id}
            onClick={() => actions.setRequestMode(mode.id)}
            className={cn(
              "chat-interactive min-w-0 flex-1 rounded-md border px-1.5 py-1 text-xs font-medium",
              store.requestMode === mode.id
                ? "border-primary/40 bg-primary/12 text-primary"
                : "border-border bg-white/[0.02] text-muted-foreground hover:border-primary/25 hover:text-foreground",
            )}
          >
            {mode.label}
          </button>
        ))}
      </div>

      <div className="flex items-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title="Attach images, audio, documents, code, archives, and other files (stored for this conversation)"
          onClick={() => actions.requestAttachFiles()}
          disabled={store.attaching}
          className="mb-0.5 shrink-0"
        >
          <Paperclip className="size-3.5" />
        </Button>
        <Textarea
          ref={taRef}
          rows={1}
          value={value}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setMention(CLOSED), 120)}
          onPaste={onPaste}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={mention.open || slashOpen}
          aria-autocomplete="list"
          aria-controls={mention.open ? "mention-listbox" : slashOpen ? "slash-listbox" : undefined}
          aria-activedescendant={activeOptionId}
          className="min-h-[34px] flex-1 resize-none rounded-xl py-1.5 leading-snug"
        />
        {value.trim() && (
          <span
            className="mb-2 shrink-0 font-mono text-2xs tabular-nums text-muted-foreground/70"
            title="Estimated tokens for this message (approximate)"
          >
            ~{estimateTokens(value)}
          </span>
        )}
        {running ? (
          <div className="flex items-center gap-1">
            {value.trim() && (
              <Button type="button" variant="outline" size="sm" title="Queue this message (sends when the current turn ends)" onClick={submit}>
                Queue
              </Button>
            )}
            <Button type="button" variant="ghost" size="icon-sm" title="Cancel current run" onClick={() => actions.cancel()}>
              <X className="size-3.5" />
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            size="sm"
            title="Send (Enter)"
            onClick={submit}
            disabled={!value.trim() && !store.queuedMessage && store.pendingAttachments.length === 0}
          >
            Send
          </Button>
        )}
      </div>
      {isDraggingFiles && (
        <div className="pointer-events-none absolute inset-1 z-30 flex items-center justify-center rounded-xl border border-dashed border-primary/70 bg-background/90 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-sm font-semibold text-primary">
            <Upload className="size-4" />
            Drop files to add them to this conversation
          </div>
        </div>
      )}
    </div>
  );
}
