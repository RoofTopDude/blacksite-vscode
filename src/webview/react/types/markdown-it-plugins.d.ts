declare module "markdown-it-deflist" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module "markdown-it-abbr" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module "markdown-it-mark" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module "markdown-it-sup" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module "markdown-it-sub" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginWithOptions<{ enabled?: boolean; label?: boolean; labelAfter?: boolean }>;
  export default plugin;
}

declare module "markdown-it-emoji" {
  import type MarkdownIt from "markdown-it";
  export const full: MarkdownIt.PluginSimple;
}
