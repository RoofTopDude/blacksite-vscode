import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

/* Deliberately not theme.chat.css, like every panel other than the chat. The palette still
   arrives (vite-plugin-css-injected-by-js injects the combined CSS into every entry), but
   importing it here would share it between two entries, re-split the CSS chunks, and move
   Tailwind's self-referencing @theme font tokens after the palette's real ones — which silently
   drops Lexend and the monospace stack in every panel. */
import "@/theme.core.css";
import "@/theme.shared.css";
import "./diagram.css";
import { DiagramApp } from "./DiagramApp";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <DiagramApp />
    </StrictMode>,
  );
}
