#!/bin/bash
# Build the extensions.gnome.org upload bundle.
#
# The extension is staged in a temporary directory so that the translation
# catalogues live next to it during packaging (gnome-extensions pack resolves
# --podir relative to the source directory).
#
# Output: dist/laptop-cooling@joseteo.github.io.shell-extension.zip
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

uuid=laptop-cooling@joseteo.github.io
src="extension/$uuid"
out="dist/$uuid.shell-extension.zip"

for tool in gnome-extensions glib-compile-schemas msgfmt; do
    command -v "$tool" >/dev/null || { printf 'Missing build tool: %s\n' "$tool" >&2; exit 1; }
done

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

cp -a "$src/." "$stage/"
# Never ship a stale compiled schema; rebuild it from the XML.
rm -f "$stage/schemas/gschemas.compiled"
glib-compile-schemas --strict "$stage/schemas"
cp -a po "$stage/po"

mkdir -p dist
# gnome-extensions pack only picks up js/css/schemas/locales by default, so the
# icon, the shipped README, and the licence are passed explicitly.
gnome-extensions pack --force --quiet \
    --schema=schemas/org.gnome.shell.extensions.laptop-cooling.gschema.xml \
    --podir=po --gettext-domain=laptop-cooling \
    --extra-source=icons --extra-source=README.md --extra-source=LICENSE \
    --out-dir="$root/dist" "$stage"

printf 'Built %s\n\n' "$out"
unzip -l "$out"
printf '\nUpload this file at https://extensions.gnome.org/upload/\n'
