#!/bin/bash
# Install the root-owned cooling service.
#
# The service is the only privileged component: it owns the ACPI calls,
# validates the caller through polkit, and exports a read-only status object
# plus a single "set a known preset" method.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

if [ "$(id -u)" != 0 ]; then
    printf 'Run this installer with sudo.\n' >&2
    exit 1
fi

model=$(cat /sys/class/dmi/id/product_name)
bios=$(cat /sys/class/dmi/id/bios_version)
if [ "$model" != 81Y4 ] || [ "$bios" != EGCN41WW ]; then
    printf 'This cooling service is verified only for Lenovo 81Y4 / EGCN41WW (found %s / %s).\n' "$model" "$bios" >&2
    printf 'See docs/hardware-support.md before extending it to another model.\n' >&2
    exit 1
fi

/usr/bin/python3 -I -c 'from gi.repository import Gio, GLib'
command -v modprobe >/dev/null || { printf 'modprobe is required.\n' >&2; exit 1; }
modprobe acpi_call 2>/dev/null || {
    printf 'The acpi_call kernel module is not available. Install your distribution package (for example acpi-call-dkms) first.\n' >&2
    exit 1
}

install -d -o root -g root -m 755 /usr/local/libexec/laptop-cooling
install -o root -g root -m 644 "$root/service/cooling_service.py" /usr/local/libexec/laptop-cooling/cooling_service.py
install -o root -g root -m 644 "$root/service/laptop-cooling.service" /etc/systemd/system/laptop-cooling.service
install -o root -g root -m 644 "$root/service/org.teo.LaptopCooling.conf" /etc/dbus-1/system.d/org.teo.LaptopCooling.conf
install -o root -g root -m 644 "$root/service/org.teo.laptopcooling.policy" /usr/share/polkit-1/actions/org.teo.laptopcooling.policy

systemctl daemon-reload
# Reload configuration, never restart the desktop's system bus.
systemctl reload dbus.service
systemctl enable laptop-cooling.service
systemctl restart laptop-cooling.service

printf 'Cooling service installed. No thermal mode was changed.\n'
gdbus call --system --dest org.teo.LaptopCooling \
    --object-path /org/teo/LaptopCooling \
    --method org.teo.LaptopCooling.GetStatus
