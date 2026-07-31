import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/theme.css";
import "./theater.css";
import { RunTheater } from "./RunTheater";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <RunTheater />
    </StrictMode>,
  );
}
