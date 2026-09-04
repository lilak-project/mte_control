"""The run catalog: what runs a profile has, where their files are, what they were for.

Runs live under the profile they belong to and are numbered inside it:

    <RUN_ROOT>/ko2520/data/run_000316/
    <RUN_ROOT>/ko2520/converted/run_000316/

Numbering per profile is the point. Two experiments on the same electronics at
different times are not one sequence, and "run 12" means nothing without saying
run 12 of what -- so a run is identified by the pair, and nothing outside a
profile's own directory can affect what number its next run gets.

The runner names a run by number and nothing else, so the operator's own name
and note are kept beside it here, in one JSON file that is deliberately not the
data: delete it and every run is still listed, just unnamed.
"""

from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from .config import RUN_INDEX, RUN_ROOT

RUN_DIR = re.compile(r"^run_(\d+)$")

_lock = threading.Lock()


@dataclass
class RunFiles:
    """Where a run's four files are, and how big they got."""

    raw_dir: str | None = None
    converted_dir: str | None = None
    counter_txt: str | None = None
    stamp_txt: str | None = None
    counter_dat: str | None = None
    stamp_dat: str | None = None
    sizes: dict[str, int] = field(default_factory=dict)

    @property
    def total_bytes(self) -> int:
        return sum(self.sizes.values())


@dataclass
class Run:
    number: int
    #: The profile this run belongs to.  Half of its identity.
    profile_id: str
    profile_name: str
    files: RunFiles
    #: Wall-clock seconds. `started_at` comes from our own metadata when we
    #: started the run and from the file's mtime when someone else did, which
    #: is why `source` says which.
    started_at: float | None = None
    stopped_at: float | None = None
    name: str = ""
    note: str = ""
    #: The profile as it stood when the run was taken -- channels, names and
    #: levels -- so a past run reads with the names it was taken with rather
    #: than whatever the profile says today.
    profile: dict | None = None
    acq_time_sec: int | None = None
    count_period_ms: int | None = None
    exit_code: int | None = None
    #: "service" if this service started it, "disk" if it was found by scanning.
    source: str = "disk"

    @property
    def key(self) -> str:
        return f"{self.profile_id}/{self.number}"

    def to_json(self) -> dict:
        return {
            "number": self.number,
            "profile_id": self.profile_id,
            "profile_name": self.profile_name,
            "key": self.key,
            "name": self.name,
            "note": self.note,
            "started_at": self.started_at,
            "stopped_at": self.stopped_at,
            "profile": self.profile,
            "acq_time_sec": self.acq_time_sec,
            "count_period_ms": self.count_period_ms,
            "exit_code": self.exit_code,
            "source": self.source,
            "files": {
                "raw_dir": self.files.raw_dir,
                "converted_dir": self.files.converted_dir,
                "counter_txt": self.files.counter_txt,
                "stamp_txt": self.files.stamp_txt,
                "counter_dat": self.files.counter_dat,
                "stamp_dat": self.files.stamp_dat,
                "sizes": self.files.sizes,
                "total_bytes": self.files.total_bytes,
            },
        }


# -- metadata -------------------------------------------------------------


def load_index() -> dict[str, dict]:
    try:
        raw = json.loads(RUN_INDEX.read_text())
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _write_index(index: dict[str, dict]) -> None:
    RUN_INDEX.parent.mkdir(parents=True, exist_ok=True)
    temporary = RUN_INDEX.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(index, indent=2, sort_keys=True))
    temporary.replace(RUN_INDEX)


def _key(profile_id: str, number: int) -> str:
    return f"{profile_id}/{number}"


def remember(profile_id: str, number: int, **fields) -> dict:
    """Merge facts into a run's metadata entry.  Only what is passed changes."""
    with _lock:
        index = load_index()
        entry = index.setdefault(_key(profile_id, number), {})
        entry.update({key: value for key, value in fields.items() if value is not None})
        _write_index(index)
        return dict(entry)


def rename(profile_id: str, number: int, name: str | None = None,
           note: str | None = None) -> dict:
    """Name a run after the fact.

    A run is often only worth naming once you have seen what it did, so the
    name is metadata rather than part of the path -- renaming never moves or
    rewrites a single byte of data.
    """
    with _lock:
        index = load_index()
        entry = index.setdefault(_key(profile_id, number), {})
        if name is not None:
            entry["name"] = name.strip()
        if note is not None:
            entry["note"] = note.strip()
        entry["renamed_at"] = time.time()
        _write_index(index)
        return dict(entry)


# -- the filesystem -------------------------------------------------------


def profile_dir(profile_id: str) -> Path:
    return RUN_ROOT / profile_id


def _files_for(profile_id: str, number: int) -> RunFiles:
    """Locate a run's files, tolerating either naming.

    The runner writes `counter_<n>.txt` with the number unpadded inside a
    directory whose number is padded to six, so both are looked for by glob
    rather than by construction.
    """
    files = RunFiles()
    root = profile_dir(profile_id)
    raw = root / "data" / f"run_{number:06d}"
    converted = root / "converted" / f"run_{number:06d}"

    if raw.is_dir():
        files.raw_dir = str(raw)
        for path in sorted(raw.glob("counter_*.dat")):
            files.counter_dat = str(path)
        for path in sorted(raw.glob("time_stamp_*.dat")):
            files.stamp_dat = str(path)
    if converted.is_dir():
        files.converted_dir = str(converted)
        for path in sorted(converted.glob("counter_*.txt")):
            files.counter_txt = str(path)
        for path in sorted(converted.glob("time_stamp_*.txt")):
            files.stamp_txt = str(path)

    for key in ("counter_txt", "stamp_txt", "counter_dat", "stamp_dat"):
        path = getattr(files, key)
        if path:
            try:
                files.sizes[key] = Path(path).stat().st_size
            except OSError:
                files.sizes[key] = 0
    return files


def numbers_for(profile_id: str) -> set[int]:
    """Every run number this profile has on disk."""
    numbers: set[int] = set()
    root = profile_dir(profile_id)
    for sub in ("data", "converted"):
        directory = root / sub
        if not directory.is_dir():
            continue
        try:
            entries = list(directory.iterdir())
        except OSError:
            continue
        for entry in entries:
            match = RUN_DIR.match(entry.name)
            if match and entry.is_dir():
                numbers.add(int(match.group(1)))
    return numbers


def next_number(profile_id: str) -> int:
    """One past this profile's highest run number.

    Only this profile's own directory is consulted: another experiment taking
    run 400 must not push this one's numbering forward.
    """
    numbers = numbers_for(profile_id)
    return max(numbers) + 1 if numbers else 0


def _mtimes(files: RunFiles) -> tuple[float | None, float | None]:
    """(earliest created, latest written) across a run's files.

    For a run this service did not start, this is the only clock there is. It
    is close: the runner creates all four files as it starts and flushes them
    as it stops.
    """
    stamps = []
    for key in ("counter_txt", "stamp_txt", "counter_dat", "stamp_dat"):
        path = getattr(files, key)
        if not path:
            continue
        try:
            info = Path(path).stat()
        except OSError:
            continue
        stamps.append((info.st_ctime, info.st_mtime))
    if not stamps:
        return None, None
    return min(created for created, _ in stamps), max(modified for _, modified in stamps)


def _build(profile_id: str, profile_name: str, number: int, meta: dict) -> Run:
    files = _files_for(profile_id, number)
    created, modified = _mtimes(files)
    return Run(
        number=number,
        profile_id=profile_id,
        profile_name=profile_name,
        files=files,
        started_at=meta.get("started_at") or created,
        stopped_at=meta.get("stopped_at") or modified,
        name=str(meta.get("name", "")),
        note=str(meta.get("note", "")),
        profile=meta.get("profile"),
        acq_time_sec=meta.get("acq_time_sec"),
        count_period_ms=meta.get("count_period_ms"),
        exit_code=meta.get("exit_code"),
        source="service" if meta.get("started_at") else "disk",
    )


def find(profile_id: str, number: int) -> Run | None:
    if number not in numbers_for(profile_id):
        return None
    from . import profiles as profile_store

    profile = profile_store.find(profile_id)
    index = load_index()
    return _build(
        profile_id,
        profile.name if profile else profile_id,
        number,
        index.get(_key(profile_id, number), {}),
    )


def list_runs(profile_id: str, limit: int | None = None, search: str = "") -> list[Run]:
    """One profile's runs, newest number first.

    `search` matches the name, the note, or the number, so a run is found by
    what it was for rather than by remembering that it was 287.
    """
    from . import profiles as profile_store

    profile = profile_store.find(profile_id)
    profile_name = profile.name if profile else profile_id
    index = load_index()

    found = [
        _build(profile_id, profile_name, number, index.get(_key(profile_id, number), {}))
        for number in sorted(numbers_for(profile_id), reverse=True)
    ]

    needle = search.strip().lower()
    if needle:
        found = [
            run
            for run in found
            if needle in run.name.lower()
            or needle in run.note.lower()
            or needle in str(run.number)
        ]

    return found[:limit] if limit else found
