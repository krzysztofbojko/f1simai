import type { Track } from './Track';
import { Vector2 } from '../math/Vector2';

/** Signed curvature (1/m) of the circle through three points. */
function menger(a: Vector2, b: Vector2, c: Vector2): number {
  const abx = b.x - a.x, aby = b.y - a.y, bcx = c.x - b.x, bcy = c.y - b.y, acx = c.x - a.x, acy = c.y - a.y;
  const denominator = Math.hypot(abx, aby) * Math.hypot(bcx, bcy) * Math.hypot(acx, acy);
  return denominator > 1e-6 ? 2 * (abx * bcy - aby * bcx) / denominator : 0;
}

/**
 * Projected Gauss-Seidel on Σ w_k |p_{k-1} - 2 p_k + p_{k+1}|² with p_k = c_k + n_k α_k and
 * lo_k ≤ α_k ≤ hi_k: the discrete minimum-curvature line inside the white lines.
 */
function relax(c: Vector2[], n: Vector2[], lo: number[], hi: number[], w: number[], alpha: number[], iterations: number): void {
  const m = c.length;
  const px = new Float64Array(m), py = new Float64Array(m);
  for (let k = 0; k < m; k++) { px[k] = c[k].x + n[k].x * alpha[k]; py[k] = c[k].y + n[k].y * alpha[k]; }
  const at = (k: number) => (k % m + m) % m;
  const dx = (k: number) => { const a = at(k); return px[at(a - 1)] - 2 * px[a] + px[at(a + 1)]; };
  const dy = (k: number) => { const a = at(k); return py[at(a - 1)] - 2 * py[a] + py[at(a + 1)]; };
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < m; i++) {
      const wp = w[at(i - 1)], wi = w[i], wn = w[at(i + 1)];
      const gx = wp * dx(i - 1) - 2 * wi * dx(i) + wn * dx(i + 1);
      const gy = wp * dy(i - 1) - 2 * wi * dy(i) + wn * dy(i + 1);
      const step = 1.5 * (gx * n[i].x + gy * n[i].y) / (wp + 4 * wi + wn);
      const next = Math.max(lo[i], Math.min(hi[i], alpha[i] - step));
      const moved = next - alpha[i];
      alpha[i] = next;
      px[i] += n[i].x * moved; py[i] += n[i].y * moved;
    }
  }
}

/**
 * The racing line of a circuit: a lateral offset from the centreline at every track point, solved
 * once as the minimum-curvature path between the white lines (outside on entry, the inside kerb at
 * the apex, outside again on exit, compromises through chicanes and esses). Corners that open onto
 * a straight are weighted toward a straight exit, which turns them into late-apex corners;
 * `lateness` is the driver's taste for that (0 = geometric apex).
 */
export class RacingLine {
  /** Half a car plus a hand's width: at the apex the inside wheels run along the kerb. */
  static readonly INSIDE_MARGIN = 1.05;
  /** On the outside the car stays clear of the white line (and of the grass behind it). */
  static readonly OUTSIDE_MARGIN = 1.5;
  /** Far from any corner there is nothing to gain at the edge: the line keeps this much room. */
  static readonly STRAIGHT_MARGIN = 2.3;
  /** Metres (each way) searched for a corner before a point counts as part of a straight. */
  static readonly STRAIGHT_WINDOW = 108;
  /** Metres after a corner's last point over which its exit keeps the extra weight. */
  static readonly EXIT_RUN = 54;
  /** Metres between the three points of each arc the line's curvature is read from. */
  static readonly ARC_BASE = 6;
  /** Grid (m) the line's shape is solved on before it is carried to every track point. */
  static readonly DETAIL_LEVEL = 18;
  /** Sweeps at full resolution: they settle the line onto the bounds between the grid points. */
  static readonly FINE_SWEEPS = 100;
  /**
   * Grids (m) between DETAIL_LEVEL and full resolution, and their sweeps: a corner shorter than the
   * detail grid is shaped here; the full-resolution sweeps alone only smooth it locally. A 3 m level
   * as well opened hairpins a little more but kept some lines off the apex of wider corners.
   */
  static readonly MID_LEVELS = [9] as const;
  static readonly MID_SWEEPS = 1500;
  /**
   * The sum of squared curvature tolerates a short, very tight arc for gentler ones around it, but
   * the tightest arc sets the corner speed. One more solve weighs each point by (κ·PEAK_RADIUS)² of
   * the tightest line curvature within PEAK_REACH metres, which opens arcs tighter than PEAK_RADIUS
   * and leaves wider corners to the plain solve.
   */
  static readonly PEAK_RADIUS = 30;
  static readonly PEAK_REACH = 10;
  static readonly PEAK_WEIGHT_MAX = 50;
  /** Smoothed centreline curvature (1/m) that marks a corner: its inside gets the kerb margin. */
  static readonly CORNER_CURVATURE = 0.003;
  /** Curvature that counts as a corner to brake, attack or defend for. */
  static readonly BRAKING_CORNER = 0.006;
  /** Extra weight on a corner's exit curvature at full lateness after a long straight. */
  static readonly LATE_APEX_GAIN = 3;
  static readonly STYLES = [0.2, 0.6, 1] as const;

  readonly offsets: Float64Array;
  readonly lower: Float64Array;
  readonly upper: Float64Array;
  /** Signed curvature of the line itself (positive turns toward +normal). */
  readonly curvature: Float64Array;
  /** Distance along the centreline to the next braking corner (0 inside one) and the way it turns. */
  readonly cornerDistance: Float64Array;
  readonly cornerSign: Int8Array;

  constructor(private readonly track: Track, readonly lateness = 0.6) {
    const points = track.points, n = points.length, half = track.width / 2;
    const smooth = Array.from(track.smoothedCurvature);
    const window = track.pointsFor(RacingLine.STRAIGHT_WINDOW);
    this.lower = new Float64Array(n);
    this.upper = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const inside = Math.abs(smooth[i]) > RacingLine.CORNER_CURVATURE ? Math.sign(smooth[i]) : 0;
      let nearest = 0;
      for (let d = -window; d <= window; d++) nearest = Math.max(nearest, Math.abs(smooth[(i + d + n) % n]));
      const straightness = Math.max(0, Math.min(1, 1 - nearest / (1.5 * RacingLine.CORNER_CURVATURE)));
      const outside = RacingLine.OUTSIDE_MARGIN + (RacingLine.STRAIGHT_MARGIN - RacingLine.OUTSIDE_MARGIN) * straightness;
      this.upper[i] = Math.max(0, half - (inside > 0 ? RacingLine.INSIDE_MARGIN : outside));
      this.lower[i] = -Math.max(0, half - (inside < 0 ? RacingLine.INSIDE_MARGIN : outside));
    }
    const weights = this.exitWeights(smooth);
    this.offsets = this.solve(weights);
    this.curvature = new Float64Array(n);
    this.measureCurvature();
    this.offsets.set(this.solve(this.peakWeights(weights)));
    this.measureCurvature();
    this.cornerDistance = new Float64Array(n).fill(Infinity);
    this.cornerSign = new Int8Array(n);
    // Two backward sweeps carry the next corner around the start/finish line.
    for (let pass = 0; pass < 2; pass++) for (let j = 2 * n - 1; j >= 0; j--) {
      const i = j % n, next = (i + 1) % n;
      if (Math.abs(smooth[i]) > RacingLine.BRAKING_CORNER) { this.cornerDistance[i] = 0; this.cornerSign[i] = Math.sign(smooth[i]); continue; }
      const via = this.cornerDistance[next] + points[i].center.dist(points[next].center);
      if (via < this.cornerDistance[i]) { this.cornerDistance[i] = via; this.cornerSign[i] = this.cornerSign[next]; }
    }
  }

  private measureCurvature(): void {
    const base = this.track.pointsFor(RacingLine.ARC_BASE);
    for (let i = 0; i < this.curvature.length; i++) this.curvature[i] = menger(this.point(i - base), this.point(i), this.point(i + base));
  }

  /** `weights` raised around the tightest arcs of the current line (see PEAK_RADIUS). */
  private peakWeights(weights: number[]): number[] {
    const n = weights.length, reach = this.track.pointsFor(RacingLine.PEAK_REACH);
    const tight = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let d = -reach; d <= reach; d++) peak = Math.max(peak, Math.abs(this.curvature[(i + d + n) % n]));
      tight[i] = peak * RacingLine.PEAK_RADIUS;
    }
    return weights.map((w, i) => w * Math.max(1, Math.min(RacingLine.PEAK_WEIGHT_MAX, tight[i] * tight[i])));
  }

  /** Corner runs leading onto a straight weigh their exit curvature more: a later, tighter apex and a straight exit. */
  private exitWeights(smooth: number[]): number[] {
    const points = this.track.points, n = points.length;
    const weights = new Array<number>(n).fill(1);
    if (this.lateness <= 0) return weights;
    const inCorner = smooth.map(k => Math.abs(k) > RacingLine.CORNER_CURVATURE);
    const start = inCorner.findIndex(c => !c);
    if (start < 0) return weights;
    const spacing = (i: number) => points[i % n].center.dist(points[(i + 1) % n].center);
    const exitRun = this.track.pointsFor(RacingLine.EXIT_RUN);
    for (let j = start; j < start + n; j++) {
      if (!inCorner[j % n] || inCorner[(j - 1) % n]) continue;
      let end = j;
      while (inCorner[(end + 1) % n] && end - j < n) end++;
      let straight = 0;
      for (let k = end + 1; !inCorner[k % n] && k < end + n; k++) straight += spacing(k);
      const gain = RacingLine.LATE_APEX_GAIN * this.lateness * Math.max(0, Math.min(1, (straight - 100) / 600));
      const length = Math.max(1, end - j);
      for (let k = j; k <= end + exitRun; k++) weights[k % n] = Math.max(weights[k % n], 1 + gain * Math.min(1, (k - j) / length));
      j = end;
    }
    return weights;
  }

  /**
   * Coarse-to-fine: the shape is solved on a grid of DETAIL_LEVEL metres and its coarser levels
   * (the sweeps those levels need do not converge on a finer grid, where the line would settle on a
   * different shape), then carried to every track point by a Catmull-Rom spline and smoothed there.
   */
  private solve(weights: number[]): Float64Array {
    const points = this.track.points, n = points.length, detail = this.track.pointsFor(RacingLine.DETAIL_LEVEL);
    let alpha: number[] | null = null, previous: number[] = [];
    const levels = [8, 4, 2, 1].map(k => ({ stride: k * detail, sweeps: k > 1 ? 400 * k : 600 }));
    for (const metres of RacingLine.MID_LEVELS) {
      const stride = this.track.pointsFor(metres);
      if (stride > 1 && stride < detail) levels.push({ stride, sweeps: RacingLine.MID_SWEEPS });
    }
    if (detail > 1) levels.push({ stride: 1, sweeps: RacingLine.FINE_SWEEPS });
    for (const { stride, sweeps } of levels) {
      // Spread evenly around the whole loop: the solver assumes equal spans, the closing one included.
      const m = Math.round(n / stride);
      if (m < 12 && stride > 1) continue;
      const index = Array.from({ length: m }, (_, k) => Math.round(k * n / m));
      const level = index.map(i => {
        if (!alpha) return 0;
        // Catmull-Rom through the coarser level, across the span that holds this point.
        const c = alpha.length;
        let k = Math.min(c - 1, Math.floor(i * c / n));
        while (k > 0 && previous[k] > i) k--;
        while (k + 1 < c && previous[k + 1] <= i) k++;
        const at = previous[k], t = (i - at) / ((k + 1 < c ? previous[k + 1] : n) - at);
        const a = alpha[(k - 1 + c) % c], b = alpha[k], d = alpha[(k + 1) % c], e = alpha[(k + 2) % c];
        const t2 = t * t, t3 = t2 * t;
        const value = 0.5 * (2 * b + (d - a) * t + (2 * a - 5 * b + 4 * d - e) * t2 + (3 * b - a - 3 * d + e) * t3);
        return Math.max(this.lower[i], Math.min(this.upper[i], value));
      });
      relax(index.map(i => points[i].center), index.map(i => points[i].tangent.normal()),
        index.map(i => this.lower[i]), index.map(i => this.upper[i]), index.map(i => weights[i]), level, sweeps);
      alpha = level;
      previous = index;
    }
    return Float64Array.from(alpha!);
  }

  /** The line's lateral offset at `fraction` of the way from track point `index` to the next. */
  offsetAt(index: number, fraction = 0): number {
    const n = this.offsets.length, i = (index % n + n) % n;
    return this.offsets[i] * (1 - fraction) + this.offsets[(i + 1) % n] * fraction;
  }

  /** Bounds of the line at a point: the white lines minus the inside/outside margins. */
  limits(index: number): { lower: number; upper: number } {
    const n = this.offsets.length, i = (index % n + n) % n;
    return { lower: this.lower[i], upper: this.upper[i] };
  }

  point(index: number): Vector2 {
    const n = this.offsets.length, i = (index % n + n) % n, p = this.track.points[i];
    return p.center.add(p.tangent.normal().mul(this.offsets[i]));
  }

  /**
   * Speed the line allows at every point for a friction coefficient `mu` and downforce `aeroPerV2`
   * (m/s² per (m/s)²): the steady cornering limit, then backward passes for braking at `brake` g.
   */
  speedProfile(mu: number, aeroPerV2: number, brake: number, maxSpeed = 95): Float64Array {
    const n = this.offsets.length, g = 9.81, v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const room = Math.abs(this.curvature[i]) - mu * aeroPerV2;
      v[i] = room > 0 ? Math.min(maxSpeed, Math.sqrt(mu * g / room)) : maxSpeed;
    }
    for (let pass = 0; pass < 2; pass++) for (let j = 2 * n - 1; j >= 0; j--) {
      const i = j % n, next = (i + 1) % n, d = this.point(i).dist(this.point(next));
      v[i] = Math.min(v[i], Math.sqrt(v[next] * v[next] + 2 * brake * g * d));
    }
    return v;
  }
}

const cache = new WeakMap<Track, Map<number, RacingLine>>();
/** One line per track and driving style; deterministic, so the UI thread and the worker agree. */
export function getRacingLine(track: Track, lateness = 0.6): RacingLine {
  let perTrack = cache.get(track);
  if (!perTrack) { perTrack = new Map(); cache.set(track, perTrack); }
  let line = perTrack.get(lateness);
  if (!line) { line = new RacingLine(track, lateness); perTrack.set(lateness, line); }
  return line;
}
