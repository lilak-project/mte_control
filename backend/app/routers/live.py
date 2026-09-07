"""GET /api/live -- a few compact numbers for the LILAK portal's live mode.

    {"ok": true, "items": [{"label", "value", "unit", "state"}], "note": ""}

Assembled from state the service already holds; never touches hardware or a
remote host on the request path, so it is safe to poll every few seconds.
"""

from __future__ import annotations

from fastapi import APIRouter

from .. import runs
from ..acquisition import acquisition

router = APIRouter(tags=["live"])


def _num(v, digits=0):
    try:
        return f"{float(v):.{digits}f}"
    except (TypeError, ValueError):
        return "—"


@router.get("/api/live")
def live() -> dict:
    snap = acquisition.snapshot(average_seconds=10.0)
    state = snap.get("state") or "idle"
    running = state == "running"
    number = snap.get("run_number")
    if number is None:
        # A fresh process has taken no run yet; the newest on disk is the last run.
        try:
            profile = snap.get("profile") or {}
            pid = profile.get("id")
            numbers = runs.numbers_for(pid) if pid else set()
            if not numbers:
                numbers = {int(k.rsplit("/", 1)[-1]) for k in runs.load_index() if k.rsplit("/", 1)[-1].isdigit()}
            number = max(numbers) if numbers else None
        except Exception:
            number = None
    items = [{"label": "run" if running else "last run", "value": str(number if number is not None else "—"), "unit": "",
              "state": "running" if running else "idle", "sub": state}]
    counters = snap.get("counters") or []
    if counters:
        row = counters[0]                                 # the first selected counter channel
        items.append({"label": row.get("label") or f"ch{row.get('channel')}", "value": _num(row.get("rate")), "unit": "cnt/s", "state": "running" if running else ""})
    stamps = snap.get("stamps") or []
    if stamps:
        row = stamps[0]
        rate = row.get("rate") if row.get("rate") is not None else row.get("hits_per_s", row.get("per_s"))
        items.append({"label": (row.get("label") or f"ch{row.get('channel')}") + " ts", "value": _num(rate, 1), "unit": "/s", "state": "running" if running else ""})
    return {"ok": True, "items": items}
