#!/bin/bash
# Capture screenshots from an isolated, headless GNOME Shell session running
# the exact extension bundle that is uploaded to extensions.gnome.org.
#
#   QA_SCENARIO=qa/scenarios/capture-all.json qa/run.sh
#
# Environment:
#   QA_SCENARIO  scenario file (default: qa/scenarios/capture-all.json)
#   QA_OUTDIR    output directory (default: qa/out/<scenario name>)
#   QA_LOCALE    locale for the session (default: en_US.UTF-8)
#   QA_LOAD      seconds of synthetic CPU load during the frame series
#                (default: 0; use ~22 with capture-all.json)
#
# The session uses throwaway XDG directories, its own session bus, and its own
# Wayland runtime directory, so the live desktop is never touched. Sensor
# readings come from the real cooling service; the optional synthetic load
# makes the demo animation show a real fan response.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

scenario=${QA_SCENARIO:-$root/qa/scenarios/capture-all.json}
run_root=${QA_RUN_ROOT:-$root/qa/.run}
locale_name=${QA_LOCALE:-en_US.UTF-8}
load_seconds=${QA_LOAD:-0}
outdir=${QA_OUTDIR:-$root/qa/out/$(basename "${scenario%.json}")}

uuid=laptop-cooling@joseteo.github.io
qa_uuid=laptop-cooling-qa@joseteo.github.io

# Every headless session starts a private D-Bus, gvfs, at-spi, xdg-desktop-portal
# and evolution-data-server; those helpers outlive the shell when it is stopped
# with SIGTERM. Left behind they accumulate until the user's D-Bus connection
# limit is exhausted and new sessions fail with "LimitsExceeded" before the
# extension ever loads, so each run reaps whatever earlier runs left over.
# Only processes whose XDG_RUNTIME_DIR is this run root are touched.
reap_stale() {
    local pid cmd signal
    for signal in TERM KILL; do
        [ "$signal" = KILL ] && sleep 1
        for pid in /proc/[0-9]*; do
            pid=${pid#/proc/}
            [ "$pid" != "$$" ] || continue
            [ -r "/proc/$pid/environ" ] || continue
            grep -qz "^XDG_RUNTIME_DIR=${run_root}/runtime$" \
                "/proc/$pid/environ" 2>/dev/null || continue
            cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
            printf '   stopping %s %s\n' "$pid" "${cmd%% *}"
            kill "-$signal" "$pid" 2>/dev/null || true
        done
    done
}

rm -rf "$run_root"
mkdir -p "$run_root"/config "$run_root"/data "$run_root"/cache "$run_root"/runtime "$run_root"/out "$outdir/raw"
chmod 700 "$run_root" "$run_root/runtime"

printf '== Reaping helpers of earlier sessions\n'
reap_stale

export XDG_CONFIG_HOME="$run_root/config"
export XDG_DATA_HOME="$run_root/data"
export XDG_CACHE_HOME="$run_root/cache"
export XDG_RUNTIME_DIR="$run_root/runtime"
export GSETTINGS_SCHEMA_DIR=/usr/share/glib-2.0/schemas
export GSETTINGS_BACKEND=keyfile
export LIBGL_ALWAYS_SOFTWARE=1
# GTK children must speak Wayland to the isolated compositor; GDK_BACKEND or
# XDG_SESSION_TYPE leaking in from the caller's desktop breaks them.
export GDK_BACKEND=wayland
export XDG_SESSION_TYPE=wayland
export LANG="$locale_name"
export LC_ALL="$locale_name"
# LANGUAGE (a gettext extension, often set to the desktop's UI language)
# outranks LC_ALL and would defeat the translation captures: the session must
# resolve messages from the locale we asked for, not the caller's session.
unset LANGUAGE
# Hosts rarely have every locale generated (es_ES.UTF-8 is a common gap), and
# the shell resolves gettext through the locale name. Build the requested
# locale inside the run root and let LOCPATH find it, so translation captures
# work without changing the system or needing root.
if ! locale charmap 2>/dev/null | grep -q 'UTF-8'; then
    locale_base=${locale_name%%[.@]*}
    if localedef -i "$locale_base" -f UTF-8 --no-archive \
            "$run_root/locale/$locale_name" 2>/dev/null; then
        export LOCPATH="$run_root/locale"
        printf '== Generated %s in the run root (host locale missing)\n' "$locale_name"
    else
        printf '== Warning: %s is unavailable and cannot be generated\n' "$locale_name" >&2
    fi
fi
# The session must not see the caller's home directory: desktop icons (ding)
# and file managers would otherwise render the user's real files into the
# screenshots.
export HOME="$run_root/home"
mkdir -p "$HOME"
# A DISPLAY leaking in from the caller's desktop would make GTK clients
# connect to the wrong display (and crash); the session is Wayland-only.
unset DBUS_SESSION_BUS_ADDRESS SESSION_MANAGER DISPLAY

printf '== Building and installing the release bundle\n'
bash "$root/scripts/build-extension.sh" > /dev/null
gnome-extensions install --force "$root/dist/$uuid.shell-extension.zip"

printf '== Installing the QA harness extension\n'
install -d "$XDG_DATA_HOME/gnome-shell/extensions"
cp -a "$root/qa/extension/$qa_uuid" "$XDG_DATA_HOME/gnome-shell/extensions/"

printf '== Configuring the isolated session\n'
# The QA harness is listed *before* the extension under test: when the shell
# disables an extension it temporarily disables and re-enables every extension
# enabled after it ("rebasing"), which would restart the harness mid-scenario.
gsettings set org.gnome.shell enabled-extensions "['$qa_uuid', '$uuid']"
# ding is enabled by default on Ubuntu and paints the (now empty) desktop with
# the caller's files; Ubuntu Dock and the rest of the session stay in place so
# the captures look like a real desktop.
gsettings set org.gnome.shell disabled-extensions "['ding@rastersoft.com']"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.desktop.interface color-scheme prefer-dark
gsettings set org.gnome.desktop.interface gtk-theme Yaru-dark
gsettings set org.gnome.desktop.interface clock-show-seconds false

prepared="$run_root/out/scenario.json"
sed -e "s|\"outdir\":[^,]*|\"outdir\": \"$run_root/out\"|" \
    -e "s|\"target\":[^,]*|\"target\": \"$uuid\"|" \
    "$scenario" > "$prepared"

printf '== Starting the isolated headless session (%s)\n' "$locale_name"
export LAPTOP_COOLING_QA_SCENARIO="$prepared"
export LAPTOP_COOLING_QA_RUNNER="$root/qa/runner/prefs-window.js"
set +e
dbus-run-session -- timeout 180s gnome-shell --wayland --headless \
    --virtual-monitor 1280x800 --no-x11 --mode=ubuntu \
    > "$run_root/out/shell.log" 2>&1 &
shell_pid=$!

if [ "$load_seconds" -gt 0 ]; then
    QA_LOAD_START=${QA_LOAD_START:-11} QA_LOAD_SECONDS="$load_seconds" bash -c '
        sleep "$QA_LOAD_START"
        pids=()
        for _ in $(seq "$(nproc)"); do yes > /dev/null & pids+=($!); done
        sleep "$QA_LOAD_SECONDS"
        kill "${pids[@]}" 2> /dev/null
    ' &
    load_pid=$!
fi

for _ in $(seq 400); do
    [ -f "$run_root/out/done" ] && break
    sleep 0.5
done
kill -TERM "$shell_pid" 2> /dev/null
wait "$shell_pid" 2> /dev/null
[ -n "${load_pid:-}" ] && kill "$load_pid" 2> /dev/null
set -e

printf '== Reaping session helpers\n'
reap_stale

rm -f "$outdir/raw/"*.png
cp -a "$run_root/out/"*.png "$outdir/raw/" 2> /dev/null || true
cp -a "$run_root/out/"*-runner.log "$outdir/" 2> /dev/null || true
cp -a "$run_root/out/qa-session.log" "$outdir/qa-session.log" 2> /dev/null || true
cp -a "$run_root/out/shell.log" "$outdir/shell.log" 2> /dev/null || true
printf '== Captured %s frames into %s\n' "$(find "$outdir/raw" -name '*.png' | wc -l)" "$outdir/raw"
