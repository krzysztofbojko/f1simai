#!/usr/bin/env python3
"""
Turns the raw Gemini images in assets/generated/ into game textures in public/textures/.

Generated images rarely tile perfectly, so each axis that must repeat is made seamless by
cross-fading the borders with a copy rolled by half a tile (the copy is continuous where the
original wraps). Roughness maps are derived from albedo luminance.

Usage: python3 scripts/prep-textures.py
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'assets' / 'generated'
OUT = ROOT / 'public' / 'textures'


def seamless(a: np.ndarray, axis: int, band: float = 0.18) -> np.ndarray:
    """Cross-fades the borders along `axis` with the half-rolled image, so it wraps without a seam."""
    n = a.shape[axis]
    t = np.abs(np.arange(n) / (n - 1) - 0.5) * 2  # 0 at the centre, 1 at both borders
    w = np.clip((t - (1 - 2 * band)) / (2 * band), 0, 1)
    w = w * w * (3 - 2 * w)
    shape = [1] * a.ndim
    shape[axis] = n
    w = w.reshape(shape)
    return a * (1 - w) + np.roll(a, n // 2, axis=axis) * w


def load(name: str) -> np.ndarray:
    return np.asarray(Image.open(SRC / name).convert('RGB'), dtype=np.float32)


def save(a: np.ndarray, name: str, size: tuple[int, int], quality: int = 88) -> None:
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))  # RGB or RGBA
    img = img.resize(size, Image.LANCZOS)
    img.save(OUT / name, 'WEBP', quality=quality, method=6)
    print(f'{name:22s} {size[0]}x{size[1]}  {(OUT / name).stat().st_size // 1024} KB')


def roughness(a: np.ndarray) -> np.ndarray:
    """Bright aggregate is rougher than the polished dark binder (same rule as the procedural map)."""
    lum = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    lum = (lum - lum.min()) / max(1.0, lum.max() - lum.min()) * 255
    r = np.clip(175 + lum * 0.32, 0, 255)
    return np.repeat(r[..., None], 3, axis=2)


def flatten(a: np.ndarray, radius: float, keep: float) -> np.ndarray:
    """Keeps only `keep` of the large-scale tone variation, so big tiles do not read as a grid."""
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    low = np.asarray(img.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32)
    return a - low * (1 - keep) + low.reshape(-1, 3).mean(0) * (1 - keep)


def cutout(a: np.ndarray, flood: bool) -> np.ndarray:
    """
    RGBA from an image on a plain white backdrop. `flood` clears only the white connected to the
    top corners (keeps white parts of the subject, like a roof); otherwise every white pixel goes.
    The edge is pulled in a pixel and softened, so no white halo is left.
    """
    white = (a.min(axis=2) > 222) & (np.ptp(a, axis=2) < 30)
    if flood:
        m = Image.fromarray(white.astype(np.uint8) * 255).copy()  # a numpy-backed image ignores floodfill
        for corner in [(0, 0), (m.width - 1, 0)]:
            ImageDraw.floodfill(m, corner, 128)
        white = np.asarray(m) == 128
    alpha = Image.fromarray((~white).astype(np.uint8) * 255).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.7))
    rgba = np.dstack([a, np.asarray(alpha, dtype=np.float32)])
    ys, xs = np.nonzero(rgba[..., 3] > 8)
    return rgba[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    # Asphalt: tyre marks run along the image's y; the strip's u (along the track) is the texture's x.
    asphalt = np.rot90(seamless(seamless(load('asphalt_raw.jpg'), 0, 0.1), 1, 0.1))
    save(asphalt, 'asphalt.webp', (1024, 1024))
    save(roughness(asphalt), 'asphalt_rough.webp', (512, 512), 80)

    # Grass came out as two stacked copies: the top half already wraps vertically.
    grass = load('grass_raw.jpg')
    grass = seamless(seamless(grass[:grass.shape[0] // 2], 0, 0.25), 1)
    save(grass, 'grass.webp', (1024, 512))

    # Ground: the generator drew a strip of track at the right edge, so only the field is kept.
    ground = seamless(seamless(load('ground_raw.jpg')[:900, :900], 0), 1)
    save(flatten(ground, 40, 0.25), 'ground.webp', (1024, 1024))
    save(seamless(seamless(load('gravel_raw.jpg'), 0), 1), 'gravel.webp', (1024, 1024))

    # Kerb: two red/white pairs along u, across the strip along v; the pattern itself wraps.
    save(load('kerb_raw.jpg'), 'kerb.webp', (1024, 512))

    # Barrier: one 3 m x 1 m panel, repeating along the wall only.
    save(seamless(load('barrier_raw.jpg'), 1, 0.08), 'barrier.webp', (1536, 512))

    # Same wall with invented sponsors on the top band; the panel edges line up when it repeats.
    save(load('barrier_ads_raw.jpg'), 'barrier_ads.webp', (1536, 512))

    # Skies: equirectangular, must wrap around the horizon.
    for sky in ['day', 'overcast', 'night']:
        save(seamless(load(f'sky_{sky}_raw.jpg'), 1, 0.06), f'sky_{sky}.webp', (2048, 1024), 90)

    # Billboards with alpha; their aspect sets the size in the scene (see TrackMesh).
    for name, flood in [('trees', False), ('grandstand', True)]:
        a = cutout(load(f'{name}_raw.jpg'), flood)
        save(a, f'{name}.webp', (2048, round(2048 * a.shape[0] / a.shape[1])))

    # Street circuits: the generated skyline included a road at the bottom; it stops at the building line.
    for name in ['city_day', 'city_night']:
        city = load(f'{name}_raw.jpg')
        a = cutout(city[:int(city.shape[0] * 0.84)], True)
        save(a, f'{name}.webp', (2048, round(2048 * a.shape[0] / a.shape[1])))

    # Seen from the top camera: tree crowns (alpha) behind the tree line, rooftops behind the
    # skyline and the grandstand roof; all repeat along u.
    a = cutout(load('canopy_raw.jpg'), False)
    save(seamless(a, 1, 0.08), 'canopy.webp', (2048, round(2048 * a.shape[0] / a.shape[1])))
    save(seamless(load('rooftops_raw.jpg'), 1, 0.08), 'rooftops.webp', (2048, 512))
    save(seamless(load('stand_roof_raw.jpg'), 1, 0.05), 'stand_roof.webp', (2048, 512))

    # Wheel faces: planar UVs with the circle filling the square.
    # The tyre sits on a grey backdrop with some margin: crop to the square around the dark rubber.
    tyre = load('sidewall_raw.jpg')
    ys, xs = np.nonzero(tyre.max(axis=2) < 110)
    cy, cx, r = (ys.min() + ys.max()) // 2, (xs.min() + xs.max()) // 2, max(np.ptp(ys), np.ptp(xs)) // 2
    save(tyre[cy - r:cy + r, cx - r:cx + r], 'sidewall.webp', (512, 512))
    save(load('rim_raw.jpg'), 'rim.webp', (512, 512))

    # App icon: the rounded square without its white surround.
    logo = cutout(load('logo_raw.jpg'), True)
    for size in [64, 256]:
        Image.fromarray(np.clip(logo, 0, 255).astype(np.uint8)).resize((size, size), Image.LANCZOS).save(OUT.parent / f'logo-{size}.png')


if __name__ == '__main__':
    main()
