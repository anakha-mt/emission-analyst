import { createThread, MockTools, mock } from "@0north/zap-eval-harness";
import { describe, it, expect } from "vitest";

// Each fixture is the worked example of its projection's output — exactly what the
// live tool would return. Reusing them as the mocks keeps the evals in lockstep with
// the widget shapes. Sandbox tools must be mocked; evals never hit the live server.
import euEtsFixture from "../../../widgets/src/emission/components/westship-eu-ets.fixture.json" assert { type: "json" };
import fleetSummaryFixture from "../../../widgets/src/emission/components/westship-fleet-summary.fixture.json" assert { type: "json" };
import fuelConsumptionFixture from "../../../widgets/src/emission/components/westship-fuel-consumption.fixture.json" assert { type: "json" };

// The agent may first resolve the IMO via the built-in vessel domain — mock it so
// either path (direct or lookup-then-fetch) succeeds.
const vesselLookup = mock.static([{ name: "Westship", imo: 9831062 }]);

describe("vessel-details emission widgets", () => {
  it("fetches EU ETS data and renders the emission_eu_ets widget", async () => {
    const tools = new MockTools()
      .mock("westship_get_eu_ets", mock.static(euEtsFixture))
      .mock("vessel_get_fleet_vessels", vesselLookup);

    const thread = await createThread({ tools });
    const result = await thread.send("Show the EU ETS exposure for the vessel Westship (IMO 9831062) for 2026.");

    expect(result).toHaveNoErrors();
    expect(result.toolCallNames).toContain("westship_get_eu_ets");
    expect(result.toolCallNames).toContain("show_emission_eu_ets");
  });

  it("fetches fuel consumption and renders the emission_fuel_consumption widget", async () => {
    const tools = new MockTools()
      .mock("westship_get_fuel_consumption", mock.static(fuelConsumptionFixture))
      .mock("vessel_get_fleet_vessels", vesselLookup);

    const thread = await createThread({ tools });
    const result = await thread.send(
      "Show the fuel consumption and CO2 breakdown for the vessel Westship (IMO 9831062) for 2026.",
    );

    expect(result).toHaveNoErrors();
    expect(result.toolCallNames).toContain("westship_get_fuel_consumption");
    expect(result.toolCallNames).toContain("show_emission_fuel_consumption");
  });

  it("fetches the emission summary and renders the emission_fleet_summary widget", async () => {
    const tools = new MockTools()
      .mock("westship_get_fleet_summary", mock.static(fleetSummaryFixture))
      .mock("vessel_get_fleet_vessels", vesselLookup);

    const thread = await createThread({ tools });
    const result = await thread.send("Show the emission summary for the vessel Westship (IMO 9831062) for 2026.");

    expect(result).toHaveNoErrors();
    expect(result.toolCallNames).toContain("westship_get_fleet_summary");
    expect(result.toolCallNames).toContain("show_emission_fleet_summary");
  });
});
