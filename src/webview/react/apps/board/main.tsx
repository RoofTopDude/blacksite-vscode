import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/theme.css";
import { BoardApp } from "./BoardApp";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <BoardApp />
    </StrictMode>,
  );
}
