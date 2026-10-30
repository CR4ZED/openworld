#!/usr/bin/env bash
# Re-download the raw open data for the FCI Colony area (1 km radius around the pin + margin).
# OpenStreetMap: API map call. Google Open Buildings v3: S2 level-4 cell 3a3 (~3.2 GB gzip),
# streamed and filtered to the area so nothing large is stored.
set -euo pipefail
cd "$(dirname "$0")/.."
BBOX="82.254411,17.004431,82.275078,17.024328"   # lon/lat box, 1.1 km around 17.0143794,82.2647444
UA="openworld (github.com/CR4ZED/openworld)"
mkdir -p data/raw/buildings
curl -sS -A "$UA" "https://api.openstreetmap.org/api/0.6/map?bbox=$BBOX" -o data/raw/fci_colony_1km.osm
echo "OSM: $(grep -c '<way' data/raw/fci_colony_1km.osm) ways"
curl -sS "https://storage.googleapis.com/open-buildings-data/v3/polygons_s2_level_4_gzip/3a3_buildings.csv.gz" \
  | gunzip -c \
  | awk -F, 'NR==1 || ($1>16.9935 && $1<17.0353 && $2>82.2539 && $2<82.2756)' \
  > data/raw/buildings/google_fci_area.csv
echo "Google Open Buildings: $(($(wc -l < data/raw/buildings/google_fci_area.csv) - 1)) rows"
