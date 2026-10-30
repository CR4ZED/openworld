// Browser tests for the 3D game (layer 3 of the testing plan).
// Run: node tests/e2e_game.mjs game/dist out_dir
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || "game/dist");
const outDir = path.resolve(process.argv[3] || "test-results");
fs.mkdirSync(outDir, { recursive: true });
const fails = [];
const check = (ok, msg) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) fails.push(msg);
};

// tiny static server (ES modules and fetch() need http, not file://)
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, "index.html") : p;
  if (!file.startsWith(root) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/?test=1`;

// Budgets: keep the colony cheap enough for budget phones.
const MAX_DRAW_CALLS = 40;
const MAX_LOAD_MS = 15000; // software rendering in CI is slow; real phones should be far faster

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
for (const [label, opts] of [
  ["desktop", { viewport: { width: 1280, height: 800 } }],
  // phones play in landscape (iPhone 17-sized screen turned sideways)
  ["phone", { viewport: { width: 874, height: 402 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
]) {
  const page = await browser.newPage(opts);
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => window.__GAME__ && window.__GAME__.ready, null, { timeout: MAX_LOAD_MS });
  check(Date.now() - t0 < MAX_LOAD_MS, `[${label}] 3D world ready in ${Date.now() - t0} ms`);
  if (label === "phone") {
    check(await page.isVisible("#btnPlay"), `[${label}] phone shows a Play button first`);
    check(!(await page.isVisible("#rotate")), `[${label}] no "turn sideways" prompt in landscape`);
    await page.click("#btnPlay"); // fullscreen + landscape lock where the browser allows it (not in tests)
    check(!(await page.isVisible("#start")), `[${label}] Play starts the game`);
    const hudH = await page.evaluate(() => document.getElementById("hud").getBoundingClientRect().height);
    check(hudH <= 48, `[${label}] top strip is compact in landscape (${Math.round(hudH)} px)`);
  }
  await page.waitForTimeout(800); // let a few frames render

  check(errors.length === 0, `[${label}] no console errors ${errors.length ? JSON.stringify(errors) : ""}`);
  const geo = await page.evaluate(() => {
    const c = document.getElementById("scene").getBoundingClientRect();
    return { w: c.width, h: c.height, vw: innerWidth, vh: innerHeight };
  });
  check(geo.w === geo.vw && geo.h === geo.vh, `[${label}] 3D view fills the screen`);

  // the picture must really contain a rendered scene, not a blank or single-colour canvas
  const shot = await page.screenshot({ path: path.join(outDir, `game_${label}_start.png`) });
  // read a 20x20 grid of pixels: rows from the top (sky) and bottom (ground/road) of the view
  const sample = await page.evaluate(() => {
    const c = document.getElementById("scene");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    const w = gl.drawingBufferWidth,
      h = gl.drawingBufferHeight;
    const px = new Uint8Array(4);
    const seen = new Set();
    const rows = [];
    for (let j = 0; j < 20; j++) {
      const row = [];
      for (let i = 0; i < 20; i++) {
        // readPixels counts y from the bottom
        gl.readPixels(
          Math.floor((i + 0.5) * (w / 20)),
          Math.floor((19 - j + 0.5) * (h / 20)),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          px,
        );
        const key = `${px[0] >> 3},${px[1] >> 3},${px[2] >> 3}`;
        seen.add(key);
        row.push([px[0], px[1], px[2]]);
      }
      rows.push(row);
    }
    return { distinct: seen.size, rows };
  });
  const skyLike = ([r, g, b]) => b >= r && b > 200 && g > 200; // pale blue-grey sky / fog
  const share = (row) => row.filter(skyLike).length / row.length;
  // skip the HUD strip at the very top: use rows 4-6 (upper view) and the bottom 3 rows
  const top = (share(sample.rows[4]) + share(sample.rows[5]) + share(sample.rows[6])) / 3;
  const bottom = (share(sample.rows[17]) + share(sample.rows[18]) + share(sample.rows[19])) / 3;
  check(
    sample.distinct >= 6,
    `[${label}] rendered picture is not blank (${sample.distinct} distinct colours)`,
  );
  check(
    top > bottom && bottom < 0.2,
    `[${label}] sky above, ground/road below (sky share top ${top.toFixed(2)}, bottom ${bottom.toFixed(2)})`,
  );
  check(shot.length > 20000, `[${label}] screenshot is not trivially empty (${shot.length} bytes)`);

  // surfaces are textured (drawn in code), and the sky is bluer overhead than at the horizon
  const textured = await page.evaluate(() => window.__GAME__.texturedSurfaces());
  const has = (k) => textured.some((n) => n.includes(k));
  check(
    has("ground") && has("roads:concrete") && has("roads:tar") && has("roads:redmud"),
    `[${label}] ground, concrete, tar and red mud surfaces are textured`,
  );
  const skyCheck = await page.evaluate(() => {
    // rendered: scan across the upper view for open sky (houses may cover parts of it)
    const c = document.getElementById("scene");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    const px = new Uint8Array(4);
    let bluest = -255;
    for (let i = 0; i < 40; i++) {
      gl.readPixels(
        Math.floor(gl.drawingBufferWidth * ((i + 0.5) / 40)),
        Math.floor(gl.drawingBufferHeight * 0.85),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        px,
      );
      bluest = Math.max(bluest, px[2] - px[0]);
    }
    return { bluest, gradient: window.__GAME__.skyGradient() };
  });
  check(skyCheck.bluest > 15, `[${label}] blue sky visible overhead (blue - red = ${skyCheck.bluest})`);
  check(
    skyCheck.gradient.top.b - skyCheck.gradient.top.r >
      skyCheck.gradient.horizon.b - skyCheck.gradient.horizon.r,
    `[${label}] sky fades from blue overhead to a paler horizon`,
  );

  const stats = await page.evaluate(() => window.__GAME__.stats());
  check(
    stats.buildings > 3000 && stats.roads > 250,
    `[${label}] world built: ${stats.roads} roads, ${stats.buildings} buildings`,
  );
  check(
    stats.drawCalls > 0 && stats.drawCalls <= MAX_DRAW_CALLS,
    `[${label}] draw calls ${stats.drawCalls} within budget ${MAX_DRAW_CALLS}`,
  );
  check(stats.restrictedWalls > 0, `[${label}] restricted area has its boundary wall`);

  // starts on the surveyed colony lane, HUD shows it
  const start = await page.evaluate(() => window.__GAME__.player());
  check(
    (await page.evaluate(({ x, y }) => window.__GAME__.roadAt(x, y), start)) === "road-545446015",
    `[${label}] player starts on the surveyed colony lane`,
  );
  const hud = await page.evaluate(() => window.__GAME__.hud());
  check(
    /9 m/.test(hud) && !/9 m ≈ estimate/.test(hud),
    `[${label}] HUD shows the lane's surveyed width (no estimate tag): "${hud}"`,
  );

  // walking forward along the road for 5 s moves about 7 m (walking pace 1.4 m/s)
  const moved = await page.evaluate(() => {
    const a = window.__GAME__.player();
    window.__GAME__.step(5, { forward: 1, strafe: 0, run: false });
    const b = window.__GAME__.player();
    return Math.hypot(b.x - a.x, b.y - a.y);
  });
  check(moved > 6 && moved < 7.5, `[${label}] walking 5 s covers ${moved.toFixed(2)} m`);

  // walking head-on into a long building wall stops at the wall, never inside it
  const wall = await page.evaluate(() => {
    const w = window.__GAME__;
    const p = w.player();
    for (let maxDist = 40; maxDist <= 200; maxDist += 40) {
      const e = w.wallNear(p.x, p.y, 8, maxDist);
      if (!e) continue;
      const mx = (e.a[0] + e.b[0]) / 2,
        my = (e.a[1] + e.b[1]) / 2;
      const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
      const nx = -(e.b[1] - e.a[1]) / len,
        ny = (e.b[0] - e.a[0]) / len;
      for (const side of [1, -1]) {
        const sx = mx + side * nx * 4,
          sy = my + side * ny * 4;
        if (w.blocked(sx, sy)) continue;
        const yaw = Math.atan2(-side * nx, -side * ny); // face the wall
        w.teleport(sx, sy, yaw);
        let everInside = false;
        for (let i = 0; i < 100; i++) {
          w.step(0.1, { forward: 1, strafe: 0, run: false });
          const q = w.player();
          if (w.blocked(q.x, q.y)) everInside = true;
        }
        const q = w.player();
        const towards = (q.x - sx) * Math.sin(yaw) + (q.y - sy) * Math.cos(yaw);
        const sideways = Math.abs(-(q.x - sx) * Math.cos(yaw) + (q.y - sy) * Math.sin(yaw));
        return { found: true, everInside, towards, sideways };
      }
    }
    return { found: false };
  });
  check(
    wall.found && !wall.everInside && wall.towards > 3 && wall.towards < 4,
    `[${label}] walking head-on into a wall 4 m away stops at it (${wall.towards?.toFixed(2)} m, never inside)`,
  );
  check(
    wall.found && wall.sideways < 0.5,
    `[${label}] no sideways drift when walking straight at a wall (${wall.sideways?.toFixed(2)} m)`,
  );

  if (label === "desktop") {
    // mouse-look: click captures the mouse, moving it turns the view without dragging, Esc releases it
    await page.mouse.click(640, 400);
    await page.waitForTimeout(150);
    check(
      await page.evaluate(() => window.__GAME__.mouseLocked()),
      `[${label}] clicking the view captures the mouse`,
    );
    check(await page.isVisible("#crosshair"), `[${label}] crosshair shown while looking with the mouse`);
    check(
      (await page.evaluate(() => getComputedStyle(document.getElementById("crosshair")).pointerEvents)) ===
        "none",
      `[${label}] crosshair never blocks clicks on the view`,
    );
    // a real mouse reports movementX/Y while captured; headless Chrome reports 0, so send the same events
    const before = await page.evaluate(() => window.__GAME__.look());
    await page.evaluate(() => {
      for (let i = 0; i < 10; i++)
        document.dispatchEvent(new MouseEvent("mousemove", { movementX: 20, movementY: 0 }));
    });
    const after = await page.evaluate(() => window.__GAME__.look());
    check(
      after.yaw - before.yaw > 0.4 && Math.abs(after.pitch - before.pitch) < 1e-6,
      `[${label}] moving the mouse right (no button held) turns right (yaw +${(after.yaw - before.yaw).toFixed(2)} rad)`,
    );
    await page.evaluate(() => {
      for (let i = 0; i < 10; i++)
        document.dispatchEvent(new MouseEvent("mousemove", { movementX: 0, movementY: -20 }));
    });
    check(
      (await page.evaluate(() => window.__GAME__.look())).pitch > after.pitch,
      `[${label}] moving the mouse up looks up`,
    );
    // Esc is handled by the browser itself: it releases the capture, like this
    await page.evaluate(() => document.exitPointerLock());
    await page.waitForTimeout(150);
    check(
      !(await page.evaluate(() => window.__GAME__.mouseLocked())),
      `[${label}] releasing the mouse (Esc) works`,
    );
    check(!(await page.isVisible("#crosshair")), `[${label}] crosshair hidden after the mouse is freed`);
    const yawFree = (await page.evaluate(() => window.__GAME__.look())).yaw;
    await page.evaluate(() => document.dispatchEvent(new MouseEvent("mousemove", { movementX: 200 })));
    check(
      (await page.evaluate(() => window.__GAME__.look())).yaw === yawFree,
      `[${label}] a free mouse doesn't turn the view`,
    );
  }

  // jumping: a normal standing jump (~0.46 m), lands in about 0.6 s, no jumping again in mid-air
  const jump = await page.evaluate(() => {
    const g = window.__GAME__;
    const heights = [];
    g.step(1 / 30, { forward: 0, strafe: 0, run: false, jump: true });
    for (let i = 0; i < 40; i++) {
      // try to jump again mid-air at 0.2 s
      g.step(1 / 30, { forward: 0, strafe: 0, run: false, jump: i === 5 });
      heights.push(g.player().z);
    }
    const peak = Math.max(...heights);
    const landedAt = heights.findIndex((h, i) => i > 3 && h === 0);
    return { peak, landedSeconds: (landedAt + 2) / 30, final: heights[heights.length - 1] };
  });
  check(
    jump.peak > 0.38 && jump.peak < 0.55,
    `[${label}] jump height is human-scale (${jump.peak.toFixed(2)} m)`,
  );
  check(
    jump.landedSeconds > 0.5 && jump.landedSeconds < 0.75 && jump.final === 0,
    `[${label}] lands after ${jump.landedSeconds.toFixed(2)} s and stays on the ground (no mid-air double jump)`,
  );
  if (label === "desktop") {
    // the real Space key, in the live game loop; holding it must not keep bouncing
    const jumpsBefore = await page.evaluate(() => window.__GAME__.jumps());
    await page.keyboard.down("Space");
    // wait for the jump to show up in the live loop (frame times vary a lot in the test browser)
    const up = await page
      .waitForFunction(() => window.__GAME__.player().z > 0.05, null, { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    await page.waitForTimeout(1800);
    await page.keyboard.up("Space");
    const jumpsHeld = (await page.evaluate(() => window.__GAME__.jumps())) - jumpsBefore;
    check(up, `[${label}] Space jumps (player leaves the ground)`);
    check(jumpsHeld === 1, `[${label}] holding Space for 2 s gives exactly one jump (got ${jumpsHeld})`);
  } else {
    const box = (sel) =>
      page.evaluate((s) => document.querySelector(s).getBoundingClientRect().toJSON(), sel);
    const hit = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    const jb = await box("#btnJump");
    check(
      (await page.isVisible("#btnJump")) &&
        !hit(jb, await box("#joystick")) &&
        !hit(jb, await box("#attrib")),
      `[${label}] Jump button shown, clear of the joystick and credits`,
    );
    await page.tap("#btnJump");
    await page.waitForTimeout(150);
    check((await page.evaluate(() => window.__GAME__.player().z)) > 0.05, `[${label}] tapping Jump jumps`);
    await page.waitForTimeout(900);
  }

  // quality switch: High has sun shadows, Low turns them off (and stays within budget)
  const q0 = await page.evaluate(() => window.__GAME__.quality());
  if (q0.quality === "low") await page.click("#btnQuality");
  const qHigh = await page.evaluate(() => window.__GAME__.quality());
  await page.click("#btnQuality");
  await page.waitForTimeout(300);
  const qLow = await page.evaluate(() => window.__GAME__.quality());
  const lowStats = await page.evaluate(() => window.__GAME__.stats());
  check(qHigh.quality === "high" && qHigh.shadows, `[${label}] Quality: High has sun shadows`);
  check(
    qLow.quality === "low" && !qLow.shadows && qLow.pixelRatio === 1,
    `[${label}] Quality: Low turns shadows off`,
  );
  check(
    lowStats.drawCalls <= MAX_DRAW_CALLS,
    `[${label}] Low quality within draw-call budget (${lowStats.drawCalls})`,
  );
  await page.click("#btnQuality"); // back to High for the remaining screenshots

  // estimates toggle tints estimated roads and is reversible
  await page.click("#btnEstimates");
  check(
    (await page.getAttribute("#btnEstimates", "aria-pressed")) === "true",
    `[${label}] "Show estimates" turns on`,
  );
  await page.screenshot({ path: path.join(outDir, `game_${label}_estimates.png`) });
  await page.click("#btnEstimates");
  check(
    (await page.getAttribute("#btnEstimates", "aria-pressed")) === "false",
    `[${label}] "Show estimates" turns off`,
  );

  // overview shot from above the colony for human review
  await page.evaluate(() => window.__GAME__.teleport(150, -150, -0.8));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, `game_${label}_street.png`) });
  if (label === "phone") check(await page.isVisible("#joystick"), `[${label}] touch joystick is shown`);
  await page.close();
}
// a budget phone (4 cores, 3 GB) starts on Low quality so it stays smooth
{
  const ctx = await browser.newContext({
    viewport: { width: 874, height: 402 },
    isMobile: true,
    hasTouch: true,
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 4 });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 3 });
  });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.__GAME__ && window.__GAME__.ready, null, { timeout: MAX_LOAD_MS });
  const q = await page.evaluate(() => window.__GAME__.quality());
  check(q.quality === "low" && !q.shadows, "[budget phone] starts on Low quality (no shadows)");
  await ctx.close();
}

// a phone held upright: the game asks to be turned sideways and waits
{
  const page = await browser.newPage({
    viewport: { width: 402, height: 874 },
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__GAME__ && window.__GAME__.ready, null, { timeout: MAX_LOAD_MS });
  check(await page.isVisible("#rotate"), "[phone portrait] shows 'Turn your phone sideways'");
  const covered = await page.evaluate(() => {
    const r = document.getElementById("rotate").getBoundingClientRect();
    return r.width >= innerWidth && r.height >= innerHeight;
  });
  check(covered, "[phone portrait] prompt covers the whole screen");
  await page.screenshot({ path: path.join(outDir, "game_phone_portrait.png") });
  // turning the phone (resizing to landscape) removes the prompt
  await page.setViewportSize({ width: 874, height: 402 });
  await page.waitForTimeout(200);
  check(!(await page.isVisible("#rotate")), "[phone portrait] prompt disappears when turned to landscape");
  await page.close();
}
await browser.close();
server.close();
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
