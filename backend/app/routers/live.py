"""GET /api/live -- a few compact numbers for the LILAK portal's live mode.

    {"ok": true, "items": [{"label", "value", "unit", "state", "sub"}]}

The run number (going, or the last one taken), plus one counter channel and
one time-stamp channel. WHICH channels is the profile's choice: its LIVE
button in the profile editor (`live_counter` / `live_trigger`); with none
chosen, the first selected channel of that kind. Assembled from state the
service already holds -- no hardware on the request path.
"""

from __future__ import annotations

from fastapi import APIRouter

from .. import profiles, runs
from ..acquisition import acquisition

router = APIRouter(tags=["live"])


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


def _pick(rows: list[dict], channel) -> dict | None:
    if not rows:
        return None
    return next((r for r in rows if r.get("channel") == channel), rows[0])


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

    row = _pick(snap.get("counters") or [], profile.get("live_counter_channel"))
    if row:
        items.append({"label": row.get("label") or f"ch{row.get('channel')}", "value": _num(row.get("rate")),
                      "unit": "cnt/s", "state": "running" if running else ""})
    row = _pick(snap.get("stamps") or [], profile.get("live_trigger_channel"))
    if row:
        rate = row.get("rate") if row.get("rate") is not None else row.get("hits_per_s", row.get("per_s"))
        items.append({"label": (row.get("label") or f"ch{row.get('channel')}") + " ts", "value": _num(rate, 1),
                      "unit": "/s", "state": "running" if running else ""})
    return {"ok": True, "items": items}
