"""Reading a finished run back off disk.

A run that is over is a pair of text files, and the questions asked of it are
the same as the ones asked of a live one: what did each channel count, and how
often did each channel fire. So the answers have the same shape, and the same
chart draws both.

Files are read on demand and the parsed result is kept for a short while. A
month-long counter file is tens of megabytes of text and an operator paging
through a run will ask for several windows of it in a row; re-parsing it each
time is seconds of wall clock for an answer that has not changed.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

from .config import COUNTER_CHANNELS, DEFAULT_MAX_POINTS, FILE_ROW_BUDGET, STAMP_BYTE_BUDGET
from .parser import CounterRows, StampBatch, read_counter_file, read_stamp_file
from .series import decimate

#: How long a parsed file stays cached. Long enough to cover paging around one
#: run, short enough that a run still being written to is re-read.
CACHE_SECONDS = 120.0

#: Parsed files held at once. A counter file is a few million floats at worst.
CACHE_SIZE = 6

_lock = threading.Lock()
_cache: dict[str, tuple[float, object]] = {}


def _cached(key: str, build):
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_SECONDS:
            return hit[1]
    value = build()
    with _lock:
        _cache[key] = (now, value)
        if len(_cache) > CACHE_SIZE:
            oldest = min(_cache, key=lambda item: _cache[item][0])
            del _cache[oldest]
    return value


def invalidate() -> None:
    """Forget everything cached -- called when a run ends and its files settle."""
    with _lock:
        _cache.clear()


def counters(path: Path) -> CounterRows:
    key = f"counter:{path}:{_stamp(path)}"
    return _cached(key, lambda: read_counter_file(path, row_budget=FILE_ROW_BUDGET))


def stamps(path: Path) -> StampBatch:
    key = f"stamp:{path}:{_stamp(path)}"
    return _cached(key, lambda: read_stamp_file(path, byte_budget=STAMP_BYTE_BUDGET * 8))


def _stamp(path: Path) -> str:
    """Size and mtime, so a file still being appended to is not served stale."""
    try:
        info = path.stat()
    except OSError:
        return "missing"
    return f"{info.st_size}:{info.st_mtime_ns}"


def counter_series(
    path: Path,
    channels: list[int],
    start: float | None,
    end: float | None,
    max_points: int = DEFAULT_MAX_POINTS,
    labels: dict[int, str] | None = None,
) -> dict:
    """Counts against module time, windowed and decimated for a chart."""
    rows = counters(path)
    wanted = [channel for channel in channels if channel in COUNTER_CHANNELS] or list(COUNTER_CHANNELS)

    out = []
    for channel in wanted:
        times: list[float] = []
        values: list[float] = []
        for at, value in zip(rows.times, rows.counts.get(channel, [])):
            if start is not None and at < start:
                continue
            if end is not None and at > end:
                continue
            times.append(at)
            values.append(float(value))
        total = len(times)
        times, values = decimate(times, values, max_points)
        out.append(
            {
                "channel": channel,
                "label": (labels or {}).get(channel, f"Ch{channel}"),
                "t": times,
                "v": values,
                "total": total,
                "dropped": 0,
            }
        )
    span = (rows.times[0], rows.times[-1]) if rows.times else None
    return {"channels": out, "rows": len(rows), "span": span, "malformed": rows.malformed}


def counter_summary(path: Path, period_ms: int | None) -> dict:
    """Per channel: mean, extremes and total, over the whole run.

    The same numbers the live table shows, so a finished run and a running one
    are read the same way -- the only difference being that the window here is
    always the whole run, because that is what a finished run is.
    """
    rows = counters(path)
    period = (period_ms or 1000) / 1000.0
    channels = []
    for channel in COUNTER_CHANNELS:
        values = rows.counts.get(channel, [])
        if not values:
            channels.append({"channel": channel, "samples": 0, "mean": None, "min": None,
                             "max": None, "total": 0, "mean_rate": None})
            continue
        mean = sum(values) / len(values)
        channels.append(
            {
                "channel": channel,
                "samples": len(values),
                "mean": mean,
                "mean_rate": mean / period,
                "min": min(values),
                "max": max(values),
                "total": sum(values),
            }
        )
    return {
        "rows": len(rows),
        "period": period,
        "span": (rows.times[0], rows.times[-1]) if rows.times else None,
        "duration": (rows.times[-1] - rows.times[0]) if len(rows.times) > 1 else 0.0,
        "channels": channels,
    }


def stamp_summary(path: Path) -> dict:
    """Per channel: events, hits a second, and when it was first and last seen."""
    batch = stamps(path)
    channels = []
    for channel in sorted(batch.bins):
        bins = batch.bins[channel]
        total = sum(bins.values())
        width = max(bins) - min(bins) + 1
        first, last = batch.span.get(channel, (None, None))
        channels.append(
            {
                "channel": channel,
                "total": total,
                "mean_rate": total / width if width else None,
                "seconds_live": width,
                "first": first,
                "last": last,
                "recent": batch.recent.get(channel, [])[-6:],
            }
        )
    return {
        "events": batch.events,
        "channels": channels,
        "malformed": batch.malformed,
        "skipped_bytes": batch.skipped_bytes,
    }


def stamp_series(
    path: Path,
    start: float | None,
    end: float | None,
    max_points: int = DEFAULT_MAX_POINTS,
    labels: dict[int, str] | None = None,
) -> dict:
    """Hits per second against module time, one line per channel."""
    batch = stamps(path)
    out = []
    for channel in sorted(batch.bins):
        bins = batch.bins[channel]
        times: list[float] = []
        values: list[float] = []
        for second in sorted(bins):
            if start is not None and second < start:
                continue
            if end is not None and second > end:
                continue
            times.append(float(second))
            values.append(float(bins[second]))
        total = len(times)
        times, values = decimate(times, values, max_points)
        out.append(
            {
                "channel": channel,
                "label": (labels or {}).get(channel, f"Ch{channel}"),
                "t": times,
                "v": values,
                "total": total,
                "dropped": 0,
            }
        )
    return {"channels": out, "events": batch.events, "skipped_bytes": batch.skipped_bytes}
