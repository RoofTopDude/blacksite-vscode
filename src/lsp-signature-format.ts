/* Pure formatting for VS Code's SignatureHelp shape. Kept vscode-free (a
   structural type, not an import) so it's unit-testable without a vscode
   mock; a real vscode.SignatureHelp satisfies this shape by structural
   typing. */

export interface ParameterInformationLike {
  label: string | readonly [number, number];
}

export interface SignatureInformationLike {
  label: string;
  parameters: readonly ParameterInformationLike[];
  activeParameter?: number;
}

export interface SignatureHelpLike {
  signatures: readonly SignatureInformationLike[];
  activeSignature: number;
  activeParameter: number;
}

/** Formats the active signature with its active parameter bolded (markdown
    `**...**`), falling back to the plain signature label whenever the active
    parameter can't be resolved. Returns undefined for an empty/missing
    signature help result. */
export function formatActiveSignature(help: SignatureHelpLike | undefined): string | undefined {
  if (!help || help.signatures.length === 0) return undefined;
  const sig = help.signatures[help.activeSignature] ?? help.signatures[0];
  if (!sig) return undefined;

  // A signature's own activeParameter overrides the top-level one when present.
  const paramIdx = sig.activeParameter ?? help.activeParameter;
  const param = sig.parameters[paramIdx];
  if (!param) return sig.label;

  const label = param.label;
  if (typeof label === "string") {
    const idx = sig.label.indexOf(label);
    if (idx < 0) return sig.label;
    return `${sig.label.slice(0, idx)}**${label}**${sig.label.slice(idx + label.length)}`;
  }

  // readonly [number, number]: an inclusive-start, exclusive-end offset into sig.label.
  const [start, end] = label;
  if (start < 0 || end > sig.label.length || start >= end) return sig.label;
  return `${sig.label.slice(0, start)}**${sig.label.slice(start, end)}**${sig.label.slice(end)}`;
}
