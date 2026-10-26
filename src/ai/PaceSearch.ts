import { median } from './TeamRating';

/**
 * Limit probing. A car that stays on the asphalt may still have margin, so after a few clean laps
 * at the proven margin it tries a slightly higher one for a few laps and keeps it when their median
 * beats the proven laps' median. One lap says little: the same car spreads its laps by several per
 * cent (traffic, per-lap grip and power), so a single fast lap neither proves nor rules out a margin.
 * Own excursions at the probed margin cap the search there; repeated ones at the proven margin step it back.
 */
export class PaceSearch {
  static readonly MIN = 0.9;
  /** The planner already budgets most of the grip including downforce: probing only trims it. */
  static readonly MAX = 1.15;
  static readonly MAX_STEP = 0.05;
  /** Clean laps a margin is driven before its median counts. */
  static readonly JUDGE_LAPS = 3;
  /** Clean laps kept at the proven margin. */
  static readonly PROVEN_LAPS = 8;
  /** Own excursions at the proven margin within the last `EXCURSION_WINDOW` laps that step it back. */
  static readonly EXCURSION_LIMIT = 2;
  static readonly EXCURSION_WINDOW = 6;
  /** Proven-margin step back after repeated excursions. */
  static readonly BACK_OFF = 0.03;
  /** A capped ceiling relaxes by this much per clean lap, so one unlucky probe does not cap it for good. */
  static readonly CEILING_RELAX = 0.002;
  margin = 1;
  bestMargin = 1;
  ceiling = PaceSearch.MAX;
  private step = 0.03;
  /** Clean laps at the proven margin, newest last. */
  private provenLaps: number[] = [];
  /** Clean laps at the probed margin. */
  private probeLaps: number[] = [];
  /** Recent laps at the proven margin: true where the car left the track by itself. */
  private excursions: boolean[] = [];

  toJSON(): { margin: number; bestMargin: number; ceiling: number; step: number; provenLaps: number[] } {
    return { margin: this.margin, bestMargin: this.bestMargin, ceiling: this.ceiling, step: this.step, provenLaps: [...this.provenLaps] };
  }

  fromJSON(data: any): void {
    const clamp = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(PaceSearch.MIN, Math.min(PaceSearch.MAX, v)) : fallback;
    this.bestMargin = clamp(data?.bestMargin, clamp(data?.margin, 1));
    // A saved probe is not resumed: its laps are gone.
    this.margin = this.bestMargin;
    this.ceiling = clamp(data?.ceiling, PaceSearch.MAX);
    this.step = typeof data?.step === 'number' ? Math.max(0.01, Math.min(PaceSearch.MAX_STEP, data.step)) : 0.03;
    this.provenLaps = Array.isArray(data?.provenLaps) ? data.provenLaps.filter((t: unknown) => typeof t === 'number' && t > 0).slice(-PaceSearch.PROVEN_LAPS) : [];
    this.probeLaps = [];
    this.excursions = [];
  }

  /** Margin used for planning: the proven one when racing, the probing one while training. */
  value(racing: boolean): number { return racing ? this.bestMargin : this.margin; }

  get probing(): boolean { return this.margin !== this.bestMargin; }

  /** Called after every completed lap. `excursion` = the car left the asphalt or hit something by itself (not after contact with another car). */
  finishLap(time: number, clean: boolean, excursion: boolean): void {
    if (excursion) { this.fail(); return; }
    if (!clean || !Number.isFinite(time) || time <= 0) return;
    this.ceiling = Math.min(PaceSearch.MAX, this.ceiling + PaceSearch.CEILING_RELAX);
    if (this.probing) {
      this.probeLaps.push(time);
      if (this.probeLaps.length < PaceSearch.JUDGE_LAPS) return;
      if (!this.provenLaps.length || median(this.probeLaps) < median(this.provenLaps)) {
        this.bestMargin = this.margin;
        this.provenLaps = this.probeLaps;
        this.excursions = [];
        // A margin that pays off probes on in bigger steps again, so a few failures do not freeze the search.
        this.step = Math.min(PaceSearch.MAX_STEP, this.step * 1.25);
      } else {
        // Pushing harder did not pay off: back to the proven margin, probe more finely next time.
        this.margin = this.bestMargin;
        this.step = Math.max(0.01, this.step * 0.7);
      }
      this.probeLaps = [];
      return;
    }
    this.provenLaps.push(time);
    if (this.provenLaps.length > PaceSearch.PROVEN_LAPS) this.provenLaps.shift();
    this.noteExcursion(false);
    if (this.provenLaps.length >= PaceSearch.JUDGE_LAPS) this.startProbe();
  }

  /** Starts the probe again from the planner's own budget (the training supervisor's pace reset). */
  resetProbe(): void {
    this.margin = this.bestMargin = 1;
    this.ceiling = PaceSearch.MAX;
    this.step = 0.03;
    this.provenLaps = [];
    this.probeLaps = [];
    this.excursions = [];
  }

  /** Off-track, barrier or retirement by the car's own doing. */
  fail(): void {
    if (this.probing) {
      // The probed margin is too much: cap the search just below it and drive the proven one again.
      this.ceiling = Math.max(this.bestMargin, this.margin - 0.01);
      this.margin = this.bestMargin;
      this.probeLaps = [];
      this.step = Math.max(0.01, this.step * 0.8);
      return;
    }
    this.noteExcursion(true);
    if (this.excursions.filter(Boolean).length < PaceSearch.EXCURSION_LIMIT) return;
    // The proven margin keeps putting the car off: step back; laps at the old margin no longer compare.
    this.bestMargin = this.margin = Math.max(PaceSearch.MIN, this.bestMargin - PaceSearch.BACK_OFF);
    this.ceiling = Math.min(this.ceiling, Math.max(PaceSearch.MIN, this.bestMargin + PaceSearch.BACK_OFF - 0.01));
    this.provenLaps = [];
    this.excursions = [];
  }

  private noteExcursion(excursion: boolean): void {
    this.excursions.push(excursion);
    if (this.excursions.length > PaceSearch.EXCURSION_WINDOW) this.excursions.shift();
  }

  private startProbe(): void {
    const next = Math.min(this.ceiling, this.bestMargin + this.step);
    if (next > this.bestMargin + 1e-6) { this.margin = next; this.probeLaps = []; }
  }
}

