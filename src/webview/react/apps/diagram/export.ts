/* Export for the diagram viewer: a standalone SVG file, and a PNG raster of it.
 *
 * The drawn SVG depends on its surroundings in ways a saved file cannot: it is sized to its
 * container (width="100%", a max-width style), and its labels are set in Lexend, which the
 * panel loads but most machines do not have. A label measured in one face and drawn in
 * another overflows its box. So the standalone copy gets explicit pixel dimensions, an
 * optional background, and the font embedded as data.
 */

export interface EmbeddedFonts {
  latin?: string;
  latinExt?: string;
}

export interface StandaloneSvg {
  markup: string;
  width: number;
  height: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/* Same subsets and ranges as the @font-face rules in shell.html. */
const FONT_FACES: Array<{ key: keyof EmbeddedFonts; range: string }> = [
  {
    key: "latin",
    range: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  },
  {
    key: "latinExt",
    range: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
  },
];

function fontFaceCss(fonts: EmbeddedFonts): string {
  return FONT_FACES
    .filter(({ key }) => fonts[key])
    .map(({ key, range }) => `@font-face{font-family:'Lexend';font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${fonts[key]}) format('woff2');unicode-range:${range};}`)
    .join("");
}

/** The diagram's own coordinate box: the viewBox Mermaid sets, or its drawn bounds. */
export function diagramBox(svg: SVGSVGElement): { x: number; y: number; width: number; height: number } {
  const box = svg.viewBox?.baseVal;
  if (box && box.width > 0 && box.height > 0) return { x: box.x, y: box.y, width: box.width, height: box.height };
  try {
    const bounds = svg.getBBox();
    if (bounds.width > 0 && bounds.height > 0) return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  } catch { /* detached or not rendered */ }
  return { x: 0, y: 0, width: 800, height: 600 };
}

/** A self-contained SVG document of the drawn diagram. */
export function buildStandaloneSvg(svg: SVGSVGElement, options: { background: string | null; fonts: EmbeddedFonts }): StandaloneSvg {
  const box = diagramBox(svg);
  const width = Math.ceil(box.width);
  const height = Math.ceil(box.height);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
  for (const property of ["max-width", "min-width", "width", "height", "transform"]) clone.style.removeProperty(property);
  if (!clone.getAttribute("style")?.trim()) clone.removeAttribute("style");

  if (options.background) {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(box.x));
    rect.setAttribute("y", String(box.y));
    rect.setAttribute("width", String(box.width));
    rect.setAttribute("height", String(box.height));
    rect.setAttribute("fill", options.background);
    clone.insertBefore(rect, clone.firstChild);
  }
  const css = fontFaceCss(options.fonts);
  if (css) {
    const style = document.createElementNS(SVG_NS, "style");
    style.textContent = css;
    clone.insertBefore(style, clone.firstChild);
  }

  const markup = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
  return { markup, width, height };
}

/** Parse SVG markup into a detached element, for building an export from a render that is
 *  not the one on screen (the PNG fallback below). */
export function parseSvg(markup: string): SVGSVGElement | null {
  const holder = document.createElement("div");
  holder.innerHTML = markup;
  return holder.querySelector("svg");
}

export function svgDataUrl(markup: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

/** Chromium's canvas ceiling is 16384 on a side and ~268M pixels in area; stay well inside. */
const MAX_CANVAS_SIDE = 16_000;
const MAX_CANVAS_AREA = 120_000_000;

/** The largest scale ≤ `requested` whose canvas fits the browser's limits. */
export function rasterScale(width: number, height: number, requested: number): number {
  let scale = requested;
  scale = Math.min(scale, MAX_CANVAS_SIDE / Math.max(1, width), MAX_CANVAS_SIDE / Math.max(1, height));
  scale = Math.min(scale, Math.sqrt(MAX_CANVAS_AREA / Math.max(1, width * height)));
  return Math.max(0.1, scale);
}

/** Thrown when the browser refuses to read back the canvas (an SVG with HTML labels can taint
 *  it on some Chromium versions); the caller retries with a text-label render. */
export class TaintedCanvasError extends Error {}

export async function rasterize(image: StandaloneSvg, requestedScale: number): Promise<Blob> {
  const element = new Image();
  element.decoding = "async";
  element.src = svgDataUrl(image.markup);
  await element.decode();

  const scale = rasterScale(image.width, image.height, requestedScale);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This webview cannot draw to a canvas.");
  context.imageSmoothingQuality = "high";
  context.drawImage(element, 0, 0, canvas.width, canvas.height);

  return new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The PNG could not be encoded."))), "image/png");
    } catch (error) {
      reject(error instanceof DOMException && error.name === "SecurityError" ? new TaintedCanvasError(error.message) : error);
    }
  });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("The image could not be read."));
    reader.readAsDataURL(blob);
  });
}
