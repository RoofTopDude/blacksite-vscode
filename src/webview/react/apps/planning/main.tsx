import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/theme.core.css";
import "@/theme.shared.css";
import "@/theme.planning.css";
import { PlanningApp } from "./PlanningApp";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <PlanningApp />
    </StrictMode>,
  );
}
