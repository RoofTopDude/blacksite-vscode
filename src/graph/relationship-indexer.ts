import { clusterDir, importEdgeId, langOf, normalizeGraphPath, type GraphEdge } from "./graph-model.js";
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
  evidence: string;
}

interface ApiConsumer {
  service: ServiceInfo;
  path?: string;
  method?: string;
  host?: string;
  operation?: string;
  sourcePath: string;
  evidence: string;
}

interface EventSignal {
  service: ServiceInfo;
  topic: string;
  role: "publish" | "subscribe";
  sourcePath: string;
  evidence: string;
}

interface DataSignal {
  service: ServiceInfo;
  resource: string;
  role: "read" | "write";
  sourcePath: string;
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
  "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
  "Gemfile", "composer.json", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
]);
/* .NET has no fixed marker filename (each project carries its own <Name>.csproj
   alongside a solution-level .sln); recognized by extension instead. */
const MARKER_EXT_RE = /\.(?:csproj|sln)$/i;
const SPEC_RE = /\.(openapi|swagger)\.(json|ya?ml)$|openapi\.(json|ya?ml)$|swagger\.(json|ya?ml)$|\.proto$|\.graphqls?$|schema\.graphql$/i;
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
/** Defensive ceiling on how many candidate signals of one kind (providers,
    consumers, event pub/sub sites, data read/write sites) get cross-matched
    against each other — independent of maxEdges (the OUTPUT edge cap below).
    Each match check builds/tests a RegExp, so on a huge polyglot codebase
    with many thousands of call sites the O(n²) cross product would burn
    real time just to *discover* matches, long before maxEdges gets a chance
    to cap what's kept. Truncation is deterministic (file-scan order) so a
    huge repo still gets stable, useful relationship coverage on every
    rebuild rather than a stall. */
const MAX_SIGNALS_PER_KIND = 3000;

function capSignals<T>(list: T[]): { list: T[]; truncated: boolean } {
  return list.length <= MAX_SIGNALS_PER_KIND
    ? { list, truncated: false }
    : { list: list.slice(0, MAX_SIGNALS_PER_KIND), truncated: true };
}

/** Iterate every match of a global regex against content, resetting lastIndex
    first — avoids repeating the exec-loop boilerplate at every call site. */
function* matches(re: RegExp, content: string): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  for (let m = re.exec(content); m !== null; m = re.exec(content)) yield m;
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
    if (MARKER_NAMES.has(name) || MARKER_EXT_RE.test(name) || SPEC_RE.test(file) || file.includes("/k8s/") || file.includes("/helm/")) {
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
        out.push({ service, path, method: method.toUpperCase(), operation: op, sourcePath: file.path, evidence: `${method.toUpperCase()} ${path}` });
      }
    }
  }
  const lines = file.content.split(/\r?\n/);
  let currentPath: string | undefined;
  let currentMethod: string | undefined;
  let operation: string | undefined;
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
          evidence: `${currentMethod} ${currentPath}`,
        });
      }
    }
  };
  for (const line of lines) {
    const pathMatch = /^\s*["']?(\/[A-Za-z0-9_./{}:-]+)["']?\s*:\s*$/.exec(line);
    if (pathMatch) {
      flush();
      currentPath = pathMatch[1];
      currentMethod = undefined;
      operation = undefined;
      continue;
    }
    const methodMatch = /^\s*(get|post|put|patch|delete|head|options)\s*:\s*$/i.exec(line);
    if (methodMatch && currentPath) {
      flush();
      currentMethod = methodMatch[1]?.toUpperCase();
      operation = undefined;
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
      out.push({ service, path: `${svc}/${rpc}`, operation: `${svc}.${rpc}`, sourcePath: file.path, evidence: `rpc ${svc}.${rpc}` });
    }
  }
  return out;
}

function collectGraphqlProviders(file: IndexedFileContent, service: ServiceInfo): ApiProvider[] {
  if (!/\.graphqls?$/.test(file.path) && !/\b(type|extend type)\s+(Query|Mutation)\b/.test(file.content)) return [];
  const out: ApiProvider[] = [];
  const typeRe = /\b(?:extend\s+)?type\s+(Query|Mutation)\s*\{([\s\S]*?)\}/g;
  for (let m = typeRe.exec(file.content); m !== null; m = typeRe.exec(file.content)) {
    const kind = m[1] ?? "Query";
    const body = m[2] ?? "";
    const fieldRe = /^\s*([A-Za-z_][\w]*)\s*(?:\(|:)/gm;
    for (let f = fieldRe.exec(body); f !== null; f = fieldRe.exec(body)) {
      const field = f[1] ?? "";
      out.push({ service, path: `${kind}.${field}`, operation: `${kind}.${field}`, sourcePath: file.path, evidence: `GraphQL ${kind}.${field}` });
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
            out.push({ service, path, sourcePath: file.path, evidence: `[Route] ${path}` });
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

  const routeRe = new RegExp(`\\b(?:app|router|server)\\s*\\.\\s*(${HTTP_METHODS.join("|")})\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]`, "gi");
  for (const m of matches(routeRe, file.content)) {
    out.push({ service, method: (m[1] ?? "GET").toUpperCase(), path: m[2] ?? "", sourcePath: file.path, evidence: `${m[1]?.toUpperCase()} ${m[2]}` });
  }
  const decoratorRe = /@(?:app|router|Controller)?\.?(Get|Post|Put|Patch|Delete|Head|Options|get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g;
  for (const m of matches(decoratorRe, file.content)) {
    out.push({ service, method: (m[1] ?? "GET").toUpperCase(), path: m[2] ?? "", sourcePath: file.path, evidence: `${m[1]?.toUpperCase()} ${m[2]}` });
  }
  const pyRouteRe = /@(?:app|router|blueprint)\.(get|post|put|patch|delete|route)\s*\(\s*["']([^"']+)["']/g;
  for (const m of matches(pyRouteRe, file.content)) {
    out.push({ service, method: (m[1] === "route" ? "GET" : m[1] ?? "GET").toUpperCase(), path: m[2] ?? "", sourcePath: file.path, evidence: `${m[1]?.toUpperCase()} ${m[2]}` });
  }

  if (lang === "go") {
    /* Go router idioms: gorilla/mux, chi, Gin, and Echo all register routes as
       `<router-var>.<Method>("/path", handler)` on a short conventional
       receiver — the same shape as Express, just a different identifier.
       Paths may be backtick raw strings. */
    const goRouteRe = new RegExp(`\\b(?:r|mux|e|rg)\\s*\\.\\s*(${HTTP_METHODS.join("|")})\\s*\\(\\s*["\`]([^"\`\\n]+)["\`]`, "gi");
    for (const m of matches(goRouteRe, file.content)) {
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), path: m[2] ?? "", sourcePath: file.path, evidence: `${m[1]?.toUpperCase()} ${m[2]}` });
    }
    /* net/http stdlib: HandleFunc/Handle register a path for every method (the
       handler dispatches on r.Method itself), so no method is recorded — an
       unset provider.method matches any consumer method. */
    const goHandleFuncRe = /\bhttp\.(?:HandleFunc|Handle)\s*\(\s*["`]([^"`\n]+)["`]/g;
    for (const m of matches(goHandleFuncRe, file.content)) {
      const path = m[1] ?? "";
      out.push({ service, path, sourcePath: file.path, evidence: `HandleFunc ${path}` });
    }
  }

  if (lang === "java") {
    /* Spring: @GetMapping/@PostMapping/etc name the method directly;
       @RequestMapping is method-agnostic unless it carries `method =
       RequestMethod.X`. Controller/method path prefixes are not composed (same
       simplification the NestJS decorator handling above already makes). */
    const springMappingRe = /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g;
    for (const m of matches(springMappingRe, file.content)) {
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), path: m[2] ?? "", sourcePath: file.path, evidence: `@${m[1]}Mapping ${m[2]}` });
    }
    const springRequestMappingRe = /@RequestMapping\s*\(([^)]{0,300})\)/g;
    for (const m of matches(springRequestMappingRe, file.content)) {
      const args = m[1] ?? "";
      const path = /(?:value|path)\s*=\s*["']([^"']+)["']/.exec(args)?.[1] ?? /^\s*["']([^"']+)["']/.exec(args)?.[1];
      if (!path) continue;
      const method = /RequestMethod\.(GET|POST|PUT|PATCH|DELETE)/.exec(args)?.[1];
      out.push({ service, method, path, sourcePath: file.path, evidence: `@RequestMapping ${path}` });
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
    out.push(...collectAspNetRouteProviders(file, service));
    const controllerName = /\bclass\s+([A-Za-z_]\w*Controller)\b/.exec(file.content)?.[1]?.replace(/Controller$/, "");
    const aspNetAttrRe = /\[Http(Get|Post|Put|Delete|Patch)\s*\(\s*["']([^"']+)["']\s*\)\]/g;
    for (const m of matches(aspNetAttrRe, file.content)) {
      const path = (m[2] ?? "").replace(/\[controller\]/gi, controllerName ?? "controller");
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), path, sourcePath: file.path, evidence: `[Http${m[1]}] ${path}` });
    }
    const aspNetRouteRe = /\[Route\s*\(\s*["']([^"']+)["']\s*\)\]/g;
    for (const m of matches(aspNetRouteRe, file.content)) {
      const path = (m[1] ?? "").replace(/\[controller\]/gi, controllerName ?? "controller");
      out.push({ service, path, sourcePath: file.path, evidence: `[Route] ${path}` });
    }
  }

  return out;
}

/** Split a captured URL/path string into (host?, path) — a bare "/x" path with
    no scheme leaves host undefined and path unchanged. Shared by every HTTP
    client pattern below so host/env-var extraction stays in one place. */
function splitUrl(raw: string): { host: string | undefined; path: string } {
  const host = /https?:\/\/([^/]+)/.exec(raw)?.[1] ?? /\$\{?([A-Z0-9_]+_SERVICE_URL)\}?/.exec(raw)?.[1];
  const path = raw.replace(/^https?:\/\/[^/]+/, "").replace(/\$\{?[^}/]+_SERVICE_URL\}?/, "") || raw;
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

  const httpRe = /\b(?:fetch|axios(?:\.(get|post|put|patch|delete))?|got|requests\.(get|post|put|patch|delete))\s*\(\s*["'`]([^"'`]+)["'`]/g;
  for (const m of matches(httpRe, file.content)) {
    const raw = m[3] ?? "";
    const method = (m[1] ?? m[2] ?? "GET").toUpperCase();
    const { host, path } = splitUrl(raw);
    out.push({ service, method, host, path, sourcePath: file.path, evidence: `${method} ${raw}` });
  }

  if (lang === "go") {
    /* Go: stdlib convenience calls and explicit NewRequest(WithContext). */
    const goHttpRe = /\bhttp\.(Get|Post|Put|Patch|Delete)\s*\(\s*["'`]([^"'`\n]+)["'`]/gi;
    for (const m of matches(goHttpRe, file.content)) {
      const raw = m[2] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), host, path, sourcePath: file.path, evidence: `http.${m[1]} ${raw}` });
    }
    const goNewRequestRe = /\bhttp\.NewRequest\s*\(\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]\s*,\s*["'`]([^"'`\n]+)["'`]/gi;
    for (const m of matches(goNewRequestRe, file.content)) {
      const raw = m[2] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), host, path, sourcePath: file.path, evidence: `http.NewRequest ${m[1]} ${raw}` });
    }
    const goNewRequestCtxRe = /\bhttp\.NewRequestWithContext\s*\([^,]+,\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]\s*,\s*["'`]([^"'`\n]+)["'`]/gi;
    for (const m of matches(goNewRequestCtxRe, file.content)) {
      const raw = m[2] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), host, path, sourcePath: file.path, evidence: `http.NewRequestWithContext ${m[1]} ${raw}` });
    }
  }

  if (lang === "java") {
    /* Spring RestTemplate (named verbs + exchange), WebClient, and OkHttp. */
    const restTemplateNamedRe = /\brestTemplate\s*\.\s*(get|post|put|patch|delete)(?:For(?:Object|Entity))?\s*\(\s*["']([^"'\n]+)["']/gi;
    for (const m of matches(restTemplateNamedRe, file.content)) {
      const raw = m[2] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), host, path, sourcePath: file.path, evidence: `restTemplate.${m[1]} ${raw}` });
    }
    const restTemplateExchangeRe = /\brestTemplate\s*\.\s*exchange\s*\(\s*["']([^"'\n]+)["']\s*,\s*HttpMethod\.(GET|POST|PUT|PATCH|DELETE)/gi;
    for (const m of matches(restTemplateExchangeRe, file.content)) {
      const raw = m[1] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, method: (m[2] ?? "GET").toUpperCase(), host, path, sourcePath: file.path, evidence: `restTemplate.exchange ${raw}` });
    }
    const webClientRe = /\bwebClient\s*\.\s*(get|post|put|patch|delete)\s*\(\s*\)[\s\S]{0,80}?\.\s*uri\s*\(\s*["']([^"'\n]+)["']/gi;
    for (const m of matches(webClientRe, file.content)) {
      const raw = m[2] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), host, path, sourcePath: file.path, evidence: `webClient.${m[1]} ${raw}` });
    }
    /* OkHttp builder chain (method-agnostic — GET is the default and other
       verbs are set via a separate .method(...) call this doesn't track). */
    const okHttpRe = /\bnew\s+Request\.Builder\s*\(\s*\)[\s\S]{0,120}?\.\s*url\s*\(\s*["']([^"'\n]+)["']/g;
    for (const m of matches(okHttpRe, file.content)) {
      const raw = m[1] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, host, path, sourcePath: file.path, evidence: `OkHttp ${raw}` });
    }
  }

  if (lang === "cs") {
    /* C#: HttpClient async verbs and RestSharp (implicit GET when no Method is
       given, matching RestSharp's own default). */
    const csharpHttpClientRe = /\b\w*[Hh]ttp[Cc]lient\s*\.\s*(Get|Post|Put|Patch|Delete)Async\s*\(\s*["']([^"'\n]+)["']/g;
    for (const m of matches(csharpHttpClientRe, file.content)) {
      const raw = m[2] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), host, path, sourcePath: file.path, evidence: `HttpClient.${m[1]}Async ${raw}` });
    }
    const restSharpRe = /\bnew\s+RestRequest\s*\(\s*["']([^"'\n]+)["']\s*(?:,\s*Method\.(Get|Post|Put|Patch|Delete))?/g;
    for (const m of matches(restSharpRe, file.content)) {
      const raw = m[1] ?? "";
      const { host, path } = splitUrl(raw);
      out.push({ service, method: (m[2] ?? "GET").toUpperCase(), host, path, sourcePath: file.path, evidence: `RestRequest ${raw}` });
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
      out.push({ service, method: (m[2] ?? "GET").toUpperCase(), host, path, sourcePath: file.path, evidence: `CreateClient(${clientName}) ${raw}` });
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
        out.push({ service, method: (m[2] ?? "GET").toUpperCase(), host, path, sourcePath: file.path, evidence: `HttpClient.${m[2]}Async ${raw}` });
      }
    }
  }

  const envRe = /\b([A-Z0-9_]+_SERVICE_URL|[A-Z0-9_]+_API_URL)\b/g;
  for (const m of matches(envRe, file.content)) {
    out.push({ service, host: m[1], sourcePath: file.path, evidence: `config ${m[1]}` });
  }
  if (!["json", "toml", "yaml", "yml"].includes(lang)) {
    const gqlRe = /\b(query|mutation)\s+([A-Za-z_][\w]*)/g;
    for (const m of matches(gqlRe, file.content)) {
      out.push({ service, operation: `${m[1] === "mutation" ? "Mutation" : "Query"}.${m[2]}`, sourcePath: file.path, evidence: `GraphQL ${m[1]} ${m[2]}` });
    }
    const rpcRe = /\b([A-Za-z_][\w]*)Client\.[A-Za-z_][\w]*|\b([A-Za-z_][\w]*)\s*\/\s*([A-Za-z_][\w]*)/g;
    for (const m of matches(rpcRe, file.content)) {
      const svc = m[1] ?? m[2];
      const rpc = m[3];
      if (svc) out.push({ service, operation: rpc ? `${svc}.${rpc}` : svc, sourcePath: file.path, evidence: `rpc client ${svc}${rpc ? `.${rpc}` : ""}` });
    }
    /* gRPC call sites: a variable ending in Client/Stub (Go/Java stub naming, e.g.
       `userClient.GetUser(...)` or `blockingStub.getUser(...)`) or the bare
       "client"/"stub" convention. */
    const genericRpcCallRe = /\b(?:client|stub|[A-Za-z_][\w]*(?:Client|Stub))\s*\.\s*([A-Za-z_][\w]*)\s*\(/g;
    for (const m of matches(genericRpcCallRe, file.content)) {
      const rpc = m[1] ?? "";
      if (rpc) out.push({ service, operation: rpc, sourcePath: file.path, evidence: `rpc call ${rpc}` });
    }
  }
  return out;
}

function collectEventSignals(file: IndexedFileContent, service: ServiceInfo): EventSignal[] {
  const out: EventSignal[] = [];
  const publishRe = /\b(?:publish|emit|send|producer\.send|channel\.publish)\s*\([^"'`]*["'`]([A-Za-z0-9_.:/-]+)["'`]/gi;
  for (let m = publishRe.exec(file.content); m !== null; m = publishRe.exec(file.content)) {
    out.push({ service, topic: m[1] ?? "", role: "publish", sourcePath: file.path, evidence: `publishes ${m[1]}` });
  }
  const subscribeRe = /\b(?:subscribe|consumer\.subscribe|channel\.consume|on)\s*\([^"'`]*["'`]([A-Za-z0-9_.:/-]+)["'`]/gi;
  for (let m = subscribeRe.exec(file.content); m !== null; m = subscribeRe.exec(file.content)) {
    out.push({ service, topic: m[1] ?? "", role: "subscribe", sourcePath: file.path, evidence: `subscribes ${m[1]}` });
  }
  return out.filter((signal) => signal.topic.length > 2);
}

function collectDataSignals(file: IndexedFileContent, service: ServiceInfo): DataSignal[] {
  const out: DataSignal[] = [];
  const readRe = /\bfrom\s+["'`]?([A-Za-z_][\w.:-]*)["'`]?/gi;
  for (let m = readRe.exec(file.content); m !== null; m = readRe.exec(file.content)) {
    out.push({ service, resource: m[1] ?? "", role: "read", sourcePath: file.path, evidence: `reads ${m[1]}` });
  }
  const writeRe = /\b(?:insert\s+into|update|delete\s+from)\s+["'`]?([A-Za-z_][\w.:-]*)["'`]?/gi;
  for (let m = writeRe.exec(file.content); m !== null; m = writeRe.exec(file.content)) {
    out.push({ service, resource: m[1] ?? "", role: "write", sourcePath: file.path, evidence: `writes ${m[1]}` });
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
  const add = (resource: string, evidence: string): void => {
    const value = resource.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ service, resource: value, role: "read", sourcePath: file.path, evidence });
    out.push({ service, resource: value, role: "write", sourcePath: file.path, evidence });
  };
  for (const m of matches(/\bDbSet\s*<\s*([A-Za-z_][\w.]*)\s*>/g, file.content)) {
    const entity = shortTypeName(m[1] ?? "");
    if (entity) add(entity, `DbSet<${entity}>`);
  }
  for (const m of matches(/\.Entity\s*<\s*([A-Za-z_][\w.]*)\s*>/g, file.content)) {
    const entity = shortTypeName(m[1] ?? "");
    if (entity) add(entity, `modelBuilder.Entity<${entity}>`);
  }
  for (const m of matches(/\[Table\s*\(\s*["']([^"']+)["']/g, file.content)) {
    const table = (m[1] ?? "").trim();
    if (table) add(table, `[Table("${table}")]`);
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
    || target.includes(provider.service.root.replace(/[/-]/g, "_").toUpperCase())
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

  const cappedProviders = capSignals(providers);
  const cappedConsumers = capSignals(consumers);
  const cappedEvents = capSignals(events);
  const cappedData = capSignals(data);
  const signalsTruncated = cappedProviders.truncated || cappedConsumers.truncated || cappedEvents.truncated || cappedData.truncated;
  const projectRefs = buildProjectReferenceMap(topology ?? null);

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const pushEdge = (edge: GraphEdge): boolean => {
    if (seen.has(edge.id)) return false;
    seen.add(edge.id);
    edges.push(edge);
    return edges.length >= maxEdges;
  };
  for (const consumer of cappedConsumers.list) {
    const bestByService = new Map<string, {
      provider: ApiProvider;
      confidence: number;
      total: number;
      label: string;
    }>();
    for (const provider of cappedProviders.list) {
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
      const current = bestByService.get(provider.service.root);
      const total = baseScore + corroboration + topologyBoost;
      if (betterScore({ total, confidence }, current)) bestByService.set(provider.service.root, { provider, confidence, total, label });
    }
    const best = [...bestByService.values()].sort((a, b) =>
      b.total - a.total
      || b.confidence - a.confidence
      || a.provider.service.root.localeCompare(b.provider.service.root),
    )[0];
    if (!best) continue;
    const key = `${consumer.service.root}->${best.provider.service.root}:${best.label}:${consumer.sourcePath}:${best.provider.sourcePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const full = pushEdge({
      id: importEdgeId(`svc:${consumer.service.root}`, `svc:${best.provider.service.root}:${edges.length}`),
      from: `svc:${consumer.service.root}`,
      to: `svc:${best.provider.service.root}`,
      kind: "api",
      sourcePath: consumer.sourcePath,
      targetPath: best.provider.sourcePath,
      serviceFrom: consumer.service.root,
      serviceTo: best.provider.service.root,
      label: best.label,
      detail: `${consumer.service.name} -> ${best.provider.service.name}`,
      confidence: best.confidence,
      evidence: [consumer.evidence, best.provider.evidence],
    });
    if (full) return { services, edges, truncated: true };
  }
  for (const consumer of cappedConsumers.list) {
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
      id: importEdgeId(`svc:${consumer.service.root}`, `svc:${target.root}:config:${consumer.sourcePath}:${edges.length}`),
      from: `svc:${consumer.service.root}`,
      to: `svc:${target.root}`,
      kind: "config",
      sourcePath: consumer.sourcePath,
      serviceFrom: consumer.service.root,
      serviceTo: target.root,
      label: consumer.host,
      detail: `${consumer.service.name} references ${target.name}`,
      confidence,
      evidence: [consumer.evidence],
    });
    if (full) return { services, edges, truncated: true };
  }
  for (const producer of cappedEvents.list.filter((signal) => signal.role === "publish")) {
    for (const subscriber of cappedEvents.list.filter((signal) => signal.role === "subscribe")) {
      if (producer.service.root === subscriber.service.root || producer.topic !== subscriber.topic) continue;
      const full = pushEdge({
        id: importEdgeId(`svc:${producer.service.root}`, `svc:${subscriber.service.root}:event:${producer.topic}:${edges.length}`),
        from: `svc:${producer.service.root}`,
        to: `svc:${subscriber.service.root}`,
        kind: "event",
        sourcePath: producer.sourcePath,
        targetPath: subscriber.sourcePath,
        serviceFrom: producer.service.root,
        serviceTo: subscriber.service.root,
        label: producer.topic,
        detail: `${producer.service.name} publishes; ${subscriber.service.name} subscribes`,
        confidence: 0.65,
        evidence: [producer.evidence, subscriber.evidence],
      });
      if (full) return { services, edges, truncated: true };
    }
  }
  for (const writer of cappedData.list.filter((signal) => signal.role === "write")) {
    for (const reader of cappedData.list.filter((signal) => signal.role === "read")) {
      if (writer.service.root === reader.service.root || writer.resource !== reader.resource) continue;
      const full = pushEdge({
        id: importEdgeId(`svc:${writer.service.root}`, `svc:${reader.service.root}:data:${writer.resource}:${edges.length}`),
        from: `svc:${writer.service.root}`,
        to: `svc:${reader.service.root}`,
        kind: "data",
        sourcePath: writer.sourcePath,
        targetPath: reader.sourcePath,
        serviceFrom: writer.service.root,
        serviceTo: reader.service.root,
        label: writer.resource,
        detail: `${writer.service.name} writes; ${reader.service.name} reads`,
        confidence: 0.5,
        evidence: [writer.evidence, reader.evidence],
      });
      if (full) return { services, edges, truncated: true };
    }
  }
  return { services, edges, truncated: signalsTruncated };
}
