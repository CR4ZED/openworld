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
  // the first frames can have a zero time step: speed and gait phase must still be real numbers (once were NaN)
  check(
    Number.isFinite(start.speed) && Number.isFinite(start.phase),
    `[${label}] movement state is valid after loading (speed ${start.speed}, phase ${start.phase})`,
  );
  check(
    (await page.evaluate(({ x, y }) => window.__GAME__.roadAt(x, y), start)) === "road-545446015",
    `[${label}] player starts on the surveyed colony lane`,
  );
  const hud = await page.evaluate(() => window.__GAME__.hud());
  check(
    /9 m/.test(hud) && !/9 m ≈ estimate/.test(hud),
    `[${label}] HUD shows the lane's surveyed width (no estimate tag): "${hud}"`,
  );

  // owner 2026-11-11: the 1.4 m/s stroll was far too slow. Forward = an easy jog (3.5 m/s) like other open-world
  // games; C = walk (1.6), Shift = sprint (6.0). Real human paces, quick to start and stop.
  const moved = await page.evaluate(() => {
    const a = window.__GAME__.player();
    window.__GAME__.step(2, { forward: 1, strafe: 0, run: false });
    const b = window.__GAME__.player();
    return Math.hypot(b.x - a.x, b.y - a.y);
  });
  check(
    moved > 5.8 && moved < 7.2,
    `[${label}] moving forward 2 s along the lane jogs ${moved.toFixed(2)} m`,
  );
  const pace = await page.evaluate(() => {
    const g = window.__GAME__;
    const F = { forward: 1, strafe: 0, run: false };
    const none = { forward: 0, strafe: 0, run: false };
    const jog = g.walkSim([[3, F]]);
    const walk = g.walkSim([[3, F]], true);
    const sprint = g.walkSim([[3, { ...F, run: true }]]);
    const light = g.walkSim([[3, { forward: 0.4, strafe: 0, run: false }]]);
    const stop = g.walkSim([
      [2, F],
      [0.4, none],
    ]);
    return {
      jog: jog.speeds.at(-1),
      jogAt03: jog.speeds[2],
      walk: walk.speeds.at(-1),
      sprint: sprint.speeds.at(-1),
      light: light.speeds.at(-1),
      stopped: stop.speeds.at(-1),
      // steps per second once at pace (last 2 s)
      cadence: {
        walk: (g.walkSim([[3, F]], true).steps - g.walkSim([[1, F]], true).steps) / 2,
        jog: (jog.steps - g.walkSim([[1, F]]).steps) / 2,
        sprint: (sprint.steps - g.walkSim([[1, { ...F, run: true }]]).steps) / 2,
      },
    };
  });
  check(
    Math.abs(pace.jog - 3.5) < 0.01,
    `[${label}] default pace is an easy jog (${pace.jog.toFixed(2)} m/s)`,
  );
  check(Math.abs(pace.walk - 1.6) < 0.01, `[${label}] C walks at a brisk 1.6 m/s (${pace.walk.toFixed(2)})`);
  check(Math.abs(pace.sprint - 6) < 0.01, `[${label}] Shift sprints at 6 m/s (${pace.sprint.toFixed(2)})`);
  check(
    pace.light > 0.5 && pace.light <= 1.6,
    `[${label}] a light push on the joystick walks (${pace.light.toFixed(2)})`,
  );
  check(pace.jogAt03 > 2.9, `[${label}] up to speed quickly (${pace.jogAt03.toFixed(2)} m/s after 0.3 s)`);
  check(pace.stopped === 0, `[${label}] stops within 0.4 s of letting go (no sliding)`);
  check(
    pace.cadence.walk > 1.6 &&
      pace.cadence.walk < 2.1 &&
      pace.cadence.jog > 2.3 &&
      pace.cadence.jog < 2.9 &&
      pace.cadence.sprint > 2.8 &&
      pace.cadence.sprint < 3.6,
    `[${label}] natural steps per second: walk ${pace.cadence.walk.toFixed(2)}, jog ${pace.cadence.jog.toFixed(2)}, sprint ${pace.cadence.sprint.toFixed(2)}`,
  );

  // a natural gait (owner: "walks like a robot"): feet stay planted while carrying weight, knees fold on the
  // swinging leg, arms swing opposite the legs, and the legs stop when the body stops
  for (const [mode, walk] of [
    ["walking", true],
    ["jogging", false],
  ]) {
    const gait = await page.evaluate(
      ({ s, walk }) => {
        const g = window.__GAME__;
        g.teleport(s.x, s.y, s.yaw);
        if (g.player().walkMode !== walk) g.step(1 / 30, { forward: 0, strafe: 0, run: false, walk: true });
        const F = { forward: 1, strafe: 0, run: false };
        g.step(walk ? 1 : 0.6, F); // get up to pace
        const samples = [];
        for (let i = 0; i < (walk ? 66 : 42); i++) {
          g.step(1 / 30, F);
          samples.push({ p: g.player(), j: g.joints() });
        }
        if (walk) g.step(1 / 30, { forward: 0, strafe: 0, run: false, walk: true }); // back to jogging
        let plantedL = 0,
          plantedR = 0,
          moving = 0;
        let minKnee = 0,
          thighMin = 0,
          thighMax = 0,
          armLegProduct = 0;
        for (let i = 1; i < samples.length; i++) {
          const a = samples[i - 1],
            b = samples[i];
          const body = Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y) * 30;
          if (body < 0.5) continue;
          moving++;
          const f = (k) => Math.hypot(b.j[k].x - a.j[k].x, b.j[k].y - a.j[k].y) * 30;
          if (f("footL") < 0.35 * body) plantedL++;
          if (f("footR") < 0.35 * body) plantedR++;
          minKnee = Math.min(minKnee, b.j.kneeL);
          thighMin = Math.min(thighMin, b.j.thighL);
          thighMax = Math.max(thighMax, b.j.thighL);
          armLegProduct += b.j.armL * b.j.thighL;
        }
        return {
          moving,
          plantedL: plantedL / moving,
          plantedR: plantedR / moving,
          minKnee,
          swing: thighMax - thighMin,
          armOpposite: armLegProduct < 0,
        };
      },
      { s: start, walk },
    );
    check(
      gait.moving > 20 && gait.plantedL > 0.15 && gait.plantedR > 0.15,
      `[${label}] ${mode}: each foot stays planted part of the stride, no skating (L ${(gait.plantedL * 100).toFixed(0)}%, R ${(gait.plantedR * 100).toFixed(0)}%)`,
    );
    check(
      gait.swing > 0.5 && gait.minKnee < -0.6,
      `[${label}] ${mode}: legs swing (${gait.swing.toFixed(2)} rad) and knees bend (${gait.minKnee.toFixed(2)} rad)`,
    );
    check(gait.armOpposite, `[${label}] ${mode}: arms swing opposite the legs`);
  }
  await page.evaluate(({ x, y, yaw }) => window.__GAME__.teleport(x, y, yaw), start);

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
    // the help line never runs under the map credits, also on a narrower laptop window
    for (const width of [1280, 1000]) {
      await page.setViewportSize({ width, height: 700 });
      const clash = await page.evaluate(() => {
        const a = document.getElementById("help").getBoundingClientRect();
        const b = document.getElementById("attrib").getBoundingClientRect();
        return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      });
      check(!clash, `[${label}] help text clear of the credits at ${width} px wide`);
    }
    await page.setViewportSize(opts.viewport);
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

  // ---- third-person camera and the scooter ----
  const g = (fn, arg) => page.evaluate(fn, arg);
  // the test browser can draw very slowly: wait for real frames rather than a fixed time
  const frames = async (n = 2) => {
    const f0 = await g(() => window.__GAME__.frames());
    await page.waitForFunction((f) => window.__GAME__.frames() >= f, f0 + n, { timeout: 10000 });
  };
  check((await g(() => window.__GAME__.view())) === "third", `[${label}] third-person view by default`);
  await g(({ x, y, yaw }) => window.__GAME__.teleport(x, y, yaw), start);
  await frames();
  const cam = await g(() => ({ c: window.__GAME__.camera(), p: window.__GAME__.player() }));
  const camBack = Math.hypot(cam.c.x - cam.p.x, cam.c.y - cam.p.y);
  check(
    camBack > 1.5 && camBack < 5 && cam.c.z > 1.6 && cam.c.z < 3,
    `[${label}] camera sits behind and above the player (${camBack.toFixed(1)} m back, ${cam.c.z.toFixed(1)} m up)`,
  );
  // the scooter starts parked near the start, on the road, not inside anything
  const parked = await g(() => window.__GAME__.scooter());
  check(
    Math.hypot(parked.x - start.x, parked.y - start.y) < 6 &&
      (await g(({ x, y }) => window.__GAME__.roadAt(x, y), parked)) !== null &&
      !(await g(({ x, y }) => window.__GAME__.blocked(x, y, 0.6), parked)),
    `[${label}] scooter parked on the lane near the start`,
  );
  check(
    parked.speed === 0 && !(await g(() => window.__GAME__.riding())),
    `[${label}] scooter parked, on foot`,
  );

  // riding physics on open ground, against a real 110 cc scooter road test (Autocar India, Activa 110, 2025):
  // 85 km/h top, 0-40 3.64 s, 0-60 8.13 s, 0-80 18.12 s, 60-0 in 18.43 m. (Owner: the 45 km/h cap was not true.)
  const sim = await g(() => {
    const s = window.__GAME__.rideSim;
    const full = s(45, 1, 0);
    return {
      reach: full.reach,
      top: full.kmh,
      brake60: s(6, -1, 0, 60).stopDistance,
      coast: s(3, 0, 0, 45).kmh,
      standstillTurn: s(1, 0, 1).heading,
      turn: s(2, 0.6, 1, 30).heading,
      reverse: s(5, -1, 0).kmh,
    };
  });
  const r = sim.reach;
  check(
    r[40] > 3 && r[40] < 5 && r[60] > 7 && r[60] < 9.5 && r[80] > 16 && r[80] < 20.5,
    `[${label}] acceleration like the real scooter: 0-40 ${r[40]?.toFixed(1)} s, 0-60 ${r[60]?.toFixed(1)} s, 0-80 ${r[80]?.toFixed(1)} s`,
  );
  check(sim.top > 83 && sim.top <= 85.01, `[${label}] top speed ${sim.top.toFixed(1)} km/h (real: 85)`);
  check(
    sim.brake60 > 16.5 && sim.brake60 < 20.5,
    `[${label}] brakes from 60 km/h in ${sim.brake60?.toFixed(1)} m (real: 18.4 m)`,
  );
  check(
    sim.coast > 30 && sim.coast < 45,
    `[${label}] coasting slows gently (${sim.coast.toFixed(0)} km/h after 3 s)`,
  );
  check(Math.abs(sim.standstillTurn) < 1e-9, `[${label}] can't steer-turn while standing still`);
  check(
    sim.turn > 1 && sim.turn < 5,
    `[${label}] steering right turns right (${sim.turn.toFixed(2)} rad in 2 s)`,
  );
  check(
    sim.reverse < 0 && sim.reverse > -5.5,
    `[${label}] reversing is a slow push (${sim.reverse.toFixed(1)} km/h)`,
  );

  // hitting a wall (owner: "no physics, the speed drops to 0"): a test wall 2-3 m ahead, running east-west
  const wallSim = await g(() => {
    const s = window.__GAME__.rideSim;
    // glancing: 40 km/h, 15 degrees towards the wall
    const glance = s(3, 0.3, 0, 40, { y: 2, heading: Math.PI / 2 - 0.26 });
    // gentle head-on bump at 10 km/h
    const bump = s(2, 0, 0, 10, { y: 3, heading: 0 });
    // hard head-on crash at 40 km/h
    const crash = s(3, 0, 0, 40, { y: 3, heading: 0 });
    return { glance, bump, crash };
  });
  const gl = wallSim.glance;
  check(
    gl.hits.length > 0 &&
      !gl.fallen &&
      gl.kmh > 25 &&
      Math.abs(gl.heading - Math.PI / 2) < 0.15 &&
      gl.maxY <= 1.4 + 1e-6,
    `[${label}] glancing off a wall scrapes along it: keeps ${gl.kmh.toFixed(0)} km/h, turns parallel (${gl.heading.toFixed(2)} rad), never through`,
  );
  const bp = wallSim.bump;
  check(
    bp.hits.length > 0 && !bp.fallen && bp.y < bp.maxY - 0.1 && bp.maxY <= 2.4 + 1e-6,
    `[${label}] a slow head-on bump bounces back ${(bp.maxY - bp.y).toFixed(2)} m, rider stays on`,
  );
  const cr = wallSim.crash;
  check(
    cr.fallen && cr.hits.some((h) => h.crashed) && cr.maxY <= 2.4 + 1e-6,
    `[${label}] a hard head-on crash at 40 km/h knocks the scooter over (impact ${cr.hits[0]?.impact.toFixed(1)} m/s), never through`,
  );

  // getting on: put the scooter 1.5 m ahead of the player; the prompt / Ride button appears
  await g(({ x, y, yaw }) => {
    window.__GAME__.placeScooter(x + Math.sin(yaw) * 1.5, y + Math.cos(yaw) * 1.5, yaw);
  }, start);
  await frames();
  const promptText = await page.textContent("#prompt");
  check(
    (await page.isVisible("#prompt")) && /scooter/i.test(promptText),
    `[${label}] near the scooter, a prompt says how to ride: "${promptText}"`,
  );
  if (label === "desktop") {
    await page.keyboard.press("KeyE");
  } else {
    check(await page.isVisible("#btnRide"), `[${label}] Ride button shown near the scooter`);
    await page.tap("#btnRide");
  }
  const rode = await page
    .waitForFunction(() => window.__GAME__.riding(), null, { timeout: 30000 }) // walks over and gets on (~1.5 s game time)
    .then(() => true)
    .catch(() => false);
  check(rode, `[${label}] ${label === "desktop" ? "E" : "Ride button"} gets you on the scooter`);
  await frames();
  check(await page.isVisible("#speedo"), `[${label}] speedometer shown while riding`);
  if (label === "phone") {
    check(
      (await page.isVisible("#btnHorn")) && !(await page.isVisible("#btnJump")),
      `[${label}] Horn button replaces Jump while riding`,
    );
    check((await page.textContent("#btnRide")) === "Get off", `[${label}] Ride button becomes "Get off"`);
  }
  const ride = await g(() => {
    const w = window.__GAME__;
    const a = w.scooter();
    w.step(2, { forward: 1, strafe: 0, run: false });
    const b = w.scooter();
    const p = w.player();
    w.step(1.5, { forward: -1, strafe: 0, run: false }); // brake: don't coast into a wall while the test reads the screen
    return { moved: Math.hypot(b.x - a.x, b.y - a.y), kmh: b.kmh, follows: Math.hypot(p.x - b.x, p.y - b.y) };
  });
  check(
    ride.moved > 3 && ride.moved < 12 && ride.follows < 1e-6,
    `[${label}] riding 2 s on throttle moves ${ride.moved.toFixed(1)} m, rider stays on it`,
  );
  await frames();
  check(
    /km\/h/.test(await page.textContent("#speedo")),
    `[${label}] speedometer reads "${await page.textContent("#speedo")}"`,
  );
  await page.screenshot({ path: path.join(outDir, `game_${label}_riding.png`) });

  // horn: once per press, only while riding
  const honks0 = await g(() => window.__GAME__.honks());
  if (label === "desktop") await page.keyboard.press("KeyH");
  else await page.tap("#btnHorn");
  const honked = await page
    .waitForFunction((n) => window.__GAME__.honks() === n + 1, honks0, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(honked, `[${label}] ${label === "desktop" ? "H" : "Horn button"} sounds the horn once`);

  // can't jump off at speed; can after slowing down, and the scooter stays where it was left
  const off = await g(({ x, y, yaw }) => {
    const w = window.__GAME__;
    // back to the start of the lane (the live game kept coasting), then speed up a little
    w.placeScooter(x, y, yaw);
    w.step(1.5, { forward: 1, strafe: 0, run: false });
    const fast = w.scooter().kmh;
    w.step(1 / 30, { forward: 0, strafe: 0, run: false, use: true });
    const stillOn = w.riding();
    w.step(3, { forward: -1, strafe: 0, run: false });
    w.step(1 / 30, { forward: 0, strafe: 0, run: false, use: true });
    // getting off is animated: swing the leg back over and step down (no teleporting)
    let dismountSeen = false,
      jump = 0,
      last = w.joints().head;
    for (let i = 0; i < 24; i++) {
      w.step(1 / 30, { forward: 0, strafe: 0, run: false });
      if (w.act()?.kind === "dismount") dismountSeen = true;
      const h = w.joints().head;
      jump = Math.max(jump, Math.hypot(h.x - last.x, h.y - last.y, h.z - last.z));
      last = h;
    }
    const s = w.scooter();
    const p = w.player();
    const offNow = !w.riding();
    const gap = Math.hypot(p.x - s.x, p.y - s.y);
    const inside = w.blocked(p.x, p.y);
    const honksOnFoot = w.honks();
    w.step(2, { forward: 1, strafe: 0, run: false, horn: true }); // walk away; horn does nothing on foot
    const s2 = w.scooter();
    return {
      fast,
      stillOn,
      offNow,
      gap,
      inside,
      stays: Math.hypot(s2.x - s.x, s2.y - s.y) < 1e-6 && Math.abs(s2.speed) < 1e-6,
      hornOnFoot: w.honks() - honksOnFoot,
      dismountSeen,
      jump,
    };
  }, start);
  check(
    off.dismountSeen && off.jump < 0.15,
    `[${label}] getting off is animated and smooth (head moves at most ${off.jump.toFixed(2)} m per frame)`,
  );
  check(off.stillOn, `[${label}] can't get off at ${off.fast.toFixed(0)} km/h ("slow down")`);
  check(
    off.offNow && off.gap > 0.5 && off.gap < 1.6 && !off.inside,
    `[${label}] after braking you get off beside the scooter (${off.gap.toFixed(2)} m away, not in a wall)`,
  );
  check(off.stays, `[${label}] the scooter stays parked where you left it`);
  check(off.hornOnFoot === 0, `[${label}] no horn on foot`);

  // riding hard at a real building: the rider is thrown off, the scooter falls; nobody ends up inside the
  // building; you get up after a moment and E picks the scooter back up
  const crash = await g(() => {
    const w = window.__GAME__;
    const p = w.player();
    for (let maxDist = 40; maxDist <= 240; maxDist += 40) {
      for (let tries = 0; tries < 6; tries++) {
        const e = w.wallNear(p.x + tries * 30, p.y - tries * 20, 10, maxDist);
        if (!e) continue;
        const mx = (e.a[0] + e.b[0]) / 2,
          my = (e.a[1] + e.b[1]) / 2;
        const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
        const nx = -(e.b[1] - e.a[1]) / len,
          ny = (e.b[0] - e.a[0]) / len;
        for (const side of [1, -1]) {
          // need 12 m of open ground in front of the wall
          let clear = true;
          for (let d = 1.5; d <= 13; d += 0.5)
            if (w.blocked(mx + side * nx * d, my + side * ny * d, 0.7)) clear = false;
          if (!clear) continue;
          const sx = mx + side * nx * 12,
            sy = my + side * ny * 12;
          const yaw = Math.atan2(-side * nx, -side * ny);
          w.placeScooter(sx, sy, yaw);
          w.teleport(sx - Math.sin(yaw) * 1, sy - Math.cos(yaw) * 1, yaw);
          w.step(1 / 30, { forward: 0, strafe: 0, run: false, use: true });
          w.step(2.5, { forward: 0, strafe: 0, run: false }); // walk to its side, swing a leg over
          if (!w.riding()) return { found: false, why: "could not get on" };
          let everInside = false;
          let peak = 0;
          const crashes0 = w.crashes();
          for (let i = 0; i < 80 && w.riding(); i++) {
            w.step(0.1, { forward: 1, strafe: 0, run: false });
            const s = w.scooter();
            peak = Math.max(peak, s.kmh);
            if (w.blocked(s.x, s.y, 0.3)) everInside = true;
          }
          const thrown = !w.riding() && w.crashes() === crashes0 + 1;
          const down = w.downFor() > 0;
          // film the fall frame by frame (30 fps): thrown, lying, getting up. Pressing W does nothing meanwhile.
          const fall = [];
          const p0 = w.player();
          let stuck = true;
          for (let i = 0; i < 150 && (i < 3 || w.downFor() > 0); i++) {
            w.step(1 / 30, { forward: i < 40 ? 1 : 0, strafe: 0, run: false });
            const q = w.player();
            if (i < 40 && w.act()?.kind !== "thrown" && Math.hypot(q.x - p0.x, q.y - p0.y) > 2.2)
              stuck = false;
            fall.push({ kind: w.act()?.kind ?? "-", j: w.joints() });
          }
          w.step(0.5, { forward: 0, strafe: 0, run: false }); // the scooter slides to a stop
          const s = w.scooter();
          const p = w.player();
          const riderInside = w.blocked(p.x, p.y);
          const fallen = s.fallen;
          const scooterInside = w.blocked(s.x, s.y, 0.3);
          // E: walk to its side, bend, lift it upright, swing a leg over (filmed frame by frame)
          const near = Math.hypot(p.x - s.x, p.y - s.y) <= 2.5;
          w.step(1 / 30, { forward: 0, strafe: 0, run: false, use: true });
          const lift = [];
          for (let i = 0; i < 150 && !w.riding(); i++) {
            w.step(1 / 30, { forward: 0, strafe: 0, run: false });
            lift.push({ kind: w.act()?.kind ?? "-", lean: w.scooter().lean, j: w.joints() });
          }
          return {
            fall,
            lift,
            found: true,
            everInside,
            peak,
            thrown,
            down,
            stuck,
            up: w.downFor() === 0,
            fallen,
            riderInside,
            scooterInside,
            near,
            pickedUp: w.riding() && !w.scooter().fallen,
          };
        }
      }
    }
    return { found: false };
  });
  check(
    crash.found &&
      crash.thrown &&
      crash.fallen &&
      !crash.everInside &&
      !crash.scooterInside &&
      !crash.riderInside,
    `[${label}] riding into a building at ${crash.peak?.toFixed(0)} km/h throws the rider off and knocks the scooter over (nobody inside the building)`,
  );
  check(crash.down && crash.stuck && crash.up, `[${label}] after a fall you lie down briefly, then get up`);
  check(
    crash.near && crash.pickedUp,
    `[${label}] E next to the fallen scooter picks it up and you ride again`,
  );
  // owner: "he just falls flat, then gets up like a robot": the fall must be a real motion
  {
    const f = crash.fall ?? [];
    const of = (k) => f.filter((x) => x.kind === k);
    const maxStep = (frames) => {
      let m = 0;
      for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1].j.head,
          b = frames[i].j.head;
        m = Math.max(m, Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
      }
      return m;
    };
    const airborne = Math.max(0, ...of("thrown").map((x) => x.j.pelvis.z));
    const lying = of("down");
    const kneeling = of("getUp").filter((x) => x.j.pelvis.z > 0.35 && x.j.pelvis.z < 0.7).length;
    const lowest = Math.min(...f.map((x) => Math.min(x.j.head.z, x.j.footL.z, x.j.footR.z)));
    check(airborne > 1.0, `[${label}] thrown off in an arc (hips up to ${airborne.toFixed(2)} m)`);
    check(
      lying.length > 10 && lying.every((x) => x.j.pelvis.z < 0.3 && x.j.head.z < 0.45),
      `[${label}] lands and lies on the ground for ${(lying.length / 30).toFixed(1)} s`,
    );
    check(
      kneeling >= 6,
      `[${label}] gets up through sitting and kneeling, not a stiff flip (${(kneeling / 30).toFixed(2)} s half-way up)`,
    );
    check(
      maxStep(f) < 0.3 && maxStep(f.filter((x) => x.kind !== "thrown")) < 0.15,
      `[${label}] the fall and getting up are smooth (head moves at most ${maxStep(f).toFixed(2)} m per frame)`,
    );
    check(
      lowest > -0.06,
      `[${label}] head and feet never sink into the ground (lowest ${lowest.toFixed(2)} m)`,
    );
    check(f.at(-1)?.j.pelvis.z > 0.88, `[${label}] ends standing up`);
    const l = crash.lift ?? [];
    const kinds = [...new Set(l.map((x) => x.kind))];
    const lifting = l.filter((x) => x.kind === "lift");
    const leans = lifting.map((x) => Math.abs(x.lean));
    const gradual = new Set(leans.map((v) => v.toFixed(2))).size;
    const monotone = leans.every((v, i) => i === 0 || v <= leans[i - 1] + 1e-6);
    check(
      kinds.includes("lift") && kinds.includes("mount") && kinds.indexOf("lift") < kinds.indexOf("mount"),
      `[${label}] picking up: ${kinds.join(" → ")}`,
    );
    check(
      Math.min(...lifting.map((x) => x.j.pelvis.z)) < 0.82 && gradual >= 8 && monotone,
      `[${label}] bends down and the scooter comes up gradually (${gradual} steps), not in one jump`,
    );
    check(
      maxStep(l) < 0.15,
      `[${label}] picking up and getting on are smooth (${maxStep(l).toFixed(2)} m per frame)`,
    );
  }

  // camera never goes inside a building: stand with your back to a wall
  const backToWall = await g(() => {
    const w = window.__GAME__;
    if (w.riding()) {
      w.step(4, { forward: -1, strafe: 0, run: false });
      w.step(1 / 30, { forward: 0, strafe: 0, run: false, use: true });
      w.step(1, { forward: 0, strafe: 0, run: false }); // step off
    }
    const p = w.player();
    const e = w.wallNear(p.x, p.y, 8, 120);
    if (!e) return { found: false };
    const mx = (e.a[0] + e.b[0]) / 2,
      my = (e.a[1] + e.b[1]) / 2;
    const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
    const nx = -(e.b[1] - e.a[1]) / len,
      ny = (e.b[0] - e.a[0]) / len;
    for (const side of [1, -1]) {
      const sx = mx + side * nx * 1,
        sy = my + side * ny * 1;
      if (w.blocked(sx, sy)) continue;
      w.teleport(sx, sy, Math.atan2(side * nx, side * ny)); // facing away from the wall
      return { found: true, onFoot: !w.riding() };
    }
    return { found: false };
  });
  await frames();
  const camWall = await g(() => {
    const c = window.__GAME__.camera();
    return { inside: window.__GAME__.blocked(c.x, c.y, 0.05) };
  });
  check(
    backToWall.found && backToWall.onFoot && !camWall.inside,
    `[${label}] with your back to a wall the camera stays out of the building`,
  );

  // V switches to first person (eye height) and back
  await g(() => window.__GAME__.step(1 / 30, { forward: 0, strafe: 0, run: false, view: true }));
  await frames();
  const fp = await g(() => ({
    v: window.__GAME__.view(),
    c: window.__GAME__.camera(),
    p: window.__GAME__.player(),
  }));
  check(
    fp.v === "first" && Math.hypot(fp.c.x - fp.p.x, fp.c.y - fp.p.y) < 0.01 && Math.abs(fp.c.z - 1.6) < 0.05,
    `[${label}] V switches to first person at eye height (${fp.c.z.toFixed(2)} m)`,
  );
  await g(() => window.__GAME__.step(1 / 30, { forward: 0, strafe: 0, run: false, view: true }));
  check((await g(() => window.__GAME__.view())) === "third", `[${label}] V switches back to third person`);
  const rideStats = await g(() => window.__GAME__.stats());
  check(
    rideStats.drawCalls <= MAX_DRAW_CALLS,
    `[${label}] with player and scooter drawn, draw calls ${rideStats.drawCalls} within budget`,
  );
  check(
    errors.length === 0,
    `[${label}] still no console errors ${errors.length ? JSON.stringify(errors) : ""}`,
  );

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
