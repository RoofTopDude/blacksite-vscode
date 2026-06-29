import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/theme.css";
import { BaseContextApp } from "./BaseContextApp";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <BaseContextApp />
    </StrictMode>,
  );
}
