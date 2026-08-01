import { describe, expect, it } from "vitest";
import {
  compileSequence,
  SequenceValidationError,
} from "../../src/sequences/sequence-compiler";

function workspaceSequence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Inspect workspace",
    target: { adapter: "workspace", workspace: "current" },
    steps: [
      {
        id: "read-package",
        action: "read_file",
        params: { path: "package.json" },
        capture: true,
        checkpoint: true,
        entity_refs: [{
          scheme: "workspace-file",
          id: "package.json",
          workspacePath: "package.json",
        }],
        assertions: [{ type: "result_ok" }],
      },
      {
        id: "search-source",
        adapter: "workspace",
        action: "search_files",
        params: { path: "src", pattern: "SequenceService" },
        depends_on: ["read-package"],
      },
    ],
    failure_policy: { mode: "continue_safe", retain_partial: true },
    limits: {
      max_steps: 12,
      max_duration_ms: 60_000,
      max_artifact_bytes: 1_024,
    },
    retention_class: "pinned",
    lane_id: "lane-1",
    ...overrides,
  };
}

describe("compileSequence", () => {
  it("normalizes the tool payload into a bounded linear definition", () => {
    const compiled = compileSequence(workspaceSequence({
      plan_id: "plan-1",
      phase_id: "phase-2",
      ticket_ids: ["BLK-1"],
    }));

    expect(compiled).toMatchObject({
      retentionClass: "pinned",
      laneId: "lane-1",
      definition: {
        title: "Inspect workspace",
        target: {
          adapterId: "workspace",
          workspacePath: ".",
        },
        failurePolicy: "continue_safe",
        planId: "plan-1",
        phaseId: "phase-2",
        ticketIds: ["BLK-1"],
        limits: {
          maxSteps: 12,
          timeoutMs: 60_000,
          maxArtifactBytes: 1_024,
        },
      },
    });
    expect(compiled.steps[0]).toMatchObject({
      adapterId: "workspace",
      capture: true,
      definition: {
        id: "read-package",
        checkpoint: true,
        captureProfile: "standard",
        action: {
          type: "read_file",
          adapterId: "workspace",
          input: { path: "package.json" },
        },
      },
    });
    expect(compiled.steps[1]?.definition.dependsOn).toEqual(["read-package"]);
    expect(compiled.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(compileSequence(workspaceSequence()).fingerprint).toBe(
      compileSequence(workspaceSequence()).fingerprint,
    );
  });

  it("normalizes the browser type alias and accepts loopback targets", () => {
    const compiled = compileSequence({
      title: "Local form",
      target: { adapter: "browser", entrypoint: "http://localhost:4173/" },
      steps: [{
        id: "fill-name",
        action: "type",
        params: { selector: "#name", text: "Ada" },
      }],
    });

    expect(compiled.steps[0]?.definition.action.type).toBe("type_text");
    expect(compiled.steps[0]).toMatchObject({
      capture: true,
      definition: { captureProfile: "standard" },
    });
    expect(compiled.definition.target.configuration).toEqual({
      entrypoint: "http://localhost:4173/",
    });

    const minimal = compileSequence({
      title: "Minimal browser evidence",
      target: { adapter: "browser", entrypoint: "http://localhost:4173/" },
      steps: [{ id: "open", action: "navigate", params: { url: "http://localhost:4173/" } }],
      capture_profile: "minimal",
    });
    expect(minimal.steps[0]).toMatchObject({ capture: false });
    expect(minimal.steps[0]?.definition.captureProfile).toBeUndefined();
  });

  it("accepts the IPv6 loopback host", () => {
    expect(() => compileSequence({
      title: "IPv6 local app",
      target: { adapter: "browser", entrypoint: "http://[::1]:4173/" },
      steps: [{
        id: "open",
        action: "navigate",
        params: { url: "http://[::1]:4173/settings" },
      }],
    })).not.toThrow();
  });

  it.each([
    {
      label: "capture profile",
      patch: { capture_profile: "cinematic" },
      issue: /unsupported capture_profile 'cinematic'/i,
    },
    {
      label: "failure policy",
      patch: { failure_policy: { mode: "retry_forever", retain_partial: true } },
      issue: /unsupported failure policy 'retry_forever'/i,
    },
    {
      label: "discarded partial evidence",
      patch: { failure_policy: { mode: "stop_and_capture", retain_partial: false } },
      issue: /retain_partial=false is unsupported/i,
    },
    {
      label: "missing action input",
      patch: { steps: [{ id: "read", action: "read_file", params: {} }] },
      issue: /requires a non-empty 'path'.*workspace:read_file/i,
    },
    {
      label: "unsupported assertion",
      patch: {
        steps: [{
          id: "read",
          action: "read_file",
          params: { path: "package.json" },
          assertions: [{ type: "looks_good" }],
        }],
      },
      issue: /unsupported assertion 'looks_good'/i,
    },
  ])("rejects an invalid $label", ({ patch, issue }) => {
    expect(() => compileSequence(workspaceSequence(patch)))
      .toThrowError(expect.objectContaining<Partial<SequenceValidationError>>({
        message: expect.stringMatching(issue),
      }));
  });

  it.each([
    {
      name: "unsupported actions",
      patch: {
        steps: [{ id: "mutate", action: "write_file", params: { path: "x" } }],
      },
      issue: /unsupported workspace action 'write_file'/i,
    },
    {
      name: "forward dependencies",
      patch: {
        steps: [
          { id: "second", action: "read_file", depends_on: ["first"] },
          { id: "first", action: "read_file" },
        ],
      },
      issue: /depends on 'first'.*not an earlier step/i,
    },
    {
      name: "duplicate step ids",
      patch: {
        steps: [
          { id: "same", action: "read_file" },
          { id: "same", action: "read_file" },
        ],
      },
      issue: /duplicate step id 'same'/i,
    },
    {
      name: "incomplete plan links",
      patch: { plan_id: "plan-1" },
      issue: /plan_id and phase_id must be provided together/i,
    },
    {
      name: "declared step bounds",
      patch: {
        limits: { max_steps: 1 },
        steps: [
          { id: "one", action: "read_file" },
          { id: "two", action: "read_file" },
        ],
      },
      issue: /exceeding its max_steps limit of 1/i,
    },
  ])("rejects $name", ({ patch, issue }) => {
    expect(() => compileSequence(workspaceSequence(patch)))
      .toThrowError(expect.objectContaining<Partial<SequenceValidationError>>({
        name: "SequenceValidationError",
        message: expect.stringMatching(issue),
      }));
  });

  it("rejects remote browser origins and secret-bearing evaluate scripts", () => {
    expect(() => compileSequence({
      title: "Remote mutation",
      target: { adapter: "browser", entrypoint: "https://example.com/app?token=secret" },
      steps: [{
        id: "read-secret",
        action: "evaluate",
        params: { script: "fetch('/api'); return document.cookie;" },
      }],
    })).toThrowError(expect.objectContaining<Partial<SequenceValidationError>>({
      message: expect.stringMatching(/limited to loopback[\s\S]*network or secret-bearing APIs/i),
    }));
  });

  it("limits collect_all to independent read-only diagnostics", () => {
    expect(() => compileSequence({
      title: "Unsafe collection",
      target: { adapter: "browser", entrypoint: "http://localhost:4173/" },
      steps: [{
        id: "submit",
        action: "click",
        params: { selector: "button[type=submit]" },
      }],
      failure_policy: { mode: "collect_all", retain_partial: true },
    })).toThrowError(expect.objectContaining<Partial<SequenceValidationError>>({
      message: expect.stringMatching(/collect_all[\s\S]*(read-only|diagnostic|independent)/i),
    }));

    expect(() => compileSequence({
      title: "Read-only collection",
      target: { adapter: "workspace", workspace: "current" },
      steps: [
        { id: "one", action: "read_file", params: { path: "one.txt" } },
        { id: "two", action: "glob", params: { path: ".", pattern: "*.txt" } },
      ],
      failure_policy: { mode: "collect_all", retain_partial: true },
    })).not.toThrow();

    expect(() => compileSequence({
      title: "Dependent collection",
      target: { adapter: "workspace", workspace: "current" },
      steps: [
        { id: "one", action: "read_file", params: { path: "one.txt" } },
        {
          id: "two",
          action: "read_file",
          params: { path: "two.txt" },
          depends_on: ["one"],
        },
      ],
      failure_policy: { mode: "collect_all", retain_partial: true },
    })).toThrowError(expect.objectContaining<Partial<SequenceValidationError>>({
      message: expect.stringMatching(/collect_all[\s\S]*independent/i),
    }));
  });

  it("enforces capture-only desktop sequences with an approved opaque binding", () => {
    expect(() => compileSequence({
      title: "Read external viewport",
      target: { adapter: "desktop" },
      steps: [{ id: "capture", action: "capture", params: { binding_id: "external-app-approved" } }],
    })).not.toThrow();
    expect(() => compileSequence({
      title: "Prohibited external input",
      target: { adapter: "desktop" },
      steps: [{ id: "click", action: "click", params: { binding_id: "external-app-approved" } }],
    })).toThrow(/unsupported desktop action 'click'/i);
    expect(() => compileSequence({
      title: "Unbound capture",
      target: { adapter: "desktop" },
      steps: [{ id: "capture", action: "capture", params: {} }],
    })).toThrow(/binding_id/i);
  });
});
