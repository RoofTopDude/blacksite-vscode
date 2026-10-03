import { describe, expect, it } from "vitest";
import {
  appendText, createChatState, createUserTurn, deliverSteers, displayedUserText, ensureParentLiveTurn, removeSteers,
  restoreConversation,
} from "../../src/webview/react/lib/chat-model";
import { steerPrompt } from "../../src/agent-session.js";

/* A message sent mid-run shows where the agent read it: the reply so far above it, the rest below. */

function liveRunWithSteer() {
  const state = createChatState();
  createUserTurn(state, "refactor the parser", null);
  const live = ensureParentLiveTurn(state, "turn_1");
  appendText(live, "Reading the parser first.");
  const steer = createUserTurn(state, "keep the public API", null);
  steer.steer = { id: "s1", state: "queued" };
  return { state, live, steer };
}

describe("mid-run messages in the transcript", () => {
  it("splits the live reply where the agent read the message", () => {
    const { state, live, steer } = liveRunWithSteer();

    deliverSteers(state, ["s1"]);

    expect(live.status).toBe("complete");
    expect(steer.steer?.state).toBe("delivered");
    const next = ensureParentLiveTurn(state);
    expect(next.id).not.toBe(live.id);
    expect(state.turns.map((turn) => turn.id)).toEqual([state.turns[0]!.id, live.id, steer.id, next.id]);
  });

  it("moves the message below output the agent produced while it was queued", () => {
    const state = createChatState();
    createUserTurn(state, "go", null);
    const steer = createUserTurn(state, "early note", null);
    steer.steer = { id: "s2", state: "queued" };
    // The live turn started after the message was typed (it was created lazily by a stream event).
    const live = ensureParentLiveTurn(state, "turn_2");
    appendText(live, "Working.");

    deliverSteers(state, ["s2"]);

    const order = state.turns.map((turn) => turn.id);
    expect(order.indexOf(live.id)).toBeLessThan(order.indexOf(steer.id));
  });

  it("takes a message the run never read back out, so the composer can have it", () => {
    const { state, steer } = liveRunWithSteer();

    const removed = removeSteers(state, ["s1"]);

    expect(removed.map((turn) => turn.text)).toEqual(["keep the public API"]);
    expect(state.turns.includes(steer)).toBe(false);
    expect(state.byId.has(steer.id)).toBe(false);
  });
});

describe("restored transcripts", () => {
  it("shows a mid-run message as the user wrote it, without the harness framing", () => {
    expect(displayedUserText(steerPrompt("keep the public API"))).toBe("keep the public API");
  });

  it("hides harness reminders, which the user never said", () => {
    expect(displayedUserText("[Internal continuation]\nBefore you finish:\n- verify")).toBeNull();
  });

  it("keeps one assistant reply across a hidden reminder, and splits it at a mid-run message", () => {
    const state = createChatState();
    restoreConversation(state, [
      { role: "user", content: "fix it" },
      { role: "assistant", content: "Fixed." },
      { role: "user", content: "[Internal continuation]\nBefore you finish:\n- verify" },
      { role: "assistant", content: "Verified." },
      { role: "user", content: steerPrompt("also update the docs") },
      { role: "assistant", content: "Docs updated." },
    ] as never);

    expect(state.turns.map((turn) => [turn.role, turn.role === "user" ? turn.text : turn.raw])).toEqual([
      ["user", "fix it"],
      ["assistant", "Fixed.Verified."],
      ["user", "also update the docs"],
      ["assistant", "Docs updated."],
    ]);
  });
});
