const assert = require("node:assert/strict");
const vscode = require("vscode");

async function run() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root, "fixture workspace should be open");
  const libUri = vscode.Uri.joinPath(root, "src", "lib.ts");
  const mainUri = vscode.Uri.joinPath(root, "src", "main.ts");
  const diagnosticUri = vscode.Uri.joinPath(root, "src", "diagnostic.ts");
  const [lib, main, diagnostic] = await Promise.all([
    vscode.workspace.openTextDocument(libUri),
    vscode.workspace.openTextDocument(mainUri),
    vscode.workspace.openTextDocument(diagnosticUri),
  ]);

  const symbols = await eventually(async () => {
    const value = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", libUri);
    return Array.isArray(value) && value.length ? value : undefined;
  }, "document symbols");
  assert.ok(symbols.some((symbol) => symbol.name === "EnglishGreeter"), "class symbol should be available");

  const definitionPosition = positionOf(main, "EnglishGreeter", 1);
  const definitions = await eventually(
    () => vscode.commands.executeCommand("vscode.executeDefinitionProvider", mainUri, definitionPosition),
    "definition",
  );
  assert.ok(locations(definitions).some((location) => location.uri.fsPath.endsWith("lib.ts")), "definition should resolve into lib.ts");

  const interfacePosition = positionOf(lib, "Greeter", 1);
  const implementations = await eventually(
    () => vscode.commands.executeCommand("vscode.executeImplementationProvider", libUri, interfacePosition),
    "implementation",
  );
  assert.ok(locations(implementations).length > 0, "interface should have an implementation");

  const classPosition = positionOf(lib, "EnglishGreeter", 1);
  const references = await eventually(
    () => vscode.commands.executeCommand("vscode.executeReferenceProvider", libUri, classPosition),
    "references",
  );
  assert.ok(locations(references).some((location) => location.uri.fsPath.endsWith("main.ts")), "class reference should include main.ts");

  const hovers = await eventually(
    () => vscode.commands.executeCommand("vscode.executeHoverProvider", mainUri, definitionPosition),
    "hover",
  );
  assert.ok(Array.isArray(hovers) && hovers.length > 0, "hover should be available");

  const callPosition = positionOf(main, "greet(\"Relay\")", "greet(".length);
  const signature = await eventually(
    () => vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", mainUri, callPosition, "("),
    "signature help",
  );
  assert.ok(signature?.signatures?.length > 0, "signature help should be available");

  await verifyDiagnosticLifecycle(diagnostic, diagnosticUri);

  const fullMainRange = new vscode.Range(0, 0, main.lineCount - 1, main.lineAt(main.lineCount - 1).text.length);
  const actions = await eventually(
    () => vscode.commands.executeCommand("vscode.executeCodeActionProvider", mainUri, fullMainRange, "source.organizeImports", 20),
    "organize-imports code action",
  );
  assert.ok(Array.isArray(actions) && actions.length > 0, "organize imports should be offered");
  const organize = actions.find((action) => action.edit);
  if (organize?.edit) assert.equal(await vscode.workspace.applyEdit(organize.edit), true, "organize-imports edit should apply");

  const formatting = await eventually(
    () => vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", mainUri, { tabSize: 2, insertSpaces: true }),
    "formatting",
  );
  assert.ok(Array.isArray(formatting) && formatting.length > 0, "unformatted fixture should produce formatting edits");
  const formatEdit = new vscode.WorkspaceEdit();
  for (const edit of formatting) formatEdit.replace(mainUri, edit.range, edit.newText);
  assert.equal(await vscode.workspace.applyEdit(formatEdit), true, "formatting edit should apply");
  await main.save();
  const noFormatting = await vscode.commands.executeCommand(
    "vscode.executeFormatDocumentProvider",
    mainUri,
    { tabSize: 2, insertSpaces: true },
  );
  assert.equal(noFormatting?.length ?? 0, 0, "formatted document should produce no additional edits");

  const rename = await eventually(
    () => vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", libUri, classPosition, "UniversalGreeter"),
    "rename",
  );
  assert.ok(rename instanceof vscode.WorkspaceEdit && rename.size >= 2, "rename should span multiple files");
  assert.equal(await vscode.workspace.applyEdit(rename), true, "rename edit should apply");
  assert.match(lib.getText(), /UniversalGreeter/, "declaration should be renamed");
  assert.match(main.getText(), /UniversalGreeter/, "usage should be renamed");

  console.log("Blacksite LSP Extension Host integration checks passed.");
}

async function verifyDiagnosticLifecycle(document, uri) {
  const original = document.getText();
  await vscode.window.showTextDocument(document, { preview: false });
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(0, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length),
    "export const count: number = ;\n");
  assert.equal(await vscode.workspace.applyEdit(edit), true, "diagnostic fixture mutation should apply");
  await document.save();
  const diagnostics = await eventually(() => {
    const values = vscode.languages.getDiagnostics(uri);
    return values.some((entry) => entry.severity === vscode.DiagnosticSeverity.Error) ? values : undefined;
  }, "introduced diagnostics");
  assert.ok(diagnostics.some((entry) => /expected|expression/i.test(entry.message)), "syntax error should be published");

  const restore = new vscode.WorkspaceEdit();
  restore.replace(uri, new vscode.Range(0, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length), original);
  assert.equal(await vscode.workspace.applyEdit(restore), true, "diagnostic fixture restore should apply");
  await document.save();
  await eventually(() => vscode.languages.getDiagnostics(uri).length === 0 ? true : undefined, "resolved diagnostics");
}

function positionOf(document, text, offset) {
  const source = document.getText();
  const index = source.indexOf(text);
  assert.notEqual(index, -1, `${text} should exist in ${document.uri.fsPath}`);
  return document.positionAt(index + offset);
}

function locations(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => "targetUri" in entry
    ? { uri: entry.targetUri, range: entry.targetSelectionRange || entry.targetRange }
    : entry);
}

async function eventually(operation, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined && (!Array.isArray(value) || value.length > 0)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

module.exports = { run };
