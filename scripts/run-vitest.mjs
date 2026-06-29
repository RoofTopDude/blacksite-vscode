import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVitest } from "../../../node_modules/vitest/dist/node.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(scriptDir, "..");
const configArg = process.argv[2] ?? "vitest.config.ts";
const configPath = path.resolve(extensionDir, configArg);
const filters = process.argv.slice(3);

process.env.npm_lifecycle_event = "test:unit";
process.env.npm_lifecycle_script = "node scripts/run-vitest.mjs vitest.config.ts";

try {
  const ctx = await startVitest("test", filters, {
    config: configPath,
    run: true,
  });

  if (!ctx.shouldKeepServer()) {
    await ctx.exit();
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
