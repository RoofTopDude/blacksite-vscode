/* A shell command's output, the way a terminal shows it — streamed while the
   command runs and kept once it ends, so a build or test run can be watched
   and inspected rather than only read as its final JSON. */

import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { ArrowDown, Check, Copy, WrapText } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format";
import {
  ansiSegments, terminalLineCount, terminalText,
  type TerminalExit, type TerminalLine, type TerminalOutput,
} from "@/lib/terminal-output";

/* The 16-colour palette, tuned for the panel's dark ground (bright = +8). */
const ANSI_COLORS = [
  "#5b6070", "#f0838f", "#8fd19e", "#e8c07a", "#7fb0f0", "#c49cf0", "#6fd0d8", "#d4d4d8",
  "#7d8394", "#ff9aa5", "#a6e3b4", "#f2d59a", "#9cc4ff", "#d6b6ff", "#8fe4ea", "#f4f4f5",
];

/** `npm run build`, with any argument that needs it quoted, for the prompt line. */
export function shellCommandLine(input: unknown): string {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const command = typeof record.command === "string" ? record.command : "";
  const args = Array.isArray(record.args) ? record.args.map(String) : [];
  const quote = (arg: string): string => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`);
  return [command, ...args.map(quote)].filter(Boolean).join(" ");
}

function Line({ line, caret }: { line: TerminalLine; caret?: boolean }) {
  const segments = ansiSegments(line.text);
  return (
    <div className={cn("terminal-line", line.stream === "stderr" && "terminal-line-stderr")}>
      {segments.length === 0 ? "\u200b" : segments.map((segment, i) => {
        const style: CSSProperties = {};
        if (segment.fg !== undefined) style.color = ANSI_COLORS[segment.fg];
        if (segment.bold) style.fontWeight = 650;
        if (segment.dim) style.opacity = 0.62;
        if (segment.italic) style.fontStyle = "italic";
        if (segment.underline) style.textDecoration = "underline";
        return <span key={i} style={style}>{segment.text}</span>;
      })}
      {caret && <span className="terminal-caret" aria-hidden />}
    </div>
  );
}

function exitLabel(exit: TerminalExit | null, live: boolean): { text: string; tone: "live" | "ok" | "err" | "warn" | "idle" } {
  if (live) return { text: "Running", tone: "live" };
  if (!exit) return { text: "Finished", tone: "idle" };
  if (exit.cancelled) return { text: "Cancelled", tone: "warn" };
  if (exit.timedOut) return { text: "Timed out", tone: "warn" };
  if (exit.error && exit.code === null) return { text: "Didn't run", tone: "err" };
  if (exit.code === 0) return { text: "Exit 0", tone: "ok" };
  if (exit.code === null) return { text: "Ended", tone: "idle" };
  return { text: `Exit ${exit.code}`, tone: "err" };
}

export function TerminalPane({ output, input, elapsedMs, live }: {
  output: TerminalOutput | null;
  input: unknown;
  elapsedMs: number | null;
  /** The parent turn is still streaming; an orphaned "running" call in a restored
      transcript must not pretend to be alive. */
  live: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const running = live && (output?.live ?? true);
  const lines = output ? (output.current?.text ? [...output.lines, output.current] : output.lines) : [];
  const count = output ? terminalLineCount(output) : 0;
  const command = shellCommandLine(input);
  const cwd = input && typeof input === "object" && typeof (input as Record<string, unknown>).cwd === "string"
    ? String((input as Record<string, unknown>).cwd) : "";
  const status = exitLabel(output?.exit ?? null, running);

  /* Stay pinned to the newest line while following; scrolling up stops following
     until the reader scrolls back down or jumps to the latest. */
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body && follow) body.scrollTop = body.scrollHeight;
  });

  function onScroll(): void {
    const body = bodyRef.current;
    if (!body) return;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 12;
    if (atBottom !== follow) setFollow(atBottom);
  }

  function copy(e: MouseEvent): void {
    e.stopPropagation();
    if (!output) return;
    navigator.clipboard.writeText(`$ ${command}\n${terminalText(output)}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard unavailable */ });
  }

  return (
    <div className="terminal-pane" data-live={running || undefined}>
      <div className="terminal-head">
        <span className="terminal-prompt" aria-hidden>$</span>
        <span className="min-w-0 flex-1 truncate" title={cwd ? `${command}\nin ${cwd}` : command}>{command || "command"}</span>
        <span className={cn("terminal-status", `terminal-status-${status.tone}`)} role="status">
          {running && <span className="terminal-status-dot" aria-hidden />}
          {status.text}
        </span>
      </div>
      <div
        ref={bodyRef}
        className={cn("terminal-body", wrap ? "terminal-wrap" : "terminal-nowrap")}
        onScroll={onScroll}
        tabIndex={0}
        role="log"
        aria-live={running ? "polite" : undefined}
        aria-label={`Output of ${command || "the command"}`}
      >
        {output && output.dropped > 0 && (
          <div className="terminal-note">{output.dropped.toLocaleString()} earlier lines not kept</div>
        )}
        {lines.length === 0 && (
          <div className="terminal-note">{running ? "Waiting for output…" : "No output"}</div>
        )}
        {lines.map((line, i) => (
          <Line key={output!.dropped + i} line={line} caret={running && i === lines.length - 1 && Boolean(output?.current?.text)} />
        ))}
        {running && !output?.current?.text && <div className="terminal-line"><span className="terminal-caret" aria-hidden /></div>}
        {output?.exit?.error && (
          <div className="terminal-line terminal-line-error">{output.exit.error}</div>
        )}
        {output?.capped && (
          <div className="terminal-note">Live view stopped at 2M characters; the result keeps the end of the output.</div>
        )}
      </div>
      {!follow && running && (
        <button type="button" className="terminal-jump" onClick={(e) => { e.stopPropagation(); setFollow(true); }}>
          <ArrowDown className="size-3" aria-hidden /> Latest
        </button>
      )}
      <div className="terminal-foot">
        <span className="min-w-0 flex-1 truncate">
          {[cwd || null, `${count.toLocaleString()} ${count === 1 ? "line" : "lines"}`, elapsedMs != null ? formatDuration(elapsedMs) : null].filter(Boolean).join(" · ")}
        </span>
        <button
          type="button"
          className={cn("terminal-tool", wrap && "terminal-tool-on")}
          aria-pressed={wrap}
          title={wrap ? "Long lines wrap — click to scroll them sideways instead" : "Long lines scroll sideways — click to wrap them"}
          onClick={(e) => { e.stopPropagation(); setWrap((v) => !v); }}
        >
          <WrapText className="size-3" aria-hidden /> Wrap
        </button>
        <button type="button" className="terminal-tool" title="Copy the command and its output" onClick={copy} disabled={!output}>
          {copied ? <Check className="size-3" style={{ color: "var(--s-ok)" }} aria-hidden /> : <Copy className="size-3" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
