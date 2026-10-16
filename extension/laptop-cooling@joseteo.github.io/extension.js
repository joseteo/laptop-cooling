// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Teo Lorente
//
// Laptop Cooling: a Quick Settings tile for the laptop's native cooling
// presets and live thermal sensors.
//
// The tile only renders information and forwards user actions to the
// root-owned org.teo.LaptopCooling system service. No privileged operation
// is implemented in the Shell process, and no firmware call can be injected
// from the desktop session.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

const BUS_NAME = 'org.teo.LaptopCooling';
const OBJECT_PATH = '/org/teo/LaptopCooling';
const SETUP_URL = 'https://github.com/joseteo/laptop-cooling#installation';

// Internal preset identifiers in the firmware's native order (1 = Quiet,
// 2 = Balanced, 3 = Performance). Only these values are ever sent to the
// service, which validates them again before touching the firmware.
const MODES = ['quiet', 'balanced', 'performance'];

function modeName(mode) {
    if (mode === 1)
        return _('Quiet');
    if (mode === 2)
        return _('Balanced');
    if (mode === 3)
        return _('Performance');
    return _('Unavailable');
}

// The service reports errors as free text; keep the menu readable.
function shorten(text, limit = 64) {
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export default class LaptopCooling extends Extension {
    enable() {
        this._generation = (this._generation ?? 0) + 1;
        this._settings = this.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._changing = false;
        this._refreshing = false;
        this._loggedError = null;
        this._status = null;
        this._fanIcon = Gio.FileIcon.new(this.dir.get_child('icons').get_child('fan-symbolic.svg'));
        this._indicator = new QuickSettings.SystemIndicator();
        this._toggle = new QuickSettings.QuickMenuToggle({
            title: _('Cooling'), subtitle: _('Connecting…'), gicon: this._fanIcon,
            toggleMode: false,
        });
        // Every signal handler is connected with connectObject() and owned by
        // a widget that disable() destroys, so cleanup stays in one place:
        // settings/session-mode handlers belong to the indicator, menu
        // handlers to the menu item itself.
        // Opening the tile never changes the firmware mode implicitly.
        this._toggle.connectObject('clicked', () => this._toggle.menu.open(), this._toggle);
        this._toggle.menu.setHeader(this._fanIcon, _('Laptop Cooling'));
        this._modeItems = MODES.map((mode, index) => {
            const item = new PopupMenu.PopupMenuItem(modeName(index + 1));
            item.connectObject('activate', () => this._setMode(index, mode), item);
            this._toggle.menu.addMenuItem(item);
            return item;
        });
        this._toggle.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        // Peak summary row. The individual readings stay collapsed until the
        // user expands this row, so the menu stays short by default. The row
        // uses its own click action instead of a menu item's activation:
        // activating an item closes the whole menu, and expanding the details
        // must not take the panel away.
        this._statusRow = new PopupMenu.PopupBaseMenuItem({activate: false});
        this._statusRow.add_child(new St.Label({text: _('Status'), x_expand: true}));
        this._summary = new St.Label({text: '-'});
        this._statusRow.add_child(this._summary);
        this._statusArrow = new St.Icon({icon_name: 'pan-down-symbolic',
            style_class: 'popup-menu-arrow'});
        this._statusRow.add_child(this._statusArrow);
        this._statusToggle = new Clutter.ClickAction();
        this._statusToggle.connectObject('clicked', () => this._toggleDetails(), this._statusRow);
        this._statusRow.add_action(this._statusToggle);
        // Keyboard activation (Space/Return) arrives as 'activate'; the menu
        // closes afterwards, exactly like any other item.
        this._statusRow.connectObject('activate', () => this._toggleDetails(), this._statusRow);
        this._toggle.menu.addMenuItem(this._statusRow);
        this._readings = new PopupMenu.PopupMenuSection();
        this._toggle.menu.addMenuItem(this._readings);
        this._cpu = this._addReading(_('CPU'));
        this._gpu = this._addReading(_('GPU'));
        this._fan1 = this._addReading(_('Fan 1'));
        this._fan2 = this._addReading(_('Fan 2'));
        this._toggle.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._message = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._toggle.menu.addMenuItem(this._message);
        // Shown only while the service is unreachable, so reviewers and
        // users always find the installation instructions.
        this._setup = new PopupMenu.PopupImageMenuItem(_('Setup Instructions'), 'go-next-symbolic');
        this._setup.connectObject('activate', () => {
            Main.panel.statusArea.quickSettings.menu.close();
            Gio.AppInfo.launch_default_for_uri(SETUP_URL, null);
        }, this._setup);
        this._setup.visible = false;
        this._toggle.menu.addMenuItem(this._setup);
        this._prefs = new PopupMenu.PopupImageMenuItem(_('Preferences'), 'preferences-system-symbolic');
        this._prefs.connectObject('activate', () => {
            Main.panel.statusArea.quickSettings.menu.close();
            this.openPreferences();
        }, this._prefs);
        this._prefs.visible = Main.sessionMode.allowSettings;
        this._toggle.menu.addMenuItem(this._prefs);
        this._indicator.quickSettingsItems.push(this._toggle);
        // No indicator icon is added: Cooling lives solely in Quick Settings.
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._toggle.menu.connectObject('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        }, this._toggle.menu);
        this._settings.connectObject('changed', () => {
            this._render();
            this._startTimer();
        }, this._indicator);
        // Keep the settings entries hidden on the lock screen.
        Main.sessionMode.connectObject('updated', () => this._render(), this._indicator);
        this._startTimer();
        this._render();
        this._refresh();
    }

    _addReading(name) {
        const row = new St.BoxLayout({style_class: 'popup-menu-item',
            reactive: true, can_focus: false, track_hover: false});
        row.add_child(new St.Label({text: name, x_expand: true}));
        const value = new St.Label({text: '-', x_align: Clutter.ActorAlign.END});
        row.add_child(value);
        this._readings.actor.add_child(row);
        return value;
    }

    _startTimer() {
        if (this._timer)
            GLib.Source.remove(this._timer);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('refresh-interval'), () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _toggleDetails() {
        this._settings.set_boolean('show-status-details',
            !this._settings.get_boolean('show-status-details'));
    }

    async _call(method, mode = null) {
        const cancellable = this._cancellable;
        return new Promise((resolve, reject) => {
            Gio.DBus.system.call(BUS_NAME, OBJECT_PATH, BUS_NAME, method,
                mode === null ? null : new GLib.Variant('(s)', [mode]),
                new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE,
                method === 'SetMode' ? 125000 : 5000, cancellable, (connection, result) => {
                    try {
                        const [json] = connection.call_finish(result).deep_unpack();
                        resolve(JSON.parse(json));
                    } catch (error) {
                        reject(error);
                    }
                });
        });
    }

    async _refresh() {
        if (!this._toggle || this._refreshing)
            return;
        this._refreshing = true;
        const generation = this._generation;
        try {
            const status = await this._call('GetStatus');
            if (!this._toggle || generation !== this._generation)
                return;
            this._status = status;
            if (status.available) {
                this._loggedError = null;
            } else if (status.error && status.error !== this._loggedError) {
                // Log each distinct failure once; never on every refresh.
                this._loggedError = status.error;
                console.info(`Laptop Cooling: service reports "${status.error}"`);
            }
            this._render();
        } catch (error) {
            if (!this._toggle || generation !== this._generation)
                return;
            this._status = null;
            if (!this._loggedError) {
                this._loggedError = error.message;
                console.info(`Laptop Cooling: cooling service unavailable (${error.message})`);
            }
            this._render();
        } finally {
            if (generation === this._generation)
                this._refreshing = false;
        }
    }

    _render() {
        if (!this._toggle)
            return;
        const status = this._status;
        const available = status?.available &&
            Number.isFinite(status.updated_at) && Date.now() / 1000 - status.updated_at < 20;
        const temperature = value => Number.isFinite(value) ? `${Math.round(value)} °C` : '-';
        const rpm = value => Number.isFinite(value) ? `${Math.round(value).toLocaleString()} RPM` : '-';
        const peakOf = values => {
            const known = values.filter(Number.isFinite);
            return known.length ? Math.max(...known) : null;
        };
        this._cpu.text = temperature(available ? status.cpu_c : null);
        this._gpu.text = temperature(available ? status.gpu_c : null);
        this._fan1.text = rpm(available ? status.fan1_rpm : null);
        this._fan2.text = rpm(available ? status.fan2_rpm : null);
        // One-line peak view of the same readings.
        const peakTemperature = available ? peakOf([status.cpu_c, status.gpu_c]) : null;
        const peakFan = available ? peakOf([status.fan1_rpm, status.fan2_rpm]) : null;
        const peaks = [];
        if (peakTemperature !== null)
            peaks.push(temperature(peakTemperature));
        if (peakFan !== null)
            peaks.push(rpm(peakFan));
        this._summary.text = peaks.length ? peaks.join(' · ') : '-';
        this._statusRow.accessible_name = `${_('Status')}: ${this._summary.text}`;
        const details = this._settings.get_boolean('show-status-details');
        this._readings.actor.visible = details;
        this._statusArrow.icon_name = details ? 'pan-up-symbolic' : 'pan-down-symbolic';
        const mode = available ? status.actual_mode : 0;
        const name = modeName(mode);
        this._toggle.checked = Boolean(available && mode !== 2);
        this._modeItems.forEach((item, index) => {
            item.setOrnament(mode === index + 1 ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.sensitive = Boolean(available && !this._changing && (index !== 2 || status.on_ac));
        });
        const message = this._changing ? _('Changing cooling mode…') :
            !available ? shorten(this._status?.error ?? _('Cooling service unavailable')) :
                !status.on_ac ? _('Connect the charger for Performance mode') : '';
        this._message.label.text = message;
        this._message.visible = Boolean(message);
        this._setup.visible = !available && Main.sessionMode.allowSettings;
        this._prefs.visible = Main.sessionMode.allowSettings;
        const tileTemperature = this._settings.get_boolean('show-temperature') &&
            peakTemperature !== null ? temperature(peakTemperature) : null;
        // The tile is one grid column wide: the preset name and a temperature
        // never fit on the same line, so the setting replaces the name with the
        // reading (the preset is still the menu header and the checked row).
        this._toggle.subtitle = this._changing ? _('Changing…') : tileTemperature ?? name;
        this._toggle.menu.setHeader(this._fanIcon, _('Laptop Cooling'), name);
        // Screen-reader summary. Kept as translated fragments so that no
        // String prototype helper is required.
        this._toggle.accessible_name = available ?
            `${_('Laptop Cooling')}, ${name}, ${_('CPU')} ${this._cpu.text}, ${_('GPU')} ${this._gpu.text}` :
            _('Laptop Cooling, service unavailable');
    }

    async _setMode(index, mode) {
        if (this._changing || !this._status?.available)
            return;
        this._changing = true;
        const generation = this._generation;
        this._render();
        try {
            const status = await this._call('SetMode', mode);
            if (this._toggle && generation === this._generation)
                this._status = status;
        } catch (error) {
            if (this._toggle && generation === this._generation) {
                const cancelled = error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
                if (!cancelled) {
                    const denied = error.message.includes('NotAuthorized');
                    Main.notify(_('Laptop Cooling'), denied ? _('Cooling mode was not changed.') :
                        _('Unable to change cooling mode. Check that the charger is connected and try again.'));
                }
            }
        } finally {
            if (generation === this._generation) {
                this._changing = false;
                this._render();
                this._refresh();
            }
        }
    }

    disable() {
        this._generation++;
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = null;
        }
        // Disconnect every handler that was connected with connectObject().
        // Emitters that outlive the extension are disconnected explicitly;
        // the rest die with the widget that owns them below.
        this._settings?.disconnectObject(this._indicator);
        Main.sessionMode.disconnectObject(this._indicator);
        this._settings = null;
        // The tile's menu is not a child of the tile, so it has to be
        // destroyed on its own; it destroys its items (readings included).
        this._toggle?.menu.destroy();
        this._toggle?.destroy();
        this._toggle = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._statusRow = null;
        this._statusToggle = null;
        this._summary = null;
        this._statusArrow = null;
        this._status = null;
        this._loggedError = null;
    }
}
