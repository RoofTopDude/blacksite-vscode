import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillStore } from "../../src/skills/skill-store.js";
import { SkillToolProvider } from "../../src/skills/skill-tools.js";

let root: string;
let bundledDir: string;
let homeDir: string;
let store: SkillStore;
let capabilities: Set<string>;
let changed: number;
let provider: SkillToolProvider;

function writeSkill(dir: string, name: string, frontmatter: string, body = "# Body\n\nThe procedure."): void {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

const DESC = "description: Does the thing. Use when the thing needs doing.";
const ctx = (loaded: string[] = []) => ({ sessionId: "s1", loaded });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bs-skilltools-"));
  bundledDir = path.join(root, "bundled");
  homeDir = path.join(root, "home");
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".blacksite", "skills"), { recursive: true });
  store = new SkillStore(root, bundledDir, homeDir);
  capabilities = new Set<string>();
  changed = 0;
  provider = new SkillToolProvider(store, () => capabilities, () => { changed += 1; });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("skill_read", () => {
  beforeEach(() => {
    writeSkill(bundledDir, "alpha", `name: alpha\n${DESC}`, "# Alpha\n\nStep one.");
  });

  /* The body is handed to AgentSession through loadedBody so it can live in the durable
     tail block. Returning it as the tool result *as well* would put two copies in context,
     and the tool-result copy is the one compaction drops — exactly when a long run most
     needs the procedure it is following. */
  it("returns the body out-of-band for the tail, not inside the tool result", async () => {
    const result = await provider.dispatch("read", { name: "alpha" }, ctx());

    expect(result.ok).toBe(true);
    expect(result.loaded).toBe(true);
    expect(result.loadedBody).toEqual({ name: "alpha", markdown: "# Alpha\n\nStep one." });

    const { loadedBody: _loadedBody, ...visible } = result;
    expect(JSON.stringify(visible)).not.toContain("Step one.");
  });

  it("does not re-load a skill already in context", async () => {
    const result = await provider.dispatch("read", { name: "alpha" }, ctx(["alpha"]));

    expect(result.ok).toBe(true);
    expect(result.alreadyLoaded).toBe(true);
    expect(result.loadedBody).toBeUndefined();
  });

  it("names the available skills when the name is unknown", async () => {
    const result = await provider.dispatch("read", { name: "nope" }, ctx());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("alpha");
  });

  // The roster is a hint the model may act on a turn late, so availability is enforced at
  // dispatch too — a disabled or unsatisfiable skill must not load regardless.
  it("refuses a skill whose requirement is unmet", async () => {
    writeSkill(bundledDir, "needs-db", `name: needs-db\n${DESC}\nrequires: ["db"]`);
    store.invalidate();

    const blocked = await provider.dispatch("read", { name: "needs-db" }, ctx());
    expect(blocked.ok).toBe(false);
    expect(String(blocked.error)).toContain("db");

    capabilities.add("db");
    const allowed = await provider.dispatch("read", { name: "needs-db" }, ctx());
    expect(allowed.ok).toBe(true);
  });

  it("refuses a disabled skill", async () => {
    store.setEnabled("alpha", false);
    const result = await provider.dispatch("read", { name: "alpha" }, ctx());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("disabled");
  });

  it("serves a bundled reference file inline, without marking the skill loaded", async () => {
    fs.mkdirSync(path.join(bundledDir, "alpha", "reference"), { recursive: true });
    fs.writeFileSync(path.join(bundledDir, "alpha", "reference", "detail.md"), "deep detail", "utf8");
    store.invalidate();

    const result = await provider.dispatch("read", { name: "alpha", file: "reference/detail.md" }, ctx());

    expect(result.ok).toBe(true);
    expect(result.content).toBe("deep detail");
    expect(result.loadedBody).toBeUndefined();
  });

  it("refuses a file outside the skill directory", async () => {
    fs.writeFileSync(path.join(root, "secret.txt"), "nope", "utf8");
    const result = await provider.dispatch("read", { name: "alpha", file: "reference/../../secret.txt" }, ctx());
    expect(result.ok).toBe(false);
  });
});

describe("skill_write", () => {
  const valid = `---\nname: new-skill\ndescription: Captures a procedure. Use when it recurs.\n---\n\n# Body\n\nSteps.\n`;

  it("writes a workspace skill and notifies the host", async () => {
    const result = await provider.dispatch("write", { name: "new-skill", markdown: valid }, ctx());

    expect(result.ok).toBe(true);
    expect(result.path).toBe(".blacksite/skills/new-skill/SKILL.md");
    expect(changed).toBe(1);
    expect(store.find("new-skill")!.origin).toBe("workspace");
  });

  it("reports the specific field when validation fails, and writes nothing", async () => {
    const result = await provider.dispatch(
      "write",
      { name: "broken", markdown: `---\nname: broken\n---\n\nNo description.\n` },
      ctx(),
    );

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("description");
    expect(changed).toBe(0);
    expect(store.find("broken")).toBeNull();
  });

  // ~/.blacksite/skills is the user's private space. The agent shadowing a bundled skill is
  // fine; quietly rewriting something the user wrote for themselves is not.
  it("refuses to touch a personal skill", async () => {
    writeSkill(path.join(homeDir, ".blacksite", "skills"), "mine", `name: mine\n${DESC}`);
    store.invalidate();

    const result = await provider.dispatch("write", { name: "mine", markdown: valid }, ctx());

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("personal");
    expect(changed).toBe(0);
  });

  it("says so when a write shadows a bundled skill instead of editing it", async () => {
    writeSkill(bundledDir, "shared", `name: shared\ndescription: Bundled. Use when testing.`);
    store.invalidate();

    const result = await provider.dispatch(
      "write",
      { name: "shared", markdown: `---\nname: shared\ndescription: Ours. Use when testing.\n---\n\n# Body\n\nSteps.\n` },
      ctx(),
    );

    expect(result.ok).toBe(true);
    expect(String(result.note)).toContain("shadows");
  });
});

describe("skill_list", () => {
  it("reports availability, origin, and load state for every skill", async () => {
    writeSkill(bundledDir, "alpha", `name: alpha\n${DESC}`);
    writeSkill(bundledDir, "needs-db", `name: needs-db\n${DESC}\nrequires: ["db"]`);
    store.invalidate();

    const result = await provider.dispatch("list", {}, ctx(["alpha"]));
    const skills = result.skills as Array<Record<string, unknown>>;

    expect(result.total).toBe(2);
    expect(skills.find((s) => s.name === "alpha")).toMatchObject({ available: true, loaded: true, origin: "bundled" });
    expect(skills.find((s) => s.name === "needs-db")).toMatchObject({ available: false, loaded: false });
  });
});

describe("unknown operations", () => {
  it("answers with an error rather than throwing", async () => {
    const result = await provider.dispatch("delete", {}, ctx());
    expect(result.ok).toBe(false);
  });
});
