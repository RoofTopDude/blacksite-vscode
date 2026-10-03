/* The user's ticked recommendations, turned into the ordered steps the setup script runs, plus the
   editor-side actions (extensions, workspace folders) the extension does itself.

   Anything a ticked item needs is added even if unticked — creating an environment with uv needs
   uv — and listed in `added` so the review step can say so. A recommendation that cannot be built
   (no recipe on this platform, an archive that could not be resolved) becomes a `problem` in plain
   words instead of a silent gap. */

import type { ProjectNeeds } from "./project-needs.js";
import {
  archiveInstall, dependencyInstall, dotnetProjectInstall, managerPrerequisite, systemInstall, toolInstall, venvFromInterpreter, venvWithUv,
  type InstallStep, type Platform, type ResolvedArchive,
} from "./recipes.js";
import type { Recommendation, SetupReport } from "./setup-types.js";

export interface PlanContext {
  platform: Platform;
  arch: string;
  managers: readonly string[];
  projects: readonly ProjectNeeds[];
  resolveNode(major: string): Promise<ResolvedArchive>;
  resolveTemurin(feature: string): Promise<ResolvedArchive>;
}

export interface InstallPlan {
  steps: InstallStep[];
  extensions: string[];
  /** Absolute project directories to add as workspace folders. */
  workspaceFolders: string[];
  problems: string[];
  /** Recommendations included because a ticked one needs them. */
  added: string[];
}

/** Ids reach the script inside quotes and a JSON result: keep them to a safe alphabet. */
function safeId(id: string): string {
  return id.replace(/[^\w./-]/g, "_");
}

function withNeeds(report: SetupReport, selected: ReadonlySet<string>): { chosen: Recommendation[]; added: string[] } {
  const byId = new Map(report.recommendations.map((recommendation) => [recommendation.id, recommendation]));
  const chosen = new Set<string>();
  const added: string[] = [];
  const visit = (id: string, explicit: boolean): void => {
    if (chosen.has(id)) return;
    const recommendation = byId.get(id);
    if (!recommendation || recommendation.blocked) return;
    chosen.add(id);
    if (!explicit) added.push(recommendation.title);
    for (const need of recommendation.needs ?? []) visit(need, false);
  };
  for (const id of selected) visit(id, true);
  // Keep the advisor's run order.
  return { chosen: report.recommendations.filter((recommendation) => chosen.has(recommendation.id)), added };
}

export async function buildInstallPlan(report: SetupReport, selected: ReadonlySet<string>, ctx: PlanContext): Promise<InstallPlan> {
  const env = { platform: ctx.platform, managers: ctx.managers };
  const { chosen, added } = withNeeds(report, selected);
  const plan: InstallPlan = { steps: [], extensions: [], workspaceFolders: [], problems: [], added };
  const projectByDisplay = new Map(ctx.projects.map((project) => [project.display, project]));
  const push = (step: InstallStep | undefined, what: string): void => {
    if (step) plan.steps.push({ ...step, id: safeId(step.id) });
    else plan.problems.push(`${what}: no install recipe applies on this machine.`);
  };

  const needsManager = chosen.some((recommendation) => recommendation.intent.kind === "system");
  if (needsManager) {
    const prerequisite = managerPrerequisite(env);
    if (prerequisite) plan.steps.push(prerequisite);
  }

  for (const recommendation of chosen) {
    const intent = recommendation.intent;
    switch (intent.kind) {
      case "tool":
        push(toolInstall(intent.tool, env), recommendation.title);
        break;
      case "system":
        push(systemInstall(intent.toolchain, intent.version, env), recommendation.title);
        break;
      case "project_toolchain": {
        const project = projectByDisplay.get(intent.project);
        if (!project) { plan.problems.push(`${recommendation.title}: the project is no longer in the workspace.`); break; }
        try {
          if (intent.toolchain === ".NET") push(dotnetProjectInstall(project, intent.version, env), recommendation.title);
          else {
            const major = intent.version.split(".")[0]!;
            const archive = intent.toolchain === "Node" ? await ctx.resolveNode(major) : await ctx.resolveTemurin(major);
            push(archiveInstall(intent.toolchain, project, archive), recommendation.title);
          }
        } catch (error) {
          plan.problems.push(`${recommendation.title}: could not look up the download (${error instanceof Error ? error.message : String(error)}). Check your connection and try again.`);
        }
        break;
      }
      case "venv": {
        const project = projectByDisplay.get(intent.project);
        if (!project) { plan.problems.push(`${recommendation.title}: the project is no longer in the workspace.`); break; }
        const mm = intent.version.split(".").slice(0, 2).join(".");
        push(intent.interpreter ? venvFromInterpreter(project, intent.interpreter, intent.version) : venvWithUv(project, mm), recommendation.title);
        break;
      }
      case "deps": {
        const project = projectByDisplay.get(intent.project);
        if (!project) { plan.problems.push(`${recommendation.title}: the project is no longer in the workspace.`); break; }
        push(dependencyInstall(project, intent.argv, intent.label, ctx.platform), recommendation.title);
        break;
      }
      case "extension":
        plan.extensions.push(intent.id);
        break;
      case "workspace_folders":
        for (const display of intent.projects) {
          const project = projectByDisplay.get(display);
          if (project) plan.workspaceFolders.push(project.dir);
        }
        break;
    }
  }
  return plan;
}
