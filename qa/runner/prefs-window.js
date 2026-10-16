// SPDX-License-Identifier: GPL-2.0-or-later
//
// QA-only: opens the extension's preferences page in a standalone GTK4 window
// so an isolated QA session can capture it.
//
// The shell's own "OpenExtensionPrefs" dialog is created inside the shell
// process and does not map a window in a headless session, so this runner
// loads the very same prefs.js as a normal Wayland client of the session.
//
// Environment:
//   LAPTOP_COOLING_PREFS_DIR  installed extension directory (required)

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

// GTK must be initialised explicitly: creating a widget first crashes in a
// plain GJS process (the shell always has GTK up and running already).
Gtk.init();

const dirPath = GLib.getenv('LAPTOP_COOLING_PREFS_DIR');
if (!dirPath) {
    printerr('LAPTOP_COOLING_PREFS_DIR is not set');
    imports.system.exit(1);
}

// The Extensions app resource provides ExtensionPreferences and the
// extension manager helpers outside the shell process.
const appResource = '/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource';
Gio.resources_register(Gio.Resource.load(appResource));

const dir = Gio.File.new_for_path(dirPath);
const [, contents] = dir.get_child('metadata.json').load_contents(null);
const metadata = JSON.parse(new TextDecoder().decode(contents));
metadata.dir = dir;
metadata.path = dirPath;

const {ExtensionPreferences} = await import(
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js');
const {default: PrefsClass} = await import(dir.get_child('prefs.js').get_uri());
const prefs = new PrefsClass(metadata);

// The extension classes resolve `gettext` through lookupByURL()/lookupByUUID()
// against the extension manager, which only the shell and the Extensions app
// have; here the prefs instance itself is the one and only extension.
ExtensionPreferences.lookupByUUID = () => prefs;

const window = new Adw.PreferencesWindow({
    title: metadata.name,
    search_enabled: false,
    // Sized to fit the page content: this window exists to be photographed.
    default_width: 700,
    default_height: 580,
});
prefs.fillPreferencesWindow(window);

const loop = GLib.MainLoop.new(null, false);
window.connect('close-request', () => {
    loop.quit();
    return false;
});
window.present();
print('prefs window presented');

loop.run();
print('prefs window closed');
