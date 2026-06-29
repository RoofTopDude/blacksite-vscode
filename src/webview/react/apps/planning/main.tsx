import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/theme.css";
import { PlanningApp } from "./PlanningApp";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <PlanningApp />
    </StrictMode>,
  );
}
