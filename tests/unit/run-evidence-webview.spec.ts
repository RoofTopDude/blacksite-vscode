import { describe, expect, it } from "vitest";
import { readPlanningDocument } from "@/apps/planning/types";
import { readTicketsState } from "@/apps/tickets/types";

describe("run evidence webview protocol readers", () => {
  it("preserves plan phase run references and supplies evidence collection defaults", () => {
    const document = readPlanningDocument({
      plans: [{
        id: "plan-1",
        title: "Ship it",
        status: "active",
        phases: [{
          id: "phase-1",
          title: "Verify",
          status: "in_progress",
          steps: [],
          runEvidence: {
            runIds: ["run-baseline", "run-latest"],
            latestRunId: "run-latest",
            baselineRunId: "run-baseline",
            latestSuccessfulRunId: "run-baseline",
            unresolvedAnomalyIds: ["obs-regression"],
          },
        }],
      }],
      todoRuns: [],
    });

    expect(document.plans[0]?.phases[0]?.runEvidence).toEqual({
      runIds: ["run-baseline", "run-latest"],
      latestRunId: "run-latest",
      baselineRunId: "run-baseline",
      latestSuccessfulRunId: "run-baseline",
      acceptedObservationIds: [],
      unresolvedAnomalyIds: ["obs-regression"],
    });
  });

  it("preserves ticket run IDs and defaults older tickets to an empty list", () => {
    const state = readTicketsState({
      tickets: [
        { id: "BLK-1", runIds: ["run-1", "run-2"] },
        { id: "BLK-2" },
      ],
    });

    expect(state.tickets[0]?.runIds).toEqual(["run-1", "run-2"]);
    expect(state.tickets[1]?.runIds).toEqual([]);
  });
});
