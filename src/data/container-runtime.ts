// Container lifecycle abstraction for the optional sidecar.
//
// Containers are power-user infrastructure, never a base requirement. This wraps
// docker/podman behind a small interface and takes an injected `CommandRunner`, so
// it is testable without a daemon and reuses whatever shell capability the host
// already allowlists (the local runtime risk-classifies docker/podman/compose).

import { execFile } from "node:child_process";
import {
  parseSidecarHealth,
  type ContainerProfile,
  type SidecarStatus,
} from "./postgres-pgvector-profile.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export type ContainerEngine = "docker" | "podman";

/** Default runner backed by child_process; injected runners are used in tests. */
export const defaultCommandRunner: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });

export class ContainerRuntime {
  private _engine: ContainerEngine | null = null;

  constructor(private readonly run: CommandRunner = defaultCommandRunner) {}

  /** Detect an available container engine, preferring docker. Caches the result. */
  async detectEngine(): Promise<ContainerEngine | null> {
    if (this._engine) return this._engine;
    for (const engine of ["docker", "podman"] as const) {
      const result = await this.run(engine, ["--version"]).catch(() => null);
      if (result && result.code === 0) {
        this._engine = engine;
        return engine;
      }
    }
    return null;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.detectEngine()) !== null;
  }

  /** Create-and-start (or start an existing) container for the profile. */
  async up(profile: ContainerProfile): Promise<{ ok: boolean; message: string }> {
    const engine = await this.detectEngine();
    if (!engine) return { ok: false, message: "No container engine (docker/podman) detected." };

    const existing = await this.status(profile);
    if (existing.health !== "missing") {
      const start = await this.run(engine, ["start", profile.id]);
      return { ok: start.code === 0, message: start.code === 0 ? "Started existing container." : start.stderr.trim() };
    }

    const args = ["run", "-d", "--name", profile.id];
    for (const port of profile.ports) args.push("-p", `${port.host}:${port.container}`);
    for (const [key, value] of Object.entries(profile.env)) args.push("-e", `${key}=${value}`);
    args.push(profile.image);

    const result = await this.run(engine, args);
    return { ok: result.code === 0, message: result.code === 0 ? "Container created." : result.stderr.trim() };
  }

  async stop(profile: ContainerProfile): Promise<{ ok: boolean; message: string }> {
    const engine = await this.detectEngine();
    if (!engine) return { ok: false, message: "No container engine detected." };
    const result = await this.run(engine, ["stop", profile.id]);
    return { ok: result.code === 0, message: result.code === 0 ? "Stopped." : result.stderr.trim() };
  }

  async remove(profile: ContainerProfile): Promise<{ ok: boolean; message: string }> {
    const engine = await this.detectEngine();
    if (!engine) return { ok: false, message: "No container engine detected." };
    const result = await this.run(engine, ["rm", "-f", profile.id]);
    return { ok: result.code === 0, message: result.code === 0 ? "Removed." : result.stderr.trim() };
  }

  /** Inspect the container's normalized health. */
  async status(profile: ContainerProfile): Promise<SidecarStatus> {
    const engine = await this.detectEngine();
    if (!engine) return { health: "missing", running: false, detail: "No container engine detected." };
    const result = await this.run(engine, [
      "inspect",
      "--format",
      "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}",
      profile.id,
    ]);
    if (result.code !== 0) return parseSidecarHealth(result.stderr || result.stdout);
    return parseSidecarHealth(result.stdout);
  }

  /** Tail recent container logs. */
  async logs(profile: ContainerProfile, tail = 100): Promise<string> {
    const engine = await this.detectEngine();
    if (!engine) return "";
    const result = await this.run(engine, ["logs", "--tail", String(tail), profile.id]);
    return result.stdout || result.stderr;
  }
}
