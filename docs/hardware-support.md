# Hardware support

Firmware calls are only made on a machine that has been *verified*: model and
BIOS revision checked in code, readings cross-checked against the firmware's
own report. Everything else gets an honest "unsupported" answer.

## Supported today

| Model | DMI product | BIOS | Status | Notes |
| --- | --- | --- | --- | --- |
| Lenovo IdeaPad Gaming 3 15IMH05 | `81Y4` | `EGCN41WW` | **Verified** | Development machine. All readings and the three presets were exercised on it. |

The check lives in `service/cooling_service.py`:

```python
model = Path('/sys/class/dmi/id/product_name').read_text().strip()
bios  = Path('/sys/class/dmi/id/bios_version').read_text().strip()
if (model, bios) != ('81Y4', 'EGCN41WW'):
    raise RuntimeError(f'Unsupported hardware: {model} / {bios}')
```

Consequences of a mismatch:

- **The extension still loads and works.** The tile opens, shows the
  "Unsupported" state and the setup link; no readings, no mode rows that could
  do anything.
- **The service refuses to start**, so there is nothing listening on
  `org.teo.LaptopCooling` and no ACPI call is ever attempted.

Support is gated on the *BIOS version* as well as the model because vendor
firmware revisions of the same chassis have been observed to change the ACPI
method ids. A BIOS update is therefore a supported-hardware change, not a
bug fix.

## Why it is gated at all

The ACPI namespace holds vendor methods that are not part of any public
specification. On the verified machine, the ids below were probed with the
firmware running normally, values were compared against `nvidia-smi`, `sensors`
and the vendor tool, and *no* undocumented write id is ever used by the
service:

| Id | Direction | Meaning | Verified against |
| --- | --- | --- | --- |
| `0x08` | read | Fan 1 RPM | vendor tool, BIOS fan report |
| `0x09` | read | Fan 2 RPM | vendor tool, BIOS fan report |
| `0x2C` | write | Request cooling preset | vendor tool (same values: 1 quiet, 2 balanced, 3 performance) |
| `0x2D` | read | Requested preset | echo of the last write |
| `0x2F` | read | On AC power | `/sys/class/power_supply/AC*/online` |
| `0x37` | read | Actual preset | firmware-confirmed state after a mode change |

Writing an unknown id on an unknown machine can change thermal limits, fan
targets, or worse, with no way to know what the firmware will do. That is why
"it probably works on my model too" is not accepted as support.

## Adding a model

1. **Collect the identifiers.**

   ```bash
   cat /sys/class/dmi/id/product_name /sys/class/dmi/id/bios_version /sys/class/dmi/id/board_name
   ```

2. **Read only, first.** Load `acpi_call` and probe the *read* ids, comparing
   each answer with a known-good source (`sensors`, the vendor tool, the BIOS
   fan report):

   ```bash
   sudo modprobe acpi_call
   sudo sh -c 'echo "\_SB.GZFD.WMAA 0 0x08 0" > /proc/acpi/call; cat /proc/acpi/call'
   ```

   Non-hex answers (`0x0` or error strings) mean the id is different on that
   firmware.

3. **Find the setter carefully.** Only after the reads line up, search the
   DSDT/SSDT for the namespace's setter methods (`acpidump`,
   `iasl -d`), identify the preset ids, and confirm them by writing *one*
   preset and immediately reading it back with the read ids.

4. **Extend the code as a profile, not a special case.** Introduce the
   model/BIOS pair with its own method map, keep the polkit action and the
   lock file semantics unchanged, and add unit tests for the new map (the
   existing `service/test_cooling_service.py` shows the pattern with a fake
   `Hardware`).

5. **Document it.** Add the row to the table above, and open a pull request
   that includes the probe transcript (`--status` output before and after a
   mode change) so the numbers can be reviewed.

## What is not supported (and why)

- **Writing fan RPM directly.** The firmware's presets are the contract; there
  is no supported write path for a raw duty cycle on this generation, and
  forcing one would fight the EC's own control loop.
- **Undocumented write ids** (anything but `0x2C` with the three verified
  presets).
- **Non-Lenovo chassis** that expose a similar namespace under a different
  path, since the namespace string is part of the profile for a reason.
- **Machines without `acpi_call`.** There is no kernel driver for this
  interface; without the module the service cannot read the controller, and
  pretending otherwise would mean fabricating readings.
