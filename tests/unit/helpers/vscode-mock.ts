export const window = {
  showWarningMessage: async (..._args: unknown[]): Promise<string | undefined> => "Deny",
  showInformationMessage: async (..._args: unknown[]): Promise<string | undefined> => undefined,
  tabGroups: { all: [] as Array<{ tabs: unknown[] }>, close: async (): Promise<void> => undefined },
};

/** Minimal EventEmitter parity for host modules (e.g. PlanningStore) under unit tests. */
export class EventEmitter<T> {
  private readonly _listeners = new Set<(e: T) => void>();
  readonly event = (listener: (e: T) => void): { dispose: () => void } => {
    this._listeners.add(listener);
    return { dispose: () => { this._listeners.delete(listener); } };
  };
  fire(data: T): void {
    for (const listener of this._listeners) listener(data);
  }
  dispose(): void {
    this._listeners.clear();
  }
}

export class Uri {
  private constructor(readonly scheme: string, readonly fsPath: string, readonly path: string) {}
  static file(value: string): Uri { return new Uri("file", value, value.replace(/\\/g, "/")); }
  static parse(value: string): Uri {
    const index = value.indexOf(":");
    const scheme = index >= 0 ? value.slice(0, index) : "file";
    const rest = index >= 0 ? value.slice(index + 1) : value;
    return new Uri(scheme, rest, rest.replace(/^\//, ""));
  }
  toString(): string { return `${this.scheme}:${this.path}`; }
}

export class Position {
  constructor(readonly line: number, readonly character: number) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(start: Position | number, startCharacter: Position | number, endLine?: number, endCharacter?: number) {
    if (start instanceof Position && startCharacter instanceof Position) {
      this.start = start;
      this.end = startCharacter;
    } else {
      this.start = new Position(start as number, startCharacter as number);
      this.end = new Position(endLine ?? (start as number), endCharacter ?? (startCharacter as number));
    }
  }
  contains(value: Position | Range): boolean {
    const start = value instanceof Range ? value.start : value;
    const end = value instanceof Range ? value.end : value;
    return comparePosition(this.start, start) <= 0 && comparePosition(this.end, end) >= 0;
  }
  intersection(other: Range): Range | undefined {
    const start = comparePosition(this.start, other.start) >= 0 ? this.start : other.start;
    const end = comparePosition(this.end, other.end) <= 0 ? this.end : other.end;
    return comparePosition(start, end) <= 0 ? new Range(start, end) : undefined;
  }
}

export class TabInputTextDiff {
  constructor(readonly original: Uri, readonly modified: Uri) {}
}

const diagnosticsEmitter = new EventEmitter<{ uris: Uri[] }>();
const diagnostics = new Map<string, unknown[]>();
const textDocumentEmitter = new EventEmitter<{ document: { uri: Uri } }>();
const createFilesEmitter = new EventEmitter<{ files: Uri[] }>();
const renameFilesEmitter = new EventEmitter<{ files: Array<{ oldUri: Uri; newUri: Uri }> }>();
const deleteFilesEmitter = new EventEmitter<{ files: Uri[] }>();

export const languages = {
  getDiagnostics: (uri?: Uri): unknown => uri
    ? diagnostics.get(uri.toString()) ?? []
    : [...diagnostics].map(([key, values]) => [Uri.parse(key), values]),
  onDidChangeDiagnostics: diagnosticsEmitter.event,
  __setDiagnostics(uri: Uri, values: unknown[]): void { diagnostics.set(uri.toString(), values); },
  __fireDiagnostics(uris: Uri[]): void { diagnosticsEmitter.fire({ uris }); },
  __clearDiagnostics(): void { diagnostics.clear(); },
};

/** Settings a spec wants the mocked `workspace.getConfiguration` to return; anything absent
 *  falls through to the default the caller passed, which is what the real API does. */
const configOverrides = new Map<string, unknown>();

export const workspace = {
  workspaceFolders: undefined as Array<{ name: string; index: number; uri: Uri }> | undefined,
  getConfiguration: (section?: string): { get: <T>(key: string, defaultValue?: T) => T | undefined } => ({
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      const full = section ? `${section}.${key}` : key;
      return configOverrides.has(full) ? configOverrides.get(full) as T : defaultValue;
    },
  }),
  __setConfig(key: string, value: unknown): void { configOverrides.set(key, value); },
  __clearConfig(): void { configOverrides.clear(); },
  openTextDocument: async (uri: Uri): Promise<unknown> => { throw new Error(`No mock document for ${uri.toString()}`); },
  getWorkspaceFolder: (uri: Uri): { name: string; index: number; uri: Uri } | undefined =>
    workspace.workspaceFolders?.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath)),
  registerTextDocumentContentProvider: (): { dispose: () => void } => ({ dispose: () => undefined }),
  applyEdit: async (): Promise<boolean> => true,
  findFiles: async (): Promise<Uri[]> => [],
  onDidChangeTextDocument: textDocumentEmitter.event,
  onDidCreateFiles: createFilesEmitter.event,
  onDidRenameFiles: renameFilesEmitter.event,
  onDidDeleteFiles: deleteFilesEmitter.event,
  __fireTextDocument(uri: Uri): void { textDocumentEmitter.fire({ document: { uri } }); },
  __fireCreateFiles(files: Uri[]): void { createFilesEmitter.fire({ files }); },
  __fireRenameFiles(files: Array<{ oldUri: Uri; newUri: Uri }>): void { renameFilesEmitter.fire({ files }); },
  __fireDeleteFiles(files: Uri[]): void { deleteFilesEmitter.fire({ files }); },
};

export const commands = {
  executeCommand: async <T>(..._args: unknown[]): Promise<T | undefined> => undefined,
};

export class Disposable {
  constructor(private readonly callOnDispose: () => void) {}
  dispose(): void { this.callOnDispose(); }
}

export const ExtensionMode = { Production: 1, Development: 2, Test: 3 } as const;
export const UIKind = { Desktop: 1, Web: 2 } as const;

export const env = {
  uiKind: UIKind.Desktop as number,
  appName: "Visual Studio Code",
  appRoot: "/app",
  openExternal: async (): Promise<boolean> => true,
};

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;
export const DiagnosticTag = { Unnecessary: 1, Deprecated: 2 } as const;
export const InlayHintKind = { Type: 1, Parameter: 2 } as const;

function comparePosition(a: Position, b: Position): number {
  return a.line - b.line || a.character - b.character;
}
