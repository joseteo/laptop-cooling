"""Run with dbus-run-session; uses simulated hardware and polkit, never ACPI."""
import importlib.util
import json
from pathlib import Path
import threading
from unittest.mock import patch

from gi.repository import Gio, GLib

spec = importlib.util.spec_from_file_location('cooling', Path(__file__).with_name('cooling_service.py'))
cooling = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cooling)


class Hardware:
    mode = 2
    writes = []

    def firmware_status(self):
        return {'fan1_rpm': 3600, 'fan2_rpm': 3400, 'on_ac': True,
                'actual_mode': self.mode, 'requested_mode': self.mode}

    def set_mode(self, mode):
        self.mode = cooling.MODES[mode]
        self.writes.append(mode)
        return self.firmware_status()


loop = GLib.MainLoop()
ready = threading.Event()
authorized = False
subjects = []
errors = []
hardware = Hardware()
temps = patch.object(cooling, 'temperatures', lambda: {'cpu_c': 69, 'gpu_c': 60})
temps.start()
service = cooling.Service(hardware, Gio, GLib)
POLKIT_XML = '''<node><interface name="org.freedesktop.PolicyKit1.Authority">
<method name="CheckAuthorization"><arg type="(sa{sv})" direction="in"/>
<arg type="s" direction="in"/><arg type="a{ss}" direction="in"/>
<arg type="u" direction="in"/><arg type="s" direction="in"/>
<arg type="(bba{ss})" direction="out"/></method></interface></node>'''


def polkit_call(_connection, sender, _path, _iface, _method, params, invocation):
    subject, action, details, flags, cancellation = params.unpack()
    assert subject[0] == 'system-bus-name'
    assert action == cooling.ACTION
    subjects.append(subject[1]['name'])
    invocation.return_value(GLib.Variant('((bba{ss}))', ((authorized, False, {}),)))


def acquired(connection, name):
    if name == cooling.BUS_NAME:
        service.on_bus_acquired(connection, name)
    else:
        info = Gio.DBusNodeInfo.new_for_xml(POLKIT_XML).interfaces[0]
        connection.register_object('/org/freedesktop/PolicyKit1/Authority', info, polkit_call, None, None)


owners = [Gio.bus_own_name(Gio.BusType.SESSION, name, Gio.BusNameOwnerFlags.NONE,
                          acquired, lambda *_: ready.set(), None)
          for name in [cooling.BUS_NAME, 'org.freedesktop.PolicyKit1']]


def client():
    global authorized
    try:
        assert ready.wait(5)
        conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)

        def call(method, mode=None):
            reply = conn.call_sync(cooling.BUS_NAME, cooling.OBJECT_PATH, cooling.BUS_NAME,
                                   method, GLib.Variant('(s)', (mode,)) if mode else None,
                                   GLib.VariantType.new('(s)'), Gio.DBusCallFlags.NONE, 5000, None)
            return json.loads(reply.unpack()[0])

        status = call('GetStatus')
        assert status['actual_mode'] == 2 and status['fan1_rpm'] == 3600
        try:
            call('SetMode', 'performance')
            raise AssertionError('Denied authorization unexpectedly succeeded')
        except GLib.Error as error:
            assert 'NotAuthorized' in error.message
        assert not hardware.writes
        authorized = True
        status = call('SetMode', 'performance')
        assert status['actual_mode'] == 3 and hardware.writes == ['performance']
        assert all(subject == conn.get_unique_name() for subject in subjects)
        assert call('GetStatus')['actual_mode'] == 3
        print('D-Bus integration passed: live status, denied authentication, authorized preset, caller identity.')
    except Exception as error:
        errors.append(error)
    finally:
        GLib.idle_add(loop.quit)


threading.Thread(target=client, daemon=True).start()
GLib.timeout_add_seconds(15, lambda: loop.quit() or GLib.SOURCE_REMOVE)
loop.run()
service.stop.set()
service.worker.join(timeout=2)
temps.stop()
for owner in owners:
    Gio.bus_unown_name(owner)
if errors:
    raise errors[0]
