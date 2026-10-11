import { random } from '../math/Random';
import type { Track } from '../track/Track';
import type { Vector2 } from '../math/Vector2';
/** Evolve bounded corner trajectories from clean completed training laps. */
export class LineSearch {
  readonly offsets = [-2.4, -1.2, 0, 1.2, 2.4];
  readonly times: number[][] = this.offsets.map(() => []);
  static readonly SECTIONS = 16;
  /** `trim` shifts the line (metres) per section of the lap, so each corner is optimised on its own. */
  readonly profiles: { bias: number; amplitude: number; entry: number; exit: number; trim: number[] }[] =
    this.offsets.map((bias, i) => ({bias: bias*.35, amplitude: .12+i*.025, entry: 25+i*5, exit: 25, trim: new Array(LineSearch.SECTIONS).fill(0)}));
  current: number;
  private visits = 0;
  private transitionLap = false;
  constructor(seed: number) { this.current = seed % this.offsets.length; }
  get best(): number {
    let winner = this.current, fastest = Infinity;
    this.times.forEach((samples, index) => {
      if (!samples.length) return;
      const sorted = [...samples].sort((a,b) => a-b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (median < fastest) { fastest = median; winner = index; }
    });
    return winner;
  }
  offset(racing: boolean): number { return this.offsets[racing ? this.best : this.current]; }
  target(track: Track, pos: Vector2, racing: boolean): number {
    const variant = racing ? this.best : this.current;
    const profile = this.profiles[variant];
    const index = track.sampleSurface(pos).index, n = track.points.length;
    const curvatureAt = (distance: number): number => {
      let i = index, travelled = 0;
      const direction = distance < 0 ? -1 : 1;
      while (travelled < Math.abs(distance) && travelled < track.totalLength) {
        const next = (i + direction + n) % n;
        travelled += track.points[i].center.dist(track.points[next].center);
        i = next;
      }
      let curvature = 0;
      for (let d = -2; d <= 2; d++) curvature += track.points[(i+d+n)%n].curvature * (3-Math.abs(d))/9;
      return Math.tanh(curvature * 100);
    };
    // Outside before the bend, inside at the apex, outside again on exit.
    const shape = 1.6*curvatureAt(0) - .9*curvatureAt(profile.entry) - .6*curvatureAt(-profile.exit);
    const amplitude = track.width * profile.amplitude;
    const limit = Math.max(0, track.width/2 - 1.8);
    const section = Math.min(LineSearch.SECTIONS - 1, Math.floor(index / n * LineSearch.SECTIONS));
    const next = (section + 1) % LineSearch.SECTIONS, blend = (index / n * LineSearch.SECTIONS) - section;
    const trim = profile.trim[section] * (1 - blend) + profile.trim[next] * blend;
    return Math.max(-limit, Math.min(limit, profile.bias + amplitude*shape + trim));
  }
  finish(time: number, clean: boolean): void {
    if (!clean || !Number.isFinite(time) || time <= 0) return;
    // The lap after a switch includes the smooth lane transition: do not score it.
    if (this.transitionLap) { this.transitionLap = false; return; }
    const samples = this.times[this.current]; samples.push(time);
    if (samples.length > 5) samples.shift();
    this.visits++;
    const unexplored = this.offsets.map((_,i) => (this.current + i + 1) % this.offsets.length)
      .find(i => !this.times[i].length);
    const best = this.best;
    let next = unexplored ?? best;
    if (unexplored === undefined && this.visits % 2 === 0) {
      // Preserve the champion and evaluate a new nearby trajectory, not a fixed menu forever.
      next = (best + 1) % this.offsets.length;
      const champion = this.profiles[best];
      const perturb = (scale: number) => (random()*2-1)*scale;
      this.profiles[next] = {
        bias: Math.max(-1.5, Math.min(1.5, champion.bias + perturb(.5))),
        amplitude: Math.max(.08, Math.min(.3, champion.amplitude + perturb(.025))),
        entry: Math.max(15, Math.min(65, champion.entry + perturb(8))),
        exit: Math.max(15, Math.min(65, champion.exit + perturb(8))),
        // Re-route one to three sections of the lap (early/late apex, wider entry...).
        trim: champion.trim.map(v => v)
      };
      for (let k = 1 + Math.floor(random() * 3); k > 0; k--) {
        const section = Math.floor(random() * LineSearch.SECTIONS);
        this.profiles[next].trim[section] = Math.max(-2.2, Math.min(2.2, this.profiles[next].trim[section] + perturb(1.1)));
      }
      this.times[next] = [];
    }
    if (next !== this.current) { this.current = next; this.transitionLap = true; }
  }
}
