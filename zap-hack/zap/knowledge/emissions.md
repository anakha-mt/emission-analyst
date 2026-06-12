---
title: Vessel emission analytics
description: How to fetch and render a vessel's year-to-date CII analytics.
mode: ambient
---

# Vessel emission analytics

When the user asks about a vessel's **CII** (Carbon Intensity Indicator), emission
analytics, or carbon-rating trend:

1. Call **`westship_get_emission_analytics`** with the vessel identifier and the
   reporting year. It returns the analytics already shaped for the chart.
2. Pass that result **straight** to **`show_emission_analytics`** to render the
   widget — do not reshape or summarise the numbers yourself; the data is already
   in the exact shape the widget expects.

The `westship_get_emission_analytics` response includes the attained CII curve(s),
the A–E rating boundaries per year, and a correction-factors summary.

## Other emission widgets

The same pattern applies to three more emission tools — call the tool, then pass its
result **straight** to the matching render tool (never reshape the numbers yourself):

- **EU ETS / carbon allowances / EUA cost** → call **`westship_get_eu_ets`**, then
  **`show_emission_eu_ets`**. Returns the EUA exposure, total EUA cost (EUR), compliance
  year, and coverage percentage.
- **Fuel consumption / fuel burn / CO2 breakdown** → call **`westship_get_fuel_consumption`**,
  then **`show_emission_fuel_consumption`**. Returns the per-fuel consumption with each
  fuel's CO2 conversion factor and CO2 output, plus total CO2.
- **Emission overview / summary for a vessel** → call **`westship_get_fleet_summary`**,
  then **`show_emission_fleet_summary`**. Returns an at-a-glance summary: vessel
  characteristics, voyage performance, attained CII (rating + 30-day trend), EU ETS
  exposure, and the fuel/CO2 breakdown.

All four tools take the same `{ vesselId, year, vesselName? }` input (`vesselId` is the IMO).

## Resolving the vessel (name → IMO)

All four emission tools key off the **IMO number** (`vesselId`). If the user gives a
vessel **name** instead of an IMO (e.g. "show fuel consumption for Westship Pioneer"):

1. First resolve the IMO — call **`vessel_get_fleet_vessels`** and match the user's
   name (case-insensitive, allow partial/fuzzy matches) against the returned
   `{ name, imo }` entries.
2. Then call the emission tool with the matched `vesselId` (the IMO), and pass the
   resolved name through as `vesselName` so the widget header shows it.

Handle these cases:
- **Exactly one match** → use its IMO and proceed.
- **Multiple matches** → list the candidates (name + IMO) and ask the user which one.
- **No match** → tell the user the vessel isn't in the fleet and ask for the IMO
  directly. If the user already gave a valid 7-digit IMO, use it as-is — do **not**
  require it to be present in the fleet list (the emission tools accept any IMO).

When the user already provides an IMO, skip the lookup and call the emission tool
directly.
