import { NeuralNetwork } from './NeuralNetwork';
import type { Track } from '../track/Track';
import type { Vector2 } from '../math/Vector2';

/** Signed, saturating curvature of the track `distance` metres ahead (negative = behind) of a sample index. */
export function signedCurvature(track: Track, index: number, distance: number): number {
  const n = track.points.length;
  let i = index, travelled = 0;
  const direction = distance < 0 ? -1 : 1;
  while (travelled < Math.abs(distance) && travelled < track.totalLength) {
    const next = (i + direction + n) % n;
    travelled += track.points[i].center.dist(track.points[next].center);
    i = next;
  }
  let curvature = 0;
  for (let d = -2; d <= 2; d++) curvature += track.points[(i + d + n) % n].curvature * (3 - Math.abs(d)) / 9;
  return Math.tanh(curvature * 100);
}

const LOOKAHEADS = [0, 18, 40, 70];
/** speed + 4 curvature samples + lateral position + heading error */
export const LINE_EXTRA_INPUTS = 7;

export interface LineSensors { pos: Vector2; heading: number; speed: number; rayDistances: number[] }

/** Network input: LiDAR rays plus what the car reads from the road ahead. */
export function lineInputs(track: Track, car: LineSensors): number[] {
  const sample = track.sampleSurface(car.pos);
  const headingError = Math.atan2(Math.sin(car.heading - sample.tangent.heading()), Math.cos(car.heading - sample.tangent.heading()));
  return [
    ...car.rayDistances,
    Math.min(1, car.speed / 95),
    ...LOOKAHEADS.map(d => signedCurvature(track, sample.index, d)),
    Math.max(-1, Math.min(1, sample.lateral / Math.max(1, track.width / 2))),
    headingError / Math.PI,
  ];
}

/** Outside before the bend, deep to the inside at the apex, outside again on exit: uses the whole road. */
export function seedLineTarget(track: Track, index: number): number {
  const shape = 1.6 * signedCurvature(track, index, 0) - 0.9 * signedCurvature(track, index, 30) - 0.6 * signedCurvature(track, index, -25);
  return Math.max(-0.95, Math.min(0.95, shape * 0.9));
}

/**
 * Racing-line network. The output is the desired lateral position as a fraction of the usable
 * road width. It starts from a distilled seed line and then improves by neuro-evolution:
 * a mutated copy drives one lap, and replaces the champion only if the lap is faster.
 */
export class LineNet {
  current: NeuralNetwork;
  best: NeuralNetwork;
  bestTime = Infinity;
  private evaluatingCandidate = false;
  private laps = 0;
  private strength = 0.2;

  constructor(base: NeuralNetwork) { this.current = base.clone(); this.best = base.clone(); }

  /** Fresh search that starts from this champion (used when the driver pressure changes). */
  fork(): LineNet { return new LineNet(this.best); }

  /** Desired lateral position in metres. */
  target(track: Track, car: LineSensors, racing: boolean): number {
    const out = (racing ? this.best : this.current).forward(lineInputs(track, car))[0] ?? 0;
    return out * Math.max(0, track.width / 2 - 2.3);
  }

  finish(time: number, clean: boolean): void {
    if (!clean || !Number.isFinite(time) || time <= 0) return;
    this.laps++;
    if (this.evaluatingCandidate) {
      if (time < this.bestTime - 0.03) {
        this.best = this.current.clone();
        this.bestTime = time;
        this.strength = Math.min(0.3, this.strength * 1.1);
      } else this.strength = Math.max(0.05, this.strength * 0.93);
    } else {
      // Re-measure the champion: lap times carry grip/power noise, so keep a running estimate.
      this.bestTime = Number.isFinite(this.bestTime) ? 0.5 * this.bestTime + 0.5 * time : time;
    }
    this.current = this.best.clone();
    this.evaluatingCandidate = this.laps % 4 !== 3;
    if (this.evaluatingCandidate) this.current.mutate(0.2, this.strength);
  }
}
