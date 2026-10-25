import { Car, type LapFinishEvent } from '../physics/Car';
import type { Population } from '../ai/Population';
import type { Track } from '../track/Track';
import type { Weather } from '../physics/Weather';
import { startingDryCompound, weatherCompound, type TyreCompound } from '../physics/Tyres';
import { Qualifying, type QualifyingPhase, type QualifyingStanding } from './Qualifying';
import { FUEL_MARGIN, FUEL_PER_METRE, FUEL_RESERVE_KG, planRaceFuel } from './RaceFuel';

export type RaceState = 'IDLE' | 'QUALIFYING' | 'QUALI_FINISHED' | 'GRID_START' | 'RACING' | 'FINISHED';

export interface QualifyingSnapshot {
  /** 0 = Q1, 1 = Q2, 2 = Q3. */
  session: number;
  phase: QualifyingPhase;
  timeLeft: number;
  /** Cars knocked out if the session ended now: the slowest five, or more when cars have no time. */
  eliminatedAfter: number;
  standings: QualifyingStanding[];
}

/** The quickest pit stop of a race: entry line to exit line. */
export interface FastestPitStop {
  driverName: string;
  carColor: string;
  laneTime: number;
  serviceTime: number;
  lap: number;
}

export interface RaceStanding {
  rank: number;
  driverName: string;
  carColor: string;
  lapsCompleted: number;
  gap: string;
  gapToLeader: string;
  gapToPrevious: string;
  pitStops: number;
  trackLimitExits: number;
  isPitting: boolean;
  isAlive: boolean;
  bestLap: number | null;
  lastLap: number | null;
  totalTime: number;
  isPlayer: boolean;
  /** Took the chequered flag (with `lapsCompleted` laps). */
  finished: boolean;
}

/** What the session reads from the simulation around it; the worker swaps track and field. */
export interface SessionContext {
  readonly population: Population;
  readonly track: Track;
  readonly weather: Weather;
  /** The player's own car while they drive it (a team car they took over is in the field). */
  readonly playerCar: Car | null;
  /** Colour of the team car the player drives, if any. */
  readonly manualCarColor: string | null;
}

export interface RaceStartOptions {
  totalLaps?: number;
  withQualifying?: boolean;
  useQualifyingGrid?: boolean;
  /** Q1–Q3 lengths; tests may shorten them. */
  qualifyingSessionSeconds?: unknown;
  weatherSeed: number;
}

/** Before a physics step: run it, skip it (lights, garage, break) or end the tick. */
export type StepPhase = 'run' | 'skip' | 'halt';

/**
 * Race weekend state without any worker plumbing: qualifying with its garage releases, the
 * start lights, the race classification, the session-best sectors. The worker calls it around
 * each physics step and serializes what it reports.
 */
export class RaceSession {
  /**
   * Qualifying fuel, topped up on every lap: the garage visits between runs, where real cars take
   * fuel, are not modelled. Pit stops never refuel.
   */
  static readonly QUALI_FUEL_KG = 20;
  /** Seconds between cars leaving the garage. */
  static readonly QUALI_RELEASE_INTERVAL = 1.5;
  /**
   * After the chequered flag the race ends when every running car has crossed the line, or after
   * this many of the winner's last lap: a car stopped on the circuit is classified where it stands.
   */
  static readonly CHEQUERED_TIMEOUT_LAPS = 1.5;
  /** Race fuel constants (see `RaceFuel.ts`, shared with training). */
  static readonly FUEL_MARGIN = FUEL_MARGIN;
  static readonly FUEL_RESERVE_KG = FUEL_RESERVE_KG;
  static readonly FUEL_PER_METRE = FUEL_PER_METRE;

  state: RaceState = 'IDLE';
  totalLaps = 50;
  currentLap = 1;
  /** 0: off, 1..5: red lights, -1: lights out. */
  startLights = 0;
  winner: string | null = null;
  /** Fuel every car starts the race with, kg. */
  raceFuelKg = 0;
  /** Laps asked for; `totalLaps` is shorter when the tank cannot cover them. */
  requestedLaps = 50;
  /**
   * The winner has taken the chequered flag: from then on every car finishes at its next crossing
   * of the line, lapped cars a lap or more down.
   */
  chequered = false;
  qualifying: Qualifying | null = null;
  /** Starting order from the last qualifying, used by the next race start. */
  qualifyingGrid: string[] | null = null;
  /** The player's compound: fitted at the start and at every stop of their car. */
  playerCompound: TyreCompound = 'medium';
  /** Fastest valid time of each of the four sectors in this session. */
  sessionBestSectors: (number | null)[] = [null, null, null, null];
  /** Quickest stop of the current race (null before the first one). */
  fastestPitStop: FastestPitStop | null = null;

  private startTimer = 0;
  private lastDt = 1 / 60;
  /** Seconds since the chequered flag. */
  private chequeredTime = 0;
  /** Race clock when the winner crossed the line; cars crossing it before that still have a lap to go. */
  private flagTime = Infinity;
  private winnerCar: Car | null = null;
  /** Cars that crossed the line in this step (race only); the flag is decided once the step is over. */
  private readonly lineCrossings: Car[] = [];
  private frozenStandings: RaceStanding[] | null = null;
  private readonly qualiRelease = new Map<Car, { delay: number; slot: number }>();
  private readonly qualiLapStartExits = new Map<Car, number>();

  constructor(private readonly ctx: SessionContext) {}

  /** Every car taking part: the field plus the player's own car. */
  cars(): Car[] {
    const player = this.ctx.playerCar;
    return player ? [...this.ctx.population.cars, player] : [...this.ctx.population.cars];
  }

  /** The car the player drives: their own car, or a team car they took over. */
  isPlayerCar(car: Car): boolean {
    return car === this.ctx.playerCar || (!!this.ctx.manualCarColor && car.color === this.ctx.manualCarColor);
  }

  resetSectors(): void {
    this.sessionBestSectors = [null, null, null, null];
  }

  /** Any session ends; back to training. */
  clear(): void {
    this.state = 'IDLE';
    this.qualifying = null;
    this.qualifyingGrid = null;
    this.qualiRelease.clear();
    this.resetRaceFinish();
    this.resetSectors();
  }

  private resetRaceFinish(): void {
    this.winner = null;
    this.winnerCar = null;
    this.chequered = false;
    this.chequeredTime = 0;
    this.flagTime = Infinity;
    this.lineCrossings.length = 0;
    this.frozenStandings = null;
  }

  /** Qualifying (when asked for) or the race from the grid; the weather starts again from its forecast. */
  start(options: RaceStartOptions): void {
    const { population, track, weather } = this.ctx;
    this.requestedLaps = Math.max(10, Math.min(200, options.totalLaps || 50));
    this.planRaceFuel();
    this.resetRaceFinish();
    this.resetSectors();
    this.fastestPitStop = null;
    population.isRaceMode = true;
    weather.reset(weather.scenario, options.weatherSeed);
    population.setConditions(weather.conditions);
    // Race and qualifying use each driver's protected best network, not the one still learning.
    this.equipBestBrains();

    if (options.withQualifying) {
      this.state = 'QUALIFYING';
      this.qualifyingGrid = null;
      const seconds = options.qualifyingSessionSeconds;
      const sessionSeconds = Array.isArray(seconds) && seconds.length === 3 && seconds.every(t => typeof t === 'number' && t > 0)
        ? seconds as number[] : undefined;
      this.qualifying = new Qualifying(this.cars().map(c => ({ color: c.color, driverName: c.driverName })), { sessionSeconds });
      this.startQualifyingSession();
      return;
    }

    this.state = 'GRID_START';
    this.currentLap = 1;
    this.startLights = 0;
    this.startTimer = 0;
    // Starting order: the qualifying result when the race follows qualifying, otherwise the entry list.
    const entrants = this.cars();
    const grid = options.useQualifyingGrid ? this.qualifyingGrid : null;
    const order = grid
      ? [...grid.map(color => entrants.find(c => c.color === color)).filter((c): c is Car => !!c),
         ...entrants.filter(c => !grid.includes(c.color))]
      : entrants;
    this.qualifying = null;
    this.qualiRelease.clear();
    order.forEach((car, i) => {
      car.isRaceMode = true;
      const slot = track.getGridSlot(i);
      car.reset(slot.pos, slot.heading, true, (slot.checkpointIdx + 1) % track.checkpoints.length);
      car.updateDimensionsForTrackWidth(track.width);
      this.fitStartingTyres(car, i);
      car.fuelKg = this.raceFuelKg;
      car.lapStartFuel = car.fuelKg;
      car.raceDistanceLaps = this.totalLaps;
      car.pitStopsCount = 0;
      car.trackLimitExits = 0;
      car.raceLapsCompleted = 0;
      car.totalRaceTime = 0;
      car.isAlive = true;
      car.isPitting = false;
      car.pitPhase = '';
      car.pitShowTimer = 0;
      car.wantsToPit = false;
    });
  }

  /** Back to training: every car on its grid slot with its best network and the training fuel. */
  stop(): void {
    const { population, track } = this.ctx;
    this.clear();
    population.isRaceMode = false;
    for (let i = 0; i < population.cars.length; i++) {
      const car = population.cars[i];
      const record = population.teamRecords[i];
      car.isRaceMode = false;
      if (record && record.bestBrain && !car.isManual) {
        car.brain = record.bestBrain.clone();
        car.safeBrainBackup = record.bestBrain.clone();
        car.safeBrainPressure = record.bestLapPressure ?? 0;
      }
      const slot = track.getGridSlot(i);
      car.reset(slot.pos, slot.heading, true, (slot.checkpointIdx + 1) % track.checkpoints.length);
      car.updateDimensionsForTrackWidth(track.width);
      car.fuelKg = population.startingFuelKg;
      car.isAlive = true;
      car.pitStopsCount = 0;
      car.trackLimitExits = 0;
      car.raceLapsCompleted = 0;
      car.totalRaceTime = 0;
      car.isPitting = false;
      car.pitPhase = '';
      car.pitShowTimer = 0;
      car.wantsToPit = false;
    }
    const player = this.ctx.playerCar;
    if (player) {
      player.isRaceMode = false;
      const slot = track.getGridSlot(population.cars.length);
      player.reset(slot.pos, slot.heading, true, (slot.checkpointIdx + 1) % track.checkpoints.length);
      player.updateDimensionsForTrackWidth(track.width);
      player.fuelKg = population.startingFuelKg;
      player.isAlive = true;
    }
  }

  /** Called before every physics step. */
  beforeStep(dt: number): StepPhase {
    this.lastDt = dt;
    if (this.state === 'QUALIFYING' && !this.stepQualifying(dt)) return this.state === 'QUALIFYING' ? 'skip' : 'halt';
    if (this.state === 'GRID_START') {
      this.startTimer += dt;
      const t = this.startTimer;
      this.startLights = t < 0.8 ? 0 : t < 1.6 ? 1 : t < 2.4 ? 2 : t < 3.2 ? 3 : t < 4.0 ? 4 : t < 5.2 ? 5 : -1;
      if (this.startLights === -1) this.state = 'RACING';
      // The field waits on the grid.
      for (const car of this.cars()) {
        car.vel.set(0, 0);
        car.speed = 0;
        car.speedKmh = 0;
      }
      return 'skip';
    }
    return 'run';
  }

  /** Called after every physics step; true when the session has just ended and stepping should stop. */
  afterStep(): boolean {
    for (const car of this.cars()) {
      this.recordSector(car);
      this.recordPitStop(car);
    }
    if (this.state === 'QUALIFYING') this.retireStoppedQualifiers();
    if (this.state !== 'RACING') return false;
    this.takeLineCrossings();
    let maxLaps = 0;
    let running = 0;
    const cars = this.cars();
    for (const c of cars) {
      if (c.isAlive && !c.isFinishedRace) running++;
      if (c.raceLapsCompleted > maxLaps) maxLaps = c.raceLapsCompleted;
    }
    this.currentLap = Math.min(this.totalLaps, maxLaps + 1);
    if (this.chequered) {
      this.chequeredTime += this.lastDt;
      const winner = this.winnerCar;
      const lap = winner?.lastLapTime ?? winner?.bestLapTime ?? (winner && winner.raceLapsCompleted > 0 ? winner.totalRaceTime / winner.raceLapsCompleted : 120);
      if (running > 0 && this.chequeredTime < RaceSession.CHEQUERED_TIMEOUT_LAPS * lap) return false;
    } else if (running === 0) {
      this.winner = 'BRAK (WSZYSCY ROZBICI - DNF)';
    } else return false;
    this.state = 'FINISHED';
    this.frozenStandings = this.calculateStandings();
    return true;
  }

  /**
   * Lines crossed in the last step. The first car to complete the race distance (the smallest
   * interpolated race time, not the first in the field's order) takes the chequered flag; every
   * car crossing the line from that moment on finishes, with the laps it has.
   */
  private takeLineCrossings(): void {
    const crossings = this.lineCrossings;
    if (!crossings.length) return;
    if (!this.chequered) {
      for (const car of crossings) {
        if (car.raceLapsCompleted >= this.totalLaps && car.lineCrossingRaceTime < this.flagTime) {
          this.flagTime = car.lineCrossingRaceTime;
          this.winnerCar = car;
        }
      }
      if (this.winnerCar) {
        this.chequered = true;
        this.chequeredTime = 0;
        this.winner = this.winnerCar.driverName;
      }
    }
    if (this.chequered) {
      for (const car of crossings) if (!car.isFinishedRace && car.lineCrossingRaceTime >= this.flagTime) this.finish(car);
    }
    crossings.length = 0;
  }

  /** The car takes the flag: its race time stops where it met the line. It drives on, out of the race. */
  private finish(car: Car): void {
    car.isFinishedRace = true;
    car.totalRaceTime = car.lineCrossingRaceTime;
  }

  /**
   * A completed lap. In the race it is a crossing of the line (the flag is decided after the step);
   * in qualifying it is timed, and a lap after the session's flag sends the car back to the garage.
   */
  onLapCompleted(car: Car, event: Pick<LapFinishEvent, 'lapTime'>): void {
    if (this.state === 'RACING') {
      if (!car.isFinishedRace) this.lineCrossings.push(car);
      return;
    }
    if (this.state !== 'QUALIFYING' || !this.qualifying) return;
    const valid = car.trackLimitExits === (this.qualiLapStartExits.get(car) ?? 0);
    this.qualiLapStartExits.set(car, car.trackLimitExits);
    car.fuelKg = Math.max(car.fuelKg, RaceSession.QUALI_FUEL_KG);
    car.lapStartFuel = car.fuelKg;
    if (this.qualifying.lapCompleted(car.color, event.lapTime, valid)) this.parkCar(car);
  }

  /**
   * A sector just completed by `car`: a valid one may set the session best, and the car's last
   * gate delta shows purple when its sector is the session's fastest so far.
   */
  recordSector(car: Car): void {
    const event = car.sectorEvent;
    if (!event) return;
    car.sectorEvent = null;
    const g = event.gateIndex, best = this.sessionBestSectors[g];
    const purple = event.valid && (best === null || event.sectorTime <= best);
    if (purple) this.sessionBestSectors[g] = event.sectorTime;
    if (car.lastCheckpointDelta?.gateIndex === g) car.lastCheckpointDelta.isPurple = purple;
  }

  /** A stop `car` just completed (it crossed the pit exit line): the race's quickest so far is kept. */
  recordPitStop(car: Car): void {
    const event = car.pitStopEvent;
    if (!event) return;
    car.pitStopEvent = null;
    if (this.state !== 'RACING') return;
    if (this.fastestPitStop && this.fastestPitStop.laneTime <= event.laneTime) return;
    this.fastestPitStop = { driverName: car.driverName, carColor: car.color, laneTime: event.laneTime, serviceTime: event.serviceTime, lap: event.lap };
  }

  /** Race classification (frozen once the race is over). */
  standings(): RaceStanding[] {
    if (this.state === 'FINISHED') return this.frozenStandings ??= this.calculateStandings();
    return this.calculateStandings();
  }

  qualifyingSnapshot(): QualifyingSnapshot | null {
    const q = this.qualifying;
    return q ? {
      session: q.session,
      phase: q.phase,
      timeLeft: Math.round(q.timeLeft * 10) / 10,
      eliminatedAfter: q.projectedEliminations(),
      standings: q.standings(),
    } : null;
  }

  /** Fuel per lap as the field burns it on this track (kg). */
  fuelPerLap(): number {
    return this.ctx.population.fuelPerLap ?? this.ctx.track.totalLength * RaceSession.FUEL_PER_METRE;
  }

  /** Race fuel for the laps asked for; the distance is cut to what a full tank covers. */
  private planRaceFuel(): void {
    const plan = planRaceFuel(this.fuelPerLap(), this.requestedLaps);
    this.totalLaps = plan.totalLaps;
    this.raceFuelKg = plan.fuelKg;
  }

  /** Fits the session's starting tyres: the player's choice, or a slick by grid slot adjusted to the weather. */
  private fitStartingTyres(car: Car, gridIndex: number, dryChoice: TyreCompound = startingDryCompound(gridIndex)): void {
    if (this.isPlayerCar(car)) {
      car.tyreCompound = this.playerCompound;
      car.nextCompound = this.playerCompound;
    } else {
      car.tyreCompound = weatherCompound(this.ctx.weather.state.wetness, dryChoice);
      car.nextCompound = null;
    }
    car.usedCompounds = new Set([car.tyreCompound]);
  }

  private equipBestBrains(): void {
    const { population } = this.ctx;
    for (let i = 0; i < population.cars.length; i++) {
      const car = population.cars[i];
      const record = population.teamRecords[i];
      if (record && record.bestBrain && !car.isManual) {
        car.brain = record.bestBrain.clone();
        car.safeBrainBackup = record.bestBrain.clone();
        car.safeBrainPressure = record.bestLapPressure ?? 0;
      }
    }
  }

  /** Puts a car in the garage: off the track, invisible, ignored by traffic. */
  private parkCar(car: Car): void {
    car.isAlive = false;
    car.wreckRemoved = true;
    car.isFinishedRace = true;
    car.isPitting = false;
    car.pitPhase = '';
    car.pitShowTimer = 0;
    car.wantsToPit = false;
    car.vel.set(0, 0);
    car.speed = 0;
    car.speedKmh = 0;
  }

  private releaseQualifier(car: Car, slotIndex: number): void {
    const { track } = this.ctx;
    const slot = track.getGridSlot(slotIndex);
    car.isRaceMode = true;
    car.reset(slot.pos, slot.heading, true, (slot.checkpointIdx + 1) % track.checkpoints.length);
    car.updateDimensionsForTrackWidth(track.width);
    car.fuelKg = RaceSession.QUALI_FUEL_KG;
    car.ersEnergy = Car.ERS_CAPACITY;
    this.fitStartingTyres(car, slotIndex, 'soft');
    // A qualifying stop brings another set of the same tyres.
    if (!this.isPlayerCar(car)) car.nextCompound = car.tyreCompound;
    car.isAlive = true;
    car.pitStopsCount = 0;
    car.trackLimitExits = 0;
    car.raceLapsCompleted = 0;
    car.totalRaceTime = 0;
    this.qualiLapStartExits.set(car, 0);
  }

  /** Every session starts with the field in the garage; cars leave one by one, current leaders first. */
  private startQualifyingSession(): void {
    const qualifying = this.qualifying;
    if (!qualifying) return;
    const field = new Set(qualifying.participants());
    const cars = this.cars();
    this.qualiRelease.clear();
    cars.forEach(car => this.parkCar(car));
    qualifying.standings()
      .filter(s => field.has(s.color))
      .forEach((s, k) => {
        const car = cars.find(c => c.color === s.color);
        if (car) this.qualiRelease.set(car, { delay: k * RaceSession.QUALI_RELEASE_INTERVAL, slot: k });
      });
  }

  /** Advances the qualifying clock. Returns true when cars are on track and physics should run. */
  private stepQualifying(dt: number): boolean {
    const qualifying = this.qualifying;
    if (!qualifying) return false;
    if (qualifying.step(dt)) this.startQualifyingSession();
    if (qualifying.isFinished) {
      this.qualifyingGrid = qualifying.grid();
      this.cars().forEach(car => this.parkCar(car));
      this.qualiRelease.clear();
      this.state = 'QUALI_FINISHED';
      return false;
    }
    if (qualifying.phase === 'break') {
      this.cars().forEach(car => { if (!car.wreckRemoved) this.parkCar(car); });
      return false;
    }
    for (const [car, release] of this.qualiRelease) {
      release.delay -= dt;
      if (release.delay > 0) continue;
      this.qualiRelease.delete(car);
      if (qualifying.isRunning(car.color)) this.releaseQualifier(car, release.slot);
    }
    return true;
  }

  /** A crashed or stuck car keeps its time and takes no further part in the session. */
  private retireStoppedQualifiers(): void {
    const qualifying = this.qualifying;
    if (!qualifying) return;
    for (const car of this.cars()) {
      if (!car.isAlive && !car.wreckRemoved && !this.qualiRelease.has(car) && qualifying.isRunning(car.color)) qualifying.retire(car.color);
    }
  }

  /** Cumulative centreline distance at each checkpoint, per track. */
  private static readonly checkpointDistances = new WeakMap<Track, number[]>();
  private static checkpointDistance(track: Track): number[] {
    let distances = RaceSession.checkpointDistances.get(track);
    if (!distances) {
      distances = [0];
      const n = track.checkpoints.length;
      for (let i = 0; i < n; i++) distances.push(distances[i] + track.checkpoints[i].center.dist(track.checkpoints[(i + 1) % n].center));
      RaceSession.checkpointDistances.set(track, distances);
    }
    return distances;
  }

  private calculateStandings(): RaceStanding[] {
    const { track } = this.ctx;
    const allRacingCars = this.cars();
    const cpCount = track.checkpoints.length || 1;
    const cpCumulativeDist = RaceSession.checkpointDistance(track);
    const accumDist = cpCumulativeDist[cpCumulativeDist.length - 1];
    const trackTotalLen = accumDist > 0 ? accumDist : (track.totalLength || 1000);

    // A finished car stands at the line with the laps it completed (fewer when it was lapped).
    const getCarProgressMeters = (car: Car): number => {
      if (car.isFinishedRace || track.checkpoints.length === 0) return car.raceLapsCompleted * trackTotalLen;
      const nextCpIdx = (car.currentCheckpointIdx || 0) % cpCount;
      const prevCpIdx = (nextCpIdx - 1 + cpCount) % cpCount;
      const pPrev = track.checkpoints[prevCpIdx].center;
      const pNext = track.checkpoints[nextCpIdx].center;
      const segX = pNext.x - pPrev.x;
      const segY = pNext.y - pPrev.y;
      const segLenSq = segX * segX + segY * segY;
      let frac = 0;
      if (segLenSq > 0.001) {
        frac = ((car.pos.x - pPrev.x) * segX + (car.pos.y - pPrev.y) * segY) / segLenSq;
        frac = Math.max(0, Math.min(1, frac));
      }
      const lapDist = Math.max(0, Math.min(trackTotalLen, (cpCumulativeDist[prevCpIdx] ?? 0) + frac * Math.sqrt(segLenSq)));
      return car.raceLapsCompleted * trackTotalLen + lapDist;
    };

    const progressMap = new Map<Car, number>();
    for (const car of allRacingCars) progressMap.set(car, getCarProgressMeters(car));
    const finished = (car: Car) => car.isFinishedRace;
    // Still classified: finished or running. A car out of the race (DNF) is behind all of them.
    const classified = (car: Car) => car.isFinishedRace || car.isAlive;

    // Distance covered decides; on the same lap at the line (finishers) the race time does.
    allRacingCars.sort((a, b) => {
      if (classified(a) !== classified(b)) return classified(a) ? -1 : 1;
      const progA = progressMap.get(a) || 0;
      const progB = progressMap.get(b) || 0;
      if (Math.abs(progB - progA) > 0.05) return progB - progA;
      return a.totalRaceTime - b.totalRaceTime;
    });

    const raceLeader = allRacingCars[0];
    const refSpeed = ((): number => {
      if (raceLeader && typeof raceLeader.bestLapTime === 'number' && raceLeader.bestLapTime > 0) {
        return Math.max(20, Math.min(80, trackTotalLen / raceLeader.bestLapTime));
      }
      if (raceLeader && raceLeader.raceLapsCompleted > 0 && raceLeader.totalRaceTime > 0) {
        return Math.max(20, Math.min(80, (raceLeader.raceLapsCompleted * trackTotalLen) / raceLeader.totalRaceTime));
      }
      if (raceLeader && raceLeader.speedKmh > 30) return Math.max(20, Math.min(80, raceLeader.speedKmh / 3.6));
      return 55.0; // ~198 km/h fallback
    })();

    const formatGap = (targetCar: Car, referenceCar: Car): string => {
      if (finished(targetCar) && finished(referenceCar)) {
        const lapsDown = referenceCar.raceLapsCompleted - targetCar.raceLapsCompleted;
        if (lapsDown >= 1) return `+${lapsDown} OKR`;
        const timeDiff = targetCar.totalRaceTime - referenceCar.totalRaceTime;
        return timeDiff > 0 ? `+${timeDiff.toFixed(2)}s` : '+0.00s';
      }
      const distDiff = Math.max(0, (progressMap.get(referenceCar) || 0) - (progressMap.get(targetCar) || 0));
      const lapDiff = Math.floor(distDiff / trackTotalLen);
      if (lapDiff >= 1) return `+${lapDiff} OKR`;
      const timeDiff = distDiff / refSpeed;
      return timeDiff > 0 ? `+${timeDiff.toFixed(2)}s` : '+0.00s';
    };

    return allRacingCars.map((car, idx) => {
      const isCarDnf = !car.isAlive && !finished(car) && this.state !== 'IDLE';
      let gapToLeader = '';
      let gapToPrevious = '';
      if (isCarDnf) {
        gapToLeader = 'DNF';
        gapToPrevious = 'DNF';
      } else if (idx === 0) {
        gapToLeader = '—';
        gapToPrevious = '—';
      } else {
        gapToLeader = raceLeader ? formatGap(car, raceLeader) : '+0.00s';
        const prevCar = allRacingCars[idx - 1];
        gapToPrevious = prevCar ? formatGap(car, prevCar) : '+0.00s';
      }
      return {
        rank: idx + 1,
        driverName: car.driverName,
        carColor: car.color,
        lapsCompleted: car.raceLapsCompleted,
        gap: gapToLeader,
        gapToLeader,
        gapToPrevious,
        pitStops: car.pitStopsCount,
        trackLimitExits: car.trackLimitExits,
        isPitting: car.isPitting,
        isAlive: car.isAlive,
        bestLap: car.bestLapTime,
        lastLap: car.lastLapTime,
        totalTime: Math.round(car.totalRaceTime * 10) / 10,
        isPlayer: car.isManual,
        finished: car.isFinishedRace,
      };
    });
  }
}
