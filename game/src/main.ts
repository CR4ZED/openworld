/** FCI Colony 3D: load world data, build the scene, walk around. */
import * as THREE from "three";
import { ON_FOOT, ON_SCOOTER, placeCamera, type View } from "./camera";
import { makeCollider } from "./collision";
import { makeControls, type Input, type Look } from "./controls";
import { makeCharacter, makeScooter } from "./models";
import { newWalker, PACE, walkStep, type Walker } from "./player";
import { defaultQuality, saveQuality, type Quality } from "./quality";
import { roadDrain, roadSurface, roadWidth } from "./resolve";
import type { Pt, Road, World } from "./types";
import { liftScooter, newScooter, rideStep, SCOOTER, type Mover, type ScooterState } from "./scooter";
import { honk, honkCount } from "./sound";
import { buildWorld, makeRoadLocator, setEstimateTint } from "./world";

// Start on the colony lane the owner surveyed (road-545446015), facing along it.
const START_ROAD = "road-545446015";
const REACH = 2.5; // m: how close you must be to get on the scooter
const GET_OFF_SPEED = 2; // m/s: slow down below this to get off

const params = new URLSearchParams(location.search);
const testMode = params.has("test");

async function main() {
  const where = document.getElementById("where")!;
  const res = await fetch("./world.json");
  if (!res.ok) throw new Error(`world.json: HTTP ${res.status}`);
  const world = (await res.json()) as World;

  const canvas = document.getElementById("scene") as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: testMode });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  // sky: blue overhead fading to a pale, hazy horizon (fog uses the horizon colour so distance blends in)
  const horizon = new THREE.Color("#e3e6e3");
  scene.background = horizon;
  scene.fog = new THREE.Fog(horizon, 250, 900);
  const skyDome = makeSky(horizon, new THREE.Color("#7fa9d6"));
  scene.add(skyDome);
  // bright tropical daylight: strong warm sun so walls facing it and walls in shade read differently
  scene.add(new THREE.HemisphereLight("#f4f8fc", "#b9a888", 1.7));
  scene.add(new THREE.AmbientLight("#ffffff", 0.6));
  const sun = new THREE.DirectionalLight("#fff3dc", 2.2);
  const SUN_OFFSET = new THREE.Vector3(-120, 190, 85); // afternoon sun from the south-west
  scene.add(sun, sun.target);
  // shadows cover about 140 m around the player and follow them, so the shadow map stays sharp
  sun.shadow.camera.left = sun.shadow.camera.bottom = -70;
  sun.shadow.camera.right = sun.shadow.camera.top = 70;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 500;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;

  const built = buildWorld(world);
  scene.add(built.group);
  const collider = makeCollider(world);
  const roadAt = makeRoadLocator(world);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1500);
  const look: Look = { yaw: 0, pitch: 0 };
  // z = height above ground, vz = vertical speed, facing = where the body points (third person)
  const player: Walker = newWalker(0, 0, 0);
  let walkMode = false; // C: walk instead of jog
  let downFor = 0; // seconds left lying on the ground after coming off the scooter
  let shake = 0; // camera shake after a knock (m)
  let crashes = 0; // for tests
  let jumps = 0; // jumps started (for tests)
  const start = world.roads.find((r) => r.id === START_ROAD) ?? world.roads[0]!;
  placeOnRoad(start, player, look);
  player.facing = look.yaw;

  const character = makeCharacter();
  scene.add(character.root);
  const scooterModel = makeScooter();
  scene.add(scooterModel.root);
  const scooter: ScooterState = parkScooter(player, look.yaw, collider);
  let riding = false;
  let view: View = "third";
  let message = ""; // short notice ("Slow down to get off")
  let messageUntil = 0;

  const controls = makeControls(canvas, look);
  let quality: Quality = defaultQuality(controls.isTouch);
  const qBtn = document.getElementById("btnQuality")!;
  const applyQuality = (q: Quality) => {
    quality = q;
    renderer.shadowMap.enabled = q === "high";
    sun.castShadow = q === "high";
    const size = controls.isTouch ? 1024 : 2048;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
    renderer.setPixelRatio(q === "high" ? Math.min(devicePixelRatio, 2) : 1);
    // shadow on/off changes the shaders: rebuild materials
    scene.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (mat) mat.needsUpdate = true;
    });
    qBtn.textContent = `Quality: ${q === "high" ? "High" : "Low"}`;
    resize();
  };
  qBtn.addEventListener("click", () => {
    const q = quality === "high" ? "low" : "high";
    saveQuality(q);
    applyQuality(q);
  });
  setupLandscape(controls.isTouch);
  let showEstimates = false;
  const btn = document.getElementById("btnEstimates")!;
  btn.addEventListener("click", () => {
    showEstimates = !showEstimates;
    btn.setAttribute("aria-pressed", String(showEstimates));
    setEstimateTint(built.estimateMaterials, showEstimates);
  });

  const resize = () => {
    const w = innerWidth,
      h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  addEventListener("resize", resize);
  applyQuality(quality);

  const nearScooter = () => Math.hypot(scooter.x - player.x, scooter.y - player.y) <= REACH;
  let clockT = 0;
  const notify = (text: string) => {
    message = text;
    messageUntil = clockT + 2.5;
  };

  const getOn = () => {
    riding = true;
    player.z = player.vz = player.vx = player.vy = 0;
    scooterModel.seat.add(character.root);
    character.root.position.set(0, 0, 0);
    character.root.rotation.set(0, 0, 0);
    look.yaw = scooter.heading;
  };
  const getOff = (thrown?: [number, number]) => {
    if (!thrown && Math.abs(scooter.speed) > GET_OFF_SPEED) {
      notify("Slow down to get off");
      return;
    }
    scooter.speed = 0;
    // step off to the left (kerb side in India), else the right, else behind
    const h = scooter.heading;
    const spots: [number, number][] = [
      ...(thrown ? ([[thrown[0] * 1.3, thrown[1] * 1.3]] as [number, number][]) : []),
      [-Math.cos(h) * 0.9, Math.sin(h) * 0.9],
      [Math.cos(h) * 0.9, -Math.sin(h) * 0.9],
      [-Math.sin(h) * 1.4, -Math.cos(h) * 1.4],
    ];
    const free = spots.find(([dx, dy]) => !collider.blocked(scooter.x + dx, scooter.y + dy)) ?? spots[0]!;
    player.x = scooter.x + free[0];
    player.y = scooter.y + free[1];
    player.facing = h;
    riding = false;
    player.vx = player.vy = player.speed = 0;
    scene.add(character.root);
    if (thrown) {
      downFor = 1.6;
      notify("You came off! Press E to pick the scooter up");
    }
  };

  /** Advance the game by dt seconds with the given input. */
  const step = (dt: number, input: Input) => {
    clockT += dt;
    if (input.view) view = view === "third" ? "first" : "third";
    shake *= Math.exp(-dt * 6);
    if (downFor > 0) {
      // lying on the ground after a fall: no moving until you get back up
      downFor = Math.max(0, downFor - dt);
      walkStep(player, look.yaw, dt, { forward: 0, strafe: 0, run: false }, true, collider);
      if (scooter.fallen) rideStep(scooter, dt, 0, 0, collider);
      return;
    }
    if (input.use) {
      if (riding) getOff();
      else if (nearScooter()) {
        if (scooter.fallen) liftScooter(scooter);
        getOn();
      }
    }
    if (riding) {
      if (input.horn) honk();
      const hit = rideStep(scooter, dt, input.forward, input.strafe, collider);
      if (hit.hit) shake = Math.max(shake, Math.min(0.35, hit.impact * 0.04));
      if (hit.crashed) {
        crashes++;
        getOff(hit.normal ?? [0, 0]);
        return;
      }
      player.x = scooter.x;
      player.y = scooter.y;
      player.facing = scooter.heading;
      player.speed = Math.abs(scooter.speed);
      // the camera swings back behind the scooter (the mouse can still look around for a moment)
      const diff = Math.atan2(Math.sin(scooter.heading - look.yaw), Math.cos(scooter.heading - look.yaw));
      look.yaw += diff * Math.min(1, dt * 2.5);
      return;
    }
    if (input.walk) {
      walkMode = !walkMode;
      notify(walkMode ? "Walking (C to jog)" : "Jogging (C to walk)");
    }
    if (scooter.fallen) rideStep(scooter, dt, 0, 0, collider); // still sliding after a crash
    if (walkStep(player, look.yaw, dt, input, walkMode, collider)) jumps++;
  };

  const promptEl = document.getElementById("prompt")!;
  const speedoEl = document.getElementById("speedo")!;
  const rideBtn = document.getElementById("btnRide")!;
  const updateActions = () => {
    const body = document.body;
    body.classList.toggle("riding", riding);
    const canRide = !riding && downFor === 0 && nearScooter();
    body.classList.toggle("near-scooter", canRide);
    rideBtn.textContent = riding ? "Get off" : "Ride";
    let text = "";
    if (clockT < messageUntil) text = message;
    else if (canRide && scooter.fallen)
      text = controls.isTouch ? "Tap Ride to pick the scooter up" : "Press E to pick the scooter up";
    else if (canRide)
      text = controls.isTouch ? "Tap Ride to get on the scooter" : "Press E to ride the scooter";
    else if (riding && !controls.isTouch) text = "W/S throttle · A/D steer · H horn · E get off";
    promptEl.textContent = text;
    promptEl.hidden = !text;
    speedoEl.textContent = `${Math.round(Math.abs(scooter.speed) * 3.6)} km/h`;
  };

  let lastRoad: Road | null | undefined;
  const updateHud = () => {
    const r = roadAt(player.x, player.y);
    if (r === lastRoad) return;
    lastRoad = r;
    if (!r) {
      where.textContent = "Off the road";
      return;
    }
    const tag = (estimated: boolean) => (estimated ? ' <span class="est">≈ estimate</span>' : "");
    const w = roadWidth(r),
      s = roadSurface(r),
      d = roadDrain(r);
    where.innerHTML =
      `<b>${r.name.value ?? r.class}</b> · ${w.value} m${tag(w.estimated)} · ${s.value}${tag(s.estimated)}` +
      ` · drain: ${d.value}${tag(d.estimated)}`;
  };

  const poseCharacter = () => {
    if (!riding) {
      // after a fall: lying on the back, then getting up over the last 0.5 s
      const down = Math.min(1, downFor / 0.5);
      character.root.rotation.order = "YXZ";
      character.root.rotation.set(down * 1.45, -player.facing, 0);
      character.root.position.set(player.x, player.z + down * 0.12, -player.y);
    } else character.root.rotation.set(0, 0, 0);
    character.animate({
      speed: riding ? 0 : player.speed,
      phase: player.phase,
      t: clockT,
      seated: riding,
      airborne: player.z > 0.02,
    });
  };
  let framesDrawn = 0; // for tests: wait for real frames, not wall-clock time
  const clock = new THREE.Clock();
  const fpsEl = document.getElementById("fps")!;
  let frames = 0,
    fpsTime = 0,
    fps = 0;
  const frame = () => {
    const dt = Math.min(clock.getDelta(), 0.1);
    // phones held upright show "turn sideways": the world waits until it is landscape
    if (!document.body.classList.contains("portrait")) step(dt, controls.read());
    // models follow the game state (poseCharacter is defined below the loop)
    scooterModel.root.position.set(scooter.x, 0, -scooter.y);
    scooterModel.root.rotation.y = -scooter.heading;
    scooterModel.pose(scooter.distance, scooter.lean + scooter.wobble * Math.sin(clockT * 28));
    poseCharacter();
    // first person: hide your own body (the camera is inside the head); seated eyes are lower than standing
    character.root.visible = view === "third";
    const seatH = riding ? (view === "first" ? -0.1 : 0.3) : player.z;
    placeCamera(
      camera,
      view,
      look,
      player.x,
      player.y,
      seatH,
      riding ? ON_SCOOTER : ON_FOOT,
      collider.blocked,
    );
    if (shake > 0.005)
      camera.position.add(
        new THREE.Vector3(Math.sin(clockT * 53), Math.sin(clockT * 41), Math.sin(clockT * 47)).multiplyScalar(
          shake,
        ),
      );
    skyDome.position.copy(camera.position);
    // keep the sun's shadow area centred on the player, snapped to whole metres to avoid shimmering
    const cx = Math.round(player.x),
      cz = Math.round(-player.y);
    sun.target.position.set(cx, 0, cz);
    sun.position.set(cx + SUN_OFFSET.x, SUN_OFFSET.y, cz + SUN_OFFSET.z);
    renderer.render(scene, camera);
    updateHud();
    updateActions();
    framesDrawn++;
    frames++;
    fpsTime += dt;
    if (fpsTime >= 1) {
      fps = Math.round(frames / fpsTime);
      fpsEl.textContent = `${fps} fps · ${renderer.info.render.calls} draws`;
      frames = 0;
      fpsTime = 0;
    }
  };
  renderer.setAnimationLoop(frame);

  // Read-only hooks for automated tests (tests/e2e_game.mjs).
  (window as unknown as { __GAME__: unknown }).__GAME__ = {
    ready: true,
    stats: () => ({
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      fps,
      ...built.stats,
    }),
    player: () => ({
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: look.yaw,
      facing: player.facing,
      speed: player.speed,
      phase: player.phase,
      walkMode,
    }),
    paces: () => ({ ...PACE }),
    /**
     * Move on open ground (no buildings) from standing, through segments of [seconds, input]: tests the movement
     * on its own. Returns distance, speed every tenth of a second, and gait steps taken (two per cycle).
     */
    walkSim: (segments: [number, Input][], walk = false) => {
      const p = newWalker(0, 0, 0);
      const open = { move: (x: number, y: number, dx: number, dy: number): Pt => [x + dx, y + dy] };
      const speeds: number[] = [];
      let steps = 0,
        i = 0;
      for (const [seconds, input] of segments)
        for (let t = 0; t < seconds - 1e-9; t += 1 / 60, i++) {
          const ph = p.phase;
          walkStep(p, 0, 1 / 60, input, walk, open);
          steps += ((p.phase - ph + 2 * Math.PI) % (2 * Math.PI)) / Math.PI;
          if (i % 6 === 5) speeds.push(p.speed);
        }
      return { distance: Math.hypot(p.x, p.y), speeds, steps };
    },
    /** Pose the character for the current state and report joints (feet in data coords, angles in radians). */
    joints: () => {
      poseCharacter();
      character.root.updateMatrixWorld(true);
      const v = new THREE.Vector3();
      const at = (n: string) => {
        character.bones[n]!.getWorldPosition(v);
        return { x: v.x, y: -v.z, z: v.y };
      };
      const ang = (n: string) => character.bones[n]!.rotation.x;
      return {
        footL: at("footL"),
        footR: at("footR"),
        thighL: ang("thighL"),
        thighR: ang("thighR"),
        kneeL: ang("shinL"),
        kneeR: ang("shinR"),
        armL: ang("upperArmL"),
        armR: ang("upperArmR"),
        head: at("head"),
      };
    },
    riding: () => riding,
    view: () => view,
    scooter: () => ({ ...scooter, kmh: Math.abs(scooter.speed) * 3.6, maxKmh: SCOOTER.maxSpeed * 3.6 }),
    honks: () => honkCount(),
    camera: () => ({ x: camera.position.x, y: -camera.position.z, z: camera.position.y }),
    /**
     * Ride a copy of the scooter on open ground (no buildings) for `seconds`, starting at `kmh`:
     * tests the riding physics on their own. Returns speed (km/h), heading change and distance.
     */
    rideSim: (
      seconds: number,
      throttle: number,
      steer: number,
      kmh = 0,
      wall?: { y: number; heading: number },
    ) => {
      // optional test wall: the line y = wall.y (running east-west), approached at `heading`
      const s = newScooter(0, 0, wall?.heading ?? 0);
      s.speed = kmh / 3.6;
      const ground: Mover = wall
        ? {
            move: (x, y, dx, dy, r = 0.6): Pt => [x + dx, Math.min(y + dy, wall.y - r)],
            normal: (_x, y, r) => (y >= wall.y - r - 1e-6 ? [0, -1] : null),
          }
        : { move: (x, y, dx, dy): Pt => [x + dx, y + dy] };
      let stopAt: number | null = null;
      let stopDist: number | null = null;
      const reach: Record<number, number> = {};
      const hits: { impact: number; crashed: boolean }[] = [];
      let maxY = -Infinity;
      for (let t = 0; t < seconds - 1e-9; t += 1 / 120) {
        const hit = rideStep(s, 1 / 120, throttle, steer, ground);
        if (hit.hit) hits.push({ impact: hit.impact, crashed: hit.crashed });
        maxY = Math.max(maxY, s.y);
        for (const k of [40, 60, 80])
          if (reach[k] === undefined && s.speed * 3.6 >= k) reach[k] = t + 1 / 120;
        if (stopAt === null && s.speed <= 0 && kmh > 0 && throttle <= 0) {
          stopAt = t + 1 / 120;
          stopDist = Math.hypot(s.x, s.y);
        }
      }
      return {
        kmh: s.speed * 3.6,
        heading: s.heading,
        x: s.x,
        y: s.y,
        maxY,
        distance: Math.hypot(s.x, s.y),
        stoppedAfter: stopAt,
        stopDistance: stopDist,
        reach,
        hits,
        fallen: s.fallen,
      };
    },
    crashes: () => crashes,
    downFor: () => downFor,
    /** Put the parked scooter somewhere (tests). */
    placeScooter: (x: number, y: number, heading: number) => {
      Object.assign(scooter, newScooter(x, y, heading));
    },
    jumps: () => jumps,
    frames: () => framesDrawn,
    skyGradient: () => {
      const col = skyDome.geometry.getAttribute("color");
      const pos = skyDome.geometry.getAttribute("position");
      let top = 0,
        hor = 0;
      for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) > pos.getY(top)) top = i;
        if (Math.abs(pos.getY(i)) < Math.abs(pos.getY(hor))) hor = i;
      }
      const rgb = (i: number) => ({ r: col.getX(i), g: col.getY(i), b: col.getZ(i) });
      return { top: rgb(top), horizon: rgb(hor) };
    },
    quality: () => ({
      quality,
      shadows: renderer.shadowMap.enabled && sun.castShadow,
      pixelRatio: renderer.getPixelRatio(),
    }),
    texturedSurfaces: () => {
      const keys: string[] = [];
      built.group.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined;
        if (m?.map && o.name) keys.push(o.name);
      });
      return keys;
    },
    teleport: (x: number, y: number, yaw: number) => {
      player.x = x;
      player.y = y;
      player.facing = yaw;
      player.vx = player.vy = player.speed = 0;
      look.yaw = yaw;
      look.pitch = 0;
    },
    step: (seconds: number, input: Input) => {
      // one-shot actions (jump, ride, horn, view) are one press: only the first sub-step sees them
      for (let t = 0, first = true; t < seconds - 1e-9; t += 1 / 30, first = false)
        step(1 / 30, {
          ...input,
          jump: first && !!input.jump,
          use: first && !!input.use,
          horn: first && !!input.horn,
          view: first && !!input.view,
          walk: first && !!input.walk,
        });
    },
    blocked: (x: number, y: number, r?: number) => collider.blocked(x, y, r),
    wallNear: (x: number, y: number, minLen: number, maxDist: number) =>
      collider.wallNear(x, y, minLen, maxDist),
    roadAt: (x: number, y: number) => roadAt(x, y)?.id ?? null,
    hud: () => where.textContent,
    mouseLocked: () => controls.locked(),
    look: () => ({ yaw: look.yaw, pitch: look.pitch }),
  };
}

/**
 * Phones play in landscape. Android: "Play" enters fullscreen and locks to landscape. iPhone Safari does not let
 * websites lock orientation, so upright phones get a full-screen "turn your phone sideways" prompt instead.
 */
function setupLandscape(isTouch: boolean) {
  const body = document.body;
  const update = () => body.classList.toggle("portrait", innerHeight > innerWidth);
  addEventListener("resize", update);
  addEventListener("orientationchange", update);
  update();
  if (!isTouch) return;
  body.classList.add("needs-start");
  document.getElementById("btnPlay")!.addEventListener("click", async () => {
    body.classList.remove("needs-start");
    try {
      await document.documentElement.requestFullscreen?.({ navigationUI: "hide" });
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      await o.lock?.("landscape");
    } catch {
      // not supported (e.g. iPhone Safari): the rotate prompt covers portrait instead
    }
  });
}

/**
 * Park the scooter a few metres ahead of the player, at the left edge of the lane (Indian traffic keeps left),
 * facing the same way. Falls back to straight ahead, then right where the player stands, if that is blocked.
 */
function parkScooter(
  player: { x: number; y: number },
  heading: number,
  collider: ReturnType<typeof makeCollider>,
): ScooterState {
  const fx = Math.sin(heading),
    fy = Math.cos(heading);
  for (const [ahead, left] of [
    [4, 1],
    [4, 0],
    [2, 0],
  ] as const) {
    const x = player.x + fx * ahead - fy * left;
    const y = player.y + fy * ahead + fx * left;
    if (!collider.blocked(x, y, SCOOTER.radius)) return newScooter(x, y, heading);
  }
  return newScooter(player.x, player.y, heading);
}

/** A big sphere around the camera, blue overhead and pale at the horizon. One draw call, ignores fog. */
function makeSky(horizon: THREE.Color, zenith: THREE.Color) {
  const geo = new THREE.SphereGeometry(1200, 32, 16);
  const pos = geo.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = Math.max(0, pos.getY(i) / 1200); // 0 at horizon, 1 straight up
    c.copy(horizon)
      .lerp(zenith, Math.pow(h, 0.6))
      .toArray(colors, i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "sky";
  mesh.renderOrder = -1;
  return mesh;
}

/** Put the player in the middle of a road, facing along it. */
function placeOnRoad(r: Road, player: { x: number; y: number }, look: Look) {
  const part = r.parts.reduce((a, b) => (b.length > a.length ? b : a));
  const i = Math.max(0, Math.floor(part.length / 2) - 1);
  const a: Pt = part[i]!,
    b: Pt = part[i + 1] ?? part[i]!;
  player.x = (a[0] + b[0]) / 2;
  player.y = (a[1] + b[1]) / 2;
  look.yaw = Math.atan2(b[0] - a[0], b[1] - a[1]);
  look.pitch = 0;
}

main().catch((err: unknown) => {
  const where = document.getElementById("where");
  if (where) where.textContent = `Could not load the colony: ${String(err)}`;
  console.error(err);
});
