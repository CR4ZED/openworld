/**
 * Round minimap, like open-world games: real roads (coloured by surface), buildings and the restricted area,
 * turned so the way you're looking is always up, with the trail of where you've been.
 * The map is drawn once into a big canvas (1 px per metre); each frame copies the part around you.
 */
import { roadSurface, roadWidth, surfaceMaterial } from "./resolve";
import type { Pt, World } from "./types";

const SURFACE_COLOUR: Record<string, string> = {
  tar: "#4b4d52",
  concrete: "#c9c6bd",
  redmud: "#b0644a",
  paving: "#a7a39a",
  gravel: "#a89d88",
  mud: "#9c7e5c",
};
const GROUND = "#e2d6b8";
const BUILDING = "#b9a48c";
const RESTRICTED = "#c7b7b0";
const TRAIL = "#1d6fd8";
const TRAIL_STEP_M = 2; // a trail point every 2 m
const TRAIL_MAX = 4000; // 8 km of trail

export interface MinimapView {
  x: number; // player position (data coords, m)
  y: number;
  yaw: number; // camera direction (radians, 0 = north, clockwise)
  facing: number; // body direction
  speed: number; // m/s, zooms out when fast
  scooter: { x: number; y: number; show: boolean };
}

export function makeMinimap(world: World, canvas: HTMLCanvasElement) {
  const R = world.meta.radius_m;
  const S = 1; // px per metre in the base map
  const base = document.createElement("canvas");
  base.width = base.height = Math.ceil(2 * R * S);
  const b = base.getContext("2d")!;
  const px = (p: Pt): [number, number] => [(p[0] + R) * S, (R - p[1]) * S];

  // ---- the static map, drawn once ----
  b.fillStyle = GROUND;
  b.fillRect(0, 0, base.width, base.height);
  const poly = (pts: Pt[]) => {
    b.beginPath();
    pts.forEach((p, i) => (i ? b.lineTo(...px(p)) : b.moveTo(...px(p))));
    b.closePath();
  };
  for (const a of world.areas) {
    if (!a.restricted) continue;
    poly(a.points);
    b.fillStyle = RESTRICTED;
    b.fill();
    // diagonal hatching: a restricted area, nothing shown inside
    b.save();
    b.clip();
    b.strokeStyle = "rgba(120, 70, 60, 0.35)";
    b.lineWidth = 2;
    for (let d = -2 * R; d < 2 * R; d += 14) {
      b.beginPath();
      b.moveTo(d, 0);
      b.lineTo(d + 2 * R, 2 * R);
      b.stroke();
    }
    b.restore();
  }
  b.lineJoin = b.lineCap = "round";
  for (const r of world.roads) {
    if (r.surroundings?.in_restricted) continue; // restricted areas are never modelled
    b.strokeStyle = SURFACE_COLOUR[surfaceMaterial(roadSurface(r).value).main] ?? SURFACE_COLOUR.mud!;
    b.lineWidth = Math.max(3, roadWidth(r).value) * S;
    for (const part of r.parts) {
      b.beginPath();
      part.forEach((p, i) => (i ? b.lineTo(...px(p)) : b.moveTo(...px(p))));
      b.stroke();
    }
  }
  b.fillStyle = BUILDING;
  for (const a of world.areas) {
    if (a.kind !== "building") continue;
    poly(a.points);
    b.fill();
  }

  // ---- trail ----
  const trail: Pt[] = [];
  const record = (x: number, y: number) => {
    const last = trail.at(-1);
    const d = last ? Math.hypot(x - last[0], y - last[1]) : Infinity;
    if (d < TRAIL_STEP_M) return;
    // a jump (respawn, teleport) starts a new piece of trail instead of a line across the map
    if (last && !isNaN(last[0]) && d > 30) trail.push([NaN, NaN]);
    trail.push([x, y]);
    if (trail.length > TRAIL_MAX) trail.shift();
  };

  const ctx = canvas.getContext("2d")!;
  let viewRadius = 70; // metres from the centre to the edge of the minimap
  const state = { rotation: 0, viewRadius, drawn: 0 };

  const draw = (v: MinimapView, dt: number) => {
    // size the canvas to its on-screen size (sharp on high-density screens)
    const cssW = canvas.clientWidth;
    if (!cssW) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const size = Math.round(cssW * dpr);
    if (canvas.width !== size) canvas.width = canvas.height = size;
    // zoom out when moving fast (riding) so you can see the road ahead
    const want = 70 + Math.min(1, v.speed / 15) * 90;
    viewRadius += (want - viewRadius) * Math.min(1, dt * 2);
    const half = size / 2;
    const k = half / viewRadius; // screen px per metre
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = GROUND;
    ctx.fillRect(0, 0, size, size);
    // world -> minimap: centre on the player, turn so the camera direction points up
    ctx.translate(half, half);
    ctx.rotate(-v.yaw);
    ctx.scale(k, k);
    ctx.translate(-v.x, v.y); // data y is north; canvas y grows downwards
    ctx.drawImage(base, -R, -R, 2 * R, 2 * R);
    if (trail.length > 1) {
      ctx.strokeStyle = TRAIL;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 3 / k;
      ctx.lineJoin = ctx.lineCap = "round";
      ctx.beginPath();
      let pen = false;
      for (const [x, y] of trail) {
        if (isNaN(x)) pen = false;
        else if (pen) ctx.lineTo(x, -y);
        else {
          ctx.moveTo(x, -y);
          pen = true;
        }
      }
      ctx.lineTo(v.x, -v.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (v.scooter.show) {
      ctx.fillStyle = "#b3262e";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5 / k;
      ctx.beginPath();
      ctx.arc(v.scooter.x, -v.scooter.y, 4 / k, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    // the player: an arrow in the middle pointing where the body faces (relative to the view)
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(v.facing - v.yaw);
    const a = size * 0.055;
    ctx.beginPath();
    ctx.moveTo(0, -a * 1.3);
    ctx.lineTo(a, a);
    ctx.lineTo(0, a * 0.45);
    ctx.lineTo(-a, a);
    ctx.closePath();
    ctx.fillStyle = "#facc15";
    ctx.strokeStyle = "#1f2328";
    ctx.lineWidth = Math.max(1.5, size * 0.012);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // north marker on the rim
    const n = -v.yaw;
    const nx = half + Math.sin(n) * (half - size * 0.08),
      ny = half - Math.cos(n) * (half - size * 0.08);
    ctx.fillStyle = "#1f2328";
    ctx.beginPath();
    ctx.arc(nx, ny, size * 0.055, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.round(size * 0.07)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("N", nx, ny + 1);
    // rim
    ctx.strokeStyle = "rgba(31, 35, 40, 0.75)";
    ctx.lineWidth = Math.max(2, size * 0.015);
    ctx.beginPath();
    ctx.arc(half, half, half - ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.stroke();
    state.rotation = -v.yaw;
    state.viewRadius = viewRadius;
    state.drawn++;
  };

  /** Colour of the static map at a ground position (tests check roads/buildings land where the data says). */
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const pc = probe.getContext("2d", { willReadFrequently: true })!;
  const sample = (x: number, y: number) => {
    const [cx, cy] = px([x, y]);
    // copy one pixel into a tiny canvas and read that (reading the whole big map back is slow and heavy)
    pc.clearRect(0, 0, 1, 1);
    pc.drawImage(base, Math.floor(cx), Math.floor(cy), 1, 1, 0, 0, 1, 1);
    const d = pc.getImageData(0, 0, 1, 1).data;
    return "#" + [d[0], d[1], d[2]].map((v) => v!.toString(16).padStart(2, "0")).join("");
  };
  return { draw, record, sample, trail, state, colours: { SURFACE_COLOUR, GROUND, BUILDING, RESTRICTED } };
}
