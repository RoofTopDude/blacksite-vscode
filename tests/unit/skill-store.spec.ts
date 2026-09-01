import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillStore, buildSkillRoster, resolveSkillAvailability } from "../../src/skills/skill-store.js";

let root: string;
let bundledDir: string;
let homeDir: string;
let store: SkillStore;

function writeSkill(dir: string, name: string, frontmatter: string, body = "# Body\n\nSteps."): void {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bs-skills-"));
  bundledDir = path.join(root, "bundled");
  homeDir = path.join(root, "home");
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, ".blacksite", "skills"), { recursive: true });
  store = new SkillStore(root, bundledDir, homeDir);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const DESC = "description: Does the thing. Use when the thing needs doing.";

describe("SkillStore precedence", () => {
  // A repository's own procedure should beat a personal habit and a shipped default when
  // working in that repository — and the losing copies must stay visible, or an edit to the
  // wrong one looks like an edit that silently did nothing.
  it("lets workspace shadow user, and user shadow bundled", () => {
    writeSkill(bundledDir, "shared", `name: shared\ndescription: Bundled copy. Use when testing.`);
    writeSkill(path.join(homeDir, ".blacksite", "skills"), "shared", `name: shared\ndescription: User copy. Use when testing.`);
    writeSkill(path.join(root, ".blacksite", "skills"), "shared", `name: shared\ndescription: Workspace copy. Use when testing.`);

    const [record] = store.list();

    expect(record!.origin).toBe("workspace");
    expect(record!.description).toBe("Workspace copy. Use when testing.");
    expect(record!.shadows).toEqual(["user", "bundled"]);
  });

  it("keeps a bundled skill when nothing shadows it", () => {
    writeSkill(bundledDir, "solo", `name: solo\n${DESC}`);
    const [record] = store.list();
    expect(record!.origin).toBe("bundled");
    expect(record!.shadows).toEqual([]);
  });

  it("sorts by name so the roster is stable between turns", () => {
    writeSkill(bundledDir, "zebra", `name: zebra\n${DESC}`);
    writeSkill(bundledDir, "alpha", `name: alpha\n${DESC}`);
    expect(store.list().map((r) => r.name)).toEqual(["alpha", "zebra"]);
  });
});

describe("SkillStore.write", () => {
  it("writes into the workspace and reports shadowing a bundled skill", () => {
    writeSkill(bundledDir, "shared", `name: shared\ndescription: Bundled. Use when testing.`);

    const result = store.write("shared", `---\nname: shared\ndescription: Ours now. Use when testing.\n---\n\n# Body\n\nSteps.\n`);

    expect(result.shadowsBundled).toBe(true);
    expect(result.path).toBe(".blacksite/skills/shared/SKILL.md");
    expect(store.find("shared")!.origin).toBe("workspace");
    // The original must be untouched — a "write" that silently mutated the installed
    // extension would be lost on the next update and is not what was asked for.
    expect(fs.readFileSync(path.join(bundledDir, "shared", "SKILL.md"), "utf8")).toContain("Bundled.");
  });

  it("refuses a skill that fails validation, leaving nothing on disk", () => {
    expect(() => store.write("bad", `---\nname: bad\n---\n\nNo description.\n`)).toThrow(/description/);
    expect(fs.existsSync(path.join(root, ".blacksite", "skills", "bad"))).toBe(false);
  });

  it("only removes workspace skills", () => {
    writeSkill(bundledDir, "builtin", `name: builtin\n${DESC}`);
    writeSkill(path.join(root, ".blacksite", "skills"), "mine", `name: mine\n${DESC}`);

    expect(store.remove("builtin")).toBe(false);
    expect(store.remove("mine")).toBe(true);
    expect(store.find("mine")).toBeNull();
    expect(store.find("builtin")).not.toBeNull();
  });
});

describe("SkillStore enable state", () => {
  it("persists disabled names and reflects them on the record", () => {
    writeSkill(bundledDir, "toggle", `name: toggle\n${DESC}`);

    store.setEnabled("toggle", false);
    expect(store.find("toggle")!.enabled).toBe(false);

    // Read through a fresh store: the state must live on disk, not in the instance.
    expect(new SkillStore(root, bundledDir, homeDir).find("toggle")!.enabled).toBe(false);

    store.setEnabled("toggle", true);
    expect(store.find("toggle")!.enabled).toBe(true);
  });
});

describe("SkillStore.resolveAssetPath", () => {
  beforeEach(() => {
    writeSkill(bundledDir, "assets", `name: assets\n${DESC}`);
    fs.mkdirSync(path.join(bundledDir, "assets", "reference"), { recursive: true });
    fs.writeFileSync(path.join(bundledDir, "assets", "reference", "deep.md"), "detail", "utf8");
    fs.writeFileSync(path.join(root, "secret.txt"), "do not serve this", "utf8");
  });

  it("serves a file inside the skill's reference directory", () => {
    expect(store.readAsset("assets", "reference/deep.md")?.content).toBe("detail");
  });

  it("lists bundled files on the record", () => {
    expect(store.find("assets")!.files).toEqual(["reference/deep.md"]);
  });

  // A skill can arrive through a pull request, so its file paths are attacker-controlled.
  it("refuses traversal out of the skill directory", () => {
    expect(store.readAsset("assets", "reference/../../../secret.txt")).toBeNull();
    expect(store.readAsset("assets", "../secret.txt")).toBeNull();
  });

  it("refuses absolute paths and directories outside the asset dirs", () => {
    expect(store.readAsset("assets", path.join(root, "secret.txt"))).toBeNull();
    expect(store.readAsset("assets", "SKILL.md")).toBeNull();
  });
});

describe("skill availability", () => {
  const options = (capabilities: string[] = []) => ({
    capabilities: new Set(capabilities),
    loaded: [] as string[],
    focusFiles: [] as string[],
  });

  it("marks a skill unavailable when a required capability is missing", () => {
    writeSkill(bundledDir, "needs-db", `name: needs-db\n${DESC}\nrequires: ["db"]`);

    const [resolved] = resolveSkillAvailability(store.list(), options());
    expect(resolved!.available).toBe(false);
    expect(resolved!.reason).toContain("db");

    const [withDb] = resolveSkillAvailability(store.list(), options(["db"]));
    expect(withDb!.available).toBe(true);
  });

  it("marks a skill with a blocking lint error unavailable", () => {
    writeSkill(bundledDir, "broken", "name: broken", "");
    const [resolved] = resolveSkillAvailability(store.list(), options());
    expect(resolved!.available).toBe(false);
    expect(resolved!.reason).toContain("invalid");
  });

  it("reports the open file that a scope glob matched", () => {
    writeSkill(bundledDir, "scoped", `name: scoped\n${DESC}\nscope: ["src/**/*.ts"]`);
    const [resolved] = resolveSkillAvailability(store.list(), {
      ...options(),
      focusFiles: ["README.md", "src/app/main.ts"],
    });
    expect(resolved!.scopeMatch).toBe("src/app/main.ts");
  });
});

describe("buildSkillRoster", () => {
  const options = (overrides: Partial<{ capabilities: Set<string>; loaded: string[]; focusFiles: string[] }> = {}) => ({
    capabilities: new Set<string>(),
    loaded: [],
    focusFiles: [],
    ...overrides,
  });

  it("renders one line per skill with the full description", () => {
    writeSkill(bundledDir, "alpha", `name: alpha\ndescription: Does alpha work. Use when alpha is needed.`);
    const roster = buildSkillRoster(store.list(), options());
    expect(roster).toContain("alpha — Does alpha work. Use when alpha is needed.");
  });

  // An agent that cannot see why a capability is missing keeps reaching for it — the same
  // reason unconfigured integrations are reported rather than silently omitted.
  it("keeps unavailable skills listed, with the reason", () => {
    writeSkill(bundledDir, "needs-db", `name: needs-db\n${DESC}\nrequires: ["db"]`);
    const roster = buildSkillRoster(store.list(), options());
    expect(roster).toContain("UNAVAILABLE");
    expect(roster).toContain("db");
  });

  it("omits disabled skills entirely", () => {
    writeSkill(bundledDir, "off", `name: off\n${DESC}`);
    store.setEnabled("off", false);
    expect(buildSkillRoster(store.list(), options())).toBe("");
  });

  it("marks loaded skills so the agent does not re-read them", () => {
    writeSkill(bundledDir, "loaded-one", `name: loaded-one\n${DESC}`);
    const roster = buildSkillRoster(store.list(), options({ loaded: ["loaded-one"] }));
    expect(roster).toContain("already loaded");
    expect(roster).toContain("Loaded into your working context this session: loaded-one");
  });

  it("returns empty string when there are no skills at all", () => {
    expect(buildSkillRoster([], options())).toBe("");
  });
});
