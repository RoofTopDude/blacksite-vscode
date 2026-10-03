export type { ProjectVerdict, Recommendation, RecommendationIntent, SetupReport, ToolchainOverview, VerdictItem, VerdictKind } from "./setup-types.js";

/* From "what the projects need" and "what this machine has" to a short list of recommendations,
   least work first, each with the evidence behind it.

   ── How it decides ──────────────────────────────────────────────────────────
   Per toolchain across every project first: an install already on the machine that satisfies most
   projects is reused, and only the projects it does not satisfy get a project-scoped install. A
   system install is suggested only when nothing installed covers the majority (or nothing is
   installed at all). Go (1.21+) and rustup fetch a project's pinned version on their own, so a
   project pinning another version of either needs nothing.

   Then per project: a Python project with no environment gets one, made from an interpreter that
   satisfies it; dependency installs follow; missing editor extensions are one click.

   Pre-selection is conservative: system and prerequisite steps that something needs, the projects
   in play, and the editor extensions. Everything else is listed and left for the user to tick, so
   a window with twenty codebases does not start twenty installs because the user said yes once.

   Pure: no `vscode`, no disk reads, no network. */

import path from "path";
import type { MachineInventory } from "./inventory.js";
import { javaMajor, TOOLCHAIN_EXTENSIONS, type ProjectNeeds, type Requirement } from "./project-needs.js";
import type {
  Evidence, ProjectVerdict, Recommendation, RecommendationIntent, SetupReport, Toolchain, ToolchainInstall, ToolchainOverview,
} from "./setup-types.js";
import { isEndOfLife, systemInstallBlocker, VERSION_LINES, type Platform } from "./recipes.js";
import { compareVersions, isUnconstrained, parseVersion, pickVersion, satisfies } from "./version-spec.js";

export interface AdviseInput {
  projects: readonly ProjectNeeds[];
  inventory: MachineInventory | undefined;
  platform: Platform;
  /** Extension ids installed in this VS Code (lower-cased). */
  installedExtensions: ReadonlySet<string>;
  /** Absolute paths of the files the user and the agent are working in. */
  inPlayFiles: readonly string[];
  truncated?: boolean;
}

/** Comparable version for an install: Java "1.8.0_401" is 8. */
function installVersion(toolchain: Toolchain, install: ToolchainInstall): string | undefined {
  if (!install.version) return undefined;
  return toolchain === "Java" ? javaMajor(install.version) : install.version;
}

function evidenceText(evidence: Evidence | undefined): string {
  return evidence ? ` (${evidence.file}${evidence.line ? `:${evidence.line}` : ""})` : "";
}

function describeInstall(install: ToolchainInstall): string {
  return `${install.version ?? "unknown version"} (${install.source === "PATH" ? install.command : install.source}, ${install.path})`;
}

function isInPlay(project: ProjectNeeds, files: readonly string[]): boolean {
  return files.some((file) => {
    const rel = path.relative(project.dir, file);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}

/** Newest first. */
function byNewest(toolchain: Toolchain): (a: ToolchainInstall, b: ToolchainInstall) => number {
  return (a, b) => compareVersions(parseVersion(installVersion(toolchain, b) ?? "") ?? [], parseVersion(installVersion(toolchain, a) ?? "") ?? []);
}

export function advise(input: AdviseInput): SetupReport {
  const { projects, inventory, platform } = input;
  const installs = inventory?.installs ?? [];
  const managers = inventory?.managers ?? [];
  const env = { platform, managers };
  const verdicts = new Map<ProjectNeeds, ProjectVerdict>();
  for (const project of projects) {
    verdicts.set(project, {
      dir: project.dir, display: project.display, inPlay: isInPlay(project, input.inPlayFiles),
      needsAttention: false, toolchains: project.toolchains, items: [],
    });
  }
  const anyInPlay = [...verdicts.values()].some((verdict) => verdict.inPlay);
  /** Pre-select per-project work only where the user is working, or in a small workspace. */
  const preselect = (project: ProjectNeeds): boolean => verdicts.get(project)!.inPlay || (!anyInPlay && projects.length <= 3);
  const recommendations: Recommendation[] = [];
  const overviews: ToolchainOverview[] = [];
  const add = (recommendation: Recommendation): Recommendation => {
    const existing = recommendations.find((candidate) => candidate.id === recommendation.id);
    if (existing) {
      existing.projects = [...new Set([...existing.projects, ...recommendation.projects])];
      existing.selected ||= recommendation.selected;
      return existing;
    }
    recommendations.push(recommendation);
    return recommendation;
  };
  const requirementOf = (project: ProjectNeeds, toolchain: Toolchain): Requirement | undefined =>
    project.requirements.find((requirement) => requirement.toolchain === toolchain);

  // Projects each toolchain's chosen system install will satisfy, so per-project steps can depend on it.
  const systemRecommendation = new Map<Toolchain, Recommendation>();

  for (const toolchain of ["Python", "Node", "Java", "Go", ".NET", "Rust", "C/C++"] as Toolchain[]) {
    const needing = projects.filter((project) => project.toolchains.includes(toolchain));
    if (needing.length === 0) continue;
    const available = installs.filter((install) => install.toolchain === toolchain).sort(byNewest(toolchain));
    const pathFirst = available.find((install) => install.source === "PATH");
    const counted = available.map((install) => ({
      ...install,
      satisfiesCount: needing.filter((project) => {
        const requirement = requirementOf(project, toolchain);
        return !requirement || satisfies(installVersion(toolchain, install), requirement.spec) === true;
      }).length,
      endOfLife: isEndOfLife(toolchain, installVersion(toolchain, install)),
    }));

    // Go 1.21+ and rustup fetch whatever version a project pins; any working install is enough.
    const autoFetch = (toolchain === "Go" && available.some((install) => satisfies(install.version, { raw: ">=1.21", anyOf: [[{ op: ">=", version: [1, 21] }]] })))
      || (toolchain === "Rust" && managers.includes("rustup") && available.length > 0);

    const unsatisfied: ProjectNeeds[] = [];
    for (const project of needing) {
      const verdict = verdicts.get(project)!;
      const requirement = requirementOf(project, toolchain);
      const evidence = requirement?.evidence;
      const wanted = requirement && !isUnconstrained(requirement.spec) ? ` ${requirement.spec.raw}` : "";
      if (available.length === 0) {
        verdict.items.push({ kind: "missing", toolchain, message: `Needs ${toolchain}${wanted}; it is not installed.`, evidence });
        unsatisfied.push(project);
        continue;
      }
      if (autoFetch) {
        const direct = !requirement || available.some((install) => satisfies(install.version, requirement.spec) === true);
        verdict.items.push(direct
          ? { kind: "ok", toolchain, message: `${toolchain}${wanted || ""}: ${describeInstall(available[0]!)}.`, evidence, install: available[0] }
          : { kind: "auto", toolchain, message: `Asks for ${toolchain}${wanted}; ${toolchain === "Go" ? "Go" : "rustup"} downloads that version by itself on the first build.`, evidence });
        continue;
      }
      if (!requirement || isUnconstrained(requirement.spec)) {
        const chosen = pathFirst ?? available[0]!;
        verdict.items.push({ kind: "ok", toolchain, message: `${toolchain}: ${describeInstall(chosen)}. The project does not ask for a version.`, install: chosen });
        continue;
      }
      const satisfying = available.filter((install) => satisfies(installVersion(toolchain, install), requirement.spec) === true);
      if (pathFirst && satisfying.includes(pathFirst)) {
        verdict.items.push({ kind: "ok", toolchain, message: `Asks for ${toolchain}${wanted}; ${describeInstall(pathFirst)} satisfies it.`, evidence, install: pathFirst });
      } else if (satisfying.length > 0) {
        const other = satisfying[0]!;
        verdict.items.push({
          kind: "use_other", toolchain, evidence, install: other,
          message: `Asks for ${toolchain}${wanted}. The copy first on PATH (${pathFirst ? describeInstall(pathFirst) : "none"}) does not satisfy it, but ${describeInstall(other)} does — use that one${toolchain === "Python" ? " (its environment is made from it)" : ""}.`,
        });
        if (toolchain !== "Python") verdict.needsAttention = true;
      } else {
        verdict.items.push({ kind: "too_old", toolchain, message: `Asks for ${toolchain}${wanted}; installed: ${available.map(describeInstall).join(", ")}. None satisfies it.`, evidence });
        unsatisfied.push(project);
      }
      const used = satisfying[0] ?? pathFirst;
      if (used && isEndOfLife(toolchain, installVersion(toolchain, used))) {
        verdict.items.push({ kind: "eol", toolchain, message: `${toolchain} ${installVersion(toolchain, used)} is past its end of life; it still works, but no longer gets security fixes.` });
      }
    }
    for (const project of unsatisfied) verdicts.get(project)!.needsAttention = true;

    const lines = VERSION_LINES[toolchain] ?? [];
    let systemPick: Recommendation | undefined;
    const majoritySatisfied = counted.some((install) => install.satisfiesCount * 2 >= needing.length);
    if (unsatisfied.length > 0 && (!majoritySatisfied || available.length === 0)) {
      // Nothing installed covers most projects: one system install of the line that suits the most.
      const candidates = lines.length > 0 ? lines : ["latest"];
      let best = candidates[0]!;
      let bestCount = -1;
      for (const candidate of candidates) {
        const count = unsatisfied.filter((project) => {
          const requirement = requirementOf(project, toolchain);
          return !requirement || satisfies(candidate, requirement.spec) !== false;
        }).length;
        if (count > bestCount) { best = candidate; bestCount = count; }
      }
      const helped = unsatisfied.filter((project) => {
        const requirement = requirementOf(project, toolchain);
        return !requirement || satisfies(best, requirement.spec) !== false;
      });
      const blocked = systemInstallBlocker(toolchain, env);
      systemPick = add({
        id: `system-${toolchain}`,
        title: best === "latest" ? `Install ${toolchain}` : `Install ${toolchain} ${best}`,
        why: available.length === 0
          ? `${needing.length} project${needing.length === 1 ? " needs" : "s need"} ${toolchain} and it is not installed. One install for your machine covers ${helped.length === needing.length ? "all of them" : `${helped.length} of them`}.`
          : `None of the installed versions satisfies most of the projects that use ${toolchain}; ${best} satisfies ${helped.length} of the ${unsatisfied.length} that are not covered.`,
        selected: !blocked,
        intent: { kind: "system", toolchain, version: best },
        projects: helped.map((project) => project.display),
        toolchain,
        blocked,
      });
      systemRecommendation.set(toolchain, systemPick);
      unsatisfied.splice(0, unsatisfied.length, ...unsatisfied.filter((project) => !helped.includes(project)));
    }

    // Outliers: projects the reused (or newly installed) version does not satisfy get their own copy.
    for (const project of unsatisfied) {
      const requirement = requirementOf(project, toolchain);
      if (!requirement) continue;
      const version = pickVersion(requirement.spec, lines);
      if (!version) continue;
      if (toolchain === "Node" || toolchain === "Java" || toolchain === ".NET") {
        add({
          id: `project-${toolchain}-${project.display}`,
          title: `${toolchain} ${version} for ${project.display} only`,
          why: `This project asks for ${toolchain} ${requirement.spec.raw}${evidenceText(requirement.evidence)}, unlike the others. A copy inside the project leaves your machine's ${toolchain} alone.`,
          selected: preselect(project),
          intent: { kind: "project_toolchain", toolchain, version, project: project.display },
          projects: [project.display],
          toolchain,
        });
      } else if (toolchain === "Python") {
        // Handled with the project's environment below: uv fetches the version it needs.
      } else {
        const blocked = systemInstallBlocker(toolchain, env);
        add({
          id: `system-${toolchain}-${version}`,
          title: `Install ${toolchain} ${version}`,
          why: `${project.display} asks for ${toolchain} ${requirement.spec.raw}${evidenceText(requirement.evidence)} and ${toolchain} has no per-project install; this installs that version for your machine.`,
          selected: false, intent: { kind: "system", toolchain, version }, projects: [project.display], toolchain, blocked,
        });
      }
    }

    const latest = lines[0];
    const satisfiedCount = needing.length - needing.filter((project) => verdicts.get(project)!.items.some((item) => item.toolchain === toolchain && (item.kind === "missing" || item.kind === "too_old"))).length;
    overviews.push({
      toolchain,
      projectCount: needing.length,
      installs: counted,
      unsatisfied: needing.filter((project) => verdicts.get(project)!.items.some((item) => item.toolchain === toolchain && (item.kind === "missing" || item.kind === "too_old"))).map((project) => project.display),
      latest,
      summary: available.length === 0
        ? `${toolchain}: needed by ${needing.length} project${needing.length === 1 ? "" : "s"}; not installed.`
        : `${toolchain}: needed by ${needing.length} project${needing.length === 1 ? "" : "s"}; what is installed satisfies ${satisfiedCount}.`,
    });

    // Editor support for the language.
    const extension = TOOLCHAIN_EXTENSIONS[toolchain];
    if (extension && !input.installedExtensions.has(extension.toLowerCase())) {
      add({
        id: `extension-${extension}`, title: `Install the ${extension} extension`,
        why: `Gives VS Code (and the agent's diagnostics) real ${toolchain} support: errors, go-to-definition, symbols.`,
        selected: true, intent: { kind: "extension", id: extension }, projects: needing.map((project) => project.display), toolchain,
      });
      for (const project of needing) verdicts.get(project)!.items.push({ kind: "extension", toolchain, message: `The ${extension} extension is not installed, so VS Code has no ${toolchain} language support here.` });
    }
  }

  // Python environments, then each project's dependencies.
  const pythons = installs.filter((install) => install.toolchain === "Python").sort(byNewest("Python"));
  for (const project of projects) {
    const verdict = verdicts.get(project)!;
    if (project.toolchains.includes("Python") && !project.venv) {
      const usesTool = project.dependencies.find((step) => step.toolchain === "Python" && (step.argv[0] === "uv" || step.argv[0] === "poetry" || step.argv[0] === "pipenv"));
      if (!usesTool) {
        const requirement = requirementOf(project, "Python");
        const fit = pythons.find((install) => !requirement || satisfies(install.version, requirement.spec) === true);
        const version = fit?.version ?? (requirement ? pickVersion(requirement.spec, VERSION_LINES.Python ?? []) : VERSION_LINES.Python?.[0]) ?? "3.12";
        const needsUv = !fit;
        const needs: string[] = [];
        if (needsUv && !managers.includes("uv")) {
          add({ id: "tool-uv", title: "Install uv", why: "uv fetches Python versions this machine does not have and builds environments from them, without changing your system Python.", selected: preselect(project), intent: { kind: "tool", tool: "uv" }, projects: [project.display] });
          needs.push("tool-uv");
        }
        verdict.items.push({ kind: "no_env", toolchain: "Python", message: `No virtual environment in the project${fit ? `; one can be made from ${describeInstall(fit)}` : `; uv can fetch Python ${version} for it`}.` });
        verdict.needsAttention = true;
        add({
          id: `venv-${project.display}`,
          title: `Create .venv in ${project.display}`,
          why: fit
            ? `Gives the project its own packages, made from Python ${fit.version} which satisfies it${requirement ? evidenceText(requirement.evidence) : ""}. The agent's python, pytest and pip in this project then use it.`
            : `No installed Python satisfies ${requirement?.spec.raw ?? "this project"}${requirement ? evidenceText(requirement.evidence) : ""}; uv fetches ${version} into its own cache and the environment is made from it.`,
          selected: preselect(project),
          intent: { kind: "venv", project: project.display, interpreter: fit?.path, version: (fit?.version ?? version) },
          projects: [project.display], toolchain: "Python", needs,
        });
      }
    }

    for (const step of project.dependencies) {
      if (step.installed === false) {
        verdict.items.push({ kind: "info", toolchain: step.toolchain, message: `Dependencies are not installed yet (${step.evidence.file}).`, evidence: step.evidence });
        verdict.needsAttention = true;
      }
      const tool = step.argv[0];
      const needs: string[] = [];
      const toolKind = tool === "uv" || tool === "poetry" || tool === "pipenv" || tool === "pnpm" || tool === "yarn" ? tool : undefined;
      if (toolKind && !managers.includes(toolKind)) {
        add({
          id: `tool-${toolKind}`, title: `Install ${toolKind}`,
          why: `${project.display} manages its dependencies with ${toolKind}${evidenceText(step.evidence)}.`,
          selected: preselect(project), intent: { kind: "tool", tool: toolKind }, projects: [project.display],
        });
        needs.push(`tool-${toolKind}`);
      }
      const system = step.toolchain ? systemRecommendation.get(step.toolchain) : undefined;
      if (system) needs.push(system.id);
      if (step.argv[0] === "python") needs.push(`venv-${project.display}`);
      add({
        id: `deps-${project.display}-${step.argv[0]}`, title: `${step.label} (${project.display})`,
        why: `Installs what ${project.display} depends on, from ${step.evidence.file}, so the agent can run its tests and builds. Native build failures show up now instead of mid-task.`,
        selected: preselect(project) && step.installed !== true && verdict.needsAttention,
        intent: { kind: "deps", project: project.display, argv: step.argv, label: step.label },
        projects: [project.display], toolchain: step.toolchain, needs,
      });
    }

    for (const extension of project.recommendedExtensions) {
      if (input.installedExtensions.has(extension.toLowerCase())) continue;
      add({
        id: `extension-${extension}`, title: `Install the ${extension} extension`,
        why: "The repository recommends it in .vscode/extensions.json.",
        selected: false, intent: { kind: "extension", id: extension }, projects: [project.display],
      });
    }
  }

  // Many Python projects in one folder: VS Code analyses them all with one interpreter.
  const pythonProjects = projects.filter((project) => project.toolchains.includes("Python"));
  const folders = new Set(pythonProjects.map((project) => project.workspaceFolder));
  if (pythonProjects.length >= 3 && folders.size === 1) {
    const inPlay = pythonProjects.filter((project) => verdicts.get(project)!.inPlay && project.dir !== project.workspaceFolder);
    if (inPlay.length > 0) {
      add({
        id: "workspace-folders",
        title: `Open ${inPlay.length === 1 ? inPlay[0]!.display : `${inPlay.length} projects`} as workspace folders`,
        why: `${pythonProjects.length} Python projects share one workspace folder, so VS Code checks them all with a single interpreter and reports imports from the others' environments as errors that are not real. As separate workspace folders, each project gets its own interpreter. This changes your window into a multi-root workspace.`,
        selected: false,
        intent: { kind: "workspace_folders", projects: inPlay.map((project) => project.display) },
        projects: inPlay.map((project) => project.display),
      });
    }
  }

  // Run order: prerequisites, system installs, project toolchains and environments, dependencies, editor.
  const order: Record<RecommendationIntent["kind"], number> = { tool: 0, system: 1, project_toolchain: 2, venv: 3, deps: 4, extension: 5, workspace_folders: 6 };
  recommendations.sort((a, b) => order[a.intent.kind] - order[b.intent.kind]);
  for (const verdict of verdicts.values()) {
    if (verdict.items.some((item) => item.kind === "missing" || item.kind === "too_old" || item.kind === "no_env" || item.kind === "extension")) verdict.needsAttention = true;
  }
  return { projects: [...verdicts.values()], toolchains: overviews, recommendations, truncated: !!input.truncated };
}

const MAX_REQUIREMENT_LINES = 4;

/**
 * For the agent's per-turn context: the versions the projects in play ask for, and whether this
 * machine has one that fits. Lets the agent pick the right interpreter or SDK first time, and say
 * plainly when nothing installed fits instead of fighting the mismatch.
 */
export function requirementSummary(projects: readonly ProjectNeeds[], inventory: MachineInventory | undefined): string[] {
  const lines: string[] = [];
  for (const project of projects) {
    for (const requirement of project.requirements) {
      if (isUnconstrained(requirement.spec)) continue;
      const installs = (inventory?.installs ?? []).filter((install) => install.toolchain === requirement.toolchain).sort(byNewest(requirement.toolchain));
      const fit = installs.find((install) => satisfies(installVersion(requirement.toolchain, install), requirement.spec) === true);
      const where = `${requirement.evidence.file}${requirement.evidence.line ? `:${requirement.evidence.line}` : ""}`;
      const autoFetch = requirement.toolchain === "Go" || (requirement.toolchain === "Rust" && (inventory?.managers ?? []).includes("rustup"));
      const verdict = fit
        ? `${fit.version} at ${fit.path} fits`
        : installs.length === 0
          ? "not installed"
          : autoFetch
            ? `${requirement.toolchain === "Go" ? "go" : "rustup"} fetches it on first build`
            : `nothing installed fits (have ${installs.map((install) => install.version ?? "?").join(", ")}); tell the user — Settings › Project setup can install it`;
      lines.push(`- Project ${project.display} asks for ${requirement.toolchain} ${requirement.spec.raw} (${where}): ${verdict}`);
      if (lines.length >= MAX_REQUIREMENT_LINES) return lines;
    }
  }
  return lines;
}
