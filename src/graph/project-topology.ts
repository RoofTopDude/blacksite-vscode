import { dirOf, joinPosix, normalizeGraphPath } from "./graph-model.js";
import { parseGoMod } from "./go-modules.js";

export interface TopologySourceFile {
  path: string;
  content: string;
}

export type ProjectKind = "dotnet" | "npm" | "maven" | "gradle" | "go";
export type ProjectReferenceKind = "project" | "package" | "module" | "build";

export interface ProjectNode {
  id: string;
  root: string;
  name: string;
  kind: ProjectKind;
  manifestFiles: string[];
  containerRoot?: string;
}

export interface ProjectReference {
  from: string;
  to: string;
  kind: ProjectReferenceKind;
  evidence?: string;
}

export interface ProjectTopology {
  projects: ProjectNode[];
  references: ProjectReference[];
}

interface MutableProjectNode extends ProjectNode {
  manifestFiles: string[];
}

interface MavenProjectMeta {
  root: string;
  artifactId: string;
  groupId?: string;
  modules: string[];
  dependencies: Array<{ groupId?: string; artifactId: string }>;
}

function fileName(relPath: string): string {
  const normalized = normalizeGraphPath(relPath);
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function fileStem(relPath: string): string {
  const name = fileName(relPath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function normalizeDir(relPath: string): string {
  const dir = dirOf(normalizeGraphPath(relPath));
  return dir || ".";
}

function pushUnique(list: string[], value: string | undefined | null): void {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
}

function normalizeContainerRoot(root: string | undefined): string | undefined {
  if (!root) return undefined;
  const normalized = normalizeGraphPath(root) || ".";
  return normalized === "." ? "." : normalized.replace(/\/+$/, "");
}

function mergeProject(projects: Map<string, MutableProjectNode>, node: ProjectNode): void {
  const root = normalizeGraphPath(node.root) || ".";
  const existing = projects.get(root);
  if (!existing) {
    projects.set(root, {
      ...node,
      id: root,
      root,
      manifestFiles: [...node.manifestFiles].sort(),
      containerRoot: normalizeContainerRoot(node.containerRoot),
    });
    return;
  }
  existing.name ||= node.name;
  existing.containerRoot = chooseMoreSpecificContainer(existing.containerRoot, node.containerRoot);
  for (const manifest of node.manifestFiles) pushUnique(existing.manifestFiles, manifest);
  existing.manifestFiles.sort();
}

function chooseMoreSpecificContainer(current: string | undefined, next: string | undefined): string | undefined {
  const a = normalizeContainerRoot(current);
  const b = normalizeContainerRoot(next);
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

function addReference(
  references: ProjectReference[],
  seen: Set<string>,
  from: string,
  to: string,
  kind: ProjectReferenceKind,
  evidence?: string,
): void {
  const normalizedFrom = normalizeGraphPath(from) || ".";
  const normalizedTo = normalizeGraphPath(to) || ".";
  if (!normalizedFrom || !normalizedTo || normalizedFrom === normalizedTo) return;
  const key = `${normalizedFrom}\u0000${normalizedTo}\u0000${kind}`;
  if (seen.has(key)) return;
  seen.add(key);
  references.push({ from: normalizedFrom, to: normalizedTo, kind, evidence });
}

function parseJson(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function dependencyNames(pkg: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const value = pkg[field];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const name of Object.keys(value)) pushUnique(out, name);
  }
  return out;
}

function workspacePatterns(pkg: Record<string, unknown>): string[] {
  const workspaces = pkg.workspaces;
  if (Array.isArray(workspaces)) return workspaces.filter((value): value is string => typeof value === "string");
  if (workspaces && typeof workspaces === "object" && !Array.isArray(workspaces)) {
    const packages = (workspaces as Record<string, unknown>).packages;
    if (Array.isArray(packages)) return packages.filter((value): value is string => typeof value === "string");
  }
  return [];
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeGraphPath(pattern).replace(/^\.\/+/, "").replace(/\/+$/, "");
  let source = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === "*") {
      const next = normalized[i + 1];
      if (next === "*") {
        source += ".*";
        i += 1;
      } else {
        source += "[^/]+";
      }
      continue;
    }
    if ("\\.[]{}()+-?^$|".includes(char ?? "")) source += `\\${char}`;
    else source += char;
  }
  source += "$";
  return new RegExp(source);
}

function relativeTo(baseDir: string, targetDir: string): string | null {
  const baseNormalized = normalizeGraphPath(baseDir);
  const targetNormalized = normalizeGraphPath(targetDir);
  const baseParts = !baseNormalized || baseNormalized === "." ? [] : baseNormalized.split("/").filter(Boolean);
  const targetParts = !targetNormalized || targetNormalized === "." ? [] : targetNormalized.split("/").filter(Boolean);
  if (baseParts.length === 0) return targetParts.join("/");
  if (targetParts.length < baseParts.length) return null;
  for (let i = 0; i < baseParts.length; i += 1) {
    if (baseParts[i] !== targetParts[i]) return null;
  }
  return targetParts.slice(baseParts.length).join("/");
}

function stripXmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "");
}

function tagValues(content: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out: string[] = [];
  for (const match of content.matchAll(re)) {
    const value = match[1]?.replace(/<[^>]+>/g, "").trim();
    if (value) out.push(value);
  }
  return out;
}

function firstTagValue(content: string, tag: string): string | undefined {
  return tagValues(content, tag)[0];
}

function firstAttrValues(content: string, tag: string, attr: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*["']([^"']+)["'][^>]*/?>`, "gi");
  return [...content.matchAll(re)].map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value));
}

function parseSlnMembership(content: string): string[] {
  const re = /Project\([^)]*\)\s*=\s*"[^"]+"\s*,\s*"([^"]+\.csproj)"\s*,\s*"[^"]+"/gi;
  return [...content.matchAll(re)].map((match) => normalizeGraphPath(match[1] ?? ""));
}

function parseCsprojAssemblyName(content: string): string | undefined {
  return firstTagValue(stripXmlComments(content), "AssemblyName") ?? firstTagValue(stripXmlComments(content), "RootNamespace");
}

function withoutParentBlock(content: string): { body: string; parentGroupId?: string } {
  const stripped = stripXmlComments(content);
  const parentBlock = /<parent\b[^>]*>([\s\S]*?)<\/parent>/i.exec(stripped)?.[0] ?? "";
  const parentGroupId = firstTagValue(parentBlock, "groupId");
  return { body: stripped.replace(parentBlock, ""), parentGroupId };
}

function parsePom(content: string, pomPath: string): MavenProjectMeta | null {
  const root = normalizeDir(pomPath);
  const { body, parentGroupId } = withoutParentBlock(content);
  const artifactId = firstTagValue(body, "artifactId");
  if (!artifactId) return null;
  const groupId = firstTagValue(body, "groupId") ?? parentGroupId;
  const modules = tagValues(body, "module");
  const dependencies: Array<{ groupId?: string; artifactId: string }> = [];
  for (const block of body.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/gi)) {
    const depBlock = block[1] ?? "";
    const depArtifact = firstTagValue(depBlock, "artifactId");
    if (!depArtifact) continue;
    dependencies.push({
      artifactId: depArtifact,
      groupId: firstTagValue(depBlock, "groupId"),
    });
  }
  return { root, artifactId, groupId, modules, dependencies };
}

function parseGradleIncludes(content: string): string[] {
  const out: string[] = [];
  const callRe = /\binclude\s*\(([\s\S]*?)\)/g;
  for (const match of content.matchAll(callRe)) {
    for (const quoted of (match[1] ?? "").matchAll(/["']([^"']+)["']/g)) pushUnique(out, quoted[1]);
  }
  const bareRe = /^\s*include\s+([^\r\n]+)/gm;
  for (const match of content.matchAll(bareRe)) {
    for (const quoted of (match[1] ?? "").matchAll(/["']([^"']+)["']/g)) pushUnique(out, quoted[1]);
  }
  return out;
}

function parseGradleProjectDirs(content: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /project\s*\(\s*["'](:[^"']+)["']\s*\)\s*\.projectDir\s*=\s*file\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of content.matchAll(re)) {
    const projectPath = match[1]?.trim();
    const projectDir = match[2]?.trim();
    if (projectPath && projectDir) out.set(projectPath, normalizeGraphPath(projectDir));
  }
  return out;
}

function gradleProjectRoot(settingsRoot: string, projectPath: string, explicitDirs: ReadonlyMap<string, string>): string {
  const configured = explicitDirs.get(projectPath);
  if (configured) return joinPosix(settingsRoot === "." ? "" : settingsRoot, configured) ?? normalizeGraphPath(configured);
  const rel = projectPath.replace(/^:+/, "").split(":").filter(Boolean).join("/");
  const joined = joinPosix(settingsRoot === "." ? "" : settingsRoot, rel);
  return normalizeGraphPath(joined ?? rel) || ".";
}

function parseGradleProjectReferences(content: string): string[] {
  const out: string[] = [];
  const re = /project\s*\(\s*(?:path\s*:\s*)?["'](:[^"']+|[^"')]+)["']\s*\)/g;
  for (const match of content.matchAll(re)) {
    const value = match[1]?.trim();
    if (value) pushUnique(out, value.startsWith(":") ? value : `:${value}`);
  }
  return out;
}

function parseGoWorkUses(content: string): string[] {
  const out: string[] = [];
  const blockRe = /\buse\s*\(([\s\S]*?)\)/g;
  for (const block of content.matchAll(blockRe)) {
    for (const line of (block[1] ?? "").split(/\r?\n/)) {
      const value = line.replace(/\/\/.*$/, "").trim();
      if (value) pushUnique(out, value);
    }
  }
  const lineRe = /^\s*use\s+([^\s()]+)\s*$/gm;
  for (const match of content.matchAll(lineRe)) {
    const value = match[1]?.replace(/\/\/.*$/, "").trim();
    if (value) pushUnique(out, value);
  }
  return out;
}

function parseGoRequires(content: string): string[] {
  const stripped = content.replace(/\/\/.*$/gm, "");
  const out: string[] = [];
  const singleRe = /^\s*require\s+([^\s]+)\s+v[^\s]+/gm;
  for (const match of stripped.matchAll(singleRe)) {
    const modulePath = match[1]?.trim();
    if (modulePath) pushUnique(out, modulePath);
  }
  const blockRe = /\brequire\s*\(([\s\S]*?)\)/g;
  for (const block of stripped.matchAll(blockRe)) {
    for (const line of (block[1] ?? "").split(/\r?\n/)) {
      const modulePath = /^\s*([^\s]+)\s+v[^\s]+/.exec(line)?.[1]?.trim();
      if (modulePath) pushUnique(out, modulePath);
    }
  }
  return out;
}

function parseGoReplaceTargets(content: string): Array<{ modulePath?: string; targetPath?: string }> {
  const stripped = content.replace(/\/\/.*$/gm, "");
  const out: Array<{ modulePath?: string; targetPath?: string }> = [];
  const lineRe = /^\s*replace\s+([^\s]+)\s*(?:[^\n=]+)?=>\s*([^\s]+)\s*$/gm;
  for (const match of stripped.matchAll(lineRe)) {
    out.push({ modulePath: match[1]?.trim(), targetPath: match[2]?.trim() });
  }
  const blockRe = /\breplace\s*\(([\s\S]*?)\)/g;
  for (const block of stripped.matchAll(blockRe)) {
    for (const line of (block[1] ?? "").split(/\r?\n/)) {
      const match = /^\s*([^\s]+)\s*(?:[^\n=]+)?=>\s*([^\s]+)\s*$/.exec(line);
      if (match) out.push({ modulePath: match[1]?.trim(), targetPath: match[2]?.trim() });
    }
  }
  return out;
}

function addNpmTopology(
  manifests: ReadonlyMap<string, string>,
  projects: Map<string, MutableProjectNode>,
  references: ProjectReference[],
  seenReferences: Set<string>,
): void {
  const packages = [...manifests.entries()]
    .filter(([file]) => fileName(file) === "package.json")
    .map(([file, content]) => ({
      path: file,
      root: normalizeDir(file),
      pkg: parseJson(content),
    }))
    .filter((entry): entry is { path: string; root: string; pkg: Record<string, unknown> } => Boolean(entry.pkg));

  const packageNameByRoot = new Map<string, string>();
  const rootByPackageName = new Map<string, string>();
  for (const entry of packages) {
    const name = typeof entry.pkg.name === "string" ? entry.pkg.name.trim() : "";
    if (name) {
      packageNameByRoot.set(entry.root, name);
      rootByPackageName.set(name, entry.root);
    }
  }

  const workspaceRoots = packages
    .map((entry) => ({ ...entry, patterns: workspacePatterns(entry.pkg) }))
    .filter((entry) => entry.patterns.length > 0)
    .sort((a, b) => b.root.length - a.root.length);

  for (const entry of packages) {
    let containerRoot: string | undefined;
    for (const workspace of workspaceRoots) {
      if (workspace.path === entry.path) continue;
      const rel = relativeTo(workspace.root, entry.root);
      if (rel === null || rel === "") continue;
      if (workspace.patterns.some((pattern) => globToRegExp(pattern).test(rel))) {
        containerRoot = workspace.root;
        break;
      }
    }
    mergeProject(projects, {
      id: entry.root,
      root: entry.root,
      name: packageNameByRoot.get(entry.root) ?? fileStem(entry.path),
      kind: "npm",
      manifestFiles: [entry.path],
      containerRoot,
    });
  }

  for (const entry of packages) {
    const fromRoot = entry.root;
    for (const dep of dependencyNames(entry.pkg)) {
      const targetRoot = rootByPackageName.get(dep);
      if (targetRoot) addReference(references, seenReferences, fromRoot, targetRoot, "package", dep);
    }
  }
}

function addDotnetTopology(
  manifests: ReadonlyMap<string, string>,
  projects: Map<string, MutableProjectNode>,
  references: ProjectReference[],
  seenReferences: Set<string>,
): void {
  const solutionMembers = new Map<string, string>();
  for (const [file, content] of manifests) {
    if (!file.toLowerCase().endsWith(".sln")) continue;
    const solutionRoot = normalizeDir(file);
    for (const member of parseSlnMembership(content)) {
      const resolved = joinPosix(solutionRoot === "." ? "" : solutionRoot, member);
      if (!resolved) continue;
      const csprojPath = normalizeGraphPath(resolved);
      solutionMembers.set(normalizeDir(csprojPath), solutionRoot);
      mergeProject(projects, {
        id: normalizeDir(csprojPath),
        root: normalizeDir(csprojPath),
        name: fileStem(csprojPath),
        kind: "dotnet",
        manifestFiles: [csprojPath],
        containerRoot: solutionRoot,
      });
    }
  }

  for (const [file, content] of manifests) {
    if (!file.toLowerCase().endsWith(".csproj")) continue;
    const root = normalizeDir(file);
    const containerRoot = solutionMembers.get(root);
    mergeProject(projects, {
      id: root,
      root,
      name: parseCsprojAssemblyName(content) ?? fileStem(file),
      kind: "dotnet",
      manifestFiles: [file],
      containerRoot,
    });
  }

  for (const [file, content] of manifests) {
    if (!file.toLowerCase().endsWith(".csproj")) continue;
    const root = normalizeDir(file);
    const stripped = stripXmlComments(content);
    for (const include of firstAttrValues(stripped, "ProjectReference", "Include")) {
      const resolved = joinPosix(root === "." ? "" : root, normalizeGraphPath(include));
      if (!resolved) continue;
      const targetPath = normalizeGraphPath(resolved);
      const targetRoot = normalizeDir(targetPath);
      mergeProject(projects, {
        id: targetRoot,
        root: targetRoot,
        name: fileStem(targetPath),
        kind: "dotnet",
        manifestFiles: [targetPath],
      });
      addReference(references, seenReferences, root, targetRoot, "project", include);
    }
  }
}

function addMavenTopology(
  manifests: ReadonlyMap<string, string>,
  projects: Map<string, MutableProjectNode>,
  references: ProjectReference[],
  seenReferences: Set<string>,
): void {
  const poms = [...manifests.entries()]
    .filter(([file]) => fileName(file).toLowerCase() === "pom.xml")
    .map(([file, content]) => parsePom(content, file))
    .filter((meta): meta is MavenProjectMeta => Boolean(meta));

  const metaByRoot = new Map(poms.map((meta) => [meta.root, meta]));
  const rootByCoordinate = new Map<string, string>();

  for (const meta of poms) {
    mergeProject(projects, {
      id: meta.root,
      root: meta.root,
      name: meta.artifactId,
      kind: "maven",
      manifestFiles: [meta.root === "." ? "pom.xml" : `${meta.root}/pom.xml`],
    });
  }

  for (const meta of poms) {
    if (meta.groupId) rootByCoordinate.set(`${meta.groupId}:${meta.artifactId}`, meta.root);
    for (const moduleRel of meta.modules) {
      const moduleRoot = joinPosix(meta.root === "." ? "" : meta.root, normalizeGraphPath(moduleRel));
      if (!moduleRoot) continue;
      const targetRoot = normalizeGraphPath(moduleRoot) || ".";
      const child = metaByRoot.get(targetRoot);
      if (!child) continue;
      mergeProject(projects, {
        id: targetRoot,
        root: targetRoot,
        name: child.artifactId,
        kind: "maven",
        manifestFiles: [targetRoot === "." ? "pom.xml" : `${targetRoot}/pom.xml`],
        containerRoot: meta.root,
      });
    }
  }

  for (const meta of poms) {
    for (const dep of meta.dependencies) {
      const targetRoot = dep.groupId ? rootByCoordinate.get(`${dep.groupId}:${dep.artifactId}`) : undefined;
      if (targetRoot) addReference(references, seenReferences, meta.root, targetRoot, "module", dep.artifactId);
    }
  }
}

function addGradleTopology(
  manifests: ReadonlyMap<string, string>,
  projects: Map<string, MutableProjectNode>,
  references: ProjectReference[],
  seenReferences: Set<string>,
): void {
  const settingsFiles = [...manifests.entries()]
    .filter(([file]) => {
      const lower = fileName(file).toLowerCase();
      return lower === "settings.gradle" || lower === "settings.gradle.kts";
    })
    .map(([file, content]) => ({
      path: file,
      root: normalizeDir(file),
      includes: parseGradleIncludes(content),
      projectDirs: parseGradleProjectDirs(content),
    }));

  for (const settings of settingsFiles) {
    for (const include of settings.includes) {
      const projectRoot = gradleProjectRoot(settings.root, include, settings.projectDirs);
      mergeProject(projects, {
        id: projectRoot,
        root: projectRoot,
        name: include.replace(/^:+/, "").split(":").filter(Boolean).pop() ?? fileStem(projectRoot),
        kind: "gradle",
        manifestFiles: [],
        containerRoot: settings.root,
      });
    }
  }

  for (const [file] of manifests) {
    const lower = fileName(file).toLowerCase();
    if (lower !== "build.gradle" && lower !== "build.gradle.kts") continue;
    const root = normalizeDir(file);
    const containerRoot = settingsFiles
      .map((settings) => settings.root)
      .filter((settingsRoot) => settingsRoot === "." || root === settingsRoot || root.startsWith(`${settingsRoot}/`))
      .sort((a, b) => b.length - a.length)[0];
    mergeProject(projects, {
      id: root,
      root,
      name: fileStem(root),
      kind: "gradle",
      manifestFiles: [file],
      containerRoot,
    });
  }

  const settingsByRoot = new Map(settingsFiles.map((settings) => [settings.root, settings]));
  for (const [file, content] of manifests) {
    const lower = fileName(file).toLowerCase();
    if (lower !== "build.gradle" && lower !== "build.gradle.kts") continue;
    const root = normalizeDir(file);
    const settingsRoot = [...settingsByRoot.keys()]
      .filter((candidate) => candidate === "." || root === candidate || root.startsWith(`${candidate}/`))
      .sort((a, b) => b.length - a.length)[0];
    const settings = settingsRoot ? settingsByRoot.get(settingsRoot) : undefined;
    for (const projectPath of parseGradleProjectReferences(content)) {
      const targetRoot = settings
        ? gradleProjectRoot(settings.root, projectPath, settings.projectDirs)
        : gradleProjectRoot(root, projectPath, new Map());
      if (!targetRoot) continue;
      addReference(references, seenReferences, root, targetRoot, "build", projectPath);
    }
  }
}

function addGoTopology(
  manifests: ReadonlyMap<string, string>,
  projects: Map<string, MutableProjectNode>,
  references: ProjectReference[],
  seenReferences: Set<string>,
): void {
  const moduleNameByRoot = new Map<string, string>();
  const rootByModuleName = new Map<string, string>();

  for (const [file, content] of manifests) {
    if (fileName(file).toLowerCase() !== "go.mod") continue;
    const root = normalizeDir(file);
    const parsed = parseGoMod(root === "." ? "" : root, content);
    const moduleName = parsed?.module;
    mergeProject(projects, {
      id: root,
      root,
      name: moduleName?.split("/").pop() ?? fileStem(file),
      kind: "go",
      manifestFiles: [file],
    });
    if (moduleName) {
      moduleNameByRoot.set(root, moduleName);
      rootByModuleName.set(moduleName, root);
    }
  }

  for (const [file, content] of manifests) {
    if (fileName(file).toLowerCase() !== "go.work") continue;
    const workRoot = normalizeDir(file);
    for (const usePath of parseGoWorkUses(content)) {
      const resolved = joinPosix(workRoot === "." ? "" : workRoot, normalizeGraphPath(usePath));
      if (!resolved) continue;
      const targetRoot = normalizeGraphPath(resolved) || ".";
      if (!projects.has(targetRoot)) continue;
      mergeProject(projects, {
        id: targetRoot,
        root: targetRoot,
        name: moduleNameByRoot.get(targetRoot)?.split("/").pop() ?? fileStem(targetRoot),
        kind: "go",
        manifestFiles: [targetRoot === "." ? "go.mod" : `${targetRoot}/go.mod`],
        containerRoot: workRoot,
      });
    }
  }

  for (const [file, content] of manifests) {
    if (fileName(file).toLowerCase() !== "go.mod") continue;
    const root = normalizeDir(file);
    for (const required of parseGoRequires(content)) {
      const targetRoot = rootByModuleName.get(required);
      if (targetRoot) addReference(references, seenReferences, root, targetRoot, "module", required);
    }
    for (const replacement of parseGoReplaceTargets(content)) {
      if (replacement.targetPath?.startsWith(".")) {
        const resolved = joinPosix(root === "." ? "" : root, normalizeGraphPath(replacement.targetPath));
        const targetRoot = resolved ? normalizeGraphPath(resolved) || "." : undefined;
        if (targetRoot && projects.has(targetRoot)) addReference(references, seenReferences, root, targetRoot, "module", replacement.targetPath);
        continue;
      }
      const targetRoot = replacement.modulePath ? rootByModuleName.get(replacement.modulePath) : undefined;
      if (targetRoot) addReference(references, seenReferences, root, targetRoot, "module", replacement.modulePath);
    }
  }
}

export function buildProjectTopology(files: readonly TopologySourceFile[]): ProjectTopology {
  const manifests = new Map<string, string>();
  for (const file of files) {
    const normalized = normalizeGraphPath(file.path);
    if (!normalized || manifests.has(normalized)) continue;
    manifests.set(normalized, file.content);
  }

  const projects = new Map<string, MutableProjectNode>();
  const references: ProjectReference[] = [];
  const seenReferences = new Set<string>();

  addDotnetTopology(manifests, projects, references, seenReferences);
  addNpmTopology(manifests, projects, references, seenReferences);
  addMavenTopology(manifests, projects, references, seenReferences);
  addGradleTopology(manifests, projects, references, seenReferences);
  addGoTopology(manifests, projects, references, seenReferences);

  return {
    projects: [...projects.values()].sort((a, b) => a.root.localeCompare(b.root)).map((project) => ({
      ...project,
      manifestFiles: [...project.manifestFiles].sort(),
    })),
    references: references.sort((a, b) =>
      a.from.localeCompare(b.from)
      || a.to.localeCompare(b.to)
      || a.kind.localeCompare(b.kind),
    ),
  };
}

export function owningProjectForPath(topology: ProjectTopology | null | undefined, filePath: string): ProjectNode | null {
  if (!topology || topology.projects.length === 0) return null;
  const normalized = normalizeGraphPath(filePath) || ".";
  let best: ProjectNode | null = null;
  for (const project of topology.projects) {
    if (project.root === ".") {
      if (best === null) best = project;
      continue;
    }
    if (normalized === project.root || normalized.startsWith(`${project.root}/`)) {
      if (best === null || project.root.length > best.root.length) best = project;
    }
  }
  return best;
}

export function buildProjectReferenceMap(topology: ProjectTopology | null | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!topology) return out;
  for (const ref of topology.references) {
    const set = out.get(ref.from) ?? new Set<string>();
    set.add(ref.to);
    out.set(ref.from, set);
  }
  return out;
}

export function shareContainer(a: ProjectNode | null | undefined, b: ProjectNode | null | undefined): boolean {
  return Boolean(a?.containerRoot && b?.containerRoot && a.containerRoot === b.containerRoot);
}
