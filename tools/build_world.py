#!/usr/bin/env python3
"""Turn an OpenStreetMap extract into game world data (2D, local metres).

Core rule (see "World realism and scaling spec"): nothing is invented.
Every attribute is either a real value with its source, or null (unknown).
Unknown values are listed as survey gaps instead of being guessed.

Usage:
  python3 tools/build_world.py --osm data/raw/fci_colony_1km.osm \
      --lat 17.0143794 --lon 82.2647444 --radius 1000 \
      --name "FCI Colony, Vakalapudi" --out data/world/fci_colony.json
"""
import argparse
import json
import math
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

ROAD_CLASSES = {
    "motorway": "Highway", "trunk": "Highway", "primary": "Main road",
    "secondary": "Secondary road", "tertiary": "Connector road",
    "unclassified": "Minor road", "residential": "Colony lane",
    "living_street": "Colony lane", "service": "Service lane",
    "track": "Track", "path": "Path", "footway": "Footpath",
    "pedestrian": "Pedestrian street", "cycleway": "Cycle path",
}
# Attributes the survey must eventually provide for every road.
ROAD_SURVEY_ATTRS = ["width", "surface", "drain", "footpath"]
POI_KEYS = ["amenity", "shop", "place", "power", "barrier", "leisure",
            "tourism", "religion", "man_made", "highway", "office"]


def local_xy(lat, lon, lat0, lon0):
    """Equirectangular projection to metres east/north of the centre (fine at city scale)."""
    x = (lon - lon0) * 111320.0 * math.cos(math.radians(lat0))
    y = (lat - lat0) * 110574.0
    return round(x, 2), round(y, 2)


def clip_polygon(pts, h):
    """Sutherland-Hodgman clip of a polygon to the square [-h, h]^2."""
    def clip(poly, inside, cut):
        out = []
        for i, cur in enumerate(poly):
            prev = poly[i - 1]
            if inside(cur):
                if not inside(prev):
                    out.append(cut(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cut(prev, cur))
        return out

    def cut_x(xv):
        return lambda a, b: (xv, round(a[1] + (b[1] - a[1]) * (xv - a[0]) / (b[0] - a[0]), 2))

    def cut_y(yv):
        return lambda a, b: (round(a[0] + (b[0] - a[0]) * (yv - a[1]) / (b[1] - a[1]), 2), yv)

    poly = list(pts)
    for inside, cut in ((lambda p: p[0] >= -h, cut_x(-h)), (lambda p: p[0] <= h, cut_x(h)),
                        (lambda p: p[1] >= -h, cut_y(-h)), (lambda p: p[1] <= h, cut_y(h))):
        if not poly:
            break
        poly = clip(poly, inside, cut)
    return poly


def clip_line(pts, h):
    """Clip a polyline to the square [-h, h]^2; returns a list of parts (Liang-Barsky per segment)."""
    parts, cur = [], []
    for a, b in zip(pts, pts[1:]):
        t0, t1 = 0.0, 1.0
        dx, dy = b[0] - a[0], b[1] - a[1]
        ok = True
        for p, q in ((-dx, a[0] + h), (dx, h - a[0]), (-dy, a[1] + h), (dy, h - a[1])):
            if p == 0:
                if q < 0:
                    ok = False
                    break
                continue
            r = q / p
            if p < 0:
                t0 = max(t0, r)
            else:
                t1 = min(t1, r)
            if t0 > t1:
                ok = False
                break
        if not ok:
            if len(cur) > 1:
                parts.append(cur)
            cur = []
            continue
        s = (round(a[0] + t0 * dx, 2), round(a[1] + t0 * dy, 2))
        e = (round(a[0] + t1 * dx, 2), round(a[1] + t1 * dy, 2))
        if not cur or cur[-1] != s:
            if len(cur) > 1:
                parts.append(cur)
            cur = [s]
        cur.append(e)
        if t1 < 1.0:
            parts.append(cur)
            cur = []
    if len(cur) > 1:
        parts.append(cur)
    return parts


def attr(value, source):
    return {"value": value, "source": source} if value is not None else {"value": None, "source": None}


def parse_number(text):
    if text is None:
        return None
    try:
        return float(text.replace("m", "").strip())
    except ValueError:
        return None


def build(osm_path, lat0, lon0, radius, name):
    root = ET.parse(osm_path).getroot()
    nodes, node_tags = {}, {}
    for n in root.iter("node"):
        nid = n.get("id")
        nodes[nid] = (float(n.get("lat")), float(n.get("lon")))
        tags = {t.get("k"): t.get("v") for t in n.findall("tag")}
        if tags:
            node_tags[nid] = tags

    def inside(pts):
        return any(math.hypot(x, y) <= radius for x, y in pts)

    roads, areas, lines, pois = [], [], [], []
    for w in root.iter("way"):
        tags = {t.get("k"): t.get("v") for t in w.findall("tag")}
        if not tags:
            continue
        pts = [local_xy(*nodes[nd.get("ref")], lat0, lon0)
               for nd in w.findall("nd") if nd.get("ref") in nodes]
        if len(pts) < 2 or not inside(pts):
            continue
        src = f"osm:way/{w.get('id')}"
        closed = w.findall("nd")[0].get("ref") == w.findall("nd")[-1].get("ref")
        half = radius * 1.1  # keep a small margin beyond the circle; viewer masks the rest
        parts = clip_line(pts, half)
        if not parts:
            continue

        if "highway" in tags:
            hw = tags["highway"]
            roads.append({
                "id": f"road-{w.get('id')}", "source": src, "osm_class": hw,
                "class": ROAD_CLASSES.get(hw, hw.replace("_", " ").title()),
                "name": attr(tags.get("name"), src if tags.get("name") else None),
                "width_m": attr(parse_number(tags.get("width")), src if parse_number(tags.get("width")) else None),
                "lanes": attr(parse_number(tags.get("lanes")), src if tags.get("lanes") else None),
                "surface": attr(tags.get("surface"), src if tags.get("surface") else None),
                "oneway": attr(tags.get("oneway"), src if tags.get("oneway") else None),
                "drain": attr(None, None),      # never in OSM for these lanes: survey only
                "footpath": attr(tags.get("sidewalk"), src if tags.get("sidewalk") else None),
                "parts": parts,
            })
        elif "building" in tags or (closed and any(k in tags for k in ("landuse", "amenity", "leisure", "natural"))):
            kind = ("building" if "building" in tags else
                    "landuse:" + tags["landuse"] if "landuse" in tags else
                    "amenity:" + tags["amenity"] if "amenity" in tags else
                    "leisure:" + tags["leisure"] if "leisure" in tags else
                    "natural:" + tags["natural"])
            poly = clip_polygon(pts[:-1] if closed else pts, half)
            if len(poly) < 3:
                continue
            levels = parse_number(tags.get("building:levels"))
            areas.append({
                "id": f"area-{w.get('id')}", "source": src, "kind": kind,
                "subtype": tags.get("building") if "building" in tags else None,
                "name": attr(tags.get("name"), src if tags.get("name") else None),
                "amenity": tags.get("amenity"),
                "levels": attr(levels, src if levels else None),
                "points": poly,
            })
        elif any(k in tags for k in ("waterway", "power", "railway", "barrier")):
            kind = next(f"{k}:{tags[k]}" for k in ("waterway", "power", "railway", "barrier") if k in tags)
            lines.append({"id": f"line-{w.get('id')}", "source": src, "kind": kind,
                          "name": attr(tags.get("name"), src if tags.get("name") else None),
                          "parts": parts})

    for nid, tags in node_tags.items():
        key = next((k for k in POI_KEYS if k in tags), None)
        if not key:
            continue
        x, y = local_xy(*nodes[nid], lat0, lon0)
        if math.hypot(x, y) > radius:
            continue
        pois.append({"id": f"poi-{nid}", "source": f"osm:node/{nid}",
                     "kind": f"{key}:{tags[key]}",
                     "name": attr(tags.get("name"), f"osm:node/{nid}" if tags.get("name") else None),
                     "point": [x, y]})

    def length(pts):
        return sum(math.dist(a, b) for a, b in zip(pts, pts[1:]))

    total_len = sum(length(p) for r in roads for p in r["parts"])
    gaps = {
        "roads_total": len(roads),
        "road_length_m": round(total_len),
        "roads_without_name": sum(1 for r in roads if r["name"]["value"] is None),
        **{f"roads_without_{a}": sum(1 for r in roads if r[a if a != "width" else "width_m"]["value"] is None)
           for a in ROAD_SURVEY_ATTRS},
        "buildings_mapped": sum(1 for a in areas if a["kind"] == "building"),
        "buildings_without_levels": sum(1 for a in areas if a["kind"] == "building" and a["levels"]["value"] is None),
    }
    return {
        "meta": {
            "name": name, "center": {"lat": lat0, "lon": lon0}, "radius_m": radius,
            "units": "metres east (x) / north (y) of centre",
            "data_source": "OpenStreetMap", "license": "ODbL 1.0",
            "attribution": "© OpenStreetMap contributors",
            "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "rule": "null value = unknown, needs survey; nothing is guessed",
        },
        "gaps": gaps, "roads": roads, "areas": areas, "lines": lines, "pois": pois,
    }


def apply_owner_notes(world, notes_path):
    """Merge owner survey notes. Every merged fact carries the survey source."""
    with open(notes_path) as f:
        notes = json.load(f)
    src = notes["source"]
    by_id = {x["id"]: x for k in ("roads", "areas", "lines", "pois") for x in world[k]}
    unknown = []
    for rid, text in notes.get("roads", {}).items():
        if rid in by_id:
            by_id[rid].setdefault("notes", []).append({"value": text, "source": src})
        else:
            unknown.append(rid)
    for pid, alias in notes.get("place_aliases", {}).items():
        if pid in by_id:
            by_id[pid]["alias"] = {"value": alias, "source": src}
        else:
            unknown.append(pid)
    for aid, text in notes.get("restricted_areas", {}).items():
        if aid in by_id:
            by_id[aid]["restricted"] = {"value": text, "source": src}
        else:
            unknown.append(aid)
    if unknown:
        raise SystemExit(f"owner notes refer to features not in this map: {unknown}")
    world["meta"].setdefault("surveys", []).append({"source": src, "note": notes.get("note", "")})
    world["colony_boundary"] = notes.get("colony_boundary")


def point_in_poly(x, y, pts):
    inside = False
    for i in range(len(pts)):
        (xi, yi), (xj, yj) = pts[i], pts[i - 1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
    return inside


def add_google_buildings(world, csv_path, lat0, lon0, radius):
    """Add building outlines from Google Open Buildings v3 (CC BY 4.0 / ODbL).
    Outlines and confidence come from the dataset; floors and height stay unknown.
    Buildings inside restricted areas are dropped: sensitive sites are never modelled."""
    import csv
    import re
    src = "open-buildings:google-v3"
    restricted = [a["points"] for a in world["areas"] if "restricted" in a]
    added = dropped_restricted = 0
    with open(csv_path) as f:
        for i, r in enumerate(csv.DictReader(f)):
            cx, cy = local_xy(float(r["latitude"]), float(r["longitude"]), lat0, lon0)
            if math.hypot(cx, cy) > radius:
                continue
            if any(point_in_poly(cx, cy, poly) for poly in restricted):
                dropped_restricted += 1
                continue
            ring = re.search(r"\(\(([^()]*)\)", r["geometry"]).group(1)
            pts = [local_xy(float(b), float(a), lat0, lon0) for a, b in (p.split() for p in ring.split(","))]
            if pts[0] == pts[-1]:
                pts = pts[:-1]
            world["areas"].append({
                "id": f"bldg-g-{r['full_plus_code'] or i}", "source": f"{src}:{r['full_plus_code']}",
                "kind": "building", "subtype": None,
                "name": attr(None, None), "amenity": None,
                "levels": attr(None, None),
                "confidence": {"value": round(float(r["confidence"]), 3), "source": src},
                "area_m2": {"value": round(float(r["area_in_meters"]), 1), "source": src},
                "points": pts,
            })
            added += 1
    world["meta"].setdefault("building_sources", []).append({
        "source": src, "name": "Google Open Buildings v3", "license": "CC BY 4.0 or ODbL",
        "attribution": "Buildings: Google Open Buildings", "added": added,
        "dropped_in_restricted_areas": dropped_restricted})
    g = world["gaps"]
    g["buildings_mapped"] = sum(1 for a in world["areas"] if a["kind"] == "building")
    g["buildings_without_levels"] = sum(1 for a in world["areas"] if a["kind"] == "building" and a["levels"]["value"] is None)
    g["buildings_low_confidence"] = sum(1 for a in world["areas"] if a.get("confidence", {}).get("value", 1) < 0.75)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--google-buildings", help="Google Open Buildings CSV already filtered to the area")
    ap.add_argument("--notes", action="append", default=[], help="owner survey notes JSON (repeatable)")
    ap.add_argument("--osm", required=True)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--radius", type=float, default=1000)
    ap.add_argument("--name", default="Area")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    world = build(a.osm, a.lat, a.lon, a.radius, a.name)
    for n in a.notes:
        apply_owner_notes(world, n)
    if a.google_buildings:
        add_google_buildings(world, a.google_buildings, a.lat, a.lon, a.radius)
    with open(a.out, "w") as f:
        json.dump(world, f, ensure_ascii=False, separators=(",", ":"))
    print(json.dumps(world["gaps"], indent=1))
    print(json.dumps(world["meta"].get("building_sources", []), indent=1))
    print(f"roads {len(world['roads'])}, areas {len(world['areas'])}, lines {len(world['lines'])}, pois {len(world['pois'])}")


if __name__ == "__main__":
    main()
