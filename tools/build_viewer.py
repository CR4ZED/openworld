#!/usr/bin/env python3
"""Build the 2D map viewer: template + world data + survey schema + scripts -> one HTML file."""

import argparse
import json
import os

ROOT = os.path.join(os.path.dirname(__file__), "..")


def script_safe(text):
    """Make text safe to place inside a <script> element."""
    return text.replace("</", "<\\/")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", required=True)
    ap.add_argument("--template", default=os.path.join(ROOT, "viewer", "map_template.html"))
    ap.add_argument("--schema", default=os.path.join(ROOT, "data", "survey", "street_survey_schema.json"))
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    with open(a.world) as f:
        world = json.load(f)
    with open(a.schema) as f:
        schema = json.load(f)
    with open(a.template) as f:
        html = f.read()
    parts = {
        "__TITLE__": world["meta"]["name"],
        "__WORLD_JSON__": script_safe(json.dumps(world, ensure_ascii=False, separators=(",", ":"))),
        "__SURVEY_SCHEMA_JSON__": script_safe(json.dumps(schema, ensure_ascii=False, separators=(",", ":"))),
    }
    for name in ("survey", "map"):
        with open(os.path.join(ROOT, "viewer", f"{name}.js")) as f:
            parts[f"__{name.upper()}_JS__"] = script_safe(f.read())
    for key, value in parts.items():
        if key not in html:
            raise SystemExit(f"template is missing placeholder {key}")
        html = html.replace(key, value)
    with open(a.out, "w") as f:
        f.write(html)
    print(f"wrote {a.out} ({len(html) // 1024} KB)")


if __name__ == "__main__":
    main()
