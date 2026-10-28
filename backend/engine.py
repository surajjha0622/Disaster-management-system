"""Disaster management system simulation engine.

Everything here is SYNTHETIC. The hydrology is a deliberately simple, explainable
routing model (local runoff + attenuated, delayed upstream flow) so a demo can show
how a multi-node sensor network would behave. It is not a validated flood model.
"""
from __future__ import annotations

import math
import random
from collections import deque
from datetime import datetime, timezone

TICK_SIM_MIN = 10          # one simulation tick = 10 simulated minutes (== the "10 min change" field)
WAVE_KMH = 18.0            # assumed flood-wave celerity for ETA maths (illustrative)
SINUOSITY = 1.3            # straight-line -> river-length factor
HIST_KEEP = 240

# base = quiet-day water level (cm). up = [(upstream station, weight)].
STATIONS = {
    "FG-JSM-07": dict(name="Joshimath Station", zone="Central Himalaya", lat=30.557, lon=79.565, district="Chamoli", base=34, spatial=1.25, up=[]),
    "FG-CHM-01": dict(name="Chamoli Station", zone="Central Himalaya", lat=30.402, lon=79.320, district="Chamoli", base=38, spatial=1.20, up=[("FG-JSM-07", 0.8)]),
    "FG-RUD-02": dict(name="Rudraprayag Station", zone="Central Himalaya", lat=30.285, lon=78.981, district="Rudra Prayag", base=42, spatial=1.10, up=[("FG-CHM-01", 0.8)]),
    "FG-UTK-03": dict(name="Uttarkashi Station", zone="Western Himalaya", lat=30.726, lon=78.435, district="Uttarkashi", base=30, spatial=1.00, up=[]),
    "FG-PAU-04": dict(name="Pauri Station", zone="Foothill Belt", lat=30.150, lon=78.780, district="Pauri Garhwal", base=40, spatial=0.90, up=[("FG-RUD-02", 0.8)]),
    "FG-TEH-05": dict(name="Tehri Station", zone="Foothill Belt", lat=30.390, lon=78.480, district="Tehri Garhwal", base=36, spatial=0.95, up=[("FG-UTK-03", 0.8)]),
    "FG-DEV-08": dict(name="Devprayag Station", zone="Foothill Belt", lat=30.146, lon=78.598, district="Tehri Garhwal", base=48, spatial=0.90, up=[("FG-PAU-04", 0.6), ("FG-TEH-05", 0.6)]),
    "FG-RSK-09": dict(name="Rishikesh Station", zone="Ganga Corridor", lat=30.087, lon=78.268, district="Dehra Dun", base=52, spatial=0.80, up=[("FG-DEV-08", 0.8)]),
    "FG-HWR-10": dict(name="Haridwar Station", zone="Ganga Corridor", lat=29.945, lon=78.164, district="Haridwar", base=55, spatial=0.75, up=[("FG-RSK-09", 0.8)]),
    "FG-UDH-06": dict(name="Udham Singh Nagar Station", zone="Terai Belt", lat=29.050, lon=79.520, district="Udham Singh Nagar", base=45, spatial=0.70, up=[]),
}
ZONES = {
    "Western Himalaya": "Uttarkashi / upper Bhagirathi",
    "Central Himalaya": "Chamoli / Rudraprayag / Alaknanda",
    "Foothill Belt": "Pauri / Tehri / Devprayag",
    "Ganga Corridor": "Rishikesh / Haridwar",
    "Terai Belt": "Southern lowland",
}

# Each operational zone contains a small mesh of sensor and siren nodes.  The
# ten river stations above drive the hydrology simulation; the additional
# field nodes below model the distributed equipment an operator would monitor
# across the wider zone.  Their PCB implementation is deliberately outside
# the scope of this software project.
ZONE_ASSETS = {
    "Western Himalaya": {
        "id": "western-himalaya",
        "sensors": [
            {"id": "DMS-WH-S01", "name": "Uttarkashi river gauge", "lat": 30.726, "lon": 78.435, "station_id": "FG-UTK-03"},
            {"id": "DMS-WH-S02", "name": "Harsil upstream sensor", "lat": 31.040, "lon": 78.742},
            {"id": "DMS-WH-S03", "name": "Gangotri catchment sensor", "lat": 30.995, "lon": 78.941},
            {"id": "DMS-WH-S04", "name": "Bhatwari rain sensor", "lat": 30.805, "lon": 78.610},
            {"id": "DMS-WH-S05", "name": "Maneri level sensor", "lat": 30.755, "lon": 78.510},
        ],
        "sirens": [
            {"id": "DMS-WH-R01", "name": "Uttarkashi siren", "lat": 30.708, "lon": 78.448},
            {"id": "DMS-WH-R02", "name": "Harsil siren", "lat": 31.042, "lon": 78.734},
            {"id": "DMS-WH-R03", "name": "Maneri siren", "lat": 30.768, "lon": 78.495},
        ],
    },
    "Central Himalaya": {
        "id": "central-himalaya",
        "sensors": [
            {"id": "DMS-CH-S01", "name": "Joshimath river gauge", "lat": 30.557, "lon": 79.565, "station_id": "FG-JSM-07"},
            {"id": "DMS-CH-S02", "name": "Chamoli river gauge", "lat": 30.402, "lon": 79.320, "station_id": "FG-CHM-01"},
            {"id": "DMS-CH-S03", "name": "Rudraprayag river gauge", "lat": 30.285, "lon": 78.981, "station_id": "FG-RUD-02"},
            {"id": "DMS-CH-S04", "name": "Tapovan catchment sensor", "lat": 30.484, "lon": 79.635},
            {"id": "DMS-CH-S05", "name": "Karnaprayag level sensor", "lat": 30.259, "lon": 79.217},
        ],
        "sirens": [
            {"id": "DMS-CH-R01", "name": "Joshimath siren", "lat": 30.565, "lon": 79.552},
            {"id": "DMS-CH-R02", "name": "Chamoli siren", "lat": 30.390, "lon": 79.336},
            {"id": "DMS-CH-R03", "name": "Rudraprayag siren", "lat": 30.278, "lon": 78.968},
        ],
    },
    "Foothill Belt": {
        "id": "foothill-belt",
        "sensors": [
            {"id": "DMS-FB-S01", "name": "Pauri river gauge", "lat": 30.150, "lon": 78.780, "station_id": "FG-PAU-04"},
            {"id": "DMS-FB-S02", "name": "Tehri river gauge", "lat": 30.390, "lon": 78.480, "station_id": "FG-TEH-05"},
            {"id": "DMS-FB-S03", "name": "Devprayag river gauge", "lat": 30.146, "lon": 78.598, "station_id": "FG-DEV-08"},
            {"id": "DMS-FB-S04", "name": "Srinagar rain sensor", "lat": 30.222, "lon": 78.780},
            {"id": "DMS-FB-S05", "name": "Maldevta catchment sensor", "lat": 30.362, "lon": 78.244},
        ],
        "sirens": [
            {"id": "DMS-FB-R01", "name": "Pauri siren", "lat": 30.143, "lon": 78.765},
            {"id": "DMS-FB-R02", "name": "Tehri siren", "lat": 30.382, "lon": 78.464},
            {"id": "DMS-FB-R03", "name": "Devprayag siren", "lat": 30.137, "lon": 78.612},
        ],
    },
    "Ganga Corridor": {
        "id": "ganga-corridor",
        "sensors": [
            {"id": "DMS-GC-S01", "name": "Rishikesh river gauge", "lat": 30.087, "lon": 78.268, "station_id": "FG-RSK-09"},
            {"id": "DMS-GC-S02", "name": "Haridwar river gauge", "lat": 29.945, "lon": 78.164, "station_id": "FG-HWR-10"},
            {"id": "DMS-GC-S03", "name": "Narendranagar sensor", "lat": 30.161, "lon": 78.290},
            {"id": "DMS-GC-S04", "name": "Shyampur level sensor", "lat": 29.993, "lon": 78.205},
            {"id": "DMS-GC-S05", "name": "Jwalapur rain sensor", "lat": 29.921, "lon": 78.113},
        ],
        "sirens": [
            {"id": "DMS-GC-R01", "name": "Rishikesh siren", "lat": 30.079, "lon": 78.280},
            {"id": "DMS-GC-R02", "name": "Haridwar siren", "lat": 29.952, "lon": 78.150},
            {"id": "DMS-GC-R03", "name": "Jwalapur siren", "lat": 29.914, "lon": 78.126},
        ],
    },
    "Terai Belt": {
        "id": "terai-belt",
        "sensors": [
            {"id": "DMS-TB-S01", "name": "Udham Singh Nagar gauge", "lat": 29.050, "lon": 79.520, "station_id": "FG-UDH-06"},
            {"id": "DMS-TB-S02", "name": "Kashipur rain sensor", "lat": 29.214, "lon": 78.965},
            {"id": "DMS-TB-S03", "name": "Rudrapur water sensor", "lat": 28.982, "lon": 79.412},
            {"id": "DMS-TB-S04", "name": "Khatima flood sensor", "lat": 28.925, "lon": 79.970},
            {"id": "DMS-TB-S05", "name": "Sitarganj rain sensor", "lat": 28.932, "lon": 79.704},
        ],
        "sirens": [
            {"id": "DMS-TB-R01", "name": "Rudrapur siren", "lat": 28.975, "lon": 79.424},
            {"id": "DMS-TB-R02", "name": "Khatima siren", "lat": 28.930, "lon": 79.955},
            {"id": "DMS-TB-R03", "name": "Sitarganj siren", "lat": 28.940, "lon": 79.690},
        ],
    },
}
# Visual-only river headwaters (no sensors) so the drawn network looks complete.
HEADWATERS = {
    "Bhagirathi (upper)": [(30.99, 78.94), (30.86, 78.70), (30.726, 78.435)],
    "Alaknanda (upper)": [(30.78, 79.52), (30.66, 79.55), (30.557, 79.565)],
    "Mandakini": [(30.735, 79.067), (30.52, 79.03), (30.285, 78.981)],
}

SCENARIOS = {
    "normal": "Normal conditions",
    "monsoon": "Monsoon surge",
    "cloudburst": "Localised cloudburst",
    "glof": "Upstream outburst flood",
}
ALIASES = {"heavy_rain": "monsoon", "rapid_rise": "glof"}
DEFAULT_TARGET = {"cloudburst": "FG-CHM-01", "glof": "FG-JSM-07"}


def haversine_km(a, b):
    r = 6371.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dphi = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def build_edges():
    edges = []
    for sid, s in STATIONS.items():
        for up, w in s["up"]:
            u = STATIONS[up]
            km = haversine_km((u["lat"], u["lon"]), (s["lat"], s["lon"])) * SINUOSITY
            delay = max(1, round(km / WAVE_KMH * 60 / TICK_SIM_MIN))
            edges.append(dict(frm=up, to=sid, km=round(km, 1), delay=delay, weight=w))
    return edges


EDGES = build_edges()
CHILDREN: dict[str, list[dict]] = {}
for _e in EDGES:
    CHILDREN.setdefault(_e["frm"], []).append(_e)

LEVELS = ("LOW", "GUARDED", "ELEVATED", "HIGH")


def calculate_demo_score(rain, water, rise, audio):
    """Transparent illustrative heuristic (same weights as the original prototype)."""
    r = min(rain / 80.0, 1.0) * 40
    w = min(water / 180.0, 1.0) * 25
    d = min(max(rise, 0) / 20.0, 1.0) * 25
    a = 10 if audio in ("rain_like", "flowing_water") else 0
    score = round(r + w + d + a)
    # Rapid-rise rule: a fast climb at a high stage is the classic flash-flood signature, with or without local rain.
    if rise >= 15 and water >= 80:
        score = max(score, 76 + min(round(rise - 15), 12))
    label = "LOW" if score < 30 else "GUARDED" if score < 55 else "ELEVATED" if score < 75 else "HIGH"
    return score, label


def dname(d):
    return {"Dehra Dun": "Dehradun", "Rudra Prayag": "Rudraprayag", "Naini Tal": "Nainital"}.get(d, d)


def fmt_dur(minutes):
    h, m = divmod(int(round(minutes)), 60)
    return f"{h}h {m:02d}m" if h else f"{m}m"


class Engine:
    def __init__(self, seed=None):
        self.rng = random.Random(seed)
        self.reset()

    # ------------------------------------------------------------------ state
    def reset(self, keep_speed=True):
        self.tick = 0
        self.seq = 0
        self.ev_counter = 0
        self.scenario = "normal"
        self.target = None
        self.scn_tick = 0
        self.events: list[dict] = []
        self.fronts: list[dict] = []
        self.siren_state = {
            zone: {"active": False, "last_action": "Standing by", "changed_at": None}
            for zone in ZONES
        }
        self.log: deque = deque(maxlen=6000)
        self.st = {}
        for sid, s in STATIONS.items():
            self.st[sid] = dict(local=0.0, routed=0.0, ex=0.0, ex_hist=deque([0.0] * 60, maxlen=60),
                                local_rain=0.0, shower=0.0, level_state="LOW", calm=0,
                                hist=deque(maxlen=HIST_KEEP), latest=None, ext_until=0.0, prev_level=s["base"],
                                alert_id=None)
        self.regional = 2.0
        self.running = True if not hasattr(self, "running") else self.running
        self.speed = getattr(self, "speed", 1.0) if keep_speed else 1.0
        self.add_event("system", "LOW", None, "Simulation started — all 10 nodes reporting. Scenario: Normal conditions.")
        for _ in range(6):   # pre-roll so charts are not empty at first paint
            self.step(quiet=True)

    def set_scenario(self, name, target=None):
        name = ALIASES.get(name, name)
        if name not in SCENARIOS:
            raise ValueError("unknown scenario")
        if name in DEFAULT_TARGET:
            target = target if target in STATIONS else DEFAULT_TARGET[name]
        else:
            target = None
        self.scenario, self.target, self.scn_tick = name, target, 0
        where = f" at {STATIONS[target]['name']}" if target else ""
        self.add_event("system", "LOW", target, f"Scenario applied: {SCENARIOS[name]}{where}.")

    # ----------------------------------------------------------------- events
    def add_event(self, kind, level, sid, message, **extra):
        self.ev_counter += 1
        s = STATIONS.get(sid) if sid else None
        ev_zone = extra.pop("zone", s["zone"] if s else "—")
        ev = dict(id=f"EV-{self.ev_counter:05d}", kind=kind, timestamp=datetime.now(timezone.utc).isoformat(),
                  sim_minutes=self.tick * TICK_SIM_MIN, tick=self.tick, station_id=sid,
                  station_name=s["name"] if s else "System", zone=ev_zone, level=level,
                  score=extra.pop("score", None), message=message, acknowledged=kind == "system" or kind == "clear",
                  simulation=True, **extra)
        self.events.append(ev)
        del self.events[:-120]
        return ev

    def downstream(self, sid):
        """BFS along the river graph -> list of (station, cumulative delay ticks, via-edge)."""
        out, seen, queue = [], {sid}, [(sid, 0)]
        while queue:
            cur, t = queue.pop(0)
            for e in CHILDREN.get(cur, []):
                if e["to"] in seen:
                    continue
                seen.add(e["to"])
                out.append(dict(station_id=e["to"], t0=t, t1=t + e["delay"], via=cur, km=e["km"]))
                queue.append((e["to"], t + e["delay"]))
        return out

    def raise_alert(self, sid, score):
        s = STATIONS[sid]
        down = self.downstream(sid)
        ds = [dict(station_id=d["station_id"], name=STATIONS[d["station_id"]]["name"],
                   eta_min=d["t1"] * TICK_SIM_MIN, eta_text=fmt_dur(d["t1"] * TICK_SIM_MIN)) for d in down]
        dispatch = [
            dict(channel="DEOC console", target=f"District Emergency Operations Centre — {dname(s['district'])}",
                 text=f"HIGH flood-risk signature at {s['name']} (score {score}/100)."),
            dict(channel="SMS gateway", target="Registered local responders", text="Pre-formatted alert text queued."),
            dict(channel="Siren node", target=f"{s['name']} — siren relay", text="Siren trigger armed (requires operator confirm)."),
        ]
        if ds:
            dispatch.append(dict(channel="Downstream pre-alert", target=", ".join(d["name"].replace(" Station", "") for d in ds[:4]) + ("…" if len(ds) > 4 else ""),
                                 text=f"Flood-wave ETA from {ds[0]['eta_text']} (nearest) to {ds[-1]['eta_text']} (furthest)."))
        for d in dispatch:
            d["status"] = "SIMULATED · not sent"
        ev = self.add_event("alert", "HIGH", sid, f"HIGH risk at {s['name']} — {len(ds)} downstream node(s) in the flood path.",
                            score=score, downstream=ds, dispatch=dispatch)
        self.st[sid]["alert_id"] = ev["id"]
        for d in down:
            self.fronts.append(dict(src=sid, frm=d["via"], to=d["station_id"], t0=self.tick + d["t0"], t1=self.tick + d["t1"], alert=ev["id"]))
        return ev

    def clear_alert(self, sid):
        aid = self.st[sid]["alert_id"]
        self.st[sid]["alert_id"] = None
        self.fronts = [f for f in self.fronts if f["alert"] != aid]
        for e in self.events:
            if e["id"] == aid:
                e["resolved"] = True

    def control_sirens(self, zone_id, action):
        """Activate or silence every simulated siren node in one zone."""
        zone = next((name for name, assets in ZONE_ASSETS.items() if assets["id"] == zone_id), None)
        if not zone:
            raise ValueError("unknown zone")
        if action not in ("activate", "silence"):
            raise ValueError("unknown siren action")
        state = self.siren_state[zone]
        state["active"] = action == "activate"
        state["last_action"] = "Activated by operator" if state["active"] else "Silenced by operator"
        state["changed_at"] = datetime.now(timezone.utc).isoformat()
        count = len(ZONE_ASSETS[zone]["sirens"])
        verb = "activated" if state["active"] else "silenced"
        self.add_event(
            "siren", "HIGH" if state["active"] else "LOW", None,
            f"{zone}: {count} simulated siren node(s) {verb}.",
            zone=zone, siren_action=action, siren_count=count,
        )
        return zone, state

    # --------------------------------------------------------------- readings
    def ingest(self, sid, rain, wind, level, rise, audio, source="simulated", timestamp=None):
        score, label = calculate_demo_score(rain, level, rise, audio)
        self.seq += 1
        s, st = STATIONS[sid], self.st[sid]
        reading = dict(station_id=sid, zone=s["zone"], timestamp=timestamp or datetime.now(timezone.utc).isoformat(),
                       audio_class=audio, rainfall_mm_h=round(rain, 1), wind_speed_m_s=round(wind, 1),
                       water_level_cm=round(level, 1), water_level_change_cm_10m=round(rise, 1), source=source,
                       risk_score=score, risk_label=label, packet_number=self.seq)
        st["latest"] = reading
        st["hist"].append(dict(tick=self.tick, rain=reading["rainfall_mm_h"], level=reading["water_level_cm"], risk=score, rise=reading["water_level_change_cm_10m"]))
        self.log.append(reading)
        self._level_transitions(sid, score, label)
        return reading

    def _level_transitions(self, sid, score, label):
        st = self.st[sid]
        cur, new = LEVELS.index(st["level_state"]), LEVELS.index(label)
        s = STATIONS[sid]
        if new > cur:
            st["level_state"], st["calm"] = label, 0
            if label == "HIGH":
                self.raise_alert(sid, score)
            elif label == "ELEVATED":
                self.add_event("level", "ELEVATED", sid, f"{s['name']} rose to ELEVATED (score {score}/100).", score=score)
            elif label == "GUARDED" and cur == 0:
                pass  # GUARDED is shown on the map but is not worth an event
        elif new < cur:
            st["calm"] += 1
            if st["calm"] >= 3 and score < (30, 55, 75)[cur - 1] - 5:
                prev = st["level_state"]
                st["level_state"], st["calm"] = label, 0
                if prev == "HIGH":
                    self.clear_alert(sid)
                if prev in ("ELEVATED", "HIGH") and LEVELS.index(label) < 2:
                    self.add_event("clear", label, sid, f"{s['name']} eased to {label} (score {score}/100).", score=score)
        else:
            st["calm"] = 0

    # ------------------------------------------------------------------- tick
    def _regional_rain(self):
        r = self.rng
        n = self.scn_tick
        if self.scenario == "monsoon":
            target = 66.0 + 8 * math.sin(n / 7.0)
            self.regional += (target - self.regional) * 0.30
        else:
            target = 2.0 + 1.5 * math.sin(self.tick / 17.0)
            self.regional += (target - self.regional) * 0.25
        return max(0.0, self.regional + r.gauss(0, 0.8 if self.scenario != "monsoon" else 4.5))

    def step(self, quiet=False):
        r = self.rng
        self.tick += 1
        self.scn_tick += 1
        regional = self._regional_rain()
        now = datetime.now(timezone.utc).timestamp()
        for sid, s in STATIONS.items():
            st = self.st[sid]
            # --- local rain
            local_rain = st["local_rain"] * 0.80
            st["local_rain"] = local_rain
            if self.scenario == "cloudburst" and sid == self.target and self.scn_tick <= 9:
                st["local_rain"] = local_rain = 118 + r.uniform(-12, 14)
            if self.scenario in ("normal",) and r.random() < 0.025:
                st["shower"] = r.uniform(7, 16)
            st["shower"] *= 0.7
            rain = max(0.0, regional * s["spatial"] + local_rain + st["shower"] + r.gauss(0, 0.5))
            if self.scenario == "cloudburst" and sid != self.target:
                rain *= 0.9
            rain = min(rain, 180.0)
            # --- local runoff + injected pulse
            inject = 0.0
            if self.scenario == "glof" and sid == self.target and self.scn_tick <= 4:
                inject = 58.0
            elif self.scenario == "cloudburst" and sid == self.target and self.scn_tick <= 6:
                inject = 20.0   # steep-catchment runoff on top of the rainfall term
            st["local"] = st["local"] * 0.90 + 0.14 * rain + inject
            # --- routed upstream flow (delayed, attenuated, low-passed)
            target_routed = 0.0
            for up, w in s["up"]:
                edge = next(e for e in EDGES if e["frm"] == up and e["to"] == sid)
                hist = self.st[up]["ex_hist"]
                idx = min(edge["delay"], len(hist))
                target_routed += w * hist[-idx]
            st["routed"] += 0.55 * (target_routed - st["routed"])
            st["ex"] = st["local"] + st["routed"]
            st["ex_hist"].append(st["ex"])
        # --- sensor readings
        for sid, s in STATIONS.items():
            st = self.st[sid]
            if st["ext_until"] > now:       # a real/external node is feeding this station
                st["prev_level"] = st["latest"]["water_level_cm"] if st["latest"] else s["base"]
                continue
            level = min(420.0, s["base"] + st["ex"] + r.gauss(0, 0.5))
            rain = max(0.0, regional * s["spatial"] + st["local_rain"] + st["shower"])
            if self.scenario == "cloudburst" and sid != self.target:
                rain *= 0.9
            rain = min(rain + r.gauss(0, 0.4), 180.0)
            rise = level - st["prev_level"]
            st["prev_level"] = level
            wind = max(0.2, 1.6 + 1.6 * r.random() + rain * 0.045 + (3 if rain > 40 else 0) * r.random())
            if rain >= 25:
                audio = "rain_like" if r.random() < 0.85 else "flowing_water"
            elif st["ex"] > 55 or rise >= 8:
                audio = "flowing_water" if r.random() < 0.9 else "rain_like"
            elif wind >= 8:
                audio = "wind_noise"
            elif rain >= 6:
                audio = "rain_like" if r.random() < 0.7 else "background"
            else:
                audio = r.choices(["background", "wind_noise", "flowing_water"], [90, 6, 4])[0]
            self.ingest(sid, rain, wind, level, rise, audio)
        self.fronts = [f for f in self.fronts if f["t1"] >= self.tick - 2]

    # -------------------------------------------------------------- snapshots
    def sim_clock(self):
        m = 6 * 60 + self.tick * TICK_SIM_MIN
        d, rem = divmod(m, 1440)
        return f"Day {d + 1} · {rem // 60:02d}:{rem % 60:02d}"

    def snapshot(self, clients=0, hist_n=90):
        now = datetime.now(timezone.utc).timestamp()
        stations = []
        for sid, s in STATIONS.items():
            st = self.st[sid]
            h = list(st["hist"])[-hist_n:]
            stations.append(dict(station_id=sid, name=s["name"], zone=s["zone"], lat=s["lat"], lon=s["lon"], district=s["district"],
                                 reading=st["latest"], external=st["ext_until"] > now,
                                 hist=dict(tick=[p["tick"] for p in h], level=[p["level"] for p in h], rain=[p["rain"] for p in h], risk=[p["risk"] for p in h])))
        zones = []
        for zone, description in ZONES.items():
            assets = ZONE_ASSETS[zone]
            siren_state = self.siren_state[zone]
            sensors = []
            for sensor in assets["sensors"]:
                live = self.st.get(sensor.get("station_id"))
                sensors.append({
                    **sensor,
                    "status": "online",
                    "source": "field feed" if live and live["ext_until"] > now else "simulated feed",
                    "risk_label": live["latest"]["risk_label"] if live and live["latest"] else "LOW",
                })
            sirens = [{
                **siren,
                "status": "active" if siren_state["active"] else "armed",
                "active": siren_state["active"],
            } for siren in assets["sirens"]]
            zones.append(dict(
                id=assets["id"], name=zone, description=description,
                sensor_nodes=sensors, siren_nodes=sirens,
                sensor_online=len(sensors), siren_online=len(sirens),
                siren_state=siren_state.copy(),
            ))
        return dict(simulation=True, server_time=datetime.now(timezone.utc).isoformat(), tick=self.tick,
                    tick_sim_min=TICK_SIM_MIN, sim_clock=self.sim_clock(), running=self.running, speed=self.speed,
                    scenario=dict(name=self.scenario, label=SCENARIOS[self.scenario], target=self.target, ticks=self.scn_tick),
                    stations=stations, zones=zones, events=self.events[-60:], fronts=self.fronts,
                    gateway=dict(status="online", received_packets=self.seq, connected_dashboards=clients))

    def config(self):
        return dict(stations={k: {kk: vv for kk, vv in v.items() if kk in ("name", "zone", "lat", "lon", "district", "base")} for k, v in STATIONS.items()},
                    edges=EDGES, zones=ZONES, zone_assets=ZONE_ASSETS, headwaters=HEADWATERS,
                    scenarios=SCENARIOS, wave_kmh=WAVE_KMH, tick_sim_min=TICK_SIM_MIN)
