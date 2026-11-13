"""MTE data acquisition service.

A web front end for the MTE scaler runner. It starts and stops the same C
program that has always been run by hand, reads the text files that program
flushes as it goes, and serves the result as a table and a chart -- plus the
run catalog, the setup profiles, and the past data the runner has already
written.

It talks to the module through the runner, never directly: one libusb handle
per module, held by the program that has held it all along.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response
from starlette.types import Scope

from . import device
from . import profiles as profile_store
from .acquisition import acquisition
from .config import RUNNER, RUN_ROOT, STATIC_DIR
from . import access, elog, elog_monitor
from .routers import control, history, profiles, status

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("mte")


class _QuietPolling(logging.Filter):
    """Keep the chart's window queries out of the access log.

    A browser following a live run re-reads its window every few seconds. At
    INFO that is a wall of identical lines and nothing else is readable.
    """

    QUIET = ("/api/live/", "/api/status", "/api/device")

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3:
            return not str(args[2]).startswith(self.QUIET)
        return True


logging.getLogger("uvicorn.access").addFilter(_QuietPolling())


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    RUN_ROOT.mkdir(parents=True, exist_ok=True)
    await status.broadcaster.start()
    try:
        yield
    finally:
        await status.broadcaster.stop()
        # A run must not outlive the service that is the only thing that knows
        # how to stop it cleanly.
        acquisition.shutdown()


app = FastAPI(
    title="MTE DAQ",
    description=(
        "Start, watch and stop MTE scaler runs from a browser. Counts per "
        "channel per counting period, time-stamp rates per channel, saved "
        "setup profiles, and every run the module has ever written."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# The Vite dev server runs on another port; in production the UI is same-origin
# and these headers are simply unused.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=(
        r"http://(localhost|127\.0\.0\.1"
        r"|10\.\d+\.\d+\.\d+"
        r"|192\.168\.\d+\.\d+"
        r"|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?"
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def control_gate(request: Request, call_next):
    """Monitoring callers may read everything and change nothing (access.py)."""
    if access.needs_control(request):
        caller = await run_in_threadpool(access.who, request)
        if not caller["control"]:
            return JSONResponse(
                status_code=403,
                content={"detail": "Monitoring only: running the DAQ needs a portal manager or an admin of this service."},
            )
    return await call_next(request)


@app.get("/api/me", tags=["meta"])
async def me(request: Request) -> dict:
    """Who is looking, and whether they may control (the page's mode switch)."""
    return await run_in_threadpool(access.who, request)


app.include_router(control.router)
app.include_router(history.router)
app.include_router(profiles.router)
app.include_router(status.router)
from .routers import live as _live  # noqa: E402
app.include_router(_live.router)
# This service is a LILAK elog SYSTEM: it answers the handshake and receives
# credentials here, and pushes run start/end from acquisition.py.
app.include_router(elog.router)
# The pull answer mte_monitoring gave (a SERVICE in elog), beside the SYSTEM one.
app.include_router(elog_monitor.router)
elog_monitor.bind(app)


@app.get("/api/health", tags=["meta"])
def health() -> dict:
    """Whether the service can do its job, without touching the module."""
    state = device.probe()
    return {
        "ok": state.ok,
        "module": {
            "present": state.present,
            "writable": state.writable,
            "node": state.node,
            "problems": state.problems,
            "remedy": state.remedy,
        },
        "runner": str(RUNNER),
        "run_root": str(RUN_ROOT),
        "profiles": [profile.id for profile in profile_store.load_all()],
        "acquisition": acquisition.state,
        "run_number": acquisition.number,
    }


class UiFiles(StaticFiles):
    """Serve the built UI, revalidating the entry point on every load.

    Vite fingerprints the asset filenames, so those can be cached hard. The
    HTML that points at them must not be, or a browser keeps running the
    previous build after a redeploy and calls endpoints that no longer exist.
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if path.endswith(".html") or path in ("", "."):
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        elif response.status_code == 200 and "/assets/" in scope.get("path", ""):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


if STATIC_DIR.is_dir():
    # Mounted last so it never shadows /api.
    app.mount("/", UiFiles(directory=STATIC_DIR, html=True), name="ui")
else:
    log.warning("Frontend build not found at %s - run `npm run build` in frontend/", STATIC_DIR)

    @app.get("/", tags=["meta"])
    def missing_ui() -> dict:
        return {
            "ok": False,
            "error": "Frontend is not built.",
            "hint": "cd frontend && npm install && npm run build",
            "api_docs": "/docs",
        }
