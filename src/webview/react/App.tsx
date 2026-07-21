import { useEffect } from "react";
import { initStore, useStore } from "@/lib/store";
import { Header } from "@/components/Header";
import { Lightbox } from "@/components/Lightbox";
import { PreviewModal } from "@/components/chat/PreviewModal";
import { ChatView } from "@/components/chat/ChatView";
import { HistoryView } from "@/components/HistoryView";
import { SettingsView } from "@/components/settings/SettingsView";

export function App() {
  const store = useStore();
  useEffect(() => { initStore(); }, []);

  return (
    <>
      <Header />
      {store.view === "chat" && <ChatView />}
      {store.view === "history" && <HistoryView />}
      {store.view === "settings" && <SettingsView />}
      <Lightbox />
      <PreviewModal />
    </>
  );
}
