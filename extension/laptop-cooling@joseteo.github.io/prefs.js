// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Teo Lorente

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const HOMEPAGE = 'https://github.com/joseteo/laptop-cooling';

export default class CoolingPreferences extends ExtensionPreferences {
    _link(title, subtitle, uri) {
        const row = new Adw.ActionRow({title, subtitle, activatable: true});
        row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        row.connect('activated', () => Gio.AppInfo.launch_default_for_uri(uri, null));
        return row;
    }

    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage({
            title: _('Laptop Cooling'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const display = new Adw.PreferencesGroup({
            title: _('Panel Tile'),
            description: _('The Cooling tile lives in the system menu, next to Wi-Fi and Bluetooth.'),
        });
        page.add(display);
        const show = new Adw.SwitchRow({
            title: _('Show Temperature in Tile'),
            subtitle: _('Show the peak temperature in the tile instead of the active preset'),
        });
        display.add(show);
        settings.bind('show-temperature', show, 'active', Gio.SettingsBindFlags.DEFAULT);
        const interval = new Adw.ActionRow({
            title: _('Update Interval'),
            subtitle: _('Seconds between sensor readings while the menu is open'),
        });
        const spin = new Gtk.SpinButton({adjustment: new Gtk.Adjustment({
            lower: 5, upper: 30, step_increment: 1, page_increment: 5,
        }), numeric: true, valign: Gtk.Align.CENTER});
        interval.add_suffix(spin);
        interval.activatable_widget = spin;
        display.add(interval);
        settings.bind('refresh-interval', spin, 'value', Gio.SettingsBindFlags.DEFAULT);
        const details = new Adw.SwitchRow({
            title: _('Expand Status by Default'),
            subtitle: _('Show the CPU, GPU, and both fan readings in the menu instead of the peak summary row'),
        });
        display.add(details);
        settings.bind('show-status-details', details, 'active', Gio.SettingsBindFlags.DEFAULT);

        const modes = new Adw.PreferencesGroup({
            title: _('Cooling Modes'),
            description: _('Quiet, Balanced, and Performance are the laptop firmware’s own presets. They change the fan curve and the power budget together, so Performance can raise heat as well as fan speed, and it requires the charger. They are independent of the CPU power profile in the system menu.'),
        });
        page.add(modes);
        modes.add(new Adw.ActionRow({
            title: _('System Appearance'),
            subtitle: _('Menus and controls follow the current GNOME Shell and system theme'),
        }));
        modes.add(this._link(_('Setup Instructions'),
            _('Install the cooling service once to enable readings and mode changes'),
            this.dir.get_child('README.md').get_uri()));
        modes.add(this._link(_('Project Homepage'),
            _('Source code, releases, and hardware support notes'),
            HOMEPAGE));

        const about = new Adw.PreferencesGroup({title: _('About')});
        page.add(about);
        about.add(new Adw.ActionRow({
            title: _('Laptop Cooling'),
            subtitle: `${_('Version')} ${this.metadata['version-name'] ?? this.metadata.version ?? ''}`.trim(),
        }));
        about.add(this._link(_('Report an Issue'),
            _('Report a problem or request support for another model'),
            `${HOMEPAGE}/issues`));
    }
}
