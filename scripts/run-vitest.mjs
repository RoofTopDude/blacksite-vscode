import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVitest } from "vitest/node";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(scriptDir, "..");
const configArg = process.argv[2] ?? "vitest.config.ts";
const configPath = path.resolve(extensionDir, configArg);

/* Everything after the config path is a test-name filter, except the one flag below.
   Vitest's own CLI parses flags here; this wrapper does not, so an unrecognized `--flag`
   would silently become a filter that matches no test and report a vacuous pass. Keep
   that in mind before adding another option: it has to be split out explicitly. */
const args = process.argv.slice(3);
const coverage = args.includes("--coverage");
const filters = args.filter((arg) => arg !== "--coverage");

const unknownFlags = filters.filter((arg) => arg.startsWith("-"));
if (unknownFlags.length > 0) {
  console.error(
    `run-vitest: unsupported option(s) ${unknownFlags.join(", ")}. This wrapper only understands `
    + "--coverage; anything else would be treated as a test-name filter and silently match nothing.",
  );
  process.exit(2);
}

process.env.npm_lifecycle_event = "test:unit";
process.env.npm_lifecycle_script = "node scripts/run-vitest.mjs vitest.config.ts";

try {
  const ctx = await startVitest("test", filters, {
    config: configPath,
    run: true,
    ...(coverage ? { coverage: { enabled: true } } : {}),
  });

  if (!ctx.shouldKeepServer()) {
    await ctx.exit();
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
