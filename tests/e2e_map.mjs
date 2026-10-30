// Browser smoke test for the 2D map viewer (layer 3 of the testing plan).
// Run: node tests/e2e_map.mjs viewer/dist/fci_colony_map.html out_dir
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

const file = path.resolve(process.argv[2]);
const outDir = path.resolve(process.argv[3] || "test-results");
fs.mkdirSync(outDir, { recursive: true });
const fails = [];
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) fails.push(msg);
};

const browser = await chromium.launch();
for (const [label, opts] of [
  ["desktop", { viewport: { width: 1280, height: 800 } }],
  ["iphone", { viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }],
]) {
  const page = await browser.newPage(opts);
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  const t0 = Date.now();
  await page.goto("file://" + file);
  await page.waitForFunction(() => window.__TEST__ && window.__TEST__.ready, null, { timeout: 5000 });
  const loadMs = Date.now() - t0;
  check(loadMs < 3000, `[${label}] map ready in ${loadMs} ms (budget 3000)`);
  check(errors.length === 0, `[${label}] no console errors ${errors.length ? JSON.stringify(errors) : ""}`);
  const counts = await page.evaluate(() => window.__TEST__.counts);
  check(counts.roads > 0, `[${label}] roads drawn: ${counts.roads}`);
  const drawn = await page.evaluate(() => document.querySelectorAll("#world path").length);
  check(drawn >= counts.roads, `[${label}] SVG paths present: ${drawn}`);
  // the map must actually fill the screen and show the whole 1 km circle large (caught a real bug)
  const geo = await page.evaluate(() => {
    const svg = document.getElementById("map").getBoundingClientRect();
    const c = document.querySelector("#world circle").getBoundingClientRect();
    return {
      sw: svg.width,
      sh: svg.height,
      vw: innerWidth,
      vh: innerHeight,
      cw: c.width,
      cl: c.left,
      cr: c.right,
      ct: c.top,
      cb: c.bottom,
    };
  });
  check(
    geo.sw === geo.vw && geo.sh === geo.vh,
    `[${label}] map fills the screen (${geo.sw}x${geo.sh} of ${geo.vw}x${geo.vh})`,
  );
  check(
    geo.cw >= 0.8 * Math.min(geo.vw, geo.vh - 130),
    `[${label}] 1 km circle is large on screen (${Math.round(geo.cw)} px)`,
  );
  check(
    geo.cl >= 0 && geo.cr <= geo.vw && geo.ct >= 40 && geo.cb <= geo.vh,
    `[${label}] whole circle visible, below the header`,
  );
  const addBtn = await page.locator("#btnAddPlace").boundingBox();
  check(
    addBtn && addBtn.y > 60 && addBtn.y + addBtn.height <= geo.vh && addBtn.x + addBtn.width <= geo.vw,
    `[${label}] + Place button is visible on screen`,
  );
  const overlaps = await page.evaluate(() => {
    const a = document.getElementById("attrib").getBoundingClientRect();
    const hit = (b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    return [...document.querySelectorAll("#controls button")]
      .filter((b) => hit(b.getBoundingClientRect()))
      .map((b) => b.id);
  });
  check(overlaps.length === 0, `[${label}] attribution doesn't cover map buttons ${overlaps.join(",")}`);
  await page.screenshot({ path: path.join(outDir, `${label}_overview.png`) });

  // select an unnamed colony lane -> must say Unknown, never a guessed width
  const id = await page.evaluate(() => {
    const w = JSON.parse(document.getElementById("world-data").textContent);
    return w.roads.find((r) => r.osm_class === "residential").id;
  });
  await page.evaluate((i) => window.__TEST__.select(i), id);
  const sheetText = await page.textContent("#sheet");
  if (label === "desktop") {
    const covered = await page.evaluate(() => {
      const a = document.getElementById("sheet").getBoundingClientRect();
      const hit = (b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      return [...document.querySelectorAll("#controls button")]
        .filter((b) => hit(b.getBoundingClientRect()))
        .map((b) => b.id);
    });
    check(covered.length === 0, `[${label}] open info panel doesn't cover map buttons ${covered.join(",")}`);
  }
  check(/Road width\s*Unknown/.test(sheetText), `[${label}] lane with no data shows width as Unknown`);
  check(/Drain\s*Unknown/.test(sheetText), `[${label}] drain shows Unknown (not invented)`);
  await page.screenshot({ path: path.join(outDir, `${label}_selected.png`) });

  // owner notes and restricted areas are shown
  const noted = await page.evaluate(() => {
    const w = JSON.parse(document.getElementById("world-data").textContent);
    return {
      road: w.roads.find((r) => r.notes && r.osm_class === "tertiary").id,
      area: (w.areas.find((a) => a.restricted) || {}).id,
    };
  });
  await page.evaluate((i) => window.__TEST__.select(i), noted.road);
  check(
    (await page.textContent("#sheet")).includes("Your note"),
    `[${label}] owner note shown on boundary road`,
  );
  await page.evaluate((i) => window.__TEST__.select(i), noted.area);
  check(
    (await page.textContent("#sheet")).includes("Restricted area"),
    `[${label}] ONGC area shown as restricted`,
  );
  check(
    (await page.textContent("#labels")).includes("Mahalakshmi Nagar"),
    `[${label}] Mahalakshmi Nagar label shown`,
  );

  // a satellite-detected building shows floors as Unknown and names its source
  const bid = await page.evaluate(
    () => JSON.parse(document.getElementById("world-data").textContent).areas.find((a) => a.confidence).id,
  );
  await page.evaluate((i) => window.__TEST__.select(i), bid);
  const bt = await page.textContent("#sheet");
  check(
    /Floors\s*Unknown/.test(bt) && bt.includes("Google Open Buildings"),
    `[${label}] building shows floors Unknown + source`,
  );
  check(
    (await page.textContent("#attrib")).includes("Google Open Buildings"),
    `[${label}] buildings attribution shown`,
  );

  // zoom in works
  const s0 = (await page.evaluate(() => window.__TEST__.camera())).s;
  await page.click("#sheetClose");
  await page.click("#zin");
  const s1 = (await page.evaluate(() => window.__TEST__.camera())).s;
  check(s1 > s0, `[${label}] zoom in increases scale (${s0.toFixed(3)} -> ${s1.toFixed(3)})`);
  await page.click("#zin");
  await page.screenshot({ path: path.join(outDir, `${label}_zoomed.png`) });

  // gaps panel
  await page.click("#btnGaps");
  check((await page.textContent("#sheet")).includes("What the map knows"), `[${label}] gaps panel opens`);
  await page.screenshot({ path: path.join(outDir, `${label}_gaps.png`) });

  // ---- street survey form (phone flow) ----
  const laneId = await page.evaluate(() => {
    const w = JSON.parse(document.getElementById("world-data").textContent);
    return w.roads.find((r) => r.osm_class === "residential" && r.width_m.value === null).id;
  });
  await page.evaluate((i) => window.__TEST__.select(i), laneId);
  check(
    (await page.textContent("#btnSurveyRoad")) === "Survey this street",
    `[${label}] road sheet offers "Survey this street"`,
  );
  await page.click("#btnSurveyRoad");
  check((await page.locator("#sv-form select").count()) >= 8, `[${label}] survey form shows choice fields`);
  // impossible width is refused, nothing saved
  await page.fill("#sv-width_m", "0.5");
  await page.click("#sv-save");
  check(
    (await page.textContent('[data-err="width_m"]')).includes("from 1.5 to 40"),
    `[${label}] form refuses an impossible width`,
  );
  check(
    (await page.evaluate(() => window.OpenworldSurvey.count())) === 0,
    `[${label}] nothing saved while invalid`,
  );
  check(
    (await page.evaluate(() => document.activeElement.id)) === "sv-width_m",
    `[${label}] form jumps to the field that needs fixing`,
  );
  await page.screenshot({ path: path.join(outDir, `${label}_survey_form.png`) });
  // valid entry
  await page.fill("#sv-width_m", "4.5");
  await page.selectOption("#sv-width_method", "tape");
  await page.selectOption("#sv-surface", "concrete");
  await page.selectOption("#sv-drain", "open, one side");
  await page.selectOption("#sv-footpath", "none");
  await page.fill("#sv-speed_breakers", "2");
  await page.fill("#sv-notes", "Milk booth at the corner <b>test</b>");
  await page.click("#sv-save");
  check((await page.textContent("#sheet")).includes("Saved on this phone"), `[${label}] survey saved`);
  check((await page.textContent("#btnSurvey")).includes("1"), `[${label}] header shows 1 street surveyed`);
  check(
    (await page.locator(`[data-my-survey="${laneId}"]`).count()) === 1,
    `[${label}] surveyed street highlighted on the map`,
  );
  // survives a reload (kept on the phone)
  await page.reload();
  await page.waitForFunction(() => window.__TEST__ && window.__TEST__.ready);
  check((await page.textContent("#btnSurvey")).includes("1"), `[${label}] survey kept after reload`);
  // ---- pin a place ----
  await page.click("#btnAddPlace");
  check(await page.evaluate(() => window.__TEST__.pinMode()), `[${label}] + Place enters pin mode`);
  await page.evaluate(() => window.__TEST__.dropPinAtWorld(1500, 0));
  check(
    (await page.textContent("#pinBanner")).includes("outside") &&
      (await page.evaluate(() => window.__TEST__.pinMode())),
    `[${label}] pin outside the map is refused`,
  );
  const restrictedPt = await page.evaluate(() => {
    const w = JSON.parse(document.getElementById("world-data").textContent);
    const zone = w.areas.find((a) => a.restricted).points;
    const inPoly = (x, y) => {
      let c = false;
      for (let i = 0, j = zone.length - 1; i < zone.length; j = i++) {
        const [xi, yi] = zone[i],
          [xj, yj] = zone[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    for (let x = -950; x <= 950; x += 25)
      for (let y = -950; y <= 950; y += 25) if (Math.hypot(x, y) < 950 && inPoly(x, y)) return [x, y];
    return null;
  });
  check(restrictedPt !== null, `[${label}] found a point inside the restricted area to test with`);
  await page.evaluate(([x, y]) => window.__TEST__.dropPinAtWorld(x, y), restrictedPt);
  check(
    (await page.textContent("#pinBanner")).includes("restricted"),
    `[${label}] pin inside the ONGC restricted area is refused`,
  );
  await page.evaluate(() => window.__TEST__.dropPinAtWorld(40, 60));
  check(!(await page.evaluate(() => window.__TEST__.pinMode())), `[${label}] valid pin opens the place form`);
  await page.click("#pl-save");
  check(
    (await page.textContent('[data-err="type"]')).includes("choose") &&
      (await page.evaluate(() => document.activeElement.id)) === "sv-type",
    `[${label}] place needs a type before saving`,
  );
  await page.selectOption("#sv-type", "temple");
  check(
    (await page.textContent('[data-err="type"]')) === "" &&
      !(await page.getAttribute("#sv-type", "class")).includes("invalid"),
    `[${label}] error clears as soon as a type is chosen`,
  );
  await page.fill("#sv-name", "Sri Rama temple");
  await page.fill("#sv-note", "Right side of the lane");
  await page.screenshot({ path: path.join(outDir, `${label}_place_form.png`) });
  await page.click("#pl-save");
  check((await page.textContent("#sheet")).includes("Place saved"), `[${label}] place saved`);
  check(
    (await page.locator("[data-place-id]").count()) === 1 &&
      (await page.textContent("[data-place-id]")).includes("Sri Rama temple"),
    `[${label}] pinned place shown on the map with its name`,
  );
  await page.screenshot({ path: path.join(outDir, `${label}_place_pinned.png`) });

  // export panel
  await page.click("#btnSurvey");
  const exported = await page.inputValue("#sv-out");
  const parsed = JSON.parse(exported);
  check(
    parsed.format === "openworld-street-survey/1" && parsed.streets[laneId].width_m === 4.5,
    `[${label}] exported survey has the street and its width`,
  );
  check(
    parsed.places.length === 1 &&
      parsed.places[0].type === "temple" &&
      Math.abs(parsed.places[0].lat - 17.0143794 - 60 / 110574) < 1e-6,
    `[${label}] exported survey has the pinned place at the right spot`,
  );
  check(
    !(await page.innerHTML("#sheet")).includes("<b>test</b>"),
    `[${label}] user text is escaped in the panel`,
  );
  await page.screenshot({ path: path.join(outDir, `${label}_survey_panel.png`) });
  if (label === "desktop") {
    // round trip: what the phone exports must be accepted by the importer and drawn at true width
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "survey-"));
    const svFile = path.join(tmp, "survey.json");
    fs.writeFileSync(svFile, exported);
    const worldOut = path.join(tmp, "world.json");
    const htmlOut = path.join(tmp, "map.html");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const args = pkg.scripts["build:world"]
      .match(/"[^"]*"|\S+/g)
      .slice(2)
      .map((a) => a.replace(/^"|"$/g, ""));
    const outIdx = args.indexOf("--out");
    args[outIdx + 1] = worldOut;
    execFileSync("python3", ["tools/build_world.py", ...args, "--street-survey", svFile], { stdio: "pipe" });
    execFileSync("python3", ["tools/build_viewer.py", "--world", worldOut, "--out", htmlOut], {
      stdio: "pipe",
    });
    const p2 = await browser.newPage(opts);
    await p2.goto("file://" + htmlOut);
    await p2.waitForFunction(() => window.__TEST__ && window.__TEST__.ready);
    check(
      (await p2.locator('[data-width-m="4.5"]').count()) === 1,
      "[round-trip] importer accepts the phone export; street drawn at 4.5 m",
    );
    await p2.evaluate((i) => window.__TEST__.select(i), laneId);
    const t2 = await p2.textContent("#sheet");
    check(
      /Road width\s*4.5 m/.test(t2) && t2.includes("your survey"),
      "[round-trip] road shows surveyed width with survey as source",
    );
    const poiId = `poi-survey-${parsed.places[0].id}`;
    await p2.evaluate((i) => window.__TEST__.select(i), poiId);
    const t3 = await p2.textContent("#sheet");
    check(
      t3.includes("Sri Rama temple") && t3.includes("your survey") && t3.includes("never used in crime"),
      "[round-trip] pinned temple imported, attributed to survey, marked as place of worship",
    );
    await p2.close();
  }
  // clear all needs two taps
  await page.click("#sv-clear");
  check(
    (await page.evaluate(() => window.OpenworldSurvey.count())) === 2,
    `[${label}] first tap does not delete (street + place still saved)`,
  );
  await page.click("#sv-clear");
  check(
    (await page.evaluate(() => window.OpenworldSurvey.count())) === 0,
    `[${label}] second tap clears all`,
  );
  await page.close();
}
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
