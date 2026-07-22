import { useEffect } from "react";
import { initStore, useStore } from "@/lib/store";
import { Header } from "@/components/Header";
import { Lightbox } from "@/components/Lightbox";
import { PreviewModal } from "@/components/chat/PreviewModal";
import { ChatView } from "@/components/chat/ChatView";
import { HistoryView } from "@/components/HistoryView";
import { SettingsView } from "@/components/settings/SettingsView";
import type { ActiveRequestMode } from "@/lib/protocol";

export function App() {
  const store = useStore();
  useEffect(() => { initStore(); }, []);
  const selectedMode: ActiveRequestMode = store.requestMode === "auto" ? "general" : store.requestMode;
  const requestMode = store.view === "chat" && store.chat.running
    ? (store.chat.sessionRuntime?.activeRequestMode ?? selectedMode)
    : store.view === "chat" ? selectedMode : "general";

  return (
    <>
      <div className="request-mode-shell flex min-h-0 flex-1 flex-col" data-request-mode={requestMode}>
        <Header requestMode={requestMode} />
        {store.view === "chat" && <ChatView />}
        {store.view === "history" && <HistoryView />}
        {store.view === "settings" && <SettingsView />}
      </div>
      <Lightbox />
      <PreviewModal />
    </>
  );
}
