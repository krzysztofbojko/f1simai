import { normalizePressure } from '../ai/DriverPressure';
import { captureMotion, resolveTraffic, avoidTraffic } from '../physics/Traffic';
import { Track, TimingGate } from '../track/Track';
import { Presets } from '../track/Presets';
import { Population, LapLeaderboardEntry } from '../ai/Population';
import { Car, CarControl, TrajectoryPoint, driverInputCount } from '../physics/Car';
import { clampStressShare } from '../physics/SimConfig';
import { DRAWN_POINT_GAP, Spline } from '../math/Spline';
import { Vector2 } from '../math/Vector2';
import { TopologySpecifier } from '../ai/NeuralNetwork';
import { RaceSession, type RaceState, type RaceStanding, type QualifyingSnapshot, type FastestPitStop } from '../race/RaceSession';
import { isCompound } from '../physics/Tyres';
import { toCarView, type CarView } from './CarView';
import { Weather, isWeatherScenario, type WeatherScenario, type WeatherState } from '../physics/Weather';
import { applyDriverModel, exportDriver, mergeBetterDrivers, serializeTrack } from '../ai/Islands';
import type { LearningStatsView } from '../ai/LearningStats';

export type { TopologySpecifier, RaceState, RaceStanding, QualifyingSnapshot };
export type { CarView as SerializedCar, SerializedRay } from './CarView';

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

export interface SimSnapshot {
  /** Simulated seconds since the worker started; the display interpolates car motion on it. */
  simTime: number;
  driverPressure: number;
  cars: CarView[];
  playerCar: CarView | null;
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
  /** Fastest valid time of each of the four sectors in this session. */
  sessionBestSectors: (number | null)[];
  raceState: RaceState;
  raceTotalLaps: number;
  raceCurrentLap: number;
  raceStartLights: number;
  raceWinner: string | null;
  /** The winner has taken the chequered flag; the others finish at their next crossing of the line. */
  raceChequered: boolean;
  raceStandings: RaceStanding[];
  /** Quickest pit stop of the race so far. */
  raceFastestPit: FastestPitStop | null;
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

/** The learning diagnostics panel's data, requested about once a second while it is open. */
export interface LearningReport extends LearningStatsView {
  simTime: number;
  sessionState: RaceState;
  islands: IslandStatus;
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

/** Weather of training and every session; a race or qualifying starts again from the forecast. */
const weather = new Weather();
Car.config.weather = weather.state;
const weatherSeed = () => (Math.random() * 0x7fffffff) | 0;

let dims = Car.getDimensionsForTrackWidth(trackWidth);
let track = Presets.createGrandPrixTrack(dims.effectiveTrackWidth);
let population = createPopulation();
let playerCar: Car | null = null;
let playerControl: CarControl = { steer: 0, throttle: 0, brake: 0 };
let activeSelectedColor: string | null = null;
let manualCarColor: string | null = null;
/** Qualifying, race and session-best sectors; training runs while it is IDLE. */
const session = new RaceSession({
  get population() { return population; },
  get track() { return track; },
  weather,
  get playerCar() { return playerCar && isPlayerDriving ? playerCar : null; },
  get manualCarColor() { return manualCarColor; },
});
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
    driverPressure, mutationRate, startingFuelKg, stressLapShare: Car.config.stressLapShare, drivers: exportAllDrivers(),
    weatherScenario: weather.scenario, weatherSeed: weatherSeed() };
}

function onIslandMessage(worker: Worker, message: any): void {
  if (message?.type !== 'MODELS' || message.version !== islandVersion) return;
  if (message.busyMs > 0) islandRates.set(worker, message.steps / (message.busyMs / 1000));
  if (session.state !== 'IDLE') return;
  const adopted = mergeBetterDrivers(population, message.drivers);
  islandsAdopted += adopted;
  population.learningStats.noteAdoptions(adopted);
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
  for (const worker of islands) worker.postMessage({ type: 'CONFIG', driverPressure, mutationRate, startingFuelKg, stressLapShare: Car.config.stressLapShare, weatherScenario: weather.scenario });
}

/** Islands train only while the main field trains: not when paused, in qualifying or in a race. */
function updateIslandRun(): void {
  const run = islands.length > 0 && !isPaused && session.state === 'IDLE';
  if (run === islandsRunning) return;
  islandsRunning = run;
  for (const worker of islands) worker.postMessage({ type: 'RUN', running: run });
}

function islandStatus(): IslandStatus {
  let stepsPerSecond = 0;
  for (const rate of islandRates.values()) stepsPerSecond += rate;
  return { count: islands.length, max: maxIslands, running: islandsRunning, stepsPerSecond: Math.round(stepsPerSecond), adopted: islandsAdopted };
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
  const serializedCars: CarView[] = population.cars.map(c => {
    const ctrl: CarControl = c.isManual ? (c.manualControl || playerControl) : c.currentControl;
    return toCarView(c, ctrl, isHeadless);
  });

  let serializedPlayer: CarView | null = null;
  if (playerCar && isPlayerDriving) {
    serializedPlayer = toCarView(playerCar, playerControl, isHeadless);
  }

  let maxFitness = 0;
  for (const c of population.cars) {
    if (c.fitness > maxFitness) maxFitness = c.fitness;
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
    sessionBestSectors: [...session.sessionBestSectors],
    raceState: session.state,
    raceTotalLaps: session.totalLaps,
    raceCurrentLap: session.currentLap,
    raceStartLights: session.startLights,
    raceWinner: session.winner,
    raceChequered: session.chequered,
    // Training shows the team standings; the race classification exists from qualifying on.
    raceStandings: session.state === 'IDLE' ? [] : session.standings(),
    raceFastestPit: session.fastestPitStop ? { ...session.fastestPitStop } : null,
    weather: { ...weather.state },
    weatherScenario: weather.scenario,
    qualifying: session.qualifyingSnapshot(),
    hasQualifyingGrid: session.qualifyingGrid !== null,
    computeProfile: currentProfile,
    isHeadless: currentProfileConfig.headless,
    topology: currentTopology,
    islands: islandStatus()
  };
}

/** A new field on the current track with every user setting (rays, topology, pressure, mutation, fuel) and the session hooks. */
function createPopulation(): Population {
  const next = Population.create(track, { rayCount, topology: currentTopology, driverPressure, mutationRate, startingFuelKg });
  next.onLapCompleted = (car, event) => session.onLapCompleted(car, event);
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
  if (isPaused || session.state === 'FINISHED' || session.state === 'QUALI_FINISHED') { physicsAccumulator = 0; return; }

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
    const phase = session.beforeStep(fixedDt);
    if (phase === 'halt') break;
    if (phase === 'skip') continue;

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
        if (session.state === 'IDLE') {
          // As for the AI: the wreck stays until the marshals clear it (Population.update ages it).
          playerCar.respawnTimer -= fixedDt;
          if (playerCar.respawnTimer <= 0 && playerCar.wreckRemoved) {
            playerCar.reset(track.startPosition, track.startAngle, true);
            playerCar.isAlive = true;
          }
        }
      } else {
        playerCar.updateSensors(track, traffic);
        const lapEvent = playerCar.updatePhysics(avoidTraffic(playerCar, traffic, playerControl, track), fixedDt, track, traffic);
        if (trafficMotion) resolveTraffic(traffic, trafficMotion, playerCar);
        if (lapEvent) {
          population.recordLap({...lapEvent, compromised: lapEvent.compromised || playerCar.lapCompromised}, playerCar, true, track);
          session.onLapCompleted(playerCar, lapEvent);
        }
      }
    }
    if (session.afterStep()) break;
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
        const newPoints = Spline.generateClosedTrack(source, nextWidth, !!data.keepOrder, data.pointGap ?? DRAWN_POINT_GAP);
        const nextTrack = new Track(newPoints, nextWidth);
        nextTrack.pitLaneLoss = track.pitLaneLoss;
        trackWidth = nextWidth; track = nextTrack;
        session.resetSectors();
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
      session.resetSectors();
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
        const splinePoints = Spline.generateClosedTrack(parsedPoints, nextWidth, !!data.keepOrder, data.pointGap ?? DRAWN_POINT_GAP);
        if (splinePoints.length < 8) throw new Error('Tor jest zbyt krótki.');
        const nextTrack = new Track(splinePoints, nextWidth);
        if (typeof data.pitLaneLoss === 'number' && data.pitLaneLoss > 0) nextTrack.pitLaneLoss = data.pitLaneLoss;
        trackWidth = nextWidth; track = nextTrack;
        population = createPopulation();
        session.resetSectors();
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
        session.playerCompound = data.compound;
        for (const car of session.cars()) if (session.isPlayerCar(car)) car.nextCompound = data.compound;
        if (playerCar) playerCar.nextCompound = data.compound;
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
      Car.config.stressLapShare = clampStressShare(data.value);
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
      // A training convenience: nobody refuels during qualifying or a race.
      if (session.state !== 'IDLE') break;
      for (const car of population.cars) {
        car.fuelKg = Math.min(Car.MAX_FUEL_CAPACITY, startingFuelKg);
      }
      if (playerCar) {
        playerCar.fuelKg = Math.min(Car.MAX_FUEL_CAPACITY, startingFuelKg);
      }
      break;
    }

    case 'START_RACE': {
      isPaused = false;
      session.start({
        totalLaps: data.totalLaps,
        withQualifying: !!data.withQualifying,
        useQualifyingGrid: !!data.useQualifyingGrid,
        qualifyingSessionSeconds: data.qualifyingSessionSeconds,
        weatherSeed: typeof data.weatherSeed === 'number' ? data.weatherSeed : weatherSeed(),
      });
      break;
    }

    case 'CLEAR_LEARNING': {
      // Clean slate: a population exactly as at start-up (seed networks only, no records,
      // lines, pace or generations). Track and user settings are kept; any session ends.
      session.clear();
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
      session.stop();
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
        car.pitPhase = '';
        car.pitShowTimer = 0;
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
      session.resetSectors();
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

    case 'GET_LEARNING_STATS': {
      const report: LearningReport = { ...population.learningStats.view(population), simTime, sessionState: session.state, islands: islandStatus() };
      self.postMessage({ type: 'LEARNING_STATS_RESULT', requestId: data.requestId, report });
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
