# Contributing

Thanks for taking the time. This project is small and deliberately
conservative: it touches laptop firmware, so the bar for changes is
"reversible and verified" rather than "works on my machine".

## Ground rules

1. **No root code in the shell.** Everything privileged belongs in
   `service/cooling_service.py` behind the polkit action. A pull request that
   reads `/proc/acpi/call` from `extension.js` will be declined.
2. **No undocumented ACPI ids.** The write path is `0x2C` with the three
   verified presets. Adding a model means adding a *verified* profile (see
   [docs/hardware-support.md](docs/hardware-support.md)), never widening the
   check "just in case".
3. **No private shell APIs.** Only `ui/main.js`, `ui/quickSettings.js`,
   `ui/popupMenu.js` and `extensions/extension.js` are imported. If a feature
   needs something else, it almost certainly should not be done here.
4. **Every signal handler gets an owner.** Use
   `connectObject(signal, callback, owner)` where the owner is a widget that
   `disable()` destroys, and `disconnectObject(owner)` when the emitter
   outlives the extension. `qa/scenarios/verify-cleanup.json` exercises this;
   keep it green.
5. **Nothing outside the class.** Module scope holds constants and pure
   helpers; no objects are created at import time.

## Working on it

```bash
git clone https://github.com/joseteo/laptop-cooling.git
cd laptop-cooling

bash scripts/build-extension.sh          # dist/<uuid>.shell-extension.zip
bash scripts/run-tests.sh                # what CI runs

# optional, with the service installed
sudo bash scripts/install-service.sh
QA_SCENARIO=qa/scenarios/verify-cleanup.json bash qa/run.sh
```

Load a working copy without packaging:

```bash
ln -s "$PWD/extension/laptop-cooling@joseteo.github.io" \
      ~/.local/share/gnome-shell/extensions/laptop-cooling@joseteo.github.io
# then log out/in on Wayland (or Alt+F2, r, Enter on X11)
```

## Checks a pull request must pass

- `bash scripts/run-tests.sh`: service unit tests, D-Bus round trip against a
  simulated service, schema/JSON/catalogue checks, JavaScript syntax.
- UI changes: a scenario in `qa/scenarios/` or an updated one, with the
  `qa-session.log` evidence in the PR description (`PASS` lines, actor counts).
- Translation changes: `po/update-pot.sh` then `msgmerge --update` for every
  existing catalogue; never hand-edit `msgid`s.
- Documentation: update the README and/or `docs/` if behaviour changes. The
  README states what the extension does; keep it true.

## Style

- GJS: 4-space indent, single quotes, template literals, no `.format()`,
  `connectObject` over bare `connect`.
- Python: standard library only, no new dependencies in the service;
  `hardware` is injectable so it can be faked in tests.
- Shell: `set -euo pipefail`, quote everything, keep `shellcheck` quiet.
- Comments explain *why* (firmware quirks, GNOME Shell behaviour); the code
  says what.

## Commits and pull requests

- One topic per commit, imperative subject, body explains the reasoning.
- Mention the hardware and shell version you tested on.
- For hardware support, attach the probe transcript requested in
  [docs/hardware-support.md](docs/hardware-support.md).
- By contributing you agree to license your work under
  GPL-2.0-or-later, the licence of this project.

## Reporting problems

- Bugs and feature requests: <https://github.com/joseteo/laptop-cooling/issues>
- Sensitive reports (privileged code, polkit, D-Bus): see
  [SECURITY.md](SECURITY.md); please do not open a public issue.
