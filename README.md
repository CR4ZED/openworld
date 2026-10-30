# openworld

An open-world multiplayer game set in real Indian places, starting with **FCI Colony, Vakalapudi, Kakinada**.
Built almost entirely by Claude (AI), directed and reviewed by someone who has lived there all their life.

**Current stage:** 2D map of a 1 km radius (roads, 3,551 buildings, owner corrections). Next: street survey, then the first street in 3D.

## How it works

1. `data/raw/` — open data: OpenStreetMap roads/places, Google Open Buildings outlines.
2. `data/survey/` — the owner's corrections and street surveys. Always tagged with their source.
3. `tools/build_world.py` — merges everything into `data/world/*.json` (local metres). Unknown values stay unknown.
4. `tools/build_viewer.py` — builds a single-file interactive 2D map in `viewer/dist/`.
5. `tests/` — data guardrails, geometry unit tests, browser tests at desktop and iPhone size. Run on every push by GitHub Actions.

## Run it

```
npm install && npx playwright install chromium
npm run build
npm test
```

## Data and licences

- Roads and places © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/). Derived databases must stay under ODbL.
- Building outlines: [Google Open Buildings v3](https://sites.research.google/gr/open-buildings/), CC BY 4.0 (or ODbL).
- Microsoft Global ML Building Footprints (ODbL) kept for comparison in `data/raw/buildings/ms_fci_area.json`.
- No Google Maps, Street View or Google Earth content is used as data.
