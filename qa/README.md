# QA harness

An isolated, headless GNOME Shell 46 session that installs the **exact bundle**
that is uploaded to extensions.gnome.org, drives it like a user, checks that it
cleans up after itself, and takes every screenshot used in the repository
artwork.

The live desktop is never touched: the session gets throwaway `XDG_*` and
`HOME` directories, its own session bus (`dbus-run-session`), its own Wayland
socket and a private runtime directory.

```bash
QA_SCENARIO=qa/scenarios/capture-all.json bash qa/run.sh
QA_SCENARIO=qa/scenarios/verify-cleanup.json bash qa/run.sh
QA_SCENARIO=qa/scenarios/capture-menus.json QA_LOCALE=es_ES.UTF-8 bash qa/run.sh
python3 scripts/make-assets.py            # rebuild docs/assets from capture-all
```

Output lands in `qa/out/<scenario>/`: `raw/*.png`, `qa-session.log` (one line
per step, from inside the shell), `shell.log` (the shell's own stderr) and
`*-runner.log` (preferences runner output).

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `QA_SCENARIO` | `qa/scenarios/capture-all.json` | Scenario to run |
| `QA_OUTDIR` | `qa/out/<scenario name>` | Where frames and logs are copied |
| `QA_LOCALE` | `en_US.UTF-8` | Locale of the session (used for translation captures) |
| `QA_LOAD` | `0` | Seconds of synthetic CPU load, started 11 s in (use `22` for the fan series) |
| `QA_RUN_ROOT` | `qa/.run` | Disposable session root (config/data/cache/runtime/home) |

## How a run works

1. `scripts/build-extension.sh` builds the zip, `gnome-extensions install`
   installs it into the private `XDG_DATA_HOME`.
2. The QA harness extension (`qa/extension/…-qa@joseteo.github.io`) is enabled
   **before** the extension under test, because GNOME Shell's *rebasing*
   temporarily disables and re-enables every extension listed after the one
   being disabled. The harness keeps its timers across such a cycle and
   continues the scenario.
3. `gnome-shell --wayland --headless --virtual-monitor 1280x800` starts inside
   `dbus-run-session`; the harness reads `LAPTOP_COOLING_QA_SCENARIO`, schedules
   the steps, and touches `qa/.run/out/done` at the end.
4. `run.sh` stops the shell, reaps its helpers, and copies the artifacts.

### Session quirks worth knowing

- **The overview is visible on startup** in a headless session (nothing ever
  hides it, as there are no key presses). The harness hides it 3 s in; otherwise
  its search entry, window badges into the overview and dash icons show up in
  every screenshot.
- **The caller's environment leaks in** unless neutralised. `run.sh` unsets
  `DISPLAY`, forces `GDK_BACKEND=wayland` and `XDG_SESSION_TYPE=wayland`;
  a leaked `DISPLAY` makes GTK children connect to the wrong server.
- **Later sessions fail if earlier ones are not reaped.** Every session starts
  a private D-Bus, gvfs, at-spi, xdg-desktop-portal and evolution-data-server;
  those outlive the shell's SIGTERM. `run.sh` stops every process whose
  `XDG_RUNTIME_DIR` is this run root before and after a session; without that,
  the user's D-Bus connection limit fills up and new sessions die at startup
  with `LimitsExceeded`.
- **GTK4 in a standalone GJS process segfaults** unless `Gtk.init()` is called
  before any widget exists. Both runners do it explicitly.
- **The shell's own “Open Extension Preferences” dialog never maps a window**
  in a headless session. The preferences page is therefore captured with a
  standalone Wayland client (`qa/runner/prefs-window.js`) that loads the very
  same `prefs.js`; it also needs `ExtensionPreferences.lookupByUUID` stubbed so
  gettext resolves against the installed extension directory.

## Scenarios

| File | What it does |
| --- | --- |
| `capture-all.json` | 22 frames for the artwork: quick settings, peak menu, expanded menu, a **real Quiet → Performance** cycle through the service (16-frame series), the temperature tile, a mode-change frame, and the real preferences window. |
| `capture-menus.json` | Short pass for translation screenshots (menu + preferences). |
| `verify-cleanup.json` | Lifecycle checks: actor counts across enable/disable cycles, `destroy` watchers, `connectObject()`/`disconnectObject()` probe. |
| `check-prefs.json` | Debug scenario for the preferences runner (window geometry, actor dump). |

### Steps

Each step is `{"at": <seconds>, "do": <action>}` plus action-specific fields.
Screenshot series use

```json
{"at": 13.0, "do": "series", "name": "fan-curve-1", "count": 7, "interval": 2000}
```

Actions: `open-panel`, `close-panel`, `open-menu`, `shot`, `series`, `prefs`
(DBus dialog, kept for reference), `prefs-window` / `close-prefs-window`,
`setting`, `set-mode`, `toggle-details`, `count-actors`, `probe`,
`cycle-check`, `done`, `note`.

Diagnostics available to scenarios: `overview-state`, `dump-apps`,
`dump-actors` (with an optional `rect`), `extensions-state`,
`disable-extension`, `enable-extension`, `warp-pointer`, `list-windows`,
`env-probe`.

`probe` and `cycle-check` print their evidence into `qa-session.log`:

```
clicked Status row: show-status-details false -> true PASS
actors before=229 enabled=242 disabled=229 re-enabled=242
```

## Artwork pipeline

`scripts/make-assets.py` reads `qa/out/capture-all/raw/`, crops the captures
with the geometry recorded in `qa-session.log` (the preferences window box,
`prefs window rect …`), rounds the corners, and writes `docs/assets/`:
banner, social preview, icon/logo, the panel cards, the preferences window and
the `live-readings.gif` animation assembled from the `fan-curve-*` series.

Requires `python3-gi` (GdkPixbuf with SVG), Pillow, and a font with Cantarell
metrics for the banner.
