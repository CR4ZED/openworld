/**
 * Surface textures drawn in code (no downloaded images): concrete slabs, red mud (moram), tar, and dusty ground.
 * Look follows docs/reference/colony_roads_andhra.md and the owner's description. Deterministic: each texture
 * uses a fixed seed, so it looks the same on every load and in tests.
 *
 * Road textures are laid along the road: u = metres along the road / TILE_M, v = 0..1 across its width.
 */
import * as THREE from "three";

/** Metres of road covered by one copy of each road texture (along the road). */
export const TILE_M: Record<string, number> = {
  concrete: 3.0, // one CC slab between transverse joints (visual only; real joint spacing varies)
  tar: 6.0,
  redmud: 5.0,
  paving: 2.0,
  gravel: 5.0,
  mud: 5.0,
};
/** Metres of open ground per texture copy. */
export const GROUND_TILE_M = 10;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Painter = (ctx: CanvasRenderingContext2D, size: number, rand: () => number) => void;

function make(size: number, seed: number, paint: Painter): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  paint(ctx, size, rng(seed));
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Fine grain: many small dots of slightly lighter/darker colour. */
function grain(
  ctx: CanvasRenderingContext2D,
  size: number,
  rand: () => number,
  n: number,
  light: string,
  dark: string,
) {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = rand() < 0.5 ? light : dark;
    const r = 0.5 + rand() * 1.5;
    ctx.fillRect(rand() * size, rand() * size, r, r);
  }
}

/** Soft blotches (stains, damp patches, worn areas). */
function blotches(
  ctx: CanvasRenderingContext2D,
  size: number,
  rand: () => number,
  n: number,
  rgb: string,
  alpha: number,
) {
  for (let i = 0; i < n; i++) {
    const x = rand() * size,
      y = rand() * size,
      r = size * (0.04 + rand() * 0.12);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${alpha * (0.5 + rand() * 0.5)})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

// u (texture x) runs along the road, v (texture y) across it: y = 0 and y = size are the road edges.

export const concreteTexture = () =>
  make(512, 11, (ctx, s, rand) => {
    ctx.fillStyle = "#a8a7a2";
    ctx.fillRect(0, 0, s, s);
    grain(ctx, s, rand, 9000, "rgba(255,255,255,0.18)", "rgba(40,40,40,0.16)");
    blotches(ctx, s, rand, 10, "70,66,60", 0.18); // oil/water stains
    blotches(ctx, s, rand, 6, "255,255,255", 0.08); // bleached patches
    // transverse joint between slabs (at the start of each tile)
    ctx.fillStyle = "rgba(45,45,45,0.75)";
    ctx.fillRect(0, 0, 3, s);
    // hairline cracks
    ctx.strokeStyle = "rgba(55,55,55,0.45)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      let x = rand() * s,
        y = rand() * s;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let k = 0; k < 8; k++) {
        x += (rand() - 0.5) * 40;
        y += (rand() - 0.3) * 30;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // chipped, dirtier edges where the slab meets the shoulder
    for (const edge of [0, s]) {
      const g = ctx.createLinearGradient(0, edge, 0, edge === 0 ? s * 0.08 : s * 0.92);
      g.addColorStop(0, "rgba(120,95,70,0.55)");
      g.addColorStop(1, "rgba(120,95,70,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, edge === 0 ? 0 : s * 0.92, s, s * 0.08);
    }
  });

export const tarTexture = () =>
  make(512, 23, (ctx, s, rand) => {
    ctx.fillStyle = "#3f4043";
    ctx.fillRect(0, 0, s, s);
    grain(ctx, s, rand, 14000, "rgba(170,170,165,0.22)", "rgba(10,10,10,0.25)");
    blotches(ctx, s, rand, 8, "90,88,84", 0.25); // faded, worn tar
    // No repair patches here: anything distinct in a repeating texture shows up as an obvious row.
    // Patches and potholes will be placed individually (from the survey's pothole data).
    // dusty, broken edges
    for (const edge of [0, s]) {
      const g = ctx.createLinearGradient(0, edge, 0, edge === 0 ? s * 0.1 : s * 0.9);
      g.addColorStop(0, "rgba(150,120,90,0.6)");
      g.addColorStop(1, "rgba(150,120,90,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, edge === 0 ? 0 : s * 0.9, s, s * 0.1);
    }
  });

export const redMudTexture = () =>
  make(512, 37, (ctx, s, rand) => {
    // dull reddish-brown laterite (moram), dusty rather than bright orange
    ctx.fillStyle = "#8a5a43";
    ctx.fillRect(0, 0, s, s);
    blotches(ctx, s, rand, 18, "150,105,80", 0.3); // dusty, lighter
    blotches(ctx, s, rand, 12, "100,62,45", 0.28); // damp, darker
    grain(ctx, s, rand, 9000, "rgba(200,160,130,0.3)", "rgba(55,32,22,0.28)");
    // small loose gravel stones
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = rand() < 0.5 ? "rgba(175,140,115,0.75)" : "rgba(85,55,42,0.75)";
      ctx.beginPath();
      ctx.arc(rand() * s, rand() * s, 0.6 + rand() * 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
    // two wheel ruts along the road
    for (const v of [0.32, 0.68]) {
      const g = ctx.createLinearGradient(0, s * (v - 0.06), 0, s * (v + 0.06));
      g.addColorStop(0, "rgba(70,35,20,0)");
      g.addColorStop(0.5, "rgba(70,35,20,0.35)");
      g.addColorStop(1, "rgba(70,35,20,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, s * (v - 0.06), s, s * 0.12);
    }
  });

export const groundTexture = () =>
  make(512, 51, (ctx, s, rand) => {
    ctx.fillStyle = "#b7a98b";
    ctx.fillRect(0, 0, s, s);
    blotches(ctx, s, rand, 20, "150,130,100", 0.35); // darker earth
    blotches(ctx, s, rand, 14, "120,135,80", 0.35); // dry grass
    blotches(ctx, s, rand, 6, "95,120,60", 0.3); // greener patches
    grain(ctx, s, rand, 12000, "rgba(230,215,185,0.3)", "rgba(80,65,45,0.25)");
    // tufts of grass
    ctx.strokeStyle = "rgba(90,110,55,0.55)";
    for (let i = 0; i < 400; i++) {
      const x = rand() * s,
        y = rand() * s;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rand() - 0.5) * 4, y - 2 - rand() * 4);
      ctx.stroke();
    }
  });

/** Texture for a road material key (see resolve.surfaceMaterial), or null for plain colour. */
export function roadTexture(key: string): THREE.CanvasTexture | null {
  switch (key) {
    case "concrete":
    case "paving":
      return concreteTexture();
    case "tar":
      return tarTexture();
    case "redmud":
    case "gravel":
    case "mud":
      return redMudTexture();
    default:
      return null;
  }
}
