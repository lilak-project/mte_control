"""Profiles: naming an experiment so a run is set up by choosing, not retyping."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import profiles as store
from .. import runs
from ..config import COUNTER_CHANNELS, DOWN_SCALE_CHANNELS, INPUT_CHANNELS, TRIGGER_CHANNELS
from ..schemas import ProfileRequest, SetupTextRequest

router = APIRouter(prefix="/api/profiles", tags=["profiles"])


def _detail(profile: store.Profile) -> dict:
    """A profile, plus the two things the UI always wants beside it."""
    body = profile.to_json()
    body["next_run"] = runs.next_number(profile.id)
    body["run_count"] = len(runs.numbers_for(profile.id))
    body["setup_text"] = store.render(profile)
    return body


@router.get("")
def list_profiles() -> dict:
    """Every saved profile, and what the module's channels are.

    The channel lists come from the backend rather than being repeated in the
    UI, because they are a property of the module: twenty inputs, of which the
    first ten are triggers that produce time stamps and the last ten are
    scalers that are counted, and three of which have a down-scale divider.
    """
    try:
        saved = store.load_all()
    except store.ProfileError as err:
        raise HTTPException(500, str(err)) from err
    return {
        "profiles": [_detail(profile) for profile in saved],
        "channels": {
            "all": list(INPUT_CHANNELS),
            "trigger": list(TRIGGER_CHANNELS),
            "counter": list(COUNTER_CHANNELS),
            "down_scale": list(DOWN_SCALE_CHANNELS),
        },
        "defaults": {
            "down_scale": store.DEFAULT_DOWN_SCALE,
            "input_type": store.DEFAULT_INPUT_TYPE,
        },
    }


@router.put("")
def save_profile(request: ProfileRequest) -> dict:
    try:
        profile = store.save(
            name=request.name,
            selected=request.selected,
            names=request.names,
            input_type=request.input_type,
            down_scale=request.down_scale,
            note=request.note,
            profile_id=request.id,
            live_channels=request.live_channels,
        )
    except store.ProfileError as err:
        raise HTTPException(422, str(err)) from err
    return _detail(profile)


@router.post("/import")
def import_setup(request: SetupTextRequest) -> dict:
    """Take a pasted setup.txt in, so an existing configuration is not retyped.

    Only the levels and the dividers come across -- that is all a setup.txt
    holds. Which channels the experiment reads, and what they are called, are
    this service's own idea and have to be chosen afterwards.
    """
    try:
        scales, levels = store.parse_setup_text(request.text)
        profile = store.save(
            name=request.name,
            selected=[],
            names={},
            input_type=levels,
            down_scale=scales,
            note="imported from a pasted setup.txt; no channels selected yet",
        )
    except store.ProfileError as err:
        raise HTTPException(422, str(err)) from err
    return _detail(profile)


@router.delete("/{profile_id}")
def delete_profile(profile_id: str) -> dict:
    """Forget a profile.  Its runs stay on disk.

    Deleting the description of an experiment must not delete the experiment.
    """
    kept = len(runs.numbers_for(profile_id))
    if not store.delete(profile_id):
        raise HTTPException(404, f"There is no profile called {profile_id!r}.")
    return {"deleted": profile_id, "runs_left_on_disk": kept}
