# Laptop Cooling

A GNOME Shell 46 extension that adds a **Cooling** tile to the system menu
with live CPU/GPU temperatures, both fan speeds, and the laptop's native
**Quiet**, **Balanced**, and **Performance** presets.

This file ships inside the extension and is opened by
**Preferences → Setup Instructions**.

## 1. Install the cooling service (once)

The extension is a front-end: all sensors and firmware commands live in a
small root-owned service that must be installed once. Without it, the tile
shows *Cooling service unavailable* and mode changes stay disabled.

From a checkout of the
[project repository](https://github.com/joseteo/laptop-cooling):

```bash
sudo bash scripts/install-service.sh
```

The service verifies the exact laptop model and BIOS, uses the signed
`acpi_call` kernel module from your distribution, and evaluates only
documented firmware getters plus the native preset setter. It never writes
to embedded-controller memory directly.

## 2. Install the extension

From [extensions.gnome.org](https://extensions.gnome.org), search for
*Laptop Cooling*, or install a local build:

```bash
gnome-extensions install --force laptop-cooling@joseteo.github.io.shell-extension.zip
```

Then sign out and back in (Wayland) or press **Alt+F2**, type `r`, Enter
(X11), and enable **Laptop Cooling** in the Extensions application.

## Using the tile

Open the system menu and select the **Cooling** tile:

- CPU and GPU temperatures, updated every few seconds.
- Fan 1 and Fan 2 speeds.
- Quiet, Balanced, and Performance. Performance requires the charger.
  Changing a mode opens the normal system authentication dialog; polkit
  then remembers your choice for a few minutes.

The tile subtitle shows the active preset, optionally with the higher
temperature (**Preferences → Show Temperature in Tile**).

## Good to know

- Lenovo's presets are independent of Ubuntu's CPU power profile. They also
  change the power budget, so **Performance can raise heat as well as fan
  speed**. Balanced is a safe default.
- This extension does not force maximum fan speed. The firmware interface on
  this model reports that feature as unsupported.
- NVIDIA power limits and thermal protection are not touched.
- Removing the extension leaves the last selected Lenovo mode active.

## Supported hardware

Currently exactly one configuration is enabled:

| Model | Product | BIOS |
| --- | --- | --- |
| Lenovo IdeaPad Gaming 3 15IMH05 | `81Y4` | `EGCN41WW` |

Any other model shows *Unsupported hardware* and remains read-only. See the
[hardware support notes](https://github.com/joseteo/laptop-cooling/blob/main/docs/hardware-support.md)
to add another model with real measurements.

## Troubleshooting

Check the service directly:

```bash
gdbus call --system --dest org.teo.LaptopCooling \
  --object-path /org/teo/LaptopCooling \
  --method org.teo.LaptopCooling.GetStatus
journalctl -u laptop-cooling.service -b --no-pager -n 30
```

| Symptom | Cause |
| --- | --- |
| *Cooling service unavailable* | Service not installed or not running |
| *Unsupported hardware* | Model/BIOS not in the verified list |
| Readings show `-` | The firmware refused the sensor query; check the journal |
| Performance item is disabled | Charger not connected |

## Uninstall

```bash
gnome-extensions uninstall laptop-cooling@joseteo.github.io
sudo bash scripts/uninstall-service.sh   # optional, removes the service
```

## License

GPL-2.0-or-later. See `LICENSE` in this folder or the repository root.
