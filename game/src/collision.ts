/**
 * 2D collision against building footprints and restricted areas (the world is flat for now).
 * The player is a circle of radius PLAYER_RADIUS; moving into a wall slides along it.
 */
import type { Pt, World } from "./types";

export const PLAYER_RADIUS = 0.3;

interface Edge {
  a: Pt;
  b: Pt;
}

export function makeCollider(w: World) {
  const cell = 20;
  const edges = new Map<string, Edge[]>();
  const polys: { pts: Pt[]; minX: number; maxX: number; minY: number; maxY: number }[] = [];
  for (const a of w.areas) {
    if (a.kind !== "building" && !a.restricted) continue;
    const pts = a.points;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    polys.push({ pts, minX, maxX, minY, maxY });
    for (let i = 0; i < pts.length; i++) {
      const e = { a: pts[i]!, b: pts[(i + 1) % pts.length]! };
      const x0 = Math.floor(Math.min(e.a[0], e.b[0]) / cell),
        x1 = Math.floor(Math.max(e.a[0], e.b[0]) / cell);
      const y0 = Math.floor(Math.min(e.a[1], e.b[1]) / cell),
        y1 = Math.floor(Math.max(e.a[1], e.b[1]) / cell);
      for (let gx = x0; gx <= x1; gx++)
        for (let gy = y0; gy <= y1; gy++) {
          const k = `${gx},${gy}`;
          const list = edges.get(k) ?? [];
          list.push(e);
          edges.set(k, list);
        }
    }
  }

  const inside = (x: number, y: number) =>
    polys.some((p) => {
      if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) return false;
      let c = false;
      const pts = p.pts;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i]!,
          [xj, yj] = pts[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    });

  const nearEdge = (x: number, y: number, r: number) => {
    const gx = Math.floor(x / cell),
      gy = Math.floor(y / cell);
    for (let i = gx - 1; i <= gx + 1; i++)
      for (let j = gy - 1; j <= gy + 1; j++)
        for (const { a, b } of edges.get(`${i},${j}`) ?? []) {
          const dx = b[0] - a[0],
            dy = b[1] - a[1];
          const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
          if (Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)) < r) return true;
        }
    return false;
  };

  /** Closest wall edge to (x, y) within `r` metres, or null. */
  const nearestEdge = (x: number, y: number, r: number): Edge | null => {
    let best: Edge | null = null;
    let bestD = r;
    const gx = Math.floor(x / cell),
      gy = Math.floor(y / cell);
    for (let i = gx - 1; i <= gx + 1; i++)
      for (let j = gy - 1; j <= gy + 1; j++)
        for (const e of edges.get(`${i},${j}`) ?? []) {
          const dx = e.b[0] - e.a[0],
            dy = e.b[1] - e.a[1];
          const t = Math.max(
            0,
            Math.min(1, ((x - e.a[0]) * dx + (y - e.a[1]) * dy) / (dx * dx + dy * dy || 1)),
          );
          const d = Math.hypot(x - (e.a[0] + t * dx), y - (e.a[1] + t * dy));
          if (d < bestD) {
            bestD = d;
            best = e;
          }
        }
    return best;
  };

  const blocked = (x: number, y: number) =>
    Math.hypot(x, y) > w.meta.radius_m || inside(x, y) || nearEdge(x, y, PLAYER_RADIUS);

  /** Move from (x, y) by (dx, dy); slides along walls. Returns the new position. */
  const move = (x: number, y: number, dx: number, dy: number): Pt => {
    // small sub-steps so fast movement can't tunnel through thin walls
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.2));
    let px = x,
      py = y;
    for (let s = 0; s < steps; s++) {
      const sx = dx / steps,
        sy = dy / steps;
      if (!blocked(px + sx, py + sy)) {
        px += sx;
        py += sy;
        continue;
      }
      // slide along the wall we hit: keep only the part of the step parallel to that wall
      const e = nearestEdge(px + sx, py + sy, PLAYER_RADIUS + 0.5);
      if (!e) break;
      const ex = e.b[0] - e.a[0],
        ey = e.b[1] - e.a[1];
      const len = Math.hypot(ex, ey) || 1;
      const along = (sx * ex + sy * ey) / len;
      const tx = (ex / len) * along,
        ty = (ey / len) * along;
      if (Math.hypot(tx, ty) > 1e-4 && !blocked(px + tx, py + ty)) {
        px += tx;
        py += ty;
      } else break;
    }
    return [px, py];
  };

  /** A building wall near (x, y) at least `minLen` m long, for tests. */
  const wallNear = (x: number, y: number, minLen: number, maxDist: number): Edge | null => {
    let best: Edge | null = null;
    let bestD = maxDist;
    for (const list of edges.values())
      for (const e of list) {
        const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
        const d = Math.hypot((e.a[0] + e.b[0]) / 2 - x, (e.a[1] + e.b[1]) / 2 - y);
        if (len >= minLen && d < bestD) {
          bestD = d;
          best = e;
        }
      }
    return best;
  };

  return { blocked, move, inside, wallNear };
}
