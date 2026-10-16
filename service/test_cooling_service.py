import contextlib
import importlib.util
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

from gi.repository import Gio, GLib

spec = importlib.util.spec_from_file_location('cooling', Path(__file__).with_name('cooling_service.py'))
cooling = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cooling)


class FakeHardware(cooling.Hardware):
    def __init__(self, on_ac=True, accept=True):
        self.lock = threading.RLock()
        self.mode = 2
        self.on_ac = on_ac
        self.accept = accept
        self.writes = []

    def query(self, method_id, argument=0):
        if method_id == 0x2C:
            self.writes.append(argument)
            if self.accept or argument == 2:
                self.mode = argument
            return 0
        return {0x08: 3600, 0x09: 3400, 0x2D: self.mode,
                0x37: self.mode, 0x2F: 1 if self.on_ac else 2}[method_id]


class Invocation:
    def __init__(self):
        self.error = None
        self.result = None

    def return_dbus_error(self, name, message):
        self.error = (name, message)

    def return_value(self, result):
        self.result = result


class CoolingTests(unittest.TestCase):
    def setUp(self):
        self.lock_patch = patch.object(cooling, 'firmware_lock', contextlib.nullcontext)
        self.lock_patch.start()
        self.addCleanup(self.lock_patch.stop)

    def test_performance_uses_only_verified_preset_and_confirms_readback(self):
        hardware = FakeHardware()
        self.assertEqual(hardware.set_mode('performance')['actual_mode'], 3)
        self.assertEqual(hardware.writes, [3])

    def test_battery_rejects_performance_without_a_write(self):
        hardware = FakeHardware(on_ac=False)
        with self.assertRaisesRegex(RuntimeError, 'Connect the charger'):
            hardware.set_mode('performance')
        self.assertEqual(hardware.writes, [])

    def test_unverified_max_fan_and_arbitrary_input_are_rejected(self):
        hardware = FakeHardware()
        for mode in ['max', '0x0D', 'performance; reboot', '']:
            with self.assertRaises(ValueError):
                hardware.set_mode(mode)
        self.assertEqual(hardware.writes, [])

    def test_failed_mode_readback_restores_previous_preset(self):
        hardware = FakeHardware(accept=False)
        with self.assertRaisesRegex(RuntimeError, 'did not take effect'):
            hardware.set_mode('performance')
        self.assertEqual(hardware.writes, [3, 2])
        self.assertEqual(hardware.mode, 2)

    def make_service(self):
        service = cooling.Service.__new__(cooling.Service)
        service.hardware = FakeHardware()
        service.Gio, service.GLib = Gio, GLib
        service.pending = set()
        return service

    def test_dbus_requires_authorization_for_real_sender_before_change(self):
        service = self.make_service()
        invocation = Invocation()
        calls = []

        class Connection:
            def call(self, *args):
                calls.append(args)

        service.on_call(Connection(), ':1.42', cooling.OBJECT_PATH, cooling.BUS_NAME,
                        'SetMode', GLib.Variant('(s)', ('performance',)), invocation)
        params = calls[0][4].unpack()
        self.assertEqual(params[0], ('system-bus-name', {'name': ':1.42'}))
        self.assertEqual(params[1], cooling.ACTION)
        self.assertEqual(params[3], 1)
        self.assertEqual(service.hardware.writes, [])

    def test_denied_authorization_cannot_change_hardware(self):
        service = self.make_service()
        service.pending.add(':1.42')
        invocation = Invocation()

        class Connection:
            def call_finish(self, _result):
                return GLib.Variant('((bba{ss}))', ((False, False, {}),))

        service.on_authorized(Connection(), None, (':1.42', 'performance', invocation))
        self.assertEqual(service.hardware.writes, [])
        self.assertTrue(invocation.error[0].endswith('NotAuthorized'))
        self.assertFalse(service.pending)

    def test_dbus_invalid_mode_never_starts_authorization(self):
        service = self.make_service()
        invocation = Invocation()
        service.on_call(None, ':1.42', cooling.OBJECT_PATH, cooling.BUS_NAME,
                        'SetMode', GLib.Variant('(s)', ('max',)), invocation)
        self.assertTrue(invocation.error[0].endswith('InvalidMode'))
        self.assertEqual(service.hardware.writes, [])


if __name__ == '__main__':
    unittest.main()
