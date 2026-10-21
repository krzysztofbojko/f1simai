import * as THREE from 'three';

export interface Point2 { x: number; y: number }

/**
 * Simulation plane (x, y) in metres maps to Three.js (x, height, y): the ground is y = 0 and
 * the 2D view's "down the screen" is +z, so a straight top view looks like the old canvas.
 */
export function toWorld(p: Point2, height = 0, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(p.x, height, p.y);
}

/**
 * A flat strip between two edge polylines of equal length (e.g. left edge and grass edge).
 * u runs along the strip in metres (measured on the first edge), v across it in metres,
 * so textures repeat at a fixed real-world size.
 */
export function stripGeometry(inner: Point2[], outer: Point2[], height: number, closed: boolean, vMetres = true): THREE.BufferGeometry {
  const n = inner.length, rows = closed ? n + 1 : n;
  const pos = new Float32Array(rows * 2 * 3), uv = new Float32Array(rows * 2 * 2), nrm = new Float32Array(rows * 2 * 3);
  let u = 0;
  for (let r = 0; r < rows; r++) {
    const i = r % n, a = inner[i], b = outer[i];
    if (r > 0) { const p = inner[(r - 1) % n]; u += Math.hypot(a.x - p.x, a.y - p.y); }
    const across = vMetres ? Math.hypot(b.x - a.x, b.y - a.y) : 1;
    pos.set([a.x, height, a.y, b.x, height, b.y], r * 6);
    uv.set([u, 0, u, across], r * 4);
    nrm.set([0, 1, 0, 0, 1, 0], r * 6);
  }
  const index: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
    index.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}

/**
 * Offsets a centre polyline by ±halfWidth into the two edges of a ribbon, with mitred joints
 * (miter length clamped so hairpins do not spike).
 */
export function offsetPolyline(points: Point2[], halfWidth: number, closed: boolean): [Point2[], Point2[]] {
  const n = points.length, left: Point2[] = [], right: Point2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    let tx = next.x - prev.x, ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    // Miter: the offset grows by 1 / cos of the half-angle between the incoming segment and the tangent.
    const cur = points[i];
    const ix = cur.x - prev.x, iy = cur.y - prev.y;
    const il = Math.hypot(ix, iy);
    const scale = il > 1e-6 ? 1 / Math.max(0.5, (ix * tx + iy * ty) / il) : 1;
    const nx = -ty * halfWidth * scale, ny = tx * halfWidth * scale;
    left.push({ x: cur.x + nx, y: cur.y + ny });
    right.push({ x: cur.x - nx, y: cur.y - ny });
  }
  return [left, right];
}

/**
 * Writes a polyline ribbon into preallocated attribute arrays (positions + optional colours)
 * and returns the index count to draw. Used for lines that change every frame.
 */
export class DynamicRibbon {
  readonly geometry = new THREE.BufferGeometry();
  private pos: Float32Array;
  private uv: Float32Array;
  private col: Float32Array;
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.pos = new Float32Array(0); this.uv = new Float32Array(0); this.col = new Float32Array(0);
    this.allocate(capacity);
  }

  private allocate(capacity: number): void {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 2 * 3);
    this.uv = new Float32Array(capacity * 2 * 2);
    this.col = new Float32Array(capacity * 2 * 3).fill(1);
    const index = new Uint32Array((capacity - 1) * 6);
    for (let r = 0; r < capacity - 1; r++) {
      const a = r * 2;
      index.set([a, a + 2, a + 1, a + 1, a + 2, a + 3], r * 6);
    }
    const nrm = new Float32Array(capacity * 2 * 3);
    for (let i = 0; i < capacity * 2; i++) nrm[i * 3 + 1] = 1;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
  }

  /**
   * Rebuilds the ribbon along `points`; `color(i)` may return an [r, g, b] (linear) per point.
   * Closing appends the first point again.
   */
  set(points: Point2[], halfWidth: number, height: number, closed = false, color?: (i: number) => THREE.Color): void {
    const n = points.length, rows = closed ? n + 1 : n;
    if (n < 2) { this.geometry.setDrawRange(0, 0); return; }
    if (rows > this.capacity) this.allocate(Math.ceil(rows * 1.5));
    const [l, r] = offsetPolyline(points, halfWidth, closed);
    let u = 0;
    for (let row = 0; row < rows; row++) {
      const i = row % n;
      if (row > 0) { const p = points[(row - 1) % n], c = points[i]; u += Math.hypot(c.x - p.x, c.y - p.y); }
      const o = row * 6;
      this.pos[o] = l[i].x; this.pos[o + 1] = height; this.pos[o + 2] = l[i].y;
      this.pos[o + 3] = r[i].x; this.pos[o + 4] = height; this.pos[o + 5] = r[i].y;
      this.uv[row * 4] = u; this.uv[row * 4 + 1] = 0; this.uv[row * 4 + 2] = u; this.uv[row * 4 + 3] = 1;
      if (color) {
        const c = color(i);
        this.col[o] = this.col[o + 3] = c.r; this.col[o + 1] = this.col[o + 4] = c.g; this.col[o + 2] = this.col[o + 5] = c.b;
      }
    }
    for (const name of ['position', 'uv', 'color'] as const) this.geometry.getAttribute(name).needsUpdate = true;
    this.geometry.setDrawRange(0, (rows - 1) * 6);
    this.geometry.computeBoundingSphere();
  }

  clear(): void { this.geometry.setDrawRange(0, 0); }
}
