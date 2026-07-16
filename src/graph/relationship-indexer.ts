import { clusterDir, langOf, normalizeGraphPath, type GraphEdge } from "./graph-model.js";
import {
  buildClientConfigIndex,
  lookupHostRoot,
  resolveProxyHost,
  urlHost,
  type ClientConfigIndex,
} from "./client-config.js";
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

/** How a consumer's target was established. This is the client-verification
    signal the matcher keys precision on: a route-shaped path alone ("relative")
    is the weakest evidence a call crosses services, while a URL host, an env
    token, a config-resolved value, or a reverse-proxy route each verify that an
    actual HTTP client is configured to leave the service. */
type TargetOrigin = "url" | "env" | "resolved" | "proxy" | "relative";

interface ApiConsumer {
  service: ServiceInfo;
  path?: string;
  method?: string;
  host?: string;
  /** Concrete hostname after env/config/proxy resolution (host may be a token). */
  resolvedHost?: string;
  /** Authoritative target service root (compose hostname mapping). Matches to
      any other service are vetoed. */
  resolvedRoot?: string;
  origin?: TargetOrigin;
  operation?: string;
  /** Receiver identifier of a generic rpc-shaped call (`fooClient.Bar()`), used
      to gate operation-name collisions. Empty string = bare `client`/`stub`. */
  rpcReceiver?: string;
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
    const methodRe = /((?:\s*\[[^\n]+\]\s*)+)\s*(?:public|internal|protected|private|async|static|virtual|override|sealed|partial|new|\s)+[A-Za-z0-9_<>[\],?.\s]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:=>|\{)/g;
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

/** A decorator/route literal that looks like a URL path rather than a dotted
    module reference. Route paths carry a slash ("/users", "users/:id",
    "http://…") or are a bare single segment ("profile"); a dotted identifier
    with no slash ("pkg.mod.func") is a Python module path — the shape mock
    decorators like `@patch("app.services.user")` use — not a route. */
function isRoutePath(path: string): boolean {
  if (!path) return false;
  if (path.includes("/")) return true;
  return !/^[A-Za-z_]\w*(?:\.\w+)+$/.test(path);
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
    /* Skip decorator args that are dotted module paths rather than URL routes.
       Without a router/app receiver, unittest.mock's `@patch("pkg.mod.func")`
       matches this pattern and would otherwise register as a `PATCH
       pkg.mod.func` route provider — a pervasive false positive in any tested
       Python service (see isRoutePath). */
    if (!isRoutePath(m[2] ?? "")) continue;
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

/** SCREAMING_SNAKE identifiers we treat as environment tokens. */
const ENV_TOKEN_RE = /^[A-Z][A-Z0-9_]{2,}$/;
/** Env-token name shapes that read as a service address even when no config
    file resolves them to a concrete URL. */
const ENV_URLISH_SUFFIX_RE = /_(?:URL|URI|HOST|ADDR|ADDRESS|ENDPOINT|BASE|BASE_URL)$/;

const JS_LANGS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte"]);

/** A base-URL value a client variable was assigned: either a concrete URL or an
    environment token (possibly with a literal fallback). */
interface BaseRef {
  url?: string;
  envToken?: string;
}

/** The classified target of one HTTP call — the fields ApiConsumer carries for
    matching. See TargetOrigin for what each origin certifies. */
interface ClientTarget {
  host?: string;
  resolvedHost?: string;
  resolvedRoot?: string;
  path?: string;
  origin: TargetOrigin;
}

function resolveEnvUrl(config: ClientConfigIndex | undefined, token: string): string | undefined {
  return config?.envUrl.get(token) ?? config?.envUrl.get(token.replace(/:/g, "__").toUpperCase());
}

function relativeTarget(path: string, service: ServiceInfo, config: ClientConfigIndex | undefined): ClientTarget {
  /* A relative path may still be verified: reverse-proxy config in the same
     service (nginx location, devserver proxy, CRA "proxy") names the upstream
     the call actually reaches. */
  if (config && path.startsWith("/")) {
    const proxyHost = resolveProxyHost(config, service.root, path);
    if (proxyHost) {
      return { host: proxyHost, resolvedHost: proxyHost, resolvedRoot: lookupHostRoot(config, proxyHost), path, origin: "proxy" };
    }
  }
  return { path: path || undefined, origin: "relative" };
}

function targetFromBaseRef(
  ref: BaseRef | undefined,
  path: string | undefined,
  service: ServiceInfo,
  config: ClientConfigIndex | undefined,
): ClientTarget {
  if (ref?.envToken) {
    const configured = resolveEnvUrl(config, ref.envToken);
    const url = configured ?? ref.url;
    if (url) {
      const resolved = classifyTarget(path ? joinUrl(url, path) : url, service, config, undefined);
      /* Display/name-match on the token (it usually names the target service);
         the concrete host is carried separately. */
      return { ...resolved, host: ref.envToken, origin: "resolved" };
    }
    if (ENV_URLISH_SUFFIX_RE.test(ref.envToken)) return { host: ref.envToken, path, origin: "env" };
    return relativeTarget(path ?? "", service, config);
  }
  if (ref?.url) return classifyTarget(path ? joinUrl(ref.url, path) : ref.url, service, config, undefined);
  return relativeTarget(path ?? "", service, config);
}

/** Classify one captured request-target string. Handles absolute URLs,
    `${VAR}`/`{var}`/`$VAR` base prefixes (env tokens or file-local base
    variables), and bare relative paths. */
function classifyTarget(
  raw: string,
  service: ServiceInfo,
  config: ClientConfigIndex | undefined,
  fileRefs: ReadonlyMap<string, BaseRef> | undefined,
): ClientTarget {
  const value = raw.trim();
  const urlPrefix = /^https?:\/\/([^/\s"']+)/i.exec(value);
  if (urlPrefix) {
    const host = urlPrefix[1] ?? "";
    const path = value.slice(urlPrefix[0].length) || "/";
    return { host, resolvedHost: host, resolvedRoot: config ? lookupHostRoot(config, host) : undefined, path, origin: "url" };
  }
  const templateVar = /^\$?\{\s*(?:process\.env\.|import\.meta\.env\.|env\.)?([A-Za-z_$][\w$]*)\s*\}/.exec(value)
    ?? /^\$([A-Z][A-Z0-9_]{2,})(?=\/|$)/.exec(value);
  if (templateVar) {
    const rest = value.slice(templateVar[0].length);
    const path = rest ? (rest.startsWith("/") ? rest : `/${rest}`) : undefined;
    const name = templateVar[1] ?? "";
    /* A file-local assignment wins over the name's own shape: `const BASE_URL =
       process.env.USERS_SERVICE_URL` makes `${BASE_URL}` mean that env var, not
       a literal BASE_URL environment token. */
    const ref = fileRefs?.get(name) ?? (ENV_TOKEN_RE.test(name) ? { envToken: name } : undefined);
    return targetFromBaseRef(ref, path, service, config);
  }
  return relativeTarget(value, service, config);
}

/** File-local base-URL variable assignments (JS/TS and Python): literal URLs,
    env reads, and env reads with a literal fallback. These are what make
    `fetch(\`\${BASE_URL}/x\`)` and `requests.get(f"{BASE}/x")` verifiable. */
function collectFileBaseRefs(file: IndexedFileContent, lang: string): Map<string, BaseRef> {
  const refs = new Map<string, BaseRef>();
  const add = (name: string | undefined, ref: BaseRef): void => {
    if (name && !refs.has(name) && (ref.url || ref.envToken)) refs.set(name, ref);
  };
  if (JS_LANGS.has(lang)) {
    for (const m of matches(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["'`](https?:\/\/[^"'`\s]+)["'`]/g, file.content)) {
      add(m[1], { url: m[2] });
    }
    const envAssignRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:process\.env|import\.meta\.env)\.([A-Za-z_][\w]*)(?:\s*(?:\?\?|\|\|)\s*["'`](https?:\/\/[^"'`\s]+)["'`])?/g;
    for (const m of matches(envAssignRe, file.content)) {
      add(m[1], { envToken: m[2], url: m[3] });
    }
  }
  if (lang === "py") {
    for (const m of matches(/([A-Za-z_]\w*)\s*=\s*["'](https?:\/\/[^"'\s]+)["']/g, file.content)) {
      add(m[1], { url: m[2] });
    }
    const getenvRe = /([A-Za-z_]\w*)\s*=\s*os\.(?:environ\.get|getenv)\s*\(\s*["']([\w]+)["']\s*(?:,\s*["'](https?:\/\/[^"'\s]+)["'])?/g;
    for (const m of matches(getenvRe, file.content)) {
      add(m[1], { envToken: m[2], url: m[3] });
    }
    for (const m of matches(/([A-Za-z_]\w*)\s*=\s*os\.environ\[\s*["'](\w+)["']/g, file.content)) {
      add(m[1], { envToken: m[2] });
    }
  }
  return refs;
}

/** Axios instances created with a baseURL (`const api = axios.create({ baseURL })`)
    — their verb calls are HTTP consumers whose base is the instance's. */
function collectAxiosInstances(file: IndexedFileContent, refs: ReadonlyMap<string, BaseRef>): Map<string, BaseRef> {
  const instances = new Map<string, BaseRef>();
  const createRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*axios\.create\s*\(\s*\{[\s\S]{0,300}?baseURL\s*:\s*(?:["'`](https?:\/\/[^"'`]+)["'`]|(?:process\.env|import\.meta\.env)\.([A-Za-z_][\w]*)|([A-Za-z_$][\w$]*))/g;
  for (const m of matches(createRe, file.content)) {
    const name = m[1];
    const ref: BaseRef | undefined = m[2] ? { url: m[2] } : m[3] ? { envToken: m[3] } : m[4] ? refs.get(m[4]) : undefined;
    if (name && ref && (ref.url || ref.envToken)) instances.set(name, ref);
  }
  return instances;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function joinUrl(base: string, rel: string): string {
  if (/^https?:\/\//i.test(rel)) return rel;
  const normalizedBase = base.replace(/\/+$/, "");
  const normalizedRel = rel.replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedRel}`;
}

/* A BaseAddress argument is either a string literal or a Configuration["A:B"]
   read; the latter resolves through appsettings*.json (see client-config.ts). */
const URI_ARG_SOURCE = `(?:["']([^"']+)["']|[\\w.]*Configuration\\[\\s*["']([^"']+)["']\\s*\\])`;

function buildCSharpClientIndex(files: readonly IndexedFileContent[], config?: ClientConfigIndex): CSharpClientIndex {
  const namedBaseAddresses = new Map<string, string>();
  const typedBaseAddresses = new Map<string, string>();
  const classNamesByFile = new Map<string, string[]>();
  const baseFrom = (literal: string | undefined, configKey: string | undefined): string | undefined => {
    const base = literal?.trim() || (configKey ? resolveEnvUrl(config, configKey.trim()) : undefined);
    return base || undefined;
  };
  for (const file of files) {
    if (langOf(file.path) !== "cs") continue;
    const classNames: string[] = [];
    for (const match of matches(/\bclass\s+([A-Za-z_]\w*)\b/g, file.content)) {
      const className = match[1]?.trim();
      if (className && !classNames.includes(className)) classNames.push(className);
    }
    classNamesByFile.set(file.path, classNames);
    const namedClientRe = new RegExp(`AddHttpClient\\s*\\(\\s*["']([^"']+)["'][\\s\\S]{0,240}?BaseAddress\\s*=\\s*new\\s+Uri\\(\\s*${URI_ARG_SOURCE}`, "g");
    for (const match of matches(namedClientRe, file.content)) {
      const name = match[1]?.trim();
      const base = baseFrom(match[2], match[3]);
      if (name && base) namedBaseAddresses.set(name, base);
    }
    const typedClientRe = new RegExp(`AddHttpClient\\s*<\\s*([A-Za-z_]\\w*)(?:\\s*,\\s*[^>]+)?\\s*>\\s*\\([\\s\\S]{0,240}?BaseAddress\\s*=\\s*new\\s+Uri\\(\\s*${URI_ARG_SOURCE}`, "g");
    for (const match of matches(typedClientRe, file.content)) {
      const className = match[1]?.trim();
      const base = baseFrom(match[2], match[3]);
      if (className && base) typedBaseAddresses.set(className, base);
    }
  }
  return { namedBaseAddresses, typedBaseAddresses, classNamesByFile };
}

function collectConsumers(
  file: IndexedFileContent,
  service: ServiceInfo,
  csharpIndex?: CSharpClientIndex,
  config?: ClientConfigIndex,
): ApiConsumer[] {
  const out: ApiConsumer[] = [];
  const lang = langOf(file.path);
  const fileRefs = collectFileBaseRefs(file, lang);
  const classify = (raw: string): ClientTarget => classifyTarget(raw, service, config, fileRefs);
  const location = (match: RegExpExecArray) => ({
    sourcePath: file.path,
    line: sourceLine(file, match.index),
    offset: match.index,
  });

  const httpRe = /\b(?:fetch|axios(?:\.(get|post|put|patch|delete))?|got|requests\.(get|post|put|patch|delete))\s*\(\s*["'`]([^"'`]+)["'`]/g;
  for (const m of matches(httpRe, file.content)) {
    const raw = m[3] ?? "";
    const method = (m[1] ?? m[2] ?? "GET").toUpperCase();
    out.push({ service, method, ...classify(raw), ...location(m), evidence: `${method} ${raw}` });
  }

  if (JS_LANGS.has(lang)) {
    /* Base + literal concatenation: `fetch(BASE_URL + "/api/x")` /
       `axios.post(process.env.X + "/y")`. The quoted-argument pattern above
       cannot see these, which hid exactly the config-driven clients that carry
       real cross-service traffic. */
    const concatRe = /\b(fetch|axios(?:\.(get|post|put|patch|delete))?|got)\s*\(\s*((?:process\.env|import\.meta\.env)\.[A-Za-z_][\w]*|[A-Za-z_$][\w$]*)\s*\+\s*["'`]([^"'`]+)["'`]/g;
    for (const m of matches(concatRe, file.content)) {
      const expr = m[3] ?? "";
      const raw = m[4] ?? "";
      const method = (m[2] ?? "GET").toUpperCase();
      const envName = /^(?:process\.env|import\.meta\.env)\.([A-Za-z_][\w]*)$/.exec(expr)?.[1];
      const ref = envName ? { envToken: envName } : fileRefs.get(expr);
      out.push({
        service,
        method,
        ...targetFromBaseRef(ref, raw, service, config),
        ...location(m),
        evidence: `${method} ${expr} + "${raw}"`,
      });
    }
    const axiosInstances = collectAxiosInstances(file, fileRefs);
    if (axiosInstances.size > 0) {
      const instanceRe = new RegExp(
        `\\b(${[...axiosInstances.keys()].map(escapeRegExp).join("|")})\\.(get|post|put|patch|delete)\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]`,
        "g",
      );
      for (const m of matches(instanceRe, file.content)) {
        const ref = axiosInstances.get(m[1] ?? "");
        const raw = m[3] ?? "";
        out.push({
          service,
          method: (m[2] ?? "GET").toUpperCase(),
          ...targetFromBaseRef(ref, raw, service, config),
          ...location(m),
          evidence: `${m[1]}.${m[2]} ${raw}`,
        });
      }
    }
  }

  if (lang === "py") {
    /* requests with an f-string or base + literal concatenation. */
    const pyFStringRe = /\brequests\.(get|post|put|patch|delete)\s*\(\s*f["']([^"']+)["']/g;
    for (const m of matches(pyFStringRe, file.content)) {
      const raw = m[2] ?? "";
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), ...classify(raw), ...location(m), evidence: `${m[1]?.toUpperCase()} ${raw}` });
    }
    const pyConcatRe = /\brequests\.(get|post|put|patch|delete)\s*\(\s*([A-Za-z_]\w*)\s*\+\s*["']([^"']+)["']/g;
    for (const m of matches(pyConcatRe, file.content)) {
      const raw = m[3] ?? "";
      out.push({
        service,
        method: (m[1] ?? "GET").toUpperCase(),
        ...targetFromBaseRef(fileRefs.get(m[2] ?? ""), raw, service, config),
        ...location(m),
        evidence: `${m[1]?.toUpperCase()} ${m[2]} + "${raw}"`,
      });
    }
  }

  if (lang === "go") {
    /* Go: stdlib convenience calls and explicit NewRequest(WithContext). */
    const goHttpRe = /\bhttp\.(Get|Post|Put|Patch|Delete)\s*\(\s*["'`]([^"'`\n]+)["'`]/gi;
    for (const m of matches(goHttpRe, file.content)) {
      const raw = m[2] ?? "";
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), ...classify(raw), ...location(m), evidence: `http.${m[1]} ${raw}` });
    }
    const goEnvConcatRe = /\bhttp\.(Get|Post|Put|Patch|Delete)\s*\(\s*os\.Getenv\(\s*"([A-Za-z_][\w]*)"\s*\)\s*\+\s*"([^"\n]+)"/g;
    for (const m of matches(goEnvConcatRe, file.content)) {
      const raw = m[3] ?? "";
      out.push({
        service,
        method: (m[1] ?? "GET").toUpperCase(),
        ...targetFromBaseRef({ envToken: m[2] }, raw, service, config),
        ...location(m),
        evidence: `http.${m[1]} os.Getenv(${m[2]}) + "${raw}"`,
      });
    }
    const goNewRequestRe = /\bhttp\.NewRequest\s*\(\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]\s*,\s*["'`]([^"'`\n]+)["'`]/gi;
    for (const m of matches(goNewRequestRe, file.content)) {
      const raw = m[2] ?? "";
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), ...classify(raw), ...location(m), evidence: `http.NewRequest ${m[1]} ${raw}` });
    }
    const goNewRequestCtxRe = /\bhttp\.NewRequestWithContext\s*\([^,]+,\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]\s*,\s*["'`]([^"'`\n]+)["'`]/gi;
    for (const m of matches(goNewRequestCtxRe, file.content)) {
      const raw = m[2] ?? "";
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), ...classify(raw), ...location(m), evidence: `http.NewRequestWithContext ${m[1]} ${raw}` });
    }
  }

  if (lang === "java") {
    /* Spring RestTemplate (named verbs + exchange), WebClient, and OkHttp. */
    const restTemplateNamedRe = /\brestTemplate\s*\.\s*(get|post|put|patch|delete)(?:For(?:Object|Entity))?\s*\(\s*["']([^"'\n]+)["']/gi;
    for (const m of matches(restTemplateNamedRe, file.content)) {
      const raw = m[2] ?? "";
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), ...classify(raw), ...location(m), evidence: `restTemplate.${m[1]} ${raw}` });
    }
    const restTemplateExchangeRe = /\brestTemplate\s*\.\s*exchange\s*\(\s*["']([^"'\n]+)["']\s*,\s*HttpMethod\.(GET|POST|PUT|PATCH|DELETE)/gi;
    for (const m of matches(restTemplateExchangeRe, file.content)) {
      const raw = m[1] ?? "";
      out.push({ service, method: (m[2] ?? "GET").toUpperCase(), ...classify(raw), ...location(m), evidence: `restTemplate.exchange ${raw}` });
    }
    const webClientRe = /\bwebClient\s*\.\s*(get|post|put|patch|delete)\s*\(\s*\)[\s\S]{0,80}?\.\s*uri\s*\(\s*["']([^"'\n]+)["']/gi;
    for (const m of matches(webClientRe, file.content)) {
      const raw = m[2] ?? "";
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), ...classify(raw), ...location(m), evidence: `webClient.${m[1]} ${raw}` });
    }
    /* OkHttp builder chain (method-agnostic — GET is the default and other
       verbs are set via a separate .method(...) call this doesn't track). */
    const okHttpRe = /\bnew\s+Request\.Builder\s*\(\s*\)[\s\S]{0,120}?\.\s*url\s*\(\s*["']([^"'\n]+)["']/g;
    for (const m of matches(okHttpRe, file.content)) {
      const raw = m[1] ?? "";
      out.push({ service, ...classify(raw), ...location(m), evidence: `OkHttp ${raw}` });
    }
  }

  if (lang === "cs") {
    /* C#: HttpClient async verbs and RestSharp (implicit GET when no Method is
       given, matching RestSharp's own default). */
    const csharpHttpClientRe = /\b\w*[Hh]ttp[Cc]lient\s*\.\s*(Get|Post|Put|Patch|Delete)Async\s*\(\s*["']([^"'\n]+)["']/g;
    for (const m of matches(csharpHttpClientRe, file.content)) {
      const raw = m[2] ?? "";
      out.push({ service, method: (m[1] ?? "GET").toUpperCase(), ...classify(raw), ...location(m), evidence: `HttpClient.${m[1]}Async ${raw}` });
    }
    const restSharpRe = /\bnew\s+RestRequest\s*\(\s*["']([^"'\n]+)["']\s*(?:,\s*Method\.(Get|Post|Put|Patch|Delete))?/g;
    for (const m of matches(restSharpRe, file.content)) {
      const raw = m[1] ?? "";
      out.push({ service, method: (m[2] ?? "GET").toUpperCase(), ...classify(raw), ...location(m), evidence: `RestRequest ${raw}` });
    }

    const baseAddressByVar = new Map<string, string>();
    const typedBaseAddresses = (csharpIndex?.classNamesByFile.get(file.path) ?? [])
      .map((name) => csharpIndex?.typedBaseAddresses.get(name))
      .filter((value): value is string => Boolean(value));
    const inlineHttpClientRe = /\b(?:var|[A-Za-z_][\w<>,.[\]\s?]+)\s+([A-Za-z_]\w*)\s*=\s*new\s+HttpClient\s*\{[\s\S]{0,200}?BaseAddress\s*=\s*new\s+Uri\(\s*["']([^"']+)["']/g;
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
    const createClientRe = /\b(?:var|[A-Za-z_][\w<>,.[\]\s?]+)\s+([A-Za-z_]\w*)\s*=\s*[A-Za-z_]\w*\.CreateClient\s*\(\s*["']([^"']+)["']\s*\)/g;
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
      out.push({ service, method: (m[2] ?? "GET").toUpperCase(), ...classify(joinUrl(base, raw)), ...location(m), evidence: `CreateClient(${clientName}) ${raw}` });
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
        out.push({ service, method: (m[2] ?? "GET").toUpperCase(), ...classify(joinUrl(base, raw)), ...location(m), evidence: `HttpClient.${m[2]}Async ${raw}` });
      }
    }
  }

  /* Bare env-token references. `*_SERVICE_URL`/`*_API_URL` names are accepted on
     shape alone; other URL-ish suffixes only count when workspace config
     actually maps the token to a URL — otherwise DATABASE_URL-style tokens
     would fabricate service references. These consumers carry no path, so they
     can only ever become `config` edges, never API edges. */
  const envRe = /\b([A-Z][A-Z0-9_]*_(?:URL|URI|HOST|ADDR|ADDRESS|ENDPOINT|BASE_URL))\b/g;
  for (const m of matches(envRe, file.content)) {
    const token = m[1] ?? "";
    const configured = resolveEnvUrl(config, token);
    if (!configured && !/_(?:SERVICE|API)_URL$/.test(token)) continue;
    const resolvedHost = configured ? urlHost(configured) : undefined;
    out.push({
      service,
      host: token,
      resolvedHost,
      resolvedRoot: config ? lookupHostRoot(config, resolvedHost) : undefined,
      origin: configured ? "resolved" : "env",
      ...location(m),
      evidence: `config ${token}`,
    });
  }
  if (!["json", "toml", "yaml", "yml"].includes(lang)) {
    const gqlRe = /\b(query|mutation)\s+([A-Za-z_][\w]*)/g;
    for (const m of matches(gqlRe, file.content)) {
      out.push({ service, operation: `${m[1] === "mutation" ? "Mutation" : "Query"}.${m[2]}`, ...location(m), evidence: `GraphQL ${m[1]} ${m[2]}` });
    }
    /* A `<name>Client.<method>` receiver only. The old alternative also matched
       a bare `word/word` (any "a/b"), which fired on file paths, arithmetic, and
       date literals in ordinary code — and, worse, on service-name path
       fragments inside Dockerfiles, compose files, and shell scripts (a `COPY
       user-service/ /app` line read as an rpc call), manufacturing service
       edges from infrastructure text. Real gRPC call sites are covered by
       genericRpcCallRe below and the proto provider/operation matching. */
    const rpcRe = /\b([A-Za-z_][\w]*)Client\.[A-Za-z_][\w]*/g;
    for (const m of matches(rpcRe, file.content)) {
      const svc = m[1];
      if (svc) out.push({ service, operation: svc, ...location(m), evidence: `rpc client ${svc}` });
    }
    /* gRPC call sites: a variable ending in Client/Stub (Go/Java stub naming, e.g.
       `userClient.GetUser(...)` or `blockingStub.getUser(...)`) or the bare
       "client"/"stub" convention. The receiver is recorded so matching can gate
       operation-name collisions: `anyClient.Create(...)` must not bind to every
       proto that declares an rpc named Create. */
    const genericRpcCallRe = /\b(client|stub|[A-Za-z_][\w]*(?:Client|Stub))\s*\.\s*([A-Za-z_][\w]*)\s*\(/g;
    for (const m of matches(genericRpcCallRe, file.content)) {
      const receiver = (m[1] ?? "").replace(/(?:Client|Stub)$/i, "").toLowerCase();
      const rpc = m[2] ?? "";
      const rpcReceiver = ["", "client", "stub", "grpc", "rpc", "api", "http"].includes(receiver) ? "" : receiver;
      if (rpc) out.push({ service, operation: rpc, rpcReceiver, ...location(m), evidence: `rpc call ${rpc}` });
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

/** How far back a bare `FROM <table>` is allowed to look for the `SELECT` that
    proves it's SQL rather than prose. Statement-local, so a `SELECT` elsewhere
    in a large file can't validate an unrelated `from`. */
const SQL_SELECT_LOOKBACK = 200;

/** A `FROM <token>` reads as a SQL table only when a `SELECT` precedes it within
    the same statement window. This is what separates a real query from the
    dominant false positives the bare `\bfrom\b` match produced: prose in
    comments and docstrings ("loads data from the cache"), UI strings ("choose
    from the list"), Python `from pkg import x`, and every Dockerfile's `FROM
    node:18`. Language-agnostic on purpose — SQL lives in string literals across
    every language, and this gate keeps the token match while dropping the
    non-SQL noise that made data edges untrustworthy. */
function hasSqlSelectContext(content: string, fromIndex: number): boolean {
  const before = content.slice(Math.max(0, fromIndex - SQL_SELECT_LOOKBACK), fromIndex);
  return /\bselect\b/i.test(before);
}

function collectDataSignals(file: IndexedFileContent, service: ServiceInfo): DataSignal[] {
  const out: DataSignal[] = [];
  const readRe = /\bfrom\s+["'`]?([A-Za-z_][\w.:-]*)["'`]?/gi;
  for (const m of matches(readRe, file.content)) {
    /* Avoid treating Python's `from package import name` as SQL. */
    const after = file.content.slice((m.index ?? 0) + m[0].length);
    if (/^\s+import\b/.test(after)) continue;
    if (!hasSqlSelectContext(file.content, m.index ?? 0)) continue;
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
  /* INSERT INTO / DELETE FROM are specific enough to stand alone. UPDATE is a
     common English word, so it only counts as a write when followed by the SQL
     `SET` clause — "update the readme" or "update dependencies" in prose no
     longer manufactures a write signal. */
  const writeRe = /\b(?:insert\s+into|delete\s+from)\s+["'`]?([A-Za-z_][\w.:-]*)["'`]?/gi;
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
  const updateRe = /\bupdate\s+["'`]?([A-Za-z_][\w.:-]*)["'`]?\s+set\b/gi;
  for (const m of matches(updateRe, file.content)) {
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

/** The string a consumer's *target identity* is matched against. Only host
    evidence (URL host, env token, resolved hostname) and operation names
    participate — the raw evidence text is deliberately excluded. Including it
    let a route's own path fragments "corroborate" the match (any `/users/...`
    fetch name-matched a service called users), which inflated confidence on
    exactly the token-collision edges that made route-only ranking untrustworthy. */
function consumerNameTarget(consumer: ApiConsumer): string {
  return [consumer.host, consumer.resolvedHost, consumer.operation].filter(Boolean).join(" ").toLowerCase();
}

function namesCompatible(provider: ApiProvider, consumer: ApiConsumer): boolean {
  const target = consumerNameTarget(consumer);
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

/** Occurrence-aware confidence for aggregated (event/data) edges. A high
    occurrence count is *collision* evidence — shared REST conventions, common
    table names, generic topics — not corroboration, so confidence falls as the
    raw pair count grows, and falls further when the same key fans out across
    many distinct service pairs. A single clean producer/consumer pair keeps the
    base confidence untouched. */
function collisionDampedConfidence(base: number, occurrenceCount: number, servicePairCount: number): number {
  const occurrencePenalty = 0.04 * Math.log2(Math.max(1, occurrenceCount));
  const breadthPenalty = 0.06 * Math.max(0, servicePairCount - 2);
  return Math.max(0.2, base - occurrencePenalty - breadthPenalty);
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
  /** Service roots declaring each operation tail — the collision gate for
      generic rpc-shaped consumers (see operationTailServiceCount). */
  private readonly tailRoots = new Map<string, Set<string>>();

  constructor(providers: readonly ApiProvider[]) {
    providers.forEach((provider, i) => this.order.set(provider, i));
    for (const provider of providers) {
      if (provider.operation) {
        this.push(this.byOpTail, operationTail(provider.operation), provider);
        const tail = operationTail(provider.operation);
        const roots = this.tailRoots.get(tail);
        if (roots) roots.add(provider.service.root);
        else this.tailRoots.set(tail, new Set([provider.service.root]));
      }
      if (provider.path) {
        const staticTokens = pathSegments(provider.path).filter(isStaticSegment);
        if (staticTokens.length === 0) this.wildcardPath.push(provider);
        else for (const token of staticTokens) this.push(this.byPathToken, token, provider);
      }
      /* Tokens are stored exactly as namesCompatible compares them (lowercase),
         otherwise the substring pre-filter would silently drop candidates the
         exact predicate accepts. */
      this.addNameToken(provider.service.name.toLowerCase(), provider);
      this.addNameToken(provider.service.root.replace(/[/-]/g, "_").toLowerCase(), provider);
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

  /** How many distinct provider services declare an operation with this tail.
      >1 means a bare `client.X()` call cannot be attributed soundly. */
  operationTailServiceCount(tail: string): number {
    return this.tailRoots.get(tail)?.size ?? 0;
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
    const target = consumerNameTarget(consumer);
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
  return resource.trim().replace(/^[`"'[]|[`"'\]]$/g, "").toLowerCase();
}

function groupedByService<T extends { service: ServiceInfo }>(signals: readonly T[]): Map<string, T[]> {
  return groupBy(signals, (signal) => signal.service.root);
}

export function buildServiceRelationships(
  files: readonly IndexedFileContent[],
  maxEdges = 5000,
  topology?: ProjectTopology | null,
): RelationshipResult {
  const normalized = files.map((raw) => ({ path: normalizeGraphPath(raw.path), content: raw.content }));
  const services = detectServices(normalized.map((f) => f.path), topology);
  const clientConfig = buildClientConfigIndex(normalized, (path) => nearestService(path, services).root);
  const providers: ApiProvider[] = [];
  const consumers: ApiConsumer[] = [];
  const events: EventSignal[] = [];
  const data: DataSignal[] = [];
  const csharpIndex = buildCSharpClientIndex(normalized, clientConfig);
  for (const file of normalized) {
    const service = nearestService(file.path, services);
    providers.push(...collectOpenApiProviders(file, service));
    providers.push(...collectProtoProviders(file, service));
    providers.push(...collectGraphqlProviders(file, service));
    providers.push(...collectRouteProviders(file, service));
    consumers.push(...collectConsumers(file, service, csharpIndex, clientConfig));
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
  const matchedConsumers = new Set<ApiConsumer>();
  for (const consumer of consumers) {
    /* An API edge requires an actual call signal — a request path or an
       operation. Bare env-token references (no path, no operation) are config
       evidence, handled by the config pass below; letting them stand in as API
       calls was a top source of false edges. */
    if (!consumer.path && !consumer.operation) continue;
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
      /* An authoritatively resolved target (compose hostname -> service root)
         vetoes every other service: whatever a route pattern says, this client
         is configured to call exactly one place. */
      if (consumer.resolvedRoot && provider.service.root !== consumer.resolvedRoot) continue;
      const resolvedMatch = !!consumer.resolvedRoot && provider.service.root === consumer.resolvedRoot;
      const methodMatch = !provider.method || !consumer.method || provider.method === consumer.method;
      let exactOperation = !!provider.operation && !!consumer.operation && (
        provider.operation.toLowerCase() === consumer.operation.toLowerCase()
        || provider.operation.toLowerCase().endsWith(`.${consumer.operation.toLowerCase()}`)
      );
      /* Generic rpc-shaped calls (`fooClient.Bar()`) collide on common method
         names. A prefixed receiver must name the provider (its operation,
         service name, or root); a bare `client`/`stub` receiver only counts
         when exactly one service declares that operation. */
      if (exactOperation && consumer.rpcReceiver !== undefined && consumer.operation) {
        const providerIdentity = `${provider.operation ?? ""} ${provider.service.name} ${provider.service.root}`.toLowerCase();
        const receiverNamesProvider = consumer.rpcReceiver !== "" && providerIdentity.includes(consumer.rpcReceiver);
        const tailUnique = providerIndex.operationTailServiceCount(operationTail(consumer.operation)) <= 1;
        if (!receiverNamesProvider && !tailUnique) exactOperation = false;
      }
      /* Generic rpc-shaped consumers are all-or-nothing: if the gated exact
         operation match failed, the tail-substring name check must not revive
         the edge (any provider sharing the operation tail would name-match). */
      if (consumer.rpcReceiver !== undefined && !exactOperation) continue;
      const pathMatch = methodMatch && pathsCompatible(provider, consumer);
      const nameMatch = resolvedMatch || namesCompatible(provider, consumer);
      const strongSignal = exactOperation || pathMatch;
      if (!strongSignal && !nameMatch) continue;
      /* Verified-client requirements (route patterns alone are not evidence of
         a cross-service call):
         - resolved targets need a strong signal here; unmatched ones get their
           own verified-client edge in the pass below instead of per-route
           guesses.
         - same-origin candidates (a path with no host evidence at all) only
           survive when project topology corroborates the dependency, and are
           marked and downranked — `fetch("/api/x")` usually targets the
           service's own backend, not whichever service shares the route shape. */
      if (consumer.resolvedRoot && !strongSignal) continue;
      const sameOrigin = consumer.origin === "relative";
      const topologyBoost = projectTopologyBoost(consumer.sourcePath, provider.sourcePath, topology, projectRefs);
      if (sameOrigin && (!pathMatch || topologyBoost <= 0)) continue;
      /* Multi-signal confidence: an operation-id or path match corroborated by
         independent host evidence naming the target is genuinely more certain
         than either signal alone; an authoritative config resolution is more
         certain still. Weak single signals rank (and read) as weak. */
      let baseConfidence: number;
      let baseScore: number;
      if (sameOrigin) {
        baseConfidence = 0.5;
        baseScore = 70;
      } else if (strongSignal && resolvedMatch) {
        baseConfidence = 0.97;
        baseScore = (exactOperation ? 120 : 100) + 20;
      } else if (strongSignal && nameMatch) {
        baseConfidence = 0.95;
        baseScore = exactOperation ? 120 : 100;
      } else if (strongSignal) {
        baseConfidence = 0.9;
        baseScore = exactOperation ? 120 : 100;
      } else {
        baseConfidence = 0.55;
        baseScore = 60;
      }
      const corroboration = strongSignal && nameMatch && !sameOrigin ? 10 : 0;
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
      /* Several equally strong candidates means at most one is the real
         target, so the per-edge confidence shrinks with the tie size — a
         high occurrence of the same match is collision evidence, not
         corroboration. */
      const emittedConfidence = best.length > 1
        ? Math.max(0.2, candidate.confidence / Math.sqrt(best.length))
        : candidate.confidence;
      const detailParts = [`${consumer.service.name} -> ${provider.service.name}`];
      if (best.length > 1) detailParts.push(`(${best.length} equally strong candidates)`);
      if (consumer.origin === "relative") detailParts.push("(same-origin call; corroborated by project topology)");
      matchedConsumers.add(consumer);
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
        detail: detailParts.join(" "),
        confidence: emittedConfidence,
        evidence: evidenceSamples([consumer], [provider]),
        ambiguityGroup,
        ambiguousCandidateCount: best.length > 1 ? best.length : undefined,
      });
      if (full) return { services, edges, truncated: true };
    }
  }
  const serviceByRoot = new Map(services.map((svc) => [svc.root, svc]));
  for (const consumer of consumers) {
    /* A consumer that already produced an API edge is accounted for — emitting
       a second config edge for the same call would double-count it. */
    if (matchedConsumers.has(consumer)) continue;
    /* Authoritatively resolved clients whose route didn't match any declared
       provider: the call is still real — configuration proves where it goes —
       so surface it rather than dropping it. Config-driven calls (env vars,
       reverse proxies) were previously invisible whenever route matching
       failed, a structural recall gap. */
    /* A target resolved to the consumer's own service is a self-call (an SPA
       hitting its own backend through the proxy) — not a service edge at all. */
    if (consumer.resolvedRoot === consumer.service.root) continue;
    const resolvedTarget = consumer.resolvedRoot ? serviceByRoot.get(consumer.resolvedRoot) : undefined;
    if (resolvedTarget) {
      const isCall = Boolean(consumer.path);
      const full = pushEdge({
        id: stableRelationshipId(isCall ? "api" : "config", [
          "verified-client",
          consumer.service.root,
          resolvedTarget.root,
          consumer.sourcePath,
          consumer.line,
          consumer.offset,
        ]),
        from: `svc:${consumer.service.root}`,
        to: `svc:${resolvedTarget.root}`,
        kind: isCall ? "api" : "config",
        sourcePath: consumer.sourcePath,
        sourceLine: consumer.line,
        serviceFrom: consumer.service.root,
        serviceTo: resolvedTarget.root,
        label: isCall ? `${consumer.method ?? "HTTP"} ${consumer.path}` : consumer.host,
        detail: isCall
          ? `${consumer.service.name} -> ${resolvedTarget.name} (configured client; no matching route declaration)`
          : `${consumer.service.name} references ${resolvedTarget.name}`,
        confidence: isCall ? 0.72 : 0.7,
        evidence: [consumer.evidence],
      });
      if (full) return { services, edges, truncated: true };
      continue;
    }
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
    let topicPairCount = 0;
    for (const sourceRoot of publishers.keys()) {
      for (const targetRoot of subscribers.keys()) {
        if (sourceRoot !== targetRoot) topicPairCount += 1;
      }
    }
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
          confidence: collisionDampedConfidence(0.65, occurrenceCount, topicPairCount),
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
    let resourcePairCount = 0;
    for (const sourceRoot of writers.keys()) {
      for (const targetRoot of readers.keys()) {
        if (sourceRoot !== targetRoot) resourcePairCount += 1;
      }
    }
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
          confidence: collisionDampedConfidence(0.5, occurrenceCount, resourcePairCount),
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
