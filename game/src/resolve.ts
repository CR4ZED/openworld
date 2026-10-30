/**
 * Decide what the 3D world shows for each road/building attribute: the known value if there is one,
 * otherwise the labelled estimate. Pure functions, unit-tested via the browser test hook.
 */
import type { Area, Resolved, Road } from "./types";

/** Used only if a road has neither a known nor an estimated width (should not happen outside restricted areas). */
const LAST_RESORT_WIDTH: Record<string, number> = { primary: 10, secondary: 8, tertiary: 6, residential: 4 };

export function roadWidth(r: Road): Resolved<number> {
  if (r.width_m.value !== null) return { value: r.width_m.value, estimated: false };
  const e = r.estimate?.width_m;
  if (e) return { value: Number(e.value), estimated: true };
  return { value: LAST_RESORT_WIDTH[r.osm_class] ?? 3, estimated: true };
}

export function roadSurface(r: Road): Resolved<string> {
  if (r.surface.value !== null) return { value: r.surface.value, estimated: false };
  const e = r.estimate?.surface;
  return { value: e ? String(e.value) : "mud", estimated: true };
}

export function roadDrain(r: Road): Resolved<string> {
  if (r.drain.value !== null) return { value: r.drain.value, estimated: false };
  const e = r.estimate?.drain;
  return { value: e ? String(e.value) : "none", estimated: true };
}

export const FLOOR_HEIGHT_M = 3.0;

export function buildingFloors(a: Area): Resolved<number> {
  if (a.levels.value !== null) return { value: a.levels.value, estimated: false };
  const e = a.estimate?.levels;
  return { value: e ? e.value : 1, estimated: true };
}

/** Surface name -> material key. Mixed surfaces are drawn as their main material with shoulders (see world.ts). */
export function surfaceMaterial(surface: string): { main: string; shoulder: string | null } {
  if (surface.startsWith("tar")) return { main: "tar", shoulder: null };
  if (surface === "concrete + tar") return { main: "tar", shoulder: "concrete" };
  if (surface === "concrete + red mud") return { main: "concrete", shoulder: "redmud" };
  if (surface === "concrete + tar + red mud") return { main: "concrete", shoulder: "redmud" };
  if (surface.startsWith("concrete")) return { main: "concrete", shoulder: null };
  if (surface.startsWith("red mud")) return { main: "redmud", shoulder: null };
  if (surface === "paving blocks") return { main: "paving", shoulder: null };
  if (surface === "gravel") return { main: "gravel", shoulder: null };
  if (surface === "mixed or broken") return { main: "concrete", shoulder: "redmud" };
  return { main: "mud", shoulder: null };
}
