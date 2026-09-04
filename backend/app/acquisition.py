"""Starting, watching and stopping a run.

The runner is a C program that owns the USB module for the length of a run, so
this service does not talk to the module at all -- it starts that program and
reads what it writes. That is a deliberate choice and not a shortcut: two
processes cannot hold the same libusb handle, and the program that has held it
for months is the one that should keep holding it. Everything the web page
shows is derived from the two text files the runner flushes as it goes.

Stopping is SIGINT, which is the same key an operator has always pressed. The
runner catches it, stops the scaler, drains what is still buffered in the
module, closes all four files and exits -- so a run stopped from a browser ends
with exactly the same files as one stopped from the terminal.
"""

from __future__ import annotations

import collections
import logging
import os
import re
import shlex
import shutil
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import device, elog, profiles, runs
from .config import (
    COUNTER_CHANNELS,
    HISTORY_LIMIT,
    RUNNER,
    STAMP_BYTE_BUDGET,
    TAIL_INTERVAL,
)
from .parser import Tail, parse_counter_lines, parse_stamp_lines
from .series import Buffer, RateBins

log = logging.getLogger("mte.acquisition")

#: How long SIGINT is given to drain the module before the run is killed. The
#: drain is one more read of a 4 MB buffer over USB; it takes well under a
#: second, and this is the margin for it being busy.
STOP_GRACE = 15.0

#: Lines of the runner's own output kept, for the module readback it prints at
#: start-up and for whatever it says when something goes wrong.
LOG_KEEP = 400

#: Counting periods kept for the rolling printout. Ten is what the screen
#: shows; the rest is slack so a browser that missed a tick still gets a
#: continuous ten rather than a gap.
RECENT_ROWS = 64

#: Rows and seconds the printouts actually show.
PRINT_ROWS = 10

#: Rows of the monitor-mode stdout table.
_MONITOR_ROW = re.compile(r"^\s*(\d+)\s+(\S+)\s+(\d+)((?:\s+-?\d+){10})\s*$")


def _line_buffered(command: list[str]) -> list[str]:
    """Wrap the runner so its output reaches us as it is printed.

    The runner never calls fflush, so on a terminal its output is line-buffered
    by libc and on a pipe -- which is what we give it -- it is block-buffered
    instead. With `--quiet` it prints so little that its start-up lines, the
    setup readback among them, would sit in its own buffer until it exited: a
    run's log would be empty for the whole run and complete only once there was
    nothing left to watch.

    `stdbuf` sets the buffering of a program it does not own, then execs it, so
    the runner keeps the same pid and the same signal handling. If it is not
    installed the command is returned unchanged: the log then arrives at the
    end, which is no worse than not trying.
    """
    stdbuf = shutil.which("stdbuf")
    return [stdbuf, "-oL", "-eL", *command] if stdbuf else list(command)


class AcquisitionError(RuntimeError):
    """A run that cannot be started, with the reason an operator can act on."""


@dataclass
class Live:
    """Everything derived from a run in progress."""

    #: Counts per counting period, per counter channel, against module time.
    counters: dict[int, Buffer] = field(
        default_factory=lambda: {channel: Buffer(HISTORY_LIMIT) for channel in COUNTER_CHANNELS}
    )
    #: Time-stamp hits per second, per channel. Channels appear as they fire.
    stamps: dict[int, RateBins] = field(default_factory=dict)
    #: The last few raw event times per channel, so "it is firing" is visible.
    recent_stamps: dict[int, list[float]] = field(default_factory=dict)
    #: The last counting periods as the runner would have printed them:
    #: event number, module clock, cumulative time stamps, and the counts.
    recent: collections.deque = field(
        default_factory=lambda: collections.deque(maxlen=RECENT_ROWS)
    )
    rows: int = 0
    stamp_events: int = 0
    #: Module clock of the newest counter row.
    module_time: float = 0.0
    malformed: int = 0
    #: Time-stamp bytes the parser had to pass over to keep up.
    skipped_bytes: int = 0

    def reset(self) -> None:
        for buffer in self.counters.values():
            buffer.clear()
        self.stamps.clear()
        self.recent_stamps.clear()
        self.recent.clear()
        self.rows = 0
        self.stamp_events = 0
        self.module_time = 0.0
        self.malformed = 0
        self.skipped_bytes = 0


class Acquisition:
    """The one run this host can have in progress, and its live view."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._process: subprocess.Popen | None = None
        self._reader: threading.Thread | None = None
        self._pump: threading.Thread | None = None
        self._stop_event = threading.Event()

        self.live = Live()
        self.log_lines: list[str] = []

        #: What the current (or last) run is.
        self.number: int | None = None
        self.name: str = ""
        self.note: str = ""
        #: The profile it belongs to: where its files go, and what its number
        #: is counted within.
        self.profile: profiles.Profile | None = None
        self.mode: str = "idle"  # idle | run | monitor
        self.state: str = "idle"  # idle | starting | running | stopping | finished | failed
        self.started_at: float | None = None
        self.stopped_at: float | None = None
        self.acq_time_sec: int | None = None
        self.count_period_ms: int | None = None
        self.command: str = ""
        self.error: str | None = None
        self.exit_code: int | None = None
        #: The scaler id the runner reported, which is proof it opened it.
        self.sid: int | None = None

        self._counter_tail: Tail | None = None
        self._stamp_tail: Tail | None = None
        self._monitor_stamp_total = 0

    # -- state ------------------------------------------------------------

    @property
    def display_profile(self) -> "profiles.Profile | None":
        """The run's profile as it stands *now*, for labels and channel choice.

        A channel's name is annotation, not data: renaming ch9 while a run is
        going should show on the next tick, not on the next run. So everything
        the screen is made of -- which rows exist, what they are called -- comes
        from the profile as saved, and follows an edit immediately.

        What the run was *taken* with is a different question and is not
        answered here. The levels and dividers actually written into the module
        are recorded in the run's metadata at the moment it starts, and are
        never rewritten; the Past runs tab reads that, so a finished run always
        reports the configuration it really ran under.

        Falls back to the captured profile if it has since been deleted, so a
        run in progress never loses its labels entirely.
        """
        if self.profile is None:
            return None
        return profiles.find_fresh(self.profile.id) or self.profile

    @property
    def running(self) -> bool:
        return self.state in ("starting", "running", "stopping")

    @property
    def elapsed(self) -> float | None:
        if self.started_at is None:
            return None
        return (self.stopped_at or time.time()) - self.started_at

    def _note(self, line: str) -> None:
        line = line.rstrip()
        if not line:
            return
        self.log_lines.append(line)
        if len(self.log_lines) > LOG_KEEP:
            del self.log_lines[:-LOG_KEEP]
        match = re.search(r"SCALER found, sid = (\d+)", line)
        if match:
            self.sid = int(match.group(1))
            # The runner only prints this after a successful open, so it is the
            # first moment we know the module actually answered.
            if self.state == "starting":
                self.state = "running"

    # -- starting ---------------------------------------------------------

    def start(
        self,
        *,
        name: str = "",
        note: str = "",
        run_number: int | None = None,
        acq_time_sec: int = 3600,
        count_period_ms: int = 1000,
        profile_id: str | None = None,
        monitor: bool = False,
        force_init: bool = False,
    ) -> dict:
        """Start a run, or a monitor pass that writes nothing."""
        with self._lock:
            if self.running:
                what = "A monitor pass" if self.mode == "monitor" else f"Run {self.number}"
                raise AcquisitionError(
                    f"{what} is already {self.state}. Stop it before starting another."
                )

            state = device.probe()
            if not state.present:
                raise AcquisitionError("The MTE module is not on the USB bus.")
            if not state.runner_ok:
                raise AcquisitionError(f"The runner {RUNNER} is not an executable file.")
            if not state.writable:
                raise AcquisitionError(
                    f"{state.problems[0] if state.problems else 'The module cannot be opened.'}\n"
                    f"{state.remedy or ''}".strip()
                )

            if acq_time_sec < 1 or count_period_ms < 1:
                raise AcquisitionError("Acquisition time and counting period must be at least 1.")

            profile = profiles.require(profile_id)

            self.live.reset()
            self.log_lines = []
            self.sid = None
            self.error = None
            self.exit_code = None
            self.stopped_at = None
            self._monitor_stamp_total = 0
            self._counter_tail = self._stamp_tail = None

            self.mode = "monitor" if monitor else "run"
            self.name = name.strip()
            self.note = note.strip()
            self.acq_time_sec = acq_time_sec
            self.count_period_ms = count_period_ms
            self.profile = profile

            # In the profile's own directory, not a scratch one: it is also the
            # record. Anyone who opens runs/ko2520/ later finds the setup its
            # runs were taken with, sitting beside them.
            root = profile.directory
            setup_path = profiles.write_setup(profile)

            command = [str(RUNNER)]
            if monitor:
                self.number = None
                command += ["--monitor", str(acq_time_sec), str(count_period_ms)]
            else:
                self.number = (
                    runs.next_number(profile.id) if run_number is None else int(run_number)
                )
                if self._occupied(profile.id, self.number):
                    raise AcquisitionError(
                        f"{profile.name} already has a run {self.number} on disk. "
                        f"Pick another number -- its next free one is "
                        f"{runs.next_number(profile.id)}."
                    )
                command += [str(self.number), str(acq_time_sec), str(count_period_ms)]

            command += [
                "--setup", str(setup_path),
                "--data-dir", str(root / "data"),
                "--converted-dir", str(root / "converted"),
            ]
            if force_init:
                command.append("--force-init")
            if not monitor:
                # In a saved run the files are the truth and the per-second
                # table on stdout is only noise in the log; in monitor mode
                # there are no files, so that table is the only data there is.
                command.append("--quiet")

            # What is shown to the operator is what they would type; the
            # buffering wrapper is our business, not theirs.
            self.command = " ".join(shlex.quote(part) for part in command)
            spawn = _line_buffered(command)
            self.state = "starting"
            self.started_at = time.time()

            try:
                self._process = subprocess.Popen(
                    spawn,
                    cwd=str(root),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    text=True,
                    bufsize=1,
                    # Its own process group, so SIGINT reaches the runner and
                    # not, via the terminal, this service as well.
                    start_new_session=True,
                )
            except OSError as err:
                self.state = "failed"
                self.error = f"Could not start {RUNNER}: {err}"
                raise AcquisitionError(self.error) from err

            if not monitor:
                converted = root / "converted" / f"run_{self.number:06d}"
                self._counter_tail = Tail(converted / f"counter_{self.number}.txt", 1 << 22)
                self._stamp_tail = Tail(converted / f"time_stamp_{self.number}.txt",
                                        STAMP_BYTE_BUDGET)
                runs.remember(
                    profile.id,
                    self.number,
                    name=self.name,
                    note=self.note,
                    started_at=self.started_at,
                    # The profile as it stands now, so a past run reads with the
                    # channel names it was taken with rather than today's.
                    profile=profile.to_json(),
                    acq_time_sec=acq_time_sec,
                    count_period_ms=count_period_ms,
                    command=self.command,
                )

                # Tell the elog a run has begun, if this service is registered
                # there as a system. Fire-and-forget on its own thread: a
                # logbook that is down, slow or not registered must not be able
                # to affect a run that has already started.
                elog.run_started(
                    self.number,
                    profile_name=profile.name,
                    name=self.name,
                    note=self.note,
                    acq_time_sec=acq_time_sec,
                    count_period_ms=count_period_ms,
                    # Always false here: this block only runs for a real run.
                    # A monitor pass writes no files and is given no number, so
                    # there is no run for elog to open -- see the README.
                    monitoring=(self.mode == "monitor"),
                    channels=profile.to_json(),
                )

            self._stop_event.clear()
            self._reader = threading.Thread(target=self._read_output, daemon=True,
                                            name="mte-runner-output")
            self._reader.start()
            self._pump = threading.Thread(target=self._follow_files, daemon=True,
                                          name="mte-tail")
            self._pump.start()

            log.info("started: %s", self.command)
            return self.snapshot()

    @staticmethod
    def _occupied(profile_id: str, number: int) -> bool:
        """Would this run number overwrite files that are already there?"""
        return number in runs.numbers_for(profile_id)

    # -- the reading threads ----------------------------------------------

    def _read_output(self) -> None:
        """Everything the runner says, kept for the log and, in monitor mode, parsed."""
        process = self._process
        if process is None or process.stdout is None:
            return
        try:
            for line in process.stdout:
                self._note(line)
                if self.mode == "monitor":
                    self._monitor_row(line)
        except Exception:
            log.debug("runner output ended unexpectedly", exc_info=True)
        finally:
            code = process.wait()
            with self._lock:
                self.exit_code = code
                self.stopped_at = time.time()
                # One last pass: the runner drains and flushes after SIGINT, so
                # the final counting periods land in the files after it has
                # already stopped answering, and the tail must see them.
                self._pump_once()
                self._stop_event.set()
                if self.state == "stopping" or code == 0:
                    self.state = "finished"
                else:
                    self.state = "failed"
                    self.error = self.error or self._last_error_line() or f"Runner exited {code}."
                if self.number is not None and self.mode == "run" and self.profile:
                    runs.remember(
                        self.profile.id,
                        self.number,
                        stopped_at=self.stopped_at,
                        exit_code=code,
                        rows=self.live.rows,
                        stamp_events=self.live.stamp_events,
                    )
            log.info("run %s ended, exit %s", self.number, code)

            # The other boundary. Pushed for a failed run too -- that is the
            # one a logbook most needs to have caught.
            if self.number is not None and self.mode == "run":
                elog.run_ended(
                    self.number,
                    state=self.state,
                    exit_code=code,
                    elapsed=self.elapsed,
                    rows=self.live.rows,
                    stamp_events=self.live.stamp_events,
                    files=self._run_files(),
                    name=self.name or "",
                )

    def _run_files(self) -> dict | None:
        """Where this run's files ended up, for the elog's End-of-run log.

        Read back from the catalog rather than rebuilt here, so the paths in the
        logbook are the ones the rest of the service reports. Best effort: a run
        the catalog cannot find is still worth announcing the end of.
        """
        if self.number is None or self.profile is None:
            return None
        try:
            run = runs.find(self.profile.id, self.number)
        except Exception:
            return None
        return run.to_json().get("files") if run else None

    def _last_error_line(self) -> str | None:
        for line in reversed(self.log_lines):
            if any(word in line for word in ("Cannot", "cannot", "failed", "Failed", "No usable")):
                return line
        return None

    def _monitor_row(self, line: str) -> None:
        """One row of the runner's per-second table, in monitor mode.

        Monitor mode opens no files, so this table is the only view of it. It
        carries the counts exactly, and the time-stamp figure only as a running
        total across all channels -- the per-channel breakdown lives in the file
        that monitor mode does not write.
        """
        match = _MONITOR_ROW.match(line)
        if not match:
            return
        try:
            module_time = float(match.group(2))
        except ValueError:
            return
        stamp_total = int(match.group(3))
        counts = [int(value) for value in match.group(4).split()]

        with self._lock:
            self.live.module_time = module_time
            self.live.rows += 1
            self.live.stamp_events = stamp_total
            self.live.recent.append(
                {
                    "index": int(match.group(1)),
                    "time": module_time,
                    "stamps": stamp_total,
                    "counts": dict(zip(COUNTER_CHANNELS, counts)),
                }
            )
            for channel, value in zip(COUNTER_CHANNELS, counts):
                self.live.counters[channel].append(module_time, float(value))
            delta = stamp_total - self._monitor_stamp_total
            self._monitor_stamp_total = stamp_total
            if delta > 0:
                # Channel 0 is not a real channel; it is how the UI labels the
                # only figure monitor mode has -- every channel at once.
                bins = self.live.stamps.setdefault(0, RateBins(HISTORY_LIMIT))
                bins.add_many({int(module_time): delta}, module_time, module_time)

    def _follow_files(self) -> None:
        while not self._stop_event.wait(TAIL_INTERVAL):
            try:
                with self._lock:
                    self._pump_once()
            except Exception:
                log.exception("tail pass failed")

    def _pump_once(self) -> None:
        """Read whatever the runner has flushed since the last pass.

        Time stamps first: the counter rows record the running time-stamp total
        beside them, the way the runner's printout does, and reading the stamps
        first makes that figure current rather than one pass stale.
        """
        if self._stamp_tail is not None:
            lines = self._stamp_tail.read()
            if lines:
                batch = parse_stamp_lines(lines)
                for channel, channel_bins in batch.bins.items():
                    first, last = batch.span[channel]
                    self.live.stamps.setdefault(channel, RateBins(HISTORY_LIMIT)).add_many(
                        channel_bins, first, last
                    )
                for channel, times in batch.recent.items():
                    recent = self.live.recent_stamps.setdefault(channel, [])
                    recent.extend(times)
                    del recent[:-12]
                self.live.stamp_events += batch.events
                self.live.malformed += batch.malformed
            self.live.skipped_bytes = self._stamp_tail.skipped_bytes

        if self._counter_tail is not None:
            lines = self._counter_tail.read()
            if lines:
                rows = parse_counter_lines(lines)
                for position, at in enumerate(rows.times):
                    for channel in COUNTER_CHANNELS:
                        self.live.counters[channel].append(at, float(rows.counts[channel][position]))
                    # The runner's own printout, kept rather than re-derived:
                    # the time-stamp total is the count as it stood when this
                    # period was read, which is what the terminal showed too.
                    self.live.recent.append(
                        {
                            "index": rows.indices[position],
                            "time": at,
                            "stamps": self.live.stamp_events,
                            "counts": {
                                channel: rows.counts[channel][position]
                                for channel in COUNTER_CHANNELS
                            },
                        }
                    )
                if rows.times:
                    self.live.module_time = rows.times[-1]
                self.live.rows += len(rows)
                self.live.malformed += rows.malformed
                if self.state == "starting" and rows.times:
                    self.state = "running"

    # -- stopping ---------------------------------------------------------

    def stop(self, timeout: float = STOP_GRACE) -> dict:
        """SIGINT, then wait for the runner to drain and close its files."""
        with self._lock:
            process = self._process
            if process is None or process.poll() is not None:
                raise AcquisitionError("Nothing is running.")
            self.state = "stopping"
            try:
                # The process group, because the runner was started in its own
                # session; the handler in the runner does the rest.
                os.killpg(os.getpgid(process.pid), signal.SIGINT)
            except (ProcessLookupError, PermissionError) as err:
                raise AcquisitionError(f"Could not signal the runner: {err}") from err

        deadline = time.time() + timeout
        while time.time() < deadline:
            if process.poll() is not None:
                break
            time.sleep(0.1)
        else:
            log.warning("run %s ignored SIGINT for %.0fs; escalating", self.number, timeout)
            self._escalate(process)

        # The output reader sets the final state as it drains; give it a moment
        # so the answer to this request is the finished run and not the one
        # that was still stopping when we let go of the lock.
        if self._reader is not None:
            self._reader.join(timeout=5)
        return self.snapshot()

    def _escalate(self, process: subprocess.Popen) -> None:
        """A runner that will not take SIGINT.

        This loses whatever was still in the module's buffer -- everything
        already written to the files is safe, because they are flushed on every
        read. It is the last resort and it is logged as one.
        """
        with self._lock:
            self.error = (
                f"The runner did not stop within {STOP_GRACE:.0f} s of SIGINT and was "
                "terminated. Counts already written to the files are complete; the "
                "last buffered read from the module was lost."
            )
        for send in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(os.getpgid(process.pid), send)
            except (ProcessLookupError, PermissionError):
                return
            for _ in range(20):
                if process.poll() is not None:
                    return
                time.sleep(0.1)

    # -- what the browser sees --------------------------------------------

    def channel_rows(self, average_seconds: float) -> list[dict]:
        """One row per counter channel the profile reads.

        Only the profile's channels, because a table of ten rows where six are
        permanently zero teaches the operator to skim past it. The module still
        counts all twenty and the file still holds all ten -- what is narrowed
        here is the display, and the run's own files are unaffected.

        `count` is per counting period, exactly as the module reports it;
        `rate` is that divided by the period, which is the number an operator
        compares against a discriminator setting. Both are given rather than
        one, because the period is a setting that changes between runs and a
        rate alone would silently change meaning with it.
        """
        period = (self.count_period_ms or 1000) / 1000.0
        profile = self.display_profile
        wanted = profile.counter_channels if profile else list(COUNTER_CHANNELS)
        rows = []
        for channel in wanted:
            buffer = self.live.counters.get(channel)
            if buffer is None:
                continue
            latest = buffer.latest
            window = buffer.stats(average_seconds)
            overall = buffer.stats()
            rows.append(
                {
                    "channel": channel,
                    "label": profile.label(channel) if profile else f"Ch{channel}",
                    "count": latest[1] if latest else None,
                    "rate": (latest[1] / period) if latest else None,
                    "at": latest[0] if latest else None,
                    "mean": window["mean"],
                    "mean_rate": (window["mean"] / period) if window["mean"] is not None else None,
                    "min": window["min"],
                    "max": window["max"],
                    "samples": window["n"],
                    "window_span": window["span"],
                    "run_mean": overall["mean"],
                    "run_mean_rate": (
                        overall["mean"] / period if overall["mean"] is not None else None
                    ),
                    "total": overall["n"],
                }
            )
        return rows

    def stamp_rows(self, average_seconds: float) -> list[dict]:
        """One row per time-stamp channel: hits a second, now and on average.

        The profile's trigger channels are listed whether or not they have
        fired -- a selected channel that has produced nothing is a finding, and
        an absent row does not say it. A channel that fires without being
        selected is listed too, and marked: hiding data the module actually
        produced would be the one unforgivable thing for this table to do.
        """
        profile = self.display_profile
        expected = profile.trigger_channels if profile else []
        seen = sorted(self.live.stamps)

        # A channel the profile watches that has fired nothing is at zero, not
        # at an unknown rate -- but only once the run has a finished second to
        # say that about. Before then there is genuinely nothing to report, and
        # a dash says so; after it, a dash would read as "not measured" when
        # the finding is "silent".
        settled = self.live.module_time >= 2.0

        def known(value: float | None) -> float | None:
            return value if value is not None else (0.0 if settled else None)

        rows = []
        for channel in list(expected) + [c for c in seen if c not in expected]:
            bins = self.live.stamps.get(channel)
            if bins is None:
                rows.append(
                    {
                        "channel": channel,
                        "label": profile.label(channel) if profile else f"Ch{channel}",
                        "expected": True,
                        "total": 0,
                        "rate": known(None),
                        "rate_1s": known(None),
                        "rate_10s": known(None),
                        "mean_rate": known(None),
                        "first": None,
                        "last": None,
                        "recent": [],
                    }
                )
                continue
            span = bins.span
            rows.append(
                {
                    "channel": channel,
                    "label": (
                        profile.label(channel) if profile and channel in expected
                        else f"Ch{channel}"
                    ),
                    "expected": channel in expected,
                    "total": bins.total,
                    "rate": bins.rate(average_seconds),
                    # The last second that finished, and the ten before it.
                    # Both exclude the second still filling, so neither is the
                    # partial-second undercount the raw bin would give.
                    "rate_1s": known(bins.rate_over(1)),
                    "rate_10s": known(bins.rate_over(PRINT_ROWS)),
                    "mean_rate": bins.mean_rate(),
                    "first": span[0] if span else None,
                    "last": span[1] if span else None,
                    "recent": list(self.live.recent_stamps.get(channel, []))[-6:],
                }
            )
        return rows

    def counter_print(self, rows: int = PRINT_ROWS) -> dict:
        """The last few counting periods, in the shape the runner prints them.

        `event# time(s) #timestamp` then one column per channel -- the table
        that has scrolled past in a terminal for as long as this module has
        been run by hand. It is kept because reading the raw numbers go by is
        how you notice a channel that has started counting nothing, well
        before a mean over a minute has moved.
        """
        profile = self.display_profile
        channels = profile.counter_channels if profile else list(COUNTER_CHANNELS)
        with self._lock:
            recent = list(self.live.recent)[-rows:]
        return {
            "channels": channels,
            "labels": [profile.label(c) if profile else f"Ch{c}" for c in channels],
            "rows": [
                {
                    "index": row["index"],
                    "time": row["time"],
                    "stamps": row["stamps"],
                    "counts": [row["counts"].get(channel, 0) for channel in channels],
                }
                for row in recent
            ],
        }

    def stamp_print(self, seconds: int = PRINT_ROWS) -> dict:
        """Hits per second, per channel, for the last few complete seconds.

        The counter printout's opposite number. Time stamps are one line per
        event in the file and nobody reads those, but how many arrived in each
        of the last ten seconds is exactly what tells you a trigger has just
        stopped -- and a mean over a minute would take a minute to say it.
        """
        profile = self.display_profile
        expected = profile.trigger_channels if profile else []
        with self._lock:
            present = sorted(self.live.stamps)
        channels = list(expected) + [c for c in present if c not in expected]

        # One row per second, so the columns line up down the block; every
        # channel is asked about the same seconds rather than its own.
        per_channel = {channel: dict(self.live.stamps[channel].recent(seconds))
                       for channel in channels if channel in self.live.stamps}
        moments = sorted({second for bins in per_channel.values() for second in bins})[-seconds:]

        return {
            "channels": channels,
            "labels": [
                (profile.label(c) if profile and c in expected else f"Ch{c}")
                for c in channels
            ],
            "rows": [
                {
                    "second": second,
                    "counts": [per_channel.get(channel, {}).get(second, 0)
                               for channel in channels],
                }
                for second in moments
            ],
        }

    def snapshot(self, average_seconds: float = 60.0) -> dict:
        with self._lock:
            return {
                "state": self.state,
                "mode": self.mode,
                "run_number": self.number,
                "name": self.name,
                "note": self.note,
                "started_at": self.started_at,
                "stopped_at": self.stopped_at,
                "elapsed": self.elapsed,
                "acq_time_sec": self.acq_time_sec,
                "count_period_ms": self.count_period_ms,
                # The profile as it stands now, so the page relabels the moment
                # a channel is renamed. What the run was taken with is in its
                # metadata, written once at the start.
                "profile": (self.display_profile.to_json() if self.profile else None),
                "sid": self.sid,
                "command": self.command,
                "error": self.error,
                "exit_code": self.exit_code,
                "average_seconds": average_seconds,
                "module_time": self.live.module_time,
                "rows": self.live.rows,
                "stamp_events": self.live.stamp_events,
                "malformed": self.live.malformed,
                "skipped_bytes": self.live.skipped_bytes,
                "counters": self.channel_rows(average_seconds),
                "stamps": self.stamp_rows(average_seconds),
                "counter_print": self.counter_print(),
                "stamp_print": self.stamp_print(),
                "print_rows": PRINT_ROWS,
                "log": self.log_lines[-40:],
            }

    def series(
        self,
        channels: list[int],
        start: float | None,
        end: float | None,
        max_points: int,
    ) -> dict:
        """The live counter buffers, windowed and decimated for a chart."""
        from .series import decimate

        period = (self.count_period_ms or 1000) / 1000.0
        out = []
        with self._lock:
            profile = self.display_profile
            label = profile.label if profile else (lambda ch: f"Ch{ch}")
            for channel in channels:
                buffer = self.live.counters.get(channel)
                if buffer is None:
                    continue
                times, values = buffer.window(start, end)
                total = len(times)
                times, values = decimate(times, values, max_points)
                out.append(
                    {
                        "channel": channel,
                        "label": label(channel),
                        "t": times,
                        "v": values,
                        "total": total,
                        "dropped": buffer.dropped,
                    }
                )
        return {"period": period, "channels": out}

    def stamp_series(self, start: float | None, end: float | None, max_points: int) -> dict:
        from .series import decimate

        profile = self.display_profile
        expected = profile.trigger_channels if profile else []
        out = []
        with self._lock:
            label = profile.label if profile else (lambda ch: f"Ch{ch}")
            for channel in sorted(self.live.stamps):
                times, values = self.live.stamps[channel].series(start, end)
                total = len(times)
                times, values = decimate(times, values, max_points)
                out.append(
                    {
                        "channel": channel,
                        "label": (
                            "all channels" if not channel
                            else label(channel) if channel in expected
                            else f"Ch{channel}"
                        ),
                        "t": times,
                        "v": values,
                        "total": total,
                        "dropped": 0,
                    }
                )
        return {"channels": out}

    def shutdown(self) -> None:
        """Stop a run on the way out rather than orphaning it."""
        if self.running:
            log.warning("service is stopping while run %s is active; stopping it", self.number)
            try:
                self.stop()
            except AcquisitionError:
                pass
        self._stop_event.set()


acquisition = Acquisition()
