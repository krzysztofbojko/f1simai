/** Parts of the lap timed on their own: each corner (racing line, pace) is judged on its own clock. */
export const SECTIONS = 32;

/**
 * Lap-time share per kilogram of fuel above the reference load. A solo expert on Albert Park
 * (93 s flying lap) drives 0.024 s/kg slower: 2.2 s from 5 to 96 kg, more than corners differ by.
 * Training draws a random race load every reset, so section times are compared at one load.
 */
export const FUEL_TIME_SHARE_PER_KG = 2.6e-4;
/** Fuel load (kg) section times are corrected to. */
export const REFERENCE_FUEL_KG = 50;

/** Section of the lap a gate (or track point) index falls in. */
export function sectionOf(index: number, count: number): number {
  return Math.min(SECTIONS - 1, Math.floor(index / Math.max(1, count) * SECTIONS));
}

/** Section times of the lap in progress, from gate passages. */
export class SectionClock {
  /** Section times of the lap in progress (s); NaN where a section was not timed. */
  readonly lap = new Float64Array(SECTIONS).fill(NaN);
  private section = -1;
  private sectionStart = 0;

  /** The car was reset (respawn, grid): the lap in progress has no comparable section times. */
  reset(): void {
    this.lap.fill(NaN);
    this.section = -1;
    this.sectionStart = 0;
  }

  /**
   * The car cleared point `index` of `count` at `lapTime` seconds into its lap. With `fuelKg` the
   * finished section's time is corrected to the reference load.
   */
  pass(index: number, count: number, lapTime: number, fuelKg?: number): void {
    const section = sectionOf(index, count);
    if (section === this.section) return;
    const consecutive = this.section >= 0 && section === (this.section + 1) % SECTIONS;
    if (consecutive && Number.isFinite(lapTime)) {
      const time = lapTime - this.sectionStart;
      this.lap[this.section] = fuelKg === undefined ? time : time * (1 - FUEL_TIME_SHARE_PER_KG * (fuelKg - REFERENCE_FUEL_KG));
    } else if (this.section >= 0) this.lap.fill(NaN); // skipped part of the lap: no fair comparison
    this.section = section;
    this.sectionStart = section === 0 ? 0 : lapTime;
  }

  /** Section times of the finished lap; the clock starts the next lap empty. */
  take(): Float64Array {
    const sections = this.lap.slice();
    this.lap.fill(NaN);
    return sections;
  }
}
