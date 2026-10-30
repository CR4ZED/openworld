"""Estimates for roads the owner has not surveyed yet, from their surroundings.

Owner-approved 2026-10-30 ("apply the research to all the roads, based on the surroundings").

Rules that keep this honest (see CLAUDE.md):
- Estimates never touch a road's core attributes (width_m, surface, drain, footpath) or its `survey` fields.
  They live only in road["estimate"][field] = {value, source: "estimate:v1", basis, confidence}.
- A surveyed value always wins: no estimate is made for a field that is already known.
- Every estimate says why (basis) and how sure it is (confidence: "medium" when backed by the owner's own
  survey or statements, "low" when it rests on general research or road type alone).
- Roads inside restricted areas get no estimates (they are never modelled).

Inputs used, all from data already in the world: OpenStreetMap road type, building outlines along the road
(gap between buildings on both sides, how built-up it is), the owner's surveyed streets of the same kind,
the owner's area notes, and the background research in docs/reference/.
"""

import math
import statistics
from collections import Counter
from itertools import pairwise

SOURCE = "estimate:v1"
CORE = ("width_m", "surface", "drain", "footpath")

GROUPS = {
    "motorway": "highway",
    "trunk": "highway",
    "primary": "highway",
    "secondary": "connector",
    "tertiary": "connector",
    "unclassified": "connector",
    "residential": "lane",
    "living_street": "lane",
    "service": "service",
    "track": "track",
    "path": "track",
    "footway": "track",
    "pedestrian": "track",
    "cycleway": "track",
}
# Plausible width ranges per kind of road (m). Lower bound for lanes follows the AP government's 3.0 m CC road
# guideline (docs/reference/colony_roads_andhra.md); upper bounds stay within what the owner surveyed.
WIDTH_RANGE = {
    "highway": (10.0, 30.0),
    "connector": (6.0, 25.0),
    "lane": (3.0, 12.0),
    "service": (2.5, 8.0),
    "track": (2.0, 5.0),
}
WIDTH_FALLBACK = {"highway": 20.0, "connector": 10.0, "lane": 6.0, "service": 4.0, "track": 3.0}
BUILT_UP_PER_100M = 4.0  # buildings within 25 m of the road per 100 m of road: above this counts as built-up


def group_of(road):
    return GROUPS.get(road["osm_class"], "track")


# ---------------------------------------------------------------- surroundings


def _building_grid(world, cell):
    grid = {}
    centroids = []
    for a in world["areas"]:
        if a["kind"] != "building":
            continue
        pts = a["points"]
        centroids.append((sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)))
        for i in range(len(pts)):
            e = (pts[i - 1], pts[i])
            for gx in range(int(min(e[0][0], e[1][0]) // cell), int(max(e[0][0], e[1][0]) // cell) + 1):
                for gy in range(int(min(e[0][1], e[1][1]) // cell), int(max(e[0][1], e[1][1]) // cell) + 1):
                    grid.setdefault((gx, gy), []).append(e)
    cgrid = {}
    for c in centroids:
        cgrid.setdefault((int(c[0] // cell), int(c[1] // cell)), []).append(c)
    return grid, cgrid


def _point_in_poly(x, y, pts):
    inside = False
    for i in range(len(pts)):
        (xi, yi), (xj, yj) = pts[i], pts[i - 1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
    return inside


def measure_surroundings(world, max_side_m=40.0, step_m=5.0, cell=20.0, near_m=25.0):
    """Set road['surroundings'] for every road:
    gap_median_m / gap_p10_m: distance between the nearest buildings on the left and right (where both exist),
    buildings_per_100m: buildings with their centre within near_m of the road, per 100 m of road,
    in_restricted: the road's midpoint lies inside a restricted area."""
    grid, cgrid = _building_grid(world, cell)
    reach = int(max_side_m // cell) + 1
    zones = [a["points"] for a in world["areas"] if "restricted" in a]

    def nearest(p, ux, uy):
        left = right = None
        gx, gy = int(p[0] // cell), int(p[1] // cell)
        for i in range(gx - reach, gx + reach + 1):
            for j in range(gy - reach, gy + reach + 1):
                for a, b in grid.get((i, j), ()):
                    dx, dy = b[0] - a[0], b[1] - a[1]
                    t = max(
                        0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / ((dx * dx + dy * dy) or 1))
                    )
                    q = (a[0] + t * dx, a[1] + t * dy)
                    d = math.dist(p, q)
                    if d > max_side_m:
                        continue
                    if ux * (q[1] - p[1]) - uy * (q[0] - p[0]) > 0:
                        left = d if left is None else min(left, d)
                    else:
                        right = d if right is None else min(right, d)
        return left, right

    for r in world["roads"]:
        gaps, length, near = [], 0.0, set()
        samples = []
        for part in r["parts"]:
            for a, b in pairwise(part):
                seg = math.dist(a, b)
                if seg == 0:
                    continue
                length += seg
                ux, uy = (b[0] - a[0]) / seg, (b[1] - a[1]) / seg
                n = max(1, int(seg // step_m))
                for k in range(n):
                    p = (a[0] + ux * seg * k / n, a[1] + uy * seg * k / n)
                    samples.append(p)
                    left, right = nearest(p, ux, uy)
                    if left is not None and right is not None:
                        gaps.append(left + right)
                    gx, gy = int(p[0] // cell), int(p[1] // cell)
                    for i in range(gx - 2, gx + 3):
                        for j in range(gy - 2, gy + 3):
                            for c in cgrid.get((i, j), ()):
                                if math.dist(p, c) <= near_m:
                                    near.add(c)
        gaps.sort()
        mid = samples[len(samples) // 2] if samples else (0.0, 0.0)
        r["surroundings"] = {
            "gap_median_m": round(gaps[len(gaps) // 2], 1) if gaps else None,
            "gap_p10_m": round(gaps[len(gaps) // 10], 1) if gaps else None,
            "gap_samples": len(gaps),
            "length_m": round(length, 1),
            "buildings_per_100m": round(100.0 * len(near) / length, 1) if length else 0.0,
            "in_restricted": any(_point_in_poly(mid[0], mid[1], z) for z in zones),
            "source": "open-buildings:google-v3",
        }


# ---------------------------------------------------------------- estimates


def _known(road, field):
    if field in CORE:
        return road[field]["value"] is not None
    return field in road.get("survey", {})


def _value(road, field):
    return road[field]["value"] if field in CORE else road["survey"][field]["value"]


def _majority(values):
    if not values:
        return None, 0
    value, count = Counter(values).most_common(1)[0]
    return value, count


def estimate_roads(world, schema):
    """Fill road['estimate'] for unsurveyed fields. Returns the number of roads that received estimates."""
    survey_fields = [
        fd["key"] for fd in schema["fields"] if fd["key"] not in ("width_method", "notes", "photos")
    ]
    surveyed = [r for r in world["roads"] if any(_known(r, f) and _is_survey(r, f) for f in survey_fields)]

    def peers(road, field):
        same = [_value(r, field) for r in surveyed if group_of(r) == group_of(road) and _known(r, field)]
        return same

    def everyone(field):
        return [_value(r, field) for r in surveyed if _known(r, field)]

    def est(value, basis, confidence):
        return {"value": value, "source": SOURCE, "basis": basis, "confidence": confidence}

    count = 0
    for road in world["roads"]:
        road.pop("estimate", None)
        s = road["surroundings"]
        if s["in_restricted"]:
            continue
        g = group_of(road)
        built_up = s["buildings_per_100m"] >= BUILT_UP_PER_100M
        out = {}
        for field in [
            "width_m",
            "surface",
            "drain",
            "footpath",
            *[f for f in survey_fields if f not in CORE],
        ]:
            if field == "width_m" or _known(road, field):
                continue
            out[field] = _estimate_field(
                road, field, g, built_up, s, peers(road, field), everyone(field), est
            )
        if not _known(road, "width_m"):
            out["width_m"] = _estimate_width(road, g, s, surveyed, est)
        out = {k: v for k, v in out.items() if v is not None}
        if out:
            road["estimate"] = out
            count += 1
    return count


def _is_survey(road, field):
    src = road[field]["source"] if field in CORE else road["survey"][field]["source"]
    return bool(src) and src.startswith("survey:")


def _estimate_field(road, field, g, built_up, s, same, every, est):
    surface = road["surface"]["value"]
    if field == "surface":
        if g == "highway":
            return est("tar (asphalt)", "Owner: only the highways here are tar.", "medium")
        if g in ("service", "track"):
            return est(
                "red mud / moram",
                "Minor service lane or track; owner: other roads are concrete or red mud.",
                "low",
            )
        if built_up:
            return est(
                "concrete",
                f"Built-up street ({s['buildings_per_100m']} buildings per 100 m). Owner: roads are concrete "
                "or red mud, and the surveyed residential streets are concrete.",
                "medium",
            )
        return est(
            "red mud / moram",
            f"Few buildings along it ({s['buildings_per_100m']} per 100 m). "
            "Owner: roads are concrete or red mud.",
            "low",
        )
    if field == "drain" and g in ("service", "track") and not same:
        return est("none", "Back lanes and tracks rarely have built drains; none surveyed yet.", "low")
    value, n = _majority(same)
    if value is not None:
        return est(
            value,
            f"Same as {n} of {len(same)} surveyed {_group_word(g)} with this field.",
            "medium" if n >= 2 else "low",
        )
    # research-based defaults for fields not yet surveyed anywhere
    red_mud = (surface or "").startswith("red mud")
    defaults = {
        "garbage": (
            "some litter",
            "Research: open dumping and litter are common on Indian streets; exact heaps only where pinned.",
        ),
        "stray_animals": ("few", "Research: stray dogs and cattle are common in Indian colonies."),
        "shops_stalls": (
            ("few" if built_up else "none"),
            "Built-up streets usually have a kirana store or tea stall; exact ones only where pinned.",
        ),
        "potholes": (
            ("many" if red_mud else "some"),
            "Unpaved red mud roads rut and pothole more than concrete.",
        ),
        "water_logging": (("sometimes" if red_mud else "no"), "Unpaved red mud roads hold water after rain."),
    }
    if field in defaults:
        v, basis = defaults[field]
        return est(v, basis, "low")
    value, n = _majority(every)
    if value is not None:
        return est(value, f"Same as {n} of {len(every)} surveyed streets (any kind).", "low")
    return None


def _estimate_width(road, g, s, surveyed, est):
    lo, hi = WIDTH_RANGE[g]
    ratios = [
        r["width_m"]["value"] / r["surroundings"]["gap_median_m"]
        for r in surveyed
        if r["width_m"]["value"] and r["surroundings"]["gap_median_m"] and group_of(r) == g
    ]  # only same-kind roads: a main road's proportions say little about a back lane
    if s["gap_median_m"] and ratios:
        # Owner's rule: never widen roads. With few surveyed streets, use the narrowest ratio seen,
        # so estimates err on the narrow side rather than the wide side.
        ratio = min(ratios)
        raw = ratio * s["gap_median_m"]
        value = round(max(lo, min(hi, raw, s["gap_median_m"])) * 2) / 2
        basis = (
            f"Buildings on both sides are about {s['gap_median_m']} m apart; the narrowest surveyed "
            f"street of this kind uses {round(ratio * 100)}% of that gap as road (estimates err narrow). "
            f"Kept within {lo:g}–{hi:g} m for a {_group_word(g, 1)}."
        )
        # widths vary a lot street to street: only "medium" once 3+ streets of this kind are surveyed
        return est(value, basis, "medium" if len(ratios) >= 3 else "low")
    widths = [r["width_m"]["value"] for r in surveyed if r["width_m"]["value"] and group_of(r) == g]
    if widths:
        value = round(max(lo, min(hi, statistics.median(widths))) * 2) / 2
        return est(
            value, f"No buildings on both sides to measure; typical of surveyed {_group_word(g)}.", "low"
        )
    value = WIDTH_FALLBACK[g]
    if s["gap_median_m"]:
        value = round(max(lo, min(value, s["gap_median_m"])) * 2) / 2
    return est(
        value,
        f"No surveyed {_group_word(g)} yet; typical width, never wider than the buildings allow.",
        "low",
    )


def _group_word(g, n=2):
    words = {
        "highway": ("highway", "highways"),
        "connector": ("connector road", "connector roads"),
        "lane": ("colony lane", "colony lanes"),
        "service": ("service lane", "service lanes"),
        "track": ("track", "tracks"),
    }
    return words[g][0 if n == 1 else 1]
