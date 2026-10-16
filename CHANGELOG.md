# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-16

First release, submitted to extensions.gnome.org.

### Added

- **Cooling tile in Quick Settings** (`QuickSettings.QuickMenuToggle`) showing
  the active preset, with an optional peak temperature in the subtitle. No
  separate top-bar button.
- **Peak-first status row**: the menu opens with one summary line
  (`93 °C · 4,900 RPM`) that expands *in place* to CPU, GPU, Fan 1 and Fan 2
  readings without closing the menu.
- **Native presets**: Quiet, Balanced and Performance, written through the
  firmware's own ACPI setter, never a userspace fan curve.
- **Root-owned cooling service** (`org.teo.LaptopCooling`) exposing exactly two
  D-Bus methods, `GetStatus` and `SetMode`, guarded by polkit
  (`org.teo.laptopcooling.set-mode`).
- **Model gate**: the service verifies DMI model `81Y4` and BIOS `EGCN41WW`
  before it starts; unknown hardware is never touched.
- **Firmware transaction lock**: every ACPI read/write is serialised through an
  exclusive lock on `/run/lock/ideapad-fan-getters.lock`.
- **Graceful degradation**: without the service the tile opens with a *Cooling
  service unavailable* message and a link to the setup instructions.
- **Preferences page** with three settings (temperature in tile, refresh
  interval 5-30 s, expand status by default) and links to the documentation,
  issue tracker and version.
- **Translations**: English (source) and Spanish (complete).
- **Test and QA tooling**: `scripts/run-tests.sh` (service unit tests, D-Bus
  round trip with a simulated service, schema, metadata, catalogue and
  JavaScript checks) and `qa/run.sh`, an isolated headless GNOME Shell session
  that installs the packaged extension, verifies lifecycle cleanup and produces
  every screenshot used in the documentation.
- **Documentation**: architecture, hardware support, publishing notes, QA
  manual and generated artwork.

### Notes

- Target shell version: GNOME Shell **46** (Ubuntu 24.04, Wayland and X11).
- Hardware coverage is intentionally narrow and verified: Lenovo IdeaPad Gaming
  3 15IMH05 (81Y4, BIOS EGCN41WW). Other models install and report
  "unsupported" rather than guessing at firmware calls.

[1.0.0]: https://github.com/joseteo/laptop-cooling/releases/tag/v1.0.0
