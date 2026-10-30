/** Shape of data/world/*.json (built by tools/build_world.py). Only the fields the game uses. */

export type Pt = [number, number];

export interface Attr<T> {
  value: T | null;
  source: string | null;
}

export interface Estimate<T> {
  value: T;
  source: string;
  basis: string;
  confidence: "low" | "medium";
}

export interface Road {
  id: string;
  source: string;
  osm_class: string;
  class: string;
  name: Attr<string>;
  width_m: Attr<number>;
  surface: Attr<string>;
  drain: Attr<string>;
  footpath: Attr<string>;
  parts: Pt[][];
  surroundings?: { in_restricted: boolean; gap_median_m: number | null };
  estimate?: Partial<Record<"width_m" | "surface" | "drain" | "footpath", Estimate<string | number>>>;
}

export interface Area {
  id: string;
  kind: string;
  points: Pt[];
  levels: Attr<number>;
  restricted?: Attr<string>;
  estimate?: { levels?: Estimate<number> };
}

export interface World {
  meta: { name: string; radius_m: number; center: { lat: number; lon: number } };
  roads: Road[];
  areas: Area[];
}

/** A value with where it came from: "survey"/"osm"/... or "estimate". */
export interface Resolved<T> {
  value: T;
  estimated: boolean;
}
