# Architecture

Laptop Cooling is split in two deliberately unequal halves: a small,
unprivileged GNOME Shell extension that only renders and forwards, and a
root-owned system service that is the only code allowed near the firmware.

```
┌─ GNOME Shell session (user) ──────────────┐   ┌─ systemd, root ───────────────────┐
│                                           │   │                                   │
│  extension.js                             │   │  cooling_service.py               │
│   ├─ QuickSettings tile + menu            │   │   ├─ Hardware: model gate          │
│   ├─ GSettings (prefs.js)                 │   │   │   + ACPI \_SB.GZFD.WMAA        │
│   └─ Gio.DBus.system ─────────────────────┼───┼─▶ ├─ polkit CheckAuthorization      │
│                                           │   │   ├─ snapshot cache (5 s poll)     │
│  gettext catalogues (en, es)              │   │   └─ temperatures()                │
│                                           │   │        coretemp · nvidia-smi       │
└───────────────────────────────────────────┘   └───────────────────────────────────┘
        │                                                  │
        │ D-Bus: org.teo.LaptopCooling                     │ ACPI via /proc/acpi/call
        │  GetStatus() → s (JSON)                          │ (acpi_call module)
        │  SetMode(s)  → s (JSON)                          ▼
        │                                        embedded controller / firmware
```

## The extension (`extension/…/extension.js`, 323 lines)

`LaptopCooling extends Extension` and owns exactly one `SystemIndicator`
containing one `QuickMenuToggle`. There is no panel button of its own; the tile
appears with the other Quick Settings tiles.

**Menu layout**

| Item | Class | Behaviour |
| --- | --- | --- |
| Header | `menu.setHeader()` | Fan icon + *Laptop Cooling* |
| Quiet / Balanced / Performance | `PopupMenu.PopupMenuItem` | Calls `SetMode`. Checkmark follows the mode reported by the service, not the click. |
| Separator | `PopupMenu.PopupSeparatorMenuItem` | |
| Status (peak) | `PopupMenu.PopupBaseMenuItem({activate: false})` + own `Clutter.ClickAction` | Shows `95 °C · 4,900 RPM`; clicking expands/collapses the four readings in place. |
| CPU / GPU / Fan 1 / Fan 2 | `St.BoxLayout` rows inside the status item | Filled by `_render()`; hidden unless `show-status-details` is on. |
| Preferences | `PopupMenu.PopupMenuItem` | `extension.openPreferences()` |

The status row intentionally does **not** use a menu item's `activate` signal:
`PopupMenuBase` connects item activation with `ConnectFlags.AFTER` and closes
the top menu, so expanding the details would dismiss the panel. The row owns a
`ClickAction` instead, which leaves the menu open.

**Data flow**

1. `enable()` builds the actors, connects every signal with
   `connectObject(signal, callback, owner)`, and starts one refresh.
2. `_refresh()` calls `GetStatus` on the system bus through a
   `Gio.DBusProxy`-free `Gio.DBus.system.call()` with a `Gio.Cancellable` and a
   generation counter, so a `disable()` in flight cannot touch dead actors.
3. `_render()` maps the JSON status onto the labels and the tile:
   - `available` is false, or `updated_at` older than 20 s: the readings show
     `-` and the subtitle reads "Unavailable".
   - Otherwise CPU/GPU temperatures, both fan speeds, the active mode, and the
     peak of each pair for the summary line.
4. The refresh timer only runs while the menu is open
   (`menu.connectObject('open-state-changed', …)`), at `refresh-interval`
   seconds, and is cancelled in `disable()`.
5. `_setMode()` sends `SetMode`, shows *Changing…*, and re-renders from the
   returned status; the UI never assumes that the firmware accepted a mode.

**Settings** (`org.gnome.shell.extensions.laptop-cooling`)

| Key | Type | Default | Used for |
| --- | --- | --- | --- |
| `show-temperature` | `b` | `false` | Tile subtitle: peak temperature instead of the preset name |
| `refresh-interval` | `i` | `5` | Seconds between `GetStatus` calls while the menu is open (5-30) |
| `show-status-details` | `b` | `false` | Whether the four readings start expanded |

**Lifecycle rules** (the part EGO reviewers look at first)

- Every `connectObject()` is owned by a widget that `disable()` destroys
  (status row, toggle/menu, indicator) or explicitly disconnected with
  `disconnectObject(owner)` when the emitter outlives the extension.
- `disable()` destroys the status row and its children, the readings section
  and the three menu items explicitly, then the menu, the toggle and the
  indicator, drops the `Gio.Cancellable`, and nulls every reference; there is
  no module-level state to forget.
- The status row's click action is only referenced by the row, kept in a local
  const instead of a field: destroying the row releases the action and its
  handler together.
- Because the extension instance is not a GObject, the *owner* passed to
  `connectObject()` is always one of those widgets, never `this`.

## The service (`service/cooling_service.py`, 241 lines)

**Identity gate.** `Hardware.__init__` refuses to construct unless
`/sys/class/dmi/id/product_name` is `81Y4` and `bios_version` is `EGCN41WW`.
Unknown hardware never reaches an ACPI call; the service exits with a clear
message instead of guessing.

**Firmware interface.** One namespace, `\_SB.GZFD.WMAA`, evaluated through
`/proc/acpi/call` (the `acpi_call` module). Read method ids `0x08` (fan 1),
`0x09` (fan 2), `0x2D` (requested mode), `0x2F` (on AC), `0x37` (actual mode);
write is `0x2C` with the preset id (`quiet 1`, `balanced 2`, `performance 3`).
No EC memory is written directly.

**Transaction lock.** All ACPI traffic is taken under an exclusive `flock` on
`/run/lock/ideapad-fan-getters.lock`, opened with `O_NOFOLLOW` after checking
that the path is a root-owned regular file without group/other write bits. The
same pattern the `ideapad-fan` scripts use, so the service can coexist with
other tools reading the same controller.

**D-Bus surface.** Two methods on `org.teo.LaptopCooling`:

| Method | Input | Output | Notes |
| --- | --- | --- | --- |
| `GetStatus` | none | `s` (JSON) | Always served from the 5 s snapshot cache; never blocks on ACPI |
| `SetMode` | `s` | `s` (JSON) | polkit `org.teo.laptopcooling.set-mode`, then the firmware write |

`SetMode` rejects: unknown modes (before doing anything), a second concurrent
change from the same sender, and, enforced again in `Hardware.set_mode`,
*performance* while the firmware reports the machine on battery.

**Privileged boundary.** The process runs as `root` under
`ProtectHome=true`, `ProtectSystem=strict`, `PrivateTmp=true`, with
`ReadWritePaths=/run/lock` as the only writable location. It speaks only to the
system bus, polkit and `/proc/acpi/call`; it opens no socket and reads no user
files.

**Polling.** A daemon thread refreshes the snapshot every 5 s
(`refresh_lock` serialises it with `SetMode`), so extension refreshes are
cheap no matter how many clients ask. Sensor reads for `cpu_c` come from
`hwmon/coretemp`, `gpu_c` from `nvidia-smi` when present.

## Files

| Path | Role |
| --- | --- |
| `extension/<uuid>/extension.js` | Shell 46 UI, D-Bus client |
| `extension/<uuid>/prefs.js` | Adw preferences page (three settings + links) |
| `extension/<uuid>/icons/fan-symbolic.svg` | The only icon the extension ships |
| `extension/<uuid>/schemas/*.gschema.xml` | GSettings schema |
| `service/cooling_service.py` | Root service (importable: `Hardware`, `Service`) |
| `service/*.service`, `*.conf`, `*.policy` | systemd unit, D-Bus policy, polkit action |
| `po/*` | gettext catalogues, compiled into the bundle |
| `scripts/` | build, install/uninstall, tests, artwork |
| `qa/` | isolated headless GNOME Shell harness (see `qa/README.md`) |
