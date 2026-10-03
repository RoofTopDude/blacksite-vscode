/* Colours for everything Blacksite draws as a diagram or chart: Mermaid and the `chart` fence.
 *
 * Kept free of DOM and vscode imports so the Mermaid renderer, the chart renderer, and the unit
 * tests all read the same values. Mermaid derives its remaining colours from these with khroma,
 * which only parses plain hex/rgb — hence literal values here instead of the CSS custom
 * properties they mirror (see the :root block in theme.chat.css).
 */

/** "dark" is the panel palette; "light" is for the viewer's light canvas and for exports
 *  headed into documents with a white page. */
export type DiagramTheme = "dark" | "light";

/* Eight categorical hues in a fixed order, validated for lightness band, chroma, colour-blind
   separation of adjacent pairs, and contrast against each surface (`validate_palette.js` from
   the dataviz skill, surfaces #0d0d0f and #ffffff). The order is the colour-blind-safety
   mechanism, so do not re-sort it, and do not generate a ninth: fold the tail into "Other". */
export const CATEGORICAL: Record<DiagramTheme, readonly string[]> = {
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
};

export interface DiagramInk {
  surface: string;
  /** Titles and values. */
  text: string;
  /** Axis labels and legends. */
  secondary: string;
  /** Tick labels and annotations. */
  muted: string;
  /** Gridlines: present, never competing with the data. */
  grid: string;
  /** Axis lines and baselines. */
  axis: string;
}

export const INK: Record<DiagramTheme, DiagramInk> = {
  dark: { surface: "#0d0d0f", text: "#f4f4f5", secondary: "#c8c8d0", muted: "#9a9aa3", grid: "#232328", axis: "#52525b" },
  light: { surface: "#ffffff", text: "#18181b", secondary: "#3f3f46", muted: "#71717a", grid: "#ececef", axis: "#a1a1aa" },
};

/** The slot colour for series `index`, wrapping only where a diagram has more than eight. */
export function categorical(theme: DiagramTheme, index: number): string {
  const colours = CATEGORICAL[theme];
  return colours[((index % colours.length) + colours.length) % colours.length]!;
}

// ── colour arithmetic ──────────────────────────────────────────────────────────────────────

function channels(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value;
  return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16)) as [number, number, number];
}

function toHex(rgb: readonly number[]): string {
  return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("")}`;
}

/** `amount` of `colour` over `base`: 0 is `base`, 1 is `colour`. */
export function mix(colour: string, base: string, amount: number): string {
  const a = channels(colour);
  const b = channels(base);
  return toHex(a.map((c, i) => b[i]! + (c - b[i]!) * amount));
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Whichever of `dark` and `light` reads better on `fill`. */
export function readableInk(fill: string, dark = "#0d0d0f", light = "#ffffff"): string {
  return contrast(fill, dark) >= contrast(fill, light) ? dark : light;
}

// ── Mermaid ────────────────────────────────────────────────────────────────────────────────

const BASE_VARIABLES: Record<DiagramTheme, Record<string, string | boolean>> = {
  dark: {
    darkMode: true,
    background: "#0d0d0f",
    primaryColor: "#1c1830",
    primaryBorderColor: "#6b56b8",
    primaryTextColor: "#f4f4f5",
    secondaryColor: "#17171c",
    secondaryBorderColor: "#3f3f46",
    secondaryTextColor: "#e4e4e7",
    tertiaryColor: "#121216",
    tertiaryBorderColor: "#3f3f46",
    tertiaryTextColor: "#e4e4e7",
    lineColor: "#9a9aa3",
    textColor: "#e4e4e7",
    clusterBkg: "#121216",
    clusterBorder: "#3f3f46",
    edgeLabelBackground: "#0d0d0f",
    noteBkgColor: "#1f1c14",
    noteBorderColor: "#c4b08d",
    noteTextColor: "#f4f4f5",
    errorBkgColor: "#2a1a1d",
    errorTextColor: "#c78b94",
  },
  light: {
    darkMode: false,
    background: "#ffffff",
    primaryColor: "#f1edfd",
    primaryBorderColor: "#8b5cf6",
    primaryTextColor: "#18181b",
    secondaryColor: "#f4f4f5",
    secondaryBorderColor: "#d4d4d8",
    secondaryTextColor: "#27272a",
    tertiaryColor: "#fafafa",
    tertiaryBorderColor: "#d4d4d8",
    tertiaryTextColor: "#27272a",
    lineColor: "#71717a",
    textColor: "#27272a",
    clusterBkg: "#fafafa",
    clusterBorder: "#d4d4d8",
    edgeLabelBackground: "#ffffff",
    noteBkgColor: "#fdf8e7",
    noteBorderColor: "#c4a35a",
    noteTextColor: "#27272a",
    errorBkgColor: "#fdecee",
    errorTextColor: "#a4343f",
  },
};

/* Mermaid's base theme derives every category colour (pie slices, the colour scale behind
   mindmaps, timelines and treemaps, Venn sets, git branches, the XY chart's series) from the
   primary/secondary/tertiary colours. Ours are near-black tints chosen for flowchart nodes, so
   left alone those types came out as near-black slices, same-coloured bars, and ribbons that
   vanish into the panel. Naming the category colours outright is what makes them readable. */
function chartVariables(theme: DiagramTheme): Record<string, unknown> {
  const ink = INK[theme];
  const colours = CATEGORICAL[theme];
  const slot = (index: number): string => colours[index % colours.length]!;
  // How much of a hue goes into a tinted background, so text on it stays readable.
  const tint = theme === "dark" ? 0.2 : 0.14;
  const out: Record<string, unknown> = {};

  for (let i = 0; i < 12; i++) {
    out[`pie${i + 1}`] = slot(i);
    out[`cScale${i}`] = slot(i);
    out[`cScaleLabel${i}`] = readableInk(slot(i));
    out[`cScaleInv${i}`] = readableInk(slot(i));
    out[`cScalePeer${i}`] = mix(slot(i), ink.surface, 0.8);
  }
  for (let i = 0; i < 8; i++) {
    out[`venn${i + 1}`] = slot(i);
    out[`git${i}`] = slot(i);
    out[`gitInv${i}`] = readableInk(slot(i));
    out[`gitBranchLabel${i}`] = readableInk(slot(i));
  }

  Object.assign(out, {
    pieStrokeColor: ink.surface,
    pieStrokeWidth: "2px",
    pieOuterStrokeColor: ink.surface,
    pieOuterStrokeWidth: "0px",
    pieOpacity: "1",
    pieTitleTextColor: ink.text,
    pieLegendTextColor: ink.secondary,
    // One colour has to read on every slice; the light slots are bright enough for dark ink,
    // and so are the dark ones (the validator puts them all between L 0.48 and 0.67).
    pieSectionTextColor: "#0d0d0f",
    vennTitleTextColor: ink.text,
    vennSetTextColor: ink.text,
    branchLabelColor: ink.text,
    tagLabelColor: ink.text,
    tagLabelBackground: mix(ink.axis, ink.surface, 0.35),
    tagLabelBorder: ink.axis,
    commitLabelColor: ink.secondary,
    commitLabelBackground: ink.surface,

    xyChart: {
      backgroundColor: ink.surface,
      titleColor: ink.text,
      dataLabelColor: ink.text,
      legendTextColor: ink.secondary,
      xAxisTitleColor: ink.secondary,
      xAxisLabelColor: ink.secondary,
      xAxisTickColor: ink.axis,
      xAxisLineColor: ink.axis,
      yAxisTitleColor: ink.secondary,
      yAxisLabelColor: ink.secondary,
      yAxisTickColor: ink.axis,
      yAxisLineColor: ink.axis,
      plotColorPalette: colours.join(","),
    },
    radar: {
      axisColor: ink.axis,
      graticuleColor: ink.axis,
      graticuleOpacity: 0.35,
      curveOpacity: 0.3,
      curveStrokeWidth: 2,
    },

    packet: {
      startByteColor: ink.muted,
      endByteColor: ink.muted,
      labelColor: ink.text,
      titleColor: ink.text,
      blockStrokeColor: ink.axis,
      blockFillColor: mix(slot(0), ink.surface, tint),
    },
    treeView: {
      labelColor: ink.text,
      lineColor: ink.axis,
      iconColor: ink.muted,
      descriptionColor: slot(2),
      highlightBg: mix(slot(3), ink.surface, 0.2),
      highlightStroke: slot(3),
    },
    cynefin: {
      boundaryColor: ink.axis,
      arrowColor: ink.muted,
      complexBg: mix(slot(2), ink.surface, tint),
      complicatedBg: mix(slot(0), ink.surface, tint),
      chaoticBg: mix(slot(7), ink.surface, tint),
      clearBg: mix(slot(3), ink.surface, tint),
      confusionBg: mix(slot(6), ink.surface, tint),
      textColor: ink.text,
      labelColor: ink.text,
    },
    wardley: {
      backgroundColor: ink.surface,
      axisColor: ink.axis,
      axisTextColor: ink.secondary,
      gridColor: ink.grid,
      componentFill: ink.surface,
      componentStroke: slot(0),
      componentLabelColor: ink.text,
      linkStroke: ink.muted,
      evolutionStroke: slot(1),
      annotationStroke: ink.muted,
      annotationTextColor: ink.secondary,
      annotationFill: ink.surface,
    },
    emUiFill: mix(ink.axis, ink.surface, tint),
    emUiStroke: ink.axis,
    emProcessorFill: mix(slot(6), ink.surface, tint + 0.1),
    emProcessorStroke: slot(6),
    emReadModelFill: mix(slot(2), ink.surface, tint + 0.1),
    emReadModelStroke: slot(2),
    emCommandFill: mix(slot(0), ink.surface, tint + 0.1),
    emCommandStroke: slot(0),
    emEventFill: mix(slot(1), ink.surface, tint + 0.1),
    emEventStroke: slot(1),
    emSwimlaneBackgroundOdd: mix(ink.axis, ink.surface, 0.12),
    emSwimlaneBackgroundStroke: ink.grid,

    // Gantt: the default task colours are the near-black primary tints, which is why bars
    // were hard to tell from the grid.
    gridColor: ink.grid,
    taskBkgColor: mix(slot(0), ink.surface, 0.75),
    taskBorderColor: slot(0),
    taskTextColor: readableInk(mix(slot(0), ink.surface, 0.75)),
    taskTextLightColor: readableInk(mix(slot(0), ink.surface, 0.75)),
    taskTextOutsideColor: ink.text,
    activeTaskBkgColor: slot(0),
    activeTaskBorderColor: slot(0),
    doneTaskBkgColor: mix(ink.axis, ink.surface, 0.55),
    doneTaskBorderColor: ink.axis,
    critBkgColor: slot(7),
    critBorderColor: slot(7),
    todayLineColor: slot(1),
    sectionBkgColor: mix(slot(0), ink.surface, 0.12),
    altSectionBkgColor: ink.surface,
    sectionBkgColor2: mix(slot(2), ink.surface, 0.12),
  });
  return out;
}

/** Every theme variable Mermaid is given, for `themeVariables` in `mermaid.initialize`. */
export function mermaidThemeVariables(theme: DiagramTheme): Record<string, unknown> {
  return { ...BASE_VARIABLES[theme], ...chartVariables(theme) };
}

/** CSS appended to every Mermaid diagram, for the few styles a theme variable cannot reach.
 *  Sankey draws its ribbons with an inline `mix-blend-mode: multiply`, which is invisible over
 *  a dark surface (multiplying by near-black is near-black). EventModeling ships no styles at
 *  all, so its labels would be the browser's default black. */
export function mermaidThemeCss(theme: DiagramTheme): string {
  const ink = INK[theme];
  const rules = [
    `.em-swimlane text { fill: ${ink.secondary}; }`,
    `.em-box div, .em-box span, .em-box b { color: ${ink.text}; }`,
  ];
  if (theme === "dark") rules.push(".links .link { mix-blend-mode: normal !important; }");
  return rules.join(" ");
}
