import { useEffect } from "react";
import { initStore, useStore } from "@/lib/store";
import { requestResearchState } from "@/lib/research-store";
import { Header } from "@/components/Header";
import { BrowserApprovalJumpBar, BrowserDelegationBanner } from "@/components/chat/BrowserApprovals";
import { Lightbox } from "@/components/Lightbox";
import { PreviewModal } from "@/components/chat/PreviewModal";
import { ChatView } from "@/components/chat/ChatView";
import { HistoryView } from "@/components/HistoryView";
import { SettingsView } from "@/components/settings/SettingsView";
import type { ActiveRequestMode } from "@/lib/protocol";

export function App() {
  const store = useStore();
  // The host pushes research state on "ready" too; asking once on mount covers a webview
  // that was rebuilt (reload, moved between side bars) while a proposal was already open.
  useEffect(() => { initStore(); requestResearchState(); }, []);
  const selectedMode: ActiveRequestMode = store.requestMode === "auto" ? "general" : store.requestMode;
  const requestMode = store.view === "chat" && store.chat.running
    ? (store.chat.sessionRuntime?.activeRequestMode ?? selectedMode)
    : store.view === "chat" ? selectedMode : "general";

  return (
    <>
      <div className="request-mode-shell flex min-h-0 flex-1 flex-col" data-request-mode={requestMode}>
        <Header requestMode={requestMode} />
        {/* Standing state and off-chat escalation. The approvals themselves live in the chat's
            docked action bar alongside every other pending decision. */}
        <BrowserDelegationBanner />
        <BrowserApprovalJumpBar />
        {store.view === "chat" && <ChatView />}
        {store.view === "history" && <HistoryView />}
        {store.view === "settings" && <SettingsView />}
      </div>
      <Lightbox />
      <PreviewModal />
    </>
  );
}
