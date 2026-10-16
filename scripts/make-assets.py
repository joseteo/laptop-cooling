#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Generates the repository artwork in docs/assets/ from the QA captures and
# the extension's own symbolic icon:
#
#   * icon.png / logo.png       app icon rendered from icons/fan-symbolic.svg
#   * banner.png / social.png   hero graphics for the README and GitHub
#   * menu-*.png, quick-settings.png, preferences.png ...
#                               cropped, rounded screenshots ("cards")
#   * live-readings.gif         animation assembled from the fan-curve series
#
# Usage:
#   scripts/make-assets.py [captures-dir]
#
# captures-dir defaults to qa/out/capture-all/raw and must contain the frames
# produced by qa/run.sh (see qa/README.md).
#
# Requirements: python3-gi (GdkPixbuf with SVG support), Pillow, ImageMagick
# only for the optional .gif fallback (Pillow is used by default).

from __future__ import annotations

import math
import subprocess
import sys
from pathlib import Path

import gi
from PIL import Image, ImageDraw, ImageFilter, ImageFont

gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'docs' / 'assets'
ICON_SVG = ROOT / 'extension' / 'laptop-cooling@joseteo.github.io' / 'icons' / 'fan-symbolic.svg'
FONT_DIR = Path('/usr/share/fonts/opentype')

ACCENT = (233, 84, 32)          # Ubuntu/Yaru accent orange, matches the shell
ACCENT_BRIGHT = (255, 122, 60)
INK = (246, 246, 246)
MUTED = (176, 181, 192)


def font(family: str, weight: str, size: int) -> ImageFont.FreeTypeFont:
    path = FONT_DIR / family.lower() / f'{family}-{weight}.otf'
    return ImageFont.truetype(str(path), size)


def text_size(draw: ImageDraw.ImageDraw, text: str, fnt: ImageFont.FreeTypeFont):
    left, top, right, bottom = draw.textbbox((0, 0), text, font=fnt)
    return right - left, bottom - top, left, top


def render_glyph(color: tuple[int, int, int, int] | str, size: int) -> Image.Image:
    """Rasterises the extension's symbolic fan icon through GdkPixbuf."""
    svg = ICON_SVG.read_text()
    hex_color = '#%02x%02x%02x' % color[:3] if isinstance(color, tuple) else color
    svg = svg.replace('#2e3436', hex_color)
    loader = GdkPixbuf.PixbufLoader.new_with_type('svg')
    loader.set_size(size, size)
    loader.write(svg.encode())
    loader.close()
    pixbuf = loader.get_pixbuf()
    mode = 'RGBA' if pixbuf.get_has_alpha() else 'RGB'
    image = Image.frombytes(mode, (pixbuf.get_width(), pixbuf.get_height()),
                            pixbuf.get_pixels())
    return image.convert('RGBA')


def rounded(image: Image.Image, radius: int) -> Image.Image:
    mask = Image.new('L', image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, *image.size), radius, fill=255)
    out = image.convert('RGBA')
    out.putalpha(mask)
    return out


def card(shadow: int = 24) -> Image.Image:
    """Rounded screenshot with a soft drop shadow, ready to paste."""
    return Image.new('RGBA', (1, 1))


def make_card(source: Image.Image, radius: int = 14, shadow: int = 26,
              border: int = 1) -> Image.Image:
    body = rounded(source, radius)
    canvas = Image.new('RGBA', (source.width + shadow * 2, source.height + shadow * 2),
                       (0, 0, 0, 0))
    silhouette = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    silhouette.paste((8, 9, 12, 190), (shadow, shadow, shadow + source.width,
                                       shadow + source.height))
    silhouette = silhouette.filter(ImageFilter.GaussianBlur(shadow * 0.45))
    canvas = Image.alpha_composite(canvas, silhouette)
    canvas.paste(body, (shadow, shadow), body)
    if border:
        draw = ImageDraw.Draw(canvas)
        draw.rounded_rectangle((shadow, shadow, shadow + source.width - 1,
                                shadow + source.height - 1), radius,
                               outline=(70, 74, 86, 220), width=border)
    return canvas


def crop_frame(path: Path, box: tuple[int, int, int, int]) -> Image.Image:
    return Image.open(path).convert('RGBA').crop(box)


def prefs_window_box(log: Path, fallback: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    """Window rectangle recorded by the QA harness while capturing prefs."""
    try:
        for line in log.read_text().splitlines():
            if 'prefs window rect ' in line:
                position, size = line.split('prefs window rect ')[1].split()
                x, y = (int(value) for value in position.split(','))
                width, height = (int(value) for value in size.split('x'))
                if width > 100 and height > 100:
                    return (x, y, x + width, y + height)
    except (OSError, ValueError):
        pass
    return fallback


# --------------------------------------------------------------------------- #
# artwork
# --------------------------------------------------------------------------- #

def make_icon(size: int = 512) -> Image.Image:
    """Dark rounded square with the fan glyph in the accent gradient."""
    pad = int(size * 0.06)
    inner = size - pad * 2
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    plate = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(plate)
    for y in range(size):
        t = y / size
        color = tuple(int(a + (b - a) * t) for a, b in zip((38, 40, 48), (22, 23, 28)))
        draw.line([(0, y), (size, y)], fill=(*color, 255))
    glow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse((pad - inner * 0.1, pad - inner * 0.35, size - pad + inner * 0.1,
                   pad + inner * 0.8), fill=(*ACCENT, 92))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.16))
    plate = Image.alpha_composite(plate, glow)
    plate.putalpha(rounded(plate, int(size * 0.22)).getchannel('A'))
    canvas = Image.alpha_composite(canvas, plate)

    glyph_size = int(size * 0.62)
    glyph = render_glyph('#ffffff', glyph_size)
    # Accent gradient through the glyph mask.
    gradient = Image.new('RGBA', (glyph_size, glyph_size))
    gdraw = ImageDraw.Draw(gradient)
    for y in range(glyph_size):
        t = y / glyph_size
        color = tuple(int(a + (b - a) * t) for a, b in zip(ACCENT_BRIGHT, (214, 62, 20)))
        gdraw.line([(0, y), (glyph_size, y)], fill=(*color, 255))
    glyph.putalpha(glyph.getchannel('A'))
    gradient.putalpha(glyph.getchannel('A'))
    offset = ((size - glyph_size) // 2, (size - glyph_size) // 2)
    shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 150), offset, glyph)
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.02))
    canvas = Image.alpha_composite(canvas, shadow)
    canvas.paste(gradient, offset, gradient)
    return canvas


def make_banner(width: int = 1600, height: int = 460,
                screenshot: Image.Image | None = None) -> Image.Image:
    canvas = Image.new('RGBA', (width, height), (18, 19, 24, 255))
    draw = ImageDraw.Draw(canvas)
    for y in range(height):
        t = y / height
        color = tuple(int(a + (b - a) * t) for a, b in zip((26, 27, 34), (14, 15, 19)))
        draw.line([(0, y), (width, y)], fill=(*color, 255))
    glow = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((-width * 0.12, -height * 0.9, width * 0.55,
                                  height * 0.75), fill=(*ACCENT, 66))
    glow = glow.filter(ImageFilter.GaussianBlur(height * 0.22))
    canvas = Image.alpha_composite(canvas, glow)
    grid = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(grid)
    for x in range(0, width, 48):
        gdraw.line([(x, 0), (x, height)], fill=(255, 255, 255, 6))
    for y in range(0, height, 48):
        gdraw.line([(0, y), (width, y)], fill=(255, 255, 255, 6))
    canvas = Image.alpha_composite(canvas, grid)

    left = 96
    icon = make_icon(124)
    canvas.paste(icon, (left, 72), icon)

    draw = ImageDraw.Draw(canvas)
    draw.text((left, 214), 'Laptop Cooling', font=font('Cantarell', 'Bold', 74),
              fill=INK)

    tagline = ('Quiet, Balanced and Performance presets with live CPU, GPU\n'
               'and fan readings, right in Quick Settings.')
    draw.multiline_text((left + 4, 312), tagline,
                        font=font('Cantarell', 'Regular', 27), fill=MUTED,
                        spacing=10)

    chip_font = font('Cantarell', 'Bold', 20)
    chips = ['GNOME 46', 'D-Bus + polkit', 'ACPI presets', 'No root in the Shell']
    x = left + 4
    chip_top = 402
    for chip in chips:
        w, h, _, _ = text_size(draw, chip, chip_font)
        box = (x, chip_top, x + w + 30, chip_top + h + 20)
        draw.rounded_rectangle(box, 14, fill=(*ACCENT, 36), outline=(*ACCENT, 170),
                               width=1)
        draw.text((x + 15, chip_top + 6), chip, font=chip_font, fill=(255, 186, 150))
        x = box[2] + 14

    if screenshot is not None:
        target_h = height - 108
        scale = target_h / screenshot.height
        shot = screenshot.resize((int(screenshot.width * scale), target_h),
                                 Image.LANCZOS)
        frame = make_card(shot, radius=12, shadow=22)
        canvas.paste(frame, (width - frame.width - 56, (height - frame.height) // 2),
                     frame)
    return canvas


def make_social(banner: Image.Image, width: int = 1280, height: int = 640) -> Image.Image:
    canvas = Image.new('RGBA', (width, height), (16, 17, 21, 255))
    scaled = banner.resize((width, int(banner.height * width / banner.width)),
                           Image.LANCZOS)
    y = (height - scaled.height) // 2
    glow = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((-300, -420, 780, 420), fill=(*ACCENT, 60))
    glow = glow.filter(ImageFilter.GaussianBlur(220))
    canvas = Image.alpha_composite(canvas, glow)
    canvas.paste(scaled, (0, y), scaled)
    return canvas


# --------------------------------------------------------------------------- #

def main() -> int:
    captures = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'qa' / 'out' / 'capture-all' / 'raw'
    ASSETS.mkdir(parents=True, exist_ok=True)

    icon = make_icon(512)
    icon.save(ASSETS / 'icon.png')
    logo = make_icon(256)
    logo.save(ASSETS / 'logo.png')

    panels = {
        'quick-settings': (868, 38, 1272, 236),
        'menu-peak': (868, 38, 1272, 560),
        'menu-expanded': (868, 38, 1272, 692),
        'tile-temperature': (868, 38, 1272, 236),
    }
    frames = {
        'quick-settings': '02-menu-peak.png',
        'menu-peak': '02-menu-peak.png',
        'menu-expanded': '03-menu-expanded.png',
        'tile-temperature': '04-tile-temperature.png',
    }
    for name, box in panels.items():
        path = captures / frames[name]
        if not path.exists():
            print(f'missing capture {path}', file=sys.stderr)
            continue
        shot = crop_frame(path, box)
        make_card(shot).save(ASSETS / f'{name}.png')

    # Localized capture of the same menu: proof that the catalogue is wired up
    # inside the packaged bundle, not just present in po/.
    localized = ROOT / 'qa' / 'out' / 'capture-menus' / 'raw' / 'menu.png'
    if localized.exists():
        make_card(crop_frame(localized, panels['menu-peak'])).save(ASSETS / 'menu-es.png')

    prefs = captures / '05-preferences.png'
    if prefs.exists():
        frame = Image.open(prefs).convert('RGBA')
        # The window geometry comes from the QA session log; the fallback is the
        # placement mutter uses for the runner's window in the capture session.
        x0, y0, x1, y1 = prefs_window_box(captures.parent / 'qa-session.log',
                                          (346, 139, 934, 714))
        margin = 3
        shot = frame.crop((max(0, x0 - margin), max(0, y0 - margin),
                           min(frame.width, x1 + margin),
                           min(frame.height, y1 + margin)))
        make_card(shot, radius=12, shadow=20).save(ASSETS / 'preferences.png')

    hero_capture = ASSETS / 'menu-peak.png'
    screenshot = Image.open(hero_capture).convert('RGBA') if hero_capture.exists() else None
    banner = make_banner(1600, 460, screenshot)
    banner.convert('RGB').save(ASSETS / 'banner.png')
    make_social(banner).convert('RGB').save(ASSETS / 'social-preview.png')

    series = sorted(captures.glob('fan-curve-*.png'))
    if series:
        box = (868, 38, 1272, 560)
        gif_frames = [crop_frame(p, box).convert('RGB') for p in series]
        palette = gif_frames[0].convert('P', palette=Image.ADAPTIVE, colors=128)
        quantized = [frame.quantize(palette=palette, dither=Image.NONE)
                     for frame in gif_frames]
        quantized[0].save(ASSETS / 'live-readings.gif', save_all=True,
                          append_images=quantized[1:], duration=700, loop=0,
                          optimize=True, disposal=2)

    for name in ['icon.png', 'logo.png', 'banner.png', 'social-preview.png',
                 'quick-settings.png', 'menu-peak.png', 'menu-expanded.png',
                 'tile-temperature.png', 'menu-es.png', 'preferences.png',
                 'live-readings.gif']:
        path = ASSETS / name
        if path.exists():
            print(f'{path.relative_to(ROOT)}  {path.stat().st_size // 1024} KiB')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
