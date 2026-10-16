// SPDX-License-Identifier: GPL-2.0-or-later
//
// QA-only: minimal GTK4 window, used to find out what the isolated session's
// GTK stack can actually do. Prints a marker after each step so a crash can be
// pinpointed from the log.

import Gtk from 'gi://Gtk?version=4.0';

print('gtk-probe: module loaded');
Gtk.init();
print('gtk-probe: gtk initialised');

const window = new Gtk.Window({title: 'GTK probe', default_width: 420, default_height: 260});
print('gtk-probe: window created');

const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12,
    margin_top: 24, margin_bottom: 24, margin_start: 24, margin_end: 24});
box.append(new Gtk.Label({label: 'GTK probe window'}));
window.set_child(box);
window.present();
print(`gtk-probe: presented, visible=${window.get_visible()}`);
