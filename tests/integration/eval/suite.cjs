// Runs inside the Extension Development Host: hands the scenario to the extension's eval command
// (registered only under BLACKSITE_EVAL=1) and waits for it to export its result.
const fs = require("node:fs");
const vscode = require("vscode");

async function run() {
  const input = JSON.parse(fs.readFileSync(process.env.BLACKSITE_EVAL_INPUT, "utf8"));
  const extension = vscode.extensions.all.find((candidate) => candidate.packageJSON?.name === "blacksite-vscode");
  if (!extension) throw new Error("The Blacksite extension is not loaded in the evaluation host.");
  await extension.activate();
  for (let i = 0; i < 60; i += 1) {
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes("blacksite.eval.runScenario")) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const out = await vscode.commands.executeCommand("blacksite.eval.runScenario", input);
  fs.writeFileSync(process.env.BLACKSITE_EVAL_OUTPUT, JSON.stringify({ resultPath: out }));
}

module.exports = { run };
