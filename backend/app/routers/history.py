"""Past runs: what exists, what is in it, and the files themselves."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse

from .. import archive, runs
from ..config import DEFAULT_MAX_POINTS, MAX_MAX_POINTS
from ..schemas import RenameRequest

#: Runs are addressed by profile and number, because that pair is what
#: identifies one: numbering restarts inside each profile.
router = APIRouter(prefix="/api/profiles/{profile_id}/runs", tags=["runs"])


@router.get("")
def list_runs(
    profile_id: str,
    limit: int = Query(500, ge=1, le=5000),
    search: str = Query("", description="Matches the name, the note, or the number."),
) -> dict:
    found = runs.list_runs(profile_id, limit=limit, search=search)
    return {
        "profile_id": profile_id,
        "runs": [run.to_json() for run in found],
        "directory": str(runs.profile_dir(profile_id)),
        "next_number": runs.next_number(profile_id),
        "total": len(runs.numbers_for(profile_id)),
    }


@router.get("/{number}")
def read_run(profile_id: str, number: int) -> dict:
    run = _find(profile_id, number)
    body = run.to_json()
    if run.files.counter_txt:
        body["counters"] = archive.counter_summary(Path(run.files.counter_txt), run.count_period_ms)
    if run.files.stamp_txt:
        body["stamps"] = archive.stamp_summary(Path(run.files.stamp_txt))
    return body


@router.patch("/{number}")
def rename_run(profile_id: str, number: int, request: RenameRequest) -> dict:
    """Give a run a name, or change one.

    Metadata only: no file is moved or rewritten, so a run can be named long
    after it was taken and the paths in anyone's notes still resolve.
    """
    _find(profile_id, number)
    runs.rename(profile_id, number, name=request.name, note=request.note)
    return read_run(profile_id, number)


@router.get("/{number}/counters")
def run_counters(
    profile_id: str,
    number: int,
    channels: str = Query("", description="Comma-separated, e.g. 13,14. Empty means all."),
    start: float | None = Query(None, description="Module clock, seconds since the run began."),
    end: float | None = None,
    max_points: int = Query(DEFAULT_MAX_POINTS, ge=10, le=MAX_MAX_POINTS),
) -> dict:
    run = _find(profile_id, number)
    if not run.files.counter_txt:
        raise HTTPException(404, f"Run {number} has no converted counter file.")
    wanted = [int(part) for part in channels.split(",") if part.strip().isdigit()]
    # The profile the run was taken with names its channels; today's profile
    # may have been re-pointed since, so the run's own copy is what is used.
    labels = _labels(run)
    if not wanted:
        wanted = [int(c) for c in (run.profile or {}).get("counter_channels", [])]
    return archive.counter_series(
        Path(run.files.counter_txt), wanted, start, end, max_points, labels=labels
    )


@router.get("/{number}/stamps")
def run_stamps(
    profile_id: str,
    number: int,
    start: float | None = None,
    end: float | None = None,
    max_points: int = Query(DEFAULT_MAX_POINTS, ge=10, le=MAX_MAX_POINTS),
) -> dict:
    run = _find(profile_id, number)
    if not run.files.stamp_txt:
        raise HTTPException(404, f"Run {number} has no converted time-stamp file.")
    return archive.stamp_series(
        Path(run.files.stamp_txt), start, end, max_points, labels=_labels(run)
    )


def _labels(run: runs.Run) -> dict[int, str]:
    """Channel -> the name it had when this run was taken."""
    saved = (run.profile or {}).get("labels") or {}
    out: dict[int, str] = {}
    for key, value in saved.items():
        try:
            out[int(key)] = str(value)
        except (TypeError, ValueError):
            continue
    return out


#: The four files a run has, by the name the API uses for them.
_FILE_KEYS = ("counter_txt", "stamp_txt", "counter_dat", "stamp_dat")


@router.get("/{number}/file/{which}")
def download(profile_id: str, number: int, which: str, preview: bool = False):
    """One of a run's four files, as it is on disk.

    `preview=true` returns the first part as text for reading in the browser;
    without it the file is a download. The raw `.dat` files are binary and are
    only ever offered as a download.
    """
    if which not in _FILE_KEYS:
        raise HTTPException(404, f"Unknown file {which!r}; expected one of {', '.join(_FILE_KEYS)}.")

    run = _find(profile_id, number)
    path = getattr(run.files, which)
    if not path:
        raise HTTPException(404, f"Run {number} has no {which.replace('_', ' ')}.")
    file = Path(path)
    if not file.is_file():
        raise HTTPException(404, f"{file} is gone.")

    if preview and which.endswith("_txt"):
        # Enough to see the header, the shape of the columns, and that data is
        # actually in there; the whole file is one click away as a download.
        head = _head(file, 400)
        return PlainTextResponse(head)

    return FileResponse(file, filename=file.name, media_type="application/octet-stream")


def _head(path: Path, lines: int) -> str:
    out: list[str] = []
    try:
        with path.open("r", errors="replace") as handle:
            for index, line in enumerate(handle):
                if index >= lines:
                    out.append(f"... (showing the first {lines} lines; download for the rest)")
                    break
                out.append(line.rstrip("\n"))
    except OSError as err:
        raise HTTPException(500, f"{path}: {err}") from err
    return "\n".join(out)


def _find(profile_id: str, number: int) -> runs.Run:
    run = runs.find(profile_id, number)
    if run is None:
        raise HTTPException(404, f"{profile_id} has no run {number}.")
    return run
