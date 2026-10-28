"""Disaster management system gateway, simulator, and dashboard host.

Run:  python run.py        (or)   uvicorn backend.main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .engine import ALIASES, SCENARIOS, STATIONS, Engine

ROOT = Path(__file__).resolve().parent.parent
engine = Engine()
clients: set[WebSocket] = set()


async def broadcast():
    if not clients:
        return
    payload = json.dumps({"type": "state", "state": engine.snapshot(len(clients))})
    dead = []
    for ws in list(clients):
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


async def sim_loop():
    while True:
        interval = 1.0 / max(0.25, engine.speed)
        await asyncio.sleep(interval)
        if engine.running:
            engine.step()
            await broadcast()


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(sim_loop())
    yield
    task.cancel()


app = FastAPI(title="Disaster management system", version="1.1.0-sim", lifespan=lifespan)


class Telemetry(BaseModel):
    station_id: str
    zone: str = "Unassigned"
    timestamp: str | None = None
    audio_class: Literal["rain_like", "flowing_water", "wind_noise", "background", "unknown"] = "unknown"
    rainfall_mm_h: float = Field(ge=0, le=500)
    wind_speed_m_s: float = Field(ge=0, le=100)
    water_level_cm: float = Field(ge=0, le=2000)
    water_level_change_cm_10m: float = Field(ge=-500, le=500)
    source: Literal["simulated", "prototype_sensor"] = "simulated"


class ScenarioReq(BaseModel):
    name: str
    station: str | None = None


class ControlReq(BaseModel):
    running: bool | None = None
    speed: float | None = Field(default=None, ge=0.25, le=8)


class SirenControlReq(BaseModel):
    action: Literal["activate", "silence"]


@app.get("/health")
def health():
    return {"status": "ok", "simulation": True, "received_packets": engine.seq, "tick": engine.tick}


@app.get("/api/config")
def config():
    return engine.config()


@app.get("/api/state")
def state():
    return engine.snapshot(len(clients))


@app.get("/api/events")
def events():
    return {"simulation": True, "events": engine.events[-100:]}


@app.get("/api/export.csv")
def export_csv():
    buf = io.StringIO()
    cols = ["packet_number", "timestamp", "station_id", "zone", "audio_class", "rainfall_mm_h", "wind_speed_m_s",
            "water_level_cm", "water_level_change_cm_10m", "risk_score", "risk_label", "source"]
    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    w.writerows(engine.log)
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": "attachment; filename=disaster_management_system_telemetry.csv"})


@app.post("/api/telemetry")
async def ingest(p: Telemetry):
    """Accepts packets from real nodes (ESP32 firmware) or the external simulator script.
    While a station is fed externally, the built-in simulator yields that station for 20 s."""
    if p.station_id not in STATIONS:
        raise HTTPException(404, "Unknown station_id. Add it to STATIONS in backend/engine.py first.")
    st = engine.st[p.station_id]
    st["ext_until"] = time.time() + 20
    r = engine.ingest(p.station_id, p.rainfall_mm_h, p.wind_speed_m_s, p.water_level_cm,
                      p.water_level_change_cm_10m, p.audio_class, source=p.source, timestamp=p.timestamp)
    await broadcast()
    return {"accepted": True, "packet_number": r["packet_number"], "risk_score": r["risk_score"],
            "risk_label": r["risk_label"], "simulation": True}


@app.post("/api/scenario")
async def scenario(req: ScenarioReq):
    name = ALIASES.get(req.name, req.name)
    if name not in SCENARIOS:
        raise HTTPException(400, f"Unknown scenario. Use one of {list(SCENARIOS)}")
    engine.set_scenario(name, req.station)
    await broadcast()
    return {"ok": True, "scenario": engine.scenario, "target": engine.target}


@app.post("/api/control")
async def control(req: ControlReq):
    if req.running is not None:
        engine.running = req.running
    if req.speed is not None:
        engine.speed = req.speed
    await broadcast()
    return {"ok": True, "running": engine.running, "speed": engine.speed}


@app.post("/api/reset")
async def reset():
    engine.reset()
    await broadcast()
    return {"ok": True}


@app.post("/api/zones/{zone_id}/sirens")
async def control_zone_sirens(zone_id: str, req: SirenControlReq):
    """Control all simulated siren nodes in one operational zone."""
    try:
        zone, state = engine.control_sirens(zone_id, req.action)
    except ValueError:
        raise HTTPException(404, "Unknown zone")
    await broadcast()
    return {"ok": True, "zone": zone, "action": req.action, "state": state, "simulation": True}


@app.post("/api/events/{event_id}/acknowledge")
async def acknowledge(event_id: str):
    for e in engine.events:
        if e["id"] == event_id:
            e["acknowledged"] = True
            await broadcast()
            return {"accepted": True, "event": e}
    raise HTTPException(404, "Event not found")


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    try:
        await ws.send_text(json.dumps({"type": "state", "state": engine.snapshot(len(clients))}))
        while True:
            await ws.receive_text()
    except (WebSocketDisconnect, Exception):
        clients.discard(ws)


# Static dashboard (must be mounted last).
app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
