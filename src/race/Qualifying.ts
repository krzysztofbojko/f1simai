/**
 * Knockout qualifying in the F1 format: three sessions (18, 15 and 12 minutes), the slowest
 * quarter of the field is eliminated after Q1 and after Q2, Q3 decides the top ten.
 *
 * Rules modelled:
 * - only the best complete lap of a session counts; the out-lap is never timed;
 * - a lap with a track-limits violation is deleted;
 * - a lap started before the chequered flag may be completed; the car then returns to the pits;
 * - equal times are separated by who set the time first;
 * - cars without a time are classified behind every car with one; after Q1 and Q2 a car without
 *   a valid lap in that session is always knocked out, even beyond the usual five;
 * - the 107% rule is reported from Q1 (stewards admit the car, it starts from the back).
 *
 * The class is pure bookkeeping: the simulation tells it about time, laps and retirements and
 * reads back which cars should be on track.
 */

export interface QualifyingDriver {
  color: string;
  driverName: string;
}

export type QualifyingPhase = 'session' | 'overtime' | 'break' | 'finished';

export interface QualifyingStanding {
  position: number;
  color: string;
  driverName: string;
  /** Best valid lap per session, `null` when no time was set (or the car did not take part). */
  times: (number | null)[];
  /** Session in which the driver was knocked out (1 or 2), 0 while still in contention or in the top ten. */
  eliminatedIn: number;
  /** Still running in the current session. */
  onTrack: boolean;
  /** Q1 time missing or slower than 107% of the fastest Q1 lap. */
  outside107: boolean;
  /** Gap to the fastest time of the session the ranking is based on. */
  gap: number | null;
}

interface Entry extends QualifyingDriver {
  order: number;
  times: (number | null)[];
  setAt: (number | null)[];
  eliminatedIn: number;
  /** Final position for eliminated cars, frozen when they drop out. */
  frozenPosition: number | null;
}

export class Qualifying {
  static readonly SESSION_SECONDS = [18 * 60, 15 * 60, 12 * 60];
  static readonly BREAK_SECONDS = 10;
  /** Longest a session may wait for cars finishing their last lap after the flag. */
  static readonly MAX_OVERTIME_SECONDS = 240;

  public session = 0;
  public phase: QualifyingPhase = 'session';
  /** Seconds elapsed in the current phase. */
  public clock = 0;
  /** Fastest valid Q1 lap, for the 107% rule. */
  public q1Best: number | null = null;

  private readonly entries: Entry[];
  private readonly sessionSeconds: number[];
  private readonly breakSeconds: number;
  /** Cars still running in the current session. */
  private readonly running = new Set<string>();
  /** Completed laps per car in the current session; the first one is the out-lap. */
  private readonly laps = new Map<string, number>();
  /** Cars eliminated after Q1 and after Q2. */
  private readonly eliminatedPerSession: number[];

  constructor(drivers: QualifyingDriver[], options: { sessionSeconds?: number[]; breakSeconds?: number } = {}) {
    this.entries = drivers.map((d, order) => ({
      ...d, order, times: [null, null, null], setAt: [null, null, null], eliminatedIn: 0, frozenPosition: null,
    }));
    this.sessionSeconds = options.sessionSeconds ?? Qualifying.SESSION_SECONDS;
    this.breakSeconds = options.breakSeconds ?? Qualifying.BREAK_SECONDS;
    // 20 cars: 5 + 5 out, ten in Q3 (22 cars: 6 + 6). Small test fields keep at least one car per session.
    const n = drivers.length;
    const out = Math.max(0, Math.min(Math.round(n / 4), Math.floor((n - 1) / 2)));
    this.eliminatedPerSession = [out, out];
    this.startSession(0);
  }

  /** Seconds left on the session clock (0 once the chequered flag is out). */
  get timeLeft(): number {
    if (this.phase === 'session') return Math.max(0, this.sessionSeconds[this.session] - this.clock);
    if (this.phase === 'break') return Math.max(0, this.breakSeconds - this.clock);
    return 0;
  }

  get isFinished(): boolean {
    return this.phase === 'finished';
  }

  /** Number of cars knocked out at the end of the given session (0-based; Q3 eliminates nobody). */
  eliminatedAfter(session: number): number {
    return this.eliminatedPerSession[session] ?? 0;
  }

  /** Cars that would be knocked out if the current session ended now: the slowest quota, or more without a time. */
  projectedEliminations(): number {
    if (this.session >= 2 || this.phase === 'finished') return 0;
    const active = this.entries.filter(e => e.eliminatedIn === 0);
    const withoutTime = active.filter(e => e.times[this.session] === null).length;
    return Math.min(active.length, Math.max(this.eliminatedAfter(this.session), withoutTime));
  }

  /** Colours of the cars that take part in the current session. */
  participants(): string[] {
    return this.entries.filter(e => e.eliminatedIn === 0).map(e => e.color);
  }

  isRunning(color: string): boolean {
    return (this.phase === 'session' || this.phase === 'overtime') && this.running.has(color);
  }

  /** Advances the clock. Returns true when a new session has just started. */
  step(dt: number): boolean {
    if (this.phase === 'finished') return false;
    this.clock += dt;
    if (this.phase === 'session' && this.clock >= this.sessionSeconds[this.session]) {
      this.phase = 'overtime';
      this.clock = 0;
    }
    if (this.phase === 'overtime' && (this.running.size === 0 || this.clock >= Qualifying.MAX_OVERTIME_SECONDS)) {
      this.endSession();
      return false;
    }
    if (this.phase === 'break' && this.clock >= this.breakSeconds) {
      this.startSession(this.session + 1);
      return true;
    }
    return false;
  }

  /**
   * A car crossed the line at the end of a complete lap. Returns true when the car has finished
   * its session (the lap was completed after the chequered flag) and should go back to the pits.
   */
  lapCompleted(color: string, lapTime: number, valid: boolean): boolean {
    if (!this.isRunning(color)) return false;
    const entry = this.entries.find(e => e.color === color);
    if (!entry) return false;
    const lap = (this.laps.get(color) ?? 0) + 1;
    this.laps.set(color, lap);
    const s = this.session;
    if (lap > 1 && valid && Number.isFinite(lapTime) && lapTime > 0) {
      const best = entry.times[s];
      if (best === null || lapTime < best) {
        entry.times[s] = lapTime;
        entry.setAt[s] = this.elapsedInSession();
      }
    }
    if (this.phase === 'overtime') {
      this.running.delete(color);
      return true;
    }
    return false;
  }

  /** The car stopped (crash, stuck, out of fuel): it keeps its time and takes no further part. */
  retire(color: string): void {
    this.running.delete(color);
  }

  /** Classification as it stands: the current session's order, then cars eliminated earlier. */
  standings(): QualifyingStanding[] {
    const ranked = this.rankActive();
    const eliminated = this.entries
      .filter(e => e.eliminatedIn > 0)
      .sort((a, b) => (a.frozenPosition ?? 0) - (b.frozenPosition ?? 0));
    const session = Math.min(this.session, 2);
    const fastest = ranked.length > 0 ? ranked[0].times[session] : null;
    const rows: QualifyingStanding[] = [];
    ranked.forEach((e, i) => rows.push(this.toStanding(e, i + 1, fastest, session)));
    eliminated.forEach(e => {
      const best = e.times[e.eliminatedIn - 1];
      const sessionFastest = this.sessionFastest(e.eliminatedIn - 1);
      rows.push({
        ...this.toStanding(e, e.frozenPosition ?? rows.length + 1, null, e.eliminatedIn - 1),
        gap: best !== null && sessionFastest !== null ? best - sessionFastest : null,
      });
    });
    return rows;
  }

  /** Starting order (colours, pole first). Valid once qualifying has finished. */
  grid(): string[] {
    return this.standings().map(s => s.color);
  }

  private toStanding(e: Entry, position: number, fastest: number | null, session: number): QualifyingStanding {
    const time = e.times[session];
    return {
      position,
      color: e.color,
      driverName: e.driverName,
      times: [...e.times],
      eliminatedIn: e.eliminatedIn,
      onTrack: this.isRunning(e.color),
      outside107: this.q1Best !== null && (e.times[0] === null || e.times[0] > this.q1Best * 1.07),
      gap: time !== null && fastest !== null ? time - fastest : null,
    };
  }

  private sessionFastest(session: number): number | null {
    const times = this.entries.map(e => e.times[session]).filter((t): t is number => t !== null);
    return times.length > 0 ? Math.min(...times) : null;
  }

  /** Cars still in contention ordered by this session's best lap; ties go to the earlier time. */
  private rankActive(): Entry[] {
    const s = Math.min(this.session, 2);
    return this.entries
      .filter(e => e.eliminatedIn === 0)
      .sort((a, b) => {
        const ta = a.times[s], tb = b.times[s];
        if (ta !== null && tb !== null) {
          if (ta !== tb) return ta - tb;
          return (a.setAt[s] ?? 0) - (b.setAt[s] ?? 0);
        }
        if (ta !== null) return -1;
        if (tb !== null) return 1;
        // No time in this session: fall back to the previous session's result, then entry order.
        const pa = s > 0 ? a.times[s - 1] : null, pb = s > 0 ? b.times[s - 1] : null;
        if (pa !== null && pb !== null && pa !== pb) return pa - pb;
        if (pa !== null && pb === null) return -1;
        if (pb !== null && pa === null) return 1;
        return a.order - b.order;
      });
  }

  private elapsedInSession(): number {
    return this.phase === 'overtime' ? this.sessionSeconds[this.session] + this.clock : this.clock;
  }

  private startSession(session: number): void {
    this.session = session;
    this.phase = 'session';
    this.clock = 0;
    this.running.clear();
    this.laps.clear();
    for (const color of this.participants()) this.running.add(color);
  }

  private endSession(): void {
    this.running.clear();
    if (this.session === 0) this.q1Best = this.sessionFastest(0);
    const ranked = this.rankActive();
    // Cars without a time rank last, so the eliminated block is always the tail of the order.
    const out = this.projectedEliminations();
    if (this.session < 2 && out > 0) {
      ranked.slice(ranked.length - out).forEach((e, i) => {
        e.eliminatedIn = this.session + 1;
        e.frozenPosition = ranked.length - out + i + 1;
      });
    }
    if (this.session >= 2 || this.participants().length === 0) {
      ranked.forEach((e, i) => { e.frozenPosition = i + 1; });
      this.phase = 'finished';
      this.clock = 0;
      return;
    }
    this.phase = 'break';
    this.clock = 0;
  }
}
