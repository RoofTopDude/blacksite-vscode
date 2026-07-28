import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/theme.css";
import { TicketsApp } from "./TicketsApp";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <TicketsApp />
    </StrictMode>,
  );
}
