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

## 3D game (game/)

- Vite + TypeScript + three.js. `npm run build:game` copies the world JSON to `game/public/world.json` and builds
  `game/dist`, published at `/openworld/game/` (and in PR previews). Coordinates: data x east / y north (m, 1:1);
  three.js x east, y up, z = -north.
- Shows known values first, otherwise the labelled estimate (`game/src/resolve.ts`). "Show estimates" tints roads
  whose width or surface is estimated. Restricted areas: flat ground + boundary wall only, nothing inside.
- Performance budget: at most 40 draw calls (geometry merged per material). `tests/e2e_game.mjs` checks the
  picture really renders (not blank; sky above, ground below), walking speed, wall collision, budgets.
- Building floors are estimates (estimate:v1) by footprint until the owner surveys them.
- Visuals (2026-10-31): surface textures are drawn in code (`game/src/textures.ts`, fixed seeds), laid along each road
  (u = metres along, v = across). Never paint distinct features (patches, potholes, signs) into a repeating texture:
  they show up as an obvious row; place them individually instead. Quality High = sun shadows following the player;
  Low = no shadows, pixel ratio 1; budget phones (<= 4 cores or <= 4 GB) start on Low.
- Desktop look = mouse movement, no click needed (owner 2026-10-31, updated 2026-11-11: "having to click and then
  move around is a turn off"): moving the mouse over the view turns it at once; the first key press or click
  captures the mouse (browsers allow pointer lock only after a gesture); Esc frees it and opens the pause menu.
  Overlays on the view (crosshair, minimap) must have pointer-events: none.
- Pause menu (Esc or ☰ Menu; phones use the button): Resume, Quality, Show estimates, 2D map, Quit (title screen,
  game stopped; Play restarts), controls list. The world waits while it is open. Closing it hands keyboard focus
  back to the game (Space must jump, never press a menu button). Settings live in the menu, not the top strip.
- Jump (owner, 2026-10-31): Space on desktop, Jump button on phones. Human-scale: 3.0 m/s take-off, g = 9.81
  (about 0.46 m high, ~0.6 s in the air); only from the ground; one jump per press.
- Player and scooter (2026-11-11, Benglooru-style roadmap step 1): third-person camera by default (pulls in so it
  never enters a building), V = first person. Generic step-through scooter (no real brand), parked on the start
  lane: E / Ride button gets on and off (only below 2 m/s), W/S throttle-brake, A/D steer, H / Horn button.
  Riding physics are tested on open ground and against a test wall via `__GAME__.rideSim`; live checks wait for
  real frames (`__GAME__.frames()`), not fixed timeouts.
- Scooter numbers (owner 2026-11-11: "45 km/h max is not true"): match a real 110 cc scooter road test (Autocar
  India, Activa 110): 85 km/h top, 0-40 3.6 s, 0-60 8.1 s, 0-80 18.1 s, 60-0 in 18.4 m. Tests hold these.
- Crashes (owner 2026-11-11: "no physics when it hits a wall, speed drops to 0"): glancing hits scrape along the
  wall keeping most speed; slow head-on bumps bounce back; more than 20 km/h straight into a wall knocks the
  scooter over and throws the rider off (lies down ~1.6 s, E picks the scooter up). Never ends up inside a wall.
- On foot (owner 2026-11-11: "walks like a robot, very slow"): default pace is an easy jog 3.5 m/s, C = walk
  1.6, Shift = sprint 6.0; quick start/stop. The character is one skinned mesh with a skeleton (knees, elbows,
  hips, shoulders; 1 draw call). Gait phase follows ground covered so feet stay planted; tests check planted
  feet, knee bend, arm swing opposite the legs, and natural cadence (walk ~1.8, jog ~2.5, sprint ~3 steps/s).
- Actions are animated, never snapped (owner 2026-11-11: "falls flat, gets up like a robot, no animation picking up
  the vehicle"): key poses in `game/src/models.ts` (POSES/CLIPS) blended smoothly. Crash = thrown in an arc clear of
  the scooter, lies ~0.7 s, gets up via sit, knees in, tuck, roll forward, one knee, push up (~2.2 s). E = walk to
  the scooter's side, bend and lift it if fallen (from the side you are on), swing a leg over; getting off swings
  the leg back. Tests film each action frame by frame: no joint below the ground, head moves < 0.15 m per frame
  (0.3 m while thrown), a real kneeling phase, gradual lift. Check new poses for feet/knees/hands vs the ground.
- Minimap (owner 2026-11-11: "a map showing the path in realtime as we move around"): `game/src/minimap.ts`, a
  round map bottom-left on desktop (top-left on phones, the joystick has bottom-left). Same data as the world: roads in
  their surface colour, buildings, restricted area hatched with nothing inside. Turns with the view (ahead = up),
  N marker, trail of where you've been (a point every 2 m; breaks on teleports), scooter dot, zooms out at speed.
  Tests sample it against the data (start lane = concrete) and check it never covers other controls.
- Phones play in landscape (owner, 2026-10-30). Android: Play button -> fullscreen + orientation lock. iPhone Safari
  cannot lock orientation, so portrait shows a full-screen "turn your phone sideways" prompt and the world waits.
  Tests run the phone in landscape and check the portrait prompt.

## Estimates for unsurveyed roads (owner-approved 2026-10-30)

- `tools/estimates.py` estimates width, surface, drain, footpath and other street fields from surroundings
  (building gaps, how built-up, road type), the owner's surveyed streets of the same kind, owner statements
  and docs/reference/ research.
- Estimates live only in `road.estimate[field] = {value, source: "estimate:v1", basis, confidence}`. They never fill
  core attributes, never replace survey values, and are never made for restricted areas.
  `tests/test_estimates.py` enforces this.
- Widths err narrow (owner: never widen roads): the narrowest surveyed ratio of the same road kind, never wider
  than the buildings allow. The map shows estimates with a different look and an "estimate" label.

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

- 2026-11-11: after closing the menu, keyboard focus stayed on its button, so Space pressed it again instead of
  jumping; focus now returns to the game and Space/Enter never activate page buttons during play (test added).
- 2026-11-11: headless test Chrome (swiftshader) balloons to 3 GB and crawls while the mouse is captured (pointer
  lock), then gets killed. Tests check capturing/releasing, then switch automatic capture off
  (`__GAME__.stopMouseCapture()`). Real Chrome memory with the mouse captured is checked by hand on the preview.

- 2026-11-11: blending joint angles straight from sitting to kneeling swung a foot 0.4 m through the ground; added
  in-between poses (knees up, tuck, roll forward). The start of getting off drew the body at the scooter's centre
  for one frame, then the seat (15 cm jump). Both caught by the frame-by-frame animation checks.

- 2026-11-11: the first frame can have a zero time step; speed = distance / 0 made the gait phase NaN and froze
  the legs. Movement steps now ignore dt <= 0, and a test checks speed and phase are real numbers after loading.

- 2026-11-11: the desktop test browser can draw under 5 fps, so a 200 ms wait sometimes saw an old frame (stale
  camera/prompt). Wait for frames drawn (`__GAME__.frames()`) instead. Also the help line ran under the map credits
  on a 1000 px window; the game test now checks they don't overlap at 1280 and 1000 px.

- 2026-10-31: repair patches painted into the 6 m tar texture repeated like a ladder down the ADB Road. Caught by
  looking at the render; textures now hold only uniform detail.

- 2026-10-31: the test browser renders slowly, so the live game runs in slow motion there; a timing-based check
  ("landed after 1.5 s") failed while the game was right. Test real-time behaviour by counting events (jumps
  started), and test timing with the deterministic step() hook.

- 2026-10-30: wall sliding along map axes let the player slip around small sheds; slide along the wall's own
  direction instead. Wall test walks head-on at a long wall and checks it stops (and no sideways drift).
- 2026-10-30: a "number of distinct colours" check was too crude for a close-up phone view; replaced with checks
  that matter (not blank; sky at top, ground/road at bottom). Thresholds must test a real property.

- 2026-10-30: owner: only highways are tar (ADB Road, road in front of ONGC); other roads are concrete, red mud or
  mixes. Recorded per road in owner notes; survey gained mixed-surface options.
- 2026-10-30: owner needed to pin a temple and a restaurant but the survey only covered streets; added places.
- 2026-10-30: the wider + Place button shifted the map buttons under the attribution text. Added an overlap check.

- 2026-10-30: browser tests passed while the map rendered as a 300x150 thumbnail (SVG had no size).
  Added a check that the map fills the screen and the 1 km circle is large. Always assert visible geometry.
- 2026-10-30: eslint was not checking the map script while it lived inside the HTML; moving it to viewer/map.js
  exposed two unused variables. Keep page scripts in .js files so they are linted.
- 2026-10-30: a city-wide OSM land-use polygon reached 6.6 km out; geometry is now clipped and range-checked.
