/**
 * Limit probing. A car that stays on the asphalt still has margin, so each clean lap
 * asks for slightly more cornering and braking; an excursion backs off and caps the search.
 */
export class PaceSearch {
  static readonly MIN = 0.9;
  static readonly MAX = 1.5;
  margin = 1;
  bestMargin = 1;
  ceiling = PaceSearch.MAX;
  private bestTime = Infinity;
  private step = 0.03;

  /** Margin used for planning: the proven one when racing, the probing one while training. */
  value(racing: boolean): number { return racing ? this.bestMargin : this.margin; }

  /** Called after every completed lap. `excursion` = the car left the asphalt or hit something by itself. */
  finishLap(time: number, clean: boolean, excursion: boolean): void {
    if (excursion) { this.fail(); return; }
    if (!clean || !Number.isFinite(time) || time <= 0) return;
    if (time < this.bestTime) {
      this.bestTime = time;
      this.bestMargin = this.margin;
      this.margin = Math.min(this.ceiling, this.margin + this.step);
    } else if (time > this.bestTime + 0.4) {
      // Pushing harder did not pay off: return to the proven margin and probe more finely.
      this.margin = this.bestMargin;
      this.step = Math.max(0.01, this.step * 0.7);
    } else {
      this.margin = Math.min(this.ceiling, this.margin + this.step * 0.5);
    }
    this.margin = Math.max(PaceSearch.MIN, Math.min(PaceSearch.MAX, this.margin));
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
