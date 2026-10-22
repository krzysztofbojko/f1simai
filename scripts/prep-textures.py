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
from PIL import Image, ImageFilter

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
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
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

    # Sky: equirectangular, must wrap around the horizon.
    save(seamless(load('sky_day_raw.jpg'), 1, 0.06), 'sky_day.webp', (2048, 1024), 90)


if __name__ == '__main__':
    main()
