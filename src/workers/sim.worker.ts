import { Track, TimingGate } from '../track/Track';
import { Presets } from '../track/Presets';
import { Population, LapLeaderboardEntry } from '../ai/Population';
import { Car, CarControl, TrajectoryPoint, CheckpointDelta } from '../physics/Car';
import { Spline } from '../math/Spline';
import { Vector2 } from '../math/Vector2';
import { TopologySpecifier } from '../ai/NeuralNetwork';

export type { TopologySpecifier };

export type RaceState = 'IDLE' | 'GRID_START' | 'RACING' | 'FINISHED';

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
  raceLapsCompleted: number;
}

export interface SimSnapshot {
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
  computeProfile?: ComputeProfile;
  isHeadless?: boolean;
  topology?: TopologySpecifier;
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

let dims = Car.getDimensionsForTrackWidth(trackWidth);
let track = Presets.createGrandPrixTrack(dims.effectiveTrackWidth);
let population = new Population(10, track, rayCount, currentTopology);
let playerCar: Car | null = null;
let playerControl: CarControl = { steer: 0, throttle: 0, brake: 0 };
let activeSelectedColor: string | null = null;
let manualCarColor: string | null = null;
let sessionBestSplits: (number | null)[] = [null, null, null, null];
const detectedCores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 8) : 8;

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
    timingGates: track.timingGates.map(g => ({ ...g })),
    sessionBestSplits: [...sessionBestSplits],
    raceState,
    raceTotalLaps,
    raceCurrentLap,
    raceStartLights,
    raceWinner,
    raceStandings,
    computeProfile: currentProfile,
    isHeadless: currentProfileConfig.headless,
    topology: currentTopology
  };
}

// Simulation step execution: elapsed-time accumulator keeps 1x tied to real time.
let lastPhysicsTick = performance.now();
let physicsAccumulator = 0;
function runSimulationSteps(): void {
  const now = performance.now();
  const elapsed = Math.max(0, Math.min(0.25, (now - lastPhysicsTick) / 1000));
  lastPhysicsTick = now;
  if (isPaused || raceState === 'FINISHED') { physicsAccumulator = 0; return; }

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

    population.update(fixedDt, track);

    if (playerCar && isPlayerDriving) {
      if (!playerCar.isAlive) {
        if (raceState === 'IDLE') {
          playerCar.respawnTimer -= fixedDt;
          if (playerCar.respawnTimer <= 0) {
            playerCar.reset(track.startPosition, track.startAngle, true);
            playerCar.isAlive = true;
          }
        }
      } else {
        playerCar.updateSensors(track);
        const lapEvent = playerCar.updatePhysics(playerControl, fixedDt, track);
        if (lapEvent) {
          population.recordLap(lapEvent, playerCar, true);
        }
      }
    }

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

// Message handling from Main Thread
self.onmessage = (e: MessageEvent) => {
  const data = e.data;
  if (!data) return;

  switch (data.type) {
    case 'INIT': {
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
      trackWidth = data.trackWidth;
      dims = Car.getDimensionsForTrackWidth(trackWidth);
      if (track.points.length > 0) {
        const centerPoints = track.points.map(p => p.center);
        const newPoints = Spline.generateClosedTrack(centerPoints, dims.effectiveTrackWidth, 18);
        if (newPoints.length > 3) {
          track = new Track(newPoints, dims.effectiveTrackWidth);
          population.resetAll(track);
          if (playerCar) {
            playerCar.reset(track.startPosition, track.startAngle, true);
            playerCar.updateDimensionsForTrackWidth(trackWidth);
          }
        }
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
      population = new Population(10, track, rayCount, currentTopology);
      if (playerCar) {
        playerCar.reset(track.startPosition, track.startAngle, true);
        playerCar.updateDimensionsForTrackWidth(trackWidth);
      }
      break;
    }

    case 'SET_CUSTOM_TRACK': {
      const parsedPoints: Vector2[] = (data.points || []).map((p: any) => new Vector2(p.x, p.y));
      if (parsedPoints.length >= 4) {
        if (typeof data.trackWidth === 'number') {
          trackWidth = data.trackWidth;
        }
        dims = Car.getDimensionsForTrackWidth(trackWidth);
        const splinePoints = Spline.generateClosedTrack(parsedPoints, dims.effectiveTrackWidth, 18);
        if (splinePoints.length >= 8) {
          track = new Track(splinePoints, dims.effectiveTrackWidth);
          population = new Population(10, track, rayCount, currentTopology);
          if (playerCar) {
            playerCar.reset(track.startPosition, track.startAngle, true);
            playerCar.updateDimensionsForTrackWidth(trackWidth);
          }
        }
      }
      break;
    }

    case 'SET_MUTATION': {
      mutationRate = data.value;
      population.mutationRate = mutationRate;
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
      raceState = 'GRID_START';
      raceCurrentLap = 1;
      raceStartLights = 0;
      raceStartTimer = 0;
      raceWinner = null;
      frozenRaceStandings = null;
      isPaused = false;
      population.isRaceMode = true;

      // Position all 10 cars on grid slots
      for (let i = 0; i < population.cars.length; i++) {
        const car = population.cars[i];
        const record = population.teamRecords[i];
        if (car) {
          // CRITICAL: Preserve learned neural network! Equip the best brain learned during training!
          if (record && record.bestBrain && !car.isManual) {
            car.brain = record.bestBrain.clone();
            car.safeBrainBackup = record.bestBrain.clone();
          }
          car.isRaceMode = true;
          const slot = track.getGridSlot(i);
          car.reset(slot.pos, slot.heading, true, slot.checkpointIdx);
          car.updateDimensionsForTrackWidth(track.width);
          car.fuelKg = 50.0;
          car.pitStopsCount = 0;
          car.raceLapsCompleted = 0;
          car.totalRaceTime = 0;
          car.isAlive = true;
          car.isPitting = false;
          car.wantsToPit = false;
        }
      }

      if (playerCar) {
        const slot = track.getGridSlot(9);
        playerCar.isRaceMode = true;
        playerCar.reset(slot.pos, slot.heading, true, slot.checkpointIdx);
        playerCar.updateDimensionsForTrackWidth(track.width);
        playerCar.fuelKg = 50.0;
        playerCar.pitStopsCount = 0;
        playerCar.raceLapsCompleted = 0;
        playerCar.totalRaceTime = 0;
        playerCar.isAlive = true;
        playerCar.isPitting = false;
        playerCar.wantsToPit = false;
      }
      break;
    }

    case 'STOP_RACE': {
      raceState = 'IDLE';
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
        }
        const slot = track.getGridSlot(i);
        const nextCpIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
        car.reset(slot.pos, slot.heading, true, nextCpIdx);
        car.updateDimensionsForTrackWidth(track.width);
        car.fuelKg = population.startingFuelKg;
        car.isAlive = true;
        car.pitStopsCount = 0;
        car.raceLapsCompleted = 0;
        car.totalRaceTime = 0;
        car.isPitting = false;
        car.wantsToPit = false;
      }
      if (playerCar) {
        playerCar.isRaceMode = false;
        const slot = track.getGridSlot(9);
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
        }
        const slot = track.getGridSlot(i);
        const nextCpIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
        car.reset(slot.pos, slot.heading, true, nextCpIdx);
        car.updateDimensionsForTrackWidth(track.width);
        car.fuelKg = population.startingFuelKg;
        car.isAlive = true;
        car.pitStopsCount = 0;
        car.raceLapsCompleted = 0;
        car.totalRaceTime = 0;
        car.isPitting = false;
        car.wantsToPit = false;
      }
      if (playerCar) {
        const slot = track.getGridSlot(9);
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
          '#FF8000',
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
      const driversData = population.cars.map((car, idx) => {
        const record = population.teamRecords[idx];
        return {
          driverName: car.driverName,
          teamName: record?.teamName || '',
          color: car.color,
          carName: record?.carName || '',
          brain: car.brain ? JSON.parse(car.brain.toJSON()) : null,
          bestBrain: record?.bestBrain ? JSON.parse(record.bestBrain.toJSON()) : null,
          bestLapTime: record?.bestLapTime || car.bestLapTime,
          bestLapSplits: record?.bestLapSplits ? [...record.bestLapSplits] : (car.bestLapSplits ? [...car.bestLapSplits] : null),
          bestFitness: record?.bestFitness || car.fitness,
          baseBrakingAggression: car.baseBrakingAggression,
          brakingAggression: car.brakingAggression,
        };
      });

      self.postMessage({
        type: 'ALL_MODELS_RESULT',
        requestId: data.requestId,
        data: {
          type: 'F1_ALL_MODELS',
          version: 2,
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
          // Validate every serialized network on clones before mutating live state.
          for (let i = 0; i < population.cars.length; i++) {
            const car = population.cars[i];
            const record = population.teamRecords[i];
            const driverData = payload.drivers.find((d: any) => d.color === car.color) || payload.drivers[i];
            if (!driverData) continue;
            if (driverData.brain && car.brain) car.brain.clone().fromJSON(JSON.stringify(driverData.brain));
            if (driverData.bestBrain && record?.bestBrain) record.bestBrain.clone().fromJSON(JSON.stringify(driverData.bestBrain));
          }
          for (let i = 0; i < population.cars.length; i++) {
            const car = population.cars[i];
            const record = population.teamRecords[i];
            const driverData = payload.drivers.find((d: any) => d.color === car.color) || payload.drivers[i];
            if (driverData) {
              if (driverData.brain && car.brain) {
                car.brain.fromJSON(JSON.stringify(driverData.brain));
                car.safeBrainBackup = car.brain.clone();
              }
              if (driverData.bestBrain && record) {
                if (!record.bestBrain && car.brain) {
                  record.bestBrain = car.brain.clone();
                }
                record.bestBrain?.fromJSON(JSON.stringify(driverData.bestBrain));
              }
              if (typeof driverData.baseBrakingAggression === 'number') {
                car.baseBrakingAggression = driverData.baseBrakingAggression;
                car.brakingAggression = driverData.brakingAggression || driverData.baseBrakingAggression;
              }
              if (typeof driverData.bestLapTime === 'number') {
                car.bestLapTime = driverData.bestLapTime;
                if (record) record.bestLapTime = driverData.bestLapTime;
              }
              if (Array.isArray(driverData.bestLapSplits) && driverData.bestLapSplits.length === 4) {
                car.bestLapSplits = [...driverData.bestLapSplits];
                if (record) record.bestLapSplits = [...driverData.bestLapSplits];
              } else {
                car.bestLapSplits = [null, null, null, null];
                if (record) record.bestLapSplits = [null, null, null, null];
              }
              if (typeof driverData.bestFitness === 'number' && record) {
                record.bestFitness = driverData.bestFitness;
              }
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
};
