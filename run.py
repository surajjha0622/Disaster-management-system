"""One-command launcher: python run.py  ->  dashboard at http://127.0.0.1:8000"""
import argparse
import socket
import threading
import time
import webbrowser

import uvicorn


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    print("\n  Disaster management system  (simulation)\n  -----------------------------------------")
    print(f"  Dashboard : http://127.0.0.1:{a.port}")
    print(f"  On your LAN (nodes / phones): http://{lan_ip()}:{a.port}   -> POST /api/telemetry")
    print("  Press Ctrl+C to stop.\n")
    if not a.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(f"http://127.0.0.1:{a.port}")).start()
    uvicorn.run("backend.main:app", host="0.0.0.0", port=a.port, log_level="warning")
