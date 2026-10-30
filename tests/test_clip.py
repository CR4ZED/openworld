"""Unit tests for geometry clipping in tools/build_world.py."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
from build_world import clip_line, clip_polygon, local_xy  # noqa: E402


class ClipTests(unittest.TestCase):
    def test_line_fully_inside_unchanged(self):
        self.assertEqual(clip_line([(0, 0), (5, 5)], 10), [[(0, 0), (5, 5)]])

    def test_line_fully_outside_dropped(self):
        self.assertEqual(clip_line([(20, 20), (30, 30)], 10), [])

    def test_line_crossing_is_cut_at_edge(self):
        parts = clip_line([(0, 0), (20, 0)], 10)
        self.assertEqual(parts, [[(0, 0), (10.0, 0.0)]])

    def test_line_leaving_and_reentering_splits(self):
        parts = clip_line([(0, 0), (20, 0), (20, 5), (0, 5)], 10)
        self.assertEqual(len(parts), 2)

    def test_polygon_clipped_to_square(self):
        poly = clip_polygon([(-20, -20), (20, -20), (20, 20), (-20, 20)], 10)
        for x, y in poly:
            self.assertLessEqual(abs(x), 10)
            self.assertLessEqual(abs(y), 10)
        self.assertEqual(len(poly), 4)

    def test_projection_origin_and_scale(self):
        self.assertEqual(local_xy(17.0, 82.0, 17.0, 82.0), (0.0, 0.0))
        x, y = local_xy(17.001, 82.0, 17.0, 82.0)
        self.assertAlmostEqual(y, 110.57, places=1)  # 0.001 deg latitude ~ 110.6 m


if __name__ == "__main__":
    unittest.main()
