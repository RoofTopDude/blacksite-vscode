import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/theme.css";
import { DataApp } from "./DataApp";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <DataApp />
    </StrictMode>,
  );
}
