#!/bin/bash
# Run every automated check that does not need the physical laptop.
#
#  * Python unit tests for the service (preset validation, charger checks,
#    rollback, caller identity, denied authorization)
#  * Private D-Bus round trip against a simulated service
#  * GSettings schema validation
#  * JSON validation of the extension metadata
#  * Translation catalogue validation
#  * JavaScript syntax check
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
uuid=laptop-cooling@joseteo.github.io

printf '\n== Python unit tests\n'
/usr/bin/python3 -m unittest -v service.test_cooling_service 2>&1 | tail -n 12 ||
    PYTHONPATH="$root/service" /usr/bin/python3 "$root/service/test_cooling_service.py" -v

printf '\n== D-Bus integration test\n'
PYTHONPATH="$root/service" /usr/bin/python3 "$root/service/test_dbus_integration.py"

printf '\n== GSettings schemas\n'
glib-compile-schemas --strict --dry-run "extension/$uuid/schemas"

printf '\n== metadata.json\n'
/usr/bin/python3 -c "import json,sys; json.load(open('extension/$uuid/metadata.json')); print('valid JSON')"

printf '\n== translations\n'
for po in po/*.po; do
    msgfmt --check --statistics -o /dev/null "$po"
done

printf '\n== JavaScript syntax\n'
node --input-type=module --check < "extension/$uuid/extension.js" && echo 'extension.js parses'
node --input-type=module --check < "extension/$uuid/prefs.js" && echo 'prefs.js parses'

printf '\nAll non-hardware checks passed.\n'
