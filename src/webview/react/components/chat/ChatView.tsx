import { useStore } from "@/lib/store";
import { Overview } from "./Overview";
import { Inspector } from "./Inspector";
import { Transcript } from "./Transcript";
import { InputDock } from "./InputDock";

export function ChatView() {
  const store = useStore();
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Overview />
      {store.inspectorOpen && <Inspector />}
      <Transcript />
      <InputDock />
    </div>
  );
}
