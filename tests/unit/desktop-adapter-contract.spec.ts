/**
 * The desktop adapter contract.
 *
 * Nothing implements this yet — the value shipped here is the *authorization* decision, which is
 * the part that must not be improvised later alongside a native input dependency. These tests pin
 * the two rules that make the difference between an automation tool and a liability: an
 * application is identified by something it cannot rename itself into, and authorization is exact
 * rather than prefix-based.
 */
import { describe, expect, it } from "vitest";
import {
  desktopEntityRef,
  desktopSideEffectClass,
  isDesktopTargetAllowed,
} from "../../src/sequences/desktop-adapter.js";

const blender = { executablePath: "C:\\Program Files\\Blender\\blender.exe" };

describe("isDesktopTargetAllowed", () => {
  it("authorizes an exact executable match", () => {
    expect(isDesktopTargetAllowed(blender, [blender.executablePath], "win32")).toBe(true);
  });

  it("denies anything not on the list", () => {
    expect(isDesktopTargetAllowed(blender, ["C:\\Windows\\System32\\cmd.exe"], "win32")).toBe(false);
    expect(isDesktopTargetAllowed(blender, [], "win32")).toBe(false);
  });

  /**
   * The rule that matters most. A prefix entry like `C:\Program Files\` would authorize every
   * application beneath it — which is emphatically not what a user believes they are agreeing to
   * when they allow one program.
   */
  it("never treats a parent directory as authorization for what is inside it", () => {
    expect(isDesktopTargetAllowed(blender, ["C:\\Program Files\\"], "win32")).toBe(false);
    expect(isDesktopTargetAllowed(blender, ["C:\\Program Files"], "win32")).toBe(false);
  });

  it("normalizes separators and case on Windows, where both are insignificant", () => {
    expect(isDesktopTargetAllowed(blender, ["c:/program files/blender/BLENDER.exe"], "win32")).toBe(true);
  });

  /** Case is significant on POSIX, so two paths differing only in case are two different files. */
  it("keeps case significant off Windows", () => {
    const target = { executablePath: "/opt/Blender/blender" };
    expect(isDesktopTargetAllowed(target, ["/opt/Blender/blender"], "linux")).toBe(true);
    expect(isDesktopTargetAllowed(target, ["/opt/blender/blender"], "linux")).toBe(false);
  });

  it("ignores blank entries rather than letting one authorize everything", () => {
    expect(isDesktopTargetAllowed(blender, ["", "   "], "win32")).toBe(false);
    expect(isDesktopTargetAllowed({ executablePath: "  " }, ["  "], "win32")).toBe(false);
  });

  /** A window title is attacker-controlled text; matching on it would let any process
   *  impersonate an allowed application by renaming its window. It must never grant access. */
  it("does not authorize on window title", () => {
    const impostor = { executablePath: "C:\\Temp\\evil.exe", windowTitlePattern: "Blender" };
    expect(isDesktopTargetAllowed(impostor, [blender.executablePath], "win32")).toBe(false);
  });
});

describe("desktopSideEffectClass", () => {
  /**
   * Flat and pessimistic on purpose: the browser classifier can tell a read from a write because
   * it knows what each action does to a page, and nothing here knows what an arbitrary
   * application does with a click.
   */
  it("treats every input as an external mutation", () => {
    for (const kind of ["mouse_path", "drag", "hover", "scroll", "key"] as const) {
      expect(desktopSideEffectClass(kind), kind).toBe("external_mutation");
    }
  });

  it("treats a capture as the one genuine read", () => {
    expect(desktopSideEffectClass("capture")).toBe("workspace_read");
  });
});

describe("desktopEntityRef", () => {
  it("identifies the target by the same value the allow-list is keyed on", () => {
    expect(desktopEntityRef(blender)).toEqual({
      scheme: "external-app",
      id: blender.executablePath,
    });
  });
});
