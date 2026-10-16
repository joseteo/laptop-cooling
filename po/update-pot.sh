#!/bin/bash
# Regenerate po/laptop-cooling.pot from the extension sources.
#
# After running this, merge new strings into the existing catalogues with:
#   msgmerge --update po/es.po po/laptop-cooling.pot
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

xgettext \
    --language=JavaScript \
    --from-code=UTF-8 \
    --keyword=_ \
    --keyword=ngettext:1,2 \
    --keyword=pgettext:1c,2 \
    --add-comments=TRANSLATORS \
    --package-name="Laptop Cooling" \
    --package-version="1.0.0" \
    --copyright-holder="Teo Lorente" \
    --msgid-bugs-address="https://github.com/joseteo/laptop-cooling/issues" \
    --output=po/laptop-cooling.pot \
    extension/laptop-cooling@joseteo.github.io/extension.js \
    extension/laptop-cooling@joseteo.github.io/prefs.js

sed -i 's|^# FIRST AUTHOR <EMAIL@ADDRESS>, YEAR\.$|# Teo Lorente <joseteolorentevallecillos@gmail.com>, 2026.|' po/laptop-cooling.pot
printf 'Wrote po/laptop-cooling.pot (%s strings)\n' "$(grep -c '^msgid' po/laptop-cooling.pot)"
