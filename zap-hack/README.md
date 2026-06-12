# zap-hack — Emission Analyst tools

A local ZAP tool server that backs the **emission** widgets in `zap-widgets`
(`src/emission/`). It exposes agent tools over an OpenAPI spec, shaping live
emission-analytics data (forwarded operator token) into the widgets' schemas.

## Layout

```
server/
  index.ts       # Express tool server on :9001 — routes + OpenAPI endpoint
  westship.ts    # soft HTTP client for the emission-analytics + vessel-particulars APIs
  openapi.ts     # OpenAPI 3.0 spec (x-zap enabled), built from the widget schemas
  projections/   # raw upstream JSON -> each widget's Zod-validated shape
zap/
  domain.yaml    # domain id: emission
  knowledge/emission.md   # ambient knowledge injected into the agent prompt
zap.config.mjs   # points the platform at ./zap + the widgets checkout
run.sh           # boots tool server + `zap serve` with the right Node/AWS
```

## The tools

| Tool (agent sees `emission_<id>`)   | Backs widgets |
| ----------------------------------- | ------------- |
| `get_fleet_cii_ratings`             | fleet-cii-rating, -grade, -at-risk, -top, -compare |
| `rank_vessels_by_emissions_per_nm`  | fleet-emissions-rank, -vessel, -compare |
| `compare_emissions_by_route`        | fleet-route-emissions |
| `get_voyage_overview`               | voyage-cii-rating, vessel-voyages |
| `rank_voyages_by_carbon_cost`       | voyage-carbon-cost |
| `get_fleet_emissions_overview`      | fleet-emissions-overview |
| `get_fleet_compliance_risk`         | fleet-compliance-risk |
| `get_fleet_ets_cost`                | fleet-ets-cost |
| `get_incomplete_voyages`            | incomplete-voyages |

## Run

```bash
./run.sh                       # tool server (:9001) + platform (:3000)
```

Then open <http://localhost:3000/zap> and ask, e.g.:

- "How many of my vessels are rated D or E this year?"
- "Rank my vessels by emissions per nautical mile."
- "Which vessels are at compliance risk?"
- "What's the total EU ETS cost for the fleet?"
- "Show all incomplete voyages."

## Gotchas

- **Node 24+** is required by `zap-cli` (this machine defaults to 18). `run.sh`
  pins it via nvm.
- **AWS SSO** (`zn-stage` profile) must be logged in for stage SSM secrets:
  `aws sso login --profile zn-stage`.
- **Restart after spec/tool changes.** `zap serve` reads the OpenAPI spec once
  at startup; restart it after editing anything under `server/`. Widget source
  hot-reloads.
- `zap lint http://localhost:9001/openapi.json` validates the spec.
