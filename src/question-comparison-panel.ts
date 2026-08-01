import * as crypto from "crypto";
import * as vscode from "vscode";
import type { QCardQuestion } from "./agent-session.js";
import { BRIDGED_THEME_VARS, PREVIEW_ALIAS_VARS, PREVIEW_BASE_RULES } from "./shared/preview-baseline.js";

type AnswerHandler = (toolCallId: string, answers: string[][]) => void;

/**
 * A focused editor-area surface for question cards that contain several sandbox previews.
 * It deliberately owns the selection controls as well as the previews: the chat drawer is
 * then a single, unambiguous launch/status surface rather than a second copy of the question.
 */
export class QuestionComparisonPanel implements vscode.Disposable {
  private _panel: vscode.WebviewPanel | undefined;
  private _activeToolCallId = "";

  constructor(private readonly _context: vscode.ExtensionContext, private readonly _onAnswer: AnswerHandler) {}

  open(toolCallId: string, questions: QCardQuestion[]): void {
    if (this._panel && this._activeToolCallId === toolCallId) {
      this._panel.reveal(this._panel.viewColumn, false);
      return;
    }
    this._panel?.dispose();

    const panel = vscode.window.createWebviewPanel(
      "blacksite.questionComparison",
      "Blacksite: Compare options",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "out")],
      },
    );
    this._panel = panel;
    this._activeToolCallId = toolCallId;
    panel.webview.html = this._html(panel.webview, toolCallId, questions);
    const receive = panel.webview.onDidReceiveMessage((message: unknown) => {
      const value = message as { type?: unknown; toolCallId?: unknown; answers?: unknown };
      if (value?.type !== "submit" || value.toolCallId !== toolCallId) return;
      const answers = this._validateAnswers(questions, value.answers);
      if (!answers) return;
      this._onAnswer(toolCallId, answers);
      panel.dispose();
    });
    panel.onDidDispose(() => {
      receive.dispose();
      if (this._panel === panel) {
        this._panel = undefined;
        this._activeToolCallId = "";
      }
    });
  }

  dispose(): void {
    this._panel?.dispose();
    this._panel = undefined;
    this._activeToolCallId = "";
  }

  private _validateAnswers(questions: QCardQuestion[], candidate: unknown): string[][] | null {
    if (!Array.isArray(candidate) || candidate.length !== questions.length) return null;
    const answers: string[][] = [];
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index];
      const raw = candidate[index];
      if (!question || !Array.isArray(raw)) return null;
      const keys = raw.map(String);
      if (new Set(keys).size !== keys.length) return null;
      if (!question.multiSelect && keys.length > 1) return null;
      const allowed = new Set(question.options.map((option) => option.key));
      if (keys.some((key) => !allowed.has(key))) return null;
      answers.push(keys);
    }
    return answers;
  }

  private _html(webview: vscode.Webview, toolCallId: string, questions: QCardQuestion[]): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const serialized = JSON.stringify({ toolCallId, questions }).replace(/</g, "\\u003c");
    const csp = [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data: blob:`,
      "frame-src blob:",
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Compare options</title>
<style>
  :root { color-scheme: dark; font-family: var(--vscode-font-family, system-ui, sans-serif); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  * { box-sizing: border-box; } body { margin: 0; min-width: 0; }
  header { position: sticky; z-index: 2; top: 0; padding: 16px clamp(16px, 3vw, 32px) 13px; border-bottom: 1px solid var(--vscode-panel-border); background: color-mix(in srgb, var(--vscode-editor-background) 96%, transparent); backdrop-filter: blur(12px); }
  .eyebrow { color: var(--vscode-textLink-foreground); font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; } h1 { margin: 4px 0 3px; font-size: clamp(19px, 2.4vw, 25px); line-height: 1.2; } .intro { max-width: 720px; margin: 0; color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1.45; }
  main { max-width: 1320px; margin: 0 auto; padding: 18px clamp(16px, 3vw, 32px) 88px; } section + section { margin-top: 24px; padding-top: 22px; border-top: 1px solid var(--vscode-panel-border); }
  h2 { margin: 0 0 5px; font-size: 16px; line-height: 1.35; } .context { max-width: 960px; margin: 0 0 12px; color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1.45; white-space: pre-wrap; }
  .options { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 10px; } .option { overflow: hidden; position: relative; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-sideBar-background)); transition: border-color .16s ease, transform .16s ease, box-shadow .16s ease; } .option:hover { transform: translateY(-1px); border-color: var(--vscode-focusBorder); } .option.selected { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder), 0 7px 18px color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent); }
  .option button { display: block; width: 100%; padding: 12px; border: 0; color: inherit; text-align: left; background: transparent; cursor: pointer; } .option button:focus-visible, summary:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; } .option-title { display: flex; gap: 8px; align-items: flex-start; font-size: 14px; font-weight: 700; line-height: 1.35; } .indicator { display: grid; place-items: center; flex: 0 0 auto; width: 16px; height: 16px; margin-top: 1px; border: 1px solid var(--vscode-descriptionForeground); border-radius: 50%; font-size: 11px; } .multi .indicator { border-radius: 3px; } .selected .indicator { color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); background: var(--vscode-button-background); }
  .description { margin: 6px 0 0 24px; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; } .preview-disclosure { border-top: 1px solid var(--vscode-panel-border); } .preview-disclosure summary { padding: 8px 12px; color: var(--vscode-textLink-foreground); font-size: 11px; font-weight: 600; cursor: pointer; user-select: none; } .preview { --preview-height: 180px; overflow: auto; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); } .preview iframe { display: block; width: 100%; height: var(--preview-height); border: 0; }
  footer { position: fixed; z-index: 3; right: 0; bottom: 0; left: 0; display: flex; align-items: center; gap: 8px; padding: 10px clamp(16px, 3vw, 32px); border-top: 1px solid var(--vscode-panel-border); background: color-mix(in srgb, var(--vscode-editor-background) 96%, transparent); backdrop-filter: blur(12px); } #progress { margin-right: auto; color: var(--vscode-descriptionForeground); font-size: 12px; } footer button { padding: 6px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 5px; color: var(--vscode-button-foreground); font: inherit; font-size: 12px; font-weight: 600; background: var(--vscode-button-background); cursor: pointer; } footer button:hover { background: var(--vscode-button-hoverBackground); } footer button.secondary { color: var(--vscode-foreground); border-color: var(--vscode-panel-border); background: transparent; } footer button:disabled { opacity: .55; cursor: not-allowed; }
  @media (max-width: 600px) { .options { grid-template-columns: 1fr; } footer { flex-wrap: wrap; } #progress { width: 100%; } }
</style></head><body><header><div class="eyebrow">Interactive comparison</div><h1>Choose a direction</h1><p class="intro">Select a complete response for the agent. Expand a live preview only when its visual evidence will help the decision.</p></header><main id="questions"></main><footer><span id="progress"></span><button id="decline" type="button" class="secondary">Decline questions</button><button id="submit" type="button" disabled>Submit selections</button></footer>
<script nonce="${nonce}">(() => {
  const state = ${serialized}; const vscode = acquireVsCodeApi(); const selections = state.questions.map(() => []); const root = document.getElementById('questions'); const progress = document.getElementById('progress'); const submit = document.getElementById('submit');
  const BRIDGED_VARS = ${JSON.stringify(BRIDGED_THEME_VARS)}; const ALIAS_VARS = ${JSON.stringify(PREVIEW_ALIAS_VARS)}; const BASE_RULES = ${JSON.stringify(PREVIEW_BASE_RULES)};
  // The same themed baseline the inline chat previews get (src/shared/preview-baseline.ts), so an
  // option looks identical whichever surface you opened it in. Rebuilt here rather than handed
  // over as a finished string because the theme values only exist as computed custom properties
  // inside a webview, which the extension host cannot read.
  function previewBaseline() { const root = getComputedStyle(document.documentElement); const bridged = BRIDGED_VARS.map((n) => [n, (root.getPropertyValue(n) || '').trim()]).filter((e) => e[1] !== '').map((e) => e[0] + ':' + e[1] + ';').join(''); return ':root{' + bridged + ALIAS_VARS + '}' + BASE_RULES; }
  function safePreview(preview) { const base = preview && preview.html && preview.html.trim() ? preview.html : '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'; const code = preview && preview.code ? preview.code : ''; const injected = '<style>' + previewBaseline() + '<\\/style>' + '<script type="module" nonce="${nonce}">' + code + '<\\/script>'; const pos = base.search(/<\\/head\\s*>/i); return pos >= 0 ? base.slice(0, pos) + injected + base.slice(pos) : base + injected; }
  function renderPreview(target, preview) { if (!preview || !preview.code) return; const requestedHeight = Number(preview.height); const height = Number.isFinite(requestedHeight) && requestedHeight > 0 ? Math.max(140, Math.min(Math.round(requestedHeight), 300)) : 180; target.style.setProperty('--preview-height', height + 'px'); const frame = document.createElement('iframe'); frame.setAttribute('sandbox', 'allow-scripts'); const blob = new Blob([safePreview(preview)], { type: 'text/html' }); const url = URL.createObjectURL(blob); frame.src = url; frame.addEventListener('load', () => URL.revokeObjectURL(url), { once: true }); target.append(frame); }
  function update() { const complete = selections.every((keys) => keys.length > 0); const selected = selections.filter((keys) => keys.length > 0).length; progress.textContent = complete ? 'Ready to submit ' + selected + ' of ' + selections.length + ' answers' : selected + ' of ' + selections.length + ' questions selected'; submit.disabled = !complete; root.querySelectorAll('.option').forEach((node) => { const q = Number(node.dataset.question); const key = node.dataset.key; const active = selections[q].includes(key); node.classList.toggle('selected', active); node.querySelector('.indicator').textContent = active ? '✓' : ''; }); }
  state.questions.forEach((question, questionIndex) => { const section = document.createElement('section'); const title = document.createElement('h2'); title.textContent = question.question; section.append(title); if (question.context) { const context = document.createElement('p'); context.className = 'context'; context.textContent = question.context; section.append(context); } const options = document.createElement('div'); options.className = 'options ' + (question.multiSelect ? 'multi' : 'single'); question.options.forEach((option) => { const card = document.createElement('article'); card.className = 'option'; card.dataset.question = String(questionIndex); card.dataset.key = option.key; const button = document.createElement('button'); button.type = 'button'; const heading = document.createElement('div'); heading.className = 'option-title'; const indicator = document.createElement('span'); indicator.className = 'indicator'; const label = document.createElement('span'); label.textContent = option.label || option.key; heading.append(indicator, label); button.append(heading); if (option.description) { const description = document.createElement('p'); description.className = 'description'; description.textContent = option.description; button.append(description); } button.addEventListener('click', () => { const current = selections[questionIndex]; if (question.multiSelect) { const at = current.indexOf(option.key); if (at >= 0) current.splice(at, 1); else current.push(option.key); } else { selections[questionIndex] = [option.key]; } update(); }); card.append(button); if (option.preview && option.preview.code) { const details = document.createElement('details'); details.className = 'preview-disclosure'; const summary = document.createElement('summary'); summary.textContent = 'Open live preview'; details.append(summary); details.addEventListener('toggle', () => { if (!details.open || details.dataset.loaded === 'true') return; const preview = document.createElement('div'); preview.className = 'preview'; details.append(preview); details.dataset.loaded = 'true'; renderPreview(preview, option.preview); }); card.append(details); } options.append(card); }); section.append(options); root.append(section); });
  document.getElementById('decline').addEventListener('click', () => vscode.postMessage({ type: 'submit', toolCallId: state.toolCallId, answers: state.questions.map(() => []) })); submit.addEventListener('click', () => { if (!submit.disabled) vscode.postMessage({ type: 'submit', toolCallId: state.toolCallId, answers: selections }); }); update();
})();</script></body></html>`;
  }
}
