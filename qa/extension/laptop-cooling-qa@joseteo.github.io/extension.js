// SPDX-License-Identifier: GPL-2.0-or-later
//
// QA-only helper extension. It never ships to users and contains no product
// logic: it drives the *shipped* extension inside an isolated headless
// GNOME Shell session and writes screenshots to disk.
//
// Scenario file path and output directory come from the environment:
//   LAPTOP_COOLING_QA_SCENARIO=/path/scenario.json
// Steps are scheduled with millisecond precision, e.g.:
//   {"at": 5.0, "do": "open-panel"}
//   {"at": 6.0, "do": "open-menu"}
//   {"at": 7.0, "do": "shot", "name": "menu-open"}
//   {"at": 8.0, "do": "series", "name": "fan-curve", "count": 20, "interval": 1000}
//   {"at": 30.0, "do": "prefs"}
//   {"at": 34.0, "do": "shot", "name": "preferences"}
//   {"at": 36.0, "do": "set-mode", "mode": "performance"}
//   {"at": 38.0, "do": "shot", "name": "authorization"}
//   {"at": 40.0, "do": "done"}

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BUS_NAME = 'org.teo.LaptopCooling';
const OBJECT_PATH = 'org/teo/LaptopCooling';

// Module scope: GNOME Shell temporarily disables and re-enables every
// extension that was enabled after the one it is disabling ("rebasing"), so
// this harness must survive being bounced mid-scenario. The module itself is
// only re-imported when the extension is reloaded, so keeping the run state
// here lets the scenario continue without restarting.
let run = null;

export default class QaCapture extends Extension {
    enable() {
        if (run) {
            this._timers = run.timers;
            this._outdir = run.outdir;
            this._scenario = run.scenario;
            this._note('harness re-enabled by the extension manager (rebasing); scenario continues');
            return;
        }
        this._timers = [];
        this._scenario = this._readScenario();
        if (!this._scenario) {
            console.error('QA harness: no scenario file; set LAPTOP_COOLING_QA_SCENARIO');
            return;
        }
        this._outdir = this._scenario.outdir;
        if (!this._outdir) {
            console.error('QA harness: scenario has no outdir');
            return;
        }
        try {
            GLib.mkdir_with_parents(this._outdir, 0o755);
        } catch (error) {
            console.error(`QA harness: cannot create ${this._outdir}: ${error}`);
            return;
        }
        run = {timers: this._timers, outdir: this._outdir, scenario: this._scenario};
        // A headless session comes up with the overview showing (nothing ever
        // hides it: no key strokes, no window activations). A desktop session
        // does not, and the overview's search entry, window badges and dashes
        // would show up in every screenshot, so drop it before capturing.
        this._timers.push(this._later(3.0, () => this._hideOverview()));
        this._note(`QA session started, target=${this._scenario.target}`);
        this._note(`extension order: ${Main.extensionManager._extensionOrder.join(', ')}`);
        for (const step of this._scenario.steps ?? [])
            this._timers.push(this._later(step.at, () => this._run(step)));
    }

    _windowRect(title) {
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (win.get_title() === title) {
                const rect = win.get_frame_rect();
                return `${rect.x},${rect.y} ${rect.width}x${rect.height}`;
            }
        }
        return null;
    }

    _hideOverview() {
        if (!Main.overview.visible)
            return;
        Main.overview.hide();
        this._note('overview hidden (a desktop session would not show it)');
    }

    _readScenario() {
        const path = GLib.getenv('LAPTOP_COOLING_QA_SCENARIO');
        if (!path)
            return null;
        try {
            const [, contents] = GLib.file_get_contents(path);
            return JSON.parse(new TextDecoder().decode(contents));
        } catch (error) {
            console.error(`QA harness: ${error}`);
            return null;
        }
    }

    _later(seconds, callback) {
        return GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(seconds * 1000), () => {
            if (!this._stopped) {
                try {
                    callback();
                } catch (error) {
                    this._note(`step failed: ${error}`);
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _target() {
        return Main.extensionManager.lookup(this._scenario.target)?.stateObj ?? null;
    }

    _note(text) {
        if (!this._outdir)
            return;
        try {
            const file = Gio.File.new_for_path(`${this._outdir}/qa-session.log`);
            const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
            const stamp = GLib.DateTime.new_now_local().format('%H:%M:%S');
            stream.write_all(new TextEncoder().encode(`${stamp} ${text}\n`), null);
            stream.close(null);
        } catch (_error) {
        }
    }

    _run(step) {
        switch (step.do) {
        case 'open-panel':
            Main.panel.statusArea.quickSettings.menu.open();
            this._note('opened Quick Settings');
            break;
        case 'close-panel':
            Main.panel.statusArea.quickSettings.menu.close();
            break;
        case 'open-menu': {
            const target = this._target();
            if (!target) {
                this._note(`target ${this._scenario.target} is not loaded`);
                break;
            }
            Main.panel.statusArea.quickSettings.menu.open();
            target._toggle?.menu.open();
            this._note('opened the Cooling tile menu');
            break;
        }
        case 'shot':
            this._shoot(step.name);
            break;
        case 'series':
            this._series(step);
            break;
        case 'prefs': {
            const target = step.uuid ?? this._scenario.target;
            if (!this._target()) {
                this._note('cannot open preferences: target not loaded');
                break;
            }
            // Same DBus call the shell makes when the user picks
            // "Preferences": the dialog is created by the Extensions service
            // in-process, and errors are reported here instead of vanishing.
            Gio.DBus.session.call('org.gnome.Shell.Extensions',
                '/org/gnome/Shell/Extensions', 'org.gnome.Shell.Extensions',
                'OpenExtensionPrefs', new GLib.Variant('(ssa{sv})', [target, '', {}]),
                null, Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                    try {
                        connection.call_finish(result);
                        this._note('preferences dialog requested');
                    } catch (error) {
                        this._note(`preferences dialog failed: ${error.message}`);
                    }
                });
            break;
        }
        case 'prefs-window': {
            // Runs the extension's own prefs.js as a Wayland client of the QA
            // session (see qa/runner/prefs-window.js): the shell's built-in
            // prefs dialog cannot map a window in a headless session.
            const runner = step.script ?? GLib.getenv('LAPTOP_COOLING_QA_RUNNER');
            const dataDir = GLib.getenv('XDG_DATA_HOME');
            if (!runner || !dataDir) {
                this._note('cannot open prefs window: runner or XDG_DATA_HOME missing');
                break;
            }
            const logName = `${runner.split('/').pop().replace(/\.js$/, '')}-runner.log`;
            const extensionDir = `${dataDir}/gnome-shell/extensions/${this._scenario.target}`;
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_SILENCE |
                       Gio.SubprocessFlags.STDERR_SILENCE,
            });
            launcher.setenv('LAPTOP_COOLING_PREFS_DIR', extensionDir, true);
            launcher.setenv('GSETTINGS_SCHEMA_DIR', `${extensionDir}/schemas`, true);
            launcher.setenv('LAPTOP_COOLING_QA_OUT', this._outdir, true);
            // The shell keeps Shew and the other private typelibs outside the
            // default search path; the Extensions app resources need Shew.
            const shellLibDir = '/usr/lib/gnome-shell';
            const typelibDir = `${shellLibDir}/girepository-1.0`;
            for (const name of ['GI_TYPELIB_PATH', 'LD_LIBRARY_PATH']) {
                const dir = name === 'GI_TYPELIB_PATH' ? typelibDir : shellLibDir;
                const current = GLib.getenv(name);
                launcher.setenv(name, current ? `${current}:${dir}` : dir, true);
            }
            for (const [name, value] of Object.entries(step.env ?? {}))
                launcher.setenv(name, value, true);
            try {
                // The runner's output goes to the capture directory so a
                // failing session can be diagnosed from the artifacts alone.
                launcher.setenv('LAPTOP_COOLING_QA_RUNNER', runner, true);
                const target = `$LAPTOP_COOLING_QA_OUT/${logName}`;
                this._prefsProcess = launcher.spawnv(['sh', '-c',
                    `echo "launching $LAPTOP_COOLING_QA_RUNNER" >> "${target}"; ` +
                    `gjs -m "$LAPTOP_COOLING_QA_RUNNER" >> "${target}" 2>&1; ` +
                    `echo "gjs exit=$?" >> "${target}"`]);
                this._note(`preferences window process started (${extensionDir})`);
                // Record where the window lands: the asset pipeline crops the
                // screenshot with this rectangle.
                this._timers.push(this._later(2.5, () => {
                    const rect = this._windowRect(step.title ?? 'Laptop Cooling');
                    this._note(rect ? `prefs window rect ${rect}`
                                    : 'prefs window rect: window not found');
                }));
            } catch (error) {
                this._note(`cannot start preferences window: ${error.message}`);
            }
            break;
        }
        case 'close-prefs-window':
            this._prefsProcess?.force_exit();
            this._prefsProcess = null;
            break;
        case 'hide-overview': {
            this._hideOverview();
            break;
        }
        case 'overview-state': {
            const overview = Main.overview;
            this._note(`overview: visible=${overview.visible} search-entry=${overview.searchEntry?.visible}` +
                ` mapped=${overview.searchEntry?.mapped} mode=${Main.sessionMode.currentMode}` +
                ` actionMode=${Main.actionMode ?? '-'}`);
            const tops = [];
            for (const child of Main.uiGroup.get_children()) {
                if (child.mapped && child.width > 0)
                    tops.push(`${child.constructor?.name}${child.name ? `#${child.name}` : ''}` +
                        `(${Math.round(child.x)},${Math.round(child.y)}` +
                        ` ${Math.round(child.width)}x${Math.round(child.height)})`);
            }
            this._note(`mapped top actors: ${tops.join(' ')}`);
            break;
        }
        case 'dump-apps': {
            const tracker = Shell.WindowTracker.get_default();
            for (const actor of global.get_window_actors()) {
                const win = actor.meta_window;
                const app = tracker.get_window_app(win);
                this._note(`window wmclass="${win.get_wm_class()}"` +
                    ` app-id=${win.get_gtk_application_id?.() ?? '-'}` +
                    ` app=${app ? app.get_id() : 'none'}` +
                    ` title="${win.get_title()}"`);
            }
            const running = Shell.AppSystem.get_default().get_running();
            this._note(`running apps: ${running.map(a => `${a.get_id()}:${a.state}`).join(' ') || 'none'}`);
            break;
        }
        case 'extensions-state': {
            const manager = Main.extensionManager;
            const lines = [];
            for (const uuid of step.uuids ?? [])
                lines.push(`${uuid}=${manager.lookup(uuid)?.state ?? 'missing'}`);
            this._note(`extensions: ${lines.join(' ')}`);
            break;
        }
        case 'disable-extension': {
            Main.extensionManager.disableExtension(step.uuid);
            this._note(`disabling ${step.uuid}`);
            break;
        }
        case 'enable-extension': {
            Main.extensionManager.enableExtension(step.uuid);
            this._note(`enabling ${step.uuid}`);
            break;
        }
        case 'warp-pointer': {
            const x = step.x ?? 0;
            const y = step.y ?? 0;
            try {
                const seat = Clutter.get_default_backend().get_default_seat();
                seat.warp_pointer(x, y);
                this._note(`pointer warped to ${x},${y}`);
            } catch (error) {
                this._note(`pointer warp failed: ${error.message}`);
            }
            break;
        }
        case 'dump-actors': {
            const rect = step.rect ?? [0, 0, global.stage.width, global.stage.height];
            const [rx, ry, rw, rh] = rect;
            const hits = actor => {
                const box = actor.get_transformed_extents?.();
                if (!box)
                    return false;
                return box.origin.x < rx + rw && box.origin.x + box.size.width > rx &&
                    box.origin.y < ry + rh && box.origin.y + box.size.height > ry;
            };
            let lines = 0;
            const walk = (actor, depth) => {
                if (lines > 200 || depth > 8 || !actor.visible)
                    return;
                if (hits(actor)) {
                    const cls = actor.constructor?.name ?? 'actor';
                    const box = actor.get_transformed_extents();
                    let extra = '';
                    if (actor instanceof St.Icon)
                        extra = ` icon=${actor.icon_name ?? actor.gicon ?? ''}`;
                    else if (actor instanceof St.Label)
                        extra = ` text="${actor.text}"`;
                    this._note(`  ${'  '.repeat(depth)}${cls}${actor.name ? `#${actor.name}` : ''}` +
                        ` @${Math.round(box.origin.x)},${Math.round(box.origin.y)}` +
                        ` ${Math.round(box.size.width)}x${Math.round(box.size.height)}${extra}`);
                    lines++;
                }
                let children = [];
                try {
                    children = actor.get_children?.() ?? [];
                } catch {
                    children = [];
                }
                for (const child of children)
                    walk(child, depth + 1);
            };
            for (const child of Main.uiGroup.get_children())
                walk(child, 0);
            break;
        }
        case 'env-probe': {
            const keys = ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
                'XDG_SESSION_TYPE', 'GSK_RENDERER', 'GDK_BACKEND', 'LIBGL_ALWAYS_SOFTWARE'];
            const values = keys.map(key => `${key}=${GLib.getenv(key) ?? 'unset'}`);
            const runtime = GLib.getenv('XDG_RUNTIME_DIR') ?? '';
            const names = [];
            try {
                const dir = Gio.File.new_for_path(runtime);
                const iter = dir.enumerate_children('standard::name',
                    Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = iter.next_file(null)) !== null)
                    names.push(info.get_name());
            } catch (error) {
                names.push(`<${error.message}>`);
            }
            this._note(`env: ${values.join(' ')} runtime=[${names.join(', ')}]`);
            break;
        }
        case 'list-windows': {
            const windows = global.get_window_actors()
                .map(actor => actor.meta_window)
                .filter(window => window && !window.is_skip_taskbar())
                .map(window => `${window.get_wm_class() ?? '?'}:${window.get_title() ?? '?'}`);
            this._note(`windows: ${windows.join(', ') || 'none'}`);
            break;
        }
        case 'setting': {
            const settings = this._target()?.getSettings?.();
            if (settings) {
                settings.set_value(step.key, new GLib.Variant('b', step.value));
                this._note(`setting ${step.key}=${step.value}`);
            } else {
                this._note(`cannot set ${step.key}: target not loaded`);
            }
            break;
        }
        case 'set-mode':
            // Deliberately the raw system-bus call: this exercises the real
            // service and the real polkit dialog, exactly like a user click.
            Gio.DBus.system.call(BUS_NAME, `/${OBJECT_PATH}`, BUS_NAME, 'SetMode',
                new GLib.Variant('(s)', [step.mode]), null, Gio.DBusCallFlags.NONE,
                120000, null, (connection, result) => {
                    try {
                        connection.call_finish(result);
                        this._note(`SetMode ${step.mode} completed`);
                    } catch (error) {
                        this._note(`SetMode ${step.mode} ended: ${error.message}`);
                    }
                });
            this._note(`requested SetMode ${step.mode}`);
            break;
        case 'note':
            this._note(step.text);
            break;
        case 'toggle-details': {
            // Emits the row's click action exactly like a pointer click does
            // (the shipped row is not a standard activatable menu item, so
            // clicking it must not close the menu), then checks that the
            // setting really flipped. The action is found through Clutter's
            // public API: the shipped extension keeps no field for it, and
            // the row's own (disabled) menu-item action is skipped.
            const stateObj = this._target();
            const row = stateObj?._statusRow;
            const action = row?.get_actions?.().find(
                a => a instanceof Clutter.ClickAction && a.enabled);
            if (!row || !action) {
                this._note('cannot toggle Status details: target not loaded');
                break;
            }
            const settings = stateObj.getSettings();
            const before = settings.get_boolean('show-status-details');
            action.emit('clicked', row);
            const after = settings.get_boolean('show-status-details');
            this._note(`clicked Status row: show-status-details ${before} -> ${after} ` +
                `${before !== after ? 'PASS' : 'FAIL'}`);
            break;
        }
        case 'count-actors':
            this._note(`actor count (Quick Settings menu): ${this._qsActorCount()}`);
            break;
        case 'probe':
            this._probe();
            break;
        case 'cycle-check':
            this._cycleCheck();
            break;
        case 'done':
            this._note('QA scenario finished');
            GLib.file_set_contents(`${this._outdir}/done`, 'done\n');
            this._stopped = true;
            run = null;
            break;
        default:
            this._note(`unknown action ${step.do}`);
        }
    }

    _series(step) {
        for (let i = 0; i < step.count; i++) {
            this._timers.push(this._later((i * step.interval) / 1000,
                () => this._shoot(`${step.name}-${String(i).padStart(3, '0')}`)));
        }
    }

    // ---- cleanup verification -------------------------------------------
    //
    // The shipped extension must leave no widgets or handlers behind when it
    // is disabled (EGO review guideline "Destroy all objects"). These helpers
    // count actors in the Quick Settings menu and run the shipped extension
    // through a disable/enable cycle inside the live session.

    _countActors(actor) {
        let count = 1;
        for (const child of actor.get_children())
            count += this._countActors(child);
        return count;
    }

    _qsActorCount() {
        // The tile and the indicator live in different trees: the tile in the
        // Quick Settings menu, the indicator in the panel button.
        return this._countActors(Main.panel.statusArea.quickSettings.menu.box) +
            this._countActors(Main.panel.statusArea.quickSettings);
    }

    _isInQuickSettings(actor) {
        const root = Main.panel.statusArea.quickSettings.menu.box;
        for (let node = actor; node; node = node.get_parent()) {
            if (node === root)
                return true;
        }
        return false;
    }

    _cycleCheck() {
        const target = this._scenario.target;
        const counts = {};
        const destroyed = {toggle: false, menu: false, indicator: false};
        const disable = () => {
            const stateObj = this._target();
            const toggle = stateObj?._toggle ?? null;
            destroyed.toggle = false;
            destroyed.menu = false;
            destroyed.indicator = false;
            toggle?.connect('destroy', () => (destroyed.toggle = true));
            toggle?.menu?.actor?.connect('destroy', () => (destroyed.menu = true));
            stateObj?._indicator?.connect('destroy', () => (destroyed.indicator = true));
            Main.extensionManager.disableExtension(target);
        };
        const snap = label => {
            const toggle = this._target()?._toggle ?? null;
            this._note(`cycle-check ${label}: ${this._qsActorCount()} actors, ` +
                `tile present: ${Boolean(toggle && this._isInQuickSettings(toggle))}, ` +
                `tile/menu/indicator destroyed: ` +
                `${destroyed.toggle}/${destroyed.menu}/${destroyed.indicator}`);
        };
        // A/B/A/B: only equal shell states are compared, so unrelated actors
        // (banners, other menus) cannot skew the leak verdict.
        const plan = [
            [0.0, () => disable()],
            [2.0, () => {
                counts.d1 = this._qsActorCount();
                snap('D1 (disabled)');
            }],
            [3.0, () => Main.extensionManager.enableExtension(target)],
            [5.0, () => {
                counts.e1 = this._qsActorCount();
                snap('E1 (enabled)');
            }],
            [6.0, () => disable()],
            [8.0, () => {
                counts.d2 = this._qsActorCount();
                snap('D2 (disabled)');
            }],
            [9.0, () => Main.extensionManager.enableExtension(target)],
            [11.0, () => {
                counts.e2 = this._qsActorCount();
                snap('E2 (enabled)');
                const disabled = counts.d1 === counts.d2 ?
                    'PASS' : `FAIL (${counts.d2 - counts.d1} actors leak)`;
                const enabled = counts.e1 === counts.e2 ?
                    'PASS' : `FAIL (${counts.e2 - counts.e1})`;
                this._note(`cycle-check verdict: cleanup after disable ${disabled}, ` +
                    `restore after enable ${enabled}`);
            }],
        ];
        for (const [delay, callback] of plan)
            this._timers.push(this._later(delay, callback));
    }

    _probe() {
        const results = [];
        // 1. connectObject(): a handler dies with the owner passed as its
        //    third argument, the pattern the shipped extension relies on.
        {
            const owner = new St.Widget();
            const emitter = new St.Widget();
            let fired = 0;
            emitter.connectObject('notify::reactive', () => fired++, owner);
            emitter.reactive = true;
            owner.destroy();
            emitter.reactive = false;
            results.push(`owner-destroy disconnects (expect 1): ${fired} ` +
                `${fired === 1 ? 'PASS' : 'FAIL'}`);
            emitter.destroy();
        }
        // 2. disconnectObject(owner) removes just that owner's handlers.
        {
            const owner = new St.Widget();
            const emitter = new St.Widget();
            let fired = 0;
            emitter.connectObject('notify::reactive', () => fired++, owner);
            emitter.reactive = true;
            emitter.disconnectObject(owner);
            emitter.reactive = false;
            results.push(`disconnectObject(owner) disconnects (expect 1): ${fired} ` +
                `${fired === 1 ? 'PASS' : 'FAIL'}`);
            owner.destroy();
            emitter.destroy();
        }
        // 3. Control: a plain connect() keeps firing until disconnected.
        {
            const emitter = new St.Widget();
            let fired = 0;
            emitter.connect('notify::reactive', () => fired++);
            emitter.reactive = true;
            emitter.reactive = false;
            results.push(`plain connect() keeps firing (expect 2): ${fired} ` +
                `${fired === 2 ? 'PASS' : 'FAIL'}`);
            emitter.destroy();
        }
        this._note(`probe: ${results.join(' | ')}`);
    }

    _shoot(name) {
        const path = `${this._outdir}/${name}.png`;
        let stream;
        try {
            stream = Gio.File.new_for_path(path)
                .replace(null, false, Gio.FileCreateFlags.NONE, null);
        } catch (error) {
            this._note(`cannot write ${path}: ${error}`);
            return;
        }
        const shooter = new Shell.Screenshot();
        shooter.screenshot(false, stream, (object, result) => {
            try {
                object.screenshot_finish(result);
                this._note(`captured ${name}.png`);
            } catch (error) {
                this._note(`screenshot ${name} failed: ${error}`);
            } finally {
                stream.close(null);
            }
        });
    }

    disable() {
        // Timers are deliberately kept: the shell may bounce this harness
        // while it disables/re-enables extensions around the one under test.
        this._note('harness disabled (scenario continues)');
    }
}
