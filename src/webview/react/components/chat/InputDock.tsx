import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { X, CornerDownLeft, Slash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { actions, useStore } from "@/lib/store";
import {
  isSlashInput, matchSlashCommands, parseSlashInput, resolveSlashCommand,
  slashQuery, slashUsage, type SlashCommandDef,
} from "@/lib/slash-commands";
import { QuickSettings } from "./QuickSettings";
import { SlashHelp } from "./SlashHelp";

interface MentionState { open: boolean; query: string; start: number; active: number; }

const CLOSED: MentionState = { open: false, query: "", start: -1, active: 0 };

export function InputDock() {
  const store = useStore();
  const running = store.chat.running;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [mention, setMention] = useState<MentionState>(CLOSED);
  const [slashActive, setSlashActive] = useState(0);
  const selected = useRef<Set<string>>(new Set());
  const reqTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  function submit(): void {
    const text = value.trim();
    if (!text) {
      // Empty send flushes a queued follow-up left over from an errored turn.
      if (!running && store.queuedMessage) actions.flushQueuedNow();
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
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
  }

  const placeholder = running
    ? "Agent is working — press Enter to queue a follow-up…"
    : "Ask about your code…  (@ to attach a file · / for commands)";

  return (
    <div className="relative flex flex-col gap-1.5 border-t border-border bg-white/[0.015] p-2">
      {store.slashHelpOpen && <SlashHelp />}

      {mention.open && (
        <div className="absolute inset-x-2 bottom-full z-20 mb-1.5 max-h-[220px] overflow-y-auto rounded-lg border border-primary/30 bg-popover p-1 shadow-xl">
          {items.length === 0 ? (
            <div className="px-2.5 py-2 text-center text-[11px] text-muted-foreground">No matching files</div>
          ) : items.map((file, index) => {
            const slash = file.lastIndexOf("/");
            const name = slash >= 0 ? file.slice(slash + 1) : file;
            const dir = slash >= 0 ? file.slice(0, slash) : "";
            return (
              <div
                key={file}
                role="option"
                aria-selected={index === active}
                onMouseDown={(e) => { e.preventDefault(); pick(index); }}
                className={cn("flex cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1.5 hover:bg-white/5", index === active && "border-primary/30 bg-primary/10")}
              >
                <span className="shrink-0 text-[11px] opacity-70">📄</span>
                <span className="truncate text-[12px] font-medium text-foreground">{name}</span>
                <span className="ml-auto max-w-[55%] truncate font-mono text-[10.5px] text-muted-foreground">{dir}</span>
              </div>
            );
          })}
        </div>
      )}

      {slashOpen && slashItems.length > 0 && (
        <div className="absolute inset-x-2 bottom-full z-20 mb-1.5 max-h-[240px] overflow-y-auto rounded-lg border border-primary/30 bg-popover p-1 shadow-xl">
          {slashItems.map((def: SlashCommandDef, index) => (
            <div
              key={def.name}
              role="option"
              aria-selected={index === sActive}
              onMouseDown={(e) => { e.preventDefault(); pickSlash(index); }}
              className={cn("flex cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1.5 hover:bg-white/5", index === sActive && "border-primary/30 bg-primary/10")}
            >
              <Slash className="size-3 shrink-0 text-primary" />
              <span className="shrink-0 font-mono text-[11.5px] font-medium text-foreground">{slashUsage(def)}</span>
              <span className="ml-auto truncate text-[10.5px] text-muted-foreground">{def.summary}</span>
            </div>
          ))}
        </div>
      )}

      {store.pendingCtx && (
        <div className="flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2 py-1">
          <span className="text-[10px] text-primary">📎</span>
          <span className="flex-1 truncate font-mono text-[10.5px] text-foreground">{store.pendingCtx.label}</span>
          <button type="button" onClick={() => actions.setPendingCtx(null)} className="text-muted-foreground hover:text-foreground" title="Clear">
            <X className="size-3" />
          </button>
        </div>
      )}

      {store.queuedMessage && (
        <div className="flex items-center gap-1.5 rounded-md border border-[color:var(--s-warn)]/35 bg-[color:var(--s-warn)]/10 px-2 py-1">
          <CornerDownLeft className="size-3 shrink-0 text-[color:var(--s-warn)]" />
          <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-[color:var(--s-warn)]">{running ? "Queued" : "Pending"}</span>
          <span className="flex-1 truncate text-[10.5px] text-foreground">{store.queuedMessage}</span>
          {!running && (
            <button type="button" onClick={() => actions.flushQueuedNow()} className="shrink-0 text-[10px] font-medium text-primary hover:underline" title="Send now">Send</button>
          )}
          <button type="button" onClick={() => actions.clearQueuedMessage()} className="text-muted-foreground hover:text-foreground" title="Discard queued message">
            <X className="size-3" />
          </button>
        </div>
      )}

      <QuickSettings />

      <div className="flex items-end gap-1.5">
        <Textarea
          ref={taRef}
          rows={1}
          value={value}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setMention(CLOSED), 120)}
          placeholder={placeholder}
          className="min-h-[34px] flex-1 resize-none rounded-xl py-1.5 leading-snug"
        />
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
          <Button type="button" size="sm" title="Send (Enter)" onClick={submit} disabled={!value.trim() && !store.queuedMessage}>
            Send
          </Button>
        )}
      </div>
    </div>
  );
}
