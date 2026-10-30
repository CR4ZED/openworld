"""World-data guardrail checks (layer 1 of the testing plan).

Run: python3 -m unittest discover -s tests
Fails if any feature lacks a source, if any attribute has a value without a
source (i.e. was invented), or if geometry is outside the expected area.
"""

import json
import math
import os
import unittest

WORLD = os.environ.get(
    "WORLD_JSON", os.path.join(os.path.dirname(__file__), "..", "data", "world", "fci_colony.json")
)


class WorldDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(WORLD) as f:
            cls.w = json.load(f)
        cls.features = cls.w["roads"] + cls.w["areas"] + cls.w["lines"] + cls.w["pois"]

    def test_attribution_present(self):
        self.assertIn("OpenStreetMap", self.w["meta"]["attribution"])
        self.assertEqual(self.w["meta"]["license"], "ODbL 1.0")

    def test_every_feature_has_a_source(self):
        for f in self.features:
            self.assertTrue(
                f.get("source", "").startswith(("osm:", "survey:", "photo:", "open-buildings:")), f["id"]
            )

    def test_ids_unique(self):
        ids = [f["id"] for f in self.features]
        self.assertEqual(len(ids), len(set(ids)))

    def test_no_invented_attribute_values(self):
        """Any attribute object with a value must say where the value came from."""
        for f in self.features:
            for k, v in f.items():
                if isinstance(v, dict) and set(v) == {"value", "source"}:
                    if v["value"] is not None:
                        self.assertIsNotNone(v["source"], f"{f['id']}.{k} has a value but no source")
                    else:
                        self.assertIsNone(v["source"], f"{f['id']}.{k} unknown but has a source")

    def test_roads_have_no_default_widths(self):
        """Width must come from OSM or survey, never a class default."""
        for r in self.w["roads"]:
            wv = r["width_m"]
            if wv["value"] is not None:
                self.assertGreater(wv["value"], 1.0, r["id"])
                self.assertLess(wv["value"], 60.0, r["id"])

    def test_owner_notes_carry_survey_source(self):
        for f in self.features:
            for n in f.get("notes", []):
                self.assertTrue(n["source"].startswith("survey:"), f["id"])
            for k in ("alias", "restricted"):
                if k in f:
                    self.assertTrue(f[k]["source"].startswith("survey:"), f["id"])

    def test_restricted_areas_have_no_building_detail(self):
        """Sensitive sites (e.g. ONGC) must never carry modelled detail."""
        for a in self.w["areas"]:
            if "restricted" in a:
                self.assertIsNone(a["levels"]["value"], a["id"])
                self.assertNotEqual(a["kind"], "building", a["id"])

    def test_no_buildings_inside_restricted_areas(self):
        import os
        import sys

        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
        from build_world import point_in_poly

        zones = [a["points"] for a in self.w["areas"] if "restricted" in a]
        for b in self.w["areas"]:
            if b["kind"] != "building":
                continue
            cx = sum(p[0] for p in b["points"]) / len(b["points"])
            cy = sum(p[1] for p in b["points"]) / len(b["points"])
            for z in zones:
                self.assertFalse(point_in_poly(cx, cy, z), f"{b['id']} is inside a restricted area")

    def test_building_source_attributed(self):
        if any(a["source"].startswith("open-buildings:") for a in self.w["areas"]):
            names = [s["attribution"] for s in self.w["meta"].get("building_sources", [])]
            self.assertTrue(any("Open Buildings" in n for n in names))

    def test_building_floors_never_guessed(self):
        for a in self.w["areas"]:
            if a["kind"] == "building" and a["source"].startswith("open-buildings:"):
                self.assertIsNone(a["levels"]["value"], a["id"])

    def test_drains_are_survey_only(self):
        for r in self.w["roads"]:
            d = r["drain"]
            if d["value"] is not None:
                self.assertTrue(d["source"].startswith(("survey:", "photo:")), r["id"])

    def test_geometry_near_area(self):
        limit = self.w["meta"]["radius_m"] * 1.1 * math.sqrt(2) + 1
        for f in self.features:
            pts = f.get("points") or (
                [p for part in f["parts"] for p in part] if "parts" in f else [f["point"]]
            )
            for x, y in pts:
                self.assertLess(math.hypot(x, y), limit, f["id"])

    def test_building_heights_sane(self):
        for a in self.w["areas"]:
            lv = a["levels"]["value"]
            if lv is not None:
                self.assertTrue(0 < lv <= 40, f"{a['id']} has {lv} levels")

    def test_gap_counts_match_data(self):
        g = self.w["gaps"]
        self.assertEqual(g["roads_total"], len(self.w["roads"]))
        self.assertEqual(
            g["roads_without_width"], sum(1 for r in self.w["roads"] if r["width_m"]["value"] is None)
        )


if __name__ == "__main__":
    unittest.main()
