# Security policy

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue:

- GitHub → **Security** → *Report a vulnerability*
  (<https://github.com/joseteo/laptop-cooling/security/advisories/new>), or
- e-mail **joseteolorentevallecillos@gmail.com** if you cannot use GitHub.

Include what you can: the affected component (extension or service), the shell
and distribution version, a description of the impact, and, if possible, a
reproduction that does not require the maintainer's hardware model.

Expect an acknowledgement within a few days. Fixes are prepared in private,
released as a new version, and only then described publicly. Credit is given
unless you prefer otherwise.

## Supported versions

The latest published version receives fixes. The extension targets
GNOME Shell 46; the service is packaged from this repository.

## What this project does with privileges

Worth knowing before you test it, and useful if you find something:

- The extension runs **unprivileged** inside the GNOME Shell process and only
  calls two D-Bus methods on the system bus.
- The systemd service runs **as root** but with `ProtectHome=true`,
  `ProtectSystem=strict`, `PrivateTmp=true` and `/run/lock` as the only
  writable path. It reads DMI identifiers, `/sys/class/hwmon`, `nvidia-smi`,
  `/proc/acpi/call`, and talks to polkit and the system bus. It opens no
  network sockets and no user files.
- `SetMode` is guarded by the polkit action `org.teo.laptopcooling.set-mode`
  with `allow_active=auth_admin_keep`; the caller is identified by its D-Bus
  unique name, not by a caller-supplied value.
- The write path is limited to the firmware's three documented presets on the
  verified model/BIOS pair. No EC memory is written directly, and unknown
  hardware never reaches an ACPI call.
- Every ACPI transaction is serialised through an
  `O_NOFOLLOW`-opened, root-owned lock file under `/run/lock`.

## Out of scope

- Behaviour on laptop models other than the verified one, when the user has
  modified the source to bypass the model check (the check exists precisely to
  prevent unsupported firmware writes).
- Denial of service by a local root user.
- Issues that require an attacker to already control the user's desktop
  session, the root account, or the physical firmware setup.
