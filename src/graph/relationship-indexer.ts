import { clusterDir, importEdgeId, normalizeGraphPath, type GraphEdge } from "./graph-model.js";

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

export interface RelationshipResult {
  services: ServiceInfo[];
  edges: GraphEdge[];
  truncated: boolean;
}

const MARKER_NAMES = new Set(["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "Dockerfile", "docker-compose.yml", "docker-compose.yaml"]);
const SPEC_RE = /\.(openapi|swagger)\.(json|ya?ml)$|openapi\.(json|ya?ml)$|swagger\.(json|ya?ml)$|\.proto$|\.graphqls?$|schema\.graphql$/i;
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

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

export function detectServices(files: readonly string[]): ServiceInfo[] {
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
  for (const raw of files) {
    const file = normalizeGraphPath(raw);
    const name = basename(file);
    if (MARKER_NAMES.has(name) || SPEC_RE.test(file) || file.includes("/k8s/") || file.includes("/helm/")) {
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

function collectRouteProviders(file: IndexedFileContent, service: ServiceInfo): ApiProvider[] {
  const out: ApiProvider[] = [];
  const routeRe = new RegExp(`\\b(?:app|router|server)\\s*\\.\\s*(${HTTP_METHODS.join("|")})\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]`, "gi");
  for (let m = routeRe.exec(file.content); m !== null; m = routeRe.exec(file.content)) {
    out.push({ service, method: (m[1] ?? "GET").toUpperCase(), path: m[2] ?? "", sourcePath: file.path, evidence: `${m[1]?.toUpperCase()} ${m[2]}` });
  }
  const decoratorRe = /@(?:app|router|Controller)?\.?(Get|Post|Put|Patch|Delete|Head|Options|get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g;
  for (let m = decoratorRe.exec(file.content); m !== null; m = decoratorRe.exec(file.content)) {
    out.push({ service, method: (m[1] ?? "GET").toUpperCase(), path: m[2] ?? "", sourcePath: file.path, evidence: `${m[1]?.toUpperCase()} ${m[2]}` });
  }
  const pyRouteRe = /@(?:app|router|blueprint)\.(get|post|put|patch|delete|route)\s*\(\s*["']([^"']+)["']/g;
  for (let m = pyRouteRe.exec(file.content); m !== null; m = pyRouteRe.exec(file.content)) {
    out.push({ service, method: (m[1] === "route" ? "GET" : m[1] ?? "GET").toUpperCase(), path: m[2] ?? "", sourcePath: file.path, evidence: `${m[1]?.toUpperCase()} ${m[2]}` });
  }
  return out;
}

function collectConsumers(file: IndexedFileContent, service: ServiceInfo): ApiConsumer[] {
  const out: ApiConsumer[] = [];
  const httpRe = /\b(?:fetch|axios(?:\.(get|post|put|patch|delete))?|got|requests\.(get|post|put|patch|delete))\s*\(\s*["'`]([^"'`]+)["'`]/g;
  for (let m = httpRe.exec(file.content); m !== null; m = httpRe.exec(file.content)) {
    const raw = m[3] ?? "";
    const method = (m[1] ?? m[2] ?? "GET").toUpperCase();
    const host = /https?:\/\/([^/]+)/.exec(raw)?.[1] ?? /\$\{?([A-Z0-9_]+_SERVICE_URL)\}?/.exec(raw)?.[1];
    const path = raw.replace(/^https?:\/\/[^/]+/, "").replace(/\$\{?[^}/]+_SERVICE_URL\}?/, "") || raw;
    out.push({ service, method, host, path, sourcePath: file.path, evidence: `${method} ${raw}` });
  }
  const envRe = /\b([A-Z0-9_]+_SERVICE_URL|[A-Z0-9_]+_API_URL)\b/g;
  for (let m = envRe.exec(file.content); m !== null; m = envRe.exec(file.content)) {
    out.push({ service, host: m[1], sourcePath: file.path, evidence: `config ${m[1]}` });
  }
  const gqlRe = /\b(query|mutation)\s+([A-Za-z_][\w]*)/g;
  for (let m = gqlRe.exec(file.content); m !== null; m = gqlRe.exec(file.content)) {
    out.push({ service, operation: `${m[1] === "mutation" ? "Mutation" : "Query"}.${m[2]}`, sourcePath: file.path, evidence: `GraphQL ${m[1]} ${m[2]}` });
  }
  const rpcRe = /\b([A-Za-z_][\w]*)Client\.[A-Za-z_][\w]*|\b([A-Za-z_][\w]*)\s*\/\s*([A-Za-z_][\w]*)/g;
  for (let m = rpcRe.exec(file.content); m !== null; m = rpcRe.exec(file.content)) {
    const svc = m[1] ?? m[2];
    const rpc = m[3];
    if (svc) out.push({ service, operation: rpc ? `${svc}.${rpc}` : svc, sourcePath: file.path, evidence: `rpc client ${svc}${rpc ? `.${rpc}` : ""}` });
  }
  const genericRpcCallRe = /\b(?:client|[A-Za-z_][\w]*Client)\s*\.\s*([A-Za-z_][\w]*)\s*\(/g;
  for (let m = genericRpcCallRe.exec(file.content); m !== null; m = genericRpcCallRe.exec(file.content)) {
    const rpc = m[1] ?? "";
    if (rpc) out.push({ service, operation: rpc, sourcePath: file.path, evidence: `rpc call ${rpc}` });
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
  return out.filter((signal) => signal.resource.length > 2);
}

function pathsCompatible(provider: ApiProvider, consumer: ApiConsumer): boolean {
  if (!provider.path || !consumer.path) return false;
  const providerPath = provider.path.replace(/\{[^}]+\}/g, "{}").replace(/:[A-Za-z_]\w*/g, ":");
  const consumerPath = consumer.path.replace(/\?.*$/, "");
  if (consumerPath.includes(provider.path) || consumerPath.endsWith(provider.path)) return true;
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

export function buildServiceRelationships(files: readonly IndexedFileContent[], maxEdges = 5000): RelationshipResult {
  const paths = files.map((f) => normalizeGraphPath(f.path));
  const services = detectServices(paths);
  const providers: ApiProvider[] = [];
  const consumers: ApiConsumer[] = [];
  const events: EventSignal[] = [];
  const data: DataSignal[] = [];
  for (const raw of files) {
    const file = { path: normalizeGraphPath(raw.path), content: raw.content };
    const service = nearestService(file.path, services);
    providers.push(...collectOpenApiProviders(file, service));
    providers.push(...collectProtoProviders(file, service));
    providers.push(...collectGraphqlProviders(file, service));
    providers.push(...collectRouteProviders(file, service));
    consumers.push(...collectConsumers(file, service));
    events.push(...collectEventSignals(file, service));
    data.push(...collectDataSignals(file, service));
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const pushEdge = (edge: GraphEdge): boolean => {
    if (seen.has(edge.id)) return false;
    seen.add(edge.id);
    edges.push(edge);
    return edges.length >= maxEdges;
  };
  for (const consumer of consumers) {
    for (const provider of providers) {
      if (provider.service.root === consumer.service.root) continue;
      const methodMatch = !provider.method || !consumer.method || provider.method === consumer.method;
      const exactOperation = !!provider.operation && !!consumer.operation && (
        provider.operation.toLowerCase() === consumer.operation.toLowerCase()
        || provider.operation.toLowerCase().endsWith(`.${consumer.operation.toLowerCase()}`)
      );
      const pathMatch = methodMatch && pathsCompatible(provider, consumer);
      const nameMatch = namesCompatible(provider, consumer);
      if (!exactOperation && !pathMatch && !nameMatch) continue;
      const confidence = exactOperation || pathMatch ? 0.9 : 0.55;
      const label = provider.method ? `${provider.method} ${provider.path}` : provider.operation ?? provider.path;
      const key = `${consumer.service.root}->${provider.service.root}:${label}:${consumer.sourcePath}:${provider.sourcePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const full = pushEdge({
        id: importEdgeId(`svc:${consumer.service.root}`, `svc:${provider.service.root}:${edges.length}`),
        from: `svc:${consumer.service.root}`,
        to: `svc:${provider.service.root}`,
        kind: "api",
        sourcePath: consumer.sourcePath,
        targetPath: provider.sourcePath,
        serviceFrom: consumer.service.root,
        serviceTo: provider.service.root,
        label,
        detail: `${consumer.service.name} -> ${provider.service.name}`,
        confidence,
        evidence: [consumer.evidence, provider.evidence],
      });
      if (full) return { services, edges, truncated: true };
    }
  }
  for (const consumer of consumers) {
    if (!consumer.host) continue;
    const target = services.find((svc) => svc.root !== consumer.service.root && namesCompatible({ service: svc, path: "", sourcePath: "", evidence: "" }, consumer));
    if (!target) continue;
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
      confidence: 0.45,
      evidence: [consumer.evidence],
    });
    if (full) return { services, edges, truncated: true };
  }
  for (const producer of events.filter((signal) => signal.role === "publish")) {
    for (const subscriber of events.filter((signal) => signal.role === "subscribe")) {
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
  for (const writer of data.filter((signal) => signal.role === "write")) {
    for (const reader of data.filter((signal) => signal.role === "read")) {
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
  return { services, edges, truncated: false };
}
