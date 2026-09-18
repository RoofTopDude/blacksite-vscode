import { WorkspaceBar } from "@/components/WorkspaceBar";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/theme.core.css";
import "@/theme.shared.css";
import "@/theme.data.css";
import { DataApp } from "./DataApp";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <WorkspaceBar current="data" />
      <DataApp />
    </StrictMode>,
  );
}
