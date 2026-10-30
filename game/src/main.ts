/** FCI Colony 3D: load world data, build the scene, walk around. */
import * as THREE from "three";
import { makeCollider } from "./collision";
import { makeControls, type Input, type Look } from "./controls";
import { defaultQuality, saveQuality, type Quality } from "./quality";
import { roadDrain, roadSurface, roadWidth } from "./resolve";
import type { Pt, Road, World } from "./types";
import { buildWorld, makeRoadLocator, setEstimateTint } from "./world";

const EYE_HEIGHT = 1.6;
const WALK_SPEED = 1.4; // m/s, typical walking pace
const RUN_SPEED = 4.0;
const GRAVITY = 9.81; // m/s²
const JUMP_SPEED = 3.0; // m/s upwards: about 0.46 m high, a normal standing jump
// Start on the colony lane the owner surveyed (road-545446015), facing along it.
const START_ROAD = "road-545446015";

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
  const player = { x: 0, y: 0, z: 0, vz: 0 }; // z = height above ground, vz = vertical speed
  let jumps = 0; // jumps started (for tests)
  const start = world.roads.find((r) => r.id === START_ROAD) ?? world.roads[0]!;
  placeOnRoad(start, player, look);

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

  /** Advance the player by dt seconds with the given input. */
  const step = (dt: number, input: Input) => {
    const speed = input.run ? RUN_SPEED : WALK_SPEED;
    const fx = Math.sin(look.yaw),
      fy = Math.cos(look.yaw); // forward in data coords (x east, y north)
    const rx = Math.cos(look.yaw),
      ry = -Math.sin(look.yaw); // right
    let dx = fx * input.forward + rx * input.strafe;
    let dy = fy * input.forward + ry * input.strafe;
    const m = Math.hypot(dx, dy);
    if (m > 1) {
      dx /= m;
      dy /= m;
    }
    [player.x, player.y] = collider.move(player.x, player.y, dx * speed * dt, dy * speed * dt);
    // jumping: only from the ground (no double jumps); gravity brings you back down
    const grounded = player.z <= 0;
    if (input.jump && grounded) {
      player.vz = JUMP_SPEED;
      jumps++;
    }
    if (!grounded || player.vz > 0) {
      player.vz -= GRAVITY * dt;
      player.z = Math.max(0, player.z + player.vz * dt);
      if (player.z === 0) player.vz = 0;
    }
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

  const clock = new THREE.Clock();
  const fpsEl = document.getElementById("fps")!;
  let frames = 0,
    fpsTime = 0,
    fps = 0;
  const frame = () => {
    const dt = Math.min(clock.getDelta(), 0.1);
    // phones held upright show "turn sideways": the world waits until it is landscape
    if (!document.body.classList.contains("portrait")) step(dt, controls.read());
    camera.position.set(player.x, EYE_HEIGHT + player.z, -player.y);
    const dir = new THREE.Vector3(
      Math.sin(look.yaw) * Math.cos(look.pitch),
      Math.sin(look.pitch),
      -Math.cos(look.yaw) * Math.cos(look.pitch),
    );
    camera.lookAt(camera.position.clone().add(dir));
    skyDome.position.copy(camera.position);
    // keep the sun's shadow area centred on the player, snapped to whole metres to avoid shimmering
    const cx = Math.round(player.x),
      cz = Math.round(-player.y);
    sun.target.position.set(cx, 0, cz);
    sun.position.set(cx + SUN_OFFSET.x, SUN_OFFSET.y, cz + SUN_OFFSET.z);
    renderer.render(scene, camera);
    updateHud();
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
    player: () => ({ x: player.x, y: player.y, z: player.z, yaw: look.yaw }),
    jumps: () => jumps,
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
      look.yaw = yaw;
      look.pitch = 0;
    },
    step: (seconds: number, input: Input) => {
      // a jump is one press: only the first sub-step sees it
      for (let t = 0, first = true; t < seconds; t += 1 / 30, first = false)
        step(1 / 30, { ...input, jump: first && !!input.jump });
    },
    blocked: (x: number, y: number) => collider.blocked(x, y),
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
