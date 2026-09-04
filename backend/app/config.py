"""Filesystem locations and tunables shared by the whole backend.

Nothing here is specific to the machine it was written on. Every path defaults
to somewhere inside the service tree, so a copy of this directory on another
host builds and runs with no editing at all; the paths that *are* particular to
a machine -- where its older runs live, which disk its new ones should go on --
come from ``mte.conf`` beside the code, or from the environment.

See ``settings.py`` for the order those are consulted in, and
``mte.conf.example`` for what each one means.
"""

from __future__ import annotations

from pathlib import Path

from .settings import (
    SERVICE_ROOT,
    get,
    get_float,
    get_int,
    get_path,
    get_paths,
)

#: backend/
BACKEND_ROOT = Path(__file__).resolve().parent.parent

#: Where runs.json and setups.json live.
DATA_DIR = get_path("MTE_DATA_DIR", BACKEND_ROOT / "data").resolve()

#: Run metadata: the name and note an operator gave a run number.  The counts
#: themselves are never in here -- they stay in the runner's own files.
RUN_INDEX = DATA_DIR / "runs.json"

#: Saved profiles: a named configuration -- which channels this experiment
#: reads, what they are called, their input levels -- chosen instead of being
#: retyped as twenty-three numbers before every run.
PROFILE_FILE = DATA_DIR / "profiles.json"

#: The profile store this replaced, read once if PROFILE_FILE is not there yet.
LEGACY_SETUP_FILE = DATA_DIR / "setups.json"

#: Built frontend (``frontend/dist``).  Served at / when present.
STATIC_DIR = get_path("MTE_STATIC_DIR", SERVICE_ROOT / "frontend" / "dist").resolve()

#: The C program that actually holds the module.  Its source is vendored under
#: ``runner/`` and built by ``runner/build.sh``, so this tree stands alone --
#: what it needs is not root but write access to the USB node, which the udev
#: rule grants.
LOCAL_RUNNER = (SERVICE_ROOT / "runner" / "build" / "run_mte.exe").resolve()

RUNNER = get_path("MTE_RUNNER", LOCAL_RUNNER).resolve()

#: False when someone has pointed us at a runner outside this tree.  Not wrong,
#: but said out loud on start-up: a tree that was never built should not look
#: like one that was.
RUNNER_IS_LOCAL = RUNNER == LOCAL_RUNNER

#: Where runs live.  Every run is under its profile:
#:
#:     <RUN_ROOT>/<profile>/setup.txt
#:     <RUN_ROOT>/<profile>/data/run_XXXXXX/
#:     <RUN_ROOT>/<profile>/converted/run_XXXXXX/
#:
#: The runner is given ``<RUN_ROOT>/<profile>`` as its working directory and
#: creates ``data`` and ``converted`` under it, exactly as it does by hand --
#: so a profile's directory is the same shape the runner has always produced,
#: and numbering restarts per profile because each is its own experiment.
RUN_ROOT = get_path("MTE_RUN_ROOT", BACKEND_ROOT / "runs").resolve()

#: The port the server listens on unless --port says otherwise.
PORT = get_int("MTE_PORT", 8004)

#: The address it binds.  0.0.0.0 lets other machines on the LAN connect.
HOST = get("MTE_HOST", "0.0.0.0")

#: The module this service drives.
VENDOR_ID = 0x0547
PRODUCT_ID = 0x1309

#: The runner writes its converted text files as it goes and flushes every
#: read, so following those files is how this service sees a live run. This is
#: how often it looks for new lines.
TAIL_INTERVAL = get_float("MTE_TAIL_INTERVAL", 0.25)

#: How often the current state is pushed to the browsers.
BROADCAST_INTERVAL = get_float("MTE_BROADCAST_INTERVAL", 0.5)

#: Counter samples kept in memory per channel: 24 h at one a second. Older
#: samples are still in the run's own file and are read back from it.
HISTORY_LIMIT = get_int("MTE_HISTORY_LIMIT", 24 * 60 * 60)

#: Most bytes of time-stamp text parsed per tail pass. Ten channels at a few
#: hundred kHz would out-run any Python parser; past this the parser skips
#: ahead and says how much it skipped, rather than falling silently behind.
STAMP_BYTE_BUDGET = get_int("MTE_STAMP_BYTE_BUDGET", 8 << 20)

#: Points a series endpoint returns before it decimates. About four per
#: horizontal pixel on a wide chart; past that nothing new becomes visible.
DEFAULT_MAX_POINTS = 2000
MAX_MAX_POINTS = 20000

#: Rows of a counter file parsed before a windowed read starts skipping.
FILE_ROW_BUDGET = get_int("MTE_FILE_ROW_BUDGET", 400_000)

#: The module's twenty inputs are two different things, and which half a
#: channel is in decides what data it produces:
#:
#:   1..10   trigger inputs -- every pulse is written to the time-stamp file
#:   11..20  scaler inputs  -- counted, and latched once a counting period
#:
#: So a profile selecting channels 3, 9, 10, 13, 14, 15 is asking for three
#: time-stamp channels and three counter channels, and they are read from two
#: different files.
TRIGGER_CHANNELS = tuple(range(1, 11))

#: The counter channels, in the order the runner writes them -- which is why a
#: channel is Ch11 in the counter file and ch11 in the setup.
COUNTER_CHANNELS = tuple(range(11, 21))

#: Every input, whose level is configurable.
INPUT_CHANNELS = tuple(range(1, 21))

#: Inputs with a down-scale divider.
DOWN_SCALE_CHANNELS = (17, 18, 19)
