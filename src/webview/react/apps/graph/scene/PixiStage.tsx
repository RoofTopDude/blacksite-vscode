/* Thin React wrapper that owns the pixi canvas lifecycle. All rendering logic
   lives in renderer.ts; React only mounts it once and streams state in. */

import { useEffect, useRef } from "react";
import { createGraphRenderer, type GraphRenderer } from "./renderer";
import { actions } from "../store";
import type { GraphViewState } from "@/lib/graph/view-model";

export function PixiStage({ view, onRenderer }: { view: GraphViewState; onRenderer?: (renderer: GraphRenderer | null) => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<GraphRenderer | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const renderer = createGraphRenderer(host, {
      onHover: (id) => actions.hover(id),
      onSelect: (id) => actions.select(id),
      onOpen: (id) => actions.openFile(id),
      onCameraChange: (camera) => actions.cameraMoved(camera),
    });
    rendererRef.current = renderer;
    onRenderer?.(renderer);
    return () => {
      rendererRef.current = null;
      onRenderer?.(null);
      renderer.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    rendererRef.current?.setState(view);
  }, [view]);

  return <div ref={hostRef} className="absolute inset-0 overflow-hidden" />;
}
