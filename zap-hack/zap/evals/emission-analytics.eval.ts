import { createThread, MockTools, mock } from "@0north/zap-eval-harness";
import { describe, it, expect } from "vitest";

// The fixture is the worked example of the projection's output — exactly what the
// live tool would return. Reusing it as the mock keeps the eval in lockstep with
// the widget shape. Sandbox tools must be mocked; evals never hit the live server.
import ciiFixture from "../../../../zap-widgets/src/emission/components/westship-cii.fixture.json" assert { type: "json" };

describe("emission analytics", () => {
  it("fetches CII data and renders the emission_analytics widget", async () => {
    const tools = new MockTools()
      .mock("westship_get_emission_analytics", mock.static(ciiFixture))
      // The agent may first resolve the IMO via the built-in vessel domain — mock it
      // so either path (direct or lookup-then-fetch) succeeds.
      .mock("vessel_get_fleet_vessels", mock.static([{ name: "Westship", imo: 9831062 }]));

    const thread = await createThread({ tools });
    const result = await thread.send(
      "Show me the year-to-date CII for the vessel Westship (IMO 9831062) for 2026.",
    );

    expect(result).toHaveNoErrors();
    expect(result.toolCallNames).toContain("westship_get_emission_analytics");
    expect(result.toolCallNames).toContain("show_emission_analytics");
  });
});
