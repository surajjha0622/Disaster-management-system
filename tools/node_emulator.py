"""Pretend to be ONE real sensor node posting to the gateway (standard library only).

While this runs, the dashboard marks that station "Real node" and the built-in simulator
steps aside for it. Useful to prove the hardware path before the ESP32 is built.

  python tools/node_emulator.py --station FG-CHM-01 --mode ramp
  python tools/node_emulator.py --station FG-UTK-03 --mode calm --url http://192.168.1.20:8000
"""
import argparse, json, random, time, urllib.request, urllib.error
from datetime import datetime, timezone

ap = argparse.ArgumentParser()
ap.add_argument("--station", default="FG-CHM-01")
ap.add_argument("--mode", choices=["calm", "ramp"], default="calm", help="ramp = water climbs ~18 cm every packet")
ap.add_argument("--interval", type=float, default=2.0)
ap.add_argument("--url", default="http://127.0.0.1:8000")
a = ap.parse_args()

level, prev, n = 38.0, 38.0, 0
print(f"Emulating {a.station} -> {a.url}/api/telemetry  (Ctrl+C to stop)")
while True:
    n += 1
    if a.mode == "ramp":
        level = min(190.0, level + 18 + random.uniform(-2, 3))
        rain = min(60.0, 4 + n * 3.5)
        audio = "flowing_water" if level > 80 else "rain_like"
    else:
        level = 38 + random.uniform(-1.5, 1.5)
        rain, audio = random.uniform(0, 3), random.choice(["background", "background", "rain_like"])
    pkt = dict(station_id=a.station, timestamp=datetime.now(timezone.utc).isoformat(), audio_class=audio,
               rainfall_mm_h=round(rain, 1), wind_speed_m_s=round(random.uniform(0.5, 4), 1),
               water_level_cm=round(level, 1), water_level_change_cm_10m=round(level - prev, 1), source="prototype_sensor")
    prev = level
    req = urllib.request.Request(a.url + "/api/telemetry", json.dumps(pkt).encode(), {"Content-Type": "application/json"})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=3))
        print(f"{a.station} level={pkt['water_level_cm']:>6} cm rain={pkt['rainfall_mm_h']:>5} -> score {r['risk_score']} {r['risk_label']}")
    except (urllib.error.URLError, OSError) as e:
        print("Gateway not reachable:", e)
    time.sleep(a.interval)
