"""Where a setting comes from, and in what order.

This tree is meant to be copied to another machine and built there, so nothing
host-specific may live in the code. Every setting has three sources, most
specific first:

    1. the environment          MTE_ARCHIVE_ROOTS=... ./start_server.sh
    2. mte.conf beside the code (git-ignored; this machine's own paths)
    3. a default relative to the service root, or nothing at all

Which means a fresh copy on a new host runs correctly with no `mte.conf` at
all -- it simply has no archive of older runs to list, because on that host
there is none.
"""

from __future__ import annotations

import os
from pathlib import Path

#: mte/ -- the root of this service, whatever it has been copied to.
SERVICE_ROOT = Path(__file__).resolve().parent.parent.parent

#: This machine's own settings.  Optional, and never in version control.
CONFIG_FILE = Path(os.environ.get("MTE_CONFIG") or (SERVICE_ROOT / "mte.conf"))


def _read_file() -> dict[str, str]:
    """Parse mte.conf: KEY=VALUE, one per line, # comments, optional quotes.

    Deliberately not an .ini and not YAML. The keys are exactly the environment
    variable names, so a setting can be moved between the file and the command
    line without being renamed, and `grep MTE_ ...` finds every mention of it.
    """
    try:
        text = CONFIG_FILE.read_text()
    except OSError:
        return {}

    values: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        key, separator, value = line.partition("=")
        if not separator:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


_FILE = _read_file()


def get(name: str, default: str = "") -> str:
    """One setting: environment, then mte.conf, then the default.

    An empty environment variable counts as set -- `MTE_ARCHIVE_ROOTS=` on the
    command line is how you turn off something mte.conf switched on, and it
    would be useless if an empty string fell through to the file.
    """
    if name in os.environ:
        return os.environ[name]
    return _FILE.get(name, default)


def get_path(name: str, default: Path) -> Path:
    """A path setting.  A relative one is relative to the service root.

    So `MTE_RUN_ROOT=data/runs` means the same thing on every machine this is
    copied to, and an absolute path still wins when someone means a specific
    disk -- which for run data, on a host with a big array mounted somewhere,
    is the usual case.
    """
    raw = get(name).strip()
    if not raw:
        return default
    path = Path(raw).expanduser()
    return path if path.is_absolute() else (SERVICE_ROOT / path)


def get_paths(name: str) -> tuple[Path, ...]:
    """A colon-separated list of paths.  Missing ones are dropped, not an error.

    An archive root that does not exist on this machine is the normal case
    after a copy, not a misconfiguration.
    """
    raw = get(name).strip()
    if not raw:
        return ()
    found = []
    for part in raw.split(":"):
        part = part.strip()
        if not part:
            continue
        path = Path(part).expanduser()
        found.append(path if path.is_absolute() else (SERVICE_ROOT / path))
    return tuple(found)


def get_float(name: str, default: float) -> float:
    try:
        return float(get(name) or default)
    except ValueError:
        return default


def get_int(name: str, default: int) -> int:
    try:
        return int(get(name) or default)
    except ValueError:
        return default


def source_of(name: str) -> str:
    """Where a setting actually came from, for the start-up banner."""
    if name in os.environ:
        return "environment"
    if name in _FILE:
        return str(CONFIG_FILE)
    return "default"
