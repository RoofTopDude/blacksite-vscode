import { WorkspaceBar } from "@/components/WorkspaceBar";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/theme.core.css";
import "@/theme.shared.css";
import "@/theme.pau.css";
import { PauApp } from "./PauApp";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <WorkspaceBar current="pau" />
      <PauApp />
    </StrictMode>,
  );
}
