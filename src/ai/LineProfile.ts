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
  /** Corner radius may grow to 1 / (0.7 κ) on a wide line; the planner never assumes more. */
  static readonly MIN_RATIO = 0.7;
  /** A wobbly line may tighten a corner by a share of its curvature, plus a small absolute slack for straights. */
  static readonly MAX_RATIO = 1.15;
  static readonly MAX_SLACK = 0.0005;
  readonly offsets: Float32Array;
  /** Curvature per point; NaN marks an entry whose neighbourhood changed since it was computed. */
  private readonly cache: Float32Array;

  constructor(pointCount: number) {
    this.offsets = new Float32Array(pointCount);
    this.cache = new Float32Array(pointCount).fill(NaN);
  }

  matches(track: Track): boolean { return this.offsets.length === track.points.length; }

  /** Blend the current lateral position (metres, `sampleSurface().lateral`) into the profile. */
  record(index: number, lateral: number, rate = LineProfile.RATE): void {
    if (index < 0 || index >= this.offsets.length || !Number.isFinite(lateral)) return;
    this.offsets[index] += (lateral - this.offsets[index]) * rate;
    this.invalidate(index);
  }

  /** Forget cached curvature around a point (call after editing `offsets` directly). */
  invalidate(index?: number): void {
    const n = this.cache.length;
    if (index === undefined) { this.cache.fill(NaN); return; }
    for (let d = -2; d <= 2; d++) this.cache[((index + d) % n + n) % n] = NaN;
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
    const centre = Math.abs(track.points[((index % n) + n) % n].curvature);
    let delta = 0;
    // Smooth over three neighbouring arcs; the difference to the centreline arc removes discretisation bias.
    for (let d = -1; d <= 1; d++) {
      const i = index + d, weight = d === 0 ? 0.5 : 0.25;
      const line = menger(this.point(track, i - 1), this.point(track, i), this.point(track, i + 1));
      const axis = menger(track.points[((i - 1) % n + n) % n].center, track.points[((i % n) + n) % n].center, track.points[((i + 1) % n + n) % n].center);
      delta += weight * (line - axis);
    }
    const signed = track.points[((index % n) + n) % n].curvature;
    const effective = Math.abs(signed + delta);
    return Math.max(centre * LineProfile.MIN_RATIO, Math.min(centre * LineProfile.MAX_RATIO + LineProfile.MAX_SLACK, effective));
  }
}
