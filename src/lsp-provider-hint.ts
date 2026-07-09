/* Pure message formatting for the "no language server available" case, kept
   as a single template so the exact wording only needs to be right once —
   reused from every lsp-service.ts empty-result branch. */

export function noProviderNotice(feature: string, lang: string, extensionId: string): string {
  return `No ${feature} provider for .${lang} files. Is the ${extensionId} extension installed?`;
}
