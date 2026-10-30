/**
 * Build the 3D scene from world data. Coordinates: data x = east, y = north (metres, 1:1).
 * Three.js: x = east, y = up, z = -north.
 *
 * Draw calls are kept low by merging all geometry of one material into one mesh.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  buildingFloors,
  FLOOR_HEIGHT_M,
  roadDrain,
  roadSurface,
  roadWidth,
  surfaceMaterial,
} from "./resolve";
import { GROUND_TILE_M, groundTexture, roadTexture, TILE_M } from "./textures";
import type { Pt, Road, World } from "./types";

/** Multiplied with a shared texture to tell similar surfaces apart (e.g. plain mud vs red mud). */
const TEXTURE_TINT: Record<string, string> = { paving: "#d6d2cc", gravel: "#d8d0c6", mud: "#b8a48d" };

export const SURFACE_COLORS: Record<string, string> = {
  concrete: "#a3a39f",
  tar: "#3b3c3f",
  redmud: "#a35a3a",
  paving: "#8e8a85",
  gravel: "#9c907c",
  mud: "#7d6448",
};
const ESTIMATE_TINT = "#e0a030";

// layer heights (m) to avoid flicker where flat surfaces overlap; bigger roads sit on top at junctions
const Y = { ground: 0, restrictedGround: 0.01, drain: 0.015, shoulder: 0.02, road: 0.03 };
const CLASS_LIFT: Record<string, number> = {
  primary: 0.006,
  secondary: 0.005,
  tertiary: 0.004,
  unclassified: 0.003,
};

export interface BuiltWorld {
  group: THREE.Group;
  /** Materials of roads whose surface or width is estimated, to tint them when "Show estimates" is on. */
  estimateMaterials: THREE.MeshLambertMaterial[];
  stats: { roads: number; buildings: number; restrictedWalls: number };
}

/** Flat ribbon along a polyline, `width` metres wide, at height y; offset shifts it sideways (+ = right). */
export function ribbon(points: Pt[], width: number, y: number, offset = 0): THREE.BufferGeometry | null {
  if (points.length < 2) return null;
  const n = points.length;
  const left: THREE.Vector3[] = [];
  const right: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const a = points[Math.max(0, i - 1)]!;
    const b = points[Math.min(n - 1, i + 1)]!;
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // normal pointing to the right of travel direction (in data coordinates)
    const nx = dy;
    const ny = -dx;
    const cx = p[0] + nx * offset;
    const cy = p[1] + ny * offset;
    left.push(new THREE.Vector3(cx - (nx * width) / 2, y, -(cy - (ny * width) / 2)));
    right.push(new THREE.Vector3(cx + (nx * width) / 2, y, -(cy + (ny * width) / 2)));
  }
  // u = metres along the road (textures repeat every TILE_M metres), v = 0 at the left edge, 1 at the right
  const along: number[] = [0];
  for (let i = 1; i < n; i++)
    along.push(
      along[i - 1]! + Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]),
    );
  const pos: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const l0 = left[i]!,
      l1 = left[i + 1]!,
      r0 = right[i]!,
      r1 = right[i + 1]!;
    const u0 = along[i]!,
      u1 = along[i + 1]!;
    pos.push(l0.x, l0.y, l0.z, r0.x, r0.y, r0.z, l1.x, l1.y, l1.z);
    uv.push(u0, 0, u0, 1, u1, 0);
    pos.push(r0.x, r0.y, r0.z, r1.x, r1.y, r1.z, l1.x, l1.y, l1.z);
    uv.push(u0, 1, u1, 1, u1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function mergeInto(
  group: THREE.Group,
  geos: THREE.BufferGeometry[],
  material: THREE.Material,
  name: string,
  shadows: { cast?: boolean; receive?: boolean } = { receive: true },
): THREE.Mesh | null {
  if (!geos.length) return null;
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, material);
  mesh.name = name;
  mesh.castShadow = !!shadows.cast;
  mesh.receiveShadow = !!shadows.receive;
  group.add(mesh);
  return mesh;
}

const ROOF_COLOR = new THREE.Color("#bdbab3");
const WALL_BASE_SHADE = 0.8;
/** Pastel wall colours common on colony houses; picked per building from its id so it never changes. */
const WALL_COLORS = ["#efe6d2", "#e8d9c0", "#f1e3c6", "#e3e7d6", "#e9dcd5", "#dfe5e8", "#f0dcc0", "#e6e0cf"];
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function buildWorld(w: World): BuiltWorld {
  const group = new THREE.Group();
  const R = w.meta.radius_m;
  // flat surfaces are drawn from both sides so they never vanish because of polygon winding
  const lambert = (color: string) => new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });

  // ground: dusty earth disc a little bigger than the mapped area
  const groundTex = groundTexture();
  groundTex.repeat.set((R * 2.3) / GROUND_TILE_M, (R * 2.3) / GROUND_TILE_M);
  const groundMat = lambert("#ffffff");
  groundMat.map = groundTex;
  const ground = new THREE.Mesh(new THREE.CircleGeometry(R * 1.15, 96), groundMat);
  ground.receiveShadow = true;
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = Y.ground;
  ground.name = "ground";
  group.add(ground);

  // roads, grouped by (material, estimated?) so estimates can be tinted on demand
  const buckets = new Map<string, THREE.BufferGeometry[]>();
  const add = (key: string, g: THREE.BufferGeometry | null) => {
    if (!g) return;
    const list = buckets.get(key) ?? [];
    list.push(g);
    buckets.set(key, list);
  };
  let roadCount = 0;
  for (const r of w.roads) {
    if (r.surroundings?.in_restricted) continue; // restricted areas are never modelled
    roadCount++;
    const width = roadWidth(r);
    const surface = roadSurface(r);
    const drain = roadDrain(r);
    const mat = surfaceMaterial(surface.value);
    const est = width.estimated || surface.estimated ? "est" : "known";
    const lift = CLASS_LIFT[r.osm_class] ?? 0;
    for (const part of r.parts) {
      if (mat.shoulder) {
        add(`${mat.shoulder}|${est}`, ribbon(part, width.value, Y.shoulder + lift));
        add(`${mat.main}|${est}`, ribbon(part, width.value * 0.65, Y.road + lift));
      } else {
        add(`${mat.main}|${est}`, ribbon(part, width.value, Y.road + lift));
      }
      addDrains(add, part, width.value, drain.value, lift);
    }
  }
  const estimateMaterials: THREE.MeshLambertMaterial[] = [];
  for (const [key, geos] of buckets) {
    const [matKey, est] = key.split("|") as [string, string];
    const tex = roadTexture(matKey);
    // textured surfaces use white (or a light tint) so the texture shows its own colours
    const color = matKey.startsWith("drain")
      ? matKey === "drain-open"
        ? "#3d3a33"
        : "#b9b4aa"
      : tex
        ? (TEXTURE_TINT[matKey] ?? "#ffffff")
        : SURFACE_COLORS[matKey];
    const m = lambert(color ?? "#888888");
    if (tex) {
      tex.repeat.set(1 / (TILE_M[matKey] ?? 4), 1);
      m.map = tex;
    }
    m.userData.baseColor = new THREE.Color(color ?? "#888888");
    if (est === "est") estimateMaterials.push(m);
    mergeInto(group, geos, m, `roads:${key}`);
  }

  // buildings: plain blocks on their real footprints, height from known or estimated floors
  const bGeos: THREE.BufferGeometry[] = [];
  let buildingCount = 0;
  for (const a of w.areas) {
    if (a.kind !== "building") continue;
    const floors = buildingFloors(a).value;
    const shape = new THREE.Shape(a.points.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: floors * FLOOR_HEIGHT_M + 0.3, bevelEnabled: false });
    g.rotateX(-Math.PI / 2); // extrude upwards; shape y (north) becomes -z
    const flat = g.index ? g.toNonIndexed() : g;
    flat.computeVertexNormals();
    const wall = new THREE.Color(WALL_COLORS[hashString(a.id) % WALL_COLORS.length]);
    const normals = flat.getAttribute("normal");
    const n = flat.getAttribute("position").count;
    const colors = new Float32Array(n * 3);
    // flat RCC roofs are bare grey concrete; walls are painted
    const pos = flat.getAttribute("position");
    for (let i = 0; i < n; i++) {
      if (normals.getY(i) > 0.5) ROOF_COLOR.toArray(colors, i * 3);
      // walls get darker towards the ground (splashed dust and damp), like real compound and house walls
      else if (pos.getY(i) < 0.01)
        wall
          .clone()
          .multiplyScalar(WALL_BASE_SHADE)
          .toArray(colors, i * 3);
      else wall.toArray(colors, i * 3);
    }
    flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    bGeos.push(flat);
    buildingCount++;
  }
  mergeInto(group, bGeos, new THREE.MeshLambertMaterial({ vertexColors: true }), "buildings", {
    cast: true,
    receive: true,
  });

  // restricted areas: flat ground and a plain boundary wall, nothing inside
  let walls = 0;
  const wallGeos: THREE.BufferGeometry[] = [];
  const zoneGeos: THREE.BufferGeometry[] = [];
  for (const a of w.areas) {
    if (!a.restricted) continue;
    const shape = new THREE.Shape(a.points.map(([x, y]) => new THREE.Vector2(x, y)));
    const flat = new THREE.ShapeGeometry(shape);
    flat.rotateX(-Math.PI / 2);
    flat.translate(0, Y.restrictedGround, 0);
    zoneGeos.push(flat.index ? flat.toNonIndexed() : flat);
    const pts = a.points;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!,
        q = pts[(i + 1) % pts.length]!;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 0.5 || Math.hypot((p[0] + q[0]) / 2, (p[1] + q[1]) / 2) > R * 1.1) continue;
      const wall = new THREE.BoxGeometry(len, 2.5, 0.25);
      wall.rotateY(Math.atan2(q[1] - p[1], q[0] - p[0]));
      wall.translate((p[0] + q[0]) / 2, 1.25, -(p[1] + q[1]) / 2);
      wallGeos.push(wall.index ? wall.toNonIndexed() : wall);
      walls++;
    }
  }
  mergeInto(group, zoneGeos, lambert("#c9b9a6"), "restricted-ground");
  mergeInto(group, wallGeos, lambert("#b8b2a6"), "restricted-walls", { cast: true, receive: true });

  return {
    group,
    estimateMaterials,
    stats: { roads: roadCount, buildings: buildingCount, restrictedWalls: walls },
  };
}

function addDrains(
  add: (key: string, g: THREE.BufferGeometry | null) => void,
  part: Pt[],
  width: number,
  drain: string,
  lift: number,
) {
  if (drain === "none" || drain === "mixed") return;
  const kind = drain.startsWith("covered") ? "drain-covered" : "drain-open";
  const both = drain.includes("both");
  const dw = 0.6;
  add(`${kind}|known`, ribbon(part, dw, Y.drain + lift, width / 2 + dw / 2));
  if (both) add(`${kind}|known`, ribbon(part, dw, Y.drain + lift, -(width / 2 + dw / 2)));
}

export function setEstimateTint(materials: THREE.MeshLambertMaterial[], on: boolean) {
  const tint = new THREE.Color(ESTIMATE_TINT);
  for (const m of materials) {
    const base = m.userData.baseColor as THREE.Color;
    m.color.copy(on ? base.clone().lerp(tint, 0.6) : base);
  }
}

/** Road the player is standing on (closest centreline within its half width + 1 m), or null. */
export function makeRoadLocator(w: World) {
  const cell = 25;
  const grid = new Map<string, { r: Road; a: Pt; b: Pt }[]>();
  for (const r of w.roads) {
    if (r.surroundings?.in_restricted) continue;
    for (const part of r.parts)
      for (let i = 0; i < part.length - 1; i++) {
        const a = part[i]!,
          b = part[i + 1]!;
        const x0 = Math.floor(Math.min(a[0], b[0]) / cell),
          x1 = Math.floor(Math.max(a[0], b[0]) / cell);
        const y0 = Math.floor(Math.min(a[1], b[1]) / cell),
          y1 = Math.floor(Math.max(a[1], b[1]) / cell);
        for (let gx = x0; gx <= x1; gx++)
          for (let gy = y0; gy <= y1; gy++) {
            const k = `${gx},${gy}`;
            const list = grid.get(k) ?? [];
            list.push({ r, a, b });
            grid.set(k, list);
          }
      }
  }
  return (x: number, y: number): Road | null => {
    let best: Road | null = null;
    let bestD = Infinity;
    const gx = Math.floor(x / cell),
      gy = Math.floor(y / cell);
    for (let i = gx - 1; i <= gx + 1; i++)
      for (let j = gy - 1; j <= gy + 1; j++)
        for (const { r, a, b } of grid.get(`${i},${j}`) ?? []) {
          const dx = b[0] - a[0],
            dy = b[1] - a[1];
          const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
          const d = Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
          if (d <= roadWidth(r).value / 2 + 1 && d < bestD) {
            bestD = d;
            best = r;
          }
        }
    return best;
  };
}
