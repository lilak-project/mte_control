#!/usr/bin/env python3
"""Start the MTE DAQ server.

    python run.py                     # listen on the LAN, port 8004
    python run.py --port 8005
    python run.py --host 127.0.0.1    # this machine only
    python run.py --reload            # development

No sudo. If the module still needs it, this says so on start-up and tells you
the one command that fixes it for good.
"""

from __future__ import annotations

import argparse
import errno
import sys

import uvicorn

from app import device, profiles, runs
from app.config import HOST, PORT, RUNNER_IS_LOCAL, RUN_ROOT, STATIC_DIR
from app.net import browser_url, lan_addresses
from app.settings import CONFIG_FILE, SERVICE_ROOT


def main() -> int:
    parser = argparse.ArgumentParser(description="MTE scaler DAQ server")
    # The defaults come from mte.conf or the environment, so a host that wants
    # a different port says so once rather than in every start command.
    parser.add_argument("--host", default=HOST,
                        help="0.0.0.0 lets other PCs on the LAN connect")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--reload", action="store_true", help="restart on code changes")
    args = parser.parse_args()

    primary = browser_url(args.host, args.port)
    print(f"UI:        {primary}", flush=True)
    print(f"API docs:  {primary}/docs", flush=True)

    state = device.probe()
    if state.ok:
        name = " ".join(filter(None, [state.manufacturer, state.product]))
        print(f"Module:    {name or 'SCALER'} on bus {state.bus} address {state.address} "
              f"({state.node}, {state.mode})", flush=True)
    else:
        print("Module:    NOT USABLE", file=sys.stderr, flush=True)
        for problem in state.problems:
            print(f"           {problem}", file=sys.stderr, flush=True)
        if state.remedy:
            for line in state.remedy.splitlines():
                print(f"           {line}", file=sys.stderr, flush=True)

    print(f"Runner:    {state.runner}{'' if state.runner_ok else '  (NOT EXECUTABLE)'}", flush=True)
    if not state.runner_ok:
        print("           Build it:  ./runner/build.sh", file=sys.stderr, flush=True)
    elif not RUNNER_IS_LOCAL:
        # Pointed outside this tree. Not wrong, but a tree that was never built
        # should not look like one that was.
        print("           ^ outside this tree; ours would be runner/build/run_mte.exe",
              flush=True)

    print(f"Service:   {SERVICE_ROOT}", flush=True)
    print(f"Settings:  {CONFIG_FILE}" if CONFIG_FILE.is_file()
          else f"Settings:  none ({CONFIG_FILE} not present; built-in defaults)", flush=True)
    print(f"Runs:      {RUN_ROOT}", flush=True)

    # One line per profile: how many runs it has and what its next number is.
    # Numbering is per profile, so a single "next run" would be a lie.
    try:
        saved = profiles.load_all()
    except profiles.ProfileError as err:
        print(f"Profiles:  unreadable - {err}", file=sys.stderr, flush=True)
        saved = []
    if saved:
        for profile in saved:
            taken = len(runs.numbers_for(profile.id))
            channels = ", ".join(f"ch{c}" for c in profile.selected) or "no channels selected"
            print(
                f"Profile:   {profile.name} ({profile.id}) - {taken} runs, "
                f"next {runs.next_number(profile.id)}  [{channels}]",
                flush=True,
            )
    else:
        print("Profile:   none saved - make one in the UI before starting a run", flush=True)

    if args.host in ("127.0.0.1", "localhost"):
        print("Bound to loopback only - other machines cannot reach this.", flush=True)
    else:
        # This host is on the instrument subnet, the lab LAN and a VPN at once,
        # so list every address rather than guessing which one you came in on.
        others = [ip for ip in lan_addresses() if f"http://{ip}:{args.port}" != primary]
        if others:
            print("Also reachable at:", flush=True)
            for ip in others:
                print(f"  http://{ip}:{args.port}", flush=True)

    if not STATIC_DIR.is_dir():
        print(f"note: no frontend build at {STATIC_DIR}; run `npm run build` in frontend/",
              flush=True)

    try:
        uvicorn.run("app.main:app", host=args.host, port=args.port,
                    reload=args.reload, log_level="info")
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            print(
                f"Port {args.port} is already in use. "
                f"Either the server is already running, or retry with --port {args.port + 1}.",
                file=sys.stderr,
            )
            return 1
        raise
    return 0


if __name__ == "__main__":
    sys.exit(main())
