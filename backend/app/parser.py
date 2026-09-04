"""Reading the runner's converted text files, live and after the fact.

The runner flushes both converted files after every read from the module, so
following them is a complete and lag-free view of a run in progress -- and it
needs no change to the runner, no second reader on the USB device, and no
shared memory. The same parsers read a finished run back off disk.

Both files are positional and both start with two header lines:

    counter_N.txt      index, Ch11..Ch20, Time(s)
    time_stamp_N.txt   Channel, Time stamp(s)

`Time(s)` is the module's own clock, seconds since the run was started -- not a
wall clock. Everything here stays in that clock, and the wall-clock start time
of the run is kept separately in the run's metadata, so a chart can be labelled
either way without either being guessed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .config import COUNTER_CHANNELS

#: Both files' headers; skipped by shape rather than by line number so a
#: partially written first line cannot be mistaken for data.
_SKIP_PREFIXES = ("#", "-", "index", "Channel")


def _is_data(line: str) -> bool:
    stripped = line.strip()
    return bool(stripped) and not stripped.startswith(_SKIP_PREFIXES)


@dataclass
class CounterRows:
    """A batch of counter rows: one per counting period."""

    #: Module clock, seconds since the run started.
    times: list[float] = field(default_factory=list)
    #: counts[channel] is a list parallel to `times`.
    counts: dict[int, list[int]] = field(default_factory=dict)
    #: The runner's own row index, one per row and parallel to `times`. Kept
    #: per row rather than only as a maximum so the live view can print the
    #: same `event#` column the runner prints, and so a gap in the sequence is
    #: visible rather than inferred.
    indices: list[int] = field(default_factory=list)
    #: The last of those, for spotting a gap at a glance.
    last_index: int | None = None
    malformed: int = 0

    def __len__(self) -> int:
        return len(self.times)


def parse_counter_lines(lines: list[str]) -> CounterRows:
    """`index, c11, ..., c20, time` per line.

    A short or unparsable line is counted, not raised on: the last line of a
    file being written to is regularly half there, and the next pass will pick
    it up whole.
    """
    rows = CounterRows(counts={channel: [] for channel in COUNTER_CHANNELS})
    for line in lines:
        if not _is_data(line):
            continue
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 2 + len(COUNTER_CHANNELS):
            rows.malformed += 1
            continue
        try:
            index = int(parts[0])
            values = [int(part) for part in parts[1 : 1 + len(COUNTER_CHANNELS)]]
            at = float(parts[1 + len(COUNTER_CHANNELS)])
        except ValueError:
            rows.malformed += 1
            continue
        rows.times.append(at)
        rows.indices.append(index)
        for channel, value in zip(COUNTER_CHANNELS, values):
            rows.counts[channel].append(value)
        rows.last_index = index
    return rows


@dataclass
class StampBatch:
    """Time-stamp events, already reduced to per-channel per-second counts.

    The individual event times are deliberately not kept: a channel can write
    hundreds of thousands a second and no screen shows them. What is wanted --
    hits per second per channel -- is the bin count, so the binning happens
    here, at the point the line is read, and nothing larger is ever built.
    """

    #: channel -> {second -> events in that second}
    bins: dict[int, dict[int, int]] = field(default_factory=dict)
    #: channel -> (first, last) event time seen in this batch.
    span: dict[int, tuple[float, float]] = field(default_factory=dict)
    #: channel -> a few of the most recent event times, for the raw view.
    recent: dict[int, list[float]] = field(default_factory=dict)
    events: int = 0
    malformed: int = 0
    #: Bytes of the file left unread, when a budget cut the read short.
    skipped_bytes: int = 0

    def __len__(self) -> int:
        return self.events


#: Recent event times kept per channel, so the UI can show that timestamps are
#: arriving at all without the bins hiding it.
RECENT_KEEP = 12


def parse_stamp_lines(lines: list[str]) -> StampBatch:
    """`channel, time` per line, binned to whole seconds of the module clock."""
    batch = StampBatch()
    for line in lines:
        if not _is_data(line):
            continue
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 2:
            batch.malformed += 1
            continue
        try:
            channel = int(parts[0])
            at = float(parts[1])
        except ValueError:
            batch.malformed += 1
            continue

        second = int(at)
        channel_bins = batch.bins.setdefault(channel, {})
        channel_bins[second] = channel_bins.get(second, 0) + 1
        first, _ = batch.span.get(channel, (at, at))
        batch.span[channel] = (first, at)
        recent = batch.recent.setdefault(channel, [])
        recent.append(at)
        if len(recent) > RECENT_KEEP:
            del recent[:-RECENT_KEEP]
        batch.events += 1
    return batch


class Tail:
    """Follows one growing text file, handing back whole lines only.

    Holds a byte offset and a remainder, so a line split across two reads is
    joined rather than counted as two malformed ones -- which on a file being
    appended to at a few MB/s happens on nearly every pass.

    `budget` caps how much is parsed in a single call. When `skip_when_behind`
    is set and the file has grown past it, the tail jumps to the end and reports
    how many bytes it passed over: a channel running faster than this process
    can parse should cost the live rate display its precision, and say so,
    rather than putting the whole service minutes behind the run. Reading a
    finished file turns that off and simply takes more passes.
    """

    def __init__(self, path: Path, budget: int, skip_when_behind: bool = True) -> None:
        self.path = path
        self.budget = budget
        self.skip_when_behind = skip_when_behind
        self.offset = 0
        self.skipped_bytes = 0
        self._remainder = ""

    def read(self) -> list[str]:
        """Complete lines appended since the last call."""
        try:
            size = self.path.stat().st_size
        except OSError:
            return []

        if size < self.offset:
            # The file was replaced -- a new run writing to the same name.
            self.offset = 0
            self._remainder = ""

        pending = size - self.offset
        if pending <= 0:
            return []

        if self.skip_when_behind and pending > self.budget:
            # Keep the newest `budget` bytes and say what was passed over. The
            # partial first line of the jump is dropped by `_is_data` or by the
            # int() below, which is why the remainder is cleared here.
            self.skipped_bytes += pending - self.budget
            self.offset = size - self.budget
            self._remainder = ""
            pending = self.budget

        try:
            with self.path.open("rb") as handle:
                handle.seek(self.offset)
                chunk = handle.read(min(self.budget, pending))
        except OSError:
            return []

        self.offset += len(chunk)
        text = self._remainder + chunk.decode("utf-8", errors="replace")
        lines = text.split("\n")
        # The last element is whatever came after the final newline: either
        # empty, or half a line that the next pass will complete.
        self._remainder = lines.pop()
        return lines


def read_counter_file(path: Path, row_budget: int | None = None) -> CounterRows:
    """A whole counter file, for a run that is over.

    `row_budget` reads every Nth row when the file is longer than the budget.
    That is a stride and it can step over a spike -- which is fine here and not
    in `decimate`, because this is the coarse pass that decides the shape of a
    month-long file, and any window the operator then opens is read exactly.
    """
    try:
        with path.open("r", errors="replace") as handle:
            lines = handle.readlines()
    except OSError:
        return CounterRows(counts={channel: [] for channel in COUNTER_CHANNELS})

    data = [line for line in lines if _is_data(line)]
    if row_budget and len(data) > row_budget:
        stride = len(data) // row_budget + 1
        data = data[::stride]
    return parse_counter_lines(data)


#: Bytes of time-stamp text read per pass when taking in a whole file. Large
#: enough that a run of any size is a handful of passes, small enough that the
#: decoded string never dwarfs the run's own footprint.
_FILE_CHUNK = 8 << 20


def read_stamp_file(path: Path, byte_budget: int | None = None) -> StampBatch:
    """A whole time-stamp file, binned per channel per second.

    `byte_budget` caps the total read for a file too big to be worth taking in
    whole; what was left unread is on the returned batch as `skipped_bytes`, so
    a rate quoted from a truncated read is never quoted as if it were complete.
    """
    tail = Tail(path, budget=_FILE_CHUNK, skip_when_behind=False)
    batch = StampBatch()
    read = 0
    while True:
        lines = tail.read()
        if not lines:
            break
        _merge_stamp(batch, parse_stamp_lines(lines))
        read = tail.offset
        if byte_budget is not None and read >= byte_budget:
            try:
                batch.skipped_bytes = max(0, path.stat().st_size - read)
            except OSError:
                pass
            break
    return batch


def _merge_stamp(into: StampBatch, piece: StampBatch) -> None:
    for channel, bins in piece.bins.items():
        target = into.bins.setdefault(channel, {})
        for second, count in bins.items():
            target[second] = target.get(second, 0) + count
    for channel, (first, last) in piece.span.items():
        if channel in into.span:
            existing_first, _ = into.span[channel]
            into.span[channel] = (existing_first, last)
        else:
            into.span[channel] = (first, last)
    for channel, times in piece.recent.items():
        recent = into.recent.setdefault(channel, [])
        recent.extend(times)
        if len(recent) > RECENT_KEEP:
            del recent[:-RECENT_KEEP]
    into.events += piece.events
    into.malformed += piece.malformed
