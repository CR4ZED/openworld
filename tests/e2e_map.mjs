// Browser smoke test for the 2D map viewer (layer 3 of the testing plan).
// Run: node tests/e2e_map.mjs viewer/dist/fci_colony_map.html out_dir
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

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
  await page.screenshot({ path: path.join(outDir, `${label}_overview.png`) });

  // select an unnamed colony lane -> must say Unknown, never a guessed width
  const id = await page.evaluate(() => {
    const w = JSON.parse(document.getElementById("world-data").textContent);
    return w.roads.find((r) => r.osm_class === "residential").id;
  });
  await page.evaluate((i) => window.__TEST__.select(i), id);
  const sheetText = await page.textContent("#sheet");
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
  await page.close();
}
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
