/**
 * Limit probing. A car that stays on the asphalt still has margin, so each clean lap
 * asks for slightly more cornering and braking; an excursion backs off and caps the search.
 */
export class PaceSearch {
  static readonly MIN = 0.9;
  /** The planner already budgets most of the grip including downforce: probing only trims it. */
  static readonly MAX = 1.15;
  /**
   * A lap this much slower than the best (share of it) failed. Training laps carry a random fuel load
   * worth a few per cent of lap time, so a fixed few tenths would call most of them failures.
   */
  static readonly SLOWER_SHARE = 0.03;
  static readonly MAX_STEP = 0.05;
  margin = 1;
  bestMargin = 1;
  ceiling = PaceSearch.MAX;
  private bestTime = Infinity;
  private step = 0.03;

  toJSON(): { margin: number; bestMargin: number; ceiling: number; bestTime: number | null; step: number } {
    return { margin: this.margin, bestMargin: this.bestMargin, ceiling: this.ceiling, bestTime: Number.isFinite(this.bestTime) ? this.bestTime : null, step: this.step };
  }

  fromJSON(data: any): void {
    const clamp = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(PaceSearch.MIN, Math.min(PaceSearch.MAX, v)) : fallback;
    this.margin = clamp(data?.margin, 1);
    this.bestMargin = clamp(data?.bestMargin, this.margin);
    this.ceiling = clamp(data?.ceiling, PaceSearch.MAX);
    this.bestTime = typeof data?.bestTime === 'number' && data.bestTime > 0 ? data.bestTime : Infinity;
    this.step = typeof data?.step === 'number' ? Math.max(0.01, Math.min(PaceSearch.MAX_STEP, data.step)) : 0.03;
  }

  /** Margin used for planning: the proven one when racing, the probing one while training. */
  value(racing: boolean): number { return racing ? this.bestMargin : this.margin; }

  /** Called after every completed lap. `excursion` = the car left the asphalt or hit something by itself (not after contact with another car). */
  finishLap(time: number, clean: boolean, excursion: boolean): void {
    if (excursion) { this.fail(); return; }
    if (!clean || !Number.isFinite(time) || time <= 0) return;
    if (time < this.bestTime) {
      this.bestTime = time;
      this.bestMargin = this.margin;
      // A margin that pays off probes on in bigger steps again, so a few failures do not freeze the search.
      this.step = Math.min(PaceSearch.MAX_STEP, this.step * 1.25);
      this.margin = Math.min(this.ceiling, this.margin + this.step);
    } else if (time > this.bestTime * (1 + PaceSearch.SLOWER_SHARE)) {
      // Pushing harder did not pay off: return to the proven margin and probe more finely.
      this.margin = this.bestMargin;
      this.step = Math.max(0.01, this.step * 0.7);
    } else {
      this.margin = Math.min(this.ceiling, this.margin + this.step * 0.5);
    }
    this.margin = Math.max(PaceSearch.MIN, Math.min(PaceSearch.MAX, this.margin));
  }

  /** Starts the probe again from the planner's own budget (the training supervisor's pace reset). */
  resetProbe(): void {
    this.margin = this.bestMargin = 1;
    this.ceiling = PaceSearch.MAX;
    this.bestTime = Infinity;
    this.step = 0.03;
  }

  /** Off-track, barrier or retirement: step back and do not return to the failing level. */
  fail(): void {
    this.ceiling = Math.max(PaceSearch.MIN, this.margin - 0.02);
    this.margin = Math.max(PaceSearch.MIN, this.margin - 0.06);
    this.bestMargin = Math.min(this.bestMargin, this.margin);
    this.bestTime = Infinity; // times at the old margin are no longer comparable
    this.step = Math.max(0.01, this.step * 0.8);
    // The ceiling relaxes slowly so the search can recover from one unlucky lap.
    this.ceiling = Math.min(PaceSearch.MAX, this.ceiling + 0.02);
  }
}
