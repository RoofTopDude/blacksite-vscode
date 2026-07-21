/* Workspace-level HTTP-client configuration index for the service lens.

   Route-pattern matching alone cannot tell a real cross-service HTTP call from
   a token collision: validation against a verified corpus showed the top-ranked
   route-only edges were almost all false positives, while clients wired through
   environment variables, appsettings, compose networking, or a reverse proxy
   were invisible. This module extracts the configuration half of that evidence:

   - envUrl:    ENV_TOKEN -> URL, from .env* files, docker-compose `environment`
                entries, Kubernetes `env:` blocks, and appsettings*.json values
                (flattened "A:B:C" keys plus their A__B__C env-override form).
   - hostRoot:  network hostname -> service root, from docker-compose service
                names whose build context points at a workspace directory. This
                is authoritative: a consumer whose URL host resolves here targets
                exactly that service, and matches elsewhere can be vetoed.
   - portService: published host port -> compose service name, from `ports:`
                mappings, so localhost:PORT dev-loop clients resolve to the
                service actually listening there.
   - proxyRoutes: per-service path-prefix -> upstream host, from nginx
                `location`/`proxy_pass` blocks, Vite/webpack devserver `proxy`
                config, and CRA's package.json `"proxy"`. These give same-origin
                (relative-path) frontend calls a concrete backend target.

   Only URL-shaped values and variable *names* are recorded — arbitrary config
   values (secrets) never leave this module. */

import { langOf, normalizeGraphPath } from "./graph-model.js";

export interface ProxyRoute {
  /** Request-path prefix the proxy forwards, e.g. "/api". */
  prefix: string;
  /** Upstream hostname (no scheme/port). */
  host: string;
}

export interface ClientConfigIndex {
  /** Environment/config token -> URL value found in workspace config. */
  envUrl: Map<string, string>;
  /** Network hostname -> workspace service root (docker-compose authoritative). */
  hostRoot: Map<string, string>;
  /** Published host port -> compose service name, from `ports: ["3001:3000"]`
      entries. Resolves `http://localhost:3001` dev-loop clients to the service
      listening on that port (via hostRoot on the service name). */
  portService: Map<number, string>;
  /** Service root -> reverse-proxy routes served from that service. */
  proxyRoutes: Map<string, ProxyRoute[]>;
}

const URL_VALUE_RE = /^https?:\/\/\S+$/i;

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "." : path.slice(0, idx) || ".";
}

function basename(path: string): string {
  const normalized = normalizeGraphPath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

/** Hostname of a URL, lowercased, without port or auth. */
export function urlHost(url: string): string | undefined {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(url.trim());
  return m?.[1]?.toLowerCase();
}

/** Normalize a hostname for hostRoot lookups: lowercase, no port. Callers may
    additionally retry with the first dot-label (users.internal -> users), which
    is how compose network aliases usually appear in fully-qualified form. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

export function lookupHostRoot(index: ClientConfigIndex, host: string | undefined): string | undefined {
  if (!host) return undefined;
  const normalized = normalizeHost(host);
  const direct = index.hostRoot.get(normalized);
  if (direct) return direct;
  const firstLabel = normalized.split(".")[0] ?? "";
  return firstLabel && firstLabel !== normalized ? index.hostRoot.get(firstLabel) : undefined;
}

/** Authoritative service root for a host that may carry a port ("users:3000",
    "localhost:3001"). Hostname mapping wins; for loopback-style hosts the
    published-port table identifies which compose service the port belongs to —
    the host itself ("localhost") never names a service. */
export function lookupTargetRoot(index: ClientConfigIndex, hostWithPort: string | undefined): string | undefined {
  if (!hostWithPort) return undefined;
  const byName = lookupHostRoot(index, hostWithPort);
  if (byName) return byName;
  if (!isGenericHost(hostWithPort)) return undefined;
  const port = /:(\d+)$/.exec(hostWithPort.trim())?.[1];
  if (!port) return undefined;
  const serviceName = index.portService.get(Number(port));
  return serviceName ? index.hostRoot.get(serviceName) : undefined;
}

/** Hosts that never identify a workspace service. */
export function isGenericHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "localhost" || normalized === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(normalized) || normalized === "host.docker.internal";
}

const ENV_FILE_RE = /(?:^|\/)\.env(?:\.[\w.-]+)?$/i;
const COMPOSE_FILE_RE = /(?:^|\/)(?:docker-)?compose[\w.-]*\.ya?ml$/i;
const NGINX_FILE_RE = /(?:^|\/)(?:[\w.-]*nginx[\w.-]*\.conf|conf\.d\/[\w.-]+\.conf|sites-(?:available|enabled)\/[\w.-]+)$/i;
const APPSETTINGS_FILE_RE = /(?:^|\/)appsettings(?:\.[\w.-]+)?\.json$/i;
const DEVSERVER_CONFIG_RE = /(?:^|\/)(?:vite\.config\.[cm]?[jt]s|webpack[\w.-]*\.[cm]?js|vue\.config\.[cm]?js)$/i;

/** Matches path-shape recognized as reverse-proxy/devserver config. Exported so
    file discovery can admit the non-source shapes (.env, nginx conf). */
export function isClientConfigPath(relPath: string): boolean {
  const normalized = normalizeGraphPath(relPath);
  return ENV_FILE_RE.test(normalized) || NGINX_FILE_RE.test(normalized);
}

function addEnvUrl(index: ClientConfigIndex, token: string, value: string): void {
  const name = token.trim();
  const url = value.trim().replace(/^["']|["']$/g, "");
  if (!name || !URL_VALUE_RE.test(url)) return;
  if (!index.envUrl.has(name)) index.envUrl.set(name, url);
}

function parseDotEnv(index: ClientConfigIndex, content: string): void {
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) addEnvUrl(index, m[1] ?? "", m[2] ?? "");
  }
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Line-based docker-compose reader: service names under `services:`, their
    build contexts (service root evidence), and `environment:` URL entries. A
    real YAML parser isn't warranted for these three shapes. */
function parseCompose(index: ClientConfigIndex, composePath: string, content: string): void {
  const composeDir = dirname(normalizeGraphPath(composePath));
  const lines = content.split(/\r?\n/);
  let inServices = false;
  let servicesIndent = 0;
  let currentService: string | undefined;
  let serviceIndent = 0;
  let inEnvironment = false;
  let environmentIndent = 0;
  let inBuild = false;
  let buildIndent = 0;
  let inPorts = false;
  let portsIndent = 0;

  const recordContext = (rawContext: string): void => {
    if (!currentService) return;
    const context = rawContext.trim().replace(/^["']|["']$/g, "");
    if (!context || context.startsWith("http")) return;
    const joined = context === "." ? composeDir : normalizeGraphPath(
      context.startsWith("/") ? context.slice(1) : composeDir === "." ? context : `${composeDir}/${context}`,
    );
    /* Collapse "."/".." segments so a compose file in a subdirectory maps its
       services onto the same workspace-relative roots detectServices produces. */
    const segments: string[] = [];
    for (const segment of joined.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") segments.pop();
      else segments.push(segment);
    }
    const root = segments.length === 0 ? "." : segments.join("/");
    if (!index.hostRoot.has(currentService)) index.hostRoot.set(currentService, root);
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = indentOf(line);

    if (/^services\s*:\s*$/.test(trimmed) && indent === 0) {
      inServices = true;
      servicesIndent = indent;
      currentService = undefined;
      continue;
    }
    if (inServices && indent <= servicesIndent && !/^services\s*:/.test(trimmed)) {
      inServices = false;
      currentService = undefined;
    }
    if (!inServices) continue;

    const serviceKey = /^([A-Za-z0-9][\w.-]*)\s*:\s*$/.exec(trimmed);
    if (serviceKey && indent > servicesIndent && (currentService === undefined || indent <= serviceIndent)) {
      currentService = serviceKey[1]?.toLowerCase();
      serviceIndent = indent;
      inEnvironment = false;
      inBuild = false;
      inPorts = false;
      continue;
    }
    if (!currentService || indent <= serviceIndent) continue;

    if (inEnvironment && indent <= environmentIndent) inEnvironment = false;
    if (inBuild && indent <= buildIndent) inBuild = false;
    if (inPorts && indent <= portsIndent) inPorts = false;

    const inlineBuild = /^build\s*:\s*(\S.*)$/.exec(trimmed);
    if (inlineBuild) {
      recordContext(inlineBuild[1] ?? "");
      continue;
    }
    if (/^build\s*:\s*$/.test(trimmed)) {
      inBuild = true;
      buildIndent = indent;
      continue;
    }
    if (inBuild) {
      const ctx = /^context\s*:\s*(\S.*)$/.exec(trimmed);
      if (ctx) recordContext(ctx[1] ?? "");
      continue;
    }
    if (/^ports\s*:\s*$/.test(trimmed)) {
      inPorts = true;
      portsIndent = indent;
      continue;
    }
    if (inPorts) {
      /* `- "HOST:CONTAINER"` (optionally with an interface prefix like
         "127.0.0.1:3001:3000"); only the published host port matters here. */
      const portEntry = /^-\s*["']?(?:[\d.]+:)?(\d+):\d+/.exec(trimmed);
      const hostPort = portEntry ? Number(portEntry[1]) : Number.NaN;
      if (currentService && Number.isFinite(hostPort) && !index.portService.has(hostPort)) {
        index.portService.set(hostPort, currentService);
      }
      continue;
    }
    if (/^environment\s*:\s*$/.test(trimmed)) {
      inEnvironment = true;
      environmentIndent = indent;
      continue;
    }
    if (inEnvironment) {
      const listEntry = /^-\s*([A-Za-z_][\w.]*)\s*[=:]\s*(.+)$/.exec(trimmed);
      const mapEntry = /^([A-Za-z_][\w.]*)\s*:\s*(.+)$/.exec(trimmed);
      const entry = listEntry ?? mapEntry;
      if (entry) addEnvUrl(index, entry[1] ?? "", entry[2] ?? "");
    }
  }
}

/** Kubernetes manifests: `env:` entries as `- name: X` / `value: http://...`. */
function parseKubernetesEnv(index: ClientConfigIndex, content: string): void {
  const envEntryRe = /-\s*name\s*:\s*["']?([A-Za-z_][\w.]*)["']?\s*\r?\n\s*value\s*:\s*["']?(https?:\/\/[^\s"']+)["']?/g;
  envEntryRe.lastIndex = 0;
  for (let m = envEntryRe.exec(content); m !== null; m = envEntryRe.exec(content)) {
    addEnvUrl(index, m[1] ?? "", m[2] ?? "");
  }
}

/** appsettings*.json: every URL-valued string keyed by its flattened
    "Section:Sub:Key" path, plus the "SECTION__SUB__KEY" env-override spelling
    .NET uses, so both `Configuration["A:B"]` reads and env overrides resolve. */
function parseAppSettings(index: ClientConfigIndex, content: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return;
  }
  const walk = (node: unknown, path: string[]): void => {
    if (typeof node === "string") {
      if (URL_VALUE_RE.test(node.trim()) && path.length > 0) {
        const key = path.join(":");
        addEnvUrl(index, key, node);
        addEnvUrl(index, key.replace(/:/g, "__").toUpperCase(), node);
      }
      return;
    }
    if (node && typeof node === "object" && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    }
  };
  walk(parsed, []);
}

function addProxyRoute(index: ClientConfigIndex, serviceRoot: string, prefix: string, target: string): void {
  const host = urlHost(target);
  const cleanPrefix = prefix.trim();
  if (!host || !cleanPrefix.startsWith("/")) return;
  const routes = index.proxyRoutes.get(serviceRoot);
  const route = { prefix: cleanPrefix.replace(/\/+$/, "") || "/", host };
  if (routes) routes.push(route);
  else index.proxyRoutes.set(serviceRoot, [route]);
}

/** nginx: `location <prefix> { ... proxy_pass http://host...; }`. Regex and
    exact-match locations (`~`, `=`) are skipped — only prefix locations give a
    sound path-prefix -> upstream mapping. */
function parseNginx(index: ClientConfigIndex, serviceRoot: string, content: string): void {
  const locationRe = /\blocation\s+(\/[^\s{]*)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  locationRe.lastIndex = 0;
  for (let m = locationRe.exec(content); m !== null; m = locationRe.exec(content)) {
    const target = /\bproxy_pass\s+(https?:\/\/[^\s;]+)/.exec(m[2] ?? "")?.[1];
    if (target) addProxyRoute(index, serviceRoot, m[1] ?? "", target);
  }
}

/** Vite/webpack devserver proxy blocks: `"/api": "http://..."` or
    `"/api": { target: "http://..." }`. Only path-prefix keys are read. */
function parseDevServerProxy(index: ClientConfigIndex, serviceRoot: string, content: string): void {
  if (!/\bproxy\s*:/.test(content)) return;
  const entryRe = /["'`](\/[\w./-]*)["'`]\s*:\s*(?:["'`](https?:\/\/[^"'`]+)["'`]|\{[^{}]*?\btarget\s*:\s*["'`](https?:\/\/[^"'`]+)["'`])/g;
  entryRe.lastIndex = 0;
  for (let m = entryRe.exec(content); m !== null; m = entryRe.exec(content)) {
    addProxyRoute(index, serviceRoot, m[1] ?? "", m[2] ?? m[3] ?? "");
  }
}

/** CRA-style package.json `"proxy": "http://..."` forwards every unmatched
    relative request, i.e. prefix "/". */
function parsePackageJsonProxy(index: ClientConfigIndex, serviceRoot: string, content: string): void {
  try {
    const parsed = JSON.parse(content) as { proxy?: unknown };
    if (typeof parsed.proxy === "string") addProxyRoute(index, serviceRoot, "/", parsed.proxy);
  } catch {
    /* Not JSON — nothing to read. */
  }
}

export function buildClientConfigIndex(
  files: readonly { path: string; content: string }[],
  serviceRootFor: (path: string) => string,
): ClientConfigIndex {
  const index: ClientConfigIndex = { envUrl: new Map(), hostRoot: new Map(), portService: new Map(), proxyRoutes: new Map() };
  for (const file of files) {
    const path = normalizeGraphPath(file.path);
    const name = basename(path).toLowerCase();
    if (ENV_FILE_RE.test(path)) parseDotEnv(index, file.content);
    else if (COMPOSE_FILE_RE.test(path)) parseCompose(index, path, file.content);
    else if (APPSETTINGS_FILE_RE.test(path)) parseAppSettings(index, file.content);
    else if (NGINX_FILE_RE.test(path)) parseNginx(index, serviceRootFor(path), file.content);
    else if (DEVSERVER_CONFIG_RE.test(path)) parseDevServerProxy(index, serviceRootFor(path), file.content);
    else if (name === "package.json") parsePackageJsonProxy(index, serviceRootFor(path), file.content);
    else if ((langOf(path) === "yaml" || langOf(path) === "yml") && /\benv\s*:/.test(file.content)) parseKubernetesEnv(index, file.content);
  }
  return index;
}

/** Resolve a relative request path against this service's reverse-proxy routes.
    Longest matching prefix wins, mirroring nginx/devserver semantics. */
export function resolveProxyHost(index: ClientConfigIndex, serviceRoot: string, requestPath: string): string | undefined {
  const routes = index.proxyRoutes.get(serviceRoot);
  if (!routes || !requestPath.startsWith("/")) return undefined;
  let best: ProxyRoute | undefined;
  for (const route of routes) {
    const matches = route.prefix === "/" || requestPath === route.prefix || requestPath.startsWith(`${route.prefix}/`);
    if (matches && (!best || route.prefix.length > best.prefix.length)) best = route;
  }
  return best?.host;
}
