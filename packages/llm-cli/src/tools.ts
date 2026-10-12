/* Two read-only demo tools, confined to one directory: enough to exercise a real tool round trip
   (a call, its result, and the model using the result) without giving the model anything it could
   damage. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolSchema } from "@blacksite-agent/llm";

export interface CliTool {
  schema: ToolSchema;
  run(input: Record<string, unknown>): Promise<string>;
}

const MAX_READ_BYTES = 64 * 1024;

/** Resolve `requested` inside `root`, refusing anything that would leave it. */
function inside(root: string, requested: unknown): string {
  const relative = typeof requested === "string" && requested.trim() ? requested.trim() : ".";
  const resolved = path.resolve(root, relative);
  const fromRoot = path.relative(root, resolved);
  if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) throw new Error(`${relative} is outside ${root}`);
  return resolved;
}

export function demoTools(root: string): CliTool[] {
  return [
    {
      schema: {
        name: "read_file",
        description: "Read a UTF-8 text file in the working directory (first 64 KB).",
        input_schema: { type: "object", properties: { path: { type: "string", description: "Path relative to the working directory" } }, required: ["path"] },
      },
      async run(input) {
        const file = inside(root, input["path"]);
        const handle = await fs.open(file, "r");
        try {
          const buffer = Buffer.alloc(MAX_READ_BYTES);
          const { bytesRead } = await handle.read(buffer, 0, MAX_READ_BYTES, 0);
          return buffer.subarray(0, bytesRead).toString("utf8");
        } finally {
          await handle.close();
        }
      },
    },
    {
      schema: {
        name: "list_dir",
        description: "List the entries of a directory in the working directory.",
        input_schema: { type: "object", properties: { path: { type: "string", description: "Directory relative to the working directory; omit for the root" } } },
      },
      async run(input) {
        const entries = await fs.readdir(inside(root, input["path"]), { withFileTypes: true });
        return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort().join("\n") || "(empty)";
      },
    },
  ];
}
