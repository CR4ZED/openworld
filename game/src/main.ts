/** FCI Colony 3D: load world data, build the scene, walk around. */
import * as THREE from "three";
import { makeCollider } from "./collision";
import { makeControls, type Input, type Look } from "./controls";
import { roadDrain, roadSurface, roadWidth } from "./resolve";
import type { Pt, Road, World } from "./types";
import { buildWorld, makeRoadLocator, setEstimateTint } from "./world";

const EYE_HEIGHT = 1.6;
const WALK_SPEED = 1.4; // m/s, typical walking pace
const RUN_SPEED = 4.0;
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
  const sky = new THREE.Color("#dfe6ea");
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 250, 900);
  // bright tropical daylight: strong warm sun so walls facing it and walls in shade read differently
  scene.add(new THREE.HemisphereLight("#f4f8fc", "#b9a888", 1.7));
  scene.add(new THREE.AmbientLight("#ffffff", 0.6));
  const sun = new THREE.DirectionalLight("#fff3dc", 2.2);
  sun.position.set(-250, 400, 180); // afternoon sun from the south-west
  scene.add(sun);

  const built = buildWorld(world);
  scene.add(built.group);
  const collider = makeCollider(world);
  const roadAt = makeRoadLocator(world);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1500);
  const look: Look = { yaw: 0, pitch: 0 };
  const player = { x: 0, y: 0 };
  const start = world.roads.find((r) => r.id === START_ROAD) ?? world.roads[0]!;
  placeOnRoad(start, player, look);

  const controls = makeControls(canvas, look);
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
  resize();

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
    step(dt, controls.read());
    camera.position.set(player.x, EYE_HEIGHT, -player.y);
    const dir = new THREE.Vector3(
      Math.sin(look.yaw) * Math.cos(look.pitch),
      Math.sin(look.pitch),
      -Math.cos(look.yaw) * Math.cos(look.pitch),
    );
    camera.lookAt(camera.position.clone().add(dir));
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
    player: () => ({ x: player.x, y: player.y, yaw: look.yaw }),
    teleport: (x: number, y: number, yaw: number) => {
      player.x = x;
      player.y = y;
      look.yaw = yaw;
      look.pitch = 0;
    },
    step: (seconds: number, input: Input) => {
      for (let t = 0; t < seconds; t += 1 / 30) step(1 / 30, input);
    },
    blocked: (x: number, y: number) => collider.blocked(x, y),
    wallNear: (x: number, y: number, minLen: number, maxDist: number) =>
      collider.wallNear(x, y, minLen, maxDist),
    roadAt: (x: number, y: number) => roadAt(x, y)?.id ?? null,
    hud: () => where.textContent,
  };
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
