"""Profiles: a named experiment, and everything a run of it needs.

A profile answers, once, the questions that used to be answered again before
every run: which channels this experiment reads, what they are called, what
level their inputs are, and how the down-scalers are set. Picking a profile is
then the whole of setting up a run.

Each profile owns a directory under the run root, and its runs are numbered
inside it:

    <RUN_ROOT>/ko2520/setup.txt
    <RUN_ROOT>/ko2520/data/run_000316/
    <RUN_ROOT>/ko2520/converted/run_000316/

Numbering per profile rather than per module is the point of that layout: two
experiments running on the same electronics at different times are not one
sequence, and "run 12" means nothing without saying run 12 of what.

**Selecting a channel does not switch it off in the module.** The scaler counts
all twenty inputs whatever this says, and the runner writes all ten counters to
the file. Selection decides what this service shows and what a chart opens on;
the data on disk is always complete. Input level and down-scale, in contrast,
*are* written into the module.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

from .config import (
    COUNTER_CHANNELS,
    DOWN_SCALE_CHANNELS,
    INPUT_CHANNELS,
    LEGACY_SETUP_FILE,
    PROFILE_FILE,
    RUN_ROOT,
    TRIGGER_CHANNELS,
)

#: What a new profile starts from: no down-scaling, every input negative NIM.
DEFAULT_DOWN_SCALE = [1, 1, 1]
DEFAULT_INPUT_TYPE = [0] * len(INPUT_CHANNELS)


class ProfileError(ValueError):
    """A profile the runner or the module would reject, caught before it is used."""


@dataclass
class Profile:
    id: str
    name: str
    #: Channels this experiment reads, from either half of the module.
    selected: list[int] = field(default_factory=list)
    #: channel -> the operator's name for it.  Missing means "Ch<n>".
    names: dict[int, str] = field(default_factory=dict)
    #: Input level per channel, 0 = negative NIM, 1 = TTL.  All twenty, because
    #: the module is configured for all twenty whether or not we read them.
    input_type: list[int] = field(default_factory=lambda: list(DEFAULT_INPUT_TYPE))
    #: Divider for ch17, ch18, ch19.
    down_scale: list[int] = field(default_factory=lambda: list(DEFAULT_DOWN_SCALE))
    note: str = ""
    updated_at: float = 0.0
    #: Which channel the portal's LIVE tile shows (one counter, one trigger).
    #: None = the first selected one of that kind.
    live_counter: int | None = None
    live_trigger: int | None = None

    # -- the two halves of the module ------------------------------------

    @property
    def counter_channels(self) -> list[int]:
        """Selected scaler inputs: what the counter table and chart show."""
        return [channel for channel in self.selected if channel in COUNTER_CHANNELS]

    @property
    def trigger_channels(self) -> list[int]:
        """Selected trigger inputs: what the time-stamp table and chart show."""
        return [channel for channel in self.selected if channel in TRIGGER_CHANNELS]

    @property
    def live_counter_channel(self) -> int | None:
        """The counter the portal live tile shows: the chosen one if it is still
        selected, else the first selected counter."""
        chans = self.counter_channels
        if self.live_counter in chans:
            return self.live_counter
        return chans[0] if chans else None

    @property
    def live_trigger_channel(self) -> int | None:
        chans = self.trigger_channels
        if self.live_trigger in chans:
            return self.live_trigger
        return chans[0] if chans else None

    def label(self, channel: int) -> str:
        """What to write on a row or a chart legend for this channel.

        The number is always in it. A name is what the operator calls the
        detector; the number is what the file column is, and someone reading a
        chart beside a counter file needs both.
        """
        name = self.names.get(channel, "").strip()
        return f"Ch{channel} {name}" if name else f"Ch{channel}"

    def level(self, channel: int) -> int:
        return self.input_type[channel - 1] if 1 <= channel <= len(self.input_type) else 0

    # -- where its runs live ---------------------------------------------

    @property
    def directory(self) -> Path:
        """This profile's own tree.  Everything about its runs is under here."""
        return RUN_ROOT / self.id

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "selected": list(self.selected),
            "names": {str(channel): name for channel, name in self.names.items()},
            "input_type": list(self.input_type),
            "down_scale": list(self.down_scale),
            "note": self.note,
            "updated_at": self.updated_at,
            "directory": str(self.directory),
            "counter_channels": self.counter_channels,
            "trigger_channels": self.trigger_channels,
            "labels": {str(channel): self.label(channel) for channel in self.selected},
            "live_counter": self.live_counter,
            "live_trigger": self.live_trigger,
            "live_counter_channel": self.live_counter_channel,
            "live_trigger_channel": self.live_trigger_channel,
        }


# -- validation -----------------------------------------------------------


def validate(down_scale: list[int], input_type: list[int]) -> tuple[list[int], list[int]]:
    """The same checks `read_setup` in the runner makes, with better messages.

    Made here rather than left to the runner because the runner discovers them
    after it has already opened the module and reset it: an operator would see
    a run that started and immediately died, with the reason in a log.
    """
    if len(down_scale) != len(DOWN_SCALE_CHANNELS):
        raise ProfileError(
            f"Expected {len(DOWN_SCALE_CHANNELS)} down-scale values, got {len(down_scale)}."
        )
    if len(input_type) != len(INPUT_CHANNELS):
        raise ProfileError(
            f"Expected {len(INPUT_CHANNELS)} input levels, got {len(input_type)}."
        )

    scales = []
    for channel, value in zip(DOWN_SCALE_CHANNELS, down_scale):
        try:
            number = int(value)
        except (TypeError, ValueError):
            raise ProfileError(f"ch{channel} down-scale is not a whole number: {value!r}") from None
        if number < 1:
            raise ProfileError(f"ch{channel} down-scale must be 1 or more, not {number}.")
        scales.append(number)

    levels = []
    for channel, value in zip(INPUT_CHANNELS, input_type):
        try:
            number = int(value)
        except (TypeError, ValueError):
            raise ProfileError(f"ch{channel} input level is not a whole number: {value!r}") from None
        if number not in (0, 1):
            raise ProfileError(f"ch{channel} input level must be 0 (NIM) or 1 (TTL), not {number}.")
        levels.append(number)

    return scales, levels


def clean_selection(selected: list[int]) -> list[int]:
    wanted = []
    for value in selected or []:
        try:
            channel = int(value)
        except (TypeError, ValueError):
            raise ProfileError(f"{value!r} is not a channel number.") from None
        if channel not in INPUT_CHANNELS:
            raise ProfileError(
                f"ch{channel} is not a channel; the module has {INPUT_CHANNELS[0]}"
                f"..{INPUT_CHANNELS[-1]}."
            )
        if channel not in wanted:
            wanted.append(channel)
    return sorted(wanted)


def clean_live(value, allowed) -> int | None:
    """A live-tile channel choice: an integer among `allowed`, or None."""
    try:
        channel = int(value)
    except (TypeError, ValueError):
        return None
    return channel if channel in allowed else None


def clean_names(names: dict) -> dict[int, str]:
    cleaned: dict[int, str] = {}
    for key, value in (names or {}).items():
        try:
            channel = int(key)
        except (TypeError, ValueError):
            continue
        text = str(value).strip()
        if text and channel in INPUT_CHANNELS:
            cleaned[channel] = text
    return cleaned


# -- setup.txt ------------------------------------------------------------


def render(profile: Profile) -> str:
    """The setup.txt the runner will read for this profile.

    Only the first two lines are parsed -- `read_setup` stops after twenty-three
    integers -- so everything after them is a note for whoever opens the
    profile's directory later, and this is the one place the channel names are
    written down beside the numbers they configure.
    """
    scales, levels = validate(profile.down_scale, profile.input_type)

    lines = [
        " ".join(str(value) for value in scales),
        " ".join(str(value) for value in levels),
        "-" * 75,
        f"Profile: {profile.name}",
    ]
    if profile.note:
        lines.append(f"Note: {profile.note}")
    lines += [
        "",
        "1. Down-scale " + ", ".join(f"ch{c} = {v}" for c, v in zip(DOWN_SCALE_CHANNELS, scales)),
        "2. Input signal level ch1 ~ ch20, 0 = negative NIM, 1 = TTL",
        "",
        "Channels this profile reads (the module counts all twenty regardless;",
        "this is what the display and the analysis are about):",
    ]

    if profile.selected:
        for channel in profile.selected:
            kind = "trigger, time-stamped" if channel in TRIGGER_CHANNELS else "scaler, counted"
            level = "TTL" if levels[channel - 1] else "NIM"
            name = profile.names.get(channel, "")
            lines.append(f"  ch{channel:<3} {level:<4} {kind:<22} {name}")
    else:
        lines.append("  (none selected)")

    lines.append("")
    return "\n".join(lines)


def parse_setup_text(text: str) -> tuple[list[int], list[int]]:
    """Read a setup.txt back.  Same rule as the runner: the first 23 integers.

    Which is why the trailing prose is safe -- and also why a stray number in
    it would not be: this stops as soon as it has twenty-three, exactly where
    the runner's `fscanf` loop does.
    """
    numbers: list[int] = []
    for token in re.findall(r"-?\d+", text):
        numbers.append(int(token))
        if len(numbers) == len(DOWN_SCALE_CHANNELS) + len(INPUT_CHANNELS):
            break
    if len(numbers) < len(DOWN_SCALE_CHANNELS) + len(INPUT_CHANNELS):
        raise ProfileError(
            f"A setup needs {len(DOWN_SCALE_CHANNELS) + len(INPUT_CHANNELS)} numbers; "
            f"this text has {len(numbers)}."
        )
    cut = len(DOWN_SCALE_CHANNELS)
    return validate(numbers[:cut], numbers[cut:])


def write_setup(profile: Profile) -> Path:
    """Put this profile's setup.txt in its own directory, and return the path.

    In the profile's directory rather than a temporary one, because it is also
    the record: anyone who opens `runs/ko2520/` later finds the configuration
    its runs were taken with, beside the runs.
    """
    profile.directory.mkdir(parents=True, exist_ok=True)
    path = profile.directory / "setup.txt"
    path.write_text(render(profile))
    return path


# -- the store ------------------------------------------------------------


def slug(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return base or f"profile-{int(time.time())}"


def _from_json(item: dict) -> Profile | None:
    try:
        scales, levels = validate(
            item.get("down_scale", DEFAULT_DOWN_SCALE),
            item.get("input_type", DEFAULT_INPUT_TYPE),
        )
        selected = clean_selection(item.get("selected", []))
    except ProfileError:
        # A profile edited by hand into something the module would reject is
        # skipped rather than taking the whole list down with it.
        return None
    name = str(item.get("name") or item.get("id") or "unnamed")
    return Profile(
        id=str(item.get("id") or slug(name)),
        name=name,
        selected=selected,
        names=clean_names(item.get("names", {})),
        input_type=levels,
        down_scale=scales,
        note=str(item.get("note", "")),
        updated_at=float(item.get("updated_at", 0.0)),
        live_counter=clean_live(item.get("live_counter"), COUNTER_CHANNELS),
        live_trigger=clean_live(item.get("live_trigger"), TRIGGER_CHANNELS),
    )


def load_all() -> list[Profile]:
    """Every saved profile, most recently changed first."""
    path = PROFILE_FILE if PROFILE_FILE.is_file() else LEGACY_SETUP_FILE
    try:
        raw = json.loads(path.read_text())
    except FileNotFoundError:
        return []
    except (OSError, json.JSONDecodeError) as err:
        raise ProfileError(f"{path} could not be read: {err}") from err

    found = [_from_json(item) for item in (raw if isinstance(raw, list) else [])]
    return sorted(
        (profile for profile in found if profile is not None),
        key=lambda profile: profile.updated_at,
        reverse=True,
    )


def _write_all(profiles: list[Profile]) -> None:
    PROFILE_FILE.parent.mkdir(parents=True, exist_ok=True)
    # Written beside the target and moved into place, so a crash mid-write
    # cannot leave the profile list truncated.
    temporary = PROFILE_FILE.with_suffix(".json.tmp")
    temporary.write_text(json.dumps([profile.to_json() for profile in profiles], indent=2))
    temporary.replace(PROFILE_FILE)


def save(
    name: str,
    selected: list[int],
    names: dict,
    input_type: list[int],
    down_scale: list[int],
    note: str = "",
    profile_id: str | None = None,
    live_counter=None,
    live_trigger=None,
) -> Profile:
    """Create a profile, or replace the one with this id."""
    if not name.strip():
        raise ProfileError("A profile needs a name.")
    scales, levels = validate(down_scale, input_type)

    existing = load_all()
    identifier = profile_id or slug(name)
    profile = Profile(
        id=identifier,
        name=name.strip(),
        selected=clean_selection(selected),
        names=clean_names(names),
        input_type=levels,
        down_scale=scales,
        note=note.strip(),
        updated_at=time.time(),
        live_counter=clean_live(live_counter, COUNTER_CHANNELS),
        live_trigger=clean_live(live_trigger, TRIGGER_CHANNELS),
    )
    # The directory is made now rather than at the first run, so a profile is
    # somewhere on disk the moment it exists and the operator can see where.
    profile.directory.mkdir(parents=True, exist_ok=True)
    write_setup(profile)

    _write_all([other for other in existing if other.id != identifier] + [profile])
    return profile


#: (mtime, profiles) of the last read.  See `load_all_fresh`.
_CACHE: tuple[int | None, list[Profile]] = (None, [])


def load_all_fresh() -> list[Profile]:
    """`load_all`, re-reading the file only when it has actually changed.

    The live tables ask for the profile on every status tick -- twice a second,
    per browser -- so that renaming a channel shows up while a run is going.
    That must not become a file read per tick per client, and it must not be a
    stale copy either, so the file's mtime decides.
    """
    global _CACHE
    try:
        stamp = PROFILE_FILE.stat().st_mtime_ns
    except OSError:
        stamp = None
    if _CACHE[0] != stamp:
        try:
            _CACHE = (stamp, load_all())
        except ProfileError:
            # Unreadable right now -- mid-write, most likely. Keep what we had
            # rather than blanking every label on the screen.
            return _CACHE[1]
    return _CACHE[1]


def find_fresh(profile_id: str) -> Profile | None:
    for profile in load_all_fresh():
        if profile.id == profile_id:
            return profile
    return None


def find(profile_id: str) -> Profile | None:
    for profile in load_all():
        if profile.id == profile_id:
            return profile
    return None


def require(profile_id: str | None) -> Profile:
    """The named profile, or the most recently edited one.

    A run must belong to a profile: it is what decides where the files go and
    what number the run gets, so there is no sensible default beyond "the one
    you were last working on".
    """
    if profile_id:
        profile = find(profile_id)
        if profile is None:
            raise ProfileError(f"There is no profile called {profile_id!r}.")
        return profile
    saved = load_all()
    if not saved:
        raise ProfileError("No profile is saved. Make one on the Profile tab first.")
    return saved[0]


def delete(profile_id: str) -> bool:
    """Forget a profile.  Its runs are left on disk untouched.

    Deleting the description of an experiment must not delete the experiment.
    The directory stays, and re-creating a profile with the same name picks its
    runs back up.
    """
    profiles = load_all()
    remaining = [profile for profile in profiles if profile.id != profile_id]
    if len(remaining) == len(profiles):
        return False
    _write_all(remaining)
    return True
