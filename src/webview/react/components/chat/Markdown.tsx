import { Markdown as BaseMarkdown, type MarkdownProps } from "@/components/ui/markdown";
import { actions } from "@/lib/store";

type ChatMarkdownProps = Omit<MarkdownProps, "onOpenFile" | "onOpenImage">;

/**
 * The transcript's Markdown renderer: the shared component wired to the chat store.
 *
 * The rendering itself lives in components/ui/markdown.tsx so the Plans panel (and, later,
 * Tickets) can render the same Markdown without importing the chat store — those surfaces
 * post their own open-file messages to their own providers.
 */
export function Markdown(props: ChatMarkdownProps) {
  return (
    <BaseMarkdown
      {...props}
      onOpenFile={(path, line) => actions.openFile(path, line)}
      onOpenImage={(src, label) => actions.openLightbox(src, label)}
    />
  );
}
