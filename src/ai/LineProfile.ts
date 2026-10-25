import type { Track } from '../track/Track';
import type { Vector2 } from '../math/Vector2';

/** Signed curvature (1/m) of the circle through three points. */
function menger(a: Vector2, b: Vector2, c: Vector2): number {
  const abx = b.x - a.x, aby = b.y - a.y, bcx = c.x - b.x, bcy = c.y - b.y, acx = c.x - a.x, acy = c.y - a.y;
  const denominator = Math.hypot(abx, aby) * Math.hypot(bcx, bcy) * Math.hypot(acx, acy);
  return denominator > 1e-6 ? 2 * (abx * bcy - aby * bcx) / denominator : 0;
}

/**
 * The line a car actually drives: its lateral offset from the centreline at every track point,
 * averaged over the laps it has run. The braking planner reads corner radii from this line, so a
 * car that uses the whole width (outside, apex, outside) is allowed the higher speed that the wider
 * arc really permits, and a car that pinches the corner plans for the tighter arc it takes.
 */
export class LineProfile {
  /** Blend per pass over a point (one sample per lap): the profile averages the last few laps. */
  static readonly RATE = 0.3;
  /** Corner radius may grow to 1 / (0.7 κ) on a wide line, or to the racing line's radius when that is wider. */
  static readonly MIN_RATIO = 0.7;
  /** A wobbly line may tighten a corner by a share of its curvature, plus a small absolute slack for straights. */
  static readonly MAX_RATIO = 1.15;
  static readonly MAX_SLACK = 0.0005;
  /** Metres between the three points of each arc the curvature is read from: short arcs amplify centimetre wobble. */
  static readonly ARC_BASE = 6;
  /** Points a car may pass in one step and still have all of them recorded (beyond that it jumped). */
  static readonly MAX_RECORD_GAP = 12;
  readonly offsets: Float32Array;
  /** Curvature per point; NaN marks an entry whose neighbourhood changed since it was computed. */
  private readonly cache: Float32Array;
  /** Curvature of the precomputed racing line: a car on that line may plan for its wider arcs. */
  private floor: Float32Array | null = null;
  /** Track points between the three points of an arc (set from the track's spacing). */
  private base = 1;

  constructor(pointCount: number) {
    this.offsets = new Float32Array(pointCount);
    this.cache = new Float32Array(pointCount).fill(NaN);
  }

  /** A profile that starts on the racing line `offsets` and may open the corners as far as that line does. */
  static fromLine(track: Track, offsets: ArrayLike<number>): LineProfile {
    const profile = new LineProfile(track.points.length);
    profile.offsets.set(offsets);
    const floor = new Float32Array(track.points.length);
    for (let i = 0; i < floor.length; i++) floor[i] = profile.effective(track, i);
    profile.floor = floor;
    return profile;
  }

  matches(track: Track): boolean { return this.offsets.length === track.points.length; }

  /** Blend the current lateral position (metres, `sampleSurface().lateral`) into the profile. */
  record(index: number, lateral: number, rate = LineProfile.RATE): void {
    if (index < 0 || index >= this.offsets.length || !Number.isFinite(lateral)) return;
    this.offsets[index] += (lateral - this.offsets[index]) * rate;
    this.invalidate(index);
  }

  /**
   * Record every point a car passed since its previous sample, the lateral position interpolated
   * between the two: at speed a car covers several track points per step.
   */
  recordSince(fromIndex: number, fromLateral: number, index: number, lateral: number, rate = LineProfile.RATE): void {
    const n = this.offsets.length, gap = ((index - fromIndex) % n + n) % n;
    if (fromIndex < 0 || !Number.isFinite(fromLateral) || gap === 0 || gap > LineProfile.MAX_RECORD_GAP) { this.record(index, lateral, rate); return; }
    for (let k = 1; k <= gap; k++) this.record((fromIndex + k) % n, fromLateral + (lateral - fromLateral) * k / gap, rate);
  }

  /** Forget cached curvature around a point (call after editing `offsets` directly). */
  invalidate(index?: number): void {
    const n = this.cache.length;
    if (index === undefined) { this.cache.fill(NaN); return; }
    // An offset enters the arcs of every point within two arc bases of it.
    const reach = 2 * this.base;
    for (let d = -reach; d <= reach; d++) this.cache[((index + d) % n + n) % n] = NaN;
  }

  private point(track: Track, index: number): Vector2 {
    const n = track.points.length, i = ((index % n) + n) % n, p = track.points[i];
    return p.center.add(p.tangent.normal().mul(this.offsets[i]));
  }

  /** Unsigned curvature of the driven line at a track point, bounded around the centreline's. */
  curvature(track: Track, index: number): number {
    const n = track.points.length, slot = ((index % n) + n) % n;
    const cached = this.cache[slot];
    if (!Number.isNaN(cached)) return cached;
    return (this.cache[slot] = this.compute(track, slot));
  }

  private compute(track: Track, index: number): number {
    const n = track.points.length;
    const centre = Math.abs(this.arcs(track, index, true));
    const lower = Math.min(centre * LineProfile.MIN_RATIO, this.floor?.[((index % n) + n) % n] ?? Infinity);
    return Math.max(lower, Math.min(centre * LineProfile.MAX_RATIO + LineProfile.MAX_SLACK, this.effective(track, index)));
  }

  private effective(track: Track, index: number): number {
    return Math.abs(this.arcs(track, index, false));
  }

  /**
   * Signed curvature of the driven line (or of the centreline) on the ARC_BASE arc around a point.
   * The per-point curvature of a 1 m track turns millimetre resampling wobble into swings of
   * several 1/km, enough to make a 400 m sweeper look like a 200 m corner; averaging neighbouring
   * arcs as well would blunt the apex of a hairpin.
   */
  private arcs(track: Track, index: number, axis: boolean): number {
    const n = track.points.length, b = this.base = track.pointsFor(LineProfile.ARC_BASE);
    const at = (i: number) => axis ? track.points[((i % n) + n) % n].center : this.point(track, i);
    return menger(at(index - b), at(index), at(index + b));
  }
}
