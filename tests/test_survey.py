"""Street survey import: valid surveys merge with the survey as source; bad input is rejected."""

import copy
import json
import math
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
from build_world import SurveyError, apply_street_survey, validate_street_survey  # noqa: E402

ROAD_IDS = {"road-1", "road-2"}
VALID = {
    "format": "openworld-street-survey/1",
    "surveyor": "owner",
    "date": "2026-10-31",
    "streets": {
        "road-1": {
            "width_m": 4.5,
            "width_method": "tape",
            "surface": "concrete",
            "drain": "open, one side",
            "footpath": "none",
            "speed_breakers": 2,
            "notes": "Milk booth at the corner",
        }
    },
}


def tiny_world():
    def road(rid):
        unknown = {"value": None, "source": None}
        return {
            "id": rid,
            "source": "osm:way/1",
            "osm_class": "residential",
            "parts": [[(0, 0), (10, 0)]],
            **{
                k: dict(unknown)
                for k in ("name", "width_m", "lanes", "surface", "oneway", "drain", "footpath")
            },
        }

    restricted = {
        "id": "area-r",
        "kind": "landuse:industrial",
        "restricted": {"value": "test site", "source": "survey:owner-2026-10-30"},
        "levels": {"value": None, "source": None},
        "points": [(200, -100), (400, -100), (400, 100), (200, 100)],
    }
    return {
        "meta": {"center": {"lat": 17.0, "lon": 82.0}, "radius_m": 1000},
        "gaps": {},
        "roads": [road("road-1"), road("road-2")],
        "areas": [restricted],
        "lines": [],
        "pois": [],
    }


def latlon(x, y):
    """Inverse of build_world.local_xy around the tiny world's centre (17.0, 82.0)."""
    return 17.0 + y / 110574.0, 82.0 + x / (111320.0 * math.cos(math.radians(17.0)))


def place(pid, x, y, **kw):
    lat, lon = latlon(x, y)
    return {"id": pid, "lat": lat, "lon": lon, "type": "temple", **kw}


class ValidateTests(unittest.TestCase):
    def test_valid_survey_passes(self):
        validate_street_survey(VALID, ROAD_IDS)

    def rejects(self, mutate, needle):
        bad = copy.deepcopy(VALID)
        mutate(bad)
        with self.assertRaises(SurveyError) as cm:
            validate_street_survey(bad, ROAD_IDS)
        self.assertIn(needle, str(cm.exception))

    def test_rejects_impossible_width(self):
        self.rejects(lambda s: s["streets"]["road-1"].update(width_m=0.4), "width_m")
        self.rejects(lambda s: s["streets"]["road-1"].update(width_m=120), "width_m")

    def test_rejects_text_width(self):
        self.rejects(lambda s: s["streets"]["road-1"].update(width_m="4.5"), "width_m")

    def test_rejects_unknown_road(self):
        self.rejects(lambda s: s["streets"].update({"road-999": {"surface": "mud"}}), "no such road")

    def test_rejects_value_outside_choices(self):
        self.rejects(lambda s: s["streets"]["road-1"].update(drain="huge canal"), "drain")

    def test_rejects_unknown_field(self):
        self.rejects(lambda s: s["streets"]["road-1"].update(lanes_painted=True), "unknown field")

    def test_rejects_fractional_count(self):
        self.rejects(lambda s: s["streets"]["road-1"].update(speed_breakers=1.5), "speed_breakers")

    def test_rejects_bad_date_and_format(self):
        self.rejects(lambda s: s.update(date="31/10/2026"), "date")
        self.rejects(lambda s: s.update(format="something-else"), "format")


class ApplyTests(unittest.TestCase):
    def test_survey_values_carry_survey_source(self):
        w = tiny_world()
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(VALID, f)
        apply_street_survey(w, f.name)
        os.unlink(f.name)
        r1, r2 = w["roads"]
        src = "survey:owner-2026-10-31"
        self.assertEqual(r1["width_m"], {"value": 4.5, "source": src})
        self.assertEqual(r1["drain"], {"value": "open, one side", "source": src})
        self.assertEqual(r1["survey"]["speed_breakers"], {"value": 2, "source": src})
        # untouched fields stay unknown; untouched roads stay unknown
        self.assertEqual(r1["lanes"], {"value": None, "source": None})
        self.assertIsNone(r2["width_m"]["value"])
        self.assertEqual(w["gaps"]["roads_surveyed"], 1)
        self.assertEqual(w["gaps"]["roads_without_width"], 1)


class PlaceTests(unittest.TestCase):
    def survey(self, places, streets=None):
        return {
            **{k: VALID[k] for k in ("format", "surveyor", "date")},
            "streets": streets or {},
            "places": places,
        }

    def check(self, places, needle):
        with self.assertRaises(SurveyError) as cm:
            validate_street_survey(self.survey(places), ROAD_IDS, world=tiny_world())
        self.assertIn(needle, str(cm.exception))

    def test_places_only_survey_is_valid(self):
        validate_street_survey(
            self.survey([place("p1", 10, 20, name="Sri Rama temple")]), ROAD_IDS, world=tiny_world()
        )

    def test_rejects_unknown_place_type(self):
        self.check([place("p1", 10, 20, type="spaceport")], "type")

    def test_rejects_place_outside_map(self):
        self.check([place("p1", 1500, 0)], "outside the mapped area")

    def test_rejects_place_inside_restricted_area(self):
        self.check([place("p1", 300, 0)], "restricted")

    def test_rejects_duplicate_ids_and_missing_type(self):
        p = place("p1", 10, 20)
        q = place("p1", 30, 20)
        del q["type"]
        with self.assertRaises(SurveyError) as cm:
            validate_street_survey(self.survey([p, q]), ROAD_IDS, world=tiny_world())
        self.assertIn("unique", str(cm.exception))
        self.assertIn("type is required", str(cm.exception))

    def test_rejects_empty_survey(self):
        with self.assertRaises(SurveyError):
            validate_street_survey(self.survey([]), ROAD_IDS, world=tiny_world())

    def test_places_become_points_with_survey_source(self):
        w = tiny_world()
        sv = self.survey([place("p1", 10, 20, note="right side"), place("p2", -50, 5, type="restaurant")])
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(sv, f)
        apply_street_survey(w, f.name)
        os.unlink(f.name)
        pois = {p["id"]: p for p in w["pois"]}
        t = pois["poi-survey-p1"]
        self.assertEqual(t["kind"], "survey:temple")
        self.assertTrue(t["sacred"])
        self.assertFalse(pois["poi-survey-p2"]["sacred"])
        self.assertEqual(t["source"], "survey:owner-2026-10-31")
        self.assertEqual(t["note"]["value"], "right side")
        self.assertIsNone(t["name"]["value"])
        self.assertAlmostEqual(t["point"][0], 10, delta=0.05)
        self.assertAlmostEqual(t["point"][1], 20, delta=0.05)
        self.assertEqual(w["gaps"]["places_surveyed"], 2)


class SchemaTests(unittest.TestCase):
    def test_schema_fields_are_well_formed(self):
        with open(os.path.join(HERE, "..", "data", "survey", "street_survey_schema.json")) as f:
            schema = json.load(f)
        keys = [fd["key"] for fd in schema["fields"]]
        self.assertEqual(len(keys), len(set(keys)))
        for fd in schema["fields"]:
            self.assertIn(fd["type"], ("number", "integer", "choice", "text"))
            if fd["type"] == "choice":
                self.assertGreaterEqual(len(fd["options"]), 2)
        # attributes the realism rules require surveys for are all collectable
        attrs = {fd.get("road_attr") for fd in schema["fields"]}
        self.assertTrue({"width_m", "surface", "drain", "footpath"} <= attrs)


if __name__ == "__main__":
    unittest.main()
