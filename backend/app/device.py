"""Is the module there, and may we open it?

Two separate questions, and for this module they have had two different
answers for a long time: the SCALER has always been plugged in, and opening it
has always needed root. Both are answered from sysfs without touching libusb,
so asking costs nothing and can be asked while a run is in progress.
"""

from __future__ import annotations

import getpass
import os
from dataclasses import dataclass, field
from pathlib import Path

from .config import PRODUCT_ID, RUNNER, VENDOR_ID

SYSFS_USB = Path("/sys/bus/usb/devices")


@dataclass
class Device:
    """What we know about the module, and what to do if it is not usable."""

    present: bool
    #: /dev/bus/usb/002/007 -- what libusb actually opens.
    node: str | None = None
    bus: int | None = None
    address: int | None = None
    #: The module answers only when this is true; see `remedy`.
    writable: bool = False
    #: crw-rw---- plugdev, as it stands now.
    mode: str | None = None
    owner: str | None = None
    #: Product and manufacturer strings the device reports, when it has them.
    product: str | None = None
    manufacturer: str | None = None
    serial: str | None = None
    #: The runner binary, separately from the module.
    runner: str = str(RUNNER)
    runner_ok: bool = False
    problems: list[str] = field(default_factory=list)
    remedy: str | None = None

    @property
    def ok(self) -> bool:
        return self.present and self.writable and self.runner_ok


def _read(path: Path) -> str | None:
    try:
        return path.read_text().strip()
    except OSError:
        return None


def _find_sysfs_dir() -> Path | None:
    """The sysfs directory of the first 0547:1309 on the bus."""
    vendor = f"{VENDOR_ID:04x}"
    product = f"{PRODUCT_ID:04x}"
    try:
        entries = sorted(SYSFS_USB.iterdir())
    except OSError:
        return None
    for entry in entries:
        if _read(entry / "idVendor") == vendor and _read(entry / "idProduct") == product:
            return entry
    return None


def _describe_node(node: Path) -> tuple[str | None, str | None]:
    """(mode, owner) of the device node, as `ls -l` would write them."""
    try:
        info = node.stat()
    except OSError:
        return None, None

    import grp
    import pwd
    import stat as stat_module

    try:
        user = pwd.getpwuid(info.st_uid).pw_name
    except KeyError:
        user = str(info.st_uid)
    try:
        group = grp.getgrgid(info.st_gid).gr_name
    except KeyError:
        group = str(info.st_gid)

    return stat_module.filemode(info.st_mode), f"{user}:{group}"


def probe() -> Device:
    """Look the module up now.  Never raises; a failure is part of the answer."""
    runner_ok = RUNNER.is_file() and os.access(RUNNER, os.X_OK)

    directory = _find_sysfs_dir()
    if directory is None:
        return Device(
            present=False,
            runner_ok=runner_ok,
            problems=[
                f"No {VENDOR_ID:04x}:{PRODUCT_ID:04x} device on the USB bus.",
                *([] if runner_ok else [f"The runner {RUNNER} is not an executable file."]),
            ],
            remedy="Check the module is powered and its USB cable is in, then `lsusb`.",
        )

    busnum = _read(directory / "busnum")
    devnum = _read(directory / "devnum")
    node = None
    mode = owner = None
    writable = False
    if busnum and devnum:
        node = Path(f"/dev/bus/usb/{int(busnum):03d}/{int(devnum):03d}")
        mode, owner = _describe_node(node)
        writable = os.access(node, os.W_OK)

    problems: list[str] = []
    remedy: str | None = None

    if not writable:
        problems.append(
            f"The module is on the bus but {getpass.getuser()} cannot open it: "
            f"{node} is {mode or 'unreadable'} {owner or ''}".rstrip()
        )
        # The whole point of the udev rule: this is the one thing that has kept
        # the runner behind `sudo -i`, and it is fixed once, not per run.
        remedy = (
            "Run ./install_udev_rule.sh once (it asks for your password), or by hand:\n"
            "  sudo cp udev/99-mte-scaler.rules /etc/udev/rules.d/\n"
            "  sudo udevadm control --reload-rules\n"
            "  sudo udevadm trigger --attr-match=idVendor=0547 --attr-match=idProduct=1309"
        )
    if not runner_ok:
        problems.append(f"The runner {RUNNER} is not an executable file.")
        remedy = remedy or "Build it:  ./runner/build.sh"

    return Device(
        present=True,
        node=str(node) if node else None,
        bus=int(busnum) if busnum else None,
        address=int(devnum) if devnum else None,
        writable=writable,
        mode=mode,
        owner=owner,
        product=_read(directory / "product"),
        manufacturer=_read(directory / "manufacturer"),
        serial=_read(directory / "serial"),
        runner=str(RUNNER),
        runner_ok=runner_ok,
        problems=problems,
        remedy=remedy,
    )
