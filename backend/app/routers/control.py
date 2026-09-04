"""The module, and the run in progress.

Every route here is about the present: is the module reachable, what is it
doing, start it, stop it. History is in `runs.py` and configuration is in
`setups.py`.
"""

from __future__ import annotations

import subprocess
import time

from fastapi import APIRouter, HTTPException, Query

from .. import archive, device, profiles
from ..acquisition import AcquisitionError, acquisition
from ..config import DEFAULT_MAX_POINTS, MAX_MAX_POINTS, RUNNER
from ..schemas import StartRequest
from ..profiles import ProfileError

router = APIRouter(prefix="/api", tags=["control"])


@router.get("/device")
def read_device() -> dict:
    """Is the module there, and may we open it?

    Answered from sysfs, so it costs nothing and is safe to ask while a run is
    in progress -- it does not touch the module, which the run is holding.
    """
    state = device.probe()
    return {
        "present": state.present,
        "ok": state.ok,
        "writable": state.writable,
        "node": state.node,
        "bus": state.bus,
        "address": state.address,
        "mode": state.mode,
        "owner": state.owner,
        "product": state.product,
        "manufacturer": state.manufacturer,
        "serial": state.serial,
        "runner": state.runner,
        "runner_ok": state.runner_ok,
        "problems": state.problems,
        "remedy": state.remedy,
        "busy": acquisition.running,
    }


@router.post("/device/test")
def test_device(
    profile_id: str | None = Query(None, description="Which profile to check the module against."),
) -> dict:
    """Actually open the module, briefly, and report what it said.

    The sysfs check above says the permissions are right; this says the module
    answers, and what it is currently configured as.

    It is not free, and cannot be made free. The runner reads a setup file
    before it touches USB at all, and once open it writes that setup into the
    module if the readback differs -- there is no setup-free way to ask the
    module anything. So this hands it the setup the next run would use: a
    module already configured that way is left exactly as it was, and one that
    is not is reported as having been changed rather than changed silently.

    It also costs a scaler reset, which is why it is refused while a run is in
    progress rather than being allowed to interrupt one.
    """
    if acquisition.running:
        raise HTTPException(409, "A run is in progress; stop it before testing the module.")

    state = device.probe()
    if not state.present:
        raise HTTPException(409, "The MTE module is not on the USB bus.")
    if not state.writable:
        raise HTTPException(403, f"{state.problems[0]}\n{state.remedy or ''}".strip())
    if not state.runner_ok:
        raise HTTPException(409, f"{RUNNER} is not an executable file. Build it: ./runner/build.sh")

    try:
        profile = profiles.require(profile_id)
        # The runner resolves a bare `setup.txt` against its working directory,
        # so both are given explicitly below. Getting that wrong is invisible
        # until a real module is on the other end, which is how it was found.
        setup_path = profiles.write_setup(profile)
    except ProfileError as err:
        raise HTTPException(422, str(err)) from err
    except OSError as err:
        raise HTTPException(500, f"Could not write the setup file: {err}") from err

    started = time.time()
    try:
        # --monitor writes no files and takes no run number; two seconds is
        # long enough for the open, the setup readback and one counting period.
        result = subprocess.run(
            [str(RUNNER), "--monitor", "2", "1000", "--setup", str(setup_path)],
            cwd=str(profile.directory),
            capture_output=True,
            text=True,
            timeout=30,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "The runner did not answer within 30 s.") from None
    except OSError as err:
        raise HTTPException(500, f"Could not run {RUNNER}: {err}") from err

    output = (result.stdout or "") + (result.stderr or "")
    lines = output.strip().splitlines()
    opened = "SCALER found" in output
    # The runner says "Initializing SCALER setup..." only when it had to write.
    rewrote = "Initializing SCALER setup" in output

    return {
        "ok": opened and result.returncode == 0,
        "opened": opened,
        "exit_code": result.returncode,
        "seconds": round(time.time() - started, 2),
        "setup": {
            "id": profile.id,
            "name": profile.name,
            "rewrote": rewrote,
            "mismatches": [line for line in lines if line.startswith("Setup mismatch")],
        },
        "readback": [line for line in lines if " = " in line],
        "output": lines,
    }


@router.get("/status")
def read_status(
    average: float = Query(60.0, ge=1, le=86400, description="Trailing seconds the means cover."),
) -> dict:
    """The run in progress, its channels, and the means over a chosen window."""
    return acquisition.snapshot(average_seconds=average)


@router.post("/run/start")
def start_run(request: StartRequest) -> dict:
    try:
        return acquisition.start(
            name=request.name,
            note=request.note,
            run_number=request.run_number,
            acq_time_sec=request.acq_time_sec,
            count_period_ms=request.count_period_ms,
            profile_id=request.profile_id,
            monitor=request.monitor,
            force_init=request.force_init,
        )
    except ProfileError as err:
        raise HTTPException(422, str(err)) from err
    except AcquisitionError as err:
        raise HTTPException(409, str(err)) from err


@router.post("/run/stop")
def stop_run() -> dict:
    try:
        snapshot = acquisition.stop()
    except AcquisitionError as err:
        raise HTTPException(409, str(err)) from err
    # The files have just been closed; anything cached about this run predates
    # the last flush.
    archive.invalidate()
    return snapshot


@router.get("/live/counters")
def live_counters(
    channels: str = Query("", description="Comma-separated, e.g. 13,14,15. Empty means all."),
    start: float | None = Query(None, description="Module clock, seconds since the run began."),
    end: float | None = None,
    max_points: int = Query(DEFAULT_MAX_POINTS, ge=10, le=MAX_MAX_POINTS),
) -> dict:
    return acquisition.series(_channels(channels), start, end, max_points)


@router.get("/live/stamps")
def live_stamps(
    start: float | None = None,
    end: float | None = None,
    max_points: int = Query(DEFAULT_MAX_POINTS, ge=10, le=MAX_MAX_POINTS),
) -> dict:
    return acquisition.stamp_series(start, end, max_points)


def _channels(text: str) -> list[int]:
    """The channels asked for, or the running profile's own when none are.

    Defaulting to the profile rather than to all ten is what keeps a chart from
    opening on six flat lines the experiment does not use.
    """
    from ..config import COUNTER_CHANNELS

    if not text.strip():
        profile = acquisition.profile
        return profile.counter_channels if profile else list(COUNTER_CHANNELS)
    wanted = []
    for part in text.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            wanted.append(int(part))
        except ValueError:
            raise HTTPException(422, f"{part!r} is not a channel number.") from None
    return wanted
