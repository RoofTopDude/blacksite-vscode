import { clusterDir, langOf, normalizeGraphPath, type GraphEdge } from "./graph-model.js";
import {
  buildProjectReferenceMap,
  owningProjectForPath,
  shareContainer,
  type ProjectTopology,
} from "./project-topology.js";

export interface IndexedFileContent {
  path: string;
  content: string;
}

export interface ServiceInfo {
  id: string;
  root: string;
  name: string;
  markers: string[];
}

interface ApiProvider {
  service: ServiceInfo;
  path: string;
  method?: string;
  operation?: string;
  sourcePath: string;
  /** Zero-based source line. */
  line?: number;
  offset?: number;
  evidence: string;
}

interface ApiConsumer {
  service: ServiceInfo;
  path?: string;
  method?: string;
  host?: string;
  operation?: string;
  sourcePath: string;
  /** Zero-based source line. */
  line?: number;
  offset?: number;
  evidence: string;
}

interface EventSignal {
  service: ServiceInfo;
  topic: string;
  role: "publish" | "subscribe";
  sourcePath: string;
  /** Zero-based source line. */
  line: number;
  offset: number;
  evidence: string;
}

interface DataSignal {
  service: ServiceInfo;
  resource: string;
  role: "read" | "write";
  sourcePath: string;
  /** Zero-based source line. */
  line: number;
  offset: number;
  evidence: string;
}

interface CSharpClientIndex {
  namedBaseAddresses: Map<string, string>;
  typedBaseAddresses: Map<string, string>;
  classNamesByFile: Map<string, string[]>;
}

export interface RelationshipResult {
  services: ServiceInfo[];
  edges: GraphEdge[];
  truncated: boolean;
}

const MARKER_NAMES = new Set([
  "package.json", "pyproject.toml", "go.mod", "cargo.toml", "pom.xml", "dockerfile", "docker-compose.yml", "docker-compose.yaml",
  "gemfile", "composer.json", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "pubspec.yaml", "mix.exs", "build.sbt", "package.swift",
]);
/* .NET has no fixed marker filename (each project carries its own <Name>.csproj
   alongside a solution-level .sln); recognized by extension instead. */
const MARKER_EXT_RE = /(?:\.(?:csproj|sln|rockspec)|^dockerfile(?:\.[^/]+)?)$/i;
const SPEC_RE = /\.(openapi|swagger)\.(json|ya?ml)$|openapi\.(json|ya?ml)$|swagger\.(json|ya?ml)$|\.proto$|\.(?:graphqls?|gql)$|schema\.graphql$/i;
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
const MAX_EVIDENCE_SAMPLES = 8;
/** Iterate every match of a global regex against content, resetting lastIndex
    first — avoids repeating the exec-loop boilerplate at every call site. */
function* matches(re: RegExp, content: string): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  for (let m = re.exec(content); m !== null; m = re.exec(content)) yield m;
}

/* Line starts are built once per file object and then binary-searched by every
   extractor. This avoids repeatedly counting from byte zero in files with many
   relationship signals. */
const LINE_STARTS = new WeakMap<IndexedFileContent, number[]>();

function sourceLine(file: IndexedFileContent, offset: number | undefined): number {
  const target = Math.max(0, offset ?? 0);
  let starts = LINE_STARTS.get(file);
  if (!starts) {
    starts = [0];
    for (let i = 0; i < file.content.length; i += 1) {
      if (file.content.charCodeAt(i) === 10) starts.push(i + 1);
    }
    LINE_STARTS.set(file, starts);
  }
  let lo = 0;
  let hi = starts.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if ((starts[mid] ?? 0) <= target) lo = mid;
    else hi = mid;
  }
  return lo;
}

function stableRelationshipId(
  kind: "api" | "event" | "data" | "config",
  parts: readonly (string | number | undefined)[],
): string {
  return `rel:${kind}:${parts.map((part) => encodeURIComponent(String(part ?? ""))).join(":")}`;
}

function dirname(file: string): string {
  const idx = file.lastIndexOf("/");
  return idx < 0 ? "." : file.slice(0, idx) || ".";
}

function basename(path: string): string {
  const parts = normalizeGraphPath(path).split("/").filter(Boolean);
  return parts[parts.length - 1] || path || ".";
}

function normalizeServiceRoot(filePath: string): string {
  const dir = dirname(filePath);
  return dir === "." ? "." : dir;
}

function serviceName(root: string): string {
  return root === "." ? "workspace" : basename(root);
}

function nearestService(filePath: string, services: ServiceInfo[]): ServiceInfo {
  const normalized = normalizeGraphPath(filePath);
  const sorted = [...services].sort((a, b) => b.root.length - a.root.length);
  const matched = sorted.find((svc) => svc.root === "." || normalized === svc.root || normalized.startsWith(`${svc.root}/`));
  if (matched && matched.markers.every((marker) => SPEC_RE.test(marker))) {
    const projectRoot = sorted.find((svc) =>
      svc.root !== matched.root
      && !svc.markers.every((marker) => SPEC_RE.test(marker))
      && (normalized === svc.root || normalized.startsWith(`${svc.root}/`))
    );
    if (projectRoot) return projectRoot;
  }
  return matched ?? { id: clusterDir(normalized), root: clusterDir(normalized), name: basename(clusterDir(normalized)), markers: ["cluster"] };
}

export function detectServices(files: readonly string[], topology?: ProjectTopology | null): ServiceInfo[] {
  const byRoot = new Map<string, ServiceInfo>();
  const add = (root: string, marker: string): void => {
    const normalized = normalizeGraphPath(root) || ".";
    const existing = byRoot.get(normalized);
    if (existing) {
      if (!existing.markers.includes(marker)) existing.markers.push(marker);
      return;
    }
    byRoot.set(normalized, { id: normalized, root: normalized, name: serviceName(normalized), markers: [marker] });
  };
  for (const project of topology?.projects ?? []) {
    const marker = project.manifestFiles.map((file) => basename(file)).find(Boolean) ?? project.kind;
    add(project.root, marker);
  }
  for (const raw of files) {
    const file = normalizeGraphPath(raw);
    const name = basename(file);
    if (MARKER_NAMES.has(name.toLowerCase()) || MARKER_EXT_RE.test(name) || SPEC_RE.test(file) || file.includes("/k8s/") || file.includes("/helm/")) {
      add(normalizeServiceRoot(file), name);
    }
  }
  if (byRoot.size === 0) {
    for (const file of files) add(clusterDir(file), "cluster");
  }
  return [...byRoot.values()].sort((a, b) => a.root.localeCompare(b.root));
}

function collectOpenApiProviders(file: IndexedFileContent, service: ServiceInfo): ApiProvider[] {
  if (!/(openapi|swagger)/i.test(file.path) && !/(openapi|swagger)["']?\s*:/i.test(file.content)) return [];
  const out: ApiProvider[] = [];
  const re = /["']?(\/[A-Za-z0-9_./{}:-]+)["']?\s*:\s*(?:\r?\n|\{)([\s\S]{0,2200})/g;
  for (let m = re.exec(file.content); m !== null; m = re.exec(file.content)) {
    const path = m[1] ?? "";
    const block = m[2] ?? "";
    for (const method of HTTP_METHODS) {
      const methodRe = new RegExp(`["']?${method}["']?\\s*:`, "i");
      if (methodRe.test(block)) {
        const op = /operationId["']?\s*:\s*["']?([A-Za-z0-9_.:-]+)/i.exec(block)?.[1];
        out.push({
          service,
          path,
          method: method.toUpperCase(),
          operation: op,
          sourcePath: file.path,
          line: sourceLine(file, m.index),
          offset: m.index,
          evidence: `${method.toUpperCase()} ${path}`,
        });
      }
    }
  }
  const lines = file.content.split(/\r?\n/);
  let currentPath: string | undefined;
  let currentMethod: string | undefined;
  let operation: string | undefined;
  let currentLine: number | undefined;
  const flush = (): void => {
    if (currentPath && currentMethod) {
      const duplicate = out.some((provider) => provider.path === currentPath && provider.method === currentMethod);
      if (!duplicate) {
        out.push({
          service,
          path: currentPath,
          method: currentMethod,
          operation,
          sourcePath: file.path,
          line: currentLine,
          evidence: `${currentMethod} ${currentPath}`,
        });
      }
    }
  };
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber] ?? "";
    const pathMatch = /^\s*["']?(\/[A-Za-z0-9_./{}:-]+)["']?\s*:\s*$/.exec(line);
    if (pathMatch) {
      flush();
      currentPath = pathMatch[1];
      currentMethod = undefined;
      operation = undefined;
      currentLine = lineNumber;
      continue;
    }
    const methodMatch = /^\s*(get|post|put|patch|delete|head|options)\s*:\s*$/i.exec(line);
    if (methodMatch && currentPath) {
      flush();
      currentMethod = methodMatch[1]?.toUpperCase();
      operation = undefined;
      currentLine = lineNumber;
      continue;
    }
    const opMatch = /^\s*operationId\s*:\s*["']?([A-Za-z0-9_.:-]+)/i.exec(line);
    if (opMatch && currentPath && currentMethod) operation = opMatch[1];
  }
  flush();
  return out;
}

function collectProtoProviders(file: IndexedFileContent, service: ServiceInfo): ApiProvider[] {
  if (!file.path.endsWith(".proto")) return [];
  const out: ApiProvider[] = [];
  const serviceRe = /\bservice\s+([A-Za-z_][\w]*)\s*\{([\s\S]*?)\}/g;
  for (let m = serviceRe.exec(file.content); m !== null; m = serviceRe.exec(file.content)) {
    const svc = m[1] ?? "";
    const body = m[2] ?? "";
    const rpcRe = /\brpc\s+([A-Za-z_][\w]*)\s*\(/g;
    for (let r = rpcRe.exec(body); r !== null; r = rpcRe.exec(body)) {
      const rpc = r[1] ?? "";
      const offset = (m.index ?? 0) + m[0].indexOf(body) + (r.index ?? 0);
      out.push({
        service,
        path: `${svc}/${rpc}`,
        operation: `${svc}.${rpc}`,
        sourcePath: file.path,
        line: sourceLine(file, offset),
        offset,
        evidence: `rpc ${svc}.${rpc}`,
      });
    }
  }
  return out;
}

function collectGraphqlProviders(file: IndexedFileContent, service: ServiceInfo): ApiProvider[] {
  if (!/\.(?:graphqls?|gql)$/i.test(file.path) && !/\b(type|extend type)\s+(Query|Mutation)\b/.test(file.content)) return [];
  const out: ApiProvider[] = [];
  const typeRe = /\b(?:extend\s+)?type\s+(Query|Mutation)\s*\{([\s\S]*?)\}/g;
  for (let m = typeRe.exec(file.content); m !== null; m = typeRe.exec(file.content)) {
    const kind = m[1] ?? "Query";
    const body = m[2] ?? "";
    const fieldRe = /^\s*([A-Za-z_][\w]*)\s*(?:\(|:)/gm;
    for (let f = fieldRe.exec(body); f !== null; f = fieldRe.exec(body)) {
      const field = f[1] ?? "";
      const offset = (m.index ?? 0) + m[0].indexOf(body) + (f.index ?? 0);
      out.push({
        service,
        path: `${kind}.${field}`,
        operation: `${kind}.${field}`,
        sourcePath: file.path,
        line: sourceLine(file, offset),
        offset,
        evidence: `GraphQL ${kind}.${field}`,
      });
    }
  }
  return out;
}

function findMatchingBrace(content: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < content.length; i += 1) {
    const char = content[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return content.length - 1;
}

function precedingAttributeBlock(content: string, index: number): string {
  const prefix = content.slice(0, index);
  const lines = prefix.split(/\r?\n/);
  const collected: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      if (collected.length > 0) collected.unshift(line);
      continue;
    }
    if (/^\[[^\n]+\]\s*$/.test(trimmed)) {
      collected.unshift(line);
      continue;
    }
    break;
  }
  return collected.join("\n");
}

function parseAspNetAttributes(block: string): {
  routes: string[];
  methods: Array<{ method?: string; path?: string }>;
} {
  const routes: string[] = [];
  const methods: Array<{ method?: string; path?: string }> = [];
  const routeRe = /\[Route\s*\(\s*["']([^"']+)["'][^)]*\)\]/g;
  for (const match of matches(routeRe, block)) {
    const path = match[1]?.trim();
    if (path) routes.push(path);
  }
  const httpRe = /\[Http(Get|Post|Put|Patch|Delete|Head|Options)\s*(?:\(\s*["']([^"']+)["']\s*\))?\]/g;
  for (const match of matches(httpRe, block)) {
    methods.push({
      method: (match[1] ?? "").toUpperCase(),
      path: match[2]?.trim() || undefined,
    });
  }
  return { routes, methods };
}

function expandAspNetTokens(template: string, controllerName: string, actionName: string): string {
  return template
    .replace(/\[controller\]/gi, controllerName)
    .replace(/\[action\]/gi, actionName);
}

function composeAspNetRoute(baseRoute: string, actionRoute: string, controllerName: string, actionName: string): string {
  const base = expandAspNetTokens(baseRoute, controllerName, actionName).replace(/^~?\//, "").replace(/\/+$/, "");
  const action = expandAspNetTokens(actionRoute, controllerName, actionName).replace(/^~?\//, "").replace(/\/+$/, "");
  if (!base) return action;
  if (!action) return base;
  if (actionRoute.startsWith("/") || actionRoute.startsWith("~/")) return action;
  return `${base}/${action}`.replace(/\/+/g, "/");
}

function collectAspNetRouteProviders(file: IndexedFileContent, service: ServiceInfo): ApiProvider[] {
  if (!/Controller/.test(file.content) || !/\[(?:Route|Http(?:Get|Post|Put|Patch|Delete|Head|Options))/.test(file.content)) return [];
  const out: ApiProvider[] = [];
  const seen = new Set<string>();
  const classRe = /\bclass\s+([A-Za-z_]\w*Controller)\b[^{]*\{/g;
  for (const classMatch of matches(classRe, file.content)) {
    const className = classMatch[1] ?? "";
    const controllerName = className.replace(/Controller$/, "");
    const classStart = classMatch.index ?? 0;
    const openBrace = file.content.indexOf("{", classStart);
    if (openBrace < 0) continue;
    const closeBrace = findMatchingBrace(file.content, openBrace);
    const classBody = file.content.slice(openBrace + 1, closeBrace);
    const controllerAttrs = parseAspNetAttributes(precedingAttributeBlock(file.content, classStart));
    const controllerRoutes = controllerAttrs.routes.length > 0 ? controllerAttrs.routes : [""];
    const methodRe = /((?:\s*\[[^\n]+\]\s*)+)\s*(?:public|internal|protected|private|async|static|virtual|override|sealed|partial|new|\s)+[A-Za-z0-9_<>\[\],?.\s]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:=>|\{)/g;
    for (const methodMatch of matches(methodRe, classBody)) {
      const offset = openBrace + 1 + methodMatch.index;
      const attrBlock = methodMatch[1] ?? "";
      const actionName = methodMatch[2] ?? "";
      const attrs = parseAspNetAttributes(attrBlock);
      const actionRoutes = attrs.routes.length > 0 ? attrs.routes : [""];
      if (attrs.methods.length === 0 && attrs.routes.length === 0) continue;
      if (attrs.methods.length === 0) {
        for (const controllerRoute of controllerRoutes) {
          for (const actionRoute of actionRoutes) {
            const path = composeAspNetRoute(controllerRoute, actionRoute, controllerName, actionName);
            if (!path) continue;
            const key = `${path}\u0000${file.path}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
              service,
              path,
              sourcePath: file.path,
              line: sourceLine(file, offset),
              offset,
              evidence: `[Route] ${path}`,
            });
          }
        }
        continue;
      }
      for (const http of attrs.methods) {
        const pathVariants = new Set<string>();
        if (http.path !== undefined) pathVariants.add(http.path);
        for (const actionRoute of actionRoutes) pathVariants.add(actionRoute);
        if (pathVariants.size === 0) pathVariants.add("");
        for (const controllerRoute of controllerRoutes) {
          for (const actionRoute of pathVariants) {
            const path = composeAspNetRoute(controllerRoute, actionRoute, controllerName, actionName);
            if (!path) continue;
            const key = `${http.method ?? ""}\u0000${path}\u0000${file.path}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
              service,
              method: http.method,
              path,
              sourcePath: file.path,
              line: sourceLine(file, offset),
              offset,
              evidence: `[Http${http.method}] ${path}`,
            });
          }
        }
      }
    }
  }
  return out;
}

function collectRouteProviders(file: IndexedFileContent, service: ServiceInfo): ApiProvider[] {
  const out: ApiProvider[] = [];
  const lang = langOf(file.path);
  const location = (match: RegExpExecArray) => ({
    sourcePath: file.path,
    line: sourceLine(file, match.index),
    offset: match.index,
  });

  const routeRe = new RegExp(`\\b(?:app|router|server)\\s*\\.\\s*(${HTTP_METHODS.join("|")})\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]`, "gi");
  for (const m of matches(routeRe, file.content)) {
    out.push({ service, method: (m[1] ?? "GET").toUpperCase(), path: m[2] ?? "", ...location(m), evidence: `${m[1]?.toUpperCase()} ${m[2]}` });
  }
  const decoratorRe = /@(?:app|router|Controller)?\.?(Get|Post|Put|Patch|Delete|Head|Options|get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g;
  for (const m of matches(decoratorRe, file.content)) {
    out.push({ service, method: (m[1] ?? "GET").toUpperCase(), path: m[2] ?? "", ...location(m), evidence: `${m[1]?.toUpperCase()} ${m[2]}` });
  }
  const pyRouteRe = /@(?:app|router|blueprint)\.(get|post|put|patch|delete|route)\s*\(\s*["']([^"']+)["']/g;
  for (const m of matches(pyRouteRe, file.content)) {
    out.push({ service, method: (m[1] === "route" ? "GET" : m[1] ?? "GET").toUpperCase(), path: m[2] ?? "", ...location(m), evidence: `${m[1]?.toUpperCase()} ${m[2]}` });
  }

  if (lang === "go") {
    /* Go router idioms: gorilla/mux, chi, Gin, and Echo all register routes as
       `<router-var>.<Method>("/path", handler)` on a short conventional
       receiver — the same shape as Express, just a different identifier.
       Paths may be backtick raw strings. */
    const goRouteRe = new RegExp(`\\b(?:r|mux|e|rg)\\s*\\.\\s*(${HTTP_METHODS.join("|")})\\s*\\(\\s*["\`]([^"\`\\n]+)["\`]`, "gi");
    for (const m of matches(goRouteRe, file.content)) {
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), path: m[2] ?? "", ...location(m), evidence: `${m[1]?.toUpperCase()} ${m[2]}` });
    }
    /* net/http stdlib: HandleFunc/Handle register a path for every method (the
       handler dispatches on r.Method itself), so no method is recorded — an
       unset provider.method matches any consumer method. */
    const goHandleFuncRe = /\bhttp\.(?:HandleFunc|Handle)\s*\(\s*["`]([^"`\n]+)["`]/g;
    for (const m of matches(goHandleFuncRe, file.content)) {
      const path = m[1] ?? "";
      out.push({ service, path, ...location(m), evidence: `HandleFunc ${path}` });
    }
  }

  if (lang === "java") {
    /* Spring: @GetMapping/@PostMapping/etc name the method directly;
       @RequestMapping is method-agnostic unless it carries `method =
       RequestMethod.X`. Controller/method path prefixes are not composed (same
       simplification the NestJS decorator handling above already makes). */
    const springMappingRe = /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g;
    for (const m of matches(springMappingRe, file.content)) {
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), path: m[2] ?? "", ...location(m), evidence: `@${m[1]}Mapping ${m[2]}` });
    }
    const springRequestMappingRe = /@RequestMapping\s*\(([^)]{0,300})\)/g;
    for (const m of matches(springRequestMappingRe, file.content)) {
      const args = m[1] ?? "";
      const path = /(?:value|path)\s*=\s*["']([^"']+)["']/.exec(args)?.[1] ?? /^\s*["']([^"']+)["']/.exec(args)?.[1];
      if (!path) continue;
      const method = /RequestMethod\.(GET|POST|PUT|PATCH|DELETE)/.exec(args)?.[1];
      out.push({ service, method, path, ...location(m), evidence: `@RequestMapping ${path}` });
    }
  }

  if (lang === "cs") {
    /* ASP.NET Core: [HttpGet("path")] (a bare [HttpGet] with no literal path
       carries nothing to match on, so it's skipped) and [Route("path")]
       (method-agnostic — a controller's base route or an attribute-routed
       action). `path` keeps its literal text (including any `[controller]`/
       `[action]` token) for the label/evidence; pathsCompatible is what
       treats those tokens as a wildcard segment when matching, the same way
       it already does for `{param}`. */
    const composedAspNetProviders = collectAspNetRouteProviders(file, service);
    out.push(...composedAspNetProviders);
    /* The fallback expressions below only understand one attribute at a time.
       When the controller parser succeeded they would add less-specific
       duplicates (and can win an otherwise equal match), hiding the composed
       [controller]/[action] endpoint from the service map. */
    if (composedAspNetProviders.length > 0) return out;
    const controllerName = /\bclass\s+([A-Za-z_]\w*Controller)\b/.exec(file.content)?.[1]?.replace(/Controller$/, "");
    const aspNetAttrRe = /\[Http(Get|Post|Put|Delete|Patch)\s*\(\s*["']([^"']+)["']\s*\)\]/g;
    for (const m of matches(aspNetAttrRe, file.content)) {
      const path = (m[2] ?? "").replace(/\[controller\]/gi, controllerName ?? "controller");
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), path, ...location(m), evidence: `[Http${m[1]}] ${path}` });
    }
    const aspNetRouteRe = /\[Route\s*\(\s*["']([^"']+)["']\s*\)\]/g;
    for (const m of matches(aspNetRouteRe, file.content)) {
      const path = (m[1] ?? "").replace(/\[controller\]/gi, controllerName ?? "controller");
      out.push({ service, path, ...location(m), evidence: `[Route] ${path}` });
    }
  }

  return out;
}

/** Split a captured URL/path string into (host?, path) — a bare "/x" path with
    no scheme leaves host undefined and path unchanged. Shared by every HTTP
    client pattern below so host/env-var extraction stays in one place. */
function splitUrl(raw: string): { host: string | undefined; path: string } {
  const host = /https?:\/\/([^/]+)/.exec(raw)?.[1] ?? /\$\{?([A-Z0-9_]+_(?:SERVICE|API)_URL)\}?/.exec(raw)?.[1];
  const path = raw.replace(/^https?:\/\/[^/]+/, "").replace(/\$\{?[^}/]+_(?:SERVICE|API)_URL\}?/, "") || raw;
  return { host, path };
}

function joinUrl(base: string, rel: string): string {
  if (/^https?:\/\//i.test(rel)) return rel;
  const normalizedBase = base.replace(/\/+$/, "");
  const normalizedRel = rel.replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedRel}`;
}

function buildCSharpClientIndex(files: readonly IndexedFileContent[]): CSharpClientIndex {
  const namedBaseAddresses = new Map<string, string>();
  const typedBaseAddresses = new Map<string, string>();
  const classNamesByFile = new Map<string, string[]>();
  for (const file of files) {
    if (langOf(file.path) !== "cs") continue;
    const classNames: string[] = [];
    for (const match of matches(/\bclass\s+([A-Za-z_]\w*)\b/g, file.content)) {
      const className = match[1]?.trim();
      if (className && !classNames.includes(className)) classNames.push(className);
    }
    classNamesByFile.set(file.path, classNames);
    const namedClientRe = /AddHttpClient\s*\(\s*["']([^"']+)["'][\s\S]{0,240}?BaseAddress\s*=\s*new\s+Uri\(\s*["']([^"']+)["']/g;
    for (const match of matches(namedClientRe, file.content)) {
      const name = match[1]?.trim();
      const base = match[2]?.trim();
      if (name && base) namedBaseAddresses.set(name, base);
    }
    const typedClientRe = /AddHttpClient\s*<\s*([A-Za-z_]\w*)(?:\s*,\s*[^>]+)?\s*>\s*\([\s\S]{0,240}?BaseAddress\s*=\s*new\s+Uri\(\s*["']([^"']+)["']/g;
    for (const match of matches(typedClientRe, file.content)) {
      const className = match[1]?.trim();
      const base = match[2]?.trim();
      if (className && base) typedBaseAddresses.set(className, base);
    }
  }
  return { namedBaseAddresses, typedBaseAddresses, classNamesByFile };
}

function collectConsumers(file: IndexedFileContent, service: ServiceInfo, csharpIndex?: CSharpClientIndex): ApiConsumer[] {
  const out: ApiConsumer[] = [];
  const lang = langOf(file.path);
  const location = (match: RegExpExecArray) => ({
    sourcePath: file.path,
    line: sourceLine(file, match.index),
    offset: match.index,
  });

  const httpRe = /\b(?:fetch|axios(?:\.(get|post|put|patch|delete))?|got|requests\.(get|post|put|patch|delete))\s*\(\s*["'`]([^"'`]+)["'`]/g;
  for (const m of matches(httpRe, file.content)) {
    const raw = m[3] ?? "";
    const method = (m[1] ?? m[2] ?? "GET").toUpperCase();
    const { host, path } = splitUrl(raw);
    out.push({ service, method, host, path, ...location(m), evidence: `${method} ${raw}` });
  }

  if (lang === "go") {
    /* Go: stdlib convenience calls and explicit NewRequest(WithContext). */
    const goHttpRe = /\bhttp\.(Get|Post|Put|Patch|Delete)\s*\(\s*["'`]([^"'`\n]+)["'`]/gi;
    for (const m of matches(goHttpRe, file.content)) {
      const raw = m[2] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), host, path, ...location(m), evidence: `http.${m[1]} ${raw}` });
    }
    const goNewRequestRe = /\bhttp\.NewRequest\s*\(\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]\s*,\s*["'`]([^"'`\n]+)["'`]/gi;
    for (const m of matches(goNewRequestRe, file.content)) {
      const raw = m[2] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), host, path, ...location(m), evidence: `http.NewRequest ${m[1]} ${raw}` });
    }
    const goNewRequestCtxRe = /\bhttp\.NewRequestWithContext\s*\([^,]+,\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]\s*,\s*["'`]([^"'`\n]+)["'`]/gi;
    for (const m of matches(goNewRequestCtxRe, file.content)) {
      const raw = m[2] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), host, path, ...location(m), evidence: `http.NewRequestWithContext ${m[1]} ${raw}` });
    }
  }

  if (lang === "java") {
    /* Spring RestTemplate (named verbs + exchange), WebClient, and OkHttp. */
    const restTemplateNamedRe = /\brestTemplate\s*\.\s*(get|post|put|patch|delete)(?:For(?:Object|Entity))?\s*\(\s*["']([^"'\n]+)["']/gi;
    for (const m of matches(restTemplateNamedRe, file.content)) {
      const raw = m[2] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), host, path, ...location(m), evidence: `restTemplate.${m[1]} ${raw}` });
    }
    const restTemplateExchangeRe = /\brestTemplate\s*\.\s*exchange\s*\(\s*["']([^"'\n]+)["']\s*,\s*HttpMethod\.(GET|POST|PUT|PATCH|DELETE)/gi;
    for (const m of matches(restTemplateExchangeRe, file.content)) {
      const raw = m[1] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, method: (m[2] ?? "GET").toUpperCase(), host, path, ...location(m), evidence: `restTemplate.exchange ${raw}` });
    }
    const webClientRe = /\bwebClient\s*\.\s*(get|post|put|patch|delete)\s*\(\s*\)[\s\S]{0,80}?\.\s*uri\s*\(\s*["']([^"'\n]+)["']/gi;
    for (const m of matches(webClientRe, file.content)) {
      const raw = m[2] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), host, path, ...location(m), evidence: `webClient.${m[1]} ${raw}` });
    }
    /* OkHttp builder chain (method-agnostic — GET is the default and other
       verbs are set via a separate .method(...) call this doesn't track). */
    const okHttpRe = /\bnew\s+Request\.Builder\s*\(\s*\)[\s\S]{0,120}?\.\s*url\s*\(\s*["']([^"'\n]+)["']/g;
    for (const m of matches(okHttpRe, file.content)) {
      const raw = m[1] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, host, path, ...location(m), evidence: `OkHttp ${raw}` });
    }
  }

  if (lang === "cs") {
    /* C#: HttpClient async verbs and RestSharp (implicit GET when no Method is
       given, matching RestSharp's own default). */
    const csharpHttpClientRe = /\b\w*[Hh]ttp[Cc]lient\s*\.\s*(Get|Post|Put|Patch|Delete)Async\s*\(\s*["']([^"'\n]+)["']/g;
    for (const m of matches(csharpHttpClientRe, file.content)) {
      const raw = m[2] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), host, path, ...location(m), evidence: `HttpClient.${m[1]}Async ${raw}` });
    }
    const restSharpRe = /\bnew\s+RestRequest\s*\(\s*["']([^"'\n]+)["']\s*(?:,\s*Method\.(Get|Post|Put|Patch|Delete))?/g;
    for (const m of matches(restSharpRe, file.content)) {
      const raw = m[1] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, method: (m[2] ?? "GET").toUpperCase(), host, path, ...location(m), evidence: `RestRequest ${raw}` });
    }

    const baseAddressByVar = new Map<string, string>();
    const typedBaseAddresses = (csharpIndex?.classNamesByFile.get(file.path) ?? [])
      .map((name) => csharpIndex?.typedBaseAddresses.get(name))
      .filter((value): value is string => Boolean(value));
    const inlineHttpClientRe = /\b(?:var|[A-Za-z_][\w<>,.\[\]\s?]+)\s+([A-Za-z_]\w*)\s*=\s*new\s+HttpClient\s*\{[\s\S]{0,200}?BaseAddress\s*=\s*new\s+Uri\(\s*["']([^"']+)["']/g;
    for (const m of matches(inlineHttpClientRe, file.content)) {
      const varName = m[1]?.trim();
      const base = m[2]?.trim();
      if (varName && base) baseAddressByVar.set(varName, base);
    }
    const assignedBaseRe = /\b([A-Za-z_]\w*)\s*\.BaseAddress\s*=\s*new\s+Uri\(\s*["']([^"']+)["']/g;
    for (const m of matches(assignedBaseRe, file.content)) {
      const varName = m[1]?.trim();
      const base = m[2]?.trim();
      if (varName && base) baseAddressByVar.set(varName, base);
    }
    const createClientRe = /\b(?:var|[A-Za-z_][\w<>,.\[\]\s?]+)\s+([A-Za-z_]\w*)\s*=\s*[A-Za-z_]\w*\.CreateClient\s*\(\s*["']([^"']+)["']\s*\)/g;
    for (const m of matches(createClientRe, file.content)) {
      const varName = m[1]?.trim();
      const clientName = m[2]?.trim();
      const base = clientName ? csharpIndex?.namedBaseAddresses.get(clientName) : undefined;
      if (varName && base) baseAddressByVar.set(varName, base);
    }
    const chainedCreateClientRe = /CreateClient\s*\(\s*["']([^"']+)["']\s*\)\s*\.\s*(Get|Post|Put|Patch|Delete)Async\s*\(\s*["']([^"'\n]+)["']/g;
    for (const m of matches(chainedCreateClientRe, file.content)) {
      const clientName = m[1]?.trim();
      const raw = m[3] ?? "";
      const base = clientName ? csharpIndex?.namedBaseAddresses.get(clientName) : undefined;
      if (!base) continue;
      const { host, path } = splitUrl(joinUrl(base, raw));
      out.push({ service, method: (m[2] ?? "GET").toUpperCase(), host, path, ...location(m), evidence: `CreateClient(${clientName}) ${raw}` });
    }
    const relativeHttpClientRe = /\b([A-Za-z_]\w*)\s*\.\s*(Get|Post|Put|Patch|Delete)Async\s*\(\s*["']([^"'\n]+)["']/g;
    for (const m of matches(relativeHttpClientRe, file.content)) {
      const varName = m[1]?.trim();
      const raw = m[3] ?? "";
      if (/^https?:\/\//i.test(raw)) continue;
      const bases = new Set<string>();
      const localBase = varName ? baseAddressByVar.get(varName) : undefined;
      if (localBase) bases.add(localBase);
      for (const typedBase of typedBaseAddresses) bases.add(typedBase);
      for (const base of bases) {
        const { host, path } = splitUrl(joinUrl(base, raw));
        out.push({ service, method: (m[2] ?? "GET").toUpperCase(), host, path, ...location(m), evidence: `HttpClient.${m[2]}Async ${raw}` });
      }
    }
  }

  const envRe = /\b([A-Z0-9_]+_SERVICE_URL|[A-Z0-9_]+_API_URL)\b/g;
  for (const m of matches(envRe, file.content)) {
    out.push({ service, host: m[1], ...location(m), evidence: `config ${m[1]}` });
  }
  if (!["json", "toml", "yaml", "yml"].includes(lang)) {
    const gqlRe = /\b(query|mutation)\s+([A-Za-z_][\w]*)/g;
    for (const m of matches(gqlRe, file.content)) {
      out.push({ service, operation: `${m[1] === "mutation" ? "Mutation" : "Query"}.${m[2]}`, ...location(m), evidence: `GraphQL ${m[1]} ${m[2]}` });
    }
    const rpcRe = /\b([A-Za-z_][\w]*)Client\.[A-Za-z_][\w]*|\b([A-Za-z_][\w]*)\s*\/\s*([A-Za-z_][\w]*)/g;
    for (const m of matches(rpcRe, file.content)) {
      const svc = m[1] ?? m[2];
      const rpc = m[3];
      if (svc) out.push({ service, operation: rpc ? `${svc}.${rpc}` : svc, ...location(m), evidence: `rpc client ${svc}${rpc ? `.${rpc}` : ""}` });
    }
    /* gRPC call sites: a variable ending in Client/Stub (Go/Java stub naming, e.g.
       `userClient.GetUser(...)` or `blockingStub.getUser(...)`) or the bare
       "client"/"stub" convention. */
    const genericRpcCallRe = /\b(?:client|stub|[A-Za-z_][\w]*(?:Client|Stub))\s*\.\s*([A-Za-z_][\w]*)\s*\(/g;
    for (const m of matches(genericRpcCallRe, file.content)) {
      const rpc = m[1] ?? "";
      if (rpc) out.push({ service, operation: rpc, ...location(m), evidence: `rpc call ${rpc}` });
    }
  }
  return out;
}

function collectEventSignals(file: IndexedFileContent, service: ServiceInfo): EventSignal[] {
  const out: EventSignal[] = [];
  const publishRe = /\b(?:publish|emit|send|producer\.send|channel\.publish)\s*\([^"'`]*["'`]([A-Za-z0-9_.:/-]+)["'`]/gi;
  for (const m of matches(publishRe, file.content)) {
    out.push({
      service,
      topic: m[1] ?? "",
      role: "publish",
      sourcePath: file.path,
      line: sourceLine(file, m.index),
      offset: m.index,
      evidence: `publishes ${m[1]}`,
    });
  }
  const subscribeRe = /\b(?:subscribe|consumer\.subscribe|channel\.consume|(?:eventBus|emitter|bus|socket)\.on)\s*\([^"'`]*["'`]([A-Za-z0-9_.:/-]+)["'`]/gi;
  for (const m of matches(subscribeRe, file.content)) {
    out.push({
      service,
      topic: m[1] ?? "",
      role: "subscribe",
      sourcePath: file.path,
      line: sourceLine(file, m.index),
      offset: m.index,
      evidence: `subscribes ${m[1]}`,
    });
  }
  return out.filter((signal) => signal.topic.length > 2);
}

function collectDataSignals(file: IndexedFileContent, service: ServiceInfo): DataSignal[] {
  const out: DataSignal[] = [];
  const readRe = /\bfrom\s+["'`]?([A-Za-z_][\w.:-]*)["'`]?/gi;
  for (const m of matches(readRe, file.content)) {
    /* Avoid treating Python's `from package import name` as SQL. SQL strings
       and actual `.sql` files still produce the same `FROM table` evidence. */
    const after = file.content.slice((m.index ?? 0) + m[0].length);
    if (/^\s+import\b/.test(after)) continue;
    out.push({
      service,
      resource: m[1] ?? "",
      role: "read",
      sourcePath: file.path,
      line: sourceLine(file, m.index),
      offset: m.index,
      evidence: `reads ${m[1]}`,
    });
  }
  const writeRe = /\b(?:insert\s+into|update|delete\s+from)\s+["'`]?([A-Za-z_][\w.:-]*)["'`]?/gi;
  for (const m of matches(writeRe, file.content)) {
    out.push({
      service,
      resource: m[1] ?? "",
      role: "write",
      sourcePath: file.path,
      line: sourceLine(file, m.index),
      offset: m.index,
      evidence: `writes ${m[1]}`,
    });
  }
  if (langOf(file.path) === "cs") out.push(...collectCSharpDataSignals(file, service));
  return out.filter((signal) => signal.resource.length > 2);
}

/** Short (namespace-stripped) type name for an EF entity reference. */
function shortTypeName(name: string): string {
  const cleaned = name.trim().replace(/<[^>]*>/g, "");
  const dot = cleaned.lastIndexOf(".");
  return (dot >= 0 ? cleaned.slice(dot + 1) : cleaned).trim();
}

/** Entity Framework / EF Core persistence signals. A `DbSet<Ticket>`,
    `modelBuilder.Entity<Ticket>()`, or `[Table("Tickets")]` means this file's
    service persists that entity/table — emitted as both read and write so two
    different services that persist the same entity surface as a `data`
    relationship (i.e. "these services share the database"). The user's C#
    codebases are largely data-layer code, so this is where the real cross-service
    coupling lives, invisible to the raw-SQL matcher above. */
function collectCSharpDataSignals(file: IndexedFileContent, service: ServiceInfo): DataSignal[] {
  const out: DataSignal[] = [];
  const seen = new Set<string>();
  const add = (resource: string, evidence: string, offset: number): void => {
    const value = resource.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    const line = sourceLine(file, offset);
    out.push({ service, resource: value, role: "read", sourcePath: file.path, line, offset, evidence });
    out.push({ service, resource: value, role: "write", sourcePath: file.path, line, offset, evidence });
  };
  for (const m of matches(/\bDbSet\s*<\s*([A-Za-z_][\w.]*)\s*>/g, file.content)) {
    const entity = shortTypeName(m[1] ?? "");
    if (entity) add(entity, `DbSet<${entity}>`, m.index);
  }
  for (const m of matches(/\.Entity\s*<\s*([A-Za-z_][\w.]*)\s*>/g, file.content)) {
    const entity = shortTypeName(m[1] ?? "");
    if (entity) add(entity, `modelBuilder.Entity<${entity}>`, m.index);
  }
  for (const m of matches(/\[Table\s*\(\s*["']([^"']+)["']/g, file.content)) {
    const table = (m[1] ?? "").trim();
    if (table) add(table, `[Table("${table}")]`, m.index);
  }
  return out;
}

function pathsCompatible(provider: ApiProvider, consumer: ApiConsumer): boolean {
  if (!provider.path || !consumer.path) return false;
  /* Every runtime-substituted path placeholder collapses to the same "{}"
     wildcard marker: named params ({id}, :id) and ASP.NET Core's
     [controller]/[action] tokens. provider.path itself keeps its literal text
     (used for the label/evidence) — only this local copy is templated. */
  const normalizePath = (value: string) => value
    .replace(/\?.*$/, "")
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  const providerPath = normalizePath(provider.path
    .replace(/\{[^}]+\}/g, "{}")
    .replace(/\[(?:controller|action)\]/gi, "{}")
    .replace(/:[A-Za-z_]\w*/g, ":"));
  const consumerPath = normalizePath(consumer.path);
  const providerLiteral = normalizePath(provider.path);
  if (consumerPath.includes(providerLiteral) || consumerPath.endsWith(providerLiteral) || providerPath.startsWith(consumerPath)) return true;
  const pattern = providerPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{\\\}/g, "[^/]+").replace(/:/g, "[^/]+");
  return new RegExp(`${pattern}$`).test(consumerPath);
}

function namesCompatible(provider: ApiProvider, consumer: ApiConsumer): boolean {
  const target = [consumer.host, consumer.operation, consumer.evidence].filter(Boolean).join(" ").toLowerCase();
  const operation = provider.operation?.toLowerCase();
  const operationTail = operation?.split(".").pop();
  return Boolean(target) && (
    target.includes(provider.service.name.toLowerCase())
    || target.includes(provider.service.root.replace(/[/-]/g, "_").toLowerCase())
    || (!!operation && target.includes(operation))
    || (!!operationTail && target.includes(operationTail))
  );
}

function projectTopologyBoost(
  consumerPath: string,
  providerPath: string,
  topology: ProjectTopology | null | undefined,
  projectRefs: ReadonlyMap<string, ReadonlySet<string>>,
): number {
  if (!topology) return 0;
  const consumerProject = owningProjectForPath(topology, consumerPath);
  const providerProject = owningProjectForPath(topology, providerPath);
  if (!consumerProject || !providerProject || consumerProject.root === providerProject.root) return 0;
  let boost = 0;
  if (projectRefs.get(consumerProject.root)?.has(providerProject.root)) boost += 6;
  else if (projectRefs.get(providerProject.root)?.has(consumerProject.root)) boost += 3;
  if (shareContainer(consumerProject, providerProject)) boost += 2;
  return boost;
}

function betterScore(score: { total: number; confidence: number }, best?: { total: number; confidence: number }): boolean {
  if (!best) return true;
  if (score.total !== best.total) return score.total > best.total;
  return score.confidence > best.confidence;
}

/** Normalized path segments, matching pathsCompatible's normalization (strip
    query, scheme+host, surrounding slashes, lowercase) so blocking tokens line
    up with how matching actually compares paths. */
function pathSegments(path: string): string[] {
  return path
    .replace(/\?.*$/, "")
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
}

/** A provider path segment is "static" if it isn't a route parameter — those
    are the only segments a pathsCompatible match is guaranteed to share with the
    consumer path, so they're the sound blocking keys. */
function isStaticSegment(segment: string): boolean {
  return !segment.includes("{") && !segment.includes("}") && !segment.startsWith(":") && !/\[(?:controller|action)\]/.test(segment);
}

function operationTail(operation: string): string {
  return operation.toLowerCase().split(".").pop() ?? "";
}

/** A blocking index over providers: for any consumer, the candidate set it
    returns is a *superset* of every provider that could match under
    exactOperation / pathsCompatible / namesCompatible, so running the exact
    predicate over candidates yields identical edges to a full cross product —
    without the O(providers×consumers) cost the old MAX_SIGNALS_PER_KIND cap was
    there to bound. */
class ProviderIndex {
  private readonly byPathToken = new Map<string, ApiProvider[]>();
  private readonly byOpTail = new Map<string, ApiProvider[]>();
  /** Providers whose path is all route-parameters (matches any path) — no static
      token to block on, so they must be tested against every path-bearing consumer. */
  private readonly wildcardPath: ApiProvider[] = [];
  /** Provider name/operation strings exactly as namesCompatible compares them,
      keyed to the providers carrying each — makes the substring nameMatch a sound
      superset (see get()). */
  private readonly byNameToken = new Map<string, ApiProvider[]>();
  private readonly nameTokens: string[] = [];
  /** Original collection index — the stable tie-break among equally specific
      candidates, so results don't depend on Set/bucket iteration order. */
  private readonly order = new Map<ApiProvider, number>();

  constructor(providers: readonly ApiProvider[]) {
    providers.forEach((provider, i) => this.order.set(provider, i));
    for (const provider of providers) {
      if (provider.operation) this.push(this.byOpTail, operationTail(provider.operation), provider);
      if (provider.path) {
        const staticTokens = pathSegments(provider.path).filter(isStaticSegment);
        if (staticTokens.length === 0) this.wildcardPath.push(provider);
        else for (const token of staticTokens) this.push(this.byPathToken, token, provider);
      }
      this.addNameToken(provider.service.name.toLowerCase(), provider);
      this.addNameToken(provider.service.root.replace(/[/-]/g, "_").toUpperCase(), provider);
      if (provider.operation) {
        this.addNameToken(provider.operation.toLowerCase(), provider);
        this.addNameToken(operationTail(provider.operation), provider);
      }
    }
  }

  private push(index: Map<string, ApiProvider[]>, key: string, provider: ApiProvider): void {
    if (!key) return;
    const list = index.get(key);
    if (list) list.push(provider);
    else index.set(key, [provider]);
  }

  private addNameToken(token: string, provider: ApiProvider): void {
    if (!token) return;
    if (!this.byNameToken.has(token)) this.nameTokens.push(token);
    this.push(this.byNameToken, token, provider);
  }

  candidatesFor(consumer: ApiConsumer): ApiProvider[] {
    const out = new Set<ApiProvider>();
    if (consumer.path) {
      for (const segment of pathSegments(consumer.path)) {
        for (const provider of this.byPathToken.get(segment) ?? []) out.add(provider);
      }
      for (const provider of this.wildcardPath) out.add(provider);
    }
    if (consumer.operation) {
      for (const provider of this.byOpTail.get(operationTail(consumer.operation)) ?? []) out.add(provider);
    }
    /* namesCompatible compares its `target` against exactly these token strings,
       so a token contained in the target reproduces its condition precisely. The
       scan is bounded by the number of DISTINCT provider name/operation tokens —
       small in real repos, and ~zero in path-only (route-heavy) ones. */
    const target = [consumer.host, consumer.operation, consumer.evidence].filter(Boolean).join(" ").toLowerCase();
    if (target) {
      for (const token of this.nameTokens) {
        if (target.includes(token)) for (const provider of this.byNameToken.get(token)!) out.add(provider);
      }
    }
    /* Most-specific path first (more segments), then original order, so an
       equal-score tie resolves to the tighter route deterministically rather
       than by however the candidate buckets happened to enumerate. */
    return [...out].sort((a, b) =>
      (b.path ? pathSegments(b.path).length : 0) - (a.path ? pathSegments(a.path).length : 0)
      || (this.order.get(a) ?? 0) - (this.order.get(b) ?? 0),
    );
  }
}

/** Group signals by an exact key (event topic, data resource) so producer↔
    consumer pairing is a hash join instead of a nested scan. */
function groupBy<T>(signals: readonly T[], key: (signal: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const signal of signals) {
    const k = key(signal);
    const list = out.get(k);
    if (list) list.push(signal);
    else out.set(k, [signal]);
  }
  return out;
}

interface LocatedRelationshipSignal {
  service: ServiceInfo;
  sourcePath: string;
  line?: number;
  offset?: number;
  evidence: string;
}

function compareLocatedSignals(a: LocatedRelationshipSignal, b: LocatedRelationshipSignal): number {
  return a.sourcePath.localeCompare(b.sourcePath)
    || (a.line ?? 0) - (b.line ?? 0)
    || (a.offset ?? 0) - (b.offset ?? 0)
    || a.evidence.localeCompare(b.evidence);
}

function representativeSignal<T extends LocatedRelationshipSignal>(signals: readonly T[]): T {
  return [...signals].sort(compareLocatedSignals)[0]!;
}

/** A bounded, deterministic sample suitable for evidence chips. The explicit
    path and human-facing one-based line keep aggregated relationships
    actionable while sourceLine/targetLine retain zero-based protocol values. */
function evidenceSamples(
  source: readonly LocatedRelationshipSignal[],
  target: readonly LocatedRelationshipSignal[],
): string[] {
  const sides = [
    [...source].sort(compareLocatedSignals),
    [...target].sort(compareLocatedSignals),
  ];
  const cursors = [0, 0];
  const out: string[] = [];
  const seen = new Set<string>();
  while (out.length < MAX_EVIDENCE_SAMPLES) {
    let advanced = false;
    for (let side = 0; side < sides.length && out.length < MAX_EVIDENCE_SAMPLES; side += 1) {
      const signal = sides[side]?.[cursors[side] ?? 0];
      if (!signal) continue;
      cursors[side] = (cursors[side] ?? 0) + 1;
      advanced = true;
      const line = signal.line === undefined ? "" : `:${signal.line + 1}`;
      const sample = `${signal.sourcePath}${line} - ${signal.evidence}`;
      if (!seen.has(sample)) {
        seen.add(sample);
        out.push(sample);
      }
    }
    if (!advanced) break;
  }
  return out;
}

function canonicalTopic(topic: string): string {
  /* Broker topics can be case-sensitive, so canonicalization intentionally
     trims transport-independent whitespace without lowercasing. */
  return topic.trim();
}

function canonicalDataResource(resource: string): string {
  /* SQL identifiers and ORM entity names are matched case-insensitively here;
     preserve the original spelling on the displayed edge label. */
  return resource.trim().replace(/^[`"'\[]|[`"'\]]$/g, "").toLowerCase();
}

function groupedByService<T extends { service: ServiceInfo }>(signals: readonly T[]): Map<string, T[]> {
  return groupBy(signals, (signal) => signal.service.root);
}

export function buildServiceRelationships(
  files: readonly IndexedFileContent[],
  maxEdges = 5000,
  topology?: ProjectTopology | null,
): RelationshipResult {
  const paths = files.map((f) => normalizeGraphPath(f.path));
  const services = detectServices(paths, topology);
  const providers: ApiProvider[] = [];
  const consumers: ApiConsumer[] = [];
  const events: EventSignal[] = [];
  const data: DataSignal[] = [];
  const csharpIndex = buildCSharpClientIndex(files);
  for (const raw of files) {
    const file = { path: normalizeGraphPath(raw.path), content: raw.content };
    const service = nearestService(file.path, services);
    providers.push(...collectOpenApiProviders(file, service));
    providers.push(...collectProtoProviders(file, service));
    providers.push(...collectGraphqlProviders(file, service));
    providers.push(...collectRouteProviders(file, service));
    consumers.push(...collectConsumers(file, service, csharpIndex));
    events.push(...collectEventSignals(file, service));
    data.push(...collectDataSignals(file, service));
  }

  const providerIndex = new ProviderIndex(providers);
  const projectRefs = buildProjectReferenceMap(topology ?? null);

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const pushEdge = (edge: GraphEdge): boolean => {
    if (seen.has(edge.id)) return false;
    seen.add(edge.id);
    edges.push(edge);
    return edges.length >= maxEdges;
  };
  for (const consumer of consumers) {
    const scoredByProvider = new Map<string, {
      provider: ApiProvider;
      confidence: number;
      total: number;
      specificity: number;
      label: string;
    }>();
    /* Candidates are a superset of every provider that could match this
       consumer, so the predicate below yields the same edges a full cross
       product would — see ProviderIndex. */
    for (const provider of providerIndex.candidatesFor(consumer)) {
      if (provider.service.root === consumer.service.root) continue;
      const methodMatch = !provider.method || !consumer.method || provider.method === consumer.method;
      const exactOperation = !!provider.operation && !!consumer.operation && (
        provider.operation.toLowerCase() === consumer.operation.toLowerCase()
        || provider.operation.toLowerCase().endsWith(`.${consumer.operation.toLowerCase()}`)
      );
      const pathMatch = methodMatch && pathsCompatible(provider, consumer);
      const nameMatch = namesCompatible(provider, consumer);
      if (!exactOperation && !pathMatch && !nameMatch) continue;
      /* Multi-signal confidence: an operation-id or path match corroborated
         by an independent name match (the service name/root also showing up
         in the consumer's evidence) is genuinely more certain than either
         signal alone, so it earns a higher tier. A single signal keeps
         exactly the confidence it always did — this only adds a tier above
         the existing ones, it never lowers an existing single-signal match. */
      const strongSignal = exactOperation || pathMatch;
      const baseConfidence = strongSignal && nameMatch ? 0.95 : strongSignal ? 0.9 : 0.55;
      const baseScore = exactOperation ? 120 : pathMatch ? 100 : 60;
      const corroboration = strongSignal && nameMatch ? 10 : 0;
      const topologyBoost = projectTopologyBoost(consumer.sourcePath, provider.sourcePath, topology, projectRefs);
      const confidence = Math.min(0.98, baseConfidence + topologyBoost * 0.01);
      const label = provider.method ? `${provider.method} ${provider.path}` : provider.operation ?? provider.path;
      const total = baseScore + corroboration + topologyBoost;
      const specificity = provider.path ? pathSegments(provider.path).length : provider.operation ? 1 : 0;
      /* Different detector passes can discover the same declaration (ASP.NET's
         composed route pass and its simple attribute fallback are one example).
         Collapse only the same provider location+contract; genuinely distinct
         equally strong declarations remain candidates below. */
      const providerKey = [
        provider.service.root,
        provider.sourcePath,
        provider.line ?? "",
        provider.method ?? "",
        provider.path,
        provider.operation ?? "",
      ].join("\u0000");
      const current = scoredByProvider.get(providerKey);
      if (betterScore({ total, confidence }, current)) {
        scoredByProvider.set(providerKey, { provider, confidence, total, specificity, label });
      }
    }
    const ranked = [...scoredByProvider.values()].sort((a, b) =>
      b.total - a.total
      || b.confidence - a.confidence
      || b.specificity - a.specificity
      || a.provider.service.root.localeCompare(b.provider.service.root)
      || a.provider.sourcePath.localeCompare(b.provider.sourcePath)
      || (a.provider.line ?? 0) - (b.provider.line ?? 0)
      || a.label.localeCompare(b.label));
    const leading = ranked[0];
    if (!leading) continue;
    /* Preserve every exactly tied top candidate instead of silently choosing
       the first service/path in iteration order. Lower-scoring alternatives
       stay suppressed as before. */
    const best = ranked.filter((candidate) =>
      candidate.total === leading.total
      && candidate.confidence === leading.confidence
      && candidate.specificity === leading.specificity
    );
    const consumerIdentity = [
      consumer.service.root,
      consumer.sourcePath,
      consumer.line,
    ];
    const ambiguityGroup = best.length > 1
      ? stableRelationshipId("api", ["ambiguity", ...consumerIdentity])
      : undefined;
    for (const candidate of best) {
      const provider = candidate.provider;
      const full = pushEdge({
        id: stableRelationshipId("api", [
          "candidate",
          ...consumerIdentity,
          provider.service.root,
          provider.sourcePath,
          provider.line,
          provider.method,
          provider.path,
          provider.operation,
        ]),
        from: `svc:${consumer.service.root}`,
        to: `svc:${provider.service.root}`,
        kind: "api",
        sourcePath: consumer.sourcePath,
        targetPath: provider.sourcePath,
        sourceLine: consumer.line,
        targetLine: provider.line,
        serviceFrom: consumer.service.root,
        serviceTo: provider.service.root,
        label: candidate.label,
        detail: best.length > 1
          ? `${consumer.service.name} -> ${provider.service.name} (${best.length} equally strong candidates)`
          : `${consumer.service.name} -> ${provider.service.name}`,
        confidence: candidate.confidence,
        evidence: evidenceSamples([consumer], [provider]),
        ambiguityGroup,
        ambiguousCandidateCount: best.length > 1 ? best.length : undefined,
      });
      if (full) return { services, edges, truncated: true };
    }
  }
  for (const consumer of consumers) {
    if (!consumer.host) continue;
    const target = services
      .filter((svc) => svc.root !== consumer.service.root && namesCompatible({ service: svc, path: "", sourcePath: "", evidence: "" }, consumer))
      .sort((a, b) => {
        const aBoost = projectTopologyBoost(consumer.sourcePath, a.root, topology, projectRefs);
        const bBoost = projectTopologyBoost(consumer.sourcePath, b.root, topology, projectRefs);
        return bBoost - aBoost || a.root.localeCompare(b.root);
      })[0];
    if (!target) continue;
    const confidence = Math.min(0.65, 0.45 + projectTopologyBoost(consumer.sourcePath, target.root, topology, projectRefs) * 0.02);
    const full = pushEdge({
      id: stableRelationshipId("config", [
        consumer.service.root,
        target.root,
        consumer.sourcePath,
        consumer.line,
        consumer.offset,
        consumer.host,
      ]),
      from: `svc:${consumer.service.root}`,
      to: `svc:${target.root}`,
      kind: "config",
      sourcePath: consumer.sourcePath,
      sourceLine: consumer.line,
      serviceFrom: consumer.service.root,
      serviceTo: target.root,
      label: consumer.host,
      detail: `${consumer.service.name} references ${target.name}`,
      confidence,
      evidence: [consumer.evidence],
    });
    if (full) return { services, edges, truncated: true };
  }
  /* Events pair publish↔subscribe on an identical topic — a hash join by topic
     instead of scanning every publisher against every subscriber. */
  const eventsByTopic = groupBy(events, (signal) => canonicalTopic(signal.topic));
  for (const [topic, topicSignals] of [...eventsByTopic.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!topic) continue;
    const publishers = groupedByService(topicSignals.filter((signal) => signal.role === "publish"));
    const subscribers = groupedByService(topicSignals.filter((signal) => signal.role === "subscribe"));
    for (const [sourceRoot, sourceSignals] of [...publishers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      for (const [targetRoot, targetSignals] of [...subscribers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (sourceRoot === targetRoot) continue;
        const producer = representativeSignal(sourceSignals);
        const subscriber = representativeSignal(targetSignals);
        const occurrenceCount = sourceSignals.length * targetSignals.length;
        const full = pushEdge({
          id: stableRelationshipId("event", [sourceRoot, targetRoot, topic]),
          from: `svc:${sourceRoot}`,
          to: `svc:${targetRoot}`,
          kind: "event",
          sourcePath: producer.sourcePath,
          targetPath: subscriber.sourcePath,
          sourceLine: producer.line,
          targetLine: subscriber.line,
          serviceFrom: sourceRoot,
          serviceTo: targetRoot,
          label: topic,
          detail: `${producer.service.name} publishes (${sourceSignals.length}); ${subscriber.service.name} subscribes (${targetSignals.length})`,
          confidence: 0.65,
          evidence: evidenceSamples(sourceSignals, targetSignals),
          occurrenceCount,
          sourceOccurrenceCount: sourceSignals.length,
          targetOccurrenceCount: targetSignals.length,
        });
        if (full) return { services, edges, truncated: true };
      }
    }
  }
  /* Shared-data links pair write↔read on an identical resource — hash join by
     resource. */
  const dataByResource = groupBy(data, (signal) => canonicalDataResource(signal.resource));
  for (const [resourceKey, resourceSignals] of [...dataByResource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!resourceKey) continue;
    const writers = groupedByService(resourceSignals.filter((signal) => signal.role === "write"));
    const readers = groupedByService(resourceSignals.filter((signal) => signal.role === "read"));
    for (const [sourceRoot, sourceSignals] of [...writers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      for (const [targetRoot, targetSignals] of [...readers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (sourceRoot === targetRoot) continue;
        const writer = representativeSignal(sourceSignals);
        const reader = representativeSignal(targetSignals);
        const label = [...new Set([...sourceSignals, ...targetSignals].map((signal) => signal.resource))]
          .sort((a, b) => a.localeCompare(b))[0] ?? resourceKey;
        const occurrenceCount = sourceSignals.length * targetSignals.length;
        const full = pushEdge({
          id: stableRelationshipId("data", [sourceRoot, targetRoot, resourceKey]),
          from: `svc:${sourceRoot}`,
          to: `svc:${targetRoot}`,
          kind: "data",
          sourcePath: writer.sourcePath,
          targetPath: reader.sourcePath,
          sourceLine: writer.line,
          targetLine: reader.line,
          serviceFrom: sourceRoot,
          serviceTo: targetRoot,
          label,
          detail: `${writer.service.name} writes (${sourceSignals.length}); ${reader.service.name} reads (${targetSignals.length})`,
          confidence: 0.5,
          evidence: evidenceSamples(sourceSignals, targetSignals),
          occurrenceCount,
          sourceOccurrenceCount: sourceSignals.length,
          targetOccurrenceCount: targetSignals.length,
        });
        if (full) return { services, edges, truncated: true };
      }
    }
  }
  /* No signal-count truncation any more: the whole corpus is matched. `truncated`
     now means only the OUTPUT edge cap (maxEdges) was hit, handled inline above. */
  return { services, edges, truncated: false };
}
