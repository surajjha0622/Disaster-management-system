# Disaster management system

A focused, map-based early-warning simulation for a distributed flood-response network. The project uses simulated readings only: no external alert or siren is ever contacted.

## Run the simulation

Requires Python 3.10 or newer.

- **Windows:** double-click `start.bat`
- **Mac / Linux:** `./start.sh`
- **Manual:** `pip install -r requirements.txt` then `python run.py`

Open http://127.0.0.1:8000. The simulation works offline; only the optional street-map layer needs an internet connection.

## Single simulation workspace

The frontend intentionally contains one operational workspace rather than separate pages. It includes:

- A live flood simulation with Normal, Monsoon surge, Cloudburst, and Outburst flood scenarios.
- Flood-wave routing with downstream arrival estimates and alert acknowledgements.
- Five operational zones, each with five sensor nodes and three siren nodes distributed across the area.
- A **Node health** panel showing every sensor and siren node in each zone.
- A **Zone sirens** panel that activates or silences all simulated sirens in a selected zone.
- Sensor readings, historical chart, synthetic microphone display, event log, and a guided simulation.

Keyboard shortcuts: `Space` pauses or resumes the simulation; `M` toggles the dashboard alert sound.

## Connect a sensor feed

The gateway accepts the same packet format as the simulator. When a primary station receives an external packet, the simulator yields that station for 20 seconds and labels it as a field feed.

```bash
python tools/node_emulator.py --station FG-CHM-01 --mode ramp
```

The reference ESP32 sketch is in `firmware/esp32_node/`. It is a software integration reference only and has not been tested on hardware.

## PCB designs

`hardware/pcb_concepts/` is intentionally reserved for the PCB designs you will reuse from the other project. The frontend does not show a hardware or PCB page.

## Project layout

```
run.py                     launcher
backend/main.py            REST + WebSocket server and simulator host
backend/engine.py          simulation, zones, node health, siren state, alerts
frontend/                  single simulation workspace
tools/node_emulator.py     stand-in for a primary field sensor
firmware/esp32_node/       reference ESP32 integration sketch
hardware/pcb_concepts/     reserved for reused PCB designs
```

## API

`GET /api/state` · `GET /api/config` · `GET /api/events` · `GET /api/export.csv` · `POST /api/telemetry` · `POST /api/scenario {"name","station"}` · `POST /api/control {"running","speed"}` · `POST /api/reset` · `POST /api/zones/{zone_id}/sirens {"action":"activate|silence"}` · `POST /api/events/{id}/acknowledge` · `WS /ws`.

## Simulation limits

- Sensor readings, flood-wave routing, alerts, node health, and siren controls are simulated.
- River courses and node positions are schematic.
- The score thresholds and assumed wave speed are illustrative, not calibrated for operational public-safety use.
