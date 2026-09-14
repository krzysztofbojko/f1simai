import { Track, TimingGate } from '../track/Track';
import { Presets } from '../track/Presets';
import { Population, LapLeaderboardEntry } from '../ai/Population';
import { Car, CarControl, TrajectoryPoint, CheckpointDelta } from '../physics/Car';
import { Spline } from '../math/Spline';
import { Vector2 } from '../math/Vector2';

export type RaceState = 'IDLE' | 'GRID_START' | 'RACING' | 'FINISHED';

export interface RaceStanding {
  rank: number;
  driverName: string;
  carColor: string;
  lapsCompleted: number;
  gap: string;
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

let dims = Car.getDimensionsForTrackWidth(trackWidth);
let track = Presets.createGrandPrixTrack(dims.effectiveTrackWidth);
let population = new Population(10, track, rayCount);
let playerCar: Car | null = null;
let playerControl: CarControl = { steer: 0, throttle: 0, brake: 0 };
let activeSelectedColor: string | null = null;
let manualCarColor: string | null = null;
let sessionBestSplits: (number | null)[] = [null, null, null, null];
const detectedCores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 8) : 8;

function serializeCar(car: Car, ctrl?: CarControl): SerializedCar {
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
    skidMarks: car.skidMarks.map(m => ({ x: m.x, y: m.y })),
    sensorRays: car.rayHits.map(h => ({
      x: h.point.x,
      y: h.point.y,
      dist: h.dist
    })),
    ctrl: ctrl || { steer: 0, throttle: 0, brake: 0 },
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

function createSnapshot(): SimSnapshot {
  const leader = population.currentLeader;
  const targetCar = activeSelectedColor
    ? population.cars.find(c => c.color === activeSelectedColor) || leader
    : leader;

  let activeBrainJson: string | undefined;
  if (targetCar && targetCar.brain) {
    activeBrainJson = targetCar.brain.toJSON();
  }

  const serializedCars: SerializedCar[] = population.cars.map(c => {
    let ctrl: CarControl = { steer: 0, throttle: 0, brake: 0 };
    if (c.isAlive) {
      ctrl = c.isManual ? (c.manualControl || playerControl) : c.getAIControl(track, population.leaderCheckpointSpeeds);
    }
    return serializeCar(c, ctrl);
  });

  let serializedPlayer: SerializedCar | null = null;
  if (playerCar && isPlayerDriving) {
    serializedPlayer = serializeCar(playerCar, playerControl);
  }

  let maxFitness = 0;
  for (const c of population.cars) {
    if (c.fitness > maxFitness) maxFitness = c.fitness;
  }

  // Calculate live race standings if in race mode
  let raceStandings: RaceStanding[] = [];
  const allRacingCars: Car[] = [...population.cars];
  if (playerCar && isPlayerDriving) {
    allRacingCars.push(playerCar);
  }

  allRacingCars.sort((a, b) => {
    // Active cars always rank ahead of dead/crashed cars
    if (a.isAlive !== b.isAlive) {
      return a.isAlive ? -1 : 1;
    }
    if (b.raceLapsCompleted !== a.raceLapsCompleted) {
      return b.raceLapsCompleted - a.raceLapsCompleted;
    }
    return a.totalRaceTime - b.totalRaceTime;
  });

  const raceLeader = allRacingCars.find(c => c.isAlive) || allRacingCars[0];
  raceStandings = allRacingCars.map((car, idx) => {
    let gapStr = '';
    if (!car.isAlive && raceState !== 'IDLE') {
      gapStr = 'DNF (ROZBITY)';
    } else if (car === raceLeader) {
      gapStr = 'LIDER';
    } else if (raceLeader) {
      const lapDiff = raceLeader.raceLapsCompleted - car.raceLapsCompleted;
      if (lapDiff > 0) {
        gapStr = `+${lapDiff} OKR`;
      } else {
        const timeDiff = car.totalRaceTime - raceLeader.totalRaceTime;
        gapStr = timeDiff > 0 ? `+${timeDiff.toFixed(2)}s` : '+0.00s';
      }
    }

    return {
      rank: idx + 1,
      driverName: car.driverName,
      carColor: car.color,
      lapsCompleted: car.raceLapsCompleted,
      gap: gapStr,
      pitStops: car.pitStopsCount,
      isPitting: car.isPitting,
      isAlive: car.isAlive,
      bestLap: car.bestLapTime,
      lastLap: car.lastLapTime,
      totalTime: Math.round(car.totalRaceTime * 10) / 10,
      isPlayer: car.isManual
    };
  });

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
    raceStandings
  };
}

// Simulation step execution
function runSimulationSteps(): void {
  if (isPaused) return;

  const steps = (speedMultiplier === 'max')
    ? 200
    : (typeof speedMultiplier === 'number' ? speedMultiplier : 1);
  const fixedDt = 1 / 60;

  for (let s = 0; s < steps; s++) {
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
          raceWinner = winner.driverName;
          raceState = 'FINISHED';
        } else if (aliveCount === 0) {
          raceWinner = 'BRAK (WSZYSCY ROZBICI - DNF)';
          raceState = 'FINISHED';
        }
      }
    }
  }
}

// Background simulation ticker: targets 60 Hz snapshot dispatch
function simLoop() {
  runSimulationSteps();
  const snapshot = createSnapshot();
  self.postMessage({ type: 'SNAPSHOT', snapshot });
}

setInterval(simLoop, 16);

// Message handling from Main Thread
self.onmessage = (e: MessageEvent) => {
  const data = e.data;
  if (!data) return;

  switch (data.type) {
    case 'INIT': {
      self.postMessage({
        type: 'READY',
        cpuCores: detectedCores
      });
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
      population = new Population(10, track, rayCount);
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
          population = new Population(10, track, rayCount);
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
      population.rayCount = rayCount;
      population.resetAll(track);
      if (playerCar) {
        playerCar.setRayCount(rayCount);
        playerCar.reset(track.startPosition, track.startAngle, true);
      }
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
          }
        }
        population.resetAll(track);
        self.postMessage({ type: 'LOAD_BRAIN_SUCCESS' });
      } catch (err) {
        self.postMessage({ type: 'LOAD_BRAIN_ERROR' });
      }
      break;
    }

    case 'GET_BEST_BRAIN': {
      const best = population.bestCarEver || population.currentLeader;
      if (best && best.brain) {
        self.postMessage({
          type: 'BEST_BRAIN_RESULT',
          json: best.brain.toJSON(),
          generation: population.generation
        });
      }
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
          bestFitness: record?.bestFitness || car.fitness,
          baseBrakingAggression: car.baseBrakingAggression,
          brakingAggression: car.brakingAggression,
        };
      });

      self.postMessage({
        type: 'ALL_MODELS_RESULT',
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
          for (let i = 0; i < population.cars.length; i++) {
            const car = population.cars[i];
            const record = population.teamRecords[i];
            const driverData = payload.drivers.find((d: any) => d.color === car.color) || payload.drivers[i];
            if (driverData) {
              if (driverData.brain && car.brain) {
                car.brain.fromJSON(JSON.stringify(driverData.brain));
              }
              if (driverData.bestBrain && record?.bestBrain) {
                record.bestBrain.fromJSON(JSON.stringify(driverData.bestBrain));
              }
              if (typeof driverData.baseBrakingAggression === 'number') {
                car.baseBrakingAggression = driverData.baseBrakingAggression;
                car.brakingAggression = driverData.brakingAggression || driverData.baseBrakingAggression;
              }
              if (typeof driverData.bestLapTime === 'number') {
                car.bestLapTime = driverData.bestLapTime;
                if (record) record.bestLapTime = driverData.bestLapTime;
              }
            }
          }
          if (payload.generation) population.generation = payload.generation;
          if (payload.globalBestLap) population.globalBestLap = payload.globalBestLap;
          population.resetAll(track);
          self.postMessage({ type: 'LOAD_ALL_MODELS_SUCCESS' });
        } else {
          self.postMessage({ type: 'LOAD_ALL_MODELS_ERROR' });
        }
      } catch (err) {
        self.postMessage({ type: 'LOAD_ALL_MODELS_ERROR' });
      }
      break;
    }
  }
};
