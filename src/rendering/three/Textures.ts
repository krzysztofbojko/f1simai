import * as THREE from 'three';

/**
 * Textures: every map is first painted with the Canvas 2D API, so the scene renders at once and
 * without any files. Surfaces with a generated image in public/textures (see
 * scripts/prep-textures.py) swap it in when it loads; the procedural map stays as the fallback.
 * A fixed-seed generator keeps the procedural surfaces identical between reloads.
 */

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!];
}

/** Colour maps are sRGB; data maps (roughness, alpha) stay linear. */
function texture(c: HTMLCanvasElement, color: boolean, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

const imageLoader = new THREE.ImageLoader();
const textureUrl = (file: string) => `${import.meta.env.BASE_URL}textures/${file}`;

/**
 * Replaces the texture's image once `file` loads; clones share the source, so they follow too.
 * The GPU copy is released first: an uploaded texture has fixed storage and cannot change size.
 */
function upgrade<T extends THREE.Texture>(t: T, file: string): T {
  imageLoader.load(textureUrl(file), image => { t.dispose(); t.image = image; t.needsUpdate = true; });
  return t;
}

/** Grain noise: `count` specks of random size and brightness around the base colour. */
function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number, count: number, rgb: [number, number, number], spread: number, maxSize: number): void {
  for (let i = 0; i < count; i++) {
    const k = (rand() - 0.5) * spread;
    ctx.fillStyle = `rgb(${rgb[0] + k | 0},${rgb[1] + k | 0},${rgb[2] + k | 0})`;
    const s = 0.5 + rand() * maxSize;
    ctx.fillRect(rand() * w, rand() * h, s, s);
  }
}

export interface SurfaceMaps { map: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture }

export class Textures {
  /** Asphalt: fine aggregate on dark bitumen, with a roughness map that polishes the darker binder. */
  static asphalt(): SurfaceMaps {
    const size = 512, rand = seeded(11);
    const [c, ctx] = canvas(size, size);
    ctx.fillStyle = '#2a2b2f';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 18; i++) {
      const g = ctx.createRadialGradient(rand() * size, rand() * size, 0, rand() * size, rand() * size, 60 + rand() * 120);
      g.addColorStop(0, `rgba(${rand() < 0.5 ? '0,0,0' : '70,70,74'},0.12)`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
    speckle(ctx, size, size, rand, 26000, [52, 53, 57], 40, 1.6);
    speckle(ctx, size, size, rand, 1800, [92, 92, 96], 50, 1.2);

    const [r, rctx] = canvas(size, size);
    const src = ctx.getImageData(0, 0, size, size), dst = rctx.createImageData(size, size);
    for (let i = 0; i < src.data.length; i += 4) {
      // Bright aggregate is rougher than the binder around it.
      const v = Math.min(255, 175 + src.data[i] * 0.9);
      dst.data[i] = dst.data[i + 1] = dst.data[i + 2] = v; dst.data[i + 3] = 255;
    }
    rctx.putImageData(dst, 0, 0);
    return { map: upgrade(texture(c, true), 'asphalt.webp'), roughnessMap: upgrade(texture(r, false), 'asphalt_rough.webp') };
  }

  /** Mown grass: alternating bands with blade noise. */
  static grass(file = 'grass.webp'): THREE.CanvasTexture {
    const size = 256, rand = seeded(23);
    const [c, ctx] = canvas(size, size);
    for (let band = 0; band < 4; band++) {
      ctx.fillStyle = band % 2 ? '#3d5a2c' : '#456533';
      ctx.fillRect(0, band * size / 4, size, size / 4);
    }
    speckle(ctx, size, size, rand, 9000, [64, 92, 46], 34, 1.4);
    return upgrade(texture(c, true), file);
  }

  /** Rough ground beyond the circuit: patchy grass and dirt (the procedural fallback is the grass). */
  static ground(): THREE.CanvasTexture {
    return Textures.grass('ground.webp');
  }

  /** Gravel trap: sandy base with pebbles. */
  static gravel(): THREE.CanvasTexture {
    const size = 256, rand = seeded(37);
    const [c, ctx] = canvas(size, size);
    ctx.fillStyle = '#8f7d58';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, size, size, rand, 14000, [150, 133, 100], 60, 2.2);
    for (let i = 0; i < 600; i++) {
      const k = 120 + rand() * 80 | 0;
      ctx.fillStyle = `rgb(${k},${k - 14},${k - 40})`;
      ctx.beginPath();
      ctx.ellipse(rand() * size, rand() * size, 1 + rand() * 2.4, 0.8 + rand() * 1.8, rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    return upgrade(texture(c, true), 'gravel.webp');
  }

  /** Kerb: one red and one white block along u, with worn paint at the block edges. */
  static kerb(): THREE.CanvasTexture {
    const [c, ctx] = canvas(128, 32);
    ctx.fillStyle = '#d40500'; ctx.fillRect(0, 0, 64, 32);
    ctx.fillStyle = '#f2f2f2'; ctx.fillRect(64, 0, 64, 32);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, 128, 3); ctx.fillRect(0, 29, 128, 3);
    ctx.fillRect(62, 0, 4, 32); ctx.fillRect(126, 0, 2, 32);
    return upgrade(texture(c, true), 'kerb.webp');
  }

  /** Energy-absorbing barrier blocks: blue and white panels with a red top band. */
  static barrier(): THREE.CanvasTexture {
    const [c, ctx] = canvas(256, 64);
    ctx.fillStyle = '#1d4fa8'; ctx.fillRect(0, 0, 128, 64);
    ctx.fillStyle = '#e9edf2'; ctx.fillRect(128, 0, 128, 64);
    ctx.fillStyle = '#c4161c'; ctx.fillRect(0, 0, 256, 10);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(126, 0, 4, 64); ctx.fillRect(0, 60, 256, 4);
    return upgrade(texture(c, true), 'barrier.webp');
  }

  /** Chequered start/finish strip: two rows of squares along u. */
  static checker(): THREE.CanvasTexture {
    const [c, ctx] = canvas(64, 32);
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 2; y++) {
        ctx.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
        ctx.fillRect(x * 16, y * 16, 16, 16);
      }
    }
    const t = texture(c, true);
    t.magFilter = THREE.NearestFilter;
    return t;
  }

  /** Dashes along u for painted lines and timing beams (alpha only, colour comes from the material). */
  static dashes(): THREE.CanvasTexture {
    const [c, ctx] = canvas(64, 4);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 36, 4);
    return texture(c, true);
  }

  /** Dashed ring around the selected car, 24 dashes over the circle. */
  static dashedRing(): THREE.CanvasTexture {
    const [c, ctx] = canvas(256, 256);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 18;
    for (let i = 0; i < 24; i++) {
      ctx.beginPath();
      ctx.arc(128, 128, 116, i / 24 * Math.PI * 2, (i + 0.55) / 24 * Math.PI * 2);
      ctx.stroke();
    }
    return texture(c, false, false);
  }

  /** Soft round particle sprite. */
  static softDot(): THREE.CanvasTexture {
    const [c, ctx] = canvas(64, 64);
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    return texture(c, false, false);
  }

  /** Tyre sidewall: dark rubber with a compound-coloured ring (planar ring UVs, centre at 0.5). */
  static sidewall(): THREE.CanvasTexture {
    const [c, ctx] = canvas(256, 256);
    ctx.fillStyle = '#151517'; ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#d8231f'; ctx.lineWidth = 9;
    ctx.beginPath(); ctx.arc(128, 128, 104, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#e8e8e8'; ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'center';
    for (let i = 0; i < 2; i++) {
      ctx.save(); ctx.translate(128, 128); ctx.rotate(i * Math.PI);
      ctx.fillText('P ZERO', 0, -112); ctx.restore();
    }
    return texture(c, true, false);
  }

  /** Wheel rim face with spokes, so the wheel's rotation is visible. */
  static rim(): THREE.CanvasTexture {
    const [c, ctx] = canvas(128, 128);
    ctx.fillStyle = '#1b1c1f'; ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = '#9aa1ab'; ctx.lineWidth = 7;
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(64, 64); ctx.lineTo(64 + Math.cos(a) * 60, 64 + Math.sin(a) * 60); ctx.stroke();
    }
    ctx.strokeStyle = '#c9ced6'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(64, 64, 58, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#d8b13a'; ctx.beginPath(); ctx.arc(64, 64, 9, 0, Math.PI * 2); ctx.fill();
    return texture(c, true, false);
  }

  /** Pit box marker painted on the asphalt. */
  static pitBox(): THREE.CanvasTexture {
    const [c, ctx] = canvas(128, 128);
    ctx.fillStyle = 'rgba(255,215,0,0.28)';
    ctx.beginPath(); ctx.arc(64, 64, 58, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 7; ctx.stroke();
    ctx.fillStyle = '#ffd700'; ctx.font = 'bold 72px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('P', 64, 68);
    return texture(c, true, false);
  }

  /** Equirectangular sky panorama for the background and reflections, delivered once it loads. */
  static skyPanorama(onLoad: (sky: THREE.Texture) => void): void {
    new THREE.TextureLoader().load(textureUrl('sky_day.webp'), sky => {
      sky.mapping = THREE.EquirectangularReflectionMapping;
      sky.colorSpace = THREE.SRGBColorSpace;
      onLoad(sky);
    });
  }

  /** Sky dome gradient for the low cameras until the panorama loads. */
  static sky(): THREE.CanvasTexture {
    const [c, ctx] = canvas(4, 256);
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#3e6fa8');
    g.addColorStop(0.55, '#9cc0e0');
    g.addColorStop(1, '#dfe8ee');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 256);
    return texture(c, true, false);
  }
}
