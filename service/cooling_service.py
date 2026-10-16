#!/usr/bin/python3
"""Model-specific Lenovo cooling service. Only verified mode presets are writable."""
import argparse
from contextlib import contextmanager
import csv
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import stat
import threading
import time

BUS_NAME = 'org.teo.LaptopCooling'
OBJECT_PATH = '/org/teo/LaptopCooling'
ACTION = 'org.teo.laptopcooling.set-mode'
METHOD = r'\_SB.GZFD.WMAA'
MODES = {'quiet': 1, 'balanced': 2, 'performance': 3}
INTERFACE_XML = '''<node><interface name="org.teo.LaptopCooling">
<method name="GetStatus"><arg type="s" direction="out" name="status"/></method>
<method name="SetMode"><arg type="s" direction="in" name="mode"/>
<arg type="s" direction="out" name="status"/></method>
</interface></node>'''


@contextmanager
def firmware_lock():
    path = '/run/lock/ideapad-fan-getters.lock'
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('The ACPI lock file must be a regular root-owned file without group/other write access.')
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


class Hardware:
    def __init__(self):
        model = Path('/sys/class/dmi/id/product_name').read_text().strip()
        bios = Path('/sys/class/dmi/id/bios_version').read_text().strip()
        if (model, bios) != ('81Y4', 'EGCN41WW'):
            raise RuntimeError(f'Unsupported hardware: {model} / {bios}')
        if os.geteuid() != 0:
            raise RuntimeError('Root access is required for the ACPI interface.')
        self.call = Path('/proc/acpi/call')
        if not self.call.exists():
            subprocess.run(['/usr/sbin/modprobe', 'acpi_call'], check=True, timeout=10)
        self.lock = threading.RLock()

    def query(self, method_id, argument=0):
        self.call.write_text(f'{METHOD} 0 {method_id:#x} {argument}\n')
        raw = self.call.read_text().strip().strip('\x00')
        if not re.fullmatch(r'0x[0-9a-fA-F]+', raw):
            raise RuntimeError(f'Firmware query {method_id:#x} failed: {raw}')
        return int(raw, 16)

    def _firmware_status(self):
        return {
            'fan1_rpm': self.query(0x08),
            'fan2_rpm': self.query(0x09),
            'requested_mode': self.query(0x2D),
            'actual_mode': self.query(0x37),
            'on_ac': self.query(0x2F) == 1,
            'max_fan_supported': False,
        }

    def firmware_status(self):
        with self.lock, firmware_lock():
            return self._firmware_status()

    def set_mode(self, mode):
        if mode not in MODES:
            raise ValueError('Choose quiet, balanced, or performance.')
        with self.lock, firmware_lock():
            before = self._firmware_status()
            if mode == 'performance' and not before['on_ac']:
                raise RuntimeError('Connect the charger to use Performance mode.')
            original = before['requested_mode']
            try:
                if self.query(0x2C, MODES[mode]) != 0:
                    raise RuntimeError('The firmware rejected the cooling mode.')
                time.sleep(0.1)
                after = self._firmware_status()
                if after['requested_mode'] != MODES[mode] or after['actual_mode'] != MODES[mode]:
                    raise RuntimeError('The requested cooling mode did not take effect.')
            except Exception as exc:
                if original in MODES.values():
                    try:
                        self.query(0x2C, original)
                    except Exception as rollback:
                        raise RuntimeError(f'{exc} Restoring the previous mode also failed: {rollback}') from exc
                raise
            return after


def temperatures():
    cpu = None
    for hwmon in Path('/sys/class/hwmon').glob('hwmon*'):
        try:
            if (hwmon / 'name').read_text().strip() == 'coretemp':
                cpu = int((hwmon / 'temp1_input').read_text()) / 1000
                break
        except (OSError, ValueError):
            continue
    gpu = None
    try:
        result = subprocess.run([
            '/usr/bin/nvidia-smi',
            '--query-gpu=temperature.gpu', '--format=csv,noheader,nounits',
        ], capture_output=True, text=True, timeout=2, check=True)
        gpu = float(next(csv.reader(result.stdout.splitlines()))[0])
    except (OSError, ValueError, StopIteration, subprocess.SubprocessError):
        pass
    return {'cpu_c': cpu, 'gpu_c': gpu}


class Service:
    def __init__(self, hardware, Gio, GLib):
        self.hardware, self.Gio, self.GLib = hardware, Gio, GLib
        self.connection = None
        self.pending = set()
        self.status_lock = threading.Lock()
        self.refresh_lock = threading.RLock()
        self.status = {'available': False, 'error': 'Connecting to cooling sensors…'}
        self.stop = threading.Event()
        self.worker = threading.Thread(target=self.poll, daemon=True)
        self.worker.start()

    def store(self, data):
        with self.status_lock:
            self.status = data

    def snapshot(self):
        with self.status_lock:
            return json.dumps(self.status)

    def refresh(self):
        with self.refresh_lock:
            try:
                data = {'available': True, 'updated_at': time.time(),
                        **self.hardware.firmware_status(), **temperatures()}
            except Exception as exc:
                data = {'available': False, 'error': str(exc), 'updated_at': time.time()}
            self.store(data)

    def poll(self):
        while not self.stop.is_set():
            self.refresh()
            self.stop.wait(5)

    def on_bus_acquired(self, connection, _name):
        self.connection = connection
        info = self.Gio.DBusNodeInfo.new_for_xml(INTERFACE_XML).interfaces[0]
        self.registration = connection.register_object(OBJECT_PATH, info, self.on_call, None, None)

    def on_call(self, connection, sender, _path, _interface, method, parameters, invocation):
        if method == 'GetStatus':
            invocation.return_value(self.GLib.Variant('(s)', (self.snapshot(),)))
            return
        if method != 'SetMode':
            invocation.return_dbus_error(f'{BUS_NAME}.UnknownMethod', 'Unknown method.')
            return
        mode, = parameters.unpack()
        if mode not in MODES:
            invocation.return_dbus_error(f'{BUS_NAME}.InvalidMode', 'Choose quiet, balanced, or performance.')
            return
        if sender in self.pending or len(self.pending) >= 4:
            invocation.return_dbus_error(f'{BUS_NAME}.Busy', 'A cooling-mode change is already pending.')
            return
        self.pending.add(sender)
        # Polkit identifies the caller by its D-Bus unique name; the client
        # cannot supply an arbitrary PID or user identity.
        subject = ('system-bus-name', {'name': self.GLib.Variant('s', sender)})
        params = self.GLib.Variant('((sa{sv})sa{ss}us)', (subject, ACTION, {}, 1, ''))
        connection.call('org.freedesktop.PolicyKit1', '/org/freedesktop/PolicyKit1/Authority',
                        'org.freedesktop.PolicyKit1.Authority', 'CheckAuthorization', params,
                        self.GLib.VariantType.new('((bba{ss}))'), self.Gio.DBusCallFlags.NONE,
                        120000, None, self.on_authorized, (sender, mode, invocation))

    def on_authorized(self, connection, result, context):
        sender, mode, invocation = context
        try:
            authorized, _challenge, _details = connection.call_finish(result).unpack()[0]
            if not authorized:
                raise PermissionError('Authentication was cancelled or denied.')
        except Exception as exc:
            self.pending.discard(sender)
            invocation.return_dbus_error(f'{BUS_NAME}.NotAuthorized', str(exc))
            return
        threading.Thread(target=self.change_mode,
                         args=(sender, mode, invocation), daemon=True).start()

    def change_mode(self, sender, mode, invocation):
        try:
            with self.refresh_lock:
                self.hardware.set_mode(mode)
                self.refresh()
                data, error = self.snapshot(), None
        except Exception as exc:
            data, error = None, str(exc)
        self.GLib.idle_add(self.finish_change, sender, invocation, data, error)

    def finish_change(self, sender, invocation, data, error):
        self.pending.discard(sender)
        if error:
            invocation.return_dbus_error(f'{BUS_NAME}.ModeFailed', error)
        else:
            invocation.return_value(self.GLib.Variant('(s)', (data,)))
        return self.GLib.SOURCE_REMOVE


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=MODES, help='set a verified native preset and print the result')
    parser.add_argument('--status', action='store_true', help='read sensors once and print the result')
    args = parser.parse_args()
    hardware = Hardware()
    if args.mode or args.status:
        status = hardware.set_mode(args.mode) if args.mode else hardware.firmware_status()
        print(json.dumps({**status, **temperatures()}, indent=2))
        return
    import gi
    from gi.repository import Gio, GLib
    service = Service(hardware, Gio, GLib)
    loop = GLib.MainLoop()
    owner = Gio.bus_own_name(Gio.BusType.SYSTEM, BUS_NAME, Gio.BusNameOwnerFlags.NONE,
                             service.on_bus_acquired, None, lambda *_: loop.quit())
    try:
        loop.run()
    finally:
        service.stop.set()
        Gio.bus_unown_name(owner)


if __name__ == '__main__':
    main()
