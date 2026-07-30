import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/theme.css";
import "./runs.css";
import { RunExplorer } from "./RunExplorer";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <RunExplorer />
    </StrictMode>,
  );
}
