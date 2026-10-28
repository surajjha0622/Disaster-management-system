# Judge demo script (about 3 minutes)

**Before you start:** run `start.bat`, open the dashboard full-screen (F11), set the browser zoom so the map and right panel both fit. Keep `python tools/node_emulator.py` ready in a second terminal.

## Option A: press "Run guided simulation" (76 s)
It resets the network, runs a cloudburst at Chamoli, then an outburst flood at Joshimath, with on-screen narration. Talk over it using the lines below.

## Option B: drive it yourself

1. **The problem (20 s).** "Flash floods in Uttarakhand can reach towns hours after the trigger upstream, but warning usually starts when the water arrives. Our nodes sit along the river and warn the towns below."
2. **Normal state (15 s).** Point at the 10 primary feeds and the zone coverage list. "Each zone has a distributed group of sensor nodes and siren nodes; the primary river feeds drive the flood simulation."
3. **Cloudburst (45 s).** Select *Chamoli*, click *Cloudburst*. "One reading later the node goes High. The red front is the flood wave. Each node downstream gets a countdown."
4. **Outburst with no rain (45 s).** Click *Reset*, select *Joshimath*, click *Outburst flood*. Open the *Sensor* tab. "No rain here, so a rain gauge alone would miss it. The rate of rise and the sound of fast water give it away."
5. **Alert (20 s).** Open *Alerts*. Show the flood path, the messages an operator would send, and click *Acknowledge*.
6. **Node health and sirens (30 s).** Open *Node health* and show the sensor and siren nodes for a zone. Open *Sirens* and activate then silence that zone. "These controls are simulated only, but every zone has a controllable siren group."
7. **External sensor feed (20 s).** Run `python tools/node_emulator.py --station FG-UTK-03 --mode ramp`. Uttarkashi switches to a field feed and raises an alert from the incoming packets.

## Likely questions

**Is this real data?** No. Readings, node health, and siren controls are simulated. The gateway, scoring, routing and dashboard software are real.

**How accurate is the ETA?** It is river length divided by an assumed 18 km/h wave speed. A field pilot would calibrate speed per reach from gauge records.

**Is the score machine learning?** No. It is a transparent weighted rule set so every alert can be explained. With real data it could be tuned or replaced.

**Why a microphone?** Fast, turbulent water changes the river's sound before the level gauge shows a large change, and it helps tell rain from river noise. On the dashboard the microphone class is simulated and the spectrogram is illustrative.

**What if there is no Wi-Fi in the valley?** First version uses Wi-Fi/LAN. The next step is LoRa links to a gateway.

**Who receives the alerts?** In the demo nobody. A real deployment would agree the channel with the district disaster management office first.

**What would a pilot need?** One node at a gauged river site logging next to the official gauge, then threshold tuning on that record.
