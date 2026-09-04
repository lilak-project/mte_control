"""Sample buffers, rolling means, and the decimation that keeps a chart honest.

Counters arrive once a counting period -- a point a second at the usual
setting -- and a shift is 86 400 of them per channel. Sending all of that to a
browser on every tick is what makes a monitoring page unusable, so the samples
stay here and a chart asks for the window it is showing.

Decimation is min/max, not a stride. A burst on a scaler channel can be one
period wide, and a stride steps straight over it; min/max keeps the extreme of
every bucket, so the envelope on screen is the envelope in the data.
"""

from __future__ import annotations

import bisect
import math
import threading

from .config import HISTORY_LIMIT

#: Trim in one slice once the buffer is this far past its cap, rather than
#: shifting the whole list on every append.
_TRIM_SLACK = 4096


class Buffer:
    """Timestamped samples for one channel, oldest first.

    Appends are strictly increasing in time, which is what lets a window query
    be two bisections rather than a scan.
    """

    __slots__ = ("_times", "_values", "_limit", "_lock", "_dropped")

    def __init__(self, limit: int = HISTORY_LIMIT) -> None:
        self._times: list[float] = []
        self._values: list[float] = []
        self._limit = max(1, limit)
        self._lock = threading.Lock()
        #: Samples that have aged out, so the UI can say the chart is a window
        #: onto the file rather than the whole run.
        self._dropped = 0

    def append(self, at: float, value: float) -> None:
        if not math.isfinite(at) or not math.isfinite(value):
            return
        with self._lock:
            if self._times and at < self._times[-1]:
                at = self._times[-1]
            self._times.append(at)
            self._values.append(value)
            if len(self._times) > self._limit + _TRIM_SLACK:
                cut = len(self._times) - self._limit
                del self._times[:cut]
                del self._values[:cut]
                self._dropped += cut

    def clear(self) -> None:
        with self._lock:
            self._times.clear()
            self._values.clear()
            self._dropped = 0

    def __len__(self) -> int:
        return len(self._times)

    @property
    def dropped(self) -> int:
        return self._dropped

    @property
    def latest(self) -> tuple[float, float] | None:
        with self._lock:
            if not self._times:
                return None
            return self._times[-1], self._values[-1]

    @property
    def span(self) -> tuple[float, float] | None:
        with self._lock:
            if not self._times:
                return None
            return self._times[0], self._times[-1]

    def window(self, start: float | None, end: float | None) -> tuple[list[float], list[float]]:
        """Copy of the samples in [start, end], both bounds optional."""
        with self._lock:
            low = 0 if start is None else bisect.bisect_left(self._times, start)
            high = len(self._times) if end is None else bisect.bisect_right(self._times, end)
            return self._times[low:high], self._values[low:high]

    def tail(self, seconds: float) -> tuple[list[float], list[float]]:
        """The last `seconds` of samples, by their own time tag."""
        with self._lock:
            if not self._times:
                return [], []
            cut = self._times[-1] - seconds
            low = bisect.bisect_left(self._times, cut)
            return self._times[low:], self._values[low:]

    def stats(self, seconds: float | None = None) -> dict:
        """Mean, extremes and count -- over a trailing window, or all of it.

        This is what the operator asked for by "average over the last N
        minutes": it is computed from the sample time tags, so a window that
        the run is not yet that old simply covers everything there is, and the
        `span` in the answer says so rather than the mean quietly meaning
        something else.
        """
        times, values = self.tail(seconds) if seconds is not None else self.window(None, None)
        if not values:
            return {"n": 0, "mean": None, "min": None, "max": None, "span": 0.0}
        return {
            "n": len(values),
            "mean": sum(values) / len(values),
            "min": min(values),
            "max": max(values),
            "span": times[-1] - times[0] if len(times) > 1 else 0.0,
        }


def decimate(
    times: list[float],
    values: list[float],
    max_points: int,
) -> tuple[list[float], list[float]]:
    """Reduce to at most `max_points`, keeping every bucket's min and max.

    Two points per bucket, emitted in the order they occur in time so the line
    does not zig-zag backwards. Under the budget the samples are returned
    untouched -- which is the usual case for a live window.
    """
    count = len(times)
    if count <= max_points or max_points < 4:
        return list(times), list(values)

    buckets = max(1, max_points // 2)
    size = count / buckets
    out_times: list[float] = []
    out_values: list[float] = []

    for index in range(buckets):
        start = int(index * size)
        end = int((index + 1) * size) if index < buckets - 1 else count
        if end <= start:
            continue
        low = high = start
        for position in range(start + 1, end):
            if values[position] < values[low]:
                low = position
            elif values[position] > values[high]:
                high = position
        first, second = (low, high) if low <= high else (high, low)
        out_times.append(times[first])
        out_values.append(values[first])
        if second != first:
            out_times.append(times[second])
            out_values.append(values[second])

    return out_times, out_values


class RateBins:
    """Events counted into one-second bins, per channel.

    The time-stamp file is one line per event and a busy channel writes tens of
    thousands a second; keeping them individually would cost more memory than
    the run is worth and answer no question anyone asked. What is asked -- how
    many hits a second is this channel taking -- is exactly a bin count, so the
    events are added up as they are read and the individual times discarded.
    """

    __slots__ = ("_bins", "_total", "_first", "_last", "_lock", "_limit")

    def __init__(self, limit: int = HISTORY_LIMIT) -> None:
        #: second -> count, for one channel.
        self._bins: dict[int, int] = {}
        self._total = 0
        self._first: float | None = None
        self._last: float | None = None
        self._lock = threading.Lock()
        self._limit = max(1, limit)

    def add_many(self, counts: dict[int, int], first: float, last: float) -> None:
        with self._lock:
            for second, number in counts.items():
                self._bins[second] = self._bins.get(second, 0) + number
                self._total += number
            if self._first is None:
                self._first = first
            self._last = last if self._last is None else max(self._last, last)
            if len(self._bins) > self._limit + 512:
                # Oldest bins go; the run's file still has every event.
                for second in sorted(self._bins)[: len(self._bins) - self._limit]:
                    del self._bins[second]

    def clear(self) -> None:
        with self._lock:
            self._bins.clear()
            self._total = 0
            self._first = self._last = None

    @property
    def total(self) -> int:
        return self._total

    @property
    def span(self) -> tuple[float, float] | None:
        with self._lock:
            if self._first is None or self._last is None:
                return None
            return self._first, self._last

    def series(self, start: float | None = None, end: float | None = None
               ) -> tuple[list[float], list[float]]:
        """Hits per second against time, ready to plot."""
        with self._lock:
            seconds = sorted(self._bins)
        times, values = [], []
        for second in seconds:
            if start is not None and second < start:
                continue
            if end is not None and second > end:
                continue
            times.append(float(second))
            values.append(float(self._bins[second]))
        return times, values

    def rate_over(self, seconds: int) -> float | None:
        """Hits per second over the last `seconds` *complete* seconds.

        The newest bin is normally still filling -- the converted files are
        read four times a second and the module's clock runs on between reads
        -- so counting it would divide a fraction of a second's hits by a whole
        second and report a rate that is always too low, and always too low by
        a different amount. It is left out, and the answer is about the last
        second that finished.

        Returns None until there is a complete second to report on, rather than
        a number that means "not much yet".
        """
        with self._lock:
            if len(self._bins) < 2:
                return None
            newest = max(self._bins)
            last_complete = newest - 1
            oldest = max(min(self._bins), last_complete - max(1, int(seconds)) + 1)
            if oldest > last_complete:
                return None
            total = sum(
                count
                for second, count in self._bins.items()
                if oldest <= second <= last_complete
            )
            # Every second in the span counts, including the ones with no hits:
            # a channel that fired once and stopped is at a low rate, not at
            # the rate of its one busy second.
            return total / (last_complete - oldest + 1)

    def recent(self, seconds: int) -> list[tuple[int, int]]:
        """(second, hits) for the last `seconds` complete seconds, oldest first.

        Empty seconds are filled in as zero. A gap that is skipped rather than
        printed reads as "nothing happened for one tick" instead of "this
        channel went quiet", and those are different findings.
        """
        with self._lock:
            if len(self._bins) < 2:
                return []
            newest = max(self._bins)
            last_complete = newest - 1
            oldest = max(min(self._bins), last_complete - max(1, int(seconds)) + 1)
            return [
                (second, self._bins.get(second, 0))
                for second in range(oldest, last_complete + 1)
            ]

    def rate(self, seconds: float) -> float | None:
        """Hits per second over the last `seconds` of the run's own clock.

        Uses the bins' own last second rather than the wall clock: a finished
        run still answers, and it answers about the run rather than about how
        long ago it ended.
        """
        with self._lock:
            if not self._bins:
                return None
            newest = max(self._bins)
            cut = newest - max(1, int(seconds)) + 1
            total = sum(count for second, count in self._bins.items() if second >= cut)
            covered = max(1, newest - max(cut, min(self._bins)) + 1)
        return total / covered

    def mean_rate(self) -> float | None:
        """Hits per second averaged over every second the channel was live."""
        with self._lock:
            if not self._bins:
                return None
            width = max(self._bins) - min(self._bins) + 1
            return self._total / width
