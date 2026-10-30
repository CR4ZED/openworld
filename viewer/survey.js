/* Street survey form for the 2D map. Inlined into the page by tools/build_viewer.py.
 *
 * Fields come from data/survey/street_survey_schema.json (shared with the importer), so the
 * form and tools/build_world.py always agree. Entries are kept in this browser only
 * (localStorage) until the owner copies them and sends them to Claude.
 */
(() => {
  const SCHEMA = JSON.parse(document.getElementById("survey-schema").textContent);
  const KEY = "openworld.street-survey.v1";
  const FIELDS = SCHEMA.fields;

  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const today = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  // In-memory copy is the source of truth for this page; storage is a best-effort mirror.
  let state = { streets: {}, places: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && saved.streets && typeof saved.streets === "object") state = saved;
    if (!state.places || typeof state.places !== "object") state.places = {};
  } catch {
    /* storage unavailable: keep working in memory */
  }
  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable or full: data stays in memory for this visit */
    }
    document.dispatchEvent(new CustomEvent("survey-changed"));
  };

  function fieldHtml(fd, value) {
    const id = `sv-${fd.key}`;
    const help = fd.help ? `<div class="sv-help">${esc(fd.help)}</div>` : "";
    let input;
    if (fd.type === "choice") {
      const opts = [`<option value="">Not sure / skip</option>`]
        .concat(
          fd.options.map(
            (o) => `<option value="${esc(o)}"${o === value ? " selected" : ""}>${esc(o)}</option>`,
          ),
        )
        .join("");
      input = `<select id="${id}" data-key="${fd.key}">${opts}</select>`;
    } else if (fd.type === "number" || fd.type === "integer") {
      const step = fd.type === "integer" ? 1 : fd.step || "any";
      const mode = fd.type === "integer" ? "numeric" : "decimal";
      input = `<input id="${id}" data-key="${fd.key}" type="number" inputmode="${mode}" min="${fd.min}" max="${fd.max}" step="${step}" value="${value ?? ""}" placeholder="${fd.min}–${fd.max}">`;
    } else {
      input = `<textarea id="${id}" data-key="${fd.key}" maxlength="${fd.max_length}" rows="2">${esc(value ?? "")}</textarea>`;
    }
    return `<label class="sv-field" for="${id}"><span>${esc(fd.label)}</span>${help}${input}<div class="sv-err" data-err="${fd.key}"></div></label>`;
  }

  function readForm(root, fields = FIELDS) {
    const entry = {};
    const errors = {};
    for (const fd of fields) {
      const elx = root.querySelector(`[data-key="${fd.key}"]`);
      const raw = elx.value.trim();
      if (raw === "") {
        if (fd.required) errors[fd.key] = "Please choose one";
        continue;
      }
      if (fd.type === "number" || fd.type === "integer") {
        const n = Number(raw);
        const okType = fd.type === "integer" ? Number.isInteger(n) : Number.isFinite(n);
        if (!okType || n < fd.min || n > fd.max) {
          errors[fd.key] =
            `Enter ${fd.type === "integer" ? "a whole number" : "a number"} from ${fd.min} to ${fd.max}`;
          continue;
        }
        entry[fd.key] = n;
      } else {
        entry[fd.key] = raw;
      }
    }
    return { entry, errors };
  }

  const PLACE_FIELDS = SCHEMA.place_fields.map((fd) =>
    fd.options_from ? { ...fd, options: SCHEMA[fd.options_from] } : fd,
  );
  const newPlaceId = () => `p-${Date.now().toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`;

  /** Clear a field's error as soon as the person changes it. */
  function clearErrorsOnInput(form) {
    form.addEventListener("input", (e) => {
      const key = e.target.dataset && e.target.dataset.key;
      if (!key) return;
      e.target.classList.remove("invalid");
      const err = form.querySelector(`[data-err="${key}"]`);
      if (err) err.textContent = "";
      if (!form.querySelector(".invalid")) form.querySelector(".sv-msg").textContent = "";
    });
  }

  const Survey = {
    count: () => Object.keys(state.streets).length + Object.keys(state.places).length,
    streetCount: () => Object.keys(state.streets).length,
    places: () => Object.entries(state.places).map(([id, p]) => ({ id, ...p })),
    isSacred: (type) => SCHEMA.sacred_place_types.includes(type),
    has: (roadId) => Boolean(state.streets[roadId]),
    ids: () => Object.keys(state.streets),

    /** Render the form for one road into `container`. `label` names the road for the heading. */
    openForm(container, roadId, label, onDone) {
      const cur = (state.streets[roadId] || {}).entry || {};
      container.innerHTML = `<h2>Survey: ${esc(label)}</h2>
        <div class="sub">Fill what you know. Leave anything you're unsure about as "Not sure".</div>
        <form id="sv-form" novalidate>${FIELDS.map((fd) => fieldHtml(fd, cur[fd.key])).join("")}
          <div class="sv-actions"><button type="submit" class="primary" id="sv-save">Save</button>
          <button type="button" id="sv-cancel">Cancel</button>
          ${state.streets[roadId] ? '<button type="button" id="sv-delete" class="danger">Delete</button>' : ""}</div>
          <div class="sv-msg" id="sv-msg"></div>
        </form>`;
      const form = container.querySelector("#sv-form");
      clearErrorsOnInput(form);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const { entry, errors } = readForm(form);
        form.querySelectorAll("[data-err]").forEach((d) => (d.textContent = errors[d.dataset.err] || ""));
        const msg = form.querySelector("#sv-msg");
        form
          .querySelectorAll("[data-key]")
          .forEach((i) => i.classList.toggle("invalid", i.dataset.key in errors));
        if (Object.keys(errors).length) {
          msg.textContent = "Please fix the highlighted fields.";
          const first = form.querySelector(".invalid");
          first.scrollIntoView({ block: "center" });
          first.focus();
          return;
        }
        if (!Object.keys(entry).length) {
          msg.textContent = "Nothing filled in yet.";
          return;
        }
        state.streets[roadId] = { label, entry, saved: today() };
        persist();
        onDone && onDone("saved");
      });
      container.querySelector("#sv-cancel").onclick = () => onDone && onDone("cancel");
      const del = container.querySelector("#sv-delete");
      if (del)
        del.onclick = () => {
          delete state.streets[roadId];
          persist();
          onDone && onDone("deleted");
        };
    },

    /** Form for a place pinned on the map. `place` = {id?, lat, lon}. */
    openPlaceForm(container, place, onDone) {
      const id = place.id || newPlaceId();
      const cur = state.places[id] || {};
      container.innerHTML = `<h2>${cur.type ? "Edit place" : "New place"}</h2>
        <div class="sub">Pinned at ${place.lat.toFixed(6)}, ${place.lon.toFixed(6)}</div>
        <form id="pl-form" novalidate>${PLACE_FIELDS.map((fd) => fieldHtml(fd, cur[fd.key])).join("")}
          <div class="sv-actions"><button type="submit" class="primary" id="pl-save">Save place</button>
          <button type="button" id="pl-cancel">Cancel</button>
          ${state.places[id] ? '<button type="button" id="pl-delete" class="danger">Delete</button>' : ""}</div>
          <div class="sv-msg" id="pl-msg"></div>
        </form>`;
      const form = container.querySelector("#pl-form");
      clearErrorsOnInput(form);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const { entry, errors } = readForm(form, PLACE_FIELDS);
        form.querySelectorAll("[data-err]").forEach((d) => (d.textContent = errors[d.dataset.err] || ""));
        form
          .querySelectorAll("[data-key]")
          .forEach((i) => i.classList.toggle("invalid", i.dataset.key in errors));
        if (Object.keys(errors).length) {
          form.querySelector("#pl-msg").textContent = "Please choose what is here.";
          form.querySelector(".invalid").focus();
          return;
        }
        state.places[id] = {
          ...entry,
          lat: Math.round(place.lat * 1e7) / 1e7,
          lon: Math.round(place.lon * 1e7) / 1e7,
          saved: today(),
        };
        persist();
        onDone && onDone("saved", id);
      });
      container.querySelector("#pl-cancel").onclick = () => onDone && onDone("cancel", id);
      const del = container.querySelector("#pl-delete");
      if (del)
        del.onclick = () => {
          delete state.places[id];
          persist();
          onDone && onDone("deleted", id);
        };
    },

    /** The JSON the importer accepts (tools/build_world.py --street-survey). */
    exportJson(surveyor = "owner") {
      const streets = {};
      for (const [rid, s] of Object.entries(state.streets)) streets[rid] = s.entry;
      const places = Object.entries(state.places).map(([id, p]) => {
        const out = { id, lat: p.lat, lon: p.lon };
        for (const fd of PLACE_FIELDS) if (p[fd.key] !== undefined) out[fd.key] = p[fd.key];
        return out;
      });
      const doc = { format: SCHEMA.format, surveyor, date: today(), streets };
      if (places.length) doc.places = places;
      return JSON.stringify(doc, null, 2);
    },

    /** Panel listing saved streets with a Copy button. `onEdit(roadId)` opens a street. */
    openPanel(container, onEdit, onEditPlace) {
      const n = Survey.count();
      const ns = Survey.streetCount(),
        np = n - ns;
      const rows = Object.entries(state.streets)
        .map(
          ([rid, s]) =>
            `<div class="stat"><button type="button" class="link" data-edit="${esc(rid)}">${esc(s.label)}</button><span>${Object.keys(s.entry).length} fields</span></div>`,
        )
        .join("");
      const placeRows = Object.entries(state.places)
        .map(
          ([pid, p]) =>
            `<div class="stat"><button type="button" class="link" data-edit-place="${esc(pid)}">${esc(p.name || p.type)}</button><span>${esc(p.type)}</span></div>`,
        )
        .join("");
      const parts = [];
      if (ns) parts.push(`${ns} street${ns > 1 ? "s" : ""}`);
      if (np) parts.push(`${np} place${np > 1 ? "s" : ""}`);
      container.innerHTML = `<h2>My survey</h2>
        <div class="sub">${n ? `${parts.join(" and ")} saved on this phone` : "Nothing yet. Tap a road and choose Survey this street, or tap + Place to pin a temple, shop or other place."}</div>
        ${rows}${placeRows}
        ${
          n
            ? `<div class="sv-actions"><button type="button" class="primary" id="sv-copy">Copy for Claude</button>
               <button type="button" id="sv-clear" class="danger">Clear all</button></div>
               <div class="sv-msg" id="sv-msg"></div>
               <textarea id="sv-out" readonly rows="6">${esc(Survey.exportJson())}</textarea>
               <div class="note">Copy, then paste it into the chat with Claude. Saved only on this phone until you send it.</div>`
            : ""
        }`;
      container.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => onEdit(b.dataset.edit)));
      container
        .querySelectorAll("[data-edit-place]")
        .forEach((b) => (b.onclick = () => onEditPlace && onEditPlace(b.dataset.editPlace)));
      const copy = container.querySelector("#sv-copy");
      if (copy)
        copy.onclick = async () => {
          const out = container.querySelector("#sv-out");
          const msg = container.querySelector("#sv-msg");
          try {
            await navigator.clipboard.writeText(out.value);
            msg.textContent = "Copied. Paste it into the chat.";
          } catch {
            out.focus();
            out.select();
            msg.textContent = "Couldn't copy automatically: the text is selected, copy it from the box.";
          }
        };
      const clear = container.querySelector("#sv-clear");
      if (clear)
        clear.onclick = () => {
          if (clear.dataset.armed) {
            state = { streets: {}, places: {} };
            persist();
            Survey.openPanel(container, onEdit, onEditPlace);
          } else {
            clear.dataset.armed = "1";
            clear.textContent = "Tap again to delete all";
          }
        };
    },
  };

  window.OpenworldSurvey = Survey;
})();
