"""The LILAK elog endpoint: one POST that answers both of elog's questions.

elog talks to a service through a single URL. Two different bodies arrive on it:

    {"event": "elog_handshake", "elog_url": …}
        -> who we are and what fields we can fill (Discover, once, at registration)

    {"format_id", "format_name", "task_log_id", "run_number", "requested_at", "mode"}
        -> the values themselves (every fill, on a task or on a schedule)

Two rules shape everything below.

**Five seconds.** elog gives up after that (`WEBHOOK_TIMEOUT_SEC`) and turns the
task into a manual one with the error as a comment. `mode` may also be
"realtime", which repeats as often as twice a second. So a reader here must be
cheap and must never block on hardware it does not already hold.

**The field list follows the PROFILE, and nothing else.** elog builds a log
format from `log_fields` at registration and matches it later by name *and*
field signature: declare a different set and a second format appears rather
than the first one changing. So the list must come from configuration -- never
from what happens to be plugged in or reporting at this instant, or unplugging
a cable would fork the format.

A profile is configuration: somebody chose those channels and saved them. It is
also the only honest answer to "what does this run measure". Declaring all
twenty slots instead kept one format forever, at the price of fourteen columns
of null in every sheet and every log of a six-channel experiment. Changing
profile now does fork the format -- which is the true statement about it, since
a different set of channels IS a different measurement.

Copied into each service rather than shared from one place: these services are
each movable as a single folder (SERVICE_CONTRACT §9), and a shared import
would tie them together at runtime for eighty lines.
"""

from __future__ import annotations

import logging
import socket
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("elog")

HANDSHAKE = "elog_handshake"

#: A field elog can put on a log format.
#: `type` is one of number_entry | number | text | body | title | tags | level.
#: `metric` (number types only) makes it an Infography variable.
Field = dict[str, Any]


def number(key: str, label: str, unit: str = "", metric: bool = True) -> Field:
    """A numeric field. number_entry is the shape elog normalises to {value,error}."""
    return {"key": key, "label": label, "type": "number_entry", "unit": unit, "metric": metric}


def text(key: str, label: str) -> Field:
    return {"key": key, "label": label, "type": "text"}


def body(label: str = "Summary") -> Field:
    return {"key": "body", "label": label, "type": "body"}


def value(number_value: float | None, error: float = 0.0) -> dict:
    """One number_entry value. None stays None -- a channel that reported
    nothing is not the same as one that reported zero."""
    return {"value": None if number_value is None else float(number_value), "error": error}


def make_router(
    *,
    service_name: str,
    description: str,
    log_fields: list[Field] | Callable[[], Awaitable[list[Field]]],
    read: Callable[[dict], Awaitable[dict]],
    directory: str = "",
    path: str = "/api/elog",
) -> APIRouter:
    """The endpoint. `read(envelope)` returns the `fields` dict for one request.

    `log_fields` is normally a plain list -- a constant, which is what the
    "fixed field list" rule above asks for. It may instead be an async callable
    for a service whose fields come from its own saved configuration (which
    actuators are set up, say). That is still configuration and still stable;
    it just cannot be written down at import time. Such a callable should RAISE
    rather than return a short list when it cannot read that configuration, so
    Discover fails loudly instead of quietly registering half a format.

    Mount this BEFORE any catch-all `/api/{path}` route: FastAPI matches in
    registration order, and the read-only mirrors answer 405 to every POST they
    do not recognise -- including this one.
    """
    router = APIRouter(tags=["elog"])

    @router.post(path, summary="LILAK elog handshake and data request")
    async def elog_endpoint(request: Request):
        try:
            envelope = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={"detail": "body must be JSON"})
        if not isinstance(envelope, dict):
            return JSONResponse(status_code=400, content={"detail": "body must be a JSON object"})

        event = envelope.get("event")
        if event == HANDSHAKE:
            log.info("elog handshake from %s", envelope.get("elog_url") or "?")
            try:
                fields = log_fields if isinstance(log_fields, list) else await log_fields()
            except Exception as err:
                log.warning("handshake refused: %s", err)
                return JSONResponse(status_code=503, content={"detail": str(err)})
            return {
                "name": service_name,
                "description": description,
                "hostname": socket.gethostname(),
                "directory": directory,
                # A service, not a system: elog asks us, we never push runs at it.
                "is_system": False,
                "log_fields": fields,
            }
        if event:
            # Only the handshake is an event. Anything else is a system-only
            # message (elog_credentials) or a typo, and answering it with
            # readings would be worse than saying so.
            return JSONResponse(
                status_code=400,
                content={"detail": f"unknown event {event!r}; this is a plain service, not a system"},
            )

        fields = await read(envelope)
        return {"fields": fields}

    return router


# ── This service's answer ────────────────────────────────────────────────────

import asyncio                                                     # noqa: E402

import httpx                                                       # noqa: E402

#: In-process: the monitoring answer asks this service's own endpoints through
#: ASGI, no network -- the same reads mte_monitoring made over HTTP before the
#: two services merged. Set by main.py once the app exists.
client: httpx.AsyncClient | None = None
TIMEOUT = 2.0


from .config import COUNTER_CHANNELS, TRIGGER_CHANNELS          # noqa: E402


def control_url() -> str:
    return ""


def bind(app) -> None:
    global client
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://mte")


async def _selected() -> tuple:
    """(trigger channels, scaler channels, their names) from the ACTIVE profile.

    Falls back to every slot when the control service cannot be reached: a
    handshake that quietly declared nothing would produce a log format with no
    channels at all, and a format is not something you notice is wrong until
    the run it was meant to record is over.
    """
    try:
        profile = (await _get("/api/status")).get("profile") or {}
        selected = [int(c) for c in (profile.get("selected") or [])]
        names = {int(k): v for k, v in (profile.get("names") or {}).items()}
    except (httpx.HTTPError, ValueError, TypeError, KeyError, RuntimeError):
        selected, names = [], {}
    if not selected:
        selected, names = list(TRIGGER_CHANNELS) + list(COUNTER_CHANNELS), {}
    return ([c for c in selected if c in TRIGGER_CHANNELS],
            [c for c in selected if c in COUNTER_CHANNELS],
            names)


async def log_fields() -> list:
    """The channels this profile reads, named as the profile names them.

    Resolved per registration rather than held as a constant, so re-registering
    after a profile change declares the channels that change actually selected.
    The profile's own names travel with them — "ch9 Compass" says what the
    number never could, and the person reading the logbook did not choose the
    numbering.
    """
    triggers, scalers, names = await _selected()
    def label(ch: int, kind: str) -> str:
        name = names.get(ch)
        return f"ch{ch} {name}" if name else f"{kind} ch{ch}"
    return (
        [number("run_number", "Run number", "", metric=False)]
        + [number(f"trig_ch{ch}", f"{label(ch, 'Trigger')} (mean rate)", "counts/s")
           for ch in triggers]
        + [number(f"scaler_ch{ch}", f"{label(ch, 'Scaler')} (mean)", "counts")
           for ch in scalers]
        + [text("data_file", "Counter file"),
           text("raw_dir", "Run directory"),
           body("Channels this run reads")]
    )


async def _get(path: str) -> dict:
    """Ask the control service. Two seconds, not the usual sixty: elog gives up
    at five, and a partial log entry is worse than a late one."""
    if client is None:                       # pragma: no cover - lifespan sets it
        raise RuntimeError("the HTTP client is not ready yet")
    response = await client.get(f"{control_url()}{path}", timeout=min(TIMEOUT, 2.0))
    response.raise_for_status()
    return response.json()


async def _files(profile_id: str, run_number: int | None) -> dict:
    """Where the run's files are. Absent for a run that has not been catalogued
    yet, which is not an error -- the counters are still worth logging."""
    if not profile_id or run_number is None:
        return {}
    try:
        run = await _get(f"/api/profiles/{profile_id}/runs/{run_number}")
    except (httpx.HTTPError, ValueError):
        return {}
    return run.get("files") or {}


async def read(envelope: dict) -> dict:
    """Each trigger's mean rate and each scaler's mean, plus where the data went.

    Which mean depends on whether the run is still going. A live run is
    averaged over the window the control service is already keeping (`mean`);
    a finished one reports its whole-run mean (`run_mean`), because "the mean
    over the last minute of a run that ended an hour ago" is not a number
    anybody wants in a logbook.
    """
    try:
        status = await _get("/api/status")
    except httpx.HTTPError as err:
        raise RuntimeError(
            f"The MTE status could not be read ({err})."
        ) from err

    running = status.get("state") == "running"
    profile = status.get("profile") or {}
    run_number = status.get("run_number")
    files = await _files(profile.get("id") or "", run_number)

    fields: dict = {"run_number": value(run_number)}

    # The same channels the format declares, and only those. Emitting all twenty
    # against a six-channel format would push fourteen fields the format has no
    # definition for — elog stores them anyway, labelled by their raw key, which
    # is the clutter this profile-shaped format exists to remove.
    triggers, scalers, _names = await _selected()

    # Declared slots start null, so a channel the profile selects but that has
    # not reported yet is null rather than absent.
    for channel in triggers:
        fields[f"trig_ch{channel}"] = value(None)
    for channel in scalers:
        fields[f"scaler_ch{channel}"] = value(None)

    lines = []
    for row in status.get("stamps") or []:
        channel = row.get("channel")
        if channel not in triggers:
            continue                          # not a trigger slot this profile reads
        rate = row.get("mean_rate")
        fields[f"trig_ch{channel}"] = value(rate)
        lines.append(f"trigger ch{channel:<3} {row.get('label',''):<24} "
                     f"{_fmt(rate):>12} counts/s   total {row.get('total', 0)}")

    for row in status.get("counters") or []:
        channel = row.get("channel")
        if channel not in scalers:
            continue
        mean = row.get("mean") if running else row.get("run_mean")
        fields[f"scaler_ch{channel}"] = value(mean)
        lines.append(f"scaler  ch{channel:<3} {row.get('label',''):<24} "
                     f"{_fmt(mean):>12} counts     latest {_fmt(row.get('count'))}")

    if not lines:
        lines.append("No channel has reported yet.")
    window = status.get("average_seconds")
    lines.append("")
    lines.append(
        f"run {run_number} ({status.get('state')}), profile {profile.get('name') or '?'}; "
        + (f"means over the last {window:g} s" if running else "means over the whole run")
    )

    fields["data_file"] = files.get("counter_txt") or ""
    fields["raw_dir"] = files.get("raw_dir") or ""
    # Fenced, like actuator_monitoring's. elog renders a body as Markdown, which
    # folds every run of spaces and every single newline into one space — the
    # aligned columns above arrive as one long line without it. Inside a fence
    # they are reproduced character for character.
    fields["body"] = "```\n" + "\n".join(lines) + "\n```"
    return fields


def _fmt(number_value) -> str:
    return "—" if number_value is None else f"{number_value:,.3f}"


router = make_router(
    # Name and path kept apart from the SYSTEM endpoint (elog.py, /api/elog):
    # this is the pull service mte_monitoring registered,
    # under the same name, so its formats keep filling after Discover.
    service_name="MTE Monitoring",
    path="/api/elog/monitor",
    description="MTE counters — each trigger's mean rate, each scaler's mean, and the run's data files.",
    log_fields=log_fields,
    read=read,
)
