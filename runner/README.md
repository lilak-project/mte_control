# The MTE runner

The C program that opens the module and takes the data. The service starts this
and reads what it writes; it never touches the USB device itself.

```bash
./build.sh
```

Needs `cmake`, `gcc` and the `libusb-1.0` headers. **Not root** — the binary
wants no privilege beyond write access to the USB node, which
`../install_udev_rule.sh` grants once.

## Where it came from

Copied unchanged from `/home/cens-alpha-00/shift_service/mte_control`, so that
this tree builds without it:

| here | from |
|---|---|
| `main.c` | `online/main.c` |
| `src/NoticeCENS_SCALER.c` | `src/NoticeCENS_SCALER.c` |
| `src/NoticeCENS_SCALER.h` | `src/NoticeCENS_SCALER.h` |

Only `CMakeLists.txt` differs, and only in its paths: the original compiled the
driver out of `../src`, a directory one level above the project it belonged to.

Note the header: `src/NoticeCENS_SCALER.h` is the one that declares
`SCALER_stop`, which the copy in `include/` does not. The original build used
`../src` too, so this is the same header it always compiled against — worth
knowing if you ever reach for the other one.

## Running it by hand

Exactly as before; the service passes the same arguments.

```bash
cd runner
./build/run_mte.exe 316 3600 1000       # run number, seconds, counting period ms
./build/run_mte.exe --next 3600 1000    # next free number
./build/run_mte.exe --monitor           # no files, no run number
```

From this directory, because the runner looks for `setup.txt` beside itself
and writes `data/` and `converted/` into the working directory. `setup.txt`
here is a plain starting point -- the service never reads it; it renders its own
from the chosen profile and passes `--setup`.

Ctrl+C stops it: it stops the scaler, drains what is buffered in the module,
closes its four files and exits. The service sends the same SIGINT.

## One thing to know if you pipe it

`main.c` never calls `fflush`, so its output is line-buffered on a terminal and
block-buffered through a pipe. Piped into anything -- `tee`, a log file, this
service -- its start-up lines, the setup readback among them, sit in its own
buffer until enough accumulates or it exits. With `--quiet` that is the whole
run.

The service works around it by spawning through `stdbuf -oL`, which sets the
buffering and then execs, so the runner keeps its pid and its signal handling.
Do the same by hand if you want to watch it live:

```bash
stdbuf -oL ./build/run_mte.exe 316 3600 1000 --quiet | tee run.log
```

This is deliberately *not* fixed in `main.c`: keeping this copy identical to the
one in `shift_service` is worth more than saving the callers a wrapper.
