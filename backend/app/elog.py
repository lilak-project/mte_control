"""This service as a LILAK elog SYSTEM.

A *service* answers when elog asks. A *system* also speaks first: it owns a run
and tells elog when one starts and when it ends, so the elog's run number and
the DAQ's run number are the same number by construction rather than by someone
retyping it.

mte_control is the system rather than mte_monitoring because only this process
knows when a run begins -- it spawns the runner. The mirror would have to poll
for the transition and would still be guessing.

Two directions on one endpoint, `POST /api/elog`:

    {"event": "elog_handshake"}    -> who we are (Discover, at registration)
    {"event": "elog_credentials"}  -> elog's address and our API token, saved

and one outbound call, `POST <elog>/api/logs` with that token, when a run
starts or ends.

**Nothing here may disturb a run.** elog being down, slow, or not yet
registered is the ordinary case, not an error: every push happens on its own
daemon thread and every failure is logged and dropped. A DAQ that refuses to
start because a logbook is unreachable would be a worse instrument.
"""

from __future__ import annotations

import json
import logging
import threading
import urllib.error
import urllib.request
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from . import portal_peer
from .config import DATA_DIR

log = logging.getLogger("mte.elog")

router = APIRouter(tags=["elog"])

#: Where elog's address and our token are kept. Written 0600: the token can
#: post logs as this system.
CREDENTIALS_FILE = DATA_DIR / "elog_credentials.json"

#: elog's own log_type map (routes/logs.py). Only the two boundaries are pushed
#: from here; Init and Monitoring are the operator's to write.
LOG_TYPE_START = 12
LOG_TYPE_END = 13

#: Long enough for a busy elog, short enough that a stuck one cannot pile up
#: threads across a shift.
TIMEOUT = 5.0

_lock = threading.Lock()


# ── Credentials ──────────────────────────────────────────────────────────────

def load_credentials() -> dict[str, str]:
    """elog's address and our token, or {} before registration."""
    try:
        data = json.loads(CREDENTIALS_FILE.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_credentials(elog_url: str, elog_token: str) -> None:
    with _lock:
        CREDENTIALS_FILE.parent.mkdir(parents=True, exist_ok=True)
        CREDENTIALS_FILE.write_text(
            json.dumps({"elog_url": elog_url, "elog_token": elog_token}, indent=2) + "\n"
        )
        try:
            CREDENTIALS_FILE.chmod(0o600)
        except OSError:                       # pragma: no cover - exotic filesystem
            log.warning("could not restrict permissions on %s", CREDENTIALS_FILE)


# ── The endpoint elog calls ──────────────────────────────────────────────────

@router.post("/api/elog", summary="LILAK elog handshake and credentials")
async def elog_endpoint(request: Request):
    try:
        envelope = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"detail": "body must be JSON"})
    if not isinstance(envelope, dict):
        return JSONResponse(status_code=400, content={"detail": "body must be a JSON object"})

    event = envelope.get("event")

    if event == "elog_handshake":
        log.info("elog handshake from %s", envelope.get("elog_url") or "?")
        import socket
        return {
            "name": "MTE",
            "description": "MTE DAQ — owns the run; pushes start and end to elog.",
            "hostname": socket.gethostname(),
            "directory": str(DATA_DIR.parent),
            # The whole point: elog creates the Init/Start/End/Monitoring run
            # formats for us and issues a token.
            "is_system": True,
            # Empty on purpose. A system's fields are the run formats elog seeds
            # itself; declaring more here would create a second, unused format.
            "log_fields": [],
        }

    if event == "elog_credentials":
        elog_url = str(envelope.get("elog_url") or "").strip()
        token = str(envelope.get("elog_token") or "").strip()
        if not elog_url or not token:
            return JSONResponse(status_code=400,
                                content={"detail": "elog_url and elog_token are both required"})
        save_credentials(elog_url, token)
        log.info("elog credentials stored; will push runs to %s", elog_url)
        return {"ok": True}

    return JSONResponse(
        status_code=400,
        content={"detail": f"unknown event {event!r}"},
    )


# ── Pushing a run boundary ───────────────────────────────────────────────────

def _post(log_type: int, run_number: int, title: str, body: str,
          fields: dict | None = None) -> None:
    """One log into elog. Runs on its own thread; never raises to the caller."""
    creds = load_credentials()
    url, token = creds.get("elog_url"), creds.get("elog_token")
    if not url or not token:
        log.debug("no elog credentials yet; run %s not pushed", run_number)
        return

    try:
        # Resolved per call: elog is portal-managed too, and its port is
        # assigned at start time (see portal_peer).
        target = portal_peer.resolve(url.rstrip("/")) + "/api/logs"
    except portal_peer.PortalPeerError as err:
        log.warning("cannot reach elog for run %s: %s", run_number, err)
        return

    envelope = {
        "title": title,
        "body": body,
        "log_type": log_type,
        "run_number": run_number,
        "is_auto": True,
    }
    if fields:
        envelope["format_fields"] = fields
    payload = json.dumps(envelope).encode("utf-8")
    request = urllib.request.Request(
        target, data=payload,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as answer:
            if answer.status not in (200, 201):
                log.warning("elog answered %s for run %s", answer.status, run_number)
            else:
                log.info("run %s: %s pushed to elog", run_number,
                         "start" if log_type == LOG_TYPE_START else "end")
    except (urllib.error.URLError, OSError, ValueError) as err:
        # The logbook being unreachable must never be the DAQ's problem.
        log.warning("could not push run %s to elog: %s", run_number, err)


def _push(log_type: int, run_number: int, title: str, body: str,
          fields: dict | None = None) -> None:
    threading.Thread(
        target=_post, args=(log_type, run_number, title, body, fields),
        name=f"elog-push-{run_number}", daemon=True,
    ).start()


# ── The fields the Start-of-run log carries ──────────────────────────────────
#
# These are the parameters a run was started with, as structured values rather
# than a paragraph, so they can be filtered and plotted. The keys must match the
# fields declared on the "Start of MTE run" format in elog -- a key the format
# does not declare is still stored, but nothing renders it.
#
# elog has exactly two custom field types, `text` and `number_entry`
# (frontend utils/formatUtils.js CUSTOM_FIELD_TYPES). There is no boolean and
# no list, so:
#   • a flag is text ("yes"/"no"), which also reads better in a logbook;
#   • a list of numbers is a number_entry in its `multiple` variant, whose
#     {"values": [...]} shape is a real array -- see utils_fields.py.
FIELD_KEYS = ("run_number", "note", "run_length_s", "monitoring", "active_channels")


def _number(value: float | int | None) -> dict:
    """One number_entry value, in the RAW single shape elog documents.

    Not the canonical {value, error}: elog stores whichever shape it is given
    as the field's `raw`, and the edit form re-renders a single-variant field
    from `raw.single`. Sending {value, error} displays correctly but opens for
    editing with an empty box.
    """
    return {"single": None if value is None else float(value)}


def _numbers(values) -> dict:
    """A list of numbers as a number_entry. elog keeps the list verbatim in
    `raw.values` and derives mean/stddev for the summary -- which for channel
    numbers is not a meaningful statistic, but the array itself is intact."""
    return {"values": [float(v) for v in (values or [])]}


def run_started(run_number: int, profile_name: str, name: str, note: str,
                acq_time_sec: int | None, count_period_ms: int | None,
                monitoring: bool = False,
                channels: dict[str, Any] | None = None) -> None:
    """Tell elog a run has begun. Called after the runner is up, not before:
    a run that failed to spawn is not a run.

    The parameters go up twice on purpose -- as `format_fields`, which are what
    a filter or a plot can reach, and as a body, which is what a shifter reads
    on a phone at three in the morning.
    """
    # The run's name is already the title; repeating it in the body only makes
    # the entry longer to read.
    triggers = list((channels or {}).get("trigger_channels") or [])
    counters = list((channels or {}).get("counter_channels") or [])

    lines = [f"profile: {profile_name}"]
    if acq_time_sec:
        lines.append(f"requested length: {acq_time_sec} s")
    if count_period_ms:
        lines.append(f"counting period: {count_period_ms} ms")
    lines.append(f"triggers: {', '.join(str(c) for c in triggers) or 'none'}")
    lines.append(f"scalers: {', '.join(str(c) for c in counters) or 'none'}")
    if note:
        lines.append("")
        lines.append(note)

    fields = {
        "run_number": _number(run_number),
        "note": note,
        "run_length_s": _number(acq_time_sec),
        "monitoring": "yes" if monitoring else "no",
        # Both halves of the module in the order the profile lists them:
        # which channels this run actually read.
        "active_channels": _numbers(triggers + counters),
    }
    _push(LOG_TYPE_START, run_number,
          name or f"Run {run_number}", "\n".join(lines), fields)


def run_ended(run_number: int, state: str, exit_code: int | None,
              elapsed: float | None, rows: int, stamp_events: int,
              files: dict[str, Any] | None = None, name: str = "") -> None:
    """Tell elog the run is over -- including when it failed, which is the case
    a logbook most needs to have caught."""
    lines = [f"outcome: {state}" + (f" (exit {exit_code})" if exit_code is not None else "")]
    if elapsed:
        lines.append(f"elapsed: {elapsed:,.0f} s")
    lines.append(f"counter rows: {rows:,}")
    lines.append(f"time stamps: {stamp_events:,}")
    if files:
        for key in ("counter_txt", "stamp_txt", "raw_dir"):
            if files.get(key):
                lines.append(f"{key}: {files[key]}")
    # The End log went up with an EMPTY title, so it showed as a blank row in the
    # logbook — the one entry you most want to spot. Same base as the Start log
    # (the run's name, else "Run N") so the pair reads together, plus the outcome,
    # which is the whole point of the end boundary.
    base = name or f"Run {run_number}"
    _push(LOG_TYPE_END, run_number, f"{base} — {state}", "\n".join(lines))
