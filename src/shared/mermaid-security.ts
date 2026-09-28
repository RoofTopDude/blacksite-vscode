/* Mermaid configuration every Blacksite renderer applies, whatever it is drawing into.
 *
 * Diagram source is model output (or a Markdown file of unknown provenance), so the chat,
 * the diagram viewer, and the Markdown-preview fallback all lock Mermaid down the same way.
 * Kept free of imports so the preview script can bundle it without pulling anything else in.
 */

/* Tags removed from label HTML. Mermaid's default here is just <style>. Images have to go at
   this stage rather than only from the finished SVG: Mermaid measures each label by inserting
   it into the live document, so an <img> in a label is fetched during layout, before render()
   has even returned. */
export const LABEL_FORBIDDEN_TAGS = ["style", "img", "image", "feImage", "video", "audio", "source", "picture"];

/** Mermaid's own locked keys, plus the label sanitizer: a diagram's %%{init}%% directive
 *  may restyle itself, but must not be able to loosen what its labels are allowed to hold. */
export const SECURE_KEYS = ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "dompurifyConfig"];

/** Spread into every mermaid.initialize() call. */
export const MERMAID_SECURITY_CONFIG = {
  startOnLoad: false,
  // "strict" sanitizes label HTML and disables click callbacks; each webview's CSP already
  // refuses inline script either way.
  securityLevel: "strict" as const,
  dompurifyConfig: { FORBID_TAGS: LABEL_FORBIDDEN_TAGS },
  secure: SECURE_KEYS,
  // A parse error rejects render() instead of also drawing Mermaid's bomb graphic into the
  // document body — each surface shows the message its own way.
  suppressErrorRendering: true,
};

/** The same allowances Mermaid's own final DOMPurify pass makes, minus image elements, for a
 *  second pass over the finished SVG. Labels are covered above; this covers whatever a diagram
 *  type emits outside them. */
export const SVG_SANITIZE_CONFIG = {
  RETURN_TRUSTED_TYPE: false as const,
  ADD_TAGS: ["foreignobject"],
  ADD_ATTR: ["dominant-baseline"],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  FORBID_TAGS: ["img", "image", "feImage"],
};
