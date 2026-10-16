#!/bin/bash
# Install or update the extension for the current desktop user.
#
# The bundle produced here is byte-for-byte the one published on
# extensions.gnome.org, so a local install and a store install behave
# identically.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
uuid=laptop-cooling@joseteo.github.io

if [ "$(id -u)" = 0 ]; then
    printf 'Run this installer as your desktop user, without sudo.\n' >&2
    exit 1
fi

bash "$root/scripts/build-extension.sh"
zip="$root/dist/$uuid.shell-extension.zip"

gnome-extensions install --force "$zip"
if gnome-extensions enable "$uuid"; then
    printf '\nLaptop Cooling enabled.\n'
else
    printf '\nExtension files installed. Sign out and back in, then enable "Laptop Cooling" in the Extensions application.\n'
fi
printf 'Update GNOME Shell on X11 with Alt+F2, r, Enter; on Wayland, sign out and back in.\n'
