#!/bin/bash
# Remove the cooling service. The laptop keeps the last selected mode.
set -euo pipefail

if [ "$(id -u)" != 0 ]; then
    printf 'Run this uninstaller with sudo.\n' >&2
    exit 1
fi

systemctl disable --now laptop-cooling.service
rm -f /etc/systemd/system/laptop-cooling.service \
      /etc/dbus-1/system.d/org.teo.LaptopCooling.conf \
      /usr/share/polkit-1/actions/org.teo.laptopcooling.policy \
      /usr/local/libexec/laptop-cooling/cooling_service.py
rmdir /usr/local/libexec/laptop-cooling 2>/dev/null || true
systemctl daemon-reload
systemctl reload dbus.service
printf 'Cooling service removed. The current Lenovo thermal mode remains selected.\n'
