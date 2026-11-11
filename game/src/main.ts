/** FCI Colony 3D: load world data, build the scene, walk around. */
import * as THREE from "three";
import { ON_FOOT, ON_SCOOTER, placeCamera, type View } from "./camera";
import { makeCollider } from "./collision";
import { makeControls, type Input, type Look } from "./controls";
import { makeMinimap } from "./minimap";
import { clipLength, clipPose, makeCharacter, makeScooter } from "./models";
import { cycleLength, newWalker, PACE, walkStep, type Walker } from "./player";
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

  const minimap = makeMinimap(world, document.getElementById("minimap") as HTMLCanvasElement);
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1500);
  const look: Look = { yaw: 0, pitch: 0 };
  // z = height above ground, vz = vertical speed, facing = where the body points (third person)
  const player: Walker = newWalker(0, 0, 0);
  let walkMode = false; // C: walk instead of jog
  // what the character is busy doing (no walking/riding control meanwhile); null = free to move
  type Act =
    | { kind: "thrown"; t: number; from: Pt; to: Pt }
    | { kind: "down"; t: number }
    | { kind: "getUp"; t: number }
    | { kind: "approach"; t: number; to: Pt; face: number; then: "lift" | "mount"; side: number }
    | { kind: "lift"; t: number; lean0: number; side: number }
    | { kind: "mount"; t: number; from: Pt; yaw0: number }
    | { kind: "dismount"; t: number; to: Pt };
  let act: Act | null = null;
  const LIE_STILL = 0.7; // seconds lying still after landing
  /** Seconds until you can move again after a fall (thrown + lying + getting up), 0 when free. */
  const downFor = () => {
    if (!act) return 0;
    const up = clipLength("getUp");
    if (act.kind === "thrown") return clipLength("thrown") - act.t + LIE_STILL + up;
    if (act.kind === "down") return LIE_STILL - act.t + up;
    if (act.kind === "getUp") return up - act.t;
    return 0;
  };
  // where the body is drawn (moves on its own during actions; normally follows the player)
  const body = { x: 0, y: 0, h: 0, yaw: 0 };
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
    act = null;
    player.z = player.vz = player.vx = player.vy = 0;
    scooterModel.seat.add(character.root);
    character.root.position.set(0, 0, 0);
    character.root.rotation.set(0, 0, 0);
    look.yaw = scooter.heading;
  };
  /** The seat's position on the ground map, and the spot 0.75 m beside the scooter (side -1 = left, +1 = right). */
  const seatAt = (): Pt => [
    scooter.x - Math.sin(scooter.heading) * 0.15,
    scooter.y - Math.cos(scooter.heading) * 0.15,
  ];
  const besideAt = (side: number, d = 0.75): Pt => [
    scooter.x + Math.cos(scooter.heading) * side * d,
    scooter.y - Math.sin(scooter.heading) * side * d,
  ];
  const freeSide = (prefer: number, d = 0.75) => {
    for (const side of [prefer, -prefer]) {
      const [x, y] = besideAt(side, d);
      if (!collider.blocked(x, y, 0.25)) return side;
    }
    return 0; // hemmed in on both sides: work from where you stand
  };
  const angleTo = (from: Pt, to: Pt) => Math.atan2(to[0] - from[0], to[1] - from[1]);
  const turnTo = (a: number, b: number, k: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;

  /** E near the scooter: walk to its side, pick it up if it has fallen, then swing a leg over and sit. */
  const startUse = () => {
    const h = scooter.heading;
    // work from the side you are already on (no walking across the scooter)
    const mySide = (player.x - scooter.x) * Math.cos(h) - (player.y - scooter.y) * Math.sin(h) >= 0 ? 1 : -1;
    // a fallen scooter: its seat and handlebar stick out ~1.1 m on the side it fell to (lean < 0 = its right);
    // stand just past them there, or close in on the wheels' side and pull it up towards you
    const reach = (side: number) =>
      !scooter.fallen ? 0.75 : side === (scooter.lean < 0 ? 1 : -1) ? 1.3 : 0.85;
    let side = freeSide(mySide, reach(mySide));
    if (side !== mySide && side !== 0 && collider.blocked(...besideAt(side, reach(side)), 0.25)) side = 0;
    const to: Pt = side ? besideAt(side, reach(side)) : [player.x, player.y];
    act = {
      kind: "approach",
      t: 0,
      to,
      side,
      then: scooter.fallen ? "lift" : "mount",
      face: scooter.fallen ? angleTo(to, [scooter.x, scooter.y]) : h,
    };
  };
  /** E while riding (slowly): stop, swing the leg back over, step off to the left (kerb side), else right. */
  const startGetOff = () => {
    if (Math.abs(scooter.speed) > GET_OFF_SPEED) {
      notify("Slow down to get off");
      return;
    }
    scooter.speed = 0;
    const side = freeSide(-1);
    const to: Pt = side
      ? besideAt(side)
      : [scooter.x - Math.sin(scooter.heading) * 1.4, scooter.y - Math.cos(scooter.heading) * 1.4];
    riding = false;
    scene.add(character.root);
    player.facing = scooter.heading;
    [player.x, player.y] = seatAt(); // the body starts exactly where it sat (no one-frame jump)
    act = { kind: "dismount", t: 0, to };
  };
  /** Thrown off in a crash: fly in an arc away from the wall, land on your back. */
  const throwOff = (n: Pt) => {
    const from = seatAt();
    // land clear of the scooter: away from the wall, and to the side its wheels point (its top falls the other
    // way, lean < 0 = falling to its right)
    const away = scooter.lean < 0 ? -1 : 1;
    const sx = Math.cos(scooter.heading) * away,
      sy = -Math.sin(scooter.heading) * away;
    const spots: Pt[] = [
      [from[0] + n[0] * 1.3 + sx * 1.3, from[1] + n[1] * 1.3 + sy * 1.3],
      [from[0] + n[0] * 0.6 + sx * 1.4, from[1] + n[1] * 0.6 + sy * 1.4],
      [from[0] + n[0] * 1.8, from[1] + n[1] * 1.8],
      besideAt(-away, 1.6),
    ];
    const to = spots.find(([x, y]) => !collider.blocked(x, y)) ?? from;
    riding = false;
    scene.add(character.root);
    player.facing = scooter.heading;
    player.vx = player.vy = player.speed = 0;
    [player.x, player.y] = from;
    act = { kind: "thrown", t: 0, from, to };
    notify("You came off!");
  };

  /** Advance whatever the character is busy doing. */
  const actStep = (a: Act, dt: number) => {
    a.t += dt;
    player.speed = 0;
    switch (a.kind) {
      case "thrown": {
        const k = Math.min(1, a.t / clipLength("thrown"));
        const e = 1 - (1 - k) * (1 - k); // fast off the seat, slowing to the landing
        player.x = a.from[0] + (a.to[0] - a.from[0]) * e;
        player.y = a.from[1] + (a.to[1] - a.from[1]) * e;
        body.h = 0.6 * 4 * k * (1 - k); // up and over, then down
        if (k >= 1) act = { kind: "down", t: 0 };
        break;
      }
      case "down":
        body.h = 0;
        if (a.t >= LIE_STILL) act = { kind: "getUp", t: 0 };
        break;
      case "getUp":
        if (a.t >= clipLength("getUp")) {
          act = null;
          notify("Press E to pick the scooter up");
        }
        break;
      case "approach": {
        const dx = a.to[0] - player.x,
          dy = a.to[1] - player.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.05 && a.t < 3) {
          const stepLen = Math.min(d, PACE.walk * dt);
          const [nx, ny] = collider.move(player.x, player.y, (dx / d) * stepLen, (dy / d) * stepLen);
          const moved = Math.hypot(nx - player.x, ny - player.y);
          player.x = nx;
          player.y = ny;
          player.speed = moved / dt;
          player.phase = (player.phase + (moved / cycleLength(player.speed)) * 2 * Math.PI) % (2 * Math.PI);
          player.facing = turnTo(player.facing, Math.atan2(dx, dy), Math.min(1, dt * 10));
          if (moved < stepLen * 0.2) a.t = Math.max(a.t, 3); // blocked: carry on from here
          break;
        }
        player.facing = turnTo(player.facing, a.face, Math.min(1, dt * 12));
        if (Math.abs(Math.sin((a.face - player.facing) / 2)) < 0.05) {
          player.facing = a.face;
          if (a.then === "lift") act = { kind: "lift", t: 0, lean0: scooter.lean, side: a.side };
          else act = { kind: "mount", t: 0, from: [player.x, player.y], yaw0: player.facing };
        }
        break;
      }
      case "lift": {
        // the scooter comes up while the legs straighten (0.6 s to 1.25 s)
        const k = Math.max(0, Math.min(1, (a.t - 0.6) / 0.65));
        scooter.lean = a.lean0 * (1 - k * k * (3 - 2 * k));
        if (a.t >= clipLength("lift")) {
          liftScooter(scooter);
          act = { kind: "mount", t: 0, from: [player.x, player.y], yaw0: player.facing };
        }
        break;
      }
      case "mount": {
        const k = Math.min(1, a.t / clipLength("mount"));
        const e = k * k * (3 - 2 * k);
        const seat = seatAt();
        player.x = a.from[0] + (seat[0] - a.from[0]) * e;
        player.y = a.from[1] + (seat[1] - a.from[1]) * e;
        player.facing = turnTo(a.yaw0, scooter.heading, Math.min(1, k * 2.5));
        if (k >= 1) getOn();
        break;
      }
      case "dismount": {
        const k = Math.min(1, a.t / clipLength("dismount"));
        const e = k * k * (3 - 2 * k);
        const seat = seatAt();
        player.x = seat[0] + (a.to[0] - seat[0]) * e;
        player.y = seat[1] + (a.to[1] - seat[1]) * e;
        if (k >= 1) act = null;
        break;
      }
    }
  };

  /** Advance the game by dt seconds with the given input. */
  const step = (dt: number, input: Input) => {
    if (!(dt > 0)) return;
    clockT += dt;
    minimap.record(player.x, player.y); // the trail on the minimap: a point every 2 m travelled
    if (input.view) view = view === "third" ? "first" : "third";
    shake *= Math.exp(-dt * 6);
    if (scooter.fallen && act?.kind !== "lift") rideStep(scooter, dt, 0, 0, collider); // still sliding
    if (act) {
      actStep(act, dt);
      return;
    }
    if (input.use) {
      if (riding) {
        startGetOff();
        if (act) return;
      } else if (nearScooter()) {
        startUse();
        return;
      }
    }
    if (riding) {
      if (input.horn) honk();
      const hit = rideStep(scooter, dt, input.forward, input.strafe, collider);
      if (hit.hit) shake = Math.max(shake, Math.min(0.35, hit.impact * 0.04));
      if (hit.crashed) {
        crashes++;
        throwOff(hit.normal ?? [0, 0]);
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
    if (walkStep(player, look.yaw, dt, input, walkMode, collider)) jumps++;
  };

  const promptEl = document.getElementById("prompt")!;
  const speedoEl = document.getElementById("speedo")!;
  const rideBtn = document.getElementById("btnRide")!;
  const updateActions = () => {
    const body = document.body;
    body.classList.toggle("riding", riding);
    const canRide = !riding && !act && nearScooter();
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
    if (riding) {
      character.root.rotation.set(0, 0, 0);
      character.animate({ speed: 0, phase: 0, t: clockT, seated: true, airborne: false });
      return;
    }
    body.x = player.x;
    body.y = player.y;
    body.yaw = player.facing;
    if (!act || act.kind === "approach") body.h = player.z;
    character.root.rotation.set(0, -body.yaw, 0);
    character.root.position.set(body.x, body.h, -body.y);
    if (!act || act.kind === "approach") {
      character.animate({
        speed: player.speed,
        phase: player.phase,
        t: clockT,
        seated: false,
        airborne: player.z > 0.02,
      });
      return;
    }
    const clip = act.kind === "down" ? "getUp" : act.kind;
    character.applyPose(clipPose(clip, act.kind === "down" ? 0 : act.t), clockT);
  };
  /** Models follow the game state. */
  const syncModels = () => {
    scooterModel.root.position.set(scooter.x, 0, -scooter.y);
    scooterModel.root.rotation.y = -scooter.heading;
    scooterModel.pose(scooter.distance, scooter.lean + scooter.wobble * Math.sin(clockT * 28));
    poseCharacter();
    scooterModel.root.updateMatrixWorld(true);
    character.root.updateMatrixWorld(true);
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
    syncModels();
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
    minimap.draw(
      {
        x: player.x,
        y: player.y,
        yaw: look.yaw,
        facing: player.facing,
        speed: riding ? Math.abs(scooter.speed) : player.speed,
        scooter: { x: scooter.x, y: scooter.y, show: !riding },
      },
      dt,
    );
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
      syncModels();
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
        pelvis: at("pelvis"),
        handL: at("forearmL"),
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
    downFor: () => downFor(),
    act: () => (act ? { kind: act.kind, t: act.t } : null),
    /** Put the parked scooter somewhere (tests). */
    placeScooter: (x: number, y: number, heading: number) => {
      Object.assign(scooter, newScooter(x, y, heading));
    },
    jumps: () => jumps,
    frames: () => framesDrawn,
    minimap: () => ({
      ...minimap.state,
      trail: minimap.trail.length,
      trailEnd: minimap.trail.at(-1) ?? null,
    }),
    minimapSample: (x: number, y: number) => minimap.sample(x, y),
    minimapColours: () => minimap.colours,
    /** A point inside a building, a restricted area, and on the start lane (for minimap tests). */
    landmarks: () => {
      const inside = (a: { points: Pt[] }) => {
        // centroid of the polygon (fine for the convex-ish footprints we pick)
        let cx = 0,
          cy = 0;
        for (const p of a.points) {
          cx += p[0];
          cy += p[1];
        }
        return [cx / a.points.length, cy / a.points.length] as Pt;
      };
      const big = world.areas
        .filter((a) => a.kind === "building" && a.points.length <= 6)
        .map((a) => ({ a, c: inside(a) }))
        .find(({ c }) => collider.inside(c[0], c[1]));
      const restricted = world.areas.find((a) => a.restricted);
      return { building: big?.c ?? null, restricted: restricted ? inside(restricted) : null };
    },
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
    setLook: (yaw: number, pitch: number) => {
      look.yaw = yaw;
      look.pitch = pitch;
    },
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
