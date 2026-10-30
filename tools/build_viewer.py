#!/usr/bin/env python3
"""Inject a world JSON into the 2D map viewer template -> a single self-contained HTML file."""
import argparse
import json


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", required=True)
    ap.add_argument("--template", default="viewer/map_template.html")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    with open(a.world) as f:
        world = json.load(f)
    data = json.dumps(world, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    with open(a.template) as f:
        html = f.read()
    title = world["meta"]["name"]
    html = html.replace("__TITLE__", title).replace("__WORLD_JSON__", data)
    with open(a.out, "w") as f:
        f.write(html)
    print(f"wrote {a.out} ({len(html) // 1024} KB)")


if __name__ == "__main__":
    main()
