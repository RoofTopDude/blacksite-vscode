import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type * as vscode from "vscode";
import type { ExternalApplicationBinding } from "../runs/run-model.js";
import type { DesktopCaptureAdapter, DesktopCaptureResult, DesktopWindowCandidate, DesktopWindowResolver } from "./desktop-adapter.js";

const execFileAsync = promisify(execFile);
const BINDINGS_KEY = "blacksite.externalApplicationBindings.v1";

interface StoredBinding extends ExternalApplicationBinding {
  executablePath: string;
  processId?: number;
}

const HELPER = String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Diagnostics; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.Text;
public class BlacksiteWindowCapture {
  public class Info { public long Handle; public int ProcessId; public string Title; public string ExecutablePath; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out int p);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int n);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L,T,R,B; }
  public static List<Info> List() { var o=new List<Info>(); EnumWindows((h,l)=>{ if(!IsWindowVisible(h)) return true; var s=new StringBuilder(1024); if(GetWindowText(h,s,s.Capacity)<=0) return true; int pid; GetWindowThreadProcessId(h,out pid); try { var p=Process.GetProcessById(pid); o.Add(new Info{Handle=h.ToInt64(),ProcessId=pid,Title=s.ToString(),ExecutablePath=p.MainModule.FileName}); } catch {} return true; },IntPtr.Zero); return o; }
  public static void Capture(string exe, int pid, string output) { var m=List().FindAll(x=>String.Equals(x.ExecutablePath,exe,StringComparison.OrdinalIgnoreCase)&&(pid<=0||x.ProcessId==pid)); if(m.Count!=1) throw new Exception(m.Count==0?"Target window is unavailable or unauthorized.":"Target window is ambiguous."); var h=new IntPtr(m[0].Handle); RECT r; if(DwmGetWindowAttribute(h,9,out r,Marshal.SizeOf(typeof(RECT)))!=0) throw new Exception("Could not resolve target bounds."); int w=r.R-r.L,hg=r.B-r.T; if(w<=0||hg<=0) throw new Exception("Target window has invalid bounds."); using(var b=new Bitmap(w,hg,PixelFormat.Format32bppArgb)) using(var g=Graphics.FromImage(b)){ var dc=g.GetHdc(); bool ok=false; try{ok=PrintWindow(h,dc,2);}finally{g.ReleaseHdc(dc);} if(!ok) throw new Exception("The selected window refused capture."); b.Save(output,ImageFormat.Png); } }
}
'@
if ($env:BS_MODE -eq 'list') { [BlacksiteWindowCapture]::List() | ConvertTo-Json -Compress -Depth 3; exit }
[BlacksiteWindowCapture]::Capture($env:BS_EXE, [int]($env:BS_PID), $env:BS_OUT)
`;

export class WindowsDesktopCaptureService implements DesktopWindowResolver, DesktopCaptureAdapter {
  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly workspaceRoot: string,
  ) {}

  available(): boolean { return process.platform === "win32"; }

  bindings(): Array<{ id: string; label: string }> {
    return this.readBindings().map(({ id, label }) => ({ id, label }));
  }

  async enumerateForUser(signal?: AbortSignal): Promise<DesktopWindowCandidate[]> {
    this.requireWindows();
    const stdout = await this.runHelper({ BS_MODE: "list" }, signal);
    if (!stdout.trim()) return [];
    const parsed: unknown = JSON.parse(stdout);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.flatMap((value): DesktopWindowCandidate[] => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      const executablePath = String(item["ExecutablePath"] ?? "");
      const title = String(item["Title"] ?? "");
      const processId = Number(item["ProcessId"]);
      return executablePath && title && Number.isSafeInteger(processId) ? [{ executablePath, title, processId }] : [];
    });
  }

  async authorize(candidate: DesktopWindowCandidate, label: string): Promise<ExternalApplicationBinding> {
    this.requireWindows();
    const bindings = this.readBindings();
    const now = new Date().toISOString();
    const stored: StoredBinding = {
      id: `external-app-${randomUUID()}`,
      label: label.trim().slice(0, 120) || path.basename(candidate.executablePath),
      executablePath: path.resolve(candidate.executablePath),
      processId: candidate.processId,
      createdAt: now,
      updatedAt: now,
    };
    bindings.push(stored);
    await this.workspaceState.update(BINDINGS_KEY, bindings);
    return { id: stored.id, label: stored.label, createdAt: now, updatedAt: now };
  }

  async capture(request: { bindingId: string; label?: string }, signal?: AbortSignal): Promise<DesktopCaptureResult> {
    this.requireWindows();
    const binding = this.readBindings().find((candidate) => candidate.id === request.bindingId);
    if (!binding) throw new Error("External application binding is unavailable or not approved.");
    const tempDirectory = path.join(this.workspaceRoot, ".blacksite", "runs", "tmp");
    fs.mkdirSync(tempDirectory, { recursive: true });
    const output = path.join(tempDirectory, `external-${randomUUID()}.png`);
    try {
      await this.runHelper({
        BS_MODE: "capture",
        BS_EXE: binding.executablePath,
        BS_PID: String(binding.processId ?? 0),
        BS_OUT: output,
      }, signal);
      const data = fs.readFileSync(output);
      if (data.length === 0) throw new Error("External application capture was empty.");
      return { bindingId: binding.id, label: request.label?.trim() || binding.label, data, capturedAt: new Date().toISOString() };
    } finally {
      try { fs.unlinkSync(output); } catch { /* best-effort isolated temporary frame */ }
    }
  }

  private readBindings(): StoredBinding[] {
    const value = this.workspaceState.get<unknown>(BINDINGS_KEY, []);
    return Array.isArray(value) ? value.filter((item): item is StoredBinding => Boolean(
      item && typeof item === "object" && typeof (item as StoredBinding).id === "string"
      && typeof (item as StoredBinding).label === "string" && typeof (item as StoredBinding).executablePath === "string",
    )) : [];
  }

  private requireWindows(): void {
    if (!this.available()) throw new Error("External application capture is available on Windows only.");
  }

  private async runHelper(environment: Record<string, string>, signal?: AbortSignal): Promise<string> {
    const encoded = Buffer.from(HELPER, "utf16le").toString("base64");
    const result = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      env: { ...process.env, ...environment },
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
      ...(signal ? { signal } : {}),
    });
    return result.stdout;
  }
}
