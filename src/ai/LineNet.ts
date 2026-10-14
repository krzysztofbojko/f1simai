import { NeuralNetwork } from './NeuralNetwork';
import { random } from '../math/Random';
import type { Track, SurfaceSample } from '../track/Track';
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
export function lineInputs(track: Track, car: LineSensors, sample: SurfaceSample = track.sampleSurface(car.pos)): number[] {
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

type Mode = 'champion' | 'trim' | 'network';

/**
 * Racing-line network plus a per-section trim. The network output is the desired lateral position
 * as a fraction of the usable road width; each of the SECTIONS parts of the lap adds its own
 * shift in metres (earlier/later apex, wider entry...). Both start from a distilled seed line and
 * improve by (1+1) evolution with lap timing as the only judge:
 * - trim candidates move one or two sections for two laps; a move is kept when the sections it
 *   shapes plus the following one (the exit) got faster, so every corner is optimised on its own clock;
 * - network laps evaluate a mutated network over two laps and keep it when the mean beats the champion;
 * - every fourth lap re-measures the champion, because lap times carry grip/power noise;
 * - a team-mate's better line can be proposed and is then evaluated like a network candidate.
 */
export class LineNet {
  static readonly SECTIONS = 16;
  static readonly MAX_TRIM = 3;
  static readonly CANDIDATE_LAPS = 2;
  /** A section move must win this much (s) over its three sections, averaged over the candidate laps. */
  static readonly TRIM_GAIN = 0.04;
  private static readonly CYCLE: Mode[] = ['trim', 'network', 'champion'];

  current: NeuralNetwork;
  best: NeuralNetwork;
  bestTime = Infinity;
  bestTrim: Float32Array<ArrayBuffer> = new Float32Array(LineNet.SECTIONS);
  currentTrim: Float32Array<ArrayBuffer> = new Float32Array(LineNet.SECTIONS);
  /** Running estimate of the champion's time in every section. */
  readonly sectionBest = new Float64Array(LineNet.SECTIONS).fill(NaN);
  mode: Mode = 'champion';
  private laps = 0;
  private cycle = 0;
  private strength = 0.2;
  private trimStrength = 0.8;
  private mutated: number[] = [];
  private candidateTimes: number[] = [];
  private candidateSections: Float64Array[] = [];
  private proposal: { net: NeuralNetwork; trim: Float32Array<ArrayBuffer> } | null = null;
  private evaluatingProposal = false;
  /** Section timing of the lap in progress. */
  private readonly lapSections = new Float64Array(LineNet.SECTIONS).fill(NaN);
  private section = -1;
  private sectionStart = 0;

  constructor(base: NeuralNetwork) { this.current = base.clone(); this.best = base.clone(); }

  toJSON(): { best: unknown; bestTime: number | null; strength: number; bestTrim: number[] } {
    return { best: JSON.parse(this.best.toJSON()), bestTime: Number.isFinite(this.bestTime) ? this.bestTime : null, strength: this.strength, bestTrim: Array.from(this.bestTrim) };
  }

  /** Restore the champion; a network built for a different sensor layout is ignored. */
  fromJSON(data: any): boolean {
    try {
      const loaded = NeuralNetwork.fromJSON(JSON.stringify(data?.best));
      if (!loaded.hasSameTopology(this.best)) return false;
      this.best = loaded;
      this.current = loaded.clone();
      this.bestTime = typeof data.bestTime === 'number' && data.bestTime > 0 ? data.bestTime : Infinity;
      this.strength = typeof data.strength === 'number' ? Math.max(0.05, Math.min(0.3, data.strength)) : 0.2;
      this.bestTrim = new Float32Array(LineNet.SECTIONS);
      if (Array.isArray(data.bestTrim) && data.bestTrim.length === LineNet.SECTIONS) {
        data.bestTrim.forEach((v: unknown, i: number) => { if (typeof v === 'number' && Number.isFinite(v)) this.bestTrim[i] = Math.max(-LineNet.MAX_TRIM, Math.min(LineNet.MAX_TRIM, v)); });
      }
      this.currentTrim = this.bestTrim.slice();
      this.sectionBest.fill(NaN);
      this.mode = 'champion';
      this.cycle = 0;
      this.candidateTimes = [];
      this.candidateSections = [];
      return true;
    } catch { return false; }
  }

  /** Fresh search that starts from this champion (used when the driver pressure changes). */
  fork(): LineNet {
    const copy = new LineNet(this.best);
    copy.bestTrim = this.bestTrim.slice();
    copy.currentTrim = this.bestTrim.slice();
    return copy;
  }

  /** A team-mate's line to evaluate next (it replaces ours only if it is faster for this car). */
  propose(other: LineNet): void {
    if (!other.best.hasSameTopology(this.best)) return;
    this.proposal = { net: other.best.clone(), trim: other.bestTrim.slice() };
  }

  get hasProposal(): boolean { return this.proposal !== null || this.evaluatingProposal; }

  private trimAt(track: Track, index: number, trim: Float32Array): number {
    const s = LineNet.SECTIONS, position = index / track.points.length * s;
    const section = Math.min(s - 1, Math.floor(position)), blend = position - section;
    return trim[section] * (1 - blend) + trim[(section + 1) % s] * blend;
  }

  /** Desired lateral position in metres. */
  target(track: Track, car: LineSensors, racing: boolean): number {
    const sample = track.sampleSurface(car.pos);
    const out = (racing ? this.best : this.current).forward(lineInputs(track, car, sample))[0] ?? 0;
    return out * Math.max(0, track.width / 2 - 2.3) + this.trimAt(track, sample.index, racing ? this.bestTrim : this.currentTrim);
  }

  /** The car was reset (respawn, grid): the lap in progress has no comparable section times. */
  resetTiming(): void {
    this.lapSections.fill(NaN);
    this.section = -1;
    this.sectionStart = 0;
  }

  /** The car cleared track point `index` at `lapTime` seconds into its lap: times each section. */
  passPoint(index: number, pointCount: number, lapTime: number): void {
    const section = Math.min(LineNet.SECTIONS - 1, Math.floor(index / Math.max(1, pointCount) * LineNet.SECTIONS));
    if (section === this.section) return;
    const consecutive = this.section >= 0 && section === (this.section + 1) % LineNet.SECTIONS;
    if (consecutive && Number.isFinite(lapTime)) this.lapSections[this.section] = lapTime - this.sectionStart;
    else if (this.section >= 0) this.lapSections.fill(NaN); // skipped part of the lap: no fair comparison
    this.section = section;
    this.sectionStart = section === 0 ? 0 : lapTime;
  }

  /** Lap finished. Returns true when the line improved. */
  finish(time: number, clean: boolean): boolean {
    const sections = this.lapSections.slice();
    this.lapSections.fill(NaN);
    if (!clean || !Number.isFinite(time) || time <= 0) return false;
    this.laps++;
    let improved = false;
    if (this.mode === 'champion') {
      // Re-measure the champion: lap times carry grip/power noise, so keep a running estimate.
      this.bestTime = Number.isFinite(this.bestTime) ? 0.5 * this.bestTime + 0.5 * time : time;
      sections.forEach((t, i) => { if (Number.isFinite(t)) this.sectionBest[i] = Number.isFinite(this.sectionBest[i]) ? 0.5 * this.sectionBest[i] + 0.5 * t : t; });
    } else {
      // Candidates (a section move or a mutated network) run for two laps: one lap is too noisy.
      this.candidateTimes.push(time);
      this.candidateSections.push(sections);
      if (this.candidateTimes.length < LineNet.CANDIDATE_LAPS) return false; // same candidate, one more lap
      const mean = this.candidateTimes.reduce((a, b) => a + b, 0) / this.candidateTimes.length;
      if (this.mode === 'trim') {
        const averaged = new Float64Array(LineNet.SECTIONS);
        for (let i = 0; i < LineNet.SECTIONS; i++) averaged[i] = this.candidateSections.reduce((sum, lap) => sum + lap[i], 0) / this.candidateSections.length;
        improved = this.judgeTrim(mean, averaged);
      } else if (mean < this.bestTime - 0.03) {
        this.best = this.current.clone();
        this.bestTrim = this.currentTrim.slice();
        this.bestTime = mean;
        for (let i = 0; i < LineNet.SECTIONS; i++) {
          const samples = this.candidateSections.map(s => s[i]).filter(Number.isFinite);
          this.sectionBest[i] = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : NaN;
        }
        if (!this.evaluatingProposal) this.strength = Math.min(0.3, this.strength * 1.1);
        improved = true;
      } else if (!this.evaluatingProposal) this.strength = Math.max(0.05, this.strength * 0.93);
      this.candidateTimes = [];
      this.candidateSections = [];
      this.evaluatingProposal = false;
    }
    this.next();
    return improved;
  }

  /**
   * Keep each moved trim whose neighbourhood got faster. Trim k shapes sections k-1 and k (it is
   * interpolated between section starts) and its exit speed shows in section k+1.
   */
  private judgeTrim(time: number, sections: Float64Array): boolean {
    const s = LineNet.SECTIONS;
    const around = (k: number) => [(k - 1 + s) % s, k, (k + 1) % s];
    let accepted = 0;
    const timed = this.mutated.every(k => around(k).every(i => Number.isFinite(sections[i]) && Number.isFinite(this.sectionBest[i])));
    if (timed) {
      for (const k of this.mutated) {
        const span = around(k);
        const candidate = span.reduce((sum, i) => sum + sections[i], 0);
        const champion = span.reduce((sum, i) => sum + this.sectionBest[i], 0);
        if (candidate < champion - LineNet.TRIM_GAIN) {
          this.bestTrim[k] = this.currentTrim[k];
          span.forEach(i => { this.sectionBest[i] = sections[i]; });
          accepted++;
        }
      }
    } else if (time < this.bestTime - 0.03) {
      // No section clock (e.g. lap timing without checkpoints): judge on the whole lap.
      this.mutated.forEach(k => { this.bestTrim[k] = this.currentTrim[k]; });
      this.bestTime = time;
      accepted = this.mutated.length;
    }
    this.trimStrength = accepted > 0 ? Math.min(1.5, this.trimStrength * 1.1) : Math.max(0.25, this.trimStrength * 0.95);
    return accepted > 0;
  }

  /** Prepare the next lap: re-measure, a section move, a network candidate or a team-mate's line. */
  private next(): void {
    this.current = this.best.clone();
    this.currentTrim = this.bestTrim.slice();
    this.mutated = [];
    if (this.proposal) {
      this.current = this.proposal.net;
      this.currentTrim = this.proposal.trim;
      this.proposal = null;
      this.evaluatingProposal = true;
      this.mode = 'network';
      return;
    }
    this.mode = LineNet.CYCLE[this.cycle++ % LineNet.CYCLE.length];
    if (this.mode === 'network') this.current.mutate(0.2, this.strength);
    if (this.mode === 'trim') {
      const count = 1 + Math.floor(random() * 2);
      for (let c = 0; c < count; c++) {
        const k = Math.floor(random() * LineNet.SECTIONS);
        if (this.mutated.includes(k)) continue;
        this.mutated.push(k);
        const step = (random() * 2 - 1) * this.trimStrength;
        this.currentTrim[k] = Math.max(-LineNet.MAX_TRIM, Math.min(LineNet.MAX_TRIM, this.currentTrim[k] + step));
      }
    }
  }
}
