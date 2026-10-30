"""Estimates for unsurveyed roads: helpful, labelled, and never mistaken for survey data."""

import json
import os
import sys
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
from estimates import (  # noqa: E402
    CORE,
    SOURCE,
    estimate_buildings,
    estimate_roads,
    group_of,
    measure_surroundings,
)

WORLD = os.path.join(HERE, "..", "data", "world", "fci_colony.json")
SCHEMA = os.path.join(HERE, "..", "data", "survey", "street_survey_schema.json")
UNKNOWN = {"value": None, "source": None}


def road(rid, cls, x0, x1, y=0.0, **known):
    r = {
        "id": rid,
        "source": "osm:way/1",
        "osm_class": cls,
        "parts": [[(x0, y), (x1, y)]],
        **{k: dict(UNKNOWN) for k in ("name", "lanes", "oneway", *CORE)},
    }
    for k, v in known.items():
        r[k] = {"value": v, "source": "survey:owner-2026-10-30"}
    return r


def row_of_houses(y0, y1, x0=0, x1=200, step=10):
    """Small houses every `step` metres between y0 and y1 (a built-up side of a street)."""
    return [
        {"id": f"b{y0}-{x}", "kind": "building", "points": [(x, y0), (x + 8, y0), (x + 8, y1), (x, y1)]}
        for x in range(x0, x1, step)
    ]


def tiny_world():
    # surveyed lane at y=0 (buildings 20 m apart), unsurveyed lane at y=100 (buildings 16 m apart),
    # unsurveyed lane at y=300 with no buildings, a highway at y=500
    areas = row_of_houses(10, 18) + row_of_houses(-10, -18) + row_of_houses(108, 116) + row_of_houses(92, 84)
    return {
        "meta": {"center": {"lat": 17.0, "lon": 82.0}, "radius_m": 1000},
        "gaps": {},
        "roads": [
            road(
                "r-surveyed",
                "residential",
                0,
                200,
                0,
                width_m=8.0,
                surface="concrete",
                drain="open, both sides",
            ),
            road("r-built", "residential", 0, 200, 100),
            road("r-open", "residential", 0, 200, 300),
            road("r-highway", "primary", 0, 200, 500),
            road("r-service", "service", 0, 200, 700),
        ],
        "areas": areas,
        "lines": [],
        "pois": [],
    }


def run(world):
    with open(SCHEMA) as f:
        schema = json.load(f)
    measure_surroundings(world)
    estimate_roads(world, schema)
    return {r["id"]: r for r in world["roads"]}


class EstimateRuleTests(unittest.TestCase):
    def setUp(self):
        self.roads = run(tiny_world())

    def test_surveyed_values_are_never_replaced(self):
        r = self.roads["r-surveyed"]
        self.assertEqual(r["width_m"]["value"], 8.0)
        for f in ("width_m", "surface", "drain"):
            self.assertNotIn(f, r.get("estimate", {}), f"estimate made for surveyed {f}")

    def test_estimates_never_fill_core_attributes(self):
        for rid in ("r-built", "r-open", "r-highway", "r-service"):
            for f in CORE:
                self.assertIsNone(self.roads[rid][f]["value"], f"{rid}.{f} was filled in")

    def test_every_estimate_is_labelled(self):
        for r in self.roads.values():
            for f, e in r.get("estimate", {}).items():
                self.assertEqual(e["source"], SOURCE, f)
                self.assertTrue(e["basis"], f)
                self.assertIn(e["confidence"], ("low", "medium"), f)

    def test_width_learns_from_same_kind_and_errs_narrow(self):
        # surveyed lane: 8 m road between buildings 20 m apart -> 40%; built lane has buildings 16 m apart
        w = self.roads["r-built"]["estimate"]["width_m"]
        self.assertAlmostEqual(w["value"], 6.5, delta=0.5)
        self.assertLessEqual(w["value"], self.roads["r-built"]["surroundings"]["gap_median_m"])

    def test_highway_is_tar_and_other_roads_are_not(self):
        self.assertEqual(self.roads["r-highway"]["estimate"]["surface"]["value"], "tar (asphalt)")
        for rid in ("r-built", "r-open", "r-service"):
            self.assertNotIn("tar", self.roads[rid]["estimate"]["surface"]["value"])

    def test_built_up_lane_is_concrete_open_lane_is_red_mud(self):
        self.assertEqual(self.roads["r-built"]["estimate"]["surface"]["value"], "concrete")
        self.assertEqual(self.roads["r-open"]["estimate"]["surface"]["value"], "red mud / moram")

    def test_service_lane_gets_no_invented_drain(self):
        self.assertEqual(self.roads["r-service"]["estimate"]["drain"]["value"], "none")
        self.assertEqual(self.roads["r-service"]["estimate"]["drain"]["confidence"], "low")

    def test_restricted_roads_get_no_estimates(self):
        world = tiny_world()
        world["areas"].append(
            {
                "id": "zone",
                "kind": "landuse:industrial",
                "restricted": {"value": "test", "source": "survey:owner-2026-10-30"},
                "levels": dict(UNKNOWN),
                "points": [(-10, 650), (300, 650), (300, 750), (-10, 750)],
            }
        )
        roads = run(world)
        self.assertNotIn("estimate", roads["r-service"])


class BuildingEstimateTests(unittest.TestCase):
    def building(self, size, levels=None):
        lv = {"value": levels, "source": "survey:owner-2026-10-30" if levels else None}
        return {
            "id": f"b{size}",
            "kind": "building",
            "levels": lv,
            "points": [(0, 0), (size, 0), (size, size), (0, size)],
        }

    def test_floors_estimated_by_footprint_and_labelled(self):
        w = {"areas": [self.building(5), self.building(10), self.building(20)]}  # 25, 100, 400 m2
        self.assertEqual(estimate_buildings(w), 3)
        got = [a["estimate"]["levels"] for a in w["areas"]]
        self.assertEqual([e["value"] for e in got], [1, 2, 3])
        for e in got:
            self.assertEqual((e["source"], e["confidence"]), (SOURCE, "low"))
            self.assertTrue(e["basis"])
        self.assertTrue(
            all(a["levels"]["value"] is None for a in w["areas"]), "estimate filled the real value"
        )

    def test_known_floors_are_not_estimated(self):
        w = {"areas": [self.building(10, levels=3)]}
        self.assertEqual(estimate_buildings(w), 0)
        self.assertNotIn("estimate", w["areas"][0])


class RealWorldEstimateTests(unittest.TestCase):
    """Checks on the built FCI Colony world."""

    @classmethod
    def setUpClass(cls):
        with open(WORLD) as f:
            cls.w = json.load(f)

    def test_unsurveyed_roads_outside_restricted_areas_have_core_estimates(self):
        for r in self.w["roads"]:
            if r["surroundings"]["in_restricted"]:
                self.assertNotIn("estimate", r, r["id"])
                continue
            for f in CORE:
                if r[f]["value"] is None:
                    self.assertIn(f, r.get("estimate", {}), f"{r['id']} has no estimate for {f}")

    def test_estimated_widths_within_buildings_and_range(self):
        for r in self.w["roads"]:
            e = r.get("estimate", {}).get("width_m")
            if not e:
                continue
            gap = r["surroundings"]["gap_median_m"]
            if gap:
                self.assertLessEqual(e["value"], gap + 0.25, r["id"])
            self.assertGreaterEqual(e["value"], 2.0, r["id"])
            self.assertLessEqual(e["value"], 30.0, r["id"])

    def test_only_highways_estimated_as_tar(self):
        for r in self.w["roads"]:
            e = r.get("estimate", {}).get("surface")
            if e and "tar" in e["value"]:
                self.assertEqual(group_of(r), "highway", r["id"])

    def test_gap_count_matches(self):
        self.assertEqual(
            self.w["gaps"]["roads_with_estimates"], sum(1 for r in self.w["roads"] if "estimate" in r)
        )


if __name__ == "__main__":
    unittest.main()
