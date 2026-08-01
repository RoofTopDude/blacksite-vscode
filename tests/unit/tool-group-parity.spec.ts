/* The settings panel's tool toggles are driven by a hand-maintained TOOL_GROUPS list
   in the webview, while the agent's actual catalog lives in src/tools/definitions.ts.
   Nothing structural keeps the two in step: a tool missing from TOOL_GROUPS is simply
   invisible in settings and can never be turned off (which is how the whole Codebase
   Map family went untoggleable), and a stale name there renders a switch that disables
   nothing. Assert the correspondence instead of relying on whoever adds the next tool
   remembering both files. */

import { describe, expect, it } from "vitest";
import { ALL_TOOL_NAMES, TOOL_GROUPS, TOOL_LABELS } from "../../src/webview/react/lib/format.js";
import { toolIconCategory } from "../../src/webview/react/lib/tool-icons.js";
import { ALL_TOOLS, UI_TOOLS } from "../../src/tools/definitions.js";

/** UI_TOOLS are appended after the disabled-tool filter in AgentSession._getTools() —
    deliberately always on, so they have no switch. Derived from the catalog rather than listed by
    hand: this file exists because hand-maintained mirrors of the tool list drift, and a literal
    here would be one more of them. */
const ALWAYS_ON_TOOLS = new Set(UI_TOOLS.map((tool) => tool.name));

const definedNames = new Set(ALL_TOOLS.map((tool) => tool.name));

describe("settings tool groups ↔ tool catalog", () => {
  it("offers a toggle for every user-toggleable tool the agent can be given", () => {
    const missing = [...definedNames].filter((name) => !ALWAYS_ON_TOOLS.has(name) && !ALL_TOOL_NAMES.includes(name));
    expect(missing).toEqual([]);
  });

  it("has no group entry that doesn't name a real tool", () => {
    expect(ALL_TOOL_NAMES.filter((name) => !definedNames.has(name))).toEqual([]);
  });

  it("lists each tool in exactly one group", () => {
    const duplicates = ALL_TOOL_NAMES.filter((name, index) => ALL_TOOL_NAMES.indexOf(name) !== index);
    expect(duplicates).toEqual([]);
  });

  it("never labels a tool that doesn't exist", () => {
    /* Two legitimate non-catalog labels: the pre-split `<service>_op` names, still
       routable for back-compat (see LEGACY_TOOL_ROUTES) so old transcripts render,
       and "approval", which labels an approval card rather than a tool call. */
    const nonCatalogLabels = new Set([
      "github_op", "gitlab_op", "jira_op", "confluence_op", "salesforce_op", "approval",
    ]);
    const unknown = Object.keys(TOOL_LABELS).filter((name) => !definedNames.has(name) && !nonCatalogLabels.has(name));
    expect(unknown).toEqual([]);
  });

  /* The icon map is a third hand-maintained mirror of the catalog, and it fails quietly:
     an unlisted tool gets the generic wrench, which looks deliberate. That is how
     ticket_sweep ended up as the one ticket tool without the family's icon, and how the
     map_note_* tools ended up as the only Codebase Map tools without one. */
  it("gives every tool an icon rather than the generic fallback", () => {
    const generic = ALL_TOOLS
      .map((tool) => tool.name)
      .filter((name) => toolIconCategory(name) === "default");
    expect(generic).toEqual([]);
  });

  it("gives every group a label and at least one tool", () => {
    for (const group of TOOL_GROUPS) {
      expect(group.label.trim()).not.toBe("");
      expect(group.tools.length).toBeGreaterThan(0);
    }
  });
});
