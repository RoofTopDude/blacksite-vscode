import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DropdownMenu, Tooltip } from "radix-ui";
import {
  Check, ChevronDown, Code, Copy, Download, FolderPlus, Keyboard, Map as MapIcon, Maximize, Minus, Moon, Plus,
  RotateCcw, Save, Sun, TriangleAlert, Workflow, X,
} from "lucide-react";
import { onMessage, post, readUiState, writeUiState } from "@/lib/bridge";
import { renderMermaid, type DiagramTheme } from "@/lib/mermaid";
import { cn } from "@/lib/utils";
import { describeMermaid, diagramDisplayTitle, diagramFileStem } from "../../../../shared/mermaid-source";
import {
  blobToBase64, buildStandaloneSvg, diagramBox, parseSvg, rasterize, svgDataUrl, TaintedCanvasError,
  type EmbeddedFonts, type StandaloneSvg,
} from "./export";
import { PanZoomController, visibleRegion, type Size, type Transform } from "./pan-zoom";

/* The diagram viewer: one Mermaid diagram per editor tab, opened from the chat, the Plans and
   Tickets panels, or a Markdown file (src/diagrams/diagram-viewer.ts). Everything a reader
   needs to actually read a large diagram lives here — pan, zoom, a minimap, the source beside
   it (editable, re-rendering as you type), a light canvas for documents, and export. */

/** The saved diagram (.blacksite/context/diagrams/) this tab follows, when it has one. */
interface BackingFile {
  name: string;
  /** Workspace-relative where it can be, so a restored tab finds it again. */
  path: string;
}

function backingFile(value: unknown): BackingFile | null {
  if (!value || typeof value !== "object") return null;
  const { name, path } = value as Record<string, unknown>;
  return typeof name === "string" && typeof path === "string" ? { name, path } : null;
}

interface ViewerState {
  /** The diagram as last opened or saved. For a saved diagram, this follows the file. */
  source: string;
  /** The user's edit of it, or null while unedited. */
  draft: string | null;
  /** The file this tab follows, or null for a diagram that only lives in this tab. */
  file: BackingFile | null;
  theme: DiagramTheme;
  showSource: boolean;
  showMinimap: boolean;
  sourceWidth: number;
}

const DEFAULT_STATE: ViewerState = {
  source: "",
  draft: null,
  file: null,
  theme: "dark",
  showSource: false,
  showMinimap: true,
  sourceWidth: 380,
};

/** Canvas colour per theme — also the background baked into an export. */
const CANVAS: Record<DiagramTheme, string> = { dark: "#0b0b0e", light: "#ffffff" };
const ZOOM_STEP = 1.25;
const PNG_SCALE = 2;
const ZOOM_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4];

interface Rendered {
  svg: string;
  /** The source and theme this SVG was drawn from, which may lag the editor while it errors. */
  source: string;
  theme: DiagramTheme;
}

type Toast = { id: number; message: string; tone: "info" | "error" };

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function percent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/* ── small building blocks ─────────────────────────────────────────────── */

function Tip({ label, shortcut, children }: { label: string; shortcut?: string; children: ReactNode }) {
  return (
    <Tooltip.Root delayDuration={350}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="dv-tooltip" side="bottom" sideOffset={6}>
          {label}
          {shortcut && <kbd className="dv-kbd">{shortcut}</kbd>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function ToolButton({ label, shortcut, onClick, active, disabled, children, className }: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tip label={label} shortcut={shortcut}>
      <button
        type="button"
        className={cn("dv-tool", active && "is-active", className)}
        aria-label={label}
        aria-pressed={active === undefined ? undefined : active}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </Tip>
  );
}

function Menu({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return (
    <DropdownMenu.Root>
      <Tip label={label}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="dv-tool dv-tool-menu" aria-label={label}>
            {icon}
            <span className="dv-tool-text">{label}</span>
            <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="dv-menu" align="end" sideOffset={6}>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function MenuItem({ onSelect, children, hint, disabled }: { onSelect: () => void; children: ReactNode; hint?: string; disabled?: boolean }) {
  return (
    <DropdownMenu.Item className="dv-menu-item" onSelect={onSelect} disabled={disabled}>
      <span>{children}</span>
      {hint && <span className="dv-menu-hint">{hint}</span>}
    </DropdownMenu.Item>
  );
}

/* ── minimap ───────────────────────────────────────────────────────────── */

const MINIMAP_MAX = { width: 200, height: 140 };

function Minimap({ image, content, viewport, transform, onNavigate }: {
  image: string;
  content: Size;
  viewport: Size;
  transform: Transform;
  onNavigate: (point: { x: number; y: number }, animate: boolean) => void;
}) {
  const scale = Math.min(MINIMAP_MAX.width / content.width, MINIMAP_MAX.height / content.height);
  const width = Math.max(1, content.width * scale);
  const height = Math.max(1, content.height * scale);
  const region = visibleRegion(transform, viewport);
  const left = Math.max(0, Math.min(width, region.x * scale));
  const top = Math.max(0, Math.min(height, region.y * scale));
  const right = Math.max(0, Math.min(width, (region.x + region.width) * scale));
  const bottom = Math.max(0, Math.min(height, (region.y + region.height) * scale));
  const dragging = useRef(false);

  function navigate(event: React.PointerEvent<HTMLDivElement>, animate: boolean): void {
    const rect = event.currentTarget.getBoundingClientRect();
    onNavigate({ x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale }, animate);
  }

  return (
    <div
      className="dv-minimap dv-overlay"
      style={{ width, height }}
      role="presentation"
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        navigate(event, true);
      }}
      onPointerMove={(event) => { if (dragging.current) navigate(event, false); }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    >
      <img src={image} alt="" draggable={false} width={width} height={height} />
      <div className="dv-minimap-view" style={{ left, top, width: Math.max(4, right - left), height: Math.max(4, bottom - top) }} />
    </div>
  );
}

/* ── source panel ──────────────────────────────────────────────────────── */

const SourcePanel = memo(function SourcePanel({ value, edited, error, width, onChange, onRevert, onCopy, onClose, onResize }: {
  value: string;
  edited: boolean;
  error: string | null;
  width: number;
  onChange: (value: string) => void;
  onRevert: () => void;
  onCopy: () => void;
  onClose: () => void;
  onResize: (width: number) => void;
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => Math.max(1, value.split("\n").length), [value]);
  const errorLine = useMemo(() => {
    const match = error ? /line (\d+)/i.exec(error) : null;
    return match ? Number(match[1]) : 0;
  }, [error]);

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // Tab indents instead of leaving the editor. execCommand keeps the edit on the textarea's
    // own undo stack, which assigning to value would wipe.
    if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      document.execCommand("insertText", false, "  ");
    }
    if (event.key === "Escape") (event.currentTarget as HTMLTextAreaElement).blur();
  }

  function startResize(event: React.PointerEvent<HTMLDivElement>): void {
    const startX = event.clientX;
    const startWidth = width;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      const max = Math.max(280, window.innerWidth * 0.7);
      onResize(Math.round(Math.min(max, Math.max(260, startWidth + (startX - moveEvent.clientX)))));
    };
    const up = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }

  return (
    <>
      <div
        className="dv-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize source panel"
        onPointerDown={startResize}
      />
      <aside className="dv-source" style={{ width }} aria-label="Diagram source">
        <div className="dv-source-head">
          <span className="dv-source-title"><Code className="size-3.5" aria-hidden="true" />Source</span>
          {edited && <span className="dv-badge">Edited</span>}
          <span className="flex-1" />
          {edited && (
            <ToolButton label="Revert to the original" onClick={onRevert}><RotateCcw className="size-3.5" /></ToolButton>
          )}
          <ToolButton label="Copy source" onClick={onCopy}><Copy className="size-3.5" /></ToolButton>
          <ToolButton label="Close source" shortcut="S" onClick={onClose}><X className="size-3.5" /></ToolButton>
        </div>
        <div className="dv-editor">
          <div ref={gutter} className="dv-gutter" aria-hidden="true">
            {Array.from({ length: lines }, (_, index) => (
              <div key={index} className={cn(index + 1 === errorLine && "is-error")}>{index + 1}</div>
            ))}
          </div>
          <textarea
            className="dv-textarea"
            value={value}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            aria-label="Mermaid source"
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            onScroll={(event) => { if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop; }}
          />
        </div>
        <div className={cn("dv-source-foot", error && "is-error")} role="status">
          {error ? <><TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" /><span>{error}</span></> : <span>Updates as you type</span>}
        </div>
      </aside>
    </>
  );
});

/* ── shortcuts help ────────────────────────────────────────────────────── */

const SHORTCUTS: Array<[string, string]> = [
  ["Scroll", "Zoom around the pointer"],
  ["Pinch · Ctrl+Scroll", "Zoom (trackpad)"],
  ["Two-finger scroll", "Pan (trackpad)"],
  ["Drag", "Pan"],
  ["Double-click", "Zoom in · Shift to zoom out"],
  ["+  −", "Zoom in / out"],
  ["0", "Fit to window"],
  ["1  2", "Zoom to 100% / 200%"],
  ["Arrow keys", "Pan · Shift for larger steps"],
  ["S", "Show or hide the source"],
  ["T", "Switch light and dark canvas"],
  ["M", "Show or hide the minimap"],
  ["?", "This list"],
];

function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="dv-help-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dv-help" role="dialog" aria-modal="true" aria-label="Keyboard and mouse shortcuts">
        <div className="dv-help-head">
          <span>Shortcuts</span>
          <button type="button" className="dv-tool" aria-label="Close" onClick={onClose}><X className="size-3.5" /></button>
        </div>
        <dl>
          {SHORTCUTS.map(([keys, action]) => (
            <div key={keys} className="dv-help-row"><dt><kbd className="dv-kbd">{keys}</kbd></dt><dd>{action}</dd></div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/* ── the app ───────────────────────────────────────────────────────────── */

export function DiagramApp() {
  const [state, setState] = useState<ViewerState>(() => readUiState("diagram", DEFAULT_STATE));
  const [fonts, setFonts] = useState<EmbeddedFonts>({});
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });
  const [content, setContent] = useState<Size>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [minimapImage, setMinimapImage] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const controller = useRef<PanZoomController | null>(null);
  /** Keep fitting the diagram to the window until the user moves it themselves. */
  const autoFit = useRef(true);
  const toastId = useRef(0);

  /** The newest state, for message handlers that must not re-subscribe on every change. */
  const latestState = useRef(state);
  latestState.current = state;

  const current = state.draft ?? state.source;
  const edited = state.draft !== null && state.draft !== state.source;
  /** Nothing to draw yet: a fresh tab waiting on the host's diagram_init. */
  const waiting = !state.source;

  const update = useCallback((patch: Partial<ViewerState>) => {
    setState((previous) => {
      const next = { ...previous, ...patch };
      writeUiState("diagram", next);
      return next;
    });
  }, []);

  const notify = useCallback((message: string, tone: Toast["tone"] = "info") => {
    setToast({ id: ++toastId.current, message, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((shown) => (shown?.id === toast.id ? null : shown)), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  // Host handshake: ask for the diagram (and the export font), then keep listening for notices.
  useEffect(() => {
    const stop = onMessage((message) => {
      if (message.type === "diagram_init" && typeof message.source === "string") {
        if (message.fonts && typeof message.fonts === "object") setFonts(message.fonts as EmbeddedFonts);
        const file = backingFile(message.file);
        setState((previous) => {
          if (previous.source === message.source && previous.file?.path === file?.path) return previous;
          const next = { ...previous, source: message.source as string, draft: null, file };
          writeUiState("diagram", next);
          return next;
        });
      }
      // The saved file changed (the agent patched it, or a save from this tab landed), or this
      // tab was just saved as a file. Redraw from it without touching pan, zoom, or an unsaved
      // edit: the edit is the user's, and the new version is one Revert away.
      if (message.type === "diagram_update" && typeof message.source === "string") {
        const incoming = message.source;
        const file = backingFile(message.file);
        const before = latestState.current;
        const keepsEdit = before.draft !== null && before.draft !== before.source && before.draft !== incoming;
        setState((previous) => {
          const next = {
            ...previous,
            source: incoming,
            draft: previous.draft !== null && previous.draft !== previous.source && previous.draft !== incoming ? previous.draft : null,
            file: file ?? previous.file,
          };
          writeUiState("diagram", next);
          return next;
        });
        if (keepsEdit) notify("The saved diagram changed. Your edit is kept; Revert loads the new version.");
      }
      if (message.type === "diagram_notice" && typeof message.message === "string") {
        notify(message.message, message.level === "error" ? "error" : "info");
      }
    });
    post({ type: "diagram_ready" });
    return stop;
  }, [notify]);

  // Tab title follows the diagram, including edits to its title.
  useEffect(() => {
    if (current.trim()) post({ type: "diagram_title", title: diagramDisplayTitle(current) });
  }, [current]);

  // Render. Edits are debounced so typing stays fluid; the first draw and a theme switch are not.
  const lastRendered = useRef<Rendered | null>(null);
  useEffect(() => {
    if (waiting) return;
    if (!current.trim()) { setError("This diagram is empty."); return; }
    let alive = true;
    const previous = lastRendered.current;
    const delay = previous && previous.theme === state.theme ? 280 : 0;
    const timer = setTimeout(() => {
      void renderMermaid(current, { theme: state.theme }).then((result) => {
        if (!alive) return;
        if ("svg" in result) {
          const next = { svg: result.svg, source: current, theme: state.theme };
          lastRendered.current = next;
          setRendered(next);
          setError(null);
        } else {
          setError(result.error);
        }
      });
    }, delay);
    return () => { alive = false; clearTimeout(timer); };
  }, [current, state.theme, waiting]);

  // The pan/zoom controller lives as long as the canvas does.
  useEffect(() => {
    const view = viewportRef.current;
    const target = contentRef.current;
    if (!view || !target) return;
    const instance = new PanZoomController(view, target, {
      onChange: (next) => {
        // The dot grid moves and scales with the diagram, set directly so it never waits on React.
        const spacing = 22 * Math.max(0.35, Math.min(2.5, next.scale));
        view.style.backgroundSize = `${spacing}px ${spacing}px`;
        view.style.backgroundPosition = `${next.x}px ${next.y}px`;
        setTransform(next);
      },
      onUserMove: () => { autoFit.current = false; },
    });
    controller.current = instance;
    const observer = new ResizeObserver(() => {
      setViewport(instance.viewportSize);
      if (autoFit.current) instance.fit(false);
      else instance.set(instance.transform);
    });
    observer.observe(view);
    return () => {
      observer.disconnect();
      instance.destroy();
      controller.current = null;
    };
  }, []);

  // Put a new render on the canvas, sized to its own coordinate box.
  const firstDraw = useRef(true);
  useLayoutEffect(() => {
    const target = contentRef.current;
    const instance = controller.current;
    if (!target || !instance || !rendered) return;
    target.innerHTML = rendered.svg;
    const svg = target.querySelector("svg");
    if (!svg) return;
    const box = diagramBox(svg);
    svg.setAttribute("width", String(box.width));
    svg.setAttribute("height", String(box.height));
    svg.style.maxWidth = "none";
    const size = { width: box.width, height: box.height };
    instance.setContentSize(size);
    setContent(size);
    setViewport(instance.viewportSize);
    if (autoFit.current) instance.fit(!firstDraw.current);
    else instance.set(instance.transform);
    firstDraw.current = false;
    try {
      setMinimapImage(svgDataUrl(buildStandaloneSvg(svg, { background: CANVAS[rendered.theme], fonts: {} }).markup));
    } catch {
      setMinimapImage("");
    }
  }, [rendered]);

  /* ── actions ── */

  const zoomBy = useCallback((factor: number) => { autoFit.current = false; controller.current?.zoomBy(factor); }, []);
  const zoomTo = useCallback((scale: number) => { autoFit.current = false; controller.current?.zoomTo(scale); }, []);
  const fit = useCallback(() => { autoFit.current = true; controller.current?.fit(true); }, []);
  const panBy = useCallback((dx: number, dy: number) => { autoFit.current = false; controller.current?.panBy(dx, dy, true); }, []);
  const toggleSource = useCallback(() => update({ showSource: !state.showSource }), [state.showSource, update]);
  const toggleTheme = useCallback(() => update({ theme: state.theme === "dark" ? "light" : "dark" }), [state.theme, update]);
  const toggleMinimap = useCallback(() => update({ showMinimap: !state.showMinimap }), [state.showMinimap, update]);

  /** A standalone copy of what is on screen — the last successful render, even mid-edit. */
  const standalone = useCallback((transparent: boolean): StandaloneSvg | null => {
    const svg = contentRef.current?.querySelector("svg");
    if (!svg || !rendered) return null;
    return buildStandaloneSvg(svg, { background: transparent ? null : CANVAS[rendered.theme], fonts });
  }, [fonts, rendered]);

  const png = useCallback(async (transparent: boolean): Promise<Blob> => {
    const image = standalone(transparent);
    if (!image || !rendered) throw new Error("There is no diagram to export yet.");
    try {
      return await rasterize(image, PNG_SCALE);
    } catch (error) {
      if (!(error instanceof TaintedCanvasError)) throw error;
      // HTML labels made the canvas unreadable here; redraw with SVG text labels and retry.
      const retry = await renderMermaid(rendered.source, { theme: rendered.theme, htmlLabels: false });
      const element = "svg" in retry ? parseSvg(retry.svg) : null;
      if (!element) throw new Error("This diagram could not be converted to PNG.");
      return rasterize(buildStandaloneSvg(element, { background: transparent ? null : CANVAS[rendered.theme], fonts }), PNG_SCALE);
    }
  }, [fonts, rendered, standalone]);

  const fileStem = rendered ? diagramFileStem(rendered.source) : "diagram";

  const copySource = useCallback(async () => {
    const copied = await copyText(current);
    notify(copied ? "Copied the Mermaid source" : "Could not reach the clipboard", copied ? "info" : "error");
  }, [current, notify]);

  const copySvg = useCallback(async () => {
    const image = standalone(false);
    if (!image) return;
    const copied = await copyText(image.markup);
    notify(copied ? "Copied as SVG markup" : "Could not reach the clipboard", copied ? "info" : "error");
  }, [notify, standalone]);

  // Stable handlers, so the memoized source panel does not re-render on every zoom frame.
  const editSource = useCallback((value: string) => {
    setState((previous) => {
      const next = { ...previous, draft: value === previous.source ? null : value };
      writeUiState("diagram", next);
      return next;
    });
  }, []);
  const revertSource = useCallback(() => update({ draft: null }), [update]);
  const closeSource = useCallback(() => update({ showSource: false }), [update]);
  const resizeSource = useCallback((width: number) => update({ sourceWidth: width }), [update]);
  const copySourceFromPanel = useCallback(() => void copySource(), [copySource]);

  // Saved diagrams: write this tab's edits to its file, or keep an unsaved diagram with the
  // project so the agent can read and patch it.
  const saveToFile = useCallback(() => {
    const { draft, source } = latestState.current;
    post({ type: "diagram_write", source: draft ?? source });
  }, []);
  const saveToProject = useCallback(() => {
    const { draft, source } = latestState.current;
    post({ type: "diagram_save_to_project", source: draft ?? source });
  }, []);

  const copyPng = useCallback(async () => {
    try {
      // Hand the clipboard a promise so the write keeps this click's user activation while
      // the PNG is still being encoded.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png(false) })]);
      notify("Copied as a PNG image");
    } catch (error) {
      notify(error instanceof Error && error.message ? `Could not copy the image: ${error.message}` : "Could not copy the image", "error");
    }
  }, [notify, png]);

  const exportSvg = useCallback((transparent: boolean) => {
    const image = standalone(transparent);
    if (!image) return;
    post({ type: "diagram_save", format: "svg", fileName: `${fileStem}.svg`, data: image.markup });
  }, [fileStem, standalone]);

  const exportPng = useCallback(async (transparent: boolean) => {
    try {
      const data = await blobToBase64(await png(transparent));
      post({ type: "diagram_save", format: "png", fileName: `${fileStem}.png`, data });
    } catch (error) {
      notify(error instanceof Error ? error.message : "The PNG could not be created.", "error");
    }
  }, [fileStem, notify, png]);

  // Ctrl/Cmd+S saves a saved diagram's edits, including from inside the source editor.
  useEffect(() => {
    function onSave(event: KeyboardEvent): void {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "s") return;
      const { draft, source, file } = latestState.current;
      if (!file) return;
      event.preventDefault();
      if (draft !== null && draft !== source) saveToFile();
    }
    window.addEventListener("keydown", onSave);
    return () => window.removeEventListener("keydown", onSave);
  }, [saveToFile]);

  // Keyboard, window-wide except while typing in the source editor or a menu.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || isTyping(event.target)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const step = event.shiftKey ? 240 : 60;
      const actions: Record<string, () => void> = {
        "+": () => zoomBy(ZOOM_STEP),
        "=": () => zoomBy(ZOOM_STEP),
        "-": () => zoomBy(1 / ZOOM_STEP),
        "_": () => zoomBy(1 / ZOOM_STEP),
        "0": fit,
        "1": () => zoomTo(1),
        "2": () => zoomTo(2),
        ArrowLeft: () => panBy(step, 0),
        ArrowRight: () => panBy(-step, 0),
        ArrowUp: () => panBy(0, step),
        ArrowDown: () => panBy(0, -step),
        s: toggleSource,
        S: toggleSource,
        t: toggleTheme,
        T: toggleTheme,
        m: toggleMinimap,
        M: toggleMinimap,
        "?": () => setHelpOpen((open) => !open),
        Escape: () => setHelpOpen(false),
      };
      const action = actions[event.key];
      if (!action) return;
      event.preventDefault();
      action();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fit, panBy, toggleMinimap, toggleSource, toggleTheme, zoomBy, zoomTo]);

  /* ── render ── */

  const { kind, title } = describeMermaid(current);
  const overflowing = content.width * transform.scale > viewport.width + 1 || content.height * transform.scale > viewport.height + 1;
  const showMinimap = state.showMinimap && overflowing && !!minimapImage && content.width > 0;
  const noDiagram = !rendered;

  return (
    <Tooltip.Provider>
      <div className="dv-root" data-theme={state.theme}>
        <header className="dv-bar">
          <span className="dv-title-icon" aria-hidden="true"><Workflow className="size-4" /></span>
          <div className="dv-title">
            <span className="dv-title-main">{title ?? kind}</span>
            {title && <span className="dv-title-kind">{kind}</span>}
            {state.file && <span className="dv-title-kind" title={state.file.path}>{state.file.name}</span>}
          </div>
          {edited && <span className="dv-badge">Edited</span>}
          <span className="flex-1" />
          {state.file ? (
            <ToolButton
              label={edited ? `Save your changes to ${state.file.name}` : `${state.file.name} is up to date`}
              shortcut="Ctrl+S"
              disabled={!edited}
              onClick={saveToFile}
            >
              <Save className="size-4" /><span className="dv-tool-text">Save</span>
            </ToolButton>
          ) : (
            <ToolButton label="Save to this project, where the agent can read and edit it" onClick={saveToProject} disabled={waiting}>
              <FolderPlus className="size-4" /><span className="dv-tool-text">Save to project</span>
            </ToolButton>
          )}
          <ToolButton label={state.showSource ? "Hide source" : "Show source"} shortcut="S" active={state.showSource} onClick={toggleSource}>
            <Code className="size-4" /><span className="dv-tool-text">Source</span>
          </ToolButton>
          <ToolButton label={state.theme === "dark" ? "Light canvas" : "Dark canvas"} shortcut="T" onClick={toggleTheme}>
            {state.theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </ToolButton>
          <Menu label="Copy" icon={<Copy className="size-4" />}>
            <MenuItem onSelect={() => void copySource()} disabled={waiting}>Mermaid source</MenuItem>
            <MenuItem onSelect={() => void copySvg()} hint="SVG" disabled={noDiagram}>As SVG markup</MenuItem>
            <MenuItem onSelect={() => void copyPng()} hint={`${PNG_SCALE}×`} disabled={noDiagram}>As PNG image</MenuItem>
          </Menu>
          <Menu label="Export" icon={<Download className="size-4" />}>
            <MenuItem onSelect={() => exportSvg(false)} hint=".svg" disabled={noDiagram}>SVG</MenuItem>
            <MenuItem onSelect={() => exportSvg(true)} hint=".svg" disabled={noDiagram}>SVG, transparent</MenuItem>
            <DropdownMenu.Separator className="dv-menu-separator" />
            <MenuItem onSelect={() => void exportPng(false)} hint={`${PNG_SCALE}× .png`} disabled={noDiagram}>PNG</MenuItem>
            <MenuItem onSelect={() => void exportPng(true)} hint={`${PNG_SCALE}× .png`} disabled={noDiagram}>PNG, transparent</MenuItem>
          </Menu>
          <ToolButton label="Shortcuts" shortcut="?" onClick={() => setHelpOpen(true)}><Keyboard className="size-4" /></ToolButton>
        </header>

        <div className="dv-body">
          <div className="dv-stage">
            <div
              ref={viewportRef}
              className="dv-viewport"
              tabIndex={0}
              role="region"
              aria-label={`${title ?? kind}. Scroll or pinch to zoom, drag to pan, press ? for shortcuts.`}
            >
              <div ref={contentRef} className="dv-content" />
            </div>

            {noDiagram && (!error || waiting) && <div className="dv-state dv-overlay"><span className="dv-spinner" aria-hidden="true" />Rendering diagram…</div>}
            {noDiagram && error && !waiting && (
              <div className="dv-state dv-state-error dv-overlay" role="alert">
                <TriangleAlert className="size-5" aria-hidden="true" />
                <div className="dv-state-title">This diagram could not be drawn</div>
                <pre className="dv-state-message">{error}</pre>
                {!state.showSource && <button type="button" className="dv-button" onClick={toggleSource}>Edit the source</button>}
              </div>
            )}
            {!noDiagram && error && (
              <div className="dv-banner dv-overlay" role="status">
                <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">Showing the last version that rendered — {error.split("\n")[0]}</span>
              </div>
            )}

            <div className="dv-dock dv-overlay" role="toolbar" aria-label="Zoom">
              <ToolButton label="Zoom out" shortcut="−" onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={noDiagram}><Minus className="size-4" /></ToolButton>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button type="button" className="dv-zoom-level" aria-label={`Zoom level ${percent(transform.scale)}`} disabled={noDiagram}>
                    {percent(transform.scale)}
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="dv-menu" side="top" align="center" sideOffset={8}>
                    <MenuItem onSelect={fit} hint="0">Fit to window</MenuItem>
                    <DropdownMenu.Separator className="dv-menu-separator" />
                    {ZOOM_PRESETS.map((preset) => (
                      <DropdownMenu.Item key={preset} className="dv-menu-item" onSelect={() => zoomTo(preset)}>
                        <span>{percent(preset)}</span>
                        {Math.abs(transform.scale - preset) < 0.005 && <Check className="size-3.5" aria-hidden="true" />}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
              <ToolButton label="Zoom in" shortcut="+" onClick={() => zoomBy(ZOOM_STEP)} disabled={noDiagram}><Plus className="size-4" /></ToolButton>
              <span className="dv-dock-divider" aria-hidden="true" />
              <ToolButton label="Fit to window" shortcut="0" onClick={fit} disabled={noDiagram}><Maximize className="size-4" /></ToolButton>
              <ToolButton label="Actual size" shortcut="1" onClick={() => zoomTo(1)} disabled={noDiagram}><span className="dv-one-to-one">1:1</span></ToolButton>
              <span className="dv-dock-divider" aria-hidden="true" />
              <ToolButton label={state.showMinimap ? "Hide minimap" : "Show minimap"} shortcut="M" active={state.showMinimap} onClick={toggleMinimap}>
                <MapIcon className="size-4" />
              </ToolButton>
            </div>

            {showMinimap && (
              <Minimap
                image={minimapImage}
                content={content}
                viewport={viewport}
                transform={transform}
                onNavigate={(point, animate) => { autoFit.current = false; controller.current?.centerOn(point, animate); }}
              />
            )}
          </div>

          {state.showSource && (
            <SourcePanel
              value={current}
              edited={edited}
              error={error}
              width={state.sourceWidth}
              onChange={editSource}
              onRevert={revertSource}
              onCopy={copySourceFromPanel}
              onClose={closeSource}
              onResize={resizeSource}
            />
          )}
        </div>

        {toast && (
          <div key={toast.id} className={cn("dv-toast", toast.tone === "error" && "is-error")} role="status" aria-live="polite">
            {toast.message}
          </div>
        )}
        {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      </div>
    </Tooltip.Provider>
  );
}
