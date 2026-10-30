# openworld — rules for AI work

A multiplayer open-world game set in real Indian places, built almost entirely by Claude.
The owner directs, tests and judges realism; Claude builds. First area: FCI Colony, Vakalapudi, Kakinada.

Reference docs (owner-maintained): "World realism and scaling spec" and "Testing and guardrails plan" (see docs/README.md).

## Realism rules (non-negotiable)

- Nothing is invented silently. Every attribute is `{value, source}`; unknown = `null` value and `null` source.
- Sources: `osm:way/<id>`, `osm:node/<id>`, `survey:owner-<date>`, `photo:<id>`, `open-buildings:google-v3:<plus code>`.
- Never widen roads, add drains/footpaths/kerbs, or add terrain that isn't there. Missing data shows as a gap.
- Objects are always true size (1:1). Only distances between places may be compressed later.
- Sensitive sites (ONGC, port, plants, defence, energy, rail) are restricted areas: never modelled, no buildings inside.
- No Google Maps / Street View / Google Earth content as a data source (terms forbid deriving outlines). Open datasets only.
- Fictional names for businesses, police insignia, brands. India's official boundary on any map of India.

## Engineering rules

- Never weaken, skip or delete a test, screenshot baseline or performance budget to make a change pass.
  If a test is wrong, say so and ask the owner first.
- Every change ships with tests; every bug fix starts with a test that reproduces it.
- "No errors" is not proof it works: check rendered output (screenshots, geometry checks).
- Small changes, one feature or fix per pull request. Main branch only changes through PRs with green CI.
- Before saying a task is done, run `npm run lint` and `npm test` and report the actual results.
- Record every owner correction as a rule here or as an automated check, so it never repeats.

## Commands

- `npm run build` — world data + 2D map viewer (viewer/dist/)
- `npm test` — data/unit tests (Python) + browser tests (Playwright)
- `npm run lint` — ruff (Python lint + format), eslint, prettier, shellcheck. Required check on every PR
- `npm run format` — auto-format everything before committing
- `npm run fetch` — re-download raw data (needs network access to openstreetmap.org and dataset hosts)

## Street surveys

- The owner surveys streets with the form in the 2D map (tap a road, "Survey this street", then Survey panel, "Copy for Claude").
- Save pasted results as `data/survey/streets_<YYYY-MM-DD>.json`. `npm run build` loads every `streets_*.json`
  (oldest first; later values win). The importer rejects invalid entries: fix with the owner, never by guessing.
- Places (temple, shop, ...) are pinned with "+ Place" and exported in the same JSON under `places`; pins inside
  restricted areas or outside the map are refused by both the form and the importer. Temples, mosques and churches
  are marked sacred: never used in crime or violent scenes.
- Survey options can be added but never renamed or removed: owners' phones hold surveys saved with old values.
  `tests/test_survey.py` (SHIPPED_OPTIONS) enforces this.
- Survey fields are defined once in `data/survey/street_survey_schema.json`, shared by the form and the importer.

## Lessons learned

- 2026-10-30: owner needed to pin a temple and a restaurant but the survey only covered streets; added places.
- 2026-10-30: the wider + Place button shifted the map buttons under the attribution text. Added an overlap check.

- 2026-10-30: browser tests passed while the map rendered as a 300x150 thumbnail (SVG had no size).
  Added a check that the map fills the screen and the 1 km circle is large. Always assert visible geometry.
- 2026-10-30: eslint was not checking the map script while it lived inside the HTML; moving it to viewer/map.js
  exposed two unused variables. Keep page scripts in .js files so they are linted.
- 2026-10-30: a city-wide OSM land-use polygon reached 6.6 km out; geometry is now clipped and range-checked.
