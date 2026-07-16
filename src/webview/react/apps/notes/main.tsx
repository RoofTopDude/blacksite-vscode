import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/theme.css";
import { NotesApp } from "./NotesApp";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <NotesApp />
    </StrictMode>,
  );
}
