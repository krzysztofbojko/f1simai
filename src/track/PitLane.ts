import { Vector2 } from '../math/Vector2';
import type { Track } from './Track';

/** Speed limit of the pit lane, m/s (80 km/h). */
export const PIT_SPEED_LIMIT = 80 / 3.6;
/** Width of the pit lane, m. */
export const PIT_LANE_WIDTH = 5;
/** Concrete between the runoff barrier (the pit wall) and the lane, m. */
export const PIT_WALL_GAP = 1;
/** Entry road from the track edge to the limiter line: room to brake from about 320 km/h at 3 g, m. */
export const PIT_ENTRY_ROAD = 130;
/** Exit road from the limiter line back to the track edge, m. */
export const PIT_EXIT_ROAD = 60;
/** Widest runoff the lane is set back by: beyond it the lane runs on the runoff, behind a wall of its own, m. */
const MAX_SETBACK = 6;
/** Distance between neighbouring team boxes, m (the boxes close up on a short lane). */
export const PIT_BOX_SPACING = 12;
/** Team boxes along the lane. */
export const PIT_BOXES = 10;

/** Stretch between the limiter lines, m. */
const LIMITED = 260;
/** Room after the exit road before the next corner, m: the car rejoins on a straight. */
const EXIT_RUNWAY = 100;
/** Furthest the lane may be shifted from the start/finish line to find a straight, m. */
const MAX_SHIFT = 500;

/**
 * The pit lane beside the start/finish straight, on the side where nothing else runs. A car in it
 * is placed by distance `d` along the track from the start/finish line (negative before it), so
 * the lane follows the straight and its bends; laterally it runs from where the car left the track,
 * down the entry road to the lane behind the pit wall, past the team boxes and back up the exit
 * road to the track edge.
 *
 * The pit entry line is crossed at `entry` and the exit line at `exit`; between them the car is in
 * the pits. The speed limit holds from `limiterStart` to `limiterEnd`.
 */
export class PitLane {
  /** +1: the lane lies along the track normal (left of the direction of travel), -1: the other side. */
  readonly side: number;
  /** Lateral offset of the lane centre from the track centreline, m (positive towards `side`). */
  readonly laneOffset: number;
  /** Lateral offset at which a car rejoins: just inside the track edge on the pit side. */
  readonly rejoinOffset: number;
  readonly entry: number;
  readonly limiterStart: number;
  readonly limiterEnd: number;
  readonly exit: number;
  /** Distance of each team's box (the stopping point) from the line. */
  readonly boxes: number[];

  private constructor(private readonly track: Track, side: number, laneOffset: number, before: number, after: number) {
    this.side = side;
    this.laneOffset = laneOffset;
    this.rejoinOffset = track.width / 2 - 2;
    this.entry = -before;
    this.limiterStart = this.entry + PIT_ENTRY_ROAD;
    this.exit = after;
    this.limiterEnd = this.exit - PIT_EXIT_ROAD;
    // Boxes centred in the limited stretch, leaving room to stop from the limit and to pull away.
    const room = this.limiterEnd - this.limiterStart - 70;
    const spacing = Math.max(6, Math.min(PIT_BOX_SPACING, room / (PIT_BOXES - 1)));
    const middle = (this.limiterStart + 35 + this.limiterEnd - 35) / 2;
    this.boxes = Array.from({ length: PIT_BOXES }, (_, k) => middle + (k - (PIT_BOXES - 1) / 2) * spacing);
  }

  /** The lane for `track`, on the side whose stretch beside the straight is free of other track. */
  static build(track: Track): PitLane | null {
    const n = track.points.length;
    const length = PIT_ENTRY_ROAD + LIMITED + PIT_EXIT_ROAD;
    if (n < 20 || track.totalLength < 3 * length) return null;
    // The straightest stretch near the start/finish line: the lane and the runway after its exit
    // stay on the gentlest curvature; among equal stretches the one nearest the line wins.
    let exit = length / 2, bestBend = Infinity;
    for (let candidate = -MAX_SHIFT + length; candidate <= MAX_SHIFT; candidate += 10) {
      let bend = 0;
      for (let d = candidate - length; d <= candidate + EXIT_RUNWAY; d += 5) bend = Math.max(bend, Math.abs(track.smoothedCurvature[track.pointAhead(0, d)]));
      const score = bend + Math.abs(candidate - length / 2) * 1e-7;
      if (score < bestBend) { bestBend = score; exit = candidate; }
    }
    const before = length - exit, after = exit;
    let best: PitLane | null = null, bestScore = Infinity;
    for (const side of [1, -1]) {
      let runoff = 0;
      for (let d = -before; d <= after; d += 5) {
        const r = track.runoff[track.pointAhead(0, d)];
        runoff = Math.max(runoff, side > 0 ? r.leftWidth : r.rightWidth);
      }
      const lane = new PitLane(track, side, track.width / 2 + Math.min(MAX_SETBACK, runoff) + PIT_WALL_GAP + PIT_LANE_WIDTH / 2, before, after);
      const score = lane.conflicts();
      if (score < bestScore) { best = lane; bestScore = score; }
      if (score === 0) break;
    }
    return best;
  }

  /** Lane points (every 5 m, both lane edges) that fall on another stretch of the track. */
  private conflicts(): number {
    const track = this.track, reach = track.width + PIT_LANE_WIDTH + 10;
    let bad = 0;
    for (let d = this.limiterStart; d <= this.limiterEnd; d += 5) {
      const own = track.pointAhead(0, d);
      for (const offset of [this.laneOffset - PIT_LANE_WIDTH / 2, this.laneOffset + PIT_LANE_WIDTH / 2 + 2]) {
        const p = this.point(d, this.side * offset), sample = track.sampleSurface(p);
        const gap = Math.abs(((sample.index - own) % track.points.length + track.points.length) % track.points.length);
        const apart = Math.min(gap, track.points.length - gap) * track.spacing;
        if (apart > reach && Math.abs(sample.lateral) < track.width / 2 + 6) bad++;
      }
    }
    return bad;
  }

  /** Track point index `d` metres from the start/finish line. */
  index(d: number): number { return this.track.pointAhead(0, d); }

  /** Lateral offset (m, towards `side` when positive) of a car that left the track at `entryOffset`. */
  offset(d: number, entryOffset: number): number {
    const lane = this.side * this.laneOffset;
    if (d <= this.limiterStart) return entryOffset + (lane - entryOffset) * smooth((d - this.entry) / PIT_ENTRY_ROAD);
    if (d >= this.limiterEnd) return lane + (this.side * this.rejoinOffset - lane) * smooth((d - this.limiterEnd) / PIT_EXIT_ROAD);
    return lane;
  }

  /** World position `offset` metres from the centreline (positive along the track normal), `d` metres from the line. */
  point(d: number, offset: number): Vector2 {
    const track = this.track, n = track.points.length;
    const whole = Math.floor(d / track.spacing), t = d / track.spacing - whole;
    const a = track.points[((whole % n) + n) % n], b = track.points[(((whole + 1) % n) + n) % n];
    const centre = Vector2.lerp(a.center, b.center, t);
    const normal = Vector2.lerp(a.normal, b.normal, t);
    return centre.add(normal.mul(offset));
  }

  /** Position and heading of a car `d` metres from the line that left the track at `entryOffset`. */
  pose(d: number, entryOffset: number): { pos: Vector2; heading: number } {
    const pos = this.point(d, this.offset(d, entryOffset));
    const ahead = this.point(d + 1, this.offset(d + 1, entryOffset));
    return { pos, heading: ahead.sub(pos).heading() };
  }

  /** Distance from the line (negative before it) of the track point `index`, within the lane's reach. */
  distanceOf(index: number): number {
    const n = this.track.points.length, steps = ((index % n) + n) % n;
    const d = steps * this.track.spacing;
    return d > this.track.totalLength / 2 ? d - this.track.totalLength : d;
  }
}

/** Smoothstep 0..1: the entry and exit roads leave and meet the lanes tangentially. */
function smooth(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}
