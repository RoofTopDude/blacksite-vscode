import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/theme.css";
import { GraphApp } from "./GraphApp";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <GraphApp />
    </StrictMode>,
  );
}
