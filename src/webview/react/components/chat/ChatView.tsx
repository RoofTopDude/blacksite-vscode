import { useState } from "react";
import type { StarterPrompt } from "./StarterPrompts";
import { useStore } from "@/lib/store";
import { Overview } from "./Overview";
import { Inspector } from "./Inspector";
import { Transcript } from "./Transcript";
import { InputDock } from "./InputDock";

export function ChatView() {
  const store = useStore();
  const [starter, setStarter] = useState<StarterPrompt | null>(null);
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Overview />
      {store.inspectorOpen && <Inspector />}
      <Transcript onStarter={setStarter} />
      <InputDock starter={starter} />
    </div>
  );
}
