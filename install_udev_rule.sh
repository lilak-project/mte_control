#!/usr/bin/env bash
# Give this user access to the MTE module, so nothing else here needs root.
#
#   ./install_udev_rule.sh              pick a group automatically
#   ./install_udev_rule.sh --group daq  use a specific one
#
# This is the one command in the whole service that asks for a password, and it
# is asked once: after it the rule is on disk and every boot, every replug and
# every service restart works unprivileged.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template="$here/udev/99-mte-scaler.rules"
installed=/etc/udev/rules.d/99-mte-scaler.rules
vendor=0547
product=1309

group=""
[[ "${1:-}" == "--group" ]] && group="${2:-}"

if [[ ! -f "$template" ]]; then
  echo "Cannot find $template" >&2
  exit 1
fi

user="$(id -un)"

# Which group to hand the device to. Whatever we pick, the user has to already
# be in it -- a rule naming a group they are not in changes nothing, and would
# be an unusually quiet way to fail.
if [[ -z "$group" ]]; then
  for candidate in plugdev dialout uucp users; do
    if id -nG "$user" | tr ' ' '\n' | grep -qx "$candidate"; then
      group="$candidate"
      break
    fi
  done
fi

if [[ -z "$group" ]]; then
  echo "Could not find a group to use. '$user' is in: $(id -nG "$user")" >&2
  echo >&2
  echo "Pick one of those and pass it:   ./install_udev_rule.sh --group <name>" >&2
  echo "Or join the usual one:           sudo usermod -aG plugdev $user" >&2
  echo "                                 (then log out and back in)" >&2
  exit 1
fi

if ! id -nG "$user" | tr ' ' '\n' | grep -qx "$group"; then
  echo "'$user' is not in the group '$group', so the rule would change nothing." >&2
  echo "  sudo usermod -aG $group $user     (then log out and back in)" >&2
  exit 1
fi

echo "Installing the rule, giving the module to group '$group'."
sed "s/GROUP=\"plugdev\"/GROUP=\"$group\"/" "$template" | sudo tee "$installed" >/dev/null
sudo udevadm control --reload-rules
sudo udevadm trigger --attr-match=idVendor=$vendor --attr-match=idProduct=$product

# udev applies the new mode asynchronously; give it a moment before reporting.
sleep 1

node=""
for dir in /sys/bus/usb/devices/*/; do
  [[ -r "$dir/idVendor" && -r "$dir/idProduct" ]] || continue
  [[ "$(cat "$dir/idVendor")" == "$vendor" && "$(cat "$dir/idProduct")" == "$product" ]] || continue
  node="/dev/bus/usb/$(printf '%03d' "$(cat "$dir/busnum")")/$(printf '%03d' "$(cat "$dir/devnum")")"
done

echo
if [[ -z "$node" ]]; then
  echo "Rule installed at $installed, but no $vendor:$product module is plugged in"
  echo "right now. It takes effect as soon as one is."
  exit 0
fi

ls -l "$node"
if [[ -w "$node" ]]; then
  echo "OK - $user can open the module. No sudo from here on."
else
  echo "Still not writable." >&2
  echo "If you were just added to '$group', the shell you are in does not know it" >&2
  echo "yet: log out and back in, or run 'newgrp $group', then try again." >&2
  exit 1
fi
