import { normalizePressure } from '../ai/DriverPressure';
import { captureMotion, resolveTraffic, avoidTraffic } from '../physics/Traffic';
import { Track, TimingGate } from '../track/Track';
import { Presets } from '../track/Presets';
import { Population, LapLeaderboardEntry } from '../ai/Population';
import { Car, CarControl, TrajectoryPoint, CheckpointDelta, driverInputCount, clampStressShare } from '../physics/Car';
import { Spline } from '../math/Spline';
import { Vector2 } from '../math/Vector2';
import { TopologySpecifier } from '../ai/NeuralNetwork';
import { Qualifying, QualifyingPhase, QualifyingStanding } from '../race/Qualifying';
import { isCompound, startingDryCompound, weatherCompound, type TyreCompound } from '../physics/Tyres';
import { Weather, isWeatherScenario, type WeatherScenario, type WeatherState } from '../physics/Weather';
import { applyDriverModel, exportDriver, mergeBetterDrivers, serializeTrack } from '../ai/Islands';

export type { TopologySpecifier };

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

export type ComputeProfile = 'eco' | 'balanced' | 'performance' | 'turbo';

export interface ComputeProfileOptions {
  stepsPerTick?: number;
  snapshotIntervalMs?: number;
  headless?: boolean;
}

export interface ComputeProfileConfig {
  profile: ComputeProfile;
  stepsPerTick: number;
  snapshotIntervalMs: number;
  headless: boolean;
  maxSubStepsBudget: number;
}

export const COMPUTE_PROFILE_PRESETS: Record<ComputeProfile, ComputeProfileConfig> = {
  eco: {
    profile: 'eco',
    stepsPerTick: 1,
    snapshotIntervalMs: 33, // ~30 Hz snapshot rate
    headless: false,
    maxSubStepsBudget: 15
  },
  balanced: {
    profile: 'balanced',
    stepsPerTick: 1,
    snapshotIntervalMs: 16, // ~60 Hz full fidelity
    headless: false,
    maxSubStepsBudget: 200
  },
  performance: {
    profile: 'performance',
    stepsPerTick: 5,
    snapshotIntervalMs: 33, // ~30 Hz throttled snapshots
    headless: false,
    maxSubStepsBudget: 250
  },
  turbo: {
    profile: 'turbo',
    stepsPerTick: 50,
    snapshotIntervalMs: 200, // 5 Hz stats updates
    headless: true,
    maxSubStepsBudget: 300
  }
};

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
}

export interface SerializedRay {
  x: number;
  y: number;
  dist: number;
}

export interface SerializedCar {
  id: number;
  color: string;
  driverName: string;
  x: number;
  y: number;
  angle: number;
  speedKmh: number;
  isAlive: boolean;
  surface: Car['surface'];
  surfaceFractions: Car['surfaceFractions'];
  eliminationReason: Car['eliminationReason'];
  barrierImpactSpeed: number;
  damage: number;
  ersSoc: number;
  gear: number;
  rideHeightFront: number;
  rideHeightRear: number;
  /** Sprung-mass heave (m), pitch and roll (rad), for the 3D body motion. */
  heave: number;
  pitch: number;
  roll: number;
  /** Road-wheel steering angle (rad, + = right) as the actuator delivers it, for the 3D front wheels. */
  wheelAngle: number;
  aeroStall: boolean;
  wakeDrag: number;
  plankForce: number;
  porpoisingHz: number;
  wakeDownforce: number;
  engineRpm: number;
  tyreTempFront: number;
  tyreTempRear: number;
  tyreWearFront: number;
  tyreWearRear: number;
  tyreCompound: TyreCompound;
  incidentActive: boolean;
  battleOpponent: string;
  overtakingTargetName: string;
  racingLineLabel: string;
  driverPressure: number;
  effectiveDriverPressure: number;
  bestLapPressure: number;
  yellowFlag: boolean;
  wreckRemoved: boolean;
  recoveryTimer: number;
  isManual: boolean;
  fitness: number;
  currentLap: number;
  lapTime: number;
  bestLapTime: number | null;
  lastLapTime: number | null;
  fuelKg: number;
  totalMass: number;
  lateralG: number;
  longitudinalG: number;
  weightFrontRatio: number;
  brakingAggression: number;
  understeerSlip: number;
  oversteerSlip: number;
  isSkidding: boolean;
  skidMarks: { x: number; y: number }[];
  sensorRays: SerializedRay[];
  ctrl: CarControl;
  effectiveThrottle: number;
  currentSplits: (number | null)[];
  bestSplits: (number | null)[];
  lastCheckpointDelta: CheckpointDelta | null;
  wantsToPit: boolean;
  isPitting: boolean;
  pitTimer: number;
  pitStopsCount: number;
  trackLimitExits: number;
  raceLapsCompleted: number;
}

export interface SimSnapshot {
  /** Simulated seconds since the worker started; the display interpolates car motion on it. */
  simTime: number;
  driverPressure: number;
  cars: SerializedCar[];
  playerCar: SerializedCar | null;
  bestRacingLine: TrajectoryPoint[];
  leaderCheckpointSpeeds: number[];
  teamStandings: LapLeaderboardEntry[];
  learningHistory: { time: number; bestLap: number; avgLap: number; teamColor: string }[];
  aliveCount: number;
  globalBestLap: number | null;
  generation: number;
  maxFitness: number;
  activeCarBrainJson?: string;
  cpuCores: number;
  speedMultiplier: number | 'max';
  timingGates: TimingGate[];
  sessionBestSplits: (number | null)[];
  raceState: RaceState;
  raceTotalLaps: number;
  raceCurrentLap: number;
  raceStartLights: number;
  raceWinner: string | null;
  raceStandings: RaceStanding[];
  /** Weather now: sun, rain, temperatures, water on the track and the wind. */
  weather: WeatherState;
  weatherScenario: WeatherScenario;
  qualifying: QualifyingSnapshot | null;
  /** Starting order from the last qualifying, used by the next race start. */
  hasQualifyingGrid: boolean;
  computeProfile?: ComputeProfile;
  isHeadless?: boolean;
  topology?: TopologySpecifier;
  islands?: IslandStatus;
}

export interface IslandStatus {
  count: number;
  max: number;
  running: boolean;
  /** Island physics steps per wall-clock second, summed over islands. */
  stepsPerSecond: number;
  /** Driver models taken over from islands since they were started. */
  adopted: number;
}

// Compute Profile State (Defaults to 'balanced' - fully preserving legacy behavior)
let currentProfile: ComputeProfile = 'balanced';
let currentProfileConfig: ComputeProfileConfig = { ...COMPUTE_PROFILE_PRESETS.balanced };
let lastSnapshotTime = 0;

// Topology State (Defaults to 'Standard')
let currentTopology: TopologySpecifier = 'Standard';

function applyComputeProfile(profile: ComputeProfile, options?: ComputeProfileOptions): void {
  const preset = COMPUTE_PROFILE_PRESETS[profile] || COMPUTE_PROFILE_PRESETS.balanced;
  currentProfile = preset.profile;
  currentProfileConfig = {
    profile: preset.profile,
    stepsPerTick: preset.stepsPerTick,
    snapshotIntervalMs: preset.snapshotIntervalMs,
    headless: preset.headless,
    maxSubStepsBudget: preset.maxSubStepsBudget
  };

  if (options) {
    if (typeof options.stepsPerTick === 'number' && Number.isFinite(options.stepsPerTick)) {
      currentProfileConfig.stepsPerTick = Math.max(1, Math.min(currentProfileConfig.maxSubStepsBudget, Math.round(options.stepsPerTick)));
    }
    if (typeof options.snapshotIntervalMs === 'number' && Number.isFinite(options.snapshotIntervalMs)) {
      currentProfileConfig.snapshotIntervalMs = Math.max(10, Math.min(2000, Math.round(options.snapshotIntervalMs)));
    }
    if (typeof options.headless === 'boolean') {
      currentProfileConfig.headless = options.headless;
    }
  }

  // Force immediate snapshot on next tick with new profile settings
  lastSnapshotTime = 0;
}

// State
let trackWidth = 14;
let rayCount = 25;
let startingFuelKg = 105;
let driverPressure = 0;
let mutationRate = 0.09;
let speedMultiplier: number | 'max' = 1;
let isPaused = true;
let isPlayerDriving = false;

// Race Mode State
let raceState: RaceState = 'IDLE';
let raceTotalLaps: number = 50;
let raceCurrentLap: number = 1;
let raceStartLights: number = 0; // 0: off, 1..5: red lights, -1: lights out (go!)
let raceStartTimer: number = 0;
let raceWinner: string | null = null;
let frozenRaceStandings: RaceStanding[] | null = null;
/** The player's compound: fitted at the start and at every stop of their car. */
let playerCompound: TyreCompound = 'medium';
/** Weather of training and every session; a race or qualifying starts again from the forecast. */
const weather = new Weather();
Car.weather = weather.state;
const weatherSeed = () => (Math.random() * 0x7fffffff) | 0;

// Qualifying State
const QUALI_FUEL_KG = 20; // topped up on every lap: runs between short refuelling visits are not modelled
const QUALI_RELEASE_INTERVAL = 1.5; // seconds between cars leaving the garage
let qualifying: Qualifying | null = null;
let qualifyingGrid: string[] | null = null;
const qualiRelease = new Map<Car, { delay: number; slot: number }>();
const qualiLapStartExits = new Map<Car, number>();

let dims = Car.getDimensionsForTrackWidth(trackWidth);
let track = Presets.createGrandPrixTrack(dims.effectiveTrackWidth);
let population = createPopulation();
let playerCar: Car | null = null;
let playerControl: CarControl = { steer: 0, throttle: 0, brake: 0 };
let activeSelectedColor: string | null = null;
let manualCarColor: string | null = null;
let sessionBestSplits: (number | null)[] = [null, null, null, null];
const detectedCores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 8) : 8;

// Training islands: extra workers train their own headless fields on this track
// and hand over driver models with faster clean laps (spare cores, e.g. Apple M1 P-cores).
const maxIslands = Math.max(0, Math.min(15, detectedCores - 2));
let islands: Worker[] = [];
let islandVersion = 0;
let islandsRunning = false;
let islandsAdopted = 0;
const islandRates = new Map<Worker, number>();

function exportAllDrivers(): any[] {
  return population.cars.map((_, i) => exportDriver(population, i));
}

function islandSetupMessage(): object {
  return { type: 'SETUP', version: islandVersion, track: serializeTrack(track), rayCount, topology: currentTopology,
    driverPressure, mutationRate, startingFuelKg, stressLapShare: Car.STRESS_LAP_SHARE, drivers: exportAllDrivers(),
    weatherScenario: weather.scenario, weatherSeed: weatherSeed() };
}

function onIslandMessage(worker: Worker, message: any): void {
  if (message?.type !== 'MODELS' || message.version !== islandVersion) return;
  if (message.busyMs > 0) islandRates.set(worker, message.steps / (message.busyMs / 1000));
  if (raceState !== 'IDLE') return;
  islandsAdopted += mergeBetterDrivers(population, message.drivers);
  worker.postMessage({ type: 'MODELS', version: islandVersion, drivers: exportAllDrivers() });
}

function setIslandCount(count: number): void {
  const target = Math.max(0, Math.min(maxIslands, Math.round(Number(count) || 0)));
  while (islands.length > target) { const worker = islands.pop()!; worker.terminate(); islandRates.delete(worker); }
  if (islands.length < target) {
    const setup = islandSetupMessage();
    while (islands.length < target) {
      const worker = new Worker(new URL('./island.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent) => onIslandMessage(worker, event.data);
      worker.postMessage(setup);
      islands.push(worker);
    }
  }
  if (!islands.length) islandsAdopted = 0;
  islandsRunning = false;
  updateIslandRun();
}

/** New track, inputs, topology or reset learning: islands restart from the main field. */
function resetIslands(): void {
  if (!islands.length) return;
  islandVersion++;
  islandRates.clear();
  const setup = islandSetupMessage();
  for (const worker of islands) worker.postMessage(setup);
}

function configureIslands(): void {
  for (const worker of islands) worker.postMessage({ type: 'CONFIG', driverPressure, mutationRate, startingFuelKg, stressLapShare: Car.STRESS_LAP_SHARE, weatherScenario: weather.scenario });
}

/** Islands train only while the main field trains: not when paused, in qualifying or in a race. */
function updateIslandRun(): void {
  const run = islands.length > 0 && !isPaused && raceState === 'IDLE';
  if (run === islandsRunning) return;
  islandsRunning = run;
  for (const worker of islands) worker.postMessage({ type: 'RUN', running: run });
}

function islandStatus(): IslandStatus {
  let stepsPerSecond = 0;
  for (const rate of islandRates.values()) stepsPerSecond += rate;
  return { count: islands.length, max: maxIslands, running: islandsRunning, stepsPerSecond: Math.round(stepsPerSecond), adopted: islandsAdopted };
}

function serializeCar(car: Car, ctrl?: CarControl, isHeadless: boolean = false): SerializedCar {
  let delta: CheckpointDelta | null = car.lastCheckpointDelta ? { ...car.lastCheckpointDelta } : null;
  if (delta) {
    const g = delta.gateIndex;
    if (sessionBestSplits[g] === null || delta.splitTime <= sessionBestSplits[g]!) {
      sessionBestSplits[g] = delta.splitTime;
      delta.isPurple = true;
    } else {
      delta.isPurple = false;
    }
  }

  return {
    id: car.id,
    color: car.color,
    driverName: car.driverName,
    x: car.pos.x,
    y: car.pos.y,
    angle: car.heading,
    speedKmh: car.speedKmh,
    isAlive: car.isAlive,
    surface: car.surface,
    surfaceFractions: { ...car.surfaceFractions },
    eliminationReason: car.eliminationReason,
    barrierImpactSpeed: car.barrierImpactSpeed,
    damage: car.damage,
    ersSoc: Math.round(car.ersEnergy / Car.ERS_CAPACITY * 100) / 100,
    gear: car.gear,
    rideHeightFront: Math.round(car.rideHeightFront * 10000) / 10,
    rideHeightRear: Math.round(car.rideHeightRear * 10000) / 10,
    heave: car.heave,
    pitch: car.pitch,
    roll: car.roll,
    wheelAngle: car.wheelAngle,
    aeroStall: car.aeroStall,
    wakeDrag: Math.round(car.wakeDrag * 100) / 100,
    plankForce: Math.round(car.plankForce),
    porpoisingHz: Math.round(car.porpoisingHz * 10) / 10,
    wakeDownforce: Math.round(car.wakeDownforce * 100) / 100,
    engineRpm: Math.round(car.engineRpm),
    tyreTempFront: Math.round(car.tyreTempFront),
    tyreTempRear: Math.round(car.tyreTempRear),
    tyreWearFront: Math.round(car.tyreWearFront * 1000) / 1000,
    tyreWearRear: Math.round(car.tyreWearRear * 1000) / 1000,
    tyreCompound: car.tyreCompound,
    incidentActive: car.incidentActive,
    battleOpponent: car.battleOpponent,
    overtakingTargetName: car.overtakingTargetName,
    racingLineLabel: car.racingLineLabel,
    driverPressure: car.driverPressure,
    effectiveDriverPressure: car.effectiveDriverPressure,
    bestLapPressure: car.bestLapPressure,
    yellowFlag: car.yellowFlag,
    wreckRemoved: car.wreckRemoved,
    recoveryTimer: car.recoveryTimer,
    isManual: car.isManual,
    fitness: car.fitness,
    currentLap: car.currentLap,
    lapTime: car.lapTime,
    bestLapTime: car.bestLapTime,
    lastLapTime: car.lastLapTime,
    fuelKg: car.fuelKg,
    totalMass: car.totalMass,
    lateralG: car.lateralG,
    longitudinalG: car.longitudinalG,
    weightFrontRatio: car.weightFrontRatio,
    brakingAggression: car.brakingAggression,
    understeerSlip: car.understeerSlip,
    oversteerSlip: car.oversteerSlip,
    isSkidding: car.isSkidding,
    skidMarks: isHeadless ? [] : car.skidMarks.map(m => ({ x: m.x, y: m.y })),
    sensorRays: isHeadless ? [] : car.rayHits.map(h => ({
      x: h.point.x,
      y: h.point.y,
      dist: h.dist
    })),
    ctrl: ctrl || car.currentControl || { steer: 0, throttle: 0, brake: 0 },
    effectiveThrottle: (!car.isAlive || car.isPitting) ? 0 : (
      typeof car.effectiveThrottle === 'number' && Number.isFinite(car.effectiveThrottle)
        ? Math.max(0, Math.min(1, car.effectiveThrottle))
        : 0
    ),
    currentSplits: [...car.currentLapSplits],
    bestSplits: [...car.bestLapSplits],
    lastCheckpointDelta: delta,
    wantsToPit: car.wantsToPit,
    isPitting: car.isPitting,
    pitTimer: Math.max(0, Math.round(car.pitTimer * 10) / 10),
    pitStopsCount: car.pitStopsCount,
    trackLimitExits: car.trackLimitExits,
    raceLapsCompleted: car.raceLapsCompleted
  };
}

function calculateRaceStandings(): RaceStanding[] {
  const allRacingCars: Car[] = [...population.cars];
  if (playerCar && isPlayerDriving) {
    allRacingCars.push(playerCar);
  }

  const cpCount = track.checkpoints.length || 1;
  const cpCumulativeDist: number[] = [0];
  let accumDist = 0;
  if (track.checkpoints.length > 0) {
    for (let i = 0; i < cpCount; i++) {
      const nextIdx = (i + 1) % cpCount;
      const pCurr = track.checkpoints[i].center;
      const pNext = track.checkpoints[nextIdx].center;
      accumDist += pCurr.dist(pNext);
      cpCumulativeDist.push(accumDist);
    }
  }
  const trackTotalLen = accumDist > 0 ? accumDist : (track.totalLength || 1000);

  const getCarProgressMeters = (car: Car): number => {
    if (car.isFinishedRace || car.raceLapsCompleted >= raceTotalLaps) {
      return raceTotalLaps * trackTotalLen;
    }
    if (track.checkpoints.length === 0) {
      return car.raceLapsCompleted * trackTotalLen;
    }
    const nextCpIdx = (car.currentCheckpointIdx || 0) % cpCount;
    const prevCpIdx = (nextCpIdx - 1 + cpCount) % cpCount;

    const pPrev = track.checkpoints[prevCpIdx].center;
    const pNext = track.checkpoints[nextCpIdx].center;

    const segX = pNext.x - pPrev.x;
    const segY = pNext.y - pPrev.y;
    const segLenSq = segX * segX + segY * segY;

    let frac = 0;
    if (segLenSq > 0.001) {
      const toCarX = car.pos.x - pPrev.x;
      const toCarY = car.pos.y - pPrev.y;
      frac = (toCarX * segX + toCarY * segY) / segLenSq;
      frac = Math.max(0, Math.min(1, frac));
    }

    const segLen = Math.sqrt(segLenSq);
    const baseDist = cpCumulativeDist[prevCpIdx] ?? 0;
    const lapDist = Math.max(0, Math.min(trackTotalLen, baseDist + frac * segLen));

    return car.raceLapsCompleted * trackTotalLen + lapDist;
  };

  const progressMap = new Map<Car, number>();
  for (const car of allRacingCars) {
    progressMap.set(car, getCarProgressMeters(car));
  }

  allRacingCars.sort((a, b) => {
    const aFinished = a.isFinishedRace || a.raceLapsCompleted >= raceTotalLaps;
    const bFinished = b.isFinishedRace || b.raceLapsCompleted >= raceTotalLaps;

    if (aFinished && bFinished) {
      return a.totalRaceTime - b.totalRaceTime;
    }
    if (aFinished) return -1;
    if (bFinished) return 1;

    if (a.isAlive !== b.isAlive) {
      return a.isAlive ? -1 : 1;
    }

    const progA = progressMap.get(a) || 0;
    const progB = progressMap.get(b) || 0;
    if (Math.abs(progB - progA) > 0.05) {
      return progB - progA;
    }

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
    if (raceLeader && raceLeader.speedKmh > 30) {
      return Math.max(20, Math.min(80, raceLeader.speedKmh / 3.6));
    }
    return 55.0; // ~198 km/h fallback
  })();

  const formatGap = (targetCar: Car, referenceCar: Car): string => {
    const targetFinished = targetCar.isFinishedRace || targetCar.raceLapsCompleted >= raceTotalLaps;
    const refFinished = referenceCar.isFinishedRace || referenceCar.raceLapsCompleted >= raceTotalLaps;

    if (targetFinished && refFinished) {
      const timeDiff = targetCar.totalRaceTime - referenceCar.totalRaceTime;
      return timeDiff > 0 ? `+${timeDiff.toFixed(2)}s` : '+0.00s';
    }

    const refProg = progressMap.get(referenceCar) || 0;
    const targetProg = progressMap.get(targetCar) || 0;
    const distDiff = Math.max(0, refProg - targetProg);

    const lapDiff = Math.floor(distDiff / trackTotalLen);
    if (lapDiff >= 1) {
      return `+${lapDiff} OKR`;
    }

    const timeDiff = distDiff / refSpeed;
    return timeDiff > 0 ? `+${timeDiff.toFixed(2)}s` : '+0.00s';
  };

  return allRacingCars.map((car, idx) => {
    const carFinished = car.isFinishedRace || car.raceLapsCompleted >= raceTotalLaps;
    const isCarDnf = !car.isAlive && !carFinished && raceState !== 'IDLE';

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
      isPlayer: car.isManual
    };
  });
}

function createSnapshot(): SimSnapshot {
  const isHeadless = currentProfileConfig.headless;
  const leader = population.currentLeader;
  const targetCar = activeSelectedColor
    ? population.cars.find(c => c.color === activeSelectedColor) || leader
    : leader;

  let activeBrainJson: string | undefined;
  if (targetCar && targetCar.brain && (!isHeadless || activeSelectedColor)) {
    activeBrainJson = targetCar.brain.toJSON();
  }

  // Pure snapshot serialization: read recorded controls without executing AI inference or mutating replayBuffer
  const serializedCars: SerializedCar[] = population.cars.map(c => {
    const ctrl: CarControl = c.isManual ? (c.manualControl || playerControl) : c.currentControl;
    return serializeCar(c, ctrl, isHeadless);
  });

  let serializedPlayer: SerializedCar | null = null;
  if (playerCar && isPlayerDriving) {
    serializedPlayer = serializeCar(playerCar, playerControl, isHeadless);
  }

  let maxFitness = 0;
  for (const c of population.cars) {
    if (c.fitness > maxFitness) maxFitness = c.fitness;
  }

  // Calculate or return frozen standings if race finished
  const raceStandings: RaceStanding[] = (raceState === 'FINISHED' && frozenRaceStandings)
    ? frozenRaceStandings
    : calculateRaceStandings();
  if (raceState === 'FINISHED' && !frozenRaceStandings) {
    frozenRaceStandings = raceStandings;
  }

  return {
    driverPressure: population.driverPressure,
    cars: serializedCars,
    playerCar: serializedPlayer,
    bestRacingLine: population.bestRacingLine.map(p => ({ ...p })),
    leaderCheckpointSpeeds: [...population.leaderCheckpointSpeeds],
    teamStandings: population.teamStandings,
    learningHistory: population.learningHistory.map(h => ({ ...h })),
    aliveCount: population.aliveCount,
    globalBestLap: population.globalBestLap,
    generation: population.generation,
    maxFitness: Math.round(maxFitness),
    activeCarBrainJson: activeBrainJson,
    cpuCores: detectedCores,
    speedMultiplier,
    simTime,
    timingGates: track.timingGates.map(g => ({ ...g })),
    sessionBestSplits: [...sessionBestSplits],
    raceState,
    raceTotalLaps,
    raceCurrentLap,
    raceStartLights,
    raceWinner,
    raceStandings,
    weather: { ...weather.state },
    weatherScenario: weather.scenario,
    qualifying: qualifying ? {
      session: qualifying.session,
      phase: qualifying.phase,
      timeLeft: Math.round(qualifying.timeLeft * 10) / 10,
      eliminatedAfter: qualifying.projectedEliminations(),
      standings: qualifying.standings(),
    } : null,
    hasQualifyingGrid: qualifyingGrid !== null,
    computeProfile: currentProfile,
    isHeadless: currentProfileConfig.headless,
    topology: currentTopology,
    islands: islandStatus()
  };
}

function sessionCars(): Car[] {
  return [...population.cars, ...(playerCar && isPlayerDriving ? [playerCar] : [])];
}

/** The car the player drives: their own car, or a team car they took over. */
function isPlayerCar(car: Car): boolean {
  return car === playerCar || (!!manualCarColor && car.color === manualCarColor);
}

/** Fits the session's starting tyres: the player's choice, or a slick by grid slot adjusted to the weather. */
function fitStartingTyres(car: Car, gridIndex: number, dryChoice: TyreCompound = startingDryCompound(gridIndex)): void {
  if (isPlayerCar(car)) {
    car.tyreCompound = playerCompound;
    car.nextCompound = playerCompound;
  } else {
    car.tyreCompound = weatherCompound(weather.state.wetness, dryChoice);
    car.nextCompound = null;
  }
}

/** Race and qualifying use each driver's protected best network, not the one still learning. */
function equipBestBrains(): void {
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
function parkCar(car: Car): void {
  car.isAlive = false;
  car.wreckRemoved = true;
  car.isFinishedRace = true;
  car.isPitting = false;
  car.wantsToPit = false;
  car.vel.set(0, 0);
  car.speed = 0;
  car.speedKmh = 0;
}

function releaseQualifier(car: Car, slotIndex: number): void {
  const slot = track.getGridSlot(slotIndex);
  car.isRaceMode = true;
  car.reset(slot.pos, slot.heading, true, (slot.checkpointIdx + 1) % track.checkpoints.length);
  car.updateDimensionsForTrackWidth(track.width);
  car.fuelKg = QUALI_FUEL_KG;
  car.ersEnergy = Car.ERS_CAPACITY;
  fitStartingTyres(car, slotIndex, 'soft');
  // A qualifying stop brings another set of the same tyres.
  if (!isPlayerCar(car)) car.nextCompound = car.tyreCompound;
  car.isAlive = true;
  car.pitStopsCount = 0;
  car.trackLimitExits = 0;
  car.raceLapsCompleted = 0;
  car.totalRaceTime = 0;
  qualiLapStartExits.set(car, 0);
}

/** Every session starts with the field in the garage; cars leave one by one, current leaders first. */
function startQualifyingSession(): void {
  if (!qualifying) return;
  const field = new Set(qualifying.participants());
  const cars = sessionCars();
  qualiRelease.clear();
  cars.forEach(parkCar);
  qualifying.standings()
    .filter(s => field.has(s.color))
    .forEach((s, k) => {
      const car = cars.find(c => c.color === s.color);
      if (car) qualiRelease.set(car, { delay: k * QUALI_RELEASE_INTERVAL, slot: k });
    });
}

/** Advances the qualifying clock. Returns true when cars are on track and physics should run. */
function stepQualifying(dt: number): boolean {
  if (!qualifying) return false;
  if (qualifying.step(dt)) startQualifyingSession();
  if (qualifying.isFinished) {
    qualifyingGrid = qualifying.grid();
    sessionCars().forEach(parkCar);
    qualiRelease.clear();
    raceState = 'QUALI_FINISHED';
    return false;
  }
  if (qualifying.phase === 'break') {
    sessionCars().forEach(car => { if (!car.wreckRemoved) parkCar(car); });
    return false;
  }
  for (const [car, release] of qualiRelease) {
    release.delay -= dt;
    if (release.delay > 0) continue;
    qualiRelease.delete(car);
    if (qualifying.isRunning(car.color)) releaseQualifier(car, release.slot);
  }
  // A stop for a fresh set of tyres must not fill the tank for a race stint.
  for (const car of sessionCars()) if (car.isPitting) car.fuelKg = Math.min(car.fuelKg, QUALI_FUEL_KG);
  return true;
}

/** Times a completed lap; a lap after the chequered flag sends the car back to the garage. */
function onQualifyingLap(car: Car, event: { lapTime: number }): void {
  if (raceState !== 'QUALIFYING' || !qualifying) return;
  const valid = car.trackLimitExits === (qualiLapStartExits.get(car) ?? 0);
  qualiLapStartExits.set(car, car.trackLimitExits);
  car.fuelKg = Math.max(car.fuelKg, QUALI_FUEL_KG);
  if (qualifying.lapCompleted(car.color, event.lapTime, valid)) parkCar(car);
}

/** A crashed or stuck car keeps its time and takes no further part in the session. */
function retireStoppedQualifiers(): void {
  if (!qualifying) return;
  for (const car of sessionCars()) {
    if (!car.isAlive && !car.wreckRemoved && !qualiRelease.has(car) && qualifying.isRunning(car.color)) qualifying.retire(car.color);
  }
}

/** A new field on the current track with every user setting (rays, topology, pressure, mutation, fuel) and the session hooks. */
function createPopulation(): Population {
  const next = Population.create(track, { rayCount, topology: currentTopology, driverPressure, mutationRate, startingFuelKg });
  next.onLapCompleted = onQualifyingLap;
  return next;
}

// Simulation step execution: elapsed-time accumulator keeps 1x tied to real time.
let lastPhysicsTick = performance.now();
let physicsAccumulator = 0;
let simTime = 0;
function runSimulationSteps(): void {
  const now = performance.now();
  const elapsed = Math.max(0, Math.min(0.25, (now - lastPhysicsTick) / 1000));
  lastPhysicsTick = now;
  if (isPaused || raceState === 'FINISHED' || raceState === 'QUALI_FINISHED') { physicsAccumulator = 0; return; }

  let steps = speedMultiplier === 'max' ? currentProfileConfig.maxSubStepsBudget : 0;

  const fixedDt = 1 / 60;
  if (speedMultiplier !== 'max') {
    const rate = (currentProfile === 'balanced' ? 1 : currentProfileConfig.stepsPerTick)
      * (typeof speedMultiplier === 'number' ? speedMultiplier : 1);
    physicsAccumulator = Math.min(currentProfileConfig.maxSubStepsBudget * fixedDt, physicsAccumulator + elapsed * rate);
    steps = Math.min(currentProfileConfig.maxSubStepsBudget, Math.floor((physicsAccumulator + 1e-9) / fixedDt));
  } else physicsAccumulator = 0;
  const tickStartTime = performance.now();
  const MAX_TICK_EXECUTION_TIME_MS = 35; // Safe boundary limit to prevent starving worker event loop

  for (let s = 0; s < steps; s++) {
    if (s > 10 && (s & 3) === 0) {
      if (performance.now() - tickStartTime > MAX_TICK_EXECUTION_TIME_MS) {
        break;
      }
    }
    if (speedMultiplier !== 'max') physicsAccumulator = Math.max(0, physicsAccumulator - fixedDt);
    simTime += fixedDt;
    weather.step(fixedDt);
    population.setConditions(weather.conditions);
    if (raceState === 'QUALIFYING' && !stepQualifying(fixedDt)) {
      if (raceState !== 'QUALIFYING') break;
      continue;
    }
    if (raceState === 'GRID_START') {
      raceStartTimer += fixedDt;
      if (raceStartTimer < 0.8) {
        raceStartLights = 0;
      } else if (raceStartTimer < 1.6) {
        raceStartLights = 1;
      } else if (raceStartTimer < 2.4) {
        raceStartLights = 2;
      } else if (raceStartTimer < 3.2) {
        raceStartLights = 3;
      } else if (raceStartTimer < 4.0) {
        raceStartLights = 4;
      } else if (raceStartTimer < 5.2) {
        raceStartLights = 5;
      } else {
        raceStartLights = -1; // LIGHTS OUT!
        raceState = 'RACING';
      }

      // Freeze all cars on grid
      for (const car of population.cars) {
        car.vel.set(0, 0);
        car.speed = 0;
        car.speedKmh = 0;
      }
      if (playerCar) {
        playerCar.vel.set(0, 0);
        playerCar.speed = 0;
        playerCar.speedKmh = 0;
      }
      continue;
    }

    if (isPlayerDriving && manualCarColor) {
      const manualCar = population.cars.find(c => c.color === manualCarColor);
      if (manualCar) {
        manualCar.isManual = true;
        manualCar.manualControl = playerControl;
      }
    }

    const traffic = [...population.cars, ...(playerCar && isPlayerDriving ? [playerCar] : [])];
    const trafficMotion = playerCar && isPlayerDriving ? captureMotion(traffic) : null;
    population.update(fixedDt, track, playerCar && isPlayerDriving ? [playerCar] : []);

    if (playerCar && isPlayerDriving) {
      if (!playerCar.isAlive) {
        playerCar.coastWreck(fixedDt, track);
        if (raceState === 'IDLE') {
          playerCar.respawnTimer -= fixedDt;
          if (playerCar.respawnTimer <= 0) {
            playerCar.reset(track.startPosition, track.startAngle, true);
            playerCar.isAlive = true;
          }
        }
      } else {
        playerCar.updateSensors(track, traffic);
        const lapEvent = playerCar.updatePhysics(avoidTraffic(playerCar, traffic, playerControl, track), fixedDt, track);
        if (trafficMotion) resolveTraffic(traffic, trafficMotion, playerCar);
        if (lapEvent) {
          population.recordLap({...lapEvent, compromised: lapEvent.compromised || playerCar.lapCompromised}, playerCar, true, track);
          onQualifyingLap(playerCar, lapEvent);
        }
      }
    }
    if (raceState === 'QUALIFYING') retireStoppedQualifiers();

    if (raceState === 'RACING') {
      let maxLaps = 0;
      let aliveCount = 0;
      for (const c of population.cars) {
        if (c.isAlive) aliveCount++;
        if (c.raceLapsCompleted > maxLaps) maxLaps = c.raceLapsCompleted;
      }
      if (playerCar && isPlayerDriving) {
        if (playerCar.isAlive) aliveCount++;
        if (playerCar.raceLapsCompleted > maxLaps) {
          maxLaps = playerCar.raceLapsCompleted;
        }
      }
      raceCurrentLap = Math.min(raceTotalLaps, maxLaps + 1);

      if (!raceWinner) {
        const winner = population.cars.find(c => c.raceLapsCompleted >= raceTotalLaps)
          || ((playerCar && isPlayerDriving && playerCar.raceLapsCompleted >= raceTotalLaps) ? playerCar : null);
        if (winner) {
          winner.isFinishedRace = true;
          raceWinner = winner.driverName;
          raceState = 'FINISHED';
          frozenRaceStandings = calculateRaceStandings();
          break;
        } else if (aliveCount === 0) {
          raceWinner = 'BRAK (WSZYSCY ROZBICI - DNF)';
          raceState = 'FINISHED';
          frozenRaceStandings = calculateRaceStandings();
          break;
        }
      }
    }
  }
}

// Background simulation ticker: targets configured snapshot dispatch rate
function simLoop() {
  runSimulationSteps();
  updateIslandRun();
  const now = performance.now();
  const interval = currentProfileConfig.snapshotIntervalMs;
  // Allow a 3ms margin of tolerance to prevent timer jitter skipping 60Hz/30Hz ticks
  const threshold = interval <= 20 ? Math.max(0, interval - 3) : interval;

  if (now - lastSnapshotTime >= threshold) {
    lastSnapshotTime = now;
    const snapshot = createSnapshot();
    self.postMessage({ type: 'SNAPSHOT', snapshot });
  }
}

setInterval(simLoop, 16);

/** Messages after which islands restart from the main field, or only take new settings. */
const ISLAND_RESET_MESSAGES = new Set(['SET_TOPOLOGY', 'SET_TRACK_WIDTH', 'SET_PRESET', 'SET_CUSTOM_TRACK', 'SET_LIDAR_COUNT',
  'RESET_POPULATION', 'CLEAR_LEARNING', 'RESET_SINGLE_BRAIN', 'RESET_BEST_TIMES', 'LOAD_BRAIN', 'LOAD_ALL_MODELS']);
const ISLAND_CONFIG_MESSAGES = new Set(['SET_DRIVER_PRESSURE', 'SET_MUTATION', 'SET_FUEL', 'SET_STRESS_LAPS']);

// Message handling from Main Thread
self.onmessage = (e: MessageEvent) => {
  const data = e.data;
  if (!data) return;

  switch (data.type) {
    case 'SET_ISLANDS': {
      setIslandCount(data.count);
      lastSnapshotTime = 0;
      break;
    }

    case 'INIT': {
      driverPressure = normalizePressure(data.driverPressure ?? 0);
      population.setDriverPressure(driverPressure, true);
      if (data.topology) {
        currentTopology = data.topology as TopologySpecifier;
        population.setTopology(currentTopology, track);
      }
      applyComputeProfile(data.profile || currentProfile, data.options);
      self.postMessage({
        type: 'READY',
        cpuCores: detectedCores,
        computeProfile: currentProfile,
        topology: currentTopology
      });
      break;
    }

    case 'SET_TOPOLOGY': {
      const topology = (data.topology || 'Standard') as TopologySpecifier;
      currentTopology = topology;
      population.setTopology(topology, track);
      if (playerCar) {
        playerCar.reset(track.startPosition, track.startAngle, true);
        playerCar.updateDimensionsForTrackWidth(trackWidth);
      }
      lastSnapshotTime = 0;
      break;
    }

    case 'SET_COMPUTE_PROFILE': {
      const profile = data.profile as ComputeProfile;
      const options = data.options as ComputeProfileOptions | undefined;
      applyComputeProfile(profile, options);
      break;
    }

    case 'SET_PAUSED': {
      isPaused = !!data.isPaused;
      break;
    }

    case 'SET_SPEED': {
      speedMultiplier = data.speed;
      break;
    }

    case 'SET_TRACK_WIDTH': {
      try {
        const nextWidth = Car.getDimensionsForTrackWidth(data.trackWidth).effectiveTrackWidth;
        const source = data.points?.length >= 4 ? data.points.map((p: {x: number; y: number}) => new Vector2(p.x, p.y)) : track.points.map(p => p.center);
        const newPoints = Spline.generateClosedTrack(source, nextWidth, 18, !!data.keepOrder);
        const nextTrack = new Track(newPoints, nextWidth);
        trackWidth = nextWidth; track = nextTrack;
        population.resetAll(track);
        if (playerCar) {
          playerCar.reset(track.startPosition, track.startAngle, true);
          playerCar.updateDimensionsForTrackWidth(trackWidth);
        }
      } catch (error) {
        self.postMessage({ type: 'TRACK_ERROR', message: error instanceof Error ? error.message : 'Niepoprawna geometria toru.' });
      }
      break;
    }

    case 'SET_PRESET': {
      dims = Car.getDimensionsForTrackWidth(trackWidth);
      if (data.preset === 'oval') {
        track = Presets.createOvalTrack(dims.effectiveTrackWidth);
      } else {
        track = Presets.createGrandPrixTrack(dims.effectiveTrackWidth);
      }
      population = createPopulation();
      if (playerCar) {
        playerCar.reset(track.startPosition, track.startAngle, true);
        playerCar.updateDimensionsForTrackWidth(trackWidth);
      }
      break;
    }

    case 'SET_CUSTOM_TRACK': {
      try {
        const parsedPoints: Vector2[] = (data.points || []).map((p: {x: number; y: number}) => new Vector2(p.x, p.y));
        if (parsedPoints.length < 4) throw new Error('Tor wymaga co najmniej czterech punktów.');
        const nextWidth = Car.getDimensionsForTrackWidth(data.trackWidth ?? trackWidth).effectiveTrackWidth;
        const splinePoints = Spline.generateClosedTrack(parsedPoints, nextWidth, 18, !!data.keepOrder);
        if (splinePoints.length < 8) throw new Error('Tor jest zbyt krótki.');
        const nextTrack = new Track(splinePoints, nextWidth);
        trackWidth = nextWidth; track = nextTrack;
        population = createPopulation();
        if (playerCar) {
          playerCar.reset(track.startPosition, track.startAngle, true);
          playerCar.updateDimensionsForTrackWidth(trackWidth);
        }
      } catch (error) {
        self.postMessage({ type: 'TRACK_ERROR', message: error instanceof Error ? error.message : 'Niepoprawna geometria toru.' });
      }
      break;
    }

    case 'SET_WEATHER': {
      // A new forecast applies at once (training too) and to every following session.
      if (isWeatherScenario(data.scenario) && data.scenario !== weather.scenario) {
        weather.reset(data.scenario, typeof data.seed === 'number' ? data.seed : weatherSeed());
        population.setConditions(weather.conditions);
        configureIslands();
      }
      break;
    }

    case 'SET_TYRES': {
      // The player's compound; changing it mid-race takes effect at the next stop.
      if (isCompound(data.compound)) {
        playerCompound = data.compound;
        for (const car of sessionCars()) if (isPlayerCar(car)) car.nextCompound = playerCompound;
        if (playerCar) playerCar.nextCompound = playerCompound;
      }
      break;
    }

    case 'SET_DRIVER_PRESSURE': {
      driverPressure = normalizePressure(data.value);
      population.setDriverPressure(driverPressure);
      playerCar?.setDriverPressure(driverPressure);
      break;
    }

    case 'SET_MUTATION': {
      mutationRate = data.value;
      population.mutationRate = mutationRate;
      break;
    }

    case 'SET_STRESS_LAPS': {
      Car.STRESS_LAP_SHARE = clampStressShare(data.value);
      break;
    }

    case 'SET_FUEL': {
      startingFuelKg = data.value;
      population.startingFuelKg = startingFuelKg;
      break;
    }

    case 'SET_LIDAR_COUNT': {
      rayCount = data.value;
      population.setRayCount(rayCount, track);
      if (playerCar) {
        playerCar.setRayCount(rayCount);
        playerCar.reset(track.startPosition, track.startAngle, true);
      }
      lastSnapshotTime = 0;
      break;
    }

    case 'RESET_POPULATION': {
      population.generation++;
      population.resetAll(track);
      if (playerCar) {
        playerCar.reset(track.startPosition, track.startAngle, true);
      }
      break;
    }

    case 'EVOLVE_POPULATION': {
      population.evolve(track);
      if (playerCar) {
        playerCar.reset(track.startPosition, track.startAngle, true);
      }
      break;
    }

    case 'REFUEL': {
      for (const car of population.cars) {
        car.fuelKg = Math.min(Car.MAX_FUEL_CAPACITY, startingFuelKg);
      }
      if (playerCar) {
        playerCar.fuelKg = Math.min(Car.MAX_FUEL_CAPACITY, startingFuelKg);
      }
      break;
    }

    case 'START_RACE': {
      raceTotalLaps = Math.max(10, Math.min(200, data.totalLaps || 50));
      raceWinner = null;
      frozenRaceStandings = null;
      isPaused = false;
      population.isRaceMode = true;
      weather.reset(weather.scenario, typeof data.weatherSeed === 'number' ? data.weatherSeed : weatherSeed());
      population.setConditions(weather.conditions);
      // CRITICAL: Preserve learned neural network! Equip the best brain learned during training!
      equipBestBrains();

      if (data.withQualifying) {
        raceState = 'QUALIFYING';
        qualifyingGrid = null;
        // Session lengths are fixed by the rules; tests may shorten them.
        const sessionSeconds = Array.isArray(data.qualifyingSessionSeconds) && data.qualifyingSessionSeconds.length === 3
          && data.qualifyingSessionSeconds.every((t: unknown) => typeof t === 'number' && t > 0)
          ? data.qualifyingSessionSeconds as number[] : undefined;
        qualifying = new Qualifying(sessionCars().map(c => ({ color: c.color, driverName: c.driverName })), { sessionSeconds });
        startQualifyingSession();
        break;
      }

      raceState = 'GRID_START';
      raceCurrentLap = 1;
      raceStartLights = 0;
      raceStartTimer = 0;
      // Starting order: the qualifying result when the race follows qualifying, otherwise the entry list.
      const entrants = sessionCars();
      const grid = data.useQualifyingGrid ? qualifyingGrid : null;
      const order = grid
        ? [...grid.map(color => entrants.find(c => c.color === color)).filter((c): c is Car => !!c),
           ...entrants.filter(c => !grid.includes(c.color))]
        : entrants;
      qualifying = null;
      qualiRelease.clear();
      order.forEach((car, i) => {
        car.isRaceMode = true;
        const slot = track.getGridSlot(i);
        car.reset(slot.pos, slot.heading, true, (slot.checkpointIdx + 1) % track.checkpoints.length);
        car.updateDimensionsForTrackWidth(track.width);
        fitStartingTyres(car, i);
        car.fuelKg = 50.0;
        car.pitStopsCount = 0;
        car.trackLimitExits = 0;
        car.raceLapsCompleted = 0;
        car.totalRaceTime = 0;
        car.isAlive = true;
        car.isPitting = false;
        car.wantsToPit = false;
      });
      break;
    }

    case 'CLEAR_LEARNING': {
      // Clean slate: a population exactly as at start-up (seed networks only, no records,
      // lines, pace or generations). Track and user settings are kept; any session ends.
      raceState = 'IDLE';
      qualifying = null;
      qualifyingGrid = null;
      qualiRelease.clear();
      raceWinner = null;
      frozenRaceStandings = null;
      sessionBestSplits = [null, null, null, null];
      islandsAdopted = 0;
      population = createPopulation();
      if (playerCar) {
        playerCar.isRaceMode = false;
        playerCar.reset(track.startPosition, track.startAngle, true);
        playerCar.updateDimensionsForTrackWidth(trackWidth);
        playerCar.bestLapTime = null;
        playerCar.lastLapTime = null;
        playerCar.bestLapSplits = [null, null, null, null];
        playerCar.currentLapSplits = [null, null, null, null];
        playerCar.lastCheckpointDelta = null;
      }
      lastSnapshotTime = 0;
      self.postMessage({ type: 'CLEAR_LEARNING_DONE', requestId: data.requestId });
      break;
    }

    case 'STOP_RACE': {
      raceState = 'IDLE';
      qualifying = null;
      qualifyingGrid = null;
      qualiRelease.clear();
      raceWinner = null;
      frozenRaceStandings = null;
      population.isRaceMode = false;
      for (let i = 0; i < population.cars.length; i++) {
        const car = population.cars[i];
        const record = population.teamRecords[i];
        car.isRaceMode = false;
        // CRITICAL: Preserve learned neural network! Restore the bestBrain without destroying it!
        if (record && record.bestBrain && !car.isManual) {
          car.brain = record.bestBrain.clone();
          car.safeBrainBackup = record.bestBrain.clone();
          car.safeBrainPressure = record.bestLapPressure ?? 0;
        }
        const slot = track.getGridSlot(i);
        const nextCpIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
        car.reset(slot.pos, slot.heading, true, nextCpIdx);
        car.updateDimensionsForTrackWidth(track.width);
        car.fuelKg = population.startingFuelKg;
        car.isAlive = true;
        car.pitStopsCount = 0;
        car.trackLimitExits = 0;
        car.raceLapsCompleted = 0;
        car.totalRaceTime = 0;
        car.isPitting = false;
        car.wantsToPit = false;
      }
      if (playerCar) {
        playerCar.isRaceMode = false;
        const slot = track.getGridSlot(population.cars.length);
        const nextCpIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
        playerCar.reset(slot.pos, slot.heading, true, nextCpIdx);
        playerCar.updateDimensionsForTrackWidth(track.width);
        playerCar.fuelKg = population.startingFuelKg;
        playerCar.isAlive = true;
      }
      break;
    }

    case 'RESET_CAR_POSITIONS': {
      for (let i = 0; i < population.cars.length; i++) {
        const car = population.cars[i];
        const record = population.teamRecords[i];
        if (record && record.bestBrain && !car.isManual) {
          car.brain = record.bestBrain.clone();
          car.safeBrainBackup = record.bestBrain.clone();
          car.safeBrainPressure = record.bestLapPressure ?? 0;
        }
        const slot = track.getGridSlot(i);
        const nextCpIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
        car.reset(slot.pos, slot.heading, true, nextCpIdx);
        car.updateDimensionsForTrackWidth(track.width);
        car.fuelKg = population.startingFuelKg;
        car.isAlive = true;
        car.pitStopsCount = 0;
        car.trackLimitExits = 0;
        car.raceLapsCompleted = 0;
        car.totalRaceTime = 0;
        car.isPitting = false;
        car.wantsToPit = false;
      }
      if (playerCar) {
        const slot = track.getGridSlot(population.cars.length);
        const nextCpIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
        playerCar.reset(slot.pos, slot.heading, true, nextCpIdx);
        playerCar.updateDimensionsForTrackWidth(track.width);
        playerCar.fuelKg = population.startingFuelKg;
        playerCar.isAlive = true;
      }
      break;
    }

    case 'TOGGLE_PLAYER_PIT': {
      if (manualCarColor) {
        const target = population.cars.find(c => c.color === manualCarColor);
        if (target) {
          target.wantsToPit = !target.wantsToPit;
        }
      }
      if (playerCar) {
        playerCar.wantsToPit = !playerCar.wantsToPit;
      }
      break;
    }

    case 'RESET_SINGLE_BRAIN': {
      const target = population.cars.find(c => c.color === data.carColor);
      if (target) {
        population.resetSingleCarBrain(target, track);
      }
      break;
    }

    case 'RESET_BEST_TIMES': {
      sessionBestSplits = [null, null, null, null];
      population.resetBestTimes();
      if (playerCar) {
        playerCar.bestLapTime = null;
        playerCar.bestLapSplits = [null, null, null, null];
        playerCar.currentLapSplits = [null, null, null, null];
        playerCar.lastCheckpointDelta = null;
      }
      break;
    }

    case 'SET_ACTIVE_CAR_COLOR': {
      activeSelectedColor = data.carColor || null;
      if (isPlayerDriving && activeSelectedColor) {
        manualCarColor = activeSelectedColor;
        for (const car of population.cars) {
          car.isManual = (car.color === manualCarColor);
          if (car.isManual) {
            car.manualControl = playerControl;
          }
        }
      }
      break;
    }

    case 'PLAYER_INPUT': {
      playerControl = data.control;
      if (manualCarColor) {
        const target = population.cars.find(c => c.color === manualCarColor);
        if (target) {
          target.manualControl = playerControl;
        }
      }
      if (playerCar) {
        playerCar.manualControl = playerControl;
      }
      break;
    }

    case 'SET_PLAYER_DRIVING': {
      isPlayerDriving = !!data.active;
      manualCarColor = data.carColor || (isPlayerDriving ? (activeSelectedColor || population.currentLeader?.color || population.cars[0]?.color) : null);

      for (const car of population.cars) {
        car.isManual = isPlayerDriving && (car.color === manualCarColor);
        if (car.isManual) {
          car.manualControl = playerControl;
        }
      }

      if (isPlayerDriving && !manualCarColor) {
        playerCar = new Car(
          track.startPosition,
          track.startAngle,
          null,
          '#FFD700',
          'TY (KIEROWCA F1)',
          startingFuelKg,
          rayCount
        );
        playerCar.updateDimensionsForTrackWidth(trackWidth);
        playerCar.isManual = true;
      } else if (!isPlayerDriving) {
        playerCar = null;
      }
      break;
    }

    case 'LOAD_BRAIN': {
      try {
        const loadedSizes = JSON.parse(data.json)?.layerSizes;
        if (Array.isArray(loadedSizes) && loadedSizes[0] !== driverInputCount(rayCount)) throw new Error('incompatible network inputs');
        for (let i = 0; i < 5; i++) {
          if (population.cars[i]?.brain) {
            population.cars[i].brain!.fromJSON(data.json);
            population.cars[i].safeBrainBackup = population.cars[i].brain!.clone();
            if (population.teamRecords[i]) {
              population.teamRecords[i].bestBrain = population.cars[i].brain!.clone();
            }
          }
        }
        population.resetPositions(track);
        self.postMessage({ type: 'LOAD_BRAIN_SUCCESS', requestId: data.requestId });
      } catch (err) {
        self.postMessage({ type: 'LOAD_BRAIN_ERROR', requestId: data.requestId });
      }
      break;
    }

    case 'GET_BEST_BRAIN': {
      const best = population.bestCarEver || population.currentLeader;
      self.postMessage({
        type: 'BEST_BRAIN_RESULT',
        json: best?.brain ? best.brain.toJSON() : null,
        generation: population.generation,
        requestId: data.requestId
      });
      break;
    }

    case 'GET_ALL_MODELS': {
      const driversData = population.cars.map((_, idx) => exportDriver(population, idx));

      self.postMessage({
        type: 'ALL_MODELS_RESULT',
        requestId: data.requestId,
        data: {
          type: 'F1_ALL_MODELS',
          version: 3,
          inputCount: driverInputCount(rayCount),
          generation: population.generation,
          globalBestLap: population.globalBestLap,
          rayCount: rayCount,
          savedAt: new Date().toISOString(),
          drivers: driversData
        }
      });
      break;
    }

    case 'LOAD_ALL_MODELS': {
      try {
        const payload = data.models;
        if (payload && Array.isArray(payload.drivers)) {
          // Networks trained on a different input layout cannot drive this car: refuse the whole file.
          const wantInputs = driverInputCount(rayCount);
          for (const d of payload.drivers) {
            for (const net of [d?.brain, d?.bestBrain]) {
              if (net && Array.isArray(net.layerSizes) && net.layerSizes[0] !== wantInputs) throw new Error('incompatible network inputs');
            }
          }
          // A file from the 10-car era has no entry for the second driver of each team:
          // that driver starts from the team-mate's networks instead of a fresh brain.
          const teamCount = Population.MAX_CARS / 2;
          const resolveDriver = (i: number): { driverData: any; inherited: boolean } => {
            const own = payload.drivers.find((d: any) => d.color === population.cars[i].color);
            if (own) return { driverData: own, inherited: false };
            const mateColor = Population.F1_TEAMS[(i + teamCount) % Population.MAX_CARS].color;
            const mate = payload.drivers.find((d: any) => d.color === mateColor);
            if (mate) return { driverData: mate, inherited: true };
            return { driverData: payload.drivers[i], inherited: false };
          };
          // Validate every serialized network on clones before mutating live state.
          for (let i = 0; i < population.cars.length; i++) {
            const car = population.cars[i];
            const record = population.teamRecords[i];
            const { driverData } = resolveDriver(i);
            if (!driverData) continue;
            if (driverData.brain && car.brain) car.brain.clone().fromJSON(JSON.stringify(driverData.brain));
            if (driverData.bestBrain && record?.bestBrain) record.bestBrain.clone().fromJSON(JSON.stringify(driverData.bestBrain));
          }
          for (let i = 0; i < population.cars.length; i++) {
            const car = population.cars[i];
            const record = population.teamRecords[i];
            const { driverData, inherited } = resolveDriver(i);
            if (driverData && inherited) {
              const source = driverData.bestBrain ?? driverData.brain;
              if (source && car.brain) {
                car.brain.fromJSON(JSON.stringify(source));
                car.brain.mutate(0.02, 0.05);
                car.safeBrainBackup = car.brain.clone();
                if (record) record.bestBrain = car.brain.clone();
              }
              if (driverData.lineNet && car.lineNet) car.lineNet.fromJSON(driverData.lineNet);
              if (typeof driverData.baseBrakingAggression === 'number') {
                car.baseBrakingAggression = driverData.baseBrakingAggression;
                car.brakingAggression = driverData.baseBrakingAggression;
              }
            } else if (driverData) {
              applyDriverModel(car, record, driverData);
            }
          }
          if (payload.generation) population.generation = payload.generation;
          if (Object.prototype.hasOwnProperty.call(payload, 'globalBestLap')) {
            population.globalBestLap = typeof payload.globalBestLap === 'number' ? payload.globalBestLap : null;
          }

          // Synchronize topology with loaded architecture without assigning a fake preset on custom networks
          const sampleBrain = population.cars.find(c => c.brain)?.brain;
          if (sampleBrain) {
            const presetName = sampleBrain.topologyName;
            if (presetName !== 'Custom') {
              currentTopology = presetName;
              population.topology = presetName;
            } else {
              const customTopology: TopologySpecifier = [...sampleBrain.layerSizes];
              currentTopology = customTopology;
              population.topology = customTopology;
            }
          } else if (payload.topology) {
            currentTopology = payload.topology;
            population.topology = payload.topology;
          }

          population.resetPositions(track);
          lastSnapshotTime = 0;
          self.postMessage({ type: 'LOAD_ALL_MODELS_SUCCESS', requestId: data.requestId });
        } else {
          self.postMessage({ type: 'LOAD_ALL_MODELS_ERROR', requestId: data.requestId });
        }
      } catch (err) {
        self.postMessage({ type: 'LOAD_ALL_MODELS_ERROR', requestId: data.requestId });
      }
      break;
    }
  }
  if (ISLAND_RESET_MESSAGES.has(data.type)) resetIslands();
  else if (ISLAND_CONFIG_MESSAGES.has(data.type)) configureIslands();
};
