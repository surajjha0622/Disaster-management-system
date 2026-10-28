/* Disaster management system dashboard — vanilla JS, no build step. */
(() => {
const API = location.protocol === "file:" ? "http://127.0.0.1:8000" : "";
const WS_URL = (API ? API.replace("http", "ws") : (location.protocol === "https:" ? "wss://" : "ws://") + location.host) + "/ws";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const LEVELS = ["LOW", "GUARDED", "ELEVATED", "HIGH"];
const LV_NAME = { LOW: "Low", GUARDED: "Guarded", ELEVATED: "Elevated", HIGH: "High" };
const COLORS = { LOW: "#3fd6a0", GUARDED: "#f1c04f", ELEVATED: "#ff8b3d", HIGH: "#ff3b6b" };
const AUDIO = { rain_like: "Rain", flowing_water: "Flowing water", wind_noise: "Wind", background: "Background", unknown: "Unknown" };
const RIVER_OF = { "FG-JSM-07>FG-CHM-01": "Alaknanda", "FG-CHM-01>FG-RUD-02": "Alaknanda", "FG-RUD-02>FG-PAU-04": "Alaknanda", "FG-PAU-04>FG-DEV-08": "Alaknanda", "FG-UTK-03>FG-TEH-05": "Bhagirathi", "FG-TEH-05>FG-DEV-08": "Bhagirathi", "FG-DEV-08>FG-RSK-09": "Ganga", "FG-RSK-09>FG-HWR-10": "Ganga" };
const LEFT = new Set(["FG-UTK-03", "FG-TEH-05", "FG-DEV-08", "FG-RSK-09", "FG-HWR-10"]);
const ORDER = ["FG-UTK-03", "FG-TEH-05", "FG-JSM-07", "FG-CHM-01", "FG-RUD-02", "FG-PAU-04", "FG-DEV-08", "FG-RSK-09", "FG-HWR-10", "FG-UDH-06"];

let CFG, S = null, lastRx = performance.now(), selected = null, selectedZone = null, rtab = "alerts";
let map, districtLayer, tileLayer, nodeMarkers = {}, assetMarkers = {}, etaMarkers = {}, frontLayers = {}, edgePaths = {}, riverLines = {};
let chart, seenAlerts = null, sigAlerts = null, sigFeed = null, distStyle = {}, sound = false, audioCtx = null;
const short = (n) => n.replace(" Station", "");
const fmtEta = (m) => { m = Math.max(0, Math.round(m)); const h = Math.floor(m / 60), r = m % 60; return h ? `${h}h ${String(r).padStart(2, "0")}m` : `${r}m`; };
const post = (url, body) => fetch(API + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).catch(() => {});
const lvIdx = (l) => LEVELS.indexOf(l);

/* ------------------------------------------------------------ geometry */
function hash(s) { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function meander(a, b, key, n = 28, amp = 0.09) {
  const dy = b[0] - a[0], dx = b[1] - a[1], len = Math.hypot(dx, dy) || 1, ny = dx / len, nx = -dy / len;
  const seed = hash(key), ph = (seed % 628) / 100, k = 2 + (seed % 3), pts = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n, off = Math.sin(Math.PI * s) * amp * len * Math.sin(2 * Math.PI * k * s + ph);
    pts.push([a[0] + dy * s + ny * off, a[1] + dx * s + nx * off]);
  }
  return pts;
}
function cum(path) { const c = [0]; for (let i = 1; i < path.length; i++) c.push(c[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])); return c; }
function along(path, c, f) { // returns {pt, sub}
  const tot = c[c.length - 1], d = Math.max(0, Math.min(1, f)) * tot; let i = 1;
  while (i < c.length - 1 && c[i] < d) i++;
  const t = (d - c[i - 1]) / ((c[i] - c[i - 1]) || 1), a = path[i - 1], b = path[i];
  const pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { pt, sub: path.slice(0, i).concat([pt]) };
}

/* ------------------------------------------------------------ map */
function initMap() {
  map = L.map("map", { zoomControl: false, zoomSnap: 0.25, minZoom: 7, attributionControl: true });
  map.attributionControl.setPrefix(false); L.control.zoom({ position: "bottomright" }).addTo(map);
  map.fitBounds([[28.85, 77.75], [31.1, 80.35]], { paddingTopLeft: [0, 30] });
  map.setMaxBounds([[27.6, 76.0], [32.4, 82.6]]);
  fetch("data/districts.json").then((r) => r.json()).then((gj) => {
    districtLayer = L.geoJSON(gj, {
      style: () => ({ color: "#2a4f5b", weight: 1, fillColor: "#12262d", fillOpacity: 1 }),
      onEachFeature: (f, l) => { l.bindTooltip(f.properties.name.replace("Dehra Dun", "Dehradun").replace("Rudra Prayag", "Rudraprayag").replace("Naini Tal", "Nainital"), { sticky: true, className: "dname", direction: "top" }); l.feature.properties._layer = l; },
    }).addTo(map);
    districtLayer.bringToBack();
    if (S) updateDistricts();
  }).catch(() => {});
  tileLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png", { subdomains: "abcd", attribution: "© OpenStreetMap contributors © CARTO", maxZoom: 14 });
  $("#tiles").addEventListener("change", (e) => {
    if (e.target.checked) { tileLayer.addTo(map); tileLayer.bringToBack(); } else map.removeLayer(tileLayer);
    distStyle = {}; updateDistricts(true);
  });

  // rivers
  const st = CFG.stations;
  CFG.edges.forEach((e) => {
    const a = [st[e.frm].lat, st[e.frm].lon], b = [st[e.to].lat, st[e.to].lon], key = e.frm + ">" + e.to;
    const path = meander(a, b, key); edgePaths[key] = { path, c: cum(path) };
    const base = L.polyline(path, { className: "river", weight: 3 }).addTo(map).bindTooltip(RIVER_OF[key] || "River", { sticky: true, className: "dname" });
    const flow = L.polyline(path, { className: "river-flow", weight: 2 }).addTo(map);
    riverLines[key] = { base, flow, to: e.to };
  });
  Object.entries(CFG.headwaters).forEach(([name, pts]) => {
    const full = []; for (let i = 0; i < pts.length - 1; i++) full.push(...meander(pts[i], pts[i + 1], name + i, 14, 0.08));
    L.polyline(full, { className: "river", weight: 2 }).addTo(map).bindTooltip(name.split(" ")[0], { sticky: true, className: "dname" });
    L.polyline(full, { className: "river-flow", weight: 1.6 }).addTo(map);
  });
  [["Alaknanda", "FG-JSM-07>FG-CHM-01", 0.3, "top", [0, -4]], ["Bhagirathi", "FG-UTK-03>FG-TEH-05", 0.5, "right", [8, 12]], ["Ganga", "FG-RSK-09>FG-HWR-10", 0.5, "right", [8, 12]]].forEach(([n, k, f, dir, off]) => {
    const p = edgePaths[k]; const m = along(p.path, p.c, f).pt;
    L.marker(m, { interactive: false, icon: L.divIcon({ className: "", html: "", iconSize: [0, 0] }) }).addTo(map).bindTooltip(n, { permanent: true, direction: dir, offset: off, className: "rname" });
  });

  // stations
  Object.entries(st).forEach(([id, s]) => {
    const m = L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "", html: `<div class="node${LEFT.has(id) ? " l" : ""}" data-lv="LOW"><i class="ring"></i><i class="core"></i><span class="nm">${short(s.name)}</span></div>`, iconSize: [34, 34], iconAnchor: [17, 17] }), riseOnHover: true, keyboard: true, title: s.name }).addTo(map);
    m.on("click", () => selectNode(id));
    nodeMarkers[id] = m;
  });

  // The primary river stations above have live simulation data. Additional
  // zone sensors and sirens show the distributed field equipment footprint.
  Object.values(CFG.zone_assets || {}).forEach((zone) => {
    zone.sensors.filter((node) => !node.station_id).forEach((node) => {
      const m = L.marker([node.lat, node.lon], {
        icon: L.divIcon({ className: "", html: `<div class="field-node sensor-node" title="${node.name}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] }),
        keyboard: true, title: node.name,
      }).addTo(map);
      m.on("click", () => focusZone(zone.id, "health"));
      assetMarkers[node.id] = m;
    });
    zone.sirens.forEach((node) => {
      const m = L.marker([node.lat, node.lon], {
        icon: L.divIcon({ className: "", html: `<div class="field-node siren-node" title="${node.name}"><i></i></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
        keyboard: true, title: node.name,
      }).addTo(map);
      m.on("click", () => focusZone(zone.id, "sirens"));
      assetMarkers[node.id] = m;
    });
  });
}

function updateDistricts(force) {
  if (!districtLayer || !S) return;
  const risk = {};
  S.stations.forEach((s) => { const l = s.reading ? lvIdx(s.reading.risk_label) : 0; risk[s.district] = Math.max(risk[s.district] ?? 0, l); });
  const tiles = $("#tiles").checked;
  districtLayer.eachLayer((l) => {
    const name = l.feature.properties.name, r = risk[name] ?? -1, key = r + (tiles ? "t" : "");
    if (!force && distStyle[name] === key) return; distStyle[name] = key;
    const lv = r < 0 ? null : LEVELS[r];
    const fill = lv === null ? "#12262d" : lv === "LOW" ? "#123129" : lv === "GUARDED" ? "#3a3314" : lv === "ELEVATED" ? "#4d2c14" : "#5a1426";
    l.setStyle({ fillColor: fill, fillOpacity: tiles ? 0.55 : 1, color: lv === "HIGH" ? "#ff3b6b" : lv === "ELEVATED" ? "#ff8b3d" : "#2a4f5b", weight: lv === "HIGH" ? 1.8 : 1 });
  });
}

/* ------------------------------------------------------------ rendering */
function render(state) {
  const first = !S; S = state; lastRx = performance.now();
  $("#simClock").textContent = S.sim_clock;
  $("#speedTag").textContent = "×" + S.speed + (S.running ? "" : " paused");
  $("#pauseBtn").textContent = S.running ? "Pause" : "Resume";
  $$("#speedSeg button").forEach((b) => b.classList.toggle("on", +b.dataset.s === Math.round(S.speed)));
  $$("#scnGrid button").forEach((b) => b.classList.toggle("on", b.dataset.scn === S.scenario.name));

  const act = S.events.filter((e) => e.kind === "alert" && !e.resolved);
  const unacked = act.filter((e) => !e.acknowledged);
  const rdgs = S.stations.filter((s) => s.reading);
  const top = rdgs.reduce((a, s) => (!a || s.reading.risk_score > a.reading.risk_score ? s : a), null);
  $("#stNodes").textContent = `${rdgs.length} / ${S.stations.length}`;
  $("#stPeak").textContent = top ? top.reading.risk_score : "–";
  $("#stPeakSub").textContent = top ? `highest score, ${short(top.name)}` : "highest score";
  $("#stAlerts").textContent = act.length;
  $("#stPackets").textContent = S.gateway.received_packets.toLocaleString();
  const b = $("#badgeAlerts"); b.hidden = !unacked.length; b.textContent = unacked.length;

  renderNodes(); renderZoneSummary(); renderMapNodes(); renderAssetNodes(); updateDistricts(); renderAlarm(unacked); renderAlerts(); renderHealthPanel(); renderSirensPanel(); renderFeed(); renderNodePanel();
  detectNewAlert(first);
}

function renderNodes() {
  const ul = $("#nodeList");
  if (!ul.children.length) {
    ul.innerHTML = ORDER.map((id) => { const s = S.stations.find((x) => x.station_id === id); return `<li data-id="${id}" data-lv="LOW" tabindex="0"><i class="dot"></i><span class="nm">${short(s.name)}<small>${s.district.replace("Dehra Dun", "Dehradun").replace("Rudra Prayag", "Rudraprayag")}</small></span><span class="sc">–</span><svg viewBox="0 0 54 18" preserveAspectRatio="none"><polyline points=""/></svg></li>`; }).join("");
    ul.addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) selectNode(li.dataset.id, true); });
    ul.addEventListener("keydown", (e) => { if (e.key === "Enter") { const li = e.target.closest("li"); if (li) selectNode(li.dataset.id, true); } });
  }
  S.stations.forEach((s) => {
    const li = ul.querySelector(`[data-id="${s.station_id}"]`); if (!li || !s.reading) return;
    li.dataset.lv = s.reading.risk_label; li.classList.toggle("sel", s.station_id === selected);
    li.querySelector(".sc").textContent = s.reading.risk_score;
    const r = s.hist.risk.slice(-36); if (r.length > 1) li.querySelector("polyline").setAttribute("points", r.map((v, i) => `${(i / (r.length - 1) * 54).toFixed(1)},${(17 - v / 100 * 16).toFixed(1)}`).join(" "));
  });
}

function zoneRisk(zone) {
  return zone.sensor_nodes.reduce((highest, node) => Math.max(highest, lvIdx(node.risk_label || "LOW")), 0);
}

function renderZoneSummary() {
  const box = $("#zoneSummary");
  if (!box || !S?.zones) return;
  box.innerHTML = S.zones.map((zone) => {
    const active = zone.siren_state.active;
    const level = LEVELS[zoneRisk(zone)];
    return `<button class="zone-row ${selectedZone === zone.id ? "selected" : ""}" data-zone="${zone.id}" data-lv="${level}">
      <span class="zone-dot"></span><span class="zone-name">${zone.name}<small>${zone.sensor_online} sensors · ${zone.siren_online} sirens</small></span>
      <span class="zone-state ${active ? "active" : ""}">${active ? "Siren active" : "Armed"}</span>
    </button>`;
  }).join("");
}

function renderHealthPanel() {
  const box = $("#rt-health");
  if (!box || !S?.zones) return;
  const zones = selectedZone ? [...S.zones].sort((a, b) => (a.id === selectedZone ? -1 : b.id === selectedZone ? 1 : 0)) : S.zones;
  box.innerHTML = `<div class="panel-intro"><p class="eyebrow">Field network</p><h2>Node health</h2><p>Every zone has several sensor and siren nodes. Statuses below are simulation states.</p></div>${zones.map((zone) => {
    const active = zone.siren_state.active;
    return `<article class="health-zone ${selectedZone === zone.id ? "focused" : ""}">
      <div class="health-head"><div><h3>${zone.name}</h3><p>${zone.description}</p></div><span class="health-badge">${zone.sensor_online + zone.siren_online} online</span></div>
      <div class="health-group"><div class="group-label"><span>Sensor nodes</span><b>${zone.sensor_online}/${zone.sensor_nodes.length}</b></div>
        ${zone.sensor_nodes.map((node) => `<div class="health-node"><i class="health-dot" data-lv="${node.risk_label}"></i><span>${node.name}<small>${node.id} · ${node.source}</small></span><em>${node.status}</em></div>`).join("")}
      </div>
      <div class="health-group"><div class="group-label"><span>Siren nodes</span><b>${zone.siren_online}/${zone.siren_nodes.length}</b></div>
        ${zone.siren_nodes.map((node) => `<div class="health-node"><i class="health-dot siren-dot ${node.active ? "active" : ""}"></i><span>${node.name}<small>${node.id}</small></span><em class="${node.active ? "active-text" : ""}">${node.status}</em></div>`).join("")}
      </div>
      <button class="subtle-btn" data-open-sirens="${zone.id}">${active ? "Review active sirens" : "Open siren control"}</button>
    </article>`;
  }).join("")}`;
}

function renderSirensPanel() {
  const box = $("#rt-sirens");
  if (!box || !S?.zones) return;
  const zones = selectedZone ? [...S.zones].sort((a, b) => (a.id === selectedZone ? -1 : b.id === selectedZone ? 1 : 0)) : S.zones;
  box.innerHTML = `<div class="panel-intro"><p class="eyebrow">Operator control</p><h2>Zone sirens</h2><p>Controls address every siren node in the selected zone. They change the simulation only.</p></div>${zones.map((zone) => {
    const active = zone.siren_state.active;
    return `<article class="siren-zone ${active ? "is-active" : ""} ${selectedZone === zone.id ? "focused" : ""}">
      <div class="health-head"><div><h3>${zone.name}</h3><p>${zone.siren_nodes.length} siren nodes across the zone</p></div><span class="siren-state ${active ? "active" : ""}">${active ? "Active" : "Armed"}</span></div>
      <div class="siren-node-list">${zone.siren_nodes.map((node) => `<span><i class="siren-dot ${node.active ? "active" : ""}"></i>${node.name}</span>`).join("")}</div>
      <div class="siren-actions">
        <button class="siren-btn activate" data-siren-action="activate" data-zone="${zone.id}" ${active ? "disabled" : ""}>Activate all sirens</button>
        <button class="siren-btn silence" data-siren-action="silence" data-zone="${zone.id}" ${active ? "" : "disabled"}>Silence zone</button>
      </div>
      <small class="siren-note">Last state: ${zone.siren_state.last_action}</small>
    </article>`;
  }).join("")}`;
}

function renderMapNodes() {
  S.stations.forEach((s) => {
    const el = nodeMarkers[s.station_id]?.getElement(); if (!el || !s.reading) return;
    const n = el.querySelector(".node"); n.dataset.lv = s.reading.risk_label; n.classList.toggle("sel", s.station_id === selected); n.classList.toggle("ext", !!s.external);
  });
  // river swell by downstream stage
  const lvl = {}; S.stations.forEach((s) => { if (s.reading) lvl[s.station_id] = s.reading.water_level_cm; });
  Object.values(riverLines).forEach((r) => { const w = 2.5 + Math.min(5, (lvl[r.to] || 0) / 45); r.base.setStyle({ weight: w }); r.flow.setStyle({ weight: Math.max(1.5, w - 1) }); });
}

function renderAssetNodes() {
  (S.zones || []).forEach((zone) => {
    zone.siren_nodes.forEach((siren) => {
      const el = assetMarkers[siren.id]?.getElement();
      const icon = el?.querySelector(".siren-node");
      if (icon) icon.classList.toggle("active", !!siren.active);
    });
  });
}

function tickFloat() { return S.tick + (S.running ? Math.min(0.98, (performance.now() - lastRx) * S.speed / 1000) : 0); }
function animateFronts() {
  if (S && map) {
    const tf = tickFloat(), live = new Set(), etaNow = {};
    S.fronts.forEach((f) => {
      const key = `${f.alert}|${f.frm}|${f.to}`, e = edgePaths[f.frm + ">" + f.to]; if (!e) return;
      live.add(key);
      const p = (tf - f.t0) / Math.max(1, f.t1 - f.t0);
      if (p > 0) {
        const { pt, sub } = along(e.path, e.c, p);
        let fl = frontLayers[key];
        if (!fl) fl = frontLayers[key] = { line: L.polyline(sub, { className: "front-line", weight: 5 }).addTo(map), head: L.circleMarker(pt, { radius: 7, color: "#fff", weight: 2, fillColor: "#ff3b6b", fillOpacity: 1, className: "front-head", interactive: false }).addTo(map) };
        fl.line.setLatLngs(sub); fl.head.setLatLng(pt);
        const arrived = p >= 1; fl.head.setStyle({ opacity: arrived ? 0 : 1, fillOpacity: arrived ? 0 : 1 });
      }
      const eta = (f.t1 - tf) * S.tick_sim_min;
      if (etaNow[f.to] === undefined || eta < etaNow[f.to]) etaNow[f.to] = eta;
    });
    Object.keys(frontLayers).forEach((k) => { if (!live.has(k)) { map.removeLayer(frontLayers[k].line); map.removeLayer(frontLayers[k].head); delete frontLayers[k]; } });
    Object.entries(etaNow).forEach(([id, eta]) => {
      const st = CFG.stations[id]; let m = etaMarkers[id];
      const txt = eta <= 0 ? "Wave arriving" : "Wave in " + fmtEta(eta);
      if (!m) m = etaMarkers[id] = L.marker([st.lat, st.lon], { interactive: false, zIndexOffset: 900, icon: L.divIcon({ className: "", html: `<div class="eta${LEFT.has(id) ? " l" : ""}">${txt}</div>`, iconSize: [0, 0], iconAnchor: [0, 0] }) }).addTo(map);
      const el = m.getElement()?.firstChild; if (el && el.textContent !== txt) { el.textContent = txt; el.classList.toggle("now", eta <= 0); }
    });
    Object.keys(etaMarkers).forEach((id) => { if (etaNow[id] === undefined) { map.removeLayer(etaMarkers[id]); delete etaMarkers[id]; } });
  }
  requestAnimationFrame(animateFronts);
}

function renderAlarm(unacked) {
  const el = $("#alarm"); if (!unacked.length) { el.hidden = true; return; }
  const tf = S.tick; let next = null;
  unacked.forEach((a) => (a.downstream || []).forEach((d) => { const eta = a.tick * S.tick_sim_min + d.eta_min - S.tick * S.tick_sim_min; if (eta > 0 && (!next || eta < next.eta)) next = { eta, name: short(d.name) }; }));
  const a = unacked[unacked.length - 1];
  el.innerHTML = `<b>High flood risk at ${short(a.station_name)}.</b> ${next ? `Next arrival: ${next.name} in ${fmtEta(next.eta)}.` : "Downstream nodes have been reached."} ${unacked.length > 1 ? `(${unacked.length} alerts open)` : ""}`;
  el.hidden = false;
}

function renderAlerts() {
  const box = $("#rt-alerts");
  const alerts = S.events.filter((e) => e.kind === "alert").slice().reverse();
  const sig = alerts.map((a) => a.id + a.acknowledged + !!a.resolved).join("|");
  if (sig !== sigAlerts) {
    sigAlerts = sig;
    if (!alerts.length) box.innerHTML = `<div class="empty">No alerts. The network is quiet.<br><br>Choose a scenario on the left, or run the guided demo, and watch the nodes respond.</div>`;
    else box.innerHTML = alerts.map((a) => `
      <article class="alert ${a.resolved ? "done" : ""} ${a.acknowledged ? "acked" : ""}" data-id="${a.id}" data-tick="${a.tick}">
        <div class="ahead"><div><h4>${a.station_name}</h4><small>${a.zone}, score ${a.score}</small></div><span class="tag">${a.resolved ? "Eased" : "High"}</span></div>
        <h5>Flood path</h5>
        <ul class="path"><li class="origin"><i></i><span>${short(a.station_name)}</span><span class="eta-t">Source</span></li>
          ${(a.downstream || []).map((d) => `<li data-eta="${d.eta_min}" data-st="${d.station_id}"><i></i><span>${short(d.name)}</span><span class="eta-t"></span></li>`).join("") || '<li><i></i><span class="eta-t">No downstream nodes</span><span></span></li>'}
        </ul>
        <h5>Messages an operator would send</h5>
        <ul class="dsp">${(a.dispatch || []).map((d) => `<li><b>${d.channel}</b><em>${d.status}</em><span>${d.target}. ${d.text}</span></li>`).join("")}</ul>
        ${a.acknowledged ? '<div class="ackdone">Acknowledged by operator</div>' : `<button class="ackbtn" data-ack="${a.id}">Acknowledge alert</button>`}
      </article>`).join("");
  }
  $$(".alert", box).forEach((card) => {
    const t0 = +card.dataset.tick;
    $$(".path li[data-eta]", card).forEach((li) => {
      const left = (t0 * S.tick_sim_min + (+li.dataset.eta)) - S.tick * S.tick_sim_min, t = li.querySelector(".eta-t");
      const txt = left > 0 ? "in " + fmtEta(left) : "Arrived"; li.classList.toggle("arrived", left <= 0);
      if (t.textContent !== txt) t.textContent = txt;
    });
  });
}

function renderFeed() {
  const box = $("#rt-feed"), evs = S.events.slice().reverse();
  const sig = evs.map((e) => e.id + e.acknowledged).join("|");
  if (sig === sigFeed) return; sigFeed = sig;
  const simT = (e) => { const m = 360 + e.tick * S.tick_sim_min; return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
  box.innerHTML = evs.map((e) => `<div class="ev" data-lv="${e.level}"><i></i><div><b>${e.kind === "system" ? "System" : e.kind === "siren" ? "Siren control" : short(e.station_name)}</b><p>${e.message}</p>${!e.acknowledged && e.kind === "level" ? `<button data-ack="${e.id}">Acknowledge</button>` : ""}</div><small>${simT(e)}</small></div>`).join("");
}

/* ------------------------------------------------------------ node panel */
function selectNode(id, pan) {
  selected = id; $("#target").value = id; showRtab("node");
  if (pan) map.panTo([CFG.stations[id].lat, CFG.stations[id].lon], { animate: true });
  if (S) { renderNodes(); renderMapNodes(); renderNodePanel(true); }
}
function renderNodePanel() {
  const s = selected && S.stations.find((x) => x.station_id === selected);
  $("#nodeEmpty").hidden = !!s; $("#nodeBody").hidden = !s; if (!s || !s.reading) return;
  const r = s.reading;
  $("#nName").textContent = s.name;
  $("#nMeta").innerHTML = `${s.station_id}<br>${s.district.replace("Dehra Dun", "Dehradun").replace("Rudra Prayag", "Rudraprayag")} district, ${s.zone}`;
  const ring = $(".score-ring"); ring.dataset.lv = r.risk_label;
  $("#ringVal").setAttribute("stroke-dasharray", `${r.risk_score} 100`); $("#ringNum").textContent = r.risk_score; $("#ringLbl").textContent = LV_NAME[r.risk_label];
  $("#rRain").innerHTML = `${r.rainfall_mm_h.toFixed(1)} <small>mm/h</small>`;
  $("#rLevel").innerHTML = `${r.water_level_cm.toFixed(0)} <small>cm</small>`;
  const rise = r.water_level_change_cm_10m; $("#rRise").innerHTML = `${rise > 0 ? "+" : ""}${rise.toFixed(1)} <small>cm</small>`;
  $("#rWind").innerHTML = `${r.wind_speed_m_s.toFixed(1)} <small>m/s</small>`;
  $("#rAudio").textContent = AUDIO[r.audio_class] || r.audio_class;
  $("#rSrc").textContent = s.external ? "Real node" : "Simulated";
  const h = s.hist, labels = h.tick.map((t) => { const m = 360 + t * S.tick_sim_min; return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; });
  if (!chart) initChart();
  chart.data.labels = labels; chart.data.datasets[0].data = h.level; chart.data.datasets[1].data = h.rain; chart.update("none");
}
function initChart() {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily; Chart.defaults.color = "#80a0a7";
  chart = new Chart($("#nodeChart"), {
    data: { labels: [], datasets: [
      { type: "line", label: "Water level (cm)", data: [], borderColor: "#62e3ff", backgroundColor: "#62e3ff22", fill: true, pointRadius: 0, borderWidth: 2, tension: .3, yAxisID: "y" },
      { type: "bar", label: "Rainfall (mm/h)", data: [], backgroundColor: "#f1c04f99", borderWidth: 0, yAxisID: "y1", barPercentage: 1, categoryPercentage: 1 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } } },
      scales: { x: { ticks: { maxTicksLimit: 5, maxRotation: 0 }, grid: { display: false } },
        y: { position: "left", beginAtZero: true, grid: { color: "#1d3640" }, title: { display: false } },
        y1: { position: "right", min: 0, suggestedMax: 60, grid: { display: false } } } } });
}

/* spectrogram (synthetic, illustrative) */
(function spectro() {
  const cv = $("#spec"), ctx = cv.getContext("2d"), W = cv.width, H = cv.height, BINS = 42, bh = H / BINS; let t = 0, last = 0;
  ctx.fillStyle = "#071013"; ctx.fillRect(0, 0, W, H);
  function color(v, hot) { v = Math.max(0, Math.min(1, v)); const a = hot ? [255, 59, 107] : [98, 227, 255]; const k = Math.pow(v, 1.4); v = v; return `rgb(${14 + (a[0] - 14) * k + (v > .85 ? 80 * (v - .85) / .15 : 0)},${34 + (a[1] - 34) * k + (v > .85 ? 60 * (v - .85) / .15 : 0)},${42 + (a[2] - 42) * k + (v > .85 ? 60 * (v - .85) / .15 : 0)})`; }
  function frame(ts) {
    requestAnimationFrame(frame);
    if (ts - last < 55 || $("#nodeBody").hidden || $("#rt-node").hidden) return; last = ts; column();
  }
  function column() {
    t++;
    const s = S && selected && S.stations.find((x) => x.station_id === selected); const cls = s?.reading?.audio_class || "background", hot = s?.reading?.risk_label === "HIGH";
    const gain = 0.75 + Math.min(0.5, ((s?.reading?.water_level_cm || 40) - 40) / 260);
    ctx.drawImage(cv, -3, 0);
    for (let i = 0; i < BINS; i++) {
      const f = i / (BINS - 1), n = Math.random(); let v;
      if (cls === "rain_like") v = 0.22 + 0.4 * Math.pow(f, 0.7) + n * 0.3;
      else if (cls === "flowing_water") v = 0.12 + 0.62 * Math.exp(-Math.pow((f - 0.28 - 0.06 * Math.sin(t / 7)) / 0.22, 2)) + n * 0.22;
      else if (cls === "wind_noise") v = 0.1 + 0.5 * Math.exp(-Math.pow(f / 0.16, 2)) * (0.7 + 0.3 * Math.sin(t / 5)) + n * 0.12;
      else v = 0.1 + n * 0.2 + 0.2 * Math.exp(-Math.pow(f / 0.1, 2));
      ctx.fillStyle = color(v * gain, hot); ctx.fillRect(W - 3, H - (i + 1) * bh, 3, bh + 0.5);
    }
  }
  for (let i = 0; i < Math.ceil(W / 3); i++) column();
  requestAnimationFrame(frame);
})();

/* ------------------------------------------------------------ alerts: sound + auto-focus */
function beep() {
  if (!sound) return; try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); const t = audioCtx.currentTime;
    [0, 0.22, 0.44].forEach((o, i) => { const osc = audioCtx.createOscillator(), g = audioCtx.createGain(); osc.type = "square"; osc.frequency.value = i % 2 ? 660 : 880; g.gain.setValueAtTime(0.0001, t + o); g.gain.exponentialRampToValueAtTime(0.08, t + o + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + o + 0.18); osc.connect(g).connect(audioCtx.destination); osc.start(t + o); osc.stop(t + o + 0.2); });
  } catch (e) {}
}
function detectNewAlert(first) {
  const ids = S.events.filter((e) => e.kind === "alert").map((e) => e.id);
  if (seenAlerts === null || first) { seenAlerts = new Set(ids); return; }
  const fresh = ids.filter((i) => !seenAlerts.has(i)); ids.forEach((i) => seenAlerts.add(i));
  if (fresh.length) { showRtab("alerts"); beep(); }
}

/* ------------------------------------------------------------ UI wiring */
function showRtab(name) { rtab = name; $$(".rtabs button").forEach((b) => b.classList.toggle("on", b.dataset.rt === name)); ["alerts", "node", "health", "sirens", "feed"].forEach((n) => { $("#rt-" + n).hidden = n !== name; }); }
function focusZone(zoneId, tab) {
  selectedZone = zoneId;
  if (S) { renderZoneSummary(); renderHealthPanel(); renderSirensPanel(); }
  showRtab(tab);
}

function wire() {
  $$(".rtabs button").forEach((b) => b.addEventListener("click", () => showRtab(b.dataset.rt)));
  $("#scnGrid").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; stopDemo(); post("/api/scenario", { name: b.dataset.scn, station: $("#target").value || null }); });
  $("#pauseBtn").addEventListener("click", () => post("/api/control", { running: !S.running }));
  $("#speedSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) post("/api/control", { speed: +b.dataset.s }); });
  $("#resetBtn").addEventListener("click", () => { stopDemo(); post("/api/reset"); });
  $("#rt-alerts").addEventListener("click", ackClick); $("#rt-feed").addEventListener("click", ackClick);
  function ackClick(e) { const b = e.target.closest("[data-ack]"); if (b) post(`/api/events/${b.dataset.ack}/acknowledge`); }
  $("#alarm").addEventListener("click", () => showRtab("alerts"));
  $("#target").addEventListener("change", (e) => { if (e.target.value) selectNode(e.target.value, true); });
  $("#zoneSummary").addEventListener("click", (e) => { const b = e.target.closest("[data-zone]"); if (b) focusZone(b.dataset.zone, "health"); });
  $("#rt-health").addEventListener("click", (e) => { const b = e.target.closest("[data-open-sirens]"); if (b) focusZone(b.dataset.openSirens, "sirens"); });
  $("#rt-sirens").addEventListener("click", (e) => {
    const b = e.target.closest("[data-siren-action]");
    if (b && !b.disabled) post(`/api/zones/${b.dataset.zone}/sirens`, { action: b.dataset.sirenAction });
  });
  $("#demoBtn").addEventListener("click", () => (demo.timers.length ? stopDemo() : startDemo()));
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input,select,textarea")) return;
    if (e.key === " ") { e.preventDefault(); post("/api/control", { running: !S.running }); }
    if (e.key === "m") { sound = !sound; if (sound) beep(); }
  });
}

/* ------------------------------------------------------------ guided demo */
const demo = { timers: [], t0: 0, raf: 0 };
const STEPS = [
  [0, "All ten nodes report every ten simulated minutes. Conditions are quiet.", () => { post("/api/reset"); post("/api/control", { speed: 2, running: true }); selected = null; showRtab("alerts"); }],
  [6, "A cloudburst hits Chamoli: 118 mm of rain an hour at a single node.", () => { post("/api/scenario", { name: "cloudburst", station: "FG-CHM-01" }); }],
  [11, "One reading later the node scores High. The alert already names every downstream node and when the wave should reach it.", () => showRtab("alerts")],
  [17, "The red front is the flood wave travelling down the Alaknanda. Rudraprayag and Pauri are warned while the water is still upstream.", null],
  [30, "Second case. A sudden outburst flood at Joshimath, with no rain at all. A rain gauge alone would miss it.", () => { post("/api/reset"); post("/api/control", { speed: 1.5, running: true }); post("/api/scenario", { name: "glof", station: "FG-JSM-07" }); }],
  [32, "The give-away is the rate of rise: more than 50 cm in one reading, plus the sound of fast water on the microphone.", () => selectNode("FG-JSM-07")],
  [42, "Each node in the flood path gets a countdown. Chamoli has hours, not minutes, to react.", () => showRtab("alerts")],
  [56, "That head start is what the network is for. Operators acknowledge each alert from this list.", null],
  [66, "The gateway takes the same packets from a real ESP32 node. Swap the simulator for hardware and nothing else on screen changes.", null],
  [76, null, () => { post("/api/scenario", { name: "normal" }); post("/api/control", { speed: 1 }); stopDemo(true); }],
];
const DEMO_LEN = 76;
function caption(t) { const c = $("#caption"); if (!t) { c.hidden = true; return; } $("p", c).textContent = t; c.hidden = false; }
function startDemo() {
  const b = $("#demoBtn"); b.classList.add("running"); $("span", b).textContent = "Stop simulation"; $("#demoProg").hidden = false;
  demo.t0 = performance.now();
  STEPS.forEach(([t, cap, fn]) => demo.timers.push(setTimeout(() => { if (cap) caption(cap); fn && fn(); }, t * 1000)));
  const tick = () => { const p = Math.min(1, (performance.now() - demo.t0) / (DEMO_LEN * 1000)); $("#demoProg i").style.width = p * 100 + "%"; demo.raf = requestAnimationFrame(tick); }; tick();
}
function stopDemo(done) {
  if (!demo.timers.length && !done) return;
  demo.timers.forEach(clearTimeout); demo.timers = []; cancelAnimationFrame(demo.raf);
  const b = $("#demoBtn"); b.classList.remove("running"); $("span", b).textContent = "Run guided simulation"; $("#demoProg").hidden = true; setTimeout(() => caption(null), done ? 0 : 0);
}

/* ------------------------------------------------------------ connection */
function connect() {
  const conn = $("#conn"), set = (s, t) => { conn.dataset.s = s; $("span", conn).textContent = t; };
  let ws; try { ws = new WebSocket(WS_URL); } catch (e) { return setTimeout(connect, 2000); }
  ws.onopen = () => { set("ok", "Gateway online"); ws.send("hi"); };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === "state") render(m.state); };
  ws.onclose = () => { set("bad", "Reconnecting"); setTimeout(connect, 1500); };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

async function init() {
  wire();
  try { CFG = await (await fetch(API + "/api/config")).json(); } catch (e) { $("#conn").dataset.s = "bad"; $("#conn span").textContent = "Gateway offline: run python run.py"; return; }
  $("#target").innerHTML = `<option value="">Default node</option>` + ORDER.map((id) => `<option value="${id}">${short(CFG.stations[id].name)}</option>`).join("");
  initMap(); requestAnimationFrame(animateFronts); connect();
}
init();
})();
