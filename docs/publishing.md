# Publishing to extensions.gnome.org

Everything in this file is maintainer-facing. The user-facing install steps are
in [the README](../README.md#installation).

## Before uploading

```bash
bash scripts/run-tests.sh                      # schemas, catalogues, service tests, JS syntax
bash scripts/build-extension.sh                # → dist/laptop-cooling@joseteo.github.io.shell-extension.zip
QA_SCENARIO=qa/scenarios/verify-cleanup.json bash qa/run.sh
python3 scripts/make-assets.py                 # refresh docs/assets from the current captures
```

Then confirm, by hand, on the artifact that will be uploaded:

- [ ] `unzip -l dist/laptop-cooling@joseteo.github.io.shell-extension.zip` lists
      `metadata.json`, `extension.js`, `prefs.js`, `schemas/`, `locale/*.mo`,
      `icons/fan-symbolic.svg`, `README.md`, `LICENSE`, and nothing else.
- [ ] `metadata.json` has no `version` key (extensions.gnome.org assigns the
      version number itself).
- [ ] `shell-version` is exactly the version the code was tested against.
      Do not add a version that was never started once.
- [ ] The `description` in `metadata.json` matches what the extension actually
      does *today*, including the hardware limitation sentence.
- [ ] A fresh install, on a machine with and without the service:

      ```bash
      gnome-extensions install --force dist/laptop-cooling@joseteo.github.io.shell-extension.zip
      # log out/in on Wayland, then:
      gnome-extensions enable laptop-cooling@joseteo.github.io
      journalctl -f -o cat /usr/bin/gnome-shell     # no JS ERROR, no Gjs-CRITICAL
      gnome-extensions disable laptop-cooling@joseteo.github.io
      journalctl -f -o cat /usr/bin/gnome-shell     # still nothing
      ```

- [ ] Two screenshots ready: the Quick Settings menu with the tile open, and
      the preferences page. `docs/assets/` holds both, freshly generated.

## Upload

1. <https://extensions.gnome.org/upload/> → choose the zip.
2. Fill in the **description** if the site shows it (it prefers the metadata
   one) and the **screenshot** URLs.
3. The listing lives at
   <https://extensions.gnome.org/extension/11287/laptop-cooling/>; the README
   badge and installation section already point at it.
4. extensions.gnome.org runs its static analyzer (Shexli) on every upload and
   shows the findings on the review page. Re-uploading a corrected zip
   supersedes a pending one: older unreviewed versions of the extension with
   the same shell-version set are auto-rejected, so there is nothing to delete
   by hand.
5. Respond to reviewers on the extension's *Review* page. Reviews are volunteer
   work; a short, factual reply with a link to the commit that addresses a
   comment is what reviewers ask for.

## What reviewers check (and where this repository answers it)

| Reviewer concern | Where it is handled |
| --- | --- |
| Signal handlers connected with `connectObject()` / a named owner, disconnected deterministically | `extension.js`: every connection has a widget owner; `disable()` destroys the owners. `qa/scenarios/verify-cleanup.json` asserts it in a live shell. |
| No module-scope instantiation, no state outside the class | `extension.js` exports a single `Extension` subclass; module scope holds constants and pure helpers only. |
| No private/undocumented shell APIs | Only `ui/main.js`, `ui/quickSettings.js`, `ui/popupMenu.js` and `extensions/extension.js` are imported. |
| Cleanup on `disable()` | The status row, its children, the readings section and the menu items are destroyed explicitly, then the menu, tile and indicator; every field is cleared. A second `enable()`/`disable()` cycle leaks nothing (actor counts are compared by the QA harness). |
| Analyzer destroy/release rules (EGO-L-002, EGO-L-005) | Every object created in `enable()` has a matching `.destroy()` in `disable()` and every reference is set to `null`; the status row's click action is owned by the row and needs no field. |
| Reasonable metadata | `uuid`, `name`, `description`, `shell-version`, `url`, `settings-schema`, `gettext-domain`, `version-name`, and no fake compatibility. |
| Translations included correctly | `--podir=po --gettext-domain=laptop-cooling` during packaging; `unzip -l` shows `locale/<lang>/LC_MESSAGES/laptop-cooling.mo`. |
| No root code inside the shell | The extension only calls two D-Bus methods; the privileged half is a separate systemd service with a polkit action. |

## Versioning

- `version-name` in `metadata.json` is the human version (`1.0.0`).
- The numeric `version` is assigned by extensions.gnome.org on upload; never
  add it by hand.
- Keep `CHANGELOG.md` in sync; reviewers and users both read it.

## Supporting a new shell version

1. Run the extension on a session of that shell version.
2. Check `journalctl -o cat /usr/bin/gnome-shell` for warnings/errors while
   opening the menu, expanding the status row, changing a mode and opening
   preferences.
3. Extend `shell-version` only with versions that were actually started.
   GNOME Shell 46 → 47/48 will likely need UI adjustments
   (`QuickSettings` menu API, `PopupMenu` details); treat it as a change, not
   a metadata edit.
