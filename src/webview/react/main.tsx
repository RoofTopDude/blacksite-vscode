import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import "./theme.css";
import { App } from "./App";

interface BoundaryState { error: Error | null }

/** Keep a render-time UI exception from blanking the entire chat webview. */
class ChatErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Blacksite chat render failed", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <main style={{ padding: 16, fontFamily: "sans-serif", color: "var(--foreground, #ddd)" }}>
          <h2>Chat recovered from a display error</h2>
          <p>The run is protected. Reload the chat surface to continue.</p>
          <button type="button" onClick={() => window.location.reload()}>Reload chat</button>
        </main>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <ChatErrorBoundary>
        <App />
      </ChatErrorBoundary>
    </StrictMode>,
  );
}
