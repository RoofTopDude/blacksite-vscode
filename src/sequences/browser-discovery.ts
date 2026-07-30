import * as fs from "node:fs";
import * as path from "node:path";
import type { BrowserDispatchScope, BrowserRunner } from "../chromium-runner.js";
import type { EntityRef } from "../runs/run-model.js";

const MAX_SCAN_FILES = 20_000;
const DEFAULT_LIMIT = 50;
const HARD_LIMIT = 200;
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".blacksite",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte"]);

export type DiscoverySource = "filesystem" | "router" | "storybook" | "tests" | "runtime";
export type SurfaceKind = "route" | "story" | "test" | "file";

export interface DiscoveredSurface {
  id: string;
  kind: SurfaceKind;
  label: string;
  source: DiscoverySource;
  confidence: number;
  reachable: boolean | "unknown";
  path?: string;
  url?: string;
  entityRef: EntityRef;
  metadata?: Record<string, unknown>;
}

export interface BrowserDiscoveryInput {
  entrypoint?: string;
  sources?: DiscoverySource[];
  include?: Array<"routes" | "stories" | "tests" | "files">;
  limit?: number;
  cursor?: string;
}

export interface BrowserDiscoveryResult {
  surfaces: DiscoveredSurface[];
  matched: number;
  nextCursor?: string;
  coverage: {
    scannedFiles: number;
    truncatedScan: boolean;
    sources: DiscoverySource[];
  };
}

function normalizedWorkspacePath(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
}

function surfaceId(kind: SurfaceKind, value: string): string {
  return `${kind}:${value.replace(/\\/g, "/").replace(/\/+/g, "/")}`;
}

function routeFromConvention(relativePath: string): string | undefined {
  const normalized = relativePath.replace(/\\/g, "/");
  let match = normalized.match(/(?:^|\/)(?:src\/)?app\/(.+\/)?page\.[^.]+$/);
  if (match) {
    const segments = (match[1] ?? "")
      .split("/")
      .filter(Boolean)
      .filter((segment) => !/^\(.+\)$/.test(segment))
      .map((segment) => segment.replace(/^\[(?:\.\.\.)?(.+)\]$/, ":$1"));
    return `/${segments.join("/")}`.replace(/\/$/, "") || "/";
  }
  match = normalized.match(/(?:^|\/)(?:src\/)?pages\/(.+)\.[^.]+$/);
  if (match && !match[1]!.startsWith("api/") && !/^_(?:app|document|error)$/.test(match[1]!)) {
    const route = match[1]!
      .replace(/\/index$/, "")
      .replace(/^index$/, "")
      .replace(/\[(?:\.\.\.)?([^\]]+)\]/g, ":$1");
    return `/${route}`.replace(/\/$/, "") || "/";
  }
  match = normalized.match(/(?:^|\/)src\/routes\/(.+)\/\+page\.[^.]+$/);
  if (match) {
    return `/${match[1]!
      .split("/")
      .filter((segment) => !/^\(.+\)$/.test(segment))
      .map((segment) => segment.replace(/^\[(?:\.\.\.)?(.+)\]$/, ":$1"))
      .join("/")}`;
  }
  if (/(?:^|\/)src\/routes\/\+page\.[^.]+$/.test(normalized)) return "/";
  return undefined;
}

function readSmallText(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 2 * 1024 * 1024) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function scanFiles(workspaceRoot: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const queue = [workspaceRoot];
  let truncated = false;
  while (queue.length > 0 && files.length < MAX_SCAN_FILES) {
    const directory = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_SCAN_FILES) {
        truncated = true;
        break;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) queue.push(absolute);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(absolute);
      }
    }
  }
  if (queue.length > 0) truncated = true;
  return { files, truncated };
}

function addSurface(surfaces: Map<string, DiscoveredSurface>, candidate: DiscoveredSurface): void {
  const existing = surfaces.get(candidate.id);
  if (!existing) {
    surfaces.set(candidate.id, candidate);
    return;
  }

  const preferred = candidate.confidence > existing.confidence ? candidate : existing;
  const secondary = preferred === candidate ? existing : candidate;
  const discoverySources = [
    ...new Set([
      ...(
        Array.isArray(existing.metadata?.["discoverySources"])
          ? existing.metadata["discoverySources"].map(String)
          : [existing.source]
      ),
      ...(
        Array.isArray(candidate.metadata?.["discoverySources"])
          ? candidate.metadata["discoverySources"].map(String)
          : [candidate.source]
      ),
    ]),
  ];
  const reachable = existing.reachable === true || candidate.reachable === true
    ? true
    : existing.reachable === false || candidate.reachable === false
      ? false
      : "unknown";
  surfaces.set(candidate.id, {
    ...secondary,
    ...preferred,
    reachable,
    ...(preferred.path ?? secondary.path ? { path: preferred.path ?? secondary.path } : {}),
    ...(preferred.url ?? secondary.url ? { url: preferred.url ?? secondary.url } : {}),
    metadata: {
      ...secondary.metadata,
      ...preferred.metadata,
      discoverySources,
    },
    entityRef: {
      ...secondary.entityRef,
      ...preferred.entityRef,
      ...(preferred.entityRef.workspacePath ?? secondary.entityRef.workspacePath
        ? { workspacePath: preferred.entityRef.workspacePath ?? secondary.entityRef.workspacePath }
        : {}),
    },
  });
}

function routeSurface(route: string, source: DiscoverySource, file?: string, confidence = 0.9): DiscoveredSurface {
  const id = surfaceId("route", route);
  return {
    id,
    kind: "route",
    label: route,
    source,
    confidence,
    reachable: "unknown",
    path: file,
    entityRef: {
      scheme: "route",
      id: route,
      ...(file ? { workspacePath: file } : {}),
      label: route,
    },
  };
}

function discoverStatic(
  workspaceRoot: string,
  files: string[],
  sources: ReadonlySet<DiscoverySource>,
  includes: ReadonlySet<string>,
): Map<string, DiscoveredSurface> {
  const surfaces = new Map<string, DiscoveredSurface>();
  for (const absolute of files) {
    const relative = normalizedWorkspacePath(workspaceRoot, absolute);
    const lower = relative.toLowerCase();
    if (sources.has("filesystem") && includes.has("routes")) {
      const route = routeFromConvention(relative);
      if (route) addSurface(surfaces, routeSurface(route, "filesystem", relative, 0.96));
    }
    if (sources.has("storybook") && includes.has("stories") && /\.stories\.[^.]+$/i.test(relative)) {
      const text = readSmallText(absolute);
      const title = text.match(/\btitle\s*:\s*["'`]([^"'`]+)["'`]/)?.[1]
        ?? path.basename(relative).replace(/\.stories\.[^.]+$/i, "");
      const id = surfaceId("story", title);
      addSurface(surfaces, {
        id,
        kind: "story",
        label: title,
        source: "storybook",
        confidence: 0.95,
        reachable: "unknown",
        path: relative,
        entityRef: { scheme: "ui-component", id: title, workspacePath: relative, label: title },
      });
    }
    if (sources.has("tests") && includes.has("tests")
      && (/(?:^|\/)(?:e2e|tests?|specs?)\//i.test(relative)
        || /\.(?:spec|test|e2e)\.[^.]+$/i.test(relative)
        || /(?:playwright|cypress)/i.test(lower))) {
      const id = surfaceId("test", relative);
      addSurface(surfaces, {
        id,
        kind: "test",
        label: path.basename(relative),
        source: "tests",
        confidence: 0.85,
        reachable: true,
        path: relative,
        entityRef: { scheme: "test", id: relative, workspacePath: relative, label: path.basename(relative) },
      });
    }
    if (sources.has("router") && includes.has("routes")) {
      const text = readSmallText(absolute);
      if (!text || !/\b(path|route|routes|createBrowserRouter|Route)\b/.test(text)) continue;
      const patterns = [
        /\bpath\s*[:=]\s*["'`]([^"'`]+)["'`]/g,
        /<Route\b[^>]*\bpath\s*=\s*["'`]([^"'`]+)["'`]/g,
      ];
      for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
          const route = match[1]?.trim();
          if (!route || !route.startsWith("/") || route.includes("*")) continue;
          addSurface(surfaces, routeSurface(route, "router", relative, 0.82));
        }
      }
    }
    if (sources.has("filesystem") && includes.has("files")) {
      const id = surfaceId("file", relative);
      addSurface(surfaces, {
        id,
        kind: "file",
        label: relative,
        source: "filesystem",
        confidence: 1,
        reachable: true,
        path: relative,
        entityRef: { scheme: "workspace-file", id: relative, workspacePath: relative, label: path.basename(relative) },
      });
    }
  }
  return surfaces;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    return (url.protocol === "http:" || url.protocol === "https:")
      && (hostname === "localhost"
        || hostname === "127.0.0.1"
        || hostname === "::1"
        || hostname.endsWith(".localhost"));
  } catch {
    return false;
  }
}

function joinEntrypoint(entrypoint: string, route: string): string | undefined {
  try {
    const base = new URL(entrypoint);
    return new URL(route, `${base.origin}/`).toString();
  } catch {
    return undefined;
  }
}

async function discoverRuntime(
  browser: BrowserRunner,
  entrypoint: string,
  signal: AbortSignal | undefined,
): Promise<DiscoveredSurface[]> {
  if (!isLoopbackUrl(entrypoint)) return [];
  const scope: BrowserDispatchScope = {
    allowedOrigins: [new URL(entrypoint).origin],
    localOnly: true,
  };
  const navigation = await browser.dispatch(
    "navigate",
    { url: entrypoint, waitFor: "load" },
    signal,
    scope,
  );
  if ((navigation as { ok?: boolean }).ok === false) return [];
  const result = await browser.dispatch("evaluate", {
    script: `Array.from(document.querySelectorAll("a[href]")).slice(0, 500).map((a) => ({
      href: a.href,
      label: (a.textContent || a.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 200)
    }))`,
  }, signal, scope) as { ok?: boolean; result?: Array<{ href?: unknown; label?: unknown }> };
  if (!result.ok || !Array.isArray(result.result)) return [];
  const base = new URL(entrypoint);
  const seen = new Set<string>();
  const surfaces: DiscoveredSurface[] = [];
  for (const candidate of result.result) {
    try {
      const url = new URL(String(candidate.href ?? ""), base);
      if (url.origin !== base.origin) continue;
      url.search = "";
      url.hash = "";
      const route = url.pathname || "/";
      if (seen.has(route)) continue;
      seen.add(route);
      const surface = routeSurface(route, "runtime", undefined, 0.9);
      surface.url = url.toString();
      surface.label = String(candidate.label ?? "").trim() || route;
      surface.reachable = true;
      surfaces.push(surface);
    } catch {
      // Ignore malformed links from the page.
    }
  }
  return surfaces;
}

function decodeCursor(value: string | undefined): number {
  if (!value) return 0;
  try {
    const parsed = Number(Buffer.from(value, "base64url").toString("utf8"));
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

export async function discoverBrowserSurfaces(
  workspaceRoot: string,
  input: BrowserDiscoveryInput,
  browser?: BrowserRunner,
  signal?: AbortSignal,
): Promise<BrowserDiscoveryResult> {
  const sources = new Set<DiscoverySource>(
    input.sources?.length
      ? input.sources
      : ["filesystem", "router", "storybook", "tests", ...(input.entrypoint ? ["runtime" as const] : [])],
  );
  const includes = new Set(input.include?.length ? input.include : ["routes", "stories", "tests"]);
  const scan = scanFiles(workspaceRoot);
  const surfaces = discoverStatic(workspaceRoot, scan.files, sources, includes);
  if (sources.has("runtime") && input.entrypoint && browser && !signal?.aborted) {
    for (const surface of await discoverRuntime(browser, input.entrypoint, signal)) {
      addSurface(surfaces, surface);
    }
  }

  if (input.entrypoint) {
    for (const surface of surfaces.values()) {
      if (surface.kind !== "route" || surface.url) continue;
      surface.url = joinEntrypoint(input.entrypoint, surface.entityRef.id);
    }
  }

  const all = [...surfaces.values()].sort((left, right) =>
    right.confidence - left.confidence
    || left.kind.localeCompare(right.kind)
    || left.label.localeCompare(right.label),
  );
  const offset = decodeCursor(input.cursor);
  const limit = Math.max(1, Math.min(HARD_LIMIT, Math.floor(input.limit ?? DEFAULT_LIMIT)));
  const page = all.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    surfaces: page,
    matched: all.length,
    ...(nextOffset < all.length ? { nextCursor: Buffer.from(String(nextOffset)).toString("base64url") } : {}),
    coverage: {
      scannedFiles: scan.files.length,
      truncatedScan: scan.truncated,
      sources: [...sources],
    },
  };
}
