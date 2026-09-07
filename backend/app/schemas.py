"""Request bodies.  Responses are plain dicts built by the modules that own them."""

from __future__ import annotations

from pydantic import BaseModel, Field

from .config import DOWN_SCALE_CHANNELS, INPUT_CHANNELS


class StartRequest(BaseModel):
    """What starting a run needs.

    A run belongs to a profile: that is what decides where its files go, what
    number it gets, and which channels the page will show. Everything else has
    a default matching how the runner has been started by hand.
    """

    name: str = Field("", description="What this run is for; shown beside the number.")
    note: str = ""
    profile_id: str | None = Field(
        None, description="The profile to run. Left empty, the one most recently edited."
    )
    run_number: int | None = Field(
        None, description="Left empty, the next free number *within this profile*."
    )
    acq_time_sec: int = Field(
        3600, ge=1, description="Seconds. The module stops itself after this."
    )
    count_period_ms: int = Field(1000, ge=1, description="How often the counters are latched.")
    monitor: bool = Field(
        False, description="Watch the counters without writing any files or taking a run number."
    )
    force_init: bool = Field(
        False, description="Write the setup into the module even if it already reads back equal."
    )


class ProfileRequest(BaseModel):
    """A named experiment: its channels, their names, and their levels."""

    id: str | None = None
    name: str
    selected: list[int] = Field(
        default_factory=list,
        description="Channels this experiment reads. 1-10 are triggers, 11-20 counters.",
    )
    names: dict[str, str] = Field(
        default_factory=dict, description="Channel number -> the operator's name for it."
    )
    input_type: list[int] = Field(
        ..., description=f"{len(INPUT_CHANNELS)} levels, 0 = negative NIM, 1 = TTL."
    )
    live_channels: list[int] = Field(
        default_factory=list,
        description="Channels the portal's live tiles show (empty = the first counter and the first trigger).",
    )
    down_scale: list[int] = Field(
        ..., description=f"Dividers for ch{', ch'.join(map(str, DOWN_SCALE_CHANNELS))}."
    )
    note: str = ""


class SetupTextRequest(BaseModel):
    """Import a hand-written setup.txt by pasting it in."""

    name: str
    text: str


class RenameRequest(BaseModel):
    name: str | None = None
    note: str | None = None
