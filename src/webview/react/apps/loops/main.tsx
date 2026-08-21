import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/theme.core.css";
import "@/theme.shared.css";
import "./loops.css";
import { LoopsApp } from "./LoopsApp";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <LoopsApp />
    </StrictMode>,
  );
}
