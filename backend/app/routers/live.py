"""GET /api/live -- a few compact numbers for the LILAK portal's live mode.

    {"ok": true, "items": [{"label", "value", "unit", "state", "sub"}]}

The run number (going, or the last one taken), then one tile per channel the
profile marks LIVE in its editor (`live_channels`, scalers and triggers
alike, in the profile's own order); with none marked, the first counter and
the first trigger. Assembled from state the
service already holds -- no hardware on the request path.
"""

from __future__ import annotations

import time

from fastapi import APIRouter

from .. import profiles, runs
from ..acquisition import acquisition

router = APIRouter(tags=["live"])

#: How much of the past a tile's sparkline shows, with how many points, and how
#: often it is recomputed however fast the wall polls.
SPARK_WINDOW_SEC = 3600.0
SPARK_POINTS = 60
SPARK_TTL = 15.0
_spark_cache: tuple[float, dict[int, list[float]]] = (0.0, {})


def _sparks(channels: list[int]) -> dict[int, list[float]]:
    """The last hour of counter rate for each channel, from the live buffers.

    Counter buffers hold counts per counting period; the tile shows a rate, so
    the series is divided by the period to match the number in front of it.
    """
    global _spark_cache
    now = time.monotonic()
    if now - _spark_cache[0] < SPARK_TTL:
        return _spark_cache[1]
    out: dict[int, list[float]] = {}
    if channels:
        try:
            series = acquisition.series(channels, time.time() - SPARK_WINDOW_SEC, None, SPARK_POINTS)
            period = series.get("period") or 1.0
            for row in series.get("channels") or []:
                values = [float(v) / period for v in (row.get("v") or []) if v is not None]
                if len(values) >= 2:
                    out[row["channel"]] = values
        except Exception:                  # no run yet, or a buffer being rebuilt
            out = {}
    _spark_cache = (now, out)
    return out


def _num(value, digits=0):
    try:
        return f"{float(value):.{digits}f}"
    except (TypeError, ValueError):
        return "—"


def _profile(snap: dict) -> dict:
    """The run's profile while one is loaded; otherwise the most recently saved
    one, which is the experiment the UI opens on."""
    live = snap.get("profile")
    if live:
        return live
    try:
        saved = profiles.load_all()
    except profiles.ProfileError:
        return {}
    return saved[0].to_json() if saved else {}


def _row(rows: list[dict], channel) -> dict | None:
    return next((r for r in rows if r.get("channel") == channel), None)


@router.get("/api/live")
def live() -> dict:
    snap = acquisition.snapshot(average_seconds=10.0)
    state = snap.get("state") or "idle"
    running = state == "running"
    profile = _profile(snap)

    number = snap.get("run_number")
    if number is None:
        # A fresh process has taken no run yet; the newest on disk is the last run.
        try:
            pid = profile.get("id")
            numbers = runs.numbers_for(pid) if pid else set()
            if not numbers:
                numbers = {int(k.rsplit("/", 1)[-1]) for k in runs.load_index() if k.rsplit("/", 1)[-1].isdigit()}
            number = max(numbers) if numbers else None
        except Exception:
            number = None

    items = [{"label": "run" if running else "last run", "value": str(number if number is not None else "—"),
              "unit": "", "state": "running" if running else "idle", "sub": profile.get("name") or state}]

    counters, stamps = snap.get("counters") or [], snap.get("stamps") or []
    labels = profile.get("labels") or {}
    triggers = set(profile.get("trigger_channels") or [])
    shown = [c for c in (profile.get("live_shown") or []) if c not in triggers]
    sparks = _sparks(shown)
    for channel in profile.get("live_shown") or []:
        # A chosen channel keeps its tile whether or not there is a run: between
        # runs the wall should show the same set of numbers, at "—", rather than
        # rearranging itself every time the DAQ starts and stops.
        stamp = channel in triggers
        row = _row(stamps if stamp else counters, channel)
        label = (row or {}).get("label") or labels.get(str(channel)) or f"Ch{channel}"
        if stamp:
            rate = (row or {}).get("rate")
            if rate is None and row:
                rate = row.get("hits_per_s", row.get("per_s"))
            items.append({"label": f"{label} ts", "value": _num(rate, 1), "unit": "/s",
                          "state": "running" if running else ""})
        else:
            items.append({"label": label, "value": _num((row or {}).get("rate")), "unit": "cnt/s",
                          "state": "running" if running else "",
                          "spark": sparks.get(channel, []), "spark_window": "1 h"})
    return {"ok": True, "items": items}
