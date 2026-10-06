/* A shell command's output as a terminal shows it: lines in arrival order with
   stdout and stderr interleaved, carriage-return progress lines overwriting in
   place, ANSI colour kept and every other escape dropped. Bounded, because the
   webview retains every tool call for the life of the conversation. */

export type TerminalStream = "stdout" | "stderr";

export interface TerminalLine {
  stream: TerminalStream;
  text: string;
}

export interface TerminalOutput {
  lines: TerminalLine[];
  /** The line still being written (no newline yet), shown last. */
  current: TerminalLine | null;
  /** A "\r" arrived at the end of a chunk: the next "\n" ends the line (CRLF split across
   *  two reads); anything else starts overwriting it. */
  pendingReturn: boolean;
  /** Oldest lines discarded to stay within MAX_TERMINAL_LINES. */
  dropped: number;
  /** The host stopped streaming this command's output partway (live cap). */
  capped: boolean;
  /** True while output is still arriving; false once the result landed. */
  live: boolean;
  /** How the command ended, read from its result. Null while it runs. */
  exit: TerminalExit | null;
}

export interface TerminalExit {
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Set when the command failed before or instead of running (missing executable, refused). */
  error: string;
}

export const MAX_TERMINAL_LINES = 2000;
const MAX_LINE_CHARS = 4000;
/** Kept once the command finishes, so a long transcript of builds stays light. */
const SETTLED_TERMINAL_LINES = 600;

export function createTerminalOutput(): TerminalOutput {
  return { lines: [], current: null, pendingReturn: false, dropped: 0, capped: false, live: true, exit: null };
}

function exitFrom(result: unknown): TerminalExit | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  return {
    code: typeof record.exitCode === "number" ? record.exitCode : null,
    timedOut: record.timedOut === true,
    cancelled: record.cancelled === true,
    error: record.ok === false && typeof record.error === "string" ? record.error : "",
  };
}

function commit(out: TerminalOutput, line: TerminalLine): void {
  out.lines.push(line.text.length > MAX_LINE_CHARS ? { stream: line.stream, text: `${line.text.slice(0, MAX_LINE_CHARS)} …` } : line);
  if (out.lines.length > MAX_TERMINAL_LINES) {
    const excess = out.lines.length - MAX_TERMINAL_LINES;
    out.lines.splice(0, excess);
    out.dropped += excess;
  }
}

/** Feed one chunk of output. */
export function appendTerminalOutput(out: TerminalOutput, stream: TerminalStream, text: string): void {
  if (!text) return;
  /* A partial line from the other stream is finished as it stands: interleaving
     beats splicing stderr into the middle of a stdout line. */
  if (out.current && out.current.stream !== stream && out.current.text) {
    commit(out, out.current);
    out.current = null;
    out.pendingReturn = false;
  }
  for (const part of text.split(/(\r\n|\n|\r)/)) {
    if (part === "") continue;
    if (part === "\n" || part === "\r\n") {
      commit(out, out.current ?? { stream, text: "" });
      out.current = null;
      out.pendingReturn = false;
    } else if (part === "\r") {
      out.pendingReturn = true;
    } else {
      if (out.pendingReturn) {
        /* A bare carriage return: the program is redrawing the line (a progress bar). */
        out.current = { stream, text: part };
        out.pendingReturn = false;
      } else {
        out.current = out.current ? { stream: out.current.stream, text: out.current.text + part } : { stream, text: part };
      }
      if (out.current.text.length > MAX_LINE_CHARS * 2) out.current = { stream, text: out.current.text.slice(-MAX_LINE_CHARS) };
    }
  }
}

/** The command finished: stop the live state, record how it ended, and trim to the settled size. */
export function settleTerminalOutput(out: TerminalOutput, result?: unknown): void {
  out.live = false;
  out.pendingReturn = false;
  out.exit = exitFrom(result);
  if (out.lines.length > SETTLED_TERMINAL_LINES) {
    const excess = out.lines.length - SETTLED_TERMINAL_LINES;
    out.lines.splice(0, excess);
    out.dropped += excess;
  }
}

/** Rebuild a terminal view from a finished result (a restored conversation, or a run whose
 *  output was not streamed). stdout and stderr were captured separately, so they are shown one
 *  after the other rather than interleaved. */
export function terminalFromResult(result: unknown): TerminalOutput | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const error = record.ok === false && typeof record.error === "string" ? record.error : "";
  if (!stdout && !stderr && !error) return null;
  const out = createTerminalOutput();
  if (stdout) appendTerminalOutput(out, "stdout", stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  if (stderr) appendTerminalOutput(out, "stderr", stderr.endsWith("\n") ? stderr : `${stderr}\n`);
  settleTerminalOutput(out, result);
  return out;
}

export function terminalLineCount(out: TerminalOutput): number {
  return out.dropped + out.lines.length + (out.current?.text ? 1 : 0);
}

/** The newest non-blank line, plain text — a running command's one-line pulse. */
export function terminalTail(out: TerminalOutput | null): string {
  if (!out) return "";
  const candidates = out.current?.text ? [out.current, ...[...out.lines].reverse()] : [...out.lines].reverse();
  for (const line of candidates.slice(0, 12)) {
    const plain = stripAnsi(line.text).trim();
    if (plain) return plain;
  }
  return "";
}

export function terminalText(out: TerminalOutput): string {
  const lines = out.current?.text ? [...out.lines, out.current] : out.lines;
  return lines.map((line) => stripAnsi(line.text)).join("\n");
}

/* ── ANSI ──────────────────────────────────────────────────────────────── */

export interface AnsiSegment {
  text: string;
  /** 0–15 for the classic palette; undefined for the default colour. */
  fg?: number;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/* CSI (ESC [ … final byte), OSC (ESC ] … BEL or ST), and any other two-byte escape. */
// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.includes("\x1b") ? text.replace(ESCAPE, "") : text;
}

/** Split a line into styled runs. Only SGR (colour/weight) survives; cursor movement and other
 *  control sequences are dropped, since output arrives through a pipe, not a screen. */
export function ansiSegments(text: string): AnsiSegment[] {
  if (!text.includes("\x1b")) return [{ text }];
  const segments: AnsiSegment[] = [];
  let style: Omit<AnsiSegment, "text"> = {};
  let last = 0;
  for (const match of text.matchAll(ESCAPE)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ ...style, text: text.slice(last, index) });
    last = index + match[0].length;
    // eslint-disable-next-line no-control-regex
    const sgr = /^\x1b\[([0-9;]*)m$/.exec(match[0]);
    if (!sgr) continue;
    const codes = (sgr[1] || "0").split(";").map((code) => Number(code) || 0);
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i]!;
      if (code === 0) style = {};
      else if (code === 1) style = { ...style, bold: true };
      else if (code === 2) style = { ...style, dim: true };
      else if (code === 3) style = { ...style, italic: true };
      else if (code === 4) style = { ...style, underline: true };
      else if (code === 22) style = { ...style, bold: false, dim: false };
      else if (code === 23) style = { ...style, italic: false };
      else if (code === 24) style = { ...style, underline: false };
      else if (code >= 30 && code <= 37) style = { ...style, fg: code - 30 };
      else if (code >= 90 && code <= 97) style = { ...style, fg: code - 90 + 8 };
      else if (code === 39) style = { ...style, fg: undefined };
      else if (code === 38) {
        /* 256-colour / truecolour: map the 256 palette's first 16; skip the rest's arguments. */
        if (codes[i + 1] === 5) { const n = codes[i + 2] ?? 0; if (n < 16) style = { ...style, fg: n }; i += 2; }
        else if (codes[i + 1] === 2) i += 4;
      } else if (code === 48) {
        if (codes[i + 1] === 5) i += 2;
        else if (codes[i + 1] === 2) i += 4;
      }
    }
  }
  if (last < text.length) segments.push({ ...style, text: text.slice(last) });
  return segments.filter((segment) => segment.text);
}
