import * as vscode from "vscode";

export interface InspectedResourceOperation {
  kind: "create" | "delete" | "rename";
  from?: vscode.Uri;
  to?: vscode.Uri;
  overwrite?: boolean;
  recursive?: boolean;
  ignoreIfExists?: boolean;
  ignoreIfNotExists?: boolean;
  destructive: boolean;
}

export interface WorkspaceEditInspection {
  textEntries: Array<[vscode.Uri, readonly vscode.TextEdit[]]>;
  textEdits: number;
  snippetEdits: number;
  textUris: vscode.Uri[];
  resourceOperations: InspectedResourceOperation[];
  opaqueResourceOperations: number;
  touchedUris: vscode.Uri[];
  destructive: boolean;
}

/**
 * VS Code exposes text edits through entries(), but has no public resource-edit
 * iterator. `_allEntries` is the stable internal representation used by the
 * Extension Host. We inspect it defensively and retain an opaque count when a
 * future VS Code release changes the shape, which keeps approval fail-closed.
 */
export function inspectWorkspaceEdit(edit: vscode.WorkspaceEdit): WorkspaceEditInspection {
  const textEntries = edit.entries();
  const resources: InspectedResourceOperation[] = [];
  const internalTextUris = new Map<string, vscode.Uri>();
  let snippetEdits = 0;
  let unknownInternalEntries = 0;
  const rawEntries = (edit as unknown as { _allEntries?: unknown })._allEntries;
  const allEntries = toArray(rawEntries);

  if (allEntries) {
    for (const entry of allEntries) {
      const entryUri = Array.isArray(entry) ? uriValue(entry[0]) : undefined;
      const values = Array.isArray(entry)
        ? Array.isArray(entry[1]) ? entry[1] : [entry[1]]
        : [entry];
      for (const value of values) {
        if (isTextEdit(value)) {
          if (entryUri) internalTextUris.set(entryUri.toString(), entryUri);
          continue;
        }
        if (isSnippetEdit(value)) {
          snippetEdits += 1;
          if (entryUri) internalTextUris.set(entryUri.toString(), entryUri);
          continue;
        }
        const resource = resourceOperation(value);
        if (resource) resources.push(resource);
        else unknownInternalEntries += 1;
      }
    }
  }

  const textResourceCount = new Set([
    ...textEntries.map(([uri]) => uri.toString()),
    ...internalTextUris.keys(),
  ]).size;
  const inferredResources = Math.max(0, edit.size - textResourceCount - resources.length);
  const opaqueResourceOperations = allEntries
    ? Math.max(unknownInternalEntries, inferredResources - resources.length)
    : inferredResources;
  const touchedUris = dedupeUris([
    ...textEntries.map(([uri]) => uri),
    ...internalTextUris.values(),
    ...resources.flatMap((resource) => [resource.from, resource.to].filter((uri): uri is vscode.Uri => !!uri)),
  ]);
  const textUris = dedupeUris([...textEntries.map(([uri]) => uri), ...internalTextUris.values()]);

  return {
    textEntries,
    textEdits: textEntries.reduce((count, [, edits]) => count + edits.length, 0),
    snippetEdits,
    textUris,
    resourceOperations: resources,
    opaqueResourceOperations,
    touchedUris,
    destructive: opaqueResourceOperations > 0 || resources.some((resource) => resource.destructive),
  };
}

function resourceOperation(value: unknown): InspectedResourceOperation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const from = uriValue(record["oldUri"] ?? record["_oldUri"] ?? record["from"]);
  const to = uriValue(record["newUri"] ?? record["_newUri"] ?? record["to"]);
  if (!from && !to) return undefined;
  const options = objectValue(record["options"] ?? record["_options"]);
  const overwrite = booleanValue(options?.["overwrite"]);
  const recursive = booleanValue(options?.["recursive"]);
  const ignoreIfExists = booleanValue(options?.["ignoreIfExists"]);
  const ignoreIfNotExists = booleanValue(options?.["ignoreIfNotExists"]);
  const kind = from && to ? "rename" : from ? "delete" : "create";
  return {
    kind,
    from,
    to,
    overwrite,
    recursive,
    ignoreIfExists,
    ignoreIfNotExists,
    destructive: kind === "delete" || overwrite === true || recursive === true,
  };
}

function isTextEdit(value: unknown): value is vscode.TextEdit {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record["newText"] === "string" && !!record["range"];
}

function isSnippetEdit(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return !!record["range"] && !!record["snippet"];
}

function uriValue(value: unknown): vscode.Uri | undefined {
  if (!value || typeof value !== "object") return undefined;
  const uri = value as vscode.Uri;
  return typeof uri.scheme === "string" && typeof uri.toString === "function" ? uri : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Symbol.iterator in value) {
    return [...value as Iterable<unknown>];
  }
  return undefined;
}

function dedupeUris(uris: vscode.Uri[]): vscode.Uri[] {
  return [...new Map(uris.map((uri) => [uri.toString(), uri])).values()];
}
