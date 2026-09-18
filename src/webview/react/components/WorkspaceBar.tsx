import { useEffect, useState } from "react";
import { ArrowLeft, ChevronDown, LayoutGrid } from "lucide-react";
import { Popover } from "radix-ui";
import { Button } from "@/components/ui/button";
import { onMessage, post, readUiState, writeUiState } from "@/lib/bridge";
import { WORKSPACE_DESTINATIONS, isWorkspaceDestination, type InterfaceDensity, type WorkspaceDestination } from "../../../shared/workspace-navigation";

export function WorkspaceBar({ current }: { current: WorkspaceDestination }) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<WorkspaceDestination[]>([]);
  const [density, setDensity] = useState<InterfaceDensity>(() => readUiState("interface", { density: "comfortable" as InterfaceDensity }).density);
  const [error, setError] = useState("");
  useEffect(() => {
    const off = onMessage((msg) => {
      if (msg.type === "workspace_ui_state") {
        setDensity(msg.density === "compact" ? "compact" : "comfortable");
        setRecent(Array.isArray(msg.recent) ? msg.recent.filter(isWorkspaceDestination) : []);
      }
      if (msg.type === "workspace_ui_error") setError(String(msg.message));
    });
    post({ type: "workspace_ui_ready" });
    return off;
  }, []);
  useEffect(() => {
    document.documentElement.dataset.workspace = current;
    document.documentElement.dataset.density = density;
    writeUiState("interface", { density });
  }, [density, current]);
  function navigate(destination: WorkspaceDestination) {
    setError("");
    setOpen(false);
    post({ type: "workspace_navigate", source: current, destination });
  }
  const previous = recent.find((id) => id !== current);
  const label = (id: WorkspaceDestination) => WORKSPACE_DESTINATIONS.find((entry) => entry.id === id)!.label;
  return (
    <nav className="workspace-bar" aria-label="Blacksite workspace">
      {previous && <Button variant="ghost" size="icon-sm" aria-label={`Back to ${label(previous)}`} title={`Back to ${label(previous)}`} onClick={() => navigate(previous)}><ArrowLeft /></Button>}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button variant="ghost" size="sm" aria-label="Switch workspace view"><LayoutGrid /><span>{label(current)}</span><ChevronDown /></Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="workspace-popover" align="start" sideOffset={6} collisionPadding={8} aria-label="Workspace views">
            {recent.some((id) => id !== current) && <>
              <div className="workspace-menu-heading">Recent</div>
              {recent.filter((id) => id !== current).slice(0, 3).map((id) => <Button key={id} variant="ghost" onClick={() => navigate(id)}>{label(id)}</Button>)}
            </>}
            <div className="workspace-menu-heading">All views</div>
            {WORKSPACE_DESTINATIONS.map((entry) => <Button key={entry.id} variant={entry.id === current ? "secondary" : "ghost"} aria-current={entry.id === current ? "page" : undefined} onClick={() => navigate(entry.id)}>{entry.label}</Button>)}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <label className="workspace-density">Text
        <select aria-label="Interface density" value={density} onChange={(event) => {
          const value = event.target.value as InterfaceDensity;
          setDensity(value);
          post({ type: "workspace_density", density: value });
        }}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select>
      </label>
      {error && <span className="workspace-error" role="alert">{error}</span>}
    </nav>
  );
}

export function RelatedWork({ destination, entityId, children }: { destination: WorkspaceDestination; entityId: string; children: React.ReactNode }) {
  return <Button variant="outline" size="sm" className="min-w-0 max-w-full" title={entityId} onClick={() => post({ type: "workspace_navigate", source: document.documentElement.dataset.workspace, destination, entityId })}><span className="truncate">{children}</span></Button>;
}
