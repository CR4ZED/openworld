/* 2D map viewer. Inlined into the page by tools/build_viewer.py. */
(() => {
  const W = JSON.parse(document.getElementById("world-data").textContent);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.getElementById("map"),
    gWorld = document.getElementById("world"),
    gLabels = document.getElementById("labels");
  const R = W.meta.radius_m;

  const ROAD_STYLE = {
    motorway: ["#c0392b", 6],
    trunk: ["#c0392b", 6],
    primary: ["#d6604d", 5],
    secondary: ["#e3a13b", 4.2],
    tertiary: ["#e3a13b", 3.4],
    unclassified: ["#5b6169", 2.6],
    residential: ["#5b6169", 2.1],
    living_street: ["#5b6169", 2.1],
    service: ["#9aa0a6", 1.4],
    track: ["#9a7b4f", 1.4, "5 4"],
    path: ["#9a7b4f", 1.2, "2 3"],
    footway: ["#9a7b4f", 1.2, "2 3"],
    pedestrian: ["#9a7b4f", 1.6],
    cycleway: ["#2f7d5b", 1.2, "2 3"],
  };
  const AREA_STYLE = (k) =>
    k === "building"
      ? ["#c9b8a6", "#9c8670"]
      : k === "landuse:industrial"
        ? ["#e6dde9", "none"]
        : k.startsWith("landuse:")
          ? ["#f1ece0", "none"]
          : k.startsWith("leisure:") || k.startsWith("natural:")
            ? ["#dcebd3", "none"]
            : ["#e9e4d8", "none"];

  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  const pathD = (pts) => pts.map((p, i) => (i ? "L" : "M") + p[0] + " " + -p[1]).join("");
  const len = (parts) =>
    parts.reduce(
      (s, pts) => s + pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0),
      0,
    );

  // ---- draw world (world units = metres, y flipped so north is up) ----
  const byId = {};
  const layerAreas = el("g", {}, gWorld),
    layerLines = el("g", {}, gWorld),
    layerWidth = el("g", {}, gWorld),
    layerRoads = el("g", {}, gWorld),
    layerMySurvey = el("g", {}, gWorld),
    layerHits = el("g", {}, gWorld),
    layerSel = el("g", {}, gWorld);

  // land use first (big), then buildings on top
  const areas = [...W.areas].sort((a, b) => (a.kind === "building") - (b.kind === "building"));
  for (const a of areas) {
    const [fill0, stroke0] = AREA_STYLE(a.kind);
    const low = a.confidence && a.confidence.value < 0.75;
    const fill = a.restricted ? "url(#hatch)" : low ? "#e3d8cb" : fill0,
      stroke = a.restricted ? "#b45454" : stroke0;
    const p = el(
      "path",
      {
        d: pathD(a.points) + "Z",
        fill,
        stroke,
        "stroke-width": low ? 0.8 : 0.6,
        "stroke-dasharray": low ? "2 2" : "",
        "vector-effect": "non-scaling-stroke",
        "data-id": a.id,
      },
      layerAreas,
    );
    if (a.kind === "building" || a.restricted) {
      p.style.cursor = "pointer";
    }
    byId[a.id] = { f: a, type: "area", node: p };
  }
  for (const l of W.lines) {
    const water = l.kind.startsWith("waterway");
    for (const pts of l.parts)
      el(
        "path",
        {
          d: pathD(pts),
          fill: "none",
          stroke: water ? "#3b82c4" : "#8a5cc2",
          "stroke-width": water ? 1.8 : 1.1,
          "stroke-dasharray": water ? "" : "7 4",
          "vector-effect": "non-scaling-stroke",
        },
        layerLines,
      );
    byId[l.id] = { f: l, type: "line" };
  }
  const order = [
    "service",
    "track",
    "path",
    "footway",
    "residential",
    "living_street",
    "unclassified",
    "tertiary",
    "secondary",
    "primary",
    "trunk",
    "motorway",
  ];
  const roads = [...W.roads].sort((a, b) => order.indexOf(a.osm_class) - order.indexOf(b.osm_class));
  for (const r of roads) {
    const [col, w, dash] = ROAD_STYLE[r.osm_class] || ["#7a7f87", 1.5];
    const d = r.parts.map(pathD).join("");
    el(
      "path",
      {
        d,
        fill: "none",
        stroke: col,
        "stroke-width": w,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "stroke-dasharray": dash || "",
        "vector-effect": "non-scaling-stroke",
      },
      layerRoads,
    );
    const hit = el(
      "path",
      {
        d,
        fill: "none",
        stroke: "transparent",
        "stroke-width": 16,
        "vector-effect": "non-scaling-stroke",
        "pointer-events": "stroke",
        "data-id": r.id,
      },
      layerHits,
    );
    hit.style.cursor = "pointer";
    byId[r.id] = { f: r, type: "road", d };
  }
  // Surveyed roads: draw the real width (stroke in metres, so it scales with zoom).
  for (const r of W.roads)
    if (r.width_m.value !== null) {
      el(
        "path",
        {
          d: r.parts.map(pathD).join(""),
          fill: "none",
          stroke: "#d8cfbd",
          "stroke-width": r.width_m.value,
          "stroke-linecap": "butt",
          "stroke-linejoin": "round",
          "pointer-events": "none",
          "data-width-m": r.width_m.value,
        },
        layerWidth,
      );
    }
  // Streets surveyed on this phone but not yet sent: green overlay.
  function drawMySurvey() {
    layerMySurvey.textContent = "";
    const S = window.OpenworldSurvey;
    if (!S) return;
    for (const rid of S.ids()) {
      const it = byId[rid];
      if (!it || it.type !== "road") continue;
      el(
        "path",
        {
          d: it.d,
          fill: "none",
          stroke: "#15803d",
          "stroke-width": 4,
          "stroke-opacity": 0.85,
          "stroke-linecap": "round",
          "vector-effect": "non-scaling-stroke",
          "pointer-events": "none",
          "data-my-survey": rid,
        },
        layerMySurvey,
      );
    }
    const b = document.getElementById("btnSurvey");
    if (b) b.textContent = S.count() ? `Survey · ${S.count()}` : "Survey";
  }
  document.addEventListener("survey-changed", drawMySurvey);
  const layerOwner = el("g", {}, gWorld);
  for (const r of W.roads)
    if (r.notes && r.osm_class !== "primary") {
      el(
        "path",
        {
          d: r.parts.map(pathD).join(""),
          fill: "none",
          stroke: "#1d6fd8",
          "stroke-width": 2,
          "stroke-dasharray": "1 7",
          "stroke-linecap": "round",
          "vector-effect": "non-scaling-stroke",
          "pointer-events": "none",
          transform: "",
        },
        layerOwner,
      );
    }
  gWorld.insertBefore(layerOwner, layerHits);
  // outside-the-radius veil + boundary circle
  const big = R * 4;
  el(
    "path",
    {
      d: `M${-big} ${-big}H${big}V${big}H${-big}Z M${R} 0A${R} ${R} 0 1 0 ${-R} 0A${R} ${R} 0 1 0 ${R} 0Z`,
      fill: "rgba(247,244,236,0.72)",
      "fill-rule": "evenodd",
      "pointer-events": "none",
    },
    gWorld,
  );
  el(
    "circle",
    {
      cx: 0,
      cy: 0,
      r: R,
      fill: "none",
      stroke: "#8b8577",
      "stroke-width": 1.2,
      "stroke-dasharray": "6 5",
      "vector-effect": "non-scaling-stroke",
      "pointer-events": "none",
    },
    gWorld,
  );

  // ---- labels (screen space so text never scales or flips) ----
  const labelItems = [];
  const placeKinds = ["place:suburb", "place:neighbourhood"];
  for (const p of W.pois) {
    const isPlace = placeKinds.includes(p.kind),
      isTower = p.kind === "power:tower";
    byId[p.id] = { f: p, type: "poi" };
    labelItems.push({ p, isPlace, isTower });
  }
  for (const a of W.areas)
    if (a.restricted) {
      // label at the most interior point of the area that lies inside the circle (keeps it off roads and edges)
      const pts = a.points,
        inside = (x, y) => {
          let c = false;
          for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            const [xi, yi] = pts[i],
              [xj, yj] = pts[j];
            if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
          }
          return c;
        };
      const segDist = (x, y) => {
        let m = Infinity;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [ax, ay] = pts[j],
            [bx, by] = pts[i],
            dx = bx - ax,
            dy = by - ay,
            L = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L));
          m = Math.min(m, Math.hypot(x - ax - t * dx, y - ay - t * dy));
        }
        return m;
      };
      const roadDist = (x, y) =>
        Math.min(
          ...W.roads
            .filter((r) => r.osm_class === "primary")
            .flatMap((r) => r.parts.flat())
            .map((p) => Math.hypot(p[0] - x, p[1] - y)),
        );
      let best = null;
      for (let x = -R; x <= R; x += 25)
        for (let y = -R; y <= R; y += 25) {
          if (Math.hypot(x, y) > R * 0.92 || !inside(x, y)) continue;
          const sc = Math.min(segDist(x, y), roadDist(x, y));
          if (!best || sc > best[2]) best = [x, y, sc];
        }
      if (best) labelItems.push({ restricted: a, at: [best[0], best[1]] });
    }
  // main named roads get a label at their midpoint
  const bestByName = {};
  for (const r of W.roads)
    if (r.name.value) {
      const L = len(r.parts);
      if (!bestByName[r.name.value] || L > bestByName[r.name.value].L) bestByName[r.name.value] = { r, L };
    }
  for (const { r } of Object.values(bestByName)) {
    const pts = r.parts.reduce((a, b) => (len([b]) > len([a]) ? b : a));
    labelItems.push({ road: r, at: pts[Math.floor(pts.length / 2)] });
  }

  // ---- camera ----
  let cam = { x: 0, y: 0, s: 1 };
  const headerH = () => document.querySelector("header").getBoundingClientRect().height;
  const size = () => {
    const r = svg.getBoundingClientRect();
    return { w: r.width, h: r.height, top: headerH() };
  };
  const fit = () => {
    const { w, h, top } = size();
    cam = { x: 0, y: 0, s: Math.min(w - 24, h - top - 70) / (2 * R * 1.04) };
  };
  const midY = () => {
    const { h, top } = size();
    return top + (h - top) / 2;
  };
  const toScreen = (x, y) => {
    const { w } = size();
    return [w / 2 + (x - cam.x) * cam.s, midY() - (y - cam.y) * cam.s];
  };
  const toWorld = (sx, sy) => {
    const { w } = size();
    return [cam.x + (sx - w / 2) / cam.s, cam.y - (sy - midY()) / cam.s];
  }; // local metres <-> lat/lon (same equirectangular projection as tools/build_world.py)
  const C = W.meta.center,
    KX = 111320 * Math.cos((C.lat * Math.PI) / 180),
    KY = 110574;
  const toLocal = (lat, lon) => [(lon - C.lon) * KX, (lat - C.lat) * KY];
  const toLatLon = (x, y) => [C.lat + y / KY, C.lon + x / KX];
  const restrictedZones = W.areas.filter((a) => a.restricted).map((a) => a.points);
  const inPoly = (x, y, pts) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i],
        [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };

  function render() {
    const { w } = size();
    gWorld.setAttribute(
      "transform",
      `translate(${w / 2} ${midY()}) scale(${cam.s}) translate(${-cam.x} ${cam.y})`,
    );
    gLabels.textContent = "";
    for (const it of labelItems) {
      if (it.restricted) {
        const [sx, sy] = toScreen(it.at[0], it.at[1]);
        const t = el(
          "text",
          {
            x: sx,
            y: sy,
            "text-anchor": "middle",
            "font-size": 12,
            "font-weight": 650,
            fill: "#8f2f2f",
            stroke: "#f7f4ec",
            "stroke-width": 3,
            "paint-order": "stroke",
            "pointer-events": "none",
          },
          gLabels,
        );
        t.textContent = "ONGC · restricted";
        continue;
      }
      if (it.road) {
        const [sx, sy] = toScreen(it.at[0], it.at[1]);
        const t = el(
          "text",
          {
            x: sx,
            y: sy - 8,
            "text-anchor": "middle",
            "font-size": 12,
            "font-weight": 600,
            fill: "#7a2e22",
            stroke: "#f7f4ec",
            "stroke-width": 3,
            "paint-order": "stroke",
          },
          gLabels,
        );
        t.textContent = it.road.name.value;
        continue;
      }
      const [sx, sy] = toScreen(it.p.point[0], it.p.point[1]);
      if (it.isTower) {
        if (cam.s > 0.6)
          el("rect", { x: sx - 2.5, y: sy - 2.5, width: 5, height: 5, fill: "#8a5cc2" }, gLabels);
        continue;
      }
      if (it.isPlace) {
        const t = el(
          "text",
          {
            x: sx,
            y: sy,
            "text-anchor": "middle",
            "font-size": it.p.kind === "place:suburb" ? 13 : 11.5,
            "font-style": "italic",
            "letter-spacing": ".04em",
            fill: "#4b5160",
            stroke: "#f7f4ec",
            "stroke-width": 3,
            "paint-order": "stroke",
            "pointer-events": "none",
          },
          gLabels,
        );
        t.textContent = (it.p.alias && it.p.alias.value) || it.p.name.value || "";
        continue;
      }
      const g = el("g", { "data-id": it.p.id }, gLabels);
      g.style.cursor = "pointer";
      el("circle", { cx: sx, cy: sy, r: 6, fill: "#1d6fd8", stroke: "#fff", "stroke-width": 2 }, g);
      const t = el(
        "text",
        {
          x: sx + 9,
          y: sy + 4,
          "font-size": 12,
          fill: "#1f2328",
          stroke: "#f7f4ec",
          "stroke-width": 3,
          "paint-order": "stroke",
        },
        g,
      );
      t.textContent = it.p.name.value || it.p.kind.split(":")[1].replace(/_/g, " ");
    }
    // places pinned on this phone (green, tappable to edit)
    const S = window.OpenworldSurvey;
    if (S)
      for (const p of S.places()) {
        const [x, y] = toLocal(p.lat, p.lon);
        const [sx, sy] = toScreen(x, y);
        const g2 = el("g", { "data-place-id": p.id }, gLabels);
        g2.style.cursor = "pointer";
        el(
          "path",
          {
            d: `M${sx} ${sy}c-5 -7 -8 -10 -8 -15a8 8 0 0 1 16 0c0 5 -3 8 -8 15z`,
            fill: "#15803d",
            stroke: "#fff",
            "stroke-width": 2,
          },
          g2,
        );
        const t = el(
          "text",
          {
            x: sx + 11,
            y: sy - 10,
            "font-size": 12,
            "font-weight": 600,
            fill: "#14532d",
            stroke: "#f7f4ec",
            "stroke-width": 3,
            "paint-order": "stroke",
          },
          g2,
        );
        t.textContent = p.name || p.type;
      }
    // centre pin
    const [cx, cy] = toScreen(0, 0);
    const pin = el("g", { "pointer-events": "none" }, gLabels);
    el(
      "path",
      {
        d: `M${cx} ${cy}c-6 -9 -10 -13 -10 -19a10 10 0 0 1 20 0c0 6 -4 10 -10 19z`,
        fill: "#e11d48",
        stroke: "#fff",
        "stroke-width": 2,
      },
      pin,
    );
    el("circle", { cx, cy: cy - 19, r: 3.5, fill: "#fff" }, pin);
    // scale bar
    const target = 110 / cam.s,
      pow = Math.pow(10, Math.floor(Math.log10(target)));
    const nice = [1, 2, 5, 10]
      .map((m) => m * pow)
      .reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
    document.querySelector("#scale .bar").style.width = nice * cam.s + "px";
    document.querySelector("#scale span").textContent = nice >= 1000 ? nice / 1000 + " km" : nice + " m";
  }

  // ---- interaction: drag, wheel, pinch ----
  const pointers = new Map();
  let last = null,
    pinch = null,
    moved = 0;
  svg.addEventListener("pointerdown", (e) => {
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    moved = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: cam.s };
    }
    last = [e.clientX, e.clientY];
  });
  svg.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()],
        mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      zoomAt(mid[0], mid[1], (pinch.s * Math.hypot(a[0] - b[0], a[1] - b[1])) / pinch.d / cam.s);
      moved += 10;
      return;
    }
    if (last) {
      const dx = e.clientX - last[0],
        dy = e.clientY - last[1];
      moved += Math.abs(dx) + Math.abs(dy);
      cam.x -= dx / cam.s;
      cam.y += dy / cam.s;
      last = [e.clientX, e.clientY];
      render();
    }
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) last = null;
    else last = [...pointers.values()][0];
  };
  svg.addEventListener("pointerup", (e) => {
    const wasTap = moved < 6 && pointers.size === 1;
    end(e);
    if (wasTap) pinMode ? dropPin(e.clientX, e.clientY) : pick(e);
  });
  svg.addEventListener("pointercancel", end);
  svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );
  function zoomAt(sx, sy, f) {
    const { w } = size();
    const ns = Math.min(Math.max(cam.s * f, w / (R * 8)), 40);
    const [wx, wy] = toWorld(sx, sy);
    cam.s = ns;
    const [nx, ny] = toWorld(sx, sy);
    cam.x += wx - nx;
    cam.y += wy - ny;
    render();
  }
  document.getElementById("zin").onclick = () => {
    zoomAt(size().w / 2, midY(), 1.6);
  };
  document.getElementById("zout").onclick = () => {
    zoomAt(size().w / 2, midY(), 1 / 1.6);
  };
  document.getElementById("home").onclick = () => {
    fit();
    render();
  };
  window.addEventListener("resize", render);

  // ---- selection + info sheet ----
  const sheet = document.getElementById("sheet"),
    body = document.getElementById("sheetBody");
  document.getElementById("sheetClose").onclick = () => {
    sheet.classList.remove("open");
    layerSel.textContent = "";
  };
  const srcName = (src) =>
    (src || "").startsWith("open-buildings:google-v3") ? "Google Open Buildings (satellite-detected)" : null;
  const osmLink = (src) => {
    if (srcName(src)) return srcName(src);
    if ((src || "").startsWith("survey:")) return `your survey (${src.slice(7)})`;
    const m = /^osm:(way|node)\/(\d+)$/.exec(src || "");
    return m
      ? `<a href="https://www.openstreetmap.org/${m[1]}/${m[2]}" target="_blank" rel="noopener">OpenStreetMap ${m[1]} ${m[2]}</a>`
      : src || "";
  };
  const val = (a, fmt) =>
    a.value === null || a.value === undefined
      ? '<span class="unknown">Unknown &middot; needs survey</span>'
      : `<span class="known">${fmt ? fmt(a.value) : a.value}</span><div class="src">from ${osmLink(a.source)}</div>`;
  function pick(e) {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const mine = t && t.closest("[data-place-id]");
    if (mine) return openPlace({ id: mine.getAttribute("data-place-id") });
    const host = t && t.closest("[data-id]");
    if (!host) return;
    select(host.getAttribute("data-id"));
  }
  function select(id) {
    const item = byId[id];
    if (!item) return false;
    const f = item.f;
    layerSel.textContent = "";
    let html = "";
    if (item.type === "road") {
      el(
        "path",
        {
          d: item.d,
          fill: "none",
          stroke: "#1d6fd8",
          "stroke-width": 7,
          "stroke-opacity": 0.55,
          "stroke-linecap": "round",
          "vector-effect": "non-scaling-stroke",
          "pointer-events": "none",
        },
        layerSel,
      );
      html = `<h2>${f.name.value || "Unnamed " + f.class.toLowerCase()}</h2><div class="sub">${f.class} &middot; ${Math.round(len(f.parts))} m in this map</div><table>
  <tr><td>Road width</td><td>${val(f.width_m, (v) => v + " m")}</td></tr>
  <tr><td>Surface</td><td>${val(f.surface)}</td></tr>
  <tr><td>Drain</td><td>${val(f.drain)}</td></tr>
  <tr><td>Footpath</td><td>${val(f.footpath)}</td></tr>
  <tr><td>Lanes</td><td>${val(f.lanes)}</td></tr>
  <tr><td>One-way</td><td>${val(f.oneway)}</td></tr>
  <tr><td>Map source</td><td>${osmLink(f.source)}</td></tr>
  ${(f.notes || []).map((n) => `<tr><td>Your note</td><td><span class="known">${n.value}</span><div class="src">owner survey ${n.source.split("-").slice(1).join("-")}</div></td></tr>`).join("")}
  ${Object.entries(f.survey || {})
    .map(([k, v]) => `<tr><td>${k.replace(/_/g, " ")}</td><td>${val(v)}</td></tr>`)
    .join("")}</table>
  <div class="sv-actions"><button type="button" class="primary" id="btnSurveyRoad">${
    window.OpenworldSurvey && window.OpenworldSurvey.has(f.id) ? "Edit my survey" : "Survey this street"
  }</button></div>
  <div class="note">${
    f.width_m.value === null
      ? "Line thickness shows the road type only. Real width is drawn after it is surveyed."
      : `Drawn at its surveyed width: ${f.width_m.value} m.`
  }</div>`;
    } else if (item.type === "area") {
      el(
        "path",
        {
          d: pathD(f.points) + "Z",
          fill: "rgba(29,111,216,.18)",
          stroke: "#1d6fd8",
          "stroke-width": 2,
          "vector-effect": "non-scaling-stroke",
          "pointer-events": "none",
        },
        layerSel,
      );
      if (f.restricted) {
        html = `<h2>Restricted area</h2><div class="sub">${f.kind.replace(":", " &middot; ")}</div><table>
    <tr><td>Status</td><td><span class="unknown">${f.restricted.value}</span><div class="src">owner survey ${f.restricted.source.split("-").slice(1).join("-")}</div></td></tr>
    <tr><td>Map source</td><td>${osmLink(f.source)}</td></tr></table>
    <div class="note">Sensitive sites are never photographed or modelled. In the game this stays a walled, off-limits area.</div>`;
        body.innerHTML = html;
        sheet.classList.add("open");
        return true;
      }
      html = `<h2>${f.name.value || (f.kind === "building" ? (f.amenity ? f.amenity.replace(/_/g, " ") + " building" : "Building") : f.kind.split(":")[1])}</h2>
  <div class="sub">${f.kind.replace(":", " &middot; ")}</div><table>
  <tr><td>Floors</td><td>${val(f.levels)}</td></tr>
  ${f.area_m2 ? `<tr><td>Footprint</td><td>${Math.round(f.area_m2.value)} m&sup2;</td></tr>` : ""}
  ${f.confidence ? `<tr><td>Detection confidence</td><td>${Math.round(f.confidence.value * 100)}%${f.confidence.value < 0.75 ? ' <span class="unknown">&middot; please check</span>' : ""}</td></tr>` : ""}
  <tr><td>Map source</td><td>${osmLink(f.source)}</td></tr></table>
  ${f.confidence ? '<div class="note">Outline detected from satellite imagery by Google. Floors, height, walls and look come from your survey and photos.</div>' : ""}`;
    } else if (item.type === "poi") {
      html = `<h2>${(f.alias && f.alias.value) || f.name.value || f.kind.split(":")[1].replace(/_/g, " ")}</h2><div class="sub">${f.kind.replace(":", " &middot; ")}</div>
  <table>${f.note && f.note.value ? `<tr><td>Note</td><td>${val(f.note)}</td></tr>` : ""}<tr><td>Map source</td><td>${osmLink(f.source)}</td></tr></table>
  ${f.sacred ? '<div class="note">Place of worship: shown respectfully and never used in crime or violent scenes.</div>' : ""}`;
    }
    body.innerHTML = html;
    sheet.classList.add("open");
    const sb = document.getElementById("btnSurveyRoad");
    if (sb) sb.onclick = () => openSurvey(id);
    return true;
  }
  const roadLabel = (r) =>
    (r.name.value || `Unnamed ${r.class.toLowerCase()}`) + ` (${r.id.replace("road-", "#")})`;
  function openSurvey(id) {
    const r = byId[id].f;
    window.OpenworldSurvey.openForm(body, id, roadLabel(r), (result) => {
      select(id);
      if (result === "saved") {
        const n = document.querySelector("#sheet .note");
        if (n) n.insertAdjacentHTML("beforebegin", '<div class="sv-msg ok">Saved on this phone.</div>');
      }
    });
    sheet.classList.add("open");
    sheet.scrollTop = 0;
  }
  function openSurveyPanel() {
    layerSel.textContent = "";
    window.OpenworldSurvey.openPanel(
      body,
      (rid) => openSurvey(rid),
      (pid) => openPlace({ id: pid }),
    );
    sheet.classList.add("open");
  }
  // ---- pin a place: "+ Place" then tap the map ----
  let pinMode = false;
  const banner = document.getElementById("pinBanner");
  function setPinMode(on, msg) {
    pinMode = on;
    banner.classList.toggle("open", on);
    banner.querySelector("span").textContent = msg || "Tap the map where the place is";
    document.getElementById("btnAddPlace").classList.toggle("active", on);
  }
  document.getElementById("btnAddPlace").onclick = () => {
    sheet.classList.remove("open");
    layerSel.textContent = "";
    setPinMode(!pinMode);
  };
  document.getElementById("pinCancel").onclick = () => setPinMode(false);
  /** Drop a pin at screen point; refuses spots outside the map or inside restricted areas. */
  function dropPin(sx, sy) {
    const [x, y] = toWorld(sx, sy);
    if (Math.hypot(x, y) > R)
      return setPinMode(true, "That's outside the mapped area. Tap inside the circle.");
    if (restrictedZones.some((z) => inPoly(x, y, z)))
      return setPinMode(true, "That's a restricted area: places there are never mapped. Tap elsewhere.");
    setPinMode(false);
    const [lat, lon] = toLatLon(x, y);
    openPlace({ lat, lon });
  }
  function openPlace(place) {
    const S = window.OpenworldSurvey;
    const known = place.id ? S.places().find((p) => p.id === place.id) : null;
    const target = known ? { id: known.id, lat: known.lat, lon: known.lon } : place;
    layerSel.textContent = "";
    S.openPlaceForm(body, target, (result) => {
      render();
      if (result === "saved") {
        body.innerHTML =
          '<h2>Place saved</h2><div class="sv-msg ok">Saved on this phone.</div><div class="note">Tap + Place to pin another, or Survey to send everything to Claude.</div>';
      } else sheet.classList.remove("open");
    });
    sheet.classList.add("open");
    sheet.scrollTop = 0;
  }
  document.addEventListener("survey-changed", render);
  document.getElementById("btnSurvey").onclick = openSurveyPanel;
  const g = W.gaps;
  document.getElementById("btnGaps").onclick = () => {
    layerSel.textContent = "";
    const pct = (n) => Math.round((100 * n) / Math.max(g.roads_total, 1)) + "%";
    body.innerHTML = `<h2>What the map knows</h2><div class="sub">OpenStreetMap, ${W.meta.radius_m / 1000} km around the pin</div>
<div class="stat"><span>Road segments</span><b>${g.roads_total} (${(g.road_length_m / 1000).toFixed(1)} km)</b></div>
<div class="stat"><span>Without a name</span><b class="unknown">${g.roads_without_name} (${pct(g.roads_without_name)})</b></div>
<div class="stat"><span>Without width</span><b class="unknown">${g.roads_without_width} (${pct(g.roads_without_width)})</b></div>
<div class="stat"><span>Without surface</span><b class="unknown">${g.roads_without_surface} (${pct(g.roads_without_surface)})</b></div>
<div class="stat"><span>Drain known</span><b class="unknown">${g.roads_total - g.roads_without_drain}</b></div>
<div class="stat"><span>Footpath known</span><b class="unknown">${g.roads_total - g.roads_without_footpath}</b></div>
<div class="stat"><span>Roads surveyed</span><b class="${g.roads_surveyed ? "known" : "unknown"}">${g.roads_surveyed || 0}</b></div>
<div class="stat"><span>Buildings mapped</span><b class="known">${g.buildings_mapped}</b></div>
<div class="stat"><span>Buildings to double-check</span><b class="unknown">${g.buildings_low_confidence || 0}</b></div>
<div class="stat"><span>Buildings with floors known</span><b class="unknown">${g.buildings_mapped - g.buildings_without_levels}</b></div>
<div class="note">Nothing on this map is guessed. Orange values are unknown and become the street survey checklist.</div>`;
    sheet.classList.add("open");
  };
  const sw = (stroke, w, dash) =>
    `<svg width="34" height="12"><line x1="2" y1="6" x2="32" y2="6" stroke="${stroke}" stroke-width="${w}" stroke-dasharray="${dash || ""}" stroke-linecap="round"/></svg>`;
  document.getElementById("btnLegend").onclick = () => {
    layerSel.textContent = "";
    body.innerHTML = `<h2>Legend</h2><div class="sub">Tap any road or place for details</div>
<div class="legend-row">${sw("#d6604d", 5)}Main road</div>
<div class="legend-row">${sw("#e3a13b", 3.6)}Secondary / connector road</div>
<div class="legend-row">${sw("#5b6169", 2.2)}Colony lane</div>
<div class="legend-row">${sw("#9aa0a6", 1.4)}Service lane</div>
<div class="legend-row">${sw("#9a7b4f", 1.4, "5 4")}Track / path</div>
<div class="legend-row">${sw("#3b82c4", 1.8)}Drain (open water channel)</div>
<div class="legend-row">${sw("#8a5cc2", 1.2, "7 4")}Power line &middot; <svg width="10" height="10"><rect x="2" y="2" width="6" height="6" fill="#8a5cc2"/></svg> tower</div>
<div class="legend-row"><svg width="34" height="14"><rect x="6" y="1" width="22" height="12" fill="#c9b8a6" stroke="#9c8670"/></svg>Building (satellite-detected)</div>
<div class="legend-row"><svg width="34" height="14"><rect x="6" y="1" width="22" height="12" fill="#e3d8cb" stroke="#9c8670" stroke-dasharray="2 2"/></svg>Building, lower confidence: please check</div>
<div class="legend-row"><svg width="34" height="14"><circle cx="17" cy="7" r="5" fill="#1d6fd8" stroke="#fff" stroke-width="2"/></svg>Place (hospital, theatre...)</div>
<div class="legend-row">${sw("#1d6fd8", 2, "1 5")}Road you described (owner note)</div>
<div class="legend-row">${sw("#15803d", 4)}Street you surveyed (not sent yet)</div>
<div class="legend-row"><svg width="34" height="16"><path d="M17 15c-5 -7 -8 -10 -8 -14a8 8 0 0 1 16 0c0 4 -3 7 -8 14z" transform="translate(0 -1)" fill="#15803d" stroke="#fff" stroke-width="1.5"/></svg>Place you pinned (not sent yet)</div>
<div class="legend-row"><svg width="34" height="14"><rect x="6" y="1" width="22" height="12" fill="#efe3e3" stroke="#b45454"/><line x1="8" y1="13" x2="20" y2="1" stroke="#c98b8b" stroke-width="3"/></svg>Restricted area (never modelled)</div>
<div class="legend-row"><svg width="34" height="14"><circle cx="17" cy="7" r="6" fill="none" stroke="#8b8577" stroke-dasharray="4 3"/></svg>1 km radius around the pin</div>
<div class="note">Line thickness shows road type, not real width. Widths, drains and footpaths are drawn only once surveyed.</div>`;
    sheet.classList.add("open");
  };

  fit();
  render();
  drawMySurvey();
  window.__TEST__ = {
    ready: true,
    counts: {
      roads: W.roads.length,
      areas: W.areas.length,
      lines: W.lines.length,
      pois: W.pois.length,
    },
    select,
    openSurvey,
    openSurveyPanel,
    dropPinAtWorld: (x, y) => {
      const [sx, sy] = toScreen(x, y);
      dropPin(sx, sy);
    },
    pinMode: () => pinMode,
    camera: () => ({ ...cam }),
    gaps: g,
  };
})();
