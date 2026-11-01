import type { Track } from '../track/Track';
import { CornerPhase } from '../track/TrackCorners';
import { FUEL_TIME_SHARE_PER_KG, REFERENCE_FUEL_KG } from './SectionClock';

/** What the car felt during one step of a corner pass (training only). */
export interface PassStep {
  dt: number;
  fuelKg: number;
  sliding: boolean;
  locked: boolean;
  /** Share of the friction circle in use (0..1+). */
  utilization: number;
  /** The guardian drove instead of the network. */
  guarded: boolean;
  /** The guardian braked because the car was far beyond the planned braking envelope. */
  emergencyBrake: boolean;
  /** Left the track or hit the barrier by itself (Car.markExcursion). */
  excursion: boolean;
  /** Planned overspeed (DrivePlan.overspeedDelta): above 0.2 the car arrives too fast. */
  overspeed: number;
  /** Nothing about this pass says anything about the limit (stress lap, contact, mistake, yellow, pits, traffic). */
  void: boolean;
}

interface Pass {
  corner: number;
  phase: CornerPhase;
  time: number;
  fuel: number;
  slide: number;
  lock: number;
  peak: number;
  /** Problems seen: in the arc or exit (guard, offArc, crash in it) and in the braking zone (emergency, offBrake, entry, crash in it). */
  guard: boolean;
  offArc: boolean;
  emergency: boolean;
  offBrake: boolean;
  entry: boolean;
  crashed: boolean;
  void: boolean;
}

/** Why passes of a corner were judged a problem (a pass may count under several). */
export const PROBLEM_REASONS = ['slide', 'lock', 'guard', 'offArc', 'offBrake', 'entry', 'emergency', 'crash'] as const;
export type ProblemReason = typeof PROBLEM_REASONS[number];

/** Per-corner learning record for the session log and diagnostics. */
export interface CornerReport {
  corner: number;
  brake: number;
  clean: number;
  problems: number;
  reasons: Record<ProblemReason, number>;
  /** Mean sliding (s) over judged passes without a problem: the corner's normal sliding. */
  cleanSlide: number;
  stepBacks: number;
  probeFails: number;
  timeReverts: number;
}

/**
 * One budget per corner (the planner's corner grip or its braking into the corner), searched by passes:
 * clean passes in a row raise it, a pass with a problem steps it back, and the corner time guards the raise.
 */
class LimitSearch {
  best: Float64Array;
  current: Float64Array;
  ceilings: Float64Array;
  private step: Float64Array;
  private streak: Int32Array;
  private probing: Uint8Array;
  /** Per corner: recent corner times at the proven budget and on the probe. */
  private before: number[][];
  private probe: number[][];
  /** Per corner: pass numbers of problems at the proven budget. */
  private problems: number[][];
  readonly clean: Int32Array;
  readonly failed: Int32Array;
  /** Proven budget stepped back after repeated problems, probes ended by a problem, probes ended by a slower time. */
  readonly stepBacks: Int32Array;
  readonly probeFails: Int32Array;
  readonly timeReverts: Int32Array;

  constructor(count: number, value: number, ceiling: number) {
    this.best = new Float64Array(count).fill(value);
    this.current = this.best.slice();
    this.ceilings = new Float64Array(count).fill(Math.max(ceiling, value));
    this.step = new Float64Array(count).fill(PaceSearch.START_STEP);
    this.streak = new Int32Array(count);
    this.probing = new Uint8Array(count);
    this.before = Array.from({ length: count }, () => []);
    this.probe = Array.from({ length: count }, () => []);
    this.problems = Array.from({ length: count }, () => []);
    this.clean = new Int32Array(count);
    this.failed = new Int32Array(count);
    this.stepBacks = new Int32Array(count);
    this.probeFails = new Int32Array(count);
    this.timeReverts = new Int32Array(count);
  }

  isProbing(c: number): boolean { return this.probing[c] === 1; }

  /** Ends any probe: the proven budgets are driven again. */
  settle(): void {
    this.current.set(this.best);
    this.probing.fill(0);
    this.probe.forEach(p => { p.length = 0; });
  }

  /**
   * A finished pass of corner `c`. `problem` = the limit was crossed here, `room` = the pass stayed well
   * inside it, `time` = the corner time (s, fuel corrected), `pass` = a running pass number. A probe
   * starts only with `mayProbe` (one budget of a corner is probed at a time).
   */
  record(c: number, problem: boolean, room: boolean, time: number, pass: number, mayProbe: boolean): void {
    if (problem) {
      this.failed[c]++;
      this.streak[c] = 0;
      if (this.isProbing(c)) {
        // Too much here: cap just below the probed budget and drive the proven one again.
        this.ceilings[c] = Math.max(this.best[c], this.current[c] - PaceSearch.CAP_MARGIN);
        this.endProbe(c);
        this.step[c] = Math.max(PaceSearch.MIN_STEP, this.step[c] * 0.5);
        this.probeFails[c]++;
        return;
      }
      const recent = this.problems[c].filter(n => n > pass - PaceSearch.PROBLEM_WINDOW);
      recent.push(pass);
      this.problems[c] = recent;
      if (recent.length < PaceSearch.PROBLEM_LIMIT) return;
      // The proven budget keeps crossing the limit: step it back.
      const back = PaceSearch.clamp(this.best[c] - this.step[c]);
      this.ceilings[c] = Math.min(this.ceilings[c], Math.max(back, this.best[c] - PaceSearch.CAP_MARGIN));
      this.best[c] = this.current[c] = back;
      this.stepBacks[c]++;
      this.problems[c] = [];
      this.before[c] = [];
      return;
    }
    this.clean[c]++;
    this.ceilings[c] = Math.min(PaceSearch.MAX, this.ceilings[c] + PaceSearch.CEILING_RELAX);
    if (this.isProbing(c)) {
      const probe = this.probe[c];
      probe.push(time);
      if (probe.length < PaceSearch.PROBE_PASSES) return;
      const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
      const before = this.before[c];
      if (!before.length || mean(probe) <= mean(before) + PaceSearch.TIME_TOLERANCE) {
        this.best[c] = this.current[c];
        this.step[c] = Math.min(PaceSearch.MAX_STEP, this.step[c] * 1.25);
        this.before[c] = probe.slice(-PaceSearch.PROBE_PASSES);
        this.probing[c] = 0;
        probe.length = 0;
      } else {
        // Faster into the corner but slower through it: the raise spoils the exit.
        this.ceilings[c] = Math.max(this.best[c], this.current[c] - PaceSearch.CAP_MARGIN);
        this.endProbe(c);
        this.step[c] = Math.max(PaceSearch.MIN_STEP, this.step[c] * 0.5);
        this.timeReverts[c]++;
      }
      return;
    }
    this.before[c].push(time);
    if (this.before[c].length > PaceSearch.PROBE_PASSES) this.before[c].shift();
    // Near the limit already: no raise, but no verdict against it either.
    if (!room) { this.streak[c] = 0; return; }
    this.streak[c]++;
    if (this.streak[c] < PaceSearch.CLEAN_PASSES || !mayProbe) return;
    const next = Math.min(this.ceilings[c], this.best[c] + this.step[c]);
    if (next <= this.best[c] + 1e-6) return;
    this.current[c] = next;
    this.probing[c] = 1;
    this.streak[c] = 0;
  }

  private endProbe(c: number): void {
    this.current[c] = this.best[c];
    this.probing[c] = 0;
    this.probe[c] = [];
    this.streak[c] = 0;
  }
}

/**
 * Limit probing, corner by corner (Track.corners: braking zone → arc → exit). Every corner has its own
 * grip budget for the arc and for the braking into it, multipliers of the planner's budgets (0.9..1.15).
 * The verdict is the pass itself, not a noisy lap time: a corner passed cleanly with room to spare twice
 * in a row is driven a step faster; a slide, an excursion or the guardian taking over in it (or locked
 * wheels, emergency braking, arriving too fast in its braking zone) steps that budget back and caps it.
 * A raise that makes the corner slower (it spoils the exit) goes back too. Learning runs in training
 * only; qualifying and the race drive the proven budgets.
 */
export class PaceSearch {
  static readonly MIN = 0.9;
  /** The planner already budgets most of the grip including downforce: probing only trims it. */
  static readonly MAX = 1.15;
  static readonly START_STEP = 0.02;
  static readonly MAX_STEP = 0.03;
  static readonly MIN_STEP = 0.005;
  /** Clean passes with room in a row before a budget is raised. */
  static readonly CLEAN_PASSES = 2;
  /** Passes a raised budget is driven before its time is judged. */
  static readonly PROBE_PASSES = 3;
  /** A raise may cost this much corner time (s, mean over the probe passes) before it goes back: the passes' noise. */
  static readonly TIME_TOLERANCE = 0.1;
  /** A pass that used more of the friction circle than this had no room to spare. */
  static readonly ROOM_UTILIZATION = 0.92;
  /**
   * Sliding (s) in a corner's arc or exit that counts as crossing its limit: at least SLIDE_LIMIT and
   * SLIDE_FACTOR times the corner's typical sliding. Tyres slide a little at the limit in every fast
   * corner; only a pass that slides clearly more than the corner usually does lost the car.
   */
  static readonly SLIDE_LIMIT = 0.3;
  static readonly SLIDE_FACTOR = 2;
  /** Weight of a new pass in a corner's typical sliding. */
  static readonly SLIDE_SMOOTHING = 0.1;
  /** Locked wheels (s) in a braking zone that count as crossing the braking limit. */
  static readonly LOCK_LIMIT = 0.15;
  /** Overspeed entering the arc above which the braking came too late. */
  static readonly ENTRY_OVERSPEED = 0.2;
  /** Problems at the proven budget within the last PROBLEM_WINDOW passes of a corner that step it back. */
  static readonly PROBLEM_LIMIT = 2;
  static readonly PROBLEM_WINDOW = 6;
  /** A failed probe caps the budget this far below it. */
  static readonly CAP_MARGIN = 0.005;
  /** A capped ceiling relaxes by this much per clean pass, so one unlucky pass does not cap a corner for good. */
  static readonly CEILING_RELAX = 0.002;

  static clamp(v: number): number { return Math.max(PaceSearch.MIN, Math.min(PaceSearch.MAX, v)); }

  private cornerSearch = new LimitSearch(0, 1, PaceSearch.MAX);
  private brakeSearch = new LimitSearch(0, 1, PaceSearch.MAX);
  /** Value every corner starts from until a track binds it (a save from before the corners, a setter). */
  private uniform = 1;
  private uniformCeiling = PaceSearch.MAX;
  private saved: any = null;
  private open: Pass | null = null;
  private passes = 0;
  private reasons: Record<ProblemReason, Int32Array> = PaceSearch.emptyReasons(0);
  private cleanSlideSum = new Float64Array(0);
  private cleanSlideCount = new Int32Array(0);
  /** Per corner: running mean of the sliding (s) of its judged passes, what driving it at the limit normally costs. */
  private typicalSlide = new Float64Array(0);

  private static emptyReasons(count: number): Record<ProblemReason, Int32Array> {
    return Object.fromEntries(PROBLEM_REASONS.map(r => [r, new Int32Array(count)])) as Record<ProblemReason, Int32Array>;
  }

  get corners(): number { return this.cornerSearch.best.length; }

  /** Sizes the search to a track's corners; a different corner count (another track) starts afresh. */
  bind(count: number): void {
    if (count === this.corners) return;
    const saved = this.saved?.corners === count ? this.saved : null;
    this.cornerSearch = new LimitSearch(count, this.uniform, this.uniformCeiling);
    this.brakeSearch = new LimitSearch(count, this.uniform, this.uniformCeiling);
    if (saved) {
      const load = (search: LimitSearch, values: unknown, ceilings: unknown) => {
        if (!Array.isArray(values) || values.length !== count) return;
        values.forEach((v, i) => { if (typeof v === 'number' && Number.isFinite(v)) search.best[i] = search.current[i] = PaceSearch.clamp(v); });
        if (Array.isArray(ceilings) && ceilings.length === count) ceilings.forEach((v, i) => {
          if (typeof v === 'number' && Number.isFinite(v)) search.ceilings[i] = Math.max(search.best[i], PaceSearch.clamp(v));
        });
      };
      load(this.cornerSearch, saved.corner, saved.cornerCeilings);
      load(this.brakeSearch, saved.brake, saved.brakeCeilings);
    }
    this.reasons = PaceSearch.emptyReasons(count);
    this.cleanSlideSum = new Float64Array(count);
    this.cleanSlideCount = new Int32Array(count);
    this.typicalSlide = new Float64Array(count).fill(NaN);
    this.open = null;
  }

  private static mean(values: Float64Array, fallback: number): number {
    if (!values.length) return fallback;
    return values.every(v => v === values[0]) ? values[0] : values.reduce((a, b) => a + b, 0) / values.length;
  }

  /** Mean corner budget driven now (statistics, the supervisor). Setting it sets every corner. */
  get margin(): number { return PaceSearch.mean(this.cornerSearch.current, this.uniform); }
  set margin(v: number) { this.uniform = v; this.cornerSearch.current.fill(v); }
  /** Mean proven corner budget. Setting it sets every corner. */
  get bestMargin(): number { return PaceSearch.mean(this.cornerSearch.best, this.uniform); }
  set bestMargin(v: number) { this.uniform = v; this.cornerSearch.best.fill(v); }
  get ceiling(): number { return PaceSearch.mean(this.cornerSearch.ceilings, this.uniformCeiling); }
  set ceiling(v: number) { this.uniformCeiling = v; this.cornerSearch.ceilings.fill(v); }

  /** Lowest and highest proven corner budget. */
  range(): [number, number] {
    const best = this.cornerSearch.best;
    return best.length ? [Math.min(...best), Math.max(...best)] : [this.uniform, this.uniform];
  }

  get probing(): boolean {
    for (let c = 0; c < this.corners; c++) if (this.cornerSearch.isProbing(c) || this.brakeSearch.isProbing(c)) return true;
    return false;
  }

  /** Grip budget multiplier of corner `c` (-1 = no corner): the proven one when racing, the probing one while training. */
  cornerMargin(c: number, racing: boolean): number {
    if (c < 0 || c >= this.corners) return 1;
    return (racing ? this.cornerSearch.best : this.cornerSearch.current)[c];
  }

  brakeMargin(c: number, racing: boolean): number {
    if (c < 0 || c >= this.corners) return 1;
    return (racing ? this.brakeSearch.best : this.brakeSearch.current)[c];
  }

  /** Mean margin for planning outside the corners. */
  value(racing: boolean): number { return racing ? this.bestMargin : this.margin; }

  /** Per-corner state for the session log. */
  cornerReport(): CornerReport[] {
    const a = this.cornerSearch, b = this.brakeSearch;
    return Array.from({ length: this.corners }, (_, c) => ({ corner: a.best[c], brake: b.best[c],
      clean: a.clean[c], problems: a.failed[c] + b.failed[c],
      reasons: Object.fromEntries(PROBLEM_REASONS.map(r => [r, this.reasons[r][c]])) as Record<ProblemReason, number>,
      cleanSlide: this.cleanSlideCount[c] ? this.cleanSlideSum[c] / this.cleanSlideCount[c] : 0,
      stepBacks: a.stepBacks[c] + b.stepBacks[c], probeFails: a.probeFails[c] + b.probeFails[c], timeReverts: a.timeReverts[c] + b.timeReverts[c] }));
  }

  toJSON(): { margin: number; bestMargin: number; ceiling: number; corners: number; corner: number[]; cornerCeilings: number[]; brake: number[]; brakeCeilings: number[] } {
    return { margin: this.bestMargin, bestMargin: this.bestMargin, ceiling: this.ceiling, corners: this.corners,
      corner: Array.from(this.cornerSearch.best), cornerCeilings: Array.from(this.cornerSearch.ceilings),
      brake: Array.from(this.brakeSearch.best), brakeCeilings: Array.from(this.brakeSearch.ceilings) };
  }

  fromJSON(data: any): void {
    const clamp = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) ? PaceSearch.clamp(v) : fallback;
    // A save from before the corners drives its one margin in every corner.
    this.uniform = clamp(data?.bestMargin, clamp(data?.margin, 1));
    this.uniformCeiling = Math.max(this.uniform, clamp(data?.ceiling, PaceSearch.MAX));
    this.saved = typeof data?.corners === 'number' ? data : null;
    const count = this.corners;
    this.cornerSearch = new LimitSearch(0, this.uniform, this.uniformCeiling);
    this.brakeSearch = new LimitSearch(0, this.uniform, this.uniformCeiling);
    this.bind(count);
  }

  /** Starts the search again from the planner's own budgets (the training supervisor's pace reset). */
  resetProbe(): void {
    const count = this.corners;
    this.uniform = 1;
    this.uniformCeiling = PaceSearch.MAX;
    this.saved = null;
    this.cornerSearch = new LimitSearch(0, 1, PaceSearch.MAX);
    this.brakeSearch = new LimitSearch(0, 1, PaceSearch.MAX);
    this.bind(count);
  }

  /** The car was reset (respawn, grid): a pass in progress says nothing. */
  resetTiming(): void { this.open = null; }

  /**
   * One planner step of a training car at track point `index`. Passes run from a corner's braking zone
   * (or its arc, when it has none) to the end of its exit; a pass joined halfway is not judged.
   */
  observe(track: Track, index: number, s: PassStep): void {
    const { zone, phase } = track.corners;
    this.bind(track.corners.corners.length);
    const c = zone[index] ?? -1, p = (phase[index] ?? 0) as CornerPhase;
    let pass = this.open;
    if (pass && (c !== pass.corner || p < pass.phase)) {
      if (pass.phase === CornerPhase.Exit) this.close(pass);
      pass = this.open = null;
    }
    if (c < 0) return;
    if (!pass) {
      const first = track.corners.corners[c].brakeStart === track.corners.corners[c].arcStart ? CornerPhase.Arc : CornerPhase.Brake;
      if (p !== first) return;
      pass = this.open = { corner: c, phase: p, time: 0, fuel: s.fuelKg, slide: 0, lock: 0, peak: 0,
        guard: false, offArc: false, emergency: false, offBrake: false, entry: false, crashed: false, void: false };
    }
    if (p === CornerPhase.Arc && pass.phase === CornerPhase.Brake && s.overspeed > PaceSearch.ENTRY_OVERSPEED) pass.entry = true;
    pass.phase = p;
    pass.time += s.dt;
    if (s.void) pass.void = true;
    if (p === CornerPhase.Brake) {
      if (s.locked) pass.lock += s.dt;
      if (s.emergencyBrake) pass.emergency = true;
      // Off the road while braking: the braking came too late.
      if (s.excursion) pass.offBrake = true;
    } else {
      if (s.sliding) pass.slide += s.dt;
      pass.peak = Math.max(pass.peak, s.utilization);
      if (s.guarded) pass.guard = true;
      if (s.excursion) pass.offArc = true;
    }
  }

  /** The car crashed out by its own doing: the corner it was in crossed its limit. */
  crash(): void {
    const pass = this.open;
    this.open = null;
    if (!pass || pass.void) return;
    pass.crashed = true;
    this.judge(pass);
  }

  private close(pass: Pass): void {
    if (!pass.void) this.judge(pass);
  }

  private judge(pass: Pass): void {
    const c = pass.corner, n = ++this.passes;
    const time = pass.time * (1 - FUEL_TIME_SHARE_PER_KG * (pass.fuel - REFERENCE_FUEL_KG));
    const crashInArc = pass.crashed && pass.phase !== CornerPhase.Brake, crashInBrake = pass.crashed && pass.phase === CornerPhase.Brake;
    const typical = this.typicalSlide[c];
    const slideLimit = Math.max(PaceSearch.SLIDE_LIMIT, Number.isFinite(typical) ? PaceSearch.SLIDE_FACTOR * typical : 0);
    if (!pass.crashed) this.typicalSlide[c] = Number.isFinite(typical) ? typical + (pass.slide - typical) * PaceSearch.SLIDE_SMOOTHING : pass.slide;
    const why: Record<ProblemReason, boolean> = {
      slide: pass.slide > slideLimit, lock: pass.lock > PaceSearch.LOCK_LIMIT, guard: pass.guard, offArc: pass.offArc,
      offBrake: pass.offBrake, entry: pass.entry, emergency: pass.emergency, crash: pass.crashed,
    };
    const arcProblem = why.slide || why.guard || why.offArc || crashInArc;
    const brakeProblem = why.lock || why.offBrake || why.entry || why.emergency || crashInBrake;
    for (const r of PROBLEM_REASONS) if (why[r]) this.reasons[r][c]++;
    if (!arcProblem && !brakeProblem) { this.cleanSlideSum[c] += pass.slide; this.cleanSlideCount[c]++; }
    const room = pass.peak < PaceSearch.ROOM_UTILIZATION;
    // A probed budget takes the blame for any problem of the pass: braking later makes the car arrive
    // faster (a slide in the arc), a faster arc moves the braking later (locked wheels). The other
    // budget learns nothing from a pass driven with a probe.
    if (this.cornerSearch.isProbing(c)) this.cornerSearch.record(c, arcProblem || brakeProblem, room, time, n, false);
    else if (this.brakeSearch.isProbing(c)) this.brakeSearch.record(c, arcProblem || brakeProblem, room, time, n, false);
    else {
      // Each budget learns from its own part of the corner.
      this.cornerSearch.record(c, arcProblem, room && !brakeProblem, time, n, true);
      if (!this.cornerSearch.isProbing(c)) this.brakeSearch.record(c, brakeProblem, room && !arcProblem && pass.lock === 0, time, n, true);
    }
  }
}
