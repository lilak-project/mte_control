# MTE DAQ

A web front end for the MTE scaler. It starts and stops the same
`run_mte.exe` that has always been run by hand, reads the text files that
program flushes as it goes, and shows the result as a table and a chart --
plus the run catalog, the setup profiles, and every run already on disk.

**It does not need root.** That was the thing worth fixing first: see
[No more `sudo -i`](#no-more-sudo--i).

There is a read-only companion beside it, [`../mte_monitoring`](../mte_monitoring):
the same page with no controls, for a shifter or a wall display. It owns no data
and mirrors this service.


## Control and monitoring

One service, two modes (mte_monitoring was folded in here). **Monitor** shows
the live run and the past runs and cannot start, stop or configure anything.
**Control** adds the Profile tab, the run form and Stop.

Under the portal, control is for a portal manager or an admin of this service
(a portal grant with admin ticked, to the person or a group); everyone else the
portal lets in gets monitoring. The server enforces it: every request that is
not a read answers 403 for a monitoring caller (`backend/app/access.py`).
Someone who may control can switch to Monitor at the top. Run on its own, with
no portal, everything is allowed, as before.

mte_monitoring's elog answer (a pull *service* named "MTE Monitoring") lives on
as `POST /api/elog/monitor`, beside this service's own *system* endpoint at
`/api/elog`. Same name and fields, so its log formats keep filling; elog needs
Discover run once against the new URL.

## Quick start

```bash
./setup.sh                      # builds the runner and the UI; no root
./install_udev_rule.sh          # once, ever. The only command that asks for a password.
./start_server.sh               # http://<this-host>:8004
```

`start_server.sh` prints every address this host answers on, because it sits on
the instrument subnet, the lab LAN and a VPN at once. `./stop_server.sh` stops
it, and stops a run cleanly on the way out.

For frontend work, `npm run dev` serves on 5173 and proxies `/api` and `/ws` to
127.0.0.1:8004, so run the backend alongside it.

## No more `sudo -i`

The runner has needed root for one reason only. The module's USB node is

```
crw-rw-r-- 1 root root  /dev/bus/usb/002/007
```

world-readable, root-writable -- and libusb needs to write. That is the whole
of it. `run_mte.exe` itself is world-executable and wants no privilege beyond
opening that node:

```
USB3Scan_SCALER: found SCALER on bus 2 address 7, but open failed: LIBUSB_ERROR_ACCESS (-3)
```

`udev/99-mte-scaler.rules` gives the node to the `plugdev` group, which is the
group Linux already puts desktop users in for exactly this, and which
`cens-alpha-00` is already in:

```
SUBSYSTEM=="usb", ATTRS{idVendor}=="0547", ATTRS{idProduct}=="1309", MODE="0660", GROUP="plugdev"
```

Install it once and the rule survives every reboot, replug and service restart.
After that nothing in this service -- not the server, not the runner it
spawns -- runs as root, which is why it can be started from a login shell, left
running, and reached from any browser on the LAN.

The **Module** panel at the top of the page checks both halves separately:
whether a 0547:1309 is on the bus, and whether this user can open it. If the
second is no it prints the exact commands. **Open it and see** goes further and
actually opens the module for two seconds -- that resets the scaler, so it is
refused while a run is going.

## How it reads a run

The service never touches the module. It starts `run_mte.exe` and follows what
that program writes:

```
  run_mte.exe ──USB──> module
      │
      ├── counter_N.txt      ─┐  flushed after every read
      └── time_stamp_N.txt   ─┘  from the module
              │
              └──> this service tails both ──> table, chart, means
```

Two processes cannot hold the same libusb handle, and the program that has held
it for months is the one that should keep holding it. Following its files costs
nothing, needs no change to the runner, and means a run started from a terminal
would be just as readable.

The runner is spawned through `stdbuf -oL`, because it never calls `fflush`:
through a pipe its output would otherwise be block-buffered, and with `--quiet`
a run's log would be empty until the run was over. See `runner/README.md`.

Stopping is `SIGINT` -- the same key an operator has always pressed. The runner
catches it, stops the scaler, drains what is still buffered in the module,
closes all four files and exits. **A run stopped from a browser ends with
exactly the same files as one stopped from the terminal.**

Every number on the screen is on the module's own clock: seconds since
`SCALER_start`, which is what both data files are stamped with. Never a wall
clock -- that would mean adding an offset the module does not know about.

## The screen

Three tabs, by what you are doing rather than by what the data is — they are
three different sittings: you set the module up once a week, watch it for a
shift, and read the archive afterwards.

| | |
|---|---|
| **Module & profile** | Is the module on the bus and openable, and what to do if not. **Open it and see** actually opens it for two seconds and prints the module's own readback — and says whether the setup it checked against had to be written into the module, because the runner cannot open it without one. Below it, the profile: which channels this experiment reads, what they are called, their input levels and the down-scalers. |
| **DAQ** | Start and stop. The profile comes first because it decides the rest — where the files go, what number the run gets, which channels appear below. Then the run number (offered, not demanded: empty means the profile's next free one), the counting period, a note, and how long to run for. Below that, a chart and a table for the counter channels and for the trigger channels. |
| **Past runs** | This profile's runs, newest first, and what is in one. |

### Field help

Each field's explanation is behind the small (i) beside its label rather than
printed under the box. They are worth reading once; printed under every box they
are a paragraph of grey text between the operator and the controls, on a panel
whose whole job is to be quick. Anything needed to *act* — the unit, above all —
stays in the label itself.

### The strip beside the tabs

What is *not* in a tab: whether the module is there, whether a run is going, how
far into it, and a **Stop**. Those are true regardless of which tab you came to
use, and splitting the page costs exactly this — on the profile tab you could no
longer see that a run was in progress, which is an hour you can waste not
noticing. The stop button is there for the same reason: a run that needs
stopping needs stopping now, not after navigating.

The strip also says when the status socket has dropped, because a page that has
stopped updating must say so or a frozen reading is read as a steady one.

### How long a run runs for

**Fixed length** is a number of seconds — the module counts its own acquisition
time down and stops itself at zero. **Until I stop it** is the longest the
module will accept, thirty days, which is also the runner's own default. It is a
very long run rather than an endless one, and the tooltip says so: there is no
"forever" to ask for, because `SCALER_write_ACQ_TIME` takes a number of seconds.

### Force the setup write

Before every run the runner reads the module's current down-scale and input
levels back and compares them with the profile. They usually match — the module
keeps its configuration across power cycles — so it leaves the module alone and
prints `SCALER setup already matches setup file.` If they differ it writes the
profile in.

The checkbox makes it write regardless. Reach for it when you doubt the
readback: after a firmware update, after a power cycle, or any time the module
might be reporting one thing and doing another.

### Counts and rates

Both are always given, never one. `count` is what the module reported for the
last counting period, exactly; `rate` is that divided by the period. The period
is a per-run setting, so a rate alone would silently change meaning between runs
and a count alone would not be comparable across them.

### Averaging

**Average over** (10 s · 1 min · 5 min · 15 min · 1 h) sets the trailing window
the `mean` columns cover, for both tables. It is computed on the server from the
sample time tags, because the samples are on the server -- the browser only ever
sees the newest one. The window is remembered per browser.

`run mean` beside it is the same over the whole run. A channel drifting shows up
as the difference between the two.

### Time stamps

The time-stamp file is one line per event, and a channel can write tens of
thousands a second. The individual times are not what anyone reads, so events
are counted into one-second bins as they are parsed and the table is those
bins -- events, hits a second now, hits a second on average, first and last.
The last few raw event times are kept anyway, in the right-hand column, because
"is this channel firing at all" is a question a bin count answers badly at low
rates.

Channels appear as they fire. A channel with no row has produced no time stamp,
which is a real and useful thing to see.

If a channel out-runs the parser the page says so and says how much it skipped.
**Nothing is lost from the data** when that happens -- the runner is still
writing every event and the file on disk is complete; only the live rate becomes
a sample rather than a total.

### The charts

Above their tables, not below: both say the same thing, and the shape is what is
read across the room — the table is what you come closer for when a number looks
wrong.

uPlot, the same kit the vacuum service uses, for the same reason: a chart that
is fed rather than rebuilt keeps the cursor, the selection and the zoom while
new data arrives once a second.

A zoom is a statement about the run you are looking at, so it does not survive
the run changing: opening another run puts the window back to the whole of it.

Drag to zoom, shift-drag to pan, wheel to zoom, double-click to go back. A
gesture does not magnify what is on screen -- it asks the server for the samples
inside the new window.

Points are decimated min/max, never by a stride: a burst on a scaler channel can
be one period wide and a stride steps straight over it. Min/max keeps the
extreme of every bucket, so the envelope on screen is the envelope in the data.
The line under each chart says how many of the window's points are drawn.

Eight channels is the most one chart will draw. The palette is
colour-vision-validated for eight and a ninth hue would make that guarantee
false; the table carries all ten regardless, and identity is never in the colour
alone -- the chart's live legend names every channel at the cursor.

### Monitor mode

**Monitor only** runs the module without writing anything and without taking a
run number. The runner opens no files in this mode, so the counts come off its
own per-second table on stdout -- exact -- and the time-stamp figure is a total
across every channel rather than a per-channel breakdown. The page says so.

## On another machine

Copy the directory and run `./setup.sh`. That is the whole procedure — the tree
is about 85 kB without its build artefacts, and nothing in it names the machine
it came from.

```bash
rsync -a --exclude node_modules --exclude frontend/dist --exclude runner/build \
      --exclude backend/runs --exclude mte.conf  mte_control/  other-host:~/mte_control/
ssh other-host 'cd mte_control && ./setup.sh && ./install_udev_rule.sh'
```

Two things do not survive a move and are rebuilt rather than copied: `runner/build`,
whose CMake cache records the absolute path it was configured in, and
`frontend/dist`, whose sourcemaps do. `./setup.sh` makes both. Everything else in
the tree is relative to where it sits.

If you take `../mte_monitoring` too, keep them siblings: it finds this service by
relative path in three places (`vite.config.ts`, `tsconfig.app.json`, `run.py`).

`./setup.sh --check` tests the machine without building anything. What it needs:

| | |
|---|---|
| `cmake`, `gcc`, `pkg-config`, `libusb-1.0` **headers** | to build the runner |
| `python3` ≥ 3.10 | the server |
| `npm` | only to *build* the UI. Copy `frontend/dist` across instead and it is not needed at all. |

```bash
sudo apt install cmake gcc pkg-config libusb-1.0-0-dev python3 nodejs npm
```

### Paths

Every default is relative to this directory, so a copy is correct with no
editing. What is particular to a machine goes in **`mte.conf`** beside the code,
which is not in version control — `./setup.sh` writes one from
`mte.conf.example` if there is none, and every setting in it is optional and
commented.

Settings are read from the environment first, then `mte.conf`, then the
built-in default, so anything can be overridden for one run without editing a
file:

```bash
MTE_PORT=8005 ./start_server.sh
```

A relative path in `mte.conf` is relative to this directory and therefore means
the same thing everywhere; an absolute one wins, which is what you want when
run data belongs on a particular array:

```
MTE_RUN_ROOT=/data1/ko2520/mte_control
```

The server prints, on start-up, which config file it read, which runner it is
using, where runs go, and one line per profile with its run count and its next
number — so a misconfigured copy says so in its first ten lines rather than by
behaving oddly later.

### The udev rule

`install_udev_rule.sh` picks a group the operator is already in — `plugdev`,
then `dialout`, `uucp`, `users` — and writes that into the rule, because a rule
naming a group you are not in changes nothing and fails quietly. Override it
with `--group <name>`, and if you are in none of them it says so and gives you
the `usermod` line.

## Standalone

This tree builds and runs on its own. `runner/` holds the C program that
actually talks to the module — `main.c` and the `NoticeCENS_SCALER` driver,
byte-identical to `shift_service/mte_control/online/main.c` and
`shift_service/mte_control/src/`, with a `CMakeLists.txt` that no longer reaches
up into a sibling directory:

```
runner/
  main.c                     the runner, unchanged
  src/NoticeCENS_SCALER.c    the libusb driver, unchanged
  src/NoticeCENS_SCALER.h
  CMakeLists.txt             builds against libusb-1.0 and nothing else
  build.sh
```

`./runner/build.sh` needs `cmake`, `gcc` and `libusb-1.0` headers, and no root.
Verified with `shift_service` treated as absent: server starts, UI serves, API
answers, run catalog is simply empty.

Two references to the old tree remain, and both are optional fallbacks that
degrade to nothing:

| | |
|---|---|
| `LEGACY_RUNNER` | Used only if `runner/build/` does not exist. Same source, so it is a fallback and not a second version — and the server says on start-up when it is on it, so a tree that never got built does not look like one that did. |

Runs are read from `backend/runs` and nowhere else. The runs worth keeping were
copied into it and now live under `backend/runs/ko2520/`; `shift_service` is no
longer consulted at all, and its `programmer/` (firmware updates), `macros/`,
`test/` and older `run/` tree were never about taking data.

### Keeping the two runners in step

There are now two copies of `main.c` on this host. They are identical today:

```bash
diff runner/main.c /home/cens-alpha-00/shift_service/mte_control/online/main.c
diff runner/src/NoticeCENS_SCALER.c /home/cens-alpha-00/shift_service/mte_control/src/NoticeCENS_SCALER.c
```

If the runner is ever changed, change it here and rebuild — this is the copy the
service runs.

## Profiles

A profile is one experiment. It answers, once, what used to be answered again
before every run:

| | |
|---|---|
| **Which channels it reads** | ch3, ch9, ch10, ch13, ch14, ch15 for KO2520 |
| **What they are called** | the operator's name, shown beside the number everywhere |
| **Input levels** | 0 = negative NIM, 1 = TTL, for all twenty |
| **Down-scale** | the dividers on ch17, ch18, ch19 |

The module's twenty inputs are two different things, and which half a channel is
in decides what data it makes — so the editor is split the same way:

```
ch1 … ch10    trigger inputs   every pulse written to the time-stamp file
ch11 … ch20   scaler inputs    counted, latched once a counting period
```

which is why KO2520's six channels are three of each, read out of two different
files.

**Selecting a channel does not switch it off in the module.** The scaler counts
all twenty whatever a profile says, and the runner writes all ten counters to
every file. Selection decides what this page shows and what a chart opens on;
the data on disk is always complete, and a channel that fires without being
selected is still listed — marked, not hidden.

Levels and down-scale, in contrast, really are written into the module when a
run starts.

### One directory per profile, and its own numbering

```
backend/runs/ko2520/
  setup.txt                     what its runs are taken with
  data/run_000317/              counter_317.dat  time_stamp_317.dat
  converted/run_000317/         counter_317.txt  time_stamp_317.txt
```

Numbering restarts inside each profile, and nothing outside a profile's own
directory can move its next number. Two experiments on the same electronics at
different times are not one sequence, and "run 12" means nothing without saying
run 12 of what — so a run is identified by the pair, and the API addresses it
that way: `/api/profiles/ko2520/runs/317`.

Deleting a profile forgets the profile. Its runs stay on disk: deleting the
description of an experiment must not delete the experiment, and re-creating a
profile with the same name picks its runs back up.

## Runs and names

The runner names a run by number and nothing else: `run_000317` is all the
filesystem knows. A number is enough to sort by and not enough to find anything,
so the operator's name and note are kept beside it in `backend/data/runs.json`,
keyed by profile and number.

That file is **not the data**. Delete it and every run is still listed, just
unnamed. Naming a run — including long after it was taken, which is usually when
you know what it was — moves and rewrites nothing, so the paths in anyone's
notes still resolve.

A run also stores the profile as it stood when it was taken, so a past run reads
with the channel names it was taken with rather than whatever the profile says
today.

## Layout

```
setup.sh               prepare a fresh copy on a new machine
mte.conf.example       this machine's own paths; every setting optional
runner/                the C program that holds the module -- vendored, builds alone
backend/
  run.py               start the server; prints the module's state
  app/
    device.py          is it there, may we open it -- from sysfs, not libusb
    acquisition.py     spawn, follow, stop; the live buffers
    parser.py          the two converted-file formats, live and after the fact
    series.py          sample buffers, rolling means, min/max decimation
    runs.py            the run catalog, per profile
    archive.py         reading a finished run back, with a short cache
    profiles.py        profiles, and rendering setup.txt
    settings.py        environment, then mte.conf, then a relative default
    routers/           control · history · profiles · the status socket
frontend/src/
  components/chart/    uPlot on the run clock
  components/          module · run controls · the two tables · profile · past runs
udev/                  the rule that removes the need for root
```

## Configuration

Every path is an environment variable; the defaults are what this host wants.

| | |
|---|---|
| `MTE_RUNNER` | the `run_mte.exe` to start (default `runner/build/run_mte.exe`) |
| `MTE_RUN_ROOT` | where runs live, one directory per profile (default `backend/runs`) |
| `MTE_DATA_DIR` | where `runs.json` and `setups.json` live (default `backend/data`) |
| `MTE_STATIC_DIR` | the built UI (default `frontend/dist`) |
| `MTE_PORT`, `MTE_HOST` | what `./start_server.sh` listens on |
| `MTE_HISTORY_LIMIT` | counter samples held per channel (default 24 h at 1 Hz) |
| `MTE_STAMP_BYTE_BUDGET` | time-stamp bytes parsed per pass before it skips ahead |
| `MTE_CONFIG` | a different settings file to `mte.conf` |

## In the LILAK elog — this service is a SYSTEM

A *service* answers when elog asks. A **system** also speaks first: it owns the
run, and tells elog when one starts and ends, so the elog's run number and the
DAQ's are the same number by construction rather than by someone retyping it.

mte_control is the system, not `../mte_monitoring` — only this process knows
when a run begins, because it spawns the runner. The mirror would have to poll
for the transition and would still be guessing. The two registrations are
complementary: register **this** as a system for the run boundaries, and
`mte_monitoring` as a plain service for the counter values elog pulls.

Register it once, in the elog's Experiment tab → New Service, with

```
portal://mte_control/api/elog
```

Discover reads back `is_system: true`; on registration elog creates the
`Init / Start / End / Monitoring of MTE run` formats, issues an API token, and
POSTs it here as an `elog_credentials` event. `app/elog.py` stores it in
`backend/data/elog_credentials.json`, mode 0600 — it can post logs as this
system, so it is not in version control.

| | |
|---|---|
| run starts | `log_type: 12` (Start of run) — the five fields below, plus a readable body |
| run ends | `log_type: 13` (End of run) with the outcome, elapsed time, row and stamp counts, and where the files went |

### The Start-of-run fields

The run's parameters go up twice on purpose: as `format_fields`, which a filter
or an Infography plot can reach, and as a body, which is what a shifter reads on
a phone at three in the morning.

| key | type in elog | what it carries |
|---|---|---|
| `run_number` | number entry | the run number, as a plottable number (the format's builtin Run field carries it too, for elog's own run tracking) |
| `note` | text | the note the run was started with |
| `run_length_s` | number entry | the REQUESTED length in seconds, which is what is known at start |
| `monitoring` | text | `no` for a run, `yes` for a monitor pass — see the caveat below |
| `active_channels` | number entry (multiple) | every channel this run reads, triggers then scalers |

**These keys must exist on the "Start of MTE run" format**, added once in elog's
format editor. A key the format does not declare is still stored on the entry
but nothing renders it. `sync_system_formats` never rewrites an existing
format's fields, so the additions survive re-registration.

elog has exactly two custom field types, `text` and `number_entry` (frontend
`utils/formatUtils.js`). There is no boolean and no list type, hence:

- a flag is text (`yes`/`no`), which also reads better in a logbook than `1`/`0`;
- a list of numbers is a `number_entry` in its **multiple** variant, whose
  `{"values": [...]}` shape is a real array. Its summary column shows
  mean ± stddev, which for channel *numbers* is not a meaningful statistic —
  the array itself is intact in `raw.values`. Switch the field to `text` if the
  summary bothers you more than the array helps.

Numbers are sent in the raw `{"single": x}` form the elog manual documents, not
the canonical `{value, error}`. Both display correctly, but the edit form
re-renders a single-variant field from `raw.single`, so the canonical shape
opens for editing with an empty box.

### A monitor pass is not a run

`monitoring` reads `no` on every Start-of-run log today, because a monitor pass
never reaches this push at all: it writes no files and is given no run number
(`acquisition.py`, `self.number = None`), and elog's run logs are keyed by run
number. Pushing one as a Start-of-run anyway would be worse than not logging it
— elog decides what run is going from the latest unclosed `start_of_run`
(`routes/logs.py`), so a monitor pass would look like a run that never ends.

Logging monitor passes properly means sending them as plain logs (`log_type: 0`)
against a non-run format, which is a separate piece of work.

A **failed** run is pushed too. That is the one a logbook most needs to have
caught.

### Nothing here may disturb a run

elog being down, slow, or not yet registered is the ordinary case, not an
error. Every push runs on its own daemon thread and every failure is logged and
dropped — a DAQ that refused to start because a logbook was unreachable would
be a worse instrument. The hooks sit in `acquisition.py` *after* the runner is
up and *after* the run has ended, so a push can never sit between the operator
and the hardware.

### Why `portal://`

elog is portal-managed too, so its port is assigned when it starts and can
differ after a restart — this really happened: mte_control and elog swapped
8026 and 8030 across one restart. `app/portal_peer.py` (a copy of elog's, minus
the part that describes elog to others) resolves the address on every push from
`$PORTAL_DATA_ROOT/elog/projects/<project>/.port`.

Going through the portal proxy instead is not an option: `/pp/<svc>/<proj>/` is
gated on a portal session, and an elog API token is not a portal token.

### What elog cannot do

**elog cannot start or stop a run.** Its manual mentions run commands over a
Command URL, but no such code exists — the only events elog ever sends a
service are `elog_handshake` and `elog_credentials`. The link is one-way: MTE
tells elog what it did. Driving a run from elog would need new features in
elog itself.
