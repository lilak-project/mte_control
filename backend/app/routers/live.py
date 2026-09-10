"""GET /api/live -- a few compact numbers for the LILAK portal's live mode.

    {"ok": true, "items": [{"label", "value", "unit", "state", "sub", "spark"}]}

The run number (going, or the last one taken), then one tile per channel the
profile marks LIVE in its editor (`live_channels`, scalers and triggers
alike, in the profile's own order); with none marked, the first counter and
the first trigger. Assembled from state the service already holds -- no
hardware on the request path.

Every channel tile carries an hour of its own rate as `spark`, drawn behind
the number by the portal. Both kinds of channel have one: a scaler's rate
comes from the counter buffers, a trigger's from the one-second time-stamp
bins.
"""

from __future__ import annotations

import math
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
_spark_cache: tuple[float, dict[str, dict[int, list[float]]]] = (0.0, {"counter": {}, "stamp": {}})
_spark_for: tuple[tuple[int, ...], tuple[int, ...]] = ((), ())


def _buckets(times, values, start, end, *, per_second):
    """`values` averaged into even buckets across [start, end], oldest first.

    Two different questions, so two different means. A **counter** sample is
    already a rate, and a bucket with no sample in it is a gap in the reading,
    not a quiet moment: those buckets carry the previous value forward. A
    **time-stamp** bin is a count of hits in one second, and a second with no
    bin is a second in which the channel did not fire: those buckets count as
    zero, and the bucket's total is divided by its width to stay hits a second.
    """
    span = end - start
    if span <= 0:
        return []
    width = span / SPARK_POINTS
    if per_second:
        width = max(width, 1.0)          # the bins are one second; nothing finer is true
    count = max(1, int(math.ceil(span / width)))
    sums = [0.0] * count
    seen = [0] * count
    for at, value in zip(times, values):
        index = int((at - start) / width)
        if 0 <= index < count:
            sums[index] += value
            seen[index] += 1
    if per_second:
        return [total / width for total in sums]
    out, carry = [], None
    for total, n in zip(sums, seen):
        if n:
            carry = total / n
        if carry is not None:            # nothing is drawn before the first sample
            out.append(carry)
    return out


def _sparks(counters: list[int], triggers: list[int], module_time: float) -> dict[str, dict[int, list[float]]]:
    """The last hour of rate for each live channel, from the run's own buffers.

    The window is in the RUN's clock, not the wall's: both buffers are keyed on
    seconds since the run began (that is what the module reports), so a window
    asked for in `time.time()` terms lands an epoch past the newest sample and
    comes back empty.
    """
    global _spark_cache, _spark_for
    now = time.monotonic()
    asked = (tuple(counters), tuple(triggers))
    if asked == _spark_for and now - _spark_cache[0] < SPARK_TTL:
        return _spark_cache[1]
    _spark_for = asked
    out: dict[str, dict[int, list[float]]] = {"counter": {}, "stamp": {}}
    end = max(module_time, 1.0)
    start = max(0.0, end - SPARK_WINDOW_SEC)
    try:
        if counters:
            # A large point budget so nothing is decimated on the way here; the
            # bucketing below is what reduces it, and min/max decimation would
            # hand it an envelope rather than the series.
            series = acquisition.series(counters, start, None, 100000)
            period = series.get("period") or 1.0
            for row in series.get("channels") or []:
                times = row.get("t") or []
                values = [float(v) / period for v in (row.get("v") or [])]
                points = _buckets(times, values, start, end, per_second=False)
                if len(points) >= 2:
                    out["counter"][row["channel"]] = points
        if triggers:
            wanted = set(triggers)
            for row in (acquisition.stamp_series(start, None, 100000).get("channels") or []):
                if row.get("channel") not in wanted:
                    continue
                points = _buckets(row.get("t") or [], row.get("v") or [], start, end, per_second=True)
                if len(points) >= 2:
                    out["stamp"][row["channel"]] = points
    except Exception:                      # no run yet, or a buffer being rebuilt
        out = {"counter": {}, "stamp": {}}
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
    picked = list(profile.get("live_shown") or [])
    sparks = _sparks([c for c in picked if c not in triggers],
                     [c for c in picked if c in triggers],
                     float(snap.get("module_time") or 0.0))
    for channel in picked:
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
                          "state": "running" if running else "",
                          "spark": sparks["stamp"].get(channel, []), "spark_window": "1 h"})
        else:
            items.append({"label": label, "value": _num((row or {}).get("rate")), "unit": "cnt/s",
                          "state": "running" if running else "",
                          "spark": sparks["counter"].get(channel, []), "spark_window": "1 h"})
    return {"ok": True, "items": items}
