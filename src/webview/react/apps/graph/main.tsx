import { WorkspaceBar } from "@/components/WorkspaceBar";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/theme.core.css";
import "@/theme.shared.css";
import "@/theme.map.css";
import { GraphApp } from "./GraphApp";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <WorkspaceBar current="map" />
      <GraphApp />
    </StrictMode>,
  );
}
