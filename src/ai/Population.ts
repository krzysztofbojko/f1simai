import { updateRaceSafety, planRaceLine } from './RaceTraffic';
import { captureMotion, avoidTraffic, resolveTraffic } from '../physics/Traffic';
import { Car, LapFinishEvent, TrajectoryPoint } from '../physics/Car';
import { NeuralNetwork, TopologySpecifier } from './NeuralNetwork';
import { Track } from '../track/Track';

export interface F1TeamDef {
  teamName: string;
  carName: string;
  driverName: string;
  color: string;
}

export interface TeamRecord {
  teamName: string;
  carName: string;
  driverName: string;
  color: string;
  bestBrain: NeuralNetwork | null;
  bestFitness: number;
  bestLapTime: number | null;
  bestLapSplits: (number | null)[] | null;
  lastLapTime: number | null;
  avgSpeed: number;
  topSpeed: number;
  fuelRemaining: number;
  lapsCount: number;
  stagnationCounter: number;
  currentMutationRate: number;
}

export interface LapLeaderboardEntry {
  id: number;
  rank: number;
  lapTime: number;
  lastLapTime?: number | null;
  avgSpeed: number; // km/h
  topSpeed: number; // km/h
  fuelRemaining: number; // kg
  driverName: string;
  carColor: string;
  generation: number;
  isPlayer?: boolean;
  hasFinishedLap?: boolean;
}

export class Population {
  public cars: Car[] = [];
  public teamRecords: TeamRecord[] = [];
  public populationSize: number = 10;
  public generation: number = 1;
  public bestFitness: number = 0;
  public globalBestLap: number | null = null;
  public bestCarEver: Car | null = null;
  public currentLeader: Car | null = null;
  public isRaceMode: boolean = false;

  // Optimal Racing Line & Leaderboard
  public bestRacingLine: TrajectoryPoint[] = [];
  public top5Laps: LapLeaderboardEntry[] = [];
  public leaderCheckpointSpeeds: number[] = [];
  public learningHistory: { time: number; bestLap: number; avgLap: number; teamColor: string }[] = [];

  // Evolution parameters
  public mutationRate: number = 0.02;
  public mutationStrength: number = 0.05;
  public startingFuelKg: number = 105.0;
  public rayCount: number = 25;
  public topology: TopologySpecifier = 'Standard';

  // Auto-evolution & Training Generation Management Parameters
  public autoEvolutionEnabled: boolean = true;
  public generationMaxTime: number = 300.0;     // Legacy alias / Hard timeout in seconds
  public generationMaxTimeBeforeFirstLap: number = 200.0; // Hard timeout safety fuse before 1st lap in seconds
  public generationTargetLaps: number = 2;       // Target completed laps for best driver after 1st lap (ok. 85-90s)
  public graceMaxTime: number = 15.0;            // Maximum grace period in seconds to close in-progress lap
  public generationMinTime: number = 8.0;        // Minimum duration before stagnation/all-dead trigger can end generation
  public stagnationMaxTime: number = 150.0;      // Max seconds without generation checkpoint/lap advancement before emergency evolve
  public allDeadMaxTime: number = 6.0;           // Max seconds with 0 alive cars before emergency evolve
  public generationTimer: number = 0;            // Current generation elapsed time in seconds
  public stagnationTimer: number = 0;            // Time elapsed since last checkpoint/lap progress in current generation
  public graceTimer: number = 0;                 // Time elapsed in current grace period
  public isGracePeriodActive: boolean = false;   // Whether generation is currently in grace period closing lap
  public allDeadTimer: number = 0;               // Time elapsed with zero living cars
  public generationMaxLaps: number = 0;          // Highest completed lap count achieved by any car in current generation
  public generationMaxProgress: number = 0;      // Furthest checkpoint progress index achieved in current generation
  public currentGenerationBestFitness: number = 0; // Best fitness in current generation
  public lastSnapshotFitness: number[] = [];     // Track fitness thresholds for brain snapshotting per car
  public carGenerationLaps: number[] = [];       // Completed laps count in current generation per car
  public carCheckpointsInRun: number[] = [];     // Continuous checkpoints passed in current run per car
  public carMaxProgress: number[] = [];          // Maximum cumulative checkpoint progress achieved in current gen per car
  public lastCarCheckpointIdx: number[] = [];    // Last seen checkpoint index per car for advancement detection

  // Respawn Offspring Mutation Parameters
  public respawnMutationEnabled: boolean = false;
  public respawnMutationRate: number = 0.01;     // Probability of weight mutation on individual car respawn
  public respawnMutationStrength: number = 0.02; // Perturbation strength for mutated weights on respawn

  public static readonly F1_TEAMS: F1TeamDef[] = [
    { teamName: 'Scuderia Ferrari', carName: 'SF-24', driverName: 'Charles Leclerc', color: '#E10600' },
    { teamName: 'Mercedes-AMG Petronas', carName: 'W15', driverName: 'Lewis Hamilton', color: '#00D2BE' },
    { teamName: 'Red Bull Racing', carName: 'RB20', driverName: 'Max Verstappen', color: '#3671C6' },
    { teamName: 'McLaren F1 Team', carName: 'MCL38', driverName: 'Lando Norris', color: '#FF8000' },
    { teamName: 'Aston Martin Aramco', carName: 'AMR24', driverName: 'Fernando Alonso', color: '#229971' },
    { teamName: 'BWT Alpine F1', carName: 'A524', driverName: 'Pierre Gasly', color: '#0090FF' },
    { teamName: 'Stake Kick Sauber', carName: 'C44', driverName: 'Valtteri Bottas', color: '#52E252' },
    { teamName: 'Visa Cash App RB', carName: 'VCARB 01', driverName: 'Daniel Ricciardo', color: '#6692FF' },
    { teamName: 'MoneyGram Haas F1', carName: 'VF-24', driverName: 'Nico Hülkenberg', color: '#B6BABD' },
    { teamName: 'Williams Racing', carName: 'FW46', driverName: 'Alex Albon', color: '#005AFF' },
  ];

  constructor(size: number = 10, track: Track, rayCount: number = 25, topology: TopologySpecifier = 'Standard') {
    this.populationSize = Math.min(10, Math.max(1, size));
    this.rayCount = rayCount;
    this.topology = topology;
    this.initPopulation(track);
  }

  public resetGenerationCounters(track?: Track): void {
    this.generationTimer = 0;
    this.stagnationTimer = 0;
    this.graceTimer = 0;
    this.isGracePeriodActive = false;
    this.allDeadTimer = 0;
    this.generationMaxLaps = 0;
    this.generationMaxProgress = 0;
    this.currentGenerationBestFitness = 0;
    this.lastSnapshotFitness = new Array(this.populationSize).fill(0);
    this.carGenerationLaps = new Array(this.populationSize).fill(0);
    this.carCheckpointsInRun = new Array(this.populationSize).fill(0);
    this.carMaxProgress = new Array(this.populationSize).fill(0);
    this.lastCarCheckpointIdx = new Array(this.populationSize).fill(0);

    if (track && track.checkpoints && track.checkpoints.length > 0) {
      for (let i = 0; i < this.populationSize; i++) {
        const slot = track.getGridSlot(i);
        this.lastCarCheckpointIdx[i] = (slot.checkpointIdx + 1) % track.checkpoints.length;
      }
    } else if (this.cars && this.cars.length > 0) {
      for (let i = 0; i < Math.min(this.populationSize, this.cars.length); i++) {
        this.lastCarCheckpointIdx[i] = this.cars[i].currentCheckpointIdx;
      }
    }
  }

  private initPopulation(track: Track): void {
    this.cars = [];
    this.teamRecords = [];
    const baseBrain = NeuralNetwork.createTrainedDriverNetwork(this.rayCount, this.topology);

    for (let i = 0; i < this.populationSize; i++) {
      const def = Population.F1_TEAMS[i % Population.F1_TEAMS.length];
      const slot = track.getGridSlot(i);
      const brain = baseBrain.clone();
      if (i > 0) {
        brain.mutate(0.04, 0.10);
      }

      this.teamRecords.push({
        teamName: def.teamName,
        carName: def.carName,
        driverName: def.driverName,
        color: def.color,
        bestBrain: brain.clone(),
        bestFitness: 0,
        bestLapTime: null,
        bestLapSplits: [null, null, null, null],
        lastLapTime: null,
        avgSpeed: 0,
        topSpeed: 0,
        fuelRemaining: this.startingFuelKg,
        lapsCount: 0,
        stagnationCounter: 0,
        currentMutationRate: this.mutationRate,
      });

      const car = new Car(
        slot.pos,
        slot.heading,
        brain,
        def.color,
        `${def.driverName} (${def.carName})`,
        this.startingFuelKg,
        this.rayCount
      );
      car.currentCheckpointIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
      car.updateDimensionsForTrackWidth(track.width);
      this.cars.push(car);
    }
    this.resetGenerationCounters(track);
  }

  get aliveCount(): number {
    return this.cars.filter(c => c.isAlive).length;
  }

  recordLap(lapEvent: LapFinishEvent, car: Car, isPlayer: boolean = false, track?: Track): void {
    if (lapEvent.compromised) {
      const record = this.teamRecords.find(r => r.color === car.color);
      if (record) { record.lapsCount++; record.lastLapTime = lapEvent.lapTime; }
      return; // Race timing counts it; contaminated performance never evaluates a brain.
    }
    if (!this.globalBestLap || lapEvent.lapTime < this.globalBestLap) {
      this.globalBestLap = lapEvent.lapTime;
      if (lapEvent.trajectory.length > 5) {
        this.bestRacingLine = [...lapEvent.trajectory];
        // Trajectory samples and checkpoints have different spacing. Index
        // coaching by the checkpoint's actual position, not sample number.
        this.leaderCheckpointSpeeds = track ? track.checkpoints.map(checkpoint => {
          let nearest = lapEvent.trajectory[0];
          let distance = Infinity;
          for (const point of lapEvent.trajectory) {
            const candidate = (point.x - checkpoint.center.x) ** 2 + (point.y - checkpoint.center.y) ** 2;
            if (candidate < distance) { distance = candidate; nearest = point; }
          }
          return nearest.speed;
        }) : [];
      }
    }

    const t = this.teamRecords.find(r => r.color === car.color);
    if (t) {
      t.lapsCount++;
      t.lastLapTime = lapEvent.lapTime;
      if (!t.bestLapTime || lapEvent.lapTime < t.bestLapTime) {
        t.bestLapTime = lapEvent.lapTime;
        t.bestLapSplits = [...car.bestLapSplits];
        t.avgSpeed = lapEvent.avgSpeed;
        t.topSpeed = lapEvent.maxSpeed;
        t.fuelRemaining = lapEvent.fuelRemaining;
        // Point 3: Simulated Annealing Cooldown on personal best lap
        t.stagnationCounter = 0;
        t.currentMutationRate = Math.max(0.025, t.currentMutationRate * 0.85);
        if (car.brain) {
          t.bestBrain = car.brain.clone();
        }
        car.safeBrainBackup = car.brain ? car.brain.clone() : null;
      } else if (t.bestBrain && lapEvent.lapTime > t.bestLapTime + 2.5) {
        // PERFORMANCE GUARD: If car suffered degradation or slow lap, restore its proven championship brain!
        car.brain = t.bestBrain.clone();
        car.safeBrainBackup = t.bestBrain.clone();
        car.replayBuffer = [];
        car.replayStepTimer = 0;
      }
    }

    // Record learning history point for the live progress chart
    this.learningHistory.push({
      time: Date.now(),
      bestLap: this.globalBestLap || lapEvent.lapTime,
      avgLap: lapEvent.lapTime,
      teamColor: car.color,
    });
    if (this.learningHistory.length > 50) {
      this.learningHistory.shift();
    }

    const newEntry: LapLeaderboardEntry = {
      id: car.id,
      rank: 1,
      lapTime: lapEvent.lapTime,
      lastLapTime: lapEvent.lapTime,
      avgSpeed: lapEvent.avgSpeed,
      topSpeed: lapEvent.maxSpeed,
      fuelRemaining: lapEvent.fuelRemaining,
      driverName: isPlayer ? 'KIEROWCA (GRACZ)' : car.driverName,
      carColor: car.color,
      generation: this.generation,
      isPlayer,
      hasFinishedLap: true,
    };

    const existingTop = this.top5Laps.find(e => e.driverName === newEntry.driverName || e.carColor === newEntry.carColor);
    if (!existingTop || newEntry.lapTime < existingTop.lapTime) {
      this.top5Laps = this.top5Laps.filter(e => e.driverName !== newEntry.driverName && e.carColor !== newEntry.carColor);
      this.top5Laps.push(newEntry);
      this.top5Laps.sort((a, b) => a.lapTime - b.lapTime);
      this.top5Laps.forEach((entry, idx) => {
        entry.rank = idx + 1;
      });
    }
  }

  get teamStandings(): LapLeaderboardEntry[] {
    const list: LapLeaderboardEntry[] = this.teamRecords.map((t, idx) => {
      const car = this.cars.find(c => c.color === t.color) || this.cars[idx];
      const hasLap = typeof t.bestLapTime === 'number' && t.bestLapTime > 0;
      return {
        id: car ? car.id : idx,
        rank: 1,
        lapTime: hasLap ? t.bestLapTime! : (car ? car.lapTime : 0),
        lastLapTime: typeof t.lastLapTime === 'number' ? t.lastLapTime : (car && typeof car.lastLapTime === 'number' ? car.lastLapTime : null),
        avgSpeed: t.avgSpeed || (car ? Math.round(car.speedKmh) : 0),
        topSpeed: t.topSpeed || (car ? Math.round(car.maxSpeedInLap * 3.6) : 0),
        fuelRemaining: car ? Math.round(car.fuelKg * 10) / 10 : this.startingFuelKg,
        driverName: `${t.driverName} (${t.carName})`,
        carColor: t.color,
        generation: this.generation,
        hasFinishedLap: hasLap,
      };
    });

    list.sort((a, b) => {
      if (a.hasFinishedLap && b.hasFinishedLap) return a.lapTime - b.lapTime;
      if (a.hasFinishedLap) return -1;
      if (b.hasFinishedLap) return 1;
      const carA = this.cars.find(c => c.color === a.carColor);
      const carB = this.cars.find(c => c.color === b.carColor);
      return (carB ? carB.fitness : 0) - (carA ? carA.fitness : 0);
    });

    list.forEach((entry, idx) => {
      entry.rank = idx + 1;
    });

    return list;
  }

  update(dt: number, track: Track, extraCars: Car[] = []): void {
    const traffic = [...this.cars, ...extraCars];
    if (this.isRaceMode) updateRaceSafety(traffic, track);
    const motion = captureMotion(traffic);
    const laps: { car: Car; event: LapFinishEvent }[] = [];
    let maxFitness = -Infinity;
    let leader: Car | null = null;

    // Find current session champion brain across all teams (by lap time if available, or best partial fitness)
    let championBrain: NeuralNetwork | null = null;
    let eliteRecord: TeamRecord | null = null;
    const sortedByLap = this.teamRecords
      .filter(t => t.bestLapTime !== null)
      .sort((a, b) => a.bestLapTime! - b.bestLapTime!);

    if (sortedByLap.length > 0 && sortedByLap[0].bestBrain) {
      eliteRecord = sortedByLap[0];
      championBrain = sortedByLap[0].bestBrain;
    } else {
      // Prior to any car finishing a full lap, select the brain with the highest partial fitness
      const sortedByFit = [...this.teamRecords]
        .filter(t => t.bestBrain !== null)
        .sort((a, b) => b.bestFitness - a.bestFitness);
      if (sortedByFit.length > 0 && sortedByFit[0].bestBrain && sortedByFit[0].bestFitness > 0) {
        eliteRecord = sortedByFit[0];
        championBrain = sortedByFit[0].bestBrain;
      }
    }
    const eliteIndex = eliteRecord ? this.teamRecords.indexOf(eliteRecord) : -1;

    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      const record = this.teamRecords[i];

      if (car.isAlive) {
        planRaceLine(car, traffic, track, dt);
        const prevCp = this.lastCarCheckpointIdx[i] ?? car.currentCheckpointIdx;
        // A rival must occupy the same local stretch, face the same direction,
        // and be ahead by at most 35 m. Nearby parallel track sections do not count.
        const tangent = track.checkpoints[car.currentCheckpointIdx]?.tangent;
        const rival = this.isRaceMode && tangent ? this.cars.find(other => {
          if (other === car || !other.isAlive || other.isPitting || other.isFinishedRace || other.raceLapsCompleted !== car.raceLapsCompleted) return false;
          const indexGap = Math.abs(other.currentCheckpointIdx - car.currentCheckpointIdx);
          if (Math.min(indexGap, track.checkpoints.length - indexGap) > 2) return false;
          const offset = other.pos.sub(car.pos);
          const ahead = offset.dot(tangent);
          return ahead > 2 && ahead < 35 && Math.abs(offset.cross(tangent)) < track.width && Math.cos(other.heading - car.heading) > 0.9;
        }) : undefined;
        const eligible = this.isRaceMode && !car.yellowFlag && !car.isManual && !car.isPitting && !car.wantsToPit && !car.isFinishedRace && car.speed > 12 && car.surface === 'asphalt' && !car.isSkidding && !car.incidentActive && car.recoveryTimer <= 0;
        car.battlePush.step(dt, rival?.driverName ?? null, eligible);
        car.battleOpponent = car.battlePush.opponent;
        if (car.battlePush.remaining > 0) {
          // Race timing counts; tactical assistance is not a baseline model result.
          car.lapCompromised = true;
          car.replayBuffer = [];
        }
        car.updateSensors(track);
        // Point 1: pass leader speeds for telemetry coaching, or use human player WASD input (learning enabled only in simulation step)
        let control = car.isManual ? car.manualControl : car.getAIControl(track, this.leaderCheckpointSpeeds, !this.isRaceMode);
        control = avoidTraffic(car, traffic, control, track);
        const lapEvent = car.updatePhysics(control, dt, track);

        if (lapEvent) {
          laps.push({car, event: lapEvent});
          this.carGenerationLaps[i] = (this.carGenerationLaps[i] || 0) + 1;
          if (this.carGenerationLaps[i] > this.generationMaxLaps) {
            this.generationMaxLaps = this.carGenerationLaps[i];
          }
          this.carCheckpointsInRun[i] = 0;
          this.carMaxProgress[i] = this.carGenerationLaps[i] * track.checkpoints.length;
          if (this.carMaxProgress[i] > this.generationMaxProgress) {
            this.generationMaxProgress = this.carMaxProgress[i];
          }
          // Reset stagnation na lapEvent
          this.stagnationTimer = 0;

          if (this.generationMaxLaps >= this.generationTargetLaps) {
            // Target completed laps reached by best driver! Start grace period to close trailing laps
            if (!this.isGracePeriodActive) {
              this.isGracePeriodActive = true;
              this.graceTimer = 0;
            }
          }
        }

        // Detect forward checkpoint advancement
        if (car.currentCheckpointIdx !== prevCp) {
          this.lastCarCheckpointIdx[i] = car.currentCheckpointIdx;
          this.carCheckpointsInRun[i] = (this.carCheckpointsInRun[i] || 0) + 1;

          const totalCarProgress = (this.carGenerationLaps[i] || 0) * track.checkpoints.length + this.carCheckpointsInRun[i];
          if (totalCarProgress > (this.carMaxProgress[i] || 0)) {
            this.carMaxProgress[i] = totalCarProgress;
          }
          if (totalCarProgress > this.generationMaxProgress) {
            this.generationMaxProgress = totalCarProgress;
            this.stagnationTimer = 0; // Resetuj stagnationTimer TYLKO przy nowym rekordzie checkpoint progress całej generacji!
          }
        }

        // Only update best fitness & brain if car survived physics step (not crashed)
        if (car.isAlive) {
          if (car.fitness > maxFitness) {
            maxFitness = car.fitness;
            leader = car;
          }

          if (record && !car.lapCompromised && car.fitness > record.bestFitness) {
            record.bestFitness = car.fitness;

            // Snapshot brain only upon significant progress (+300 pts), checkpoint clearing, lap completion, or initial brain
            const lastSnap = this.lastSnapshotFitness[i] ?? 0;
            const isSignificantProgress = (car.fitness - lastSnap) >= 300;
            const isCheckpoint = car.framesSinceLastCheckpoint === 0;
            if (record.bestLapTime === null && !car.lapCompromised && car.brain && (isSignificantProgress || isCheckpoint || !record.bestBrain)) {
              record.bestBrain = car.brain.clone();
              this.lastSnapshotFitness[i] = car.fitness;
            }
          }

          if (car.fitness > this.currentGenerationBestFitness) {
            this.currentGenerationBestFitness = car.fitness;
          }

          if (car.fitness > this.bestFitness) {
            this.bestFitness = car.fitness;
          }
        }
      } else if (!this.isRaceMode) {
        // Individual car respawn & online team learning
        car.respawnTimer -= dt;
        car.mistakes.cooldown = Math.max(0, car.mistakes.cooldown - dt);
        if (car.respawnTimer <= 0) {
          const slot = track.getGridSlot(i);
          if (traffic.some(other => other !== car && other.isAlive && other.pos.dist(slot.pos) < 6)) {
            car.respawnTimer = .1;
            continue;
          }

          if (!car.isManual) {
            // Snapshot before mutation if current brain holds an unsaved peak fitness
            const peakFit = Math.max(car.fitness, car.peakFitness || 0);
            if (record && !car.lapCompromised && peakFit > record.bestFitness && car.brain) {
              record.bestFitness = peakFit;
              if (record.bestLapTime === null && !car.lapCompromised) {
                record.bestBrain = car.brain.clone();
                this.lastSnapshotFitness[i] = peakFit;
              }
            }

            if (peakFit > this.currentGenerationBestFitness) {
              this.currentGenerationBestFitness = peakFit;
            }
            if (peakFit > this.bestFitness) {
              this.bestFitness = peakFit;
            }

            // Prawdziwy elitaryzm: slot globalnego mistrza (PB okrążenia lub najwyższy bestFitness)
            // przy respawnie zachowuje czysty, niemutowany mózg jako nienaruszony punkt odniesienia (próba bazowa).
            const isEliteSlot = (eliteIndex >= 0 && i === eliteIndex && championBrain !== null);

            // Po respawnie bolid zachowuje czysty sprawdzony mózg
            const baseBrain = record?.bestBrain || championBrain || car.brain;
            const newBrain: NeuralNetwork = baseBrain
              ? baseBrain.clone()
              : NeuralNetwork.createTrainedDriverNetwork(this.rayCount, this.topology);

            // Tylko jeśli respawnMutationEnabled jest true (i nie jest to slot elity bazowej), zastosuj mikro-mutację
            if (this.respawnMutationEnabled && !isEliteSlot) {
              newBrain.mutate(this.respawnMutationRate, this.respawnMutationStrength);
            }

            car.brain = newBrain;
            car.safeBrainBackup = newBrain.clone();
            car.replayBuffer = [];
            car.replayStepTimer = 0;
          }

          const nextCpIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
          const mistakeCooldown = car.mistakes.cooldown;
          car.reset(slot.pos, slot.heading, true, nextCpIdx);
          car.mistakes.cooldown = mistakeCooldown;
          car.updateDimensionsForTrackWidth(track.width);
          car.isAlive = true;
          // Respawning is a placement, not motion through the entire circuit.
          motion.set(car, {pos: car.pos.clone(), heading: car.heading});

          // Crash/respawn resilience: reset run-specific counters for this individual car,
          // preserving the generation's global best records and progress.
          this.carCheckpointsInRun[i] = 0;
          this.lastCarCheckpointIdx[i] = nextCpIdx;
        }
      }
    }

    if (motion) resolveTraffic(this.cars, motion);
    for (const {car, event} of laps) this.recordLap({...event, compromised: event.compromised || car.lapCompromised}, car, car.isManual, track);

    this.currentLeader = leader || this.cars.find(c => c.isAlive) || this.cars[0];

    // Automatic generation completion in training mode
    if (!this.isRaceMode && this.autoEvolutionEnabled) {
      this.generationTimer += dt;
      const hasCompletedLapInGen = this.generationMaxLaps >= 1;
      const aliveCount = this.aliveCount;

      if (aliveCount === 0) {
        this.allDeadTimer += dt;
      } else {
        this.allDeadTimer = 0;
      }

      // 1. Awaryjne zakończenie przy śmierci wszystkich aut (działa przed i po 1. okrążeniu)
      const isAllDeadEmergency = this.allDeadTimer >= this.allDeadMaxTime && this.generationTimer >= this.generationMinTime;
      if (isAllDeadEmergency) {
        this.evolve(track, true);
        return;
      }

      // 2. Sprawdzenie stagnacji:
      // Mierzy czas od ostatniego nowego rekordu globalnego postępu checkpointów w generacji (zarówno przed, jak i po 1. okrążeniu).
      // Stagnacja resetuje się tylko, gdy dowolne auto pobije dotychczasowy rekord generacji (generationMaxProgress)
      // lub ukończy okrążenie (lapEvent). Postęp jest porównywany względem rekordu generacji, a nie bieżącego powrotu po respawnie.
      this.stagnationTimer += dt;
      const isStagnatedEmergency = this.stagnationTimer >= this.stagnationMaxTime && this.generationTimer >= this.generationMinTime;
      if (isStagnatedEmergency) {
        this.evolve(track, true);
        return;
      }

      // 2. Warunki uruchomienia Grace Period lub zakończenia
      // Twardy timeout po 300s symulacyjnych w obu fazach (przed i po 1st lap), cel: 3 ukończone okrążenia po 1. lapie
      const timeoutReached = this.generationTimer >= this.generationMaxTimeBeforeFirstLap;
      const targetReached = hasCompletedLapInGen && this.generationMaxLaps >= this.generationTargetLaps;

      if (targetReached || timeoutReached) {
        if (!this.isGracePeriodActive) {
          this.isGracePeriodActive = true;
          this.graceTimer = 0;
        }
      }

      // 3. Obsługa okresu łaski (Grace Period) - max 30s na domknięcie okrążenia, nigdy bez limitu
      if (this.isGracePeriodActive) {
        this.graceTimer += dt;

        const allLivingFinishedTarget = hasCompletedLapInGen &&
          this.cars.every(c => !c.isAlive || (this.carGenerationLaps[this.cars.indexOf(c)] || 0) >= this.generationTargetLaps);

        if (this.graceTimer >= this.graceMaxTime || aliveCount === 0 || allLivingFinishedTarget) {
          this.evolve(track, true);
          return;
        }
      }
    }
  }

  evolve(track: Track, preserveCars: boolean = false): void {
    if (this.isRaceMode) {
      return;
    }

    // 1. Update team records with best fitness & brains from this generation (final generation snapshot)
    for (let i = 0; i < this.populationSize; i++) {
      const car = this.cars[i];
      const record = this.teamRecords[i];
      if (car && record) {
        const peakFit = Math.max(car.fitness, car.peakFitness || 0);
        if (!car.lapCompromised && peakFit > record.bestFitness) {
          record.bestFitness = peakFit;
          if (record.bestLapTime === null && !car.lapCompromised && car.brain) {
            record.bestBrain = car.brain.clone();
            this.lastSnapshotFitness[i] = peakFit;
          }
        }
      }
    }

    // 2. Identify session champion brain across all 10 teams (PB lap if available, otherwise highest bestFitness)
    let championBrain: NeuralNetwork | null = null;
    let eliteRecord: TeamRecord | null = null;
    const sortedByLap = this.teamRecords
      .filter(t => t.bestLapTime !== null)
      .sort((a, b) => a.bestLapTime! - b.bestLapTime!);

    if (sortedByLap.length > 0 && sortedByLap[0].bestBrain) {
      eliteRecord = sortedByLap[0];
      championBrain = sortedByLap[0].bestBrain;
    } else {
      const sortedByFit = [...this.teamRecords]
        .filter(t => t.bestBrain !== null)
        .sort((a, b) => b.bestFitness - a.bestFitness);
      if (sortedByFit.length > 0 && sortedByFit[0].bestBrain && sortedByFit[0].bestFitness > 0) {
        eliteRecord = sortedByFit[0];
        championBrain = sortedByFit[0].bestBrain;
      }
    }
    const eliteTeamIndex = eliteRecord ? this.teamRecords.indexOf(eliteRecord) : -1;

    const maxRecordFitness = Math.max(...this.teamRecords.map(r => r.bestFitness), 0);
    const currentMaxFitness = Math.max(...this.cars.map(c => Math.max(c.fitness, c.peakFitness || 0)), maxRecordFitness, 0);
    if (currentMaxFitness > this.bestFitness) {
      this.bestFitness = currentMaxFitness;
    }

    const newCars: Car[] = [];
    const inputCount = this.rayCount + 5;

    // 3. Evolve each team's car and position on staggered 2x2 starting grid
    for (let i = 0; i < this.populationSize; i++) {
      const def = Population.F1_TEAMS[i % Population.F1_TEAMS.length];
      const record = this.teamRecords[i];
      const slot = track.getGridSlot(i);
      const existingCar = this.cars[i];
      // Automatic cycles preserve every driver, including traffic-affected laps
      // without a clean PB and dead cars awaiting their individual respawn.
      if (preserveCars && existingCar) {
        newCars.push(existingCar);
        continue;
      }

      let teamBrain: NeuralNetwork;

      const isElite = (eliteTeamIndex >= 0 && i === eliteTeamIndex && championBrain !== null);
      const baseBrain = record.bestBrain || (this.cars[i] ? this.cars[i].brain : null);

      if (isElite && championBrain) {
        // Prawdziwy elitaryzm: globalnie najlepszy znany mózg (PB okrążenia, jeśli istnieje, inaczej najwyższy bestFitness)
        // jest kopiowany 1:1 bez jakiejkolwiek mutacji do kolejnej generacji.
        teamBrain = championBrain.clone();
      } else if (baseBrain) {
        // Pełny elitaryzm zespołowy: każdy zespół ewoluuje na bazie swojego record.bestBrain
        // z łagodną mutacją (mutationRate 0.02, mutationStrength 0.05) lub łagodnym crossoverem z mistrzem, bez niszczenia wag.
        if (championBrain && Math.random() < 0.40) {
          teamBrain = NeuralNetwork.crossover(baseBrain, championBrain);
          teamBrain.mutate(this.mutationRate, this.mutationStrength);
        } else {
          teamBrain = baseBrain.clone();
          teamBrain.mutate(this.mutationRate, this.mutationStrength);
        }
      } else {
        const layerSizes = NeuralNetwork.resolveLayerSizes(inputCount, this.topology, 3);
        teamBrain = new NeuralNetwork(layerSizes);
      }

      const newCar = new Car(
        slot.pos,
        slot.heading,
        teamBrain,
        def.color,
        `${def.driverName} (${def.carName})`,
        this.startingFuelKg,
        this.rayCount
      );
      newCar.currentCheckpointIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
      newCar.updateDimensionsForTrackWidth(track.width);
      newCar.bestLapTime = record.bestLapTime;
      newCar.bestLapSplits = record.bestLapSplits ? [...record.bestLapSplits] : [null, null, null, null];
      newCar.lastLapTime = record.lastLapTime;
      newCar.safeBrainBackup = teamBrain.clone();
      newCars.push(newCar);
    }

    this.cars = newCars;
    this.generation++;
    this.resetGenerationCounters();
    this.currentLeader = (eliteTeamIndex >= 0 && this.cars[eliteTeamIndex]) ? this.cars[eliteTeamIndex] : this.cars[0];
  }

  setRayCount(count: number, track: Track): void {
    this.rayCount = count;
    this.initPopulation(track);
    this.generation = 1;
    this.resetGenerationCounters(track);
    this.bestFitness = 0;
    this.globalBestLap = null;
    this.bestCarEver = null;
    this.bestRacingLine = [];
    this.top5Laps = [];
    this.learningHistory = [];
    this.leaderCheckpointSpeeds = [];
  }

  setTopology(topology: TopologySpecifier, track: Track): void {
    this.topology = topology;
    const wasRaceMode = this.isRaceMode;
    this.initPopulation(track);
    this.isRaceMode = wasRaceMode;
    this.generation = 1;
    this.resetGenerationCounters(track);
    this.bestFitness = 0;
    this.globalBestLap = null;
    this.bestCarEver = null;
    this.bestRacingLine = [];
    this.top5Laps = [];
    this.learningHistory = [];
    this.leaderCheckpointSpeeds = [];
  }

  resetPositions(track: Track): void {
    this.resetGenerationCounters(track);
    for (let i = 0; i < this.cars.length; i++) {
      const slot = track.getGridSlot(i);
      const nextCpIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
      this.cars[i].reset(slot.pos, slot.heading, true, nextCpIdx);
      this.cars[i].updateDimensionsForTrackWidth(track.width);
      this.cars[i].replayBuffer = [];
      this.cars[i].replayStepTimer = 0;
      if (this.cars[i].brain) {
        this.cars[i].safeBrainBackup = this.cars[i].brain!.clone();
      }
      const rec = this.teamRecords[i];
      if (rec && this.cars[i].brain && !rec.bestBrain) {
        rec.bestBrain = this.cars[i].brain!.clone();
      }
    }
    this.bestRacingLine = [];
    this.leaderCheckpointSpeeds = [];
  }

  resetAll(track: Track): void {
    const baseBrain = NeuralNetwork.createTrainedDriverNetwork(this.rayCount, this.topology);
    for (let i = 0; i < this.cars.length; i++) {
      const slot = track.getGridSlot(i);
      const brain = baseBrain.clone();
      if (i > 0) brain.mutate(0.04, 0.10);
      this.cars[i].brain = brain;
      const nextCpIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
      this.cars[i].reset(slot.pos, slot.heading, true, nextCpIdx);
      this.cars[i].updateDimensionsForTrackWidth(track.width);
      this.cars[i].bestLapTime = null;
      this.cars[i].bestLapSplits = [null, null, null, null];
      this.cars[i].currentLapSplits = [null, null, null, null];
      this.cars[i].lastLapTime = null;
      if (this.teamRecords[i]) {
        this.teamRecords[i].bestBrain = brain.clone();
        this.teamRecords[i].bestFitness = 0;
        this.teamRecords[i].bestLapTime = null;
        this.teamRecords[i].bestLapSplits = [null, null, null, null];
        this.teamRecords[i].lastLapTime = null;
        this.teamRecords[i].avgSpeed = 0;
        this.teamRecords[i].topSpeed = 0;
        this.teamRecords[i].lapsCount = 0;
        this.teamRecords[i].stagnationCounter = 0;
        this.teamRecords[i].currentMutationRate = this.mutationRate;
      }
    }
    this.bestRacingLine = [];
    this.top5Laps = [];
    this.globalBestLap = null;
    this.bestFitness = 0;
    this.resetGenerationCounters(track);
    this.leaderCheckpointSpeeds = [];
    this.learningHistory = [];
  }

  resetSingleCarBrain(car: Car, track: Track): void {
    const carIdx = this.cars.indexOf(car);
    if (carIdx < 0) return;

    const baseBrain = NeuralNetwork.createTrainedDriverNetwork(this.rayCount, this.topology);
    if (carIdx > 0) {
      baseBrain.mutate(0.04, 0.10);
    }
    car.brain = baseBrain;
    car.replayBuffer = [];
    car.replayStepTimer = 0;
    car.baseBrakingAggression = 1.05 + Math.random() * 0.30;
    car.brakingAggression = car.baseBrakingAggression;
    car.bestLapTime = null;
    car.bestLapSplits = [null, null, null, null];
    car.currentLapSplits = [null, null, null, null];
    car.lastLapTime = null;
    car.lapsUntilStyleShift = Math.floor(Math.random() * 3) + 2;

    if (this.teamRecords[carIdx]) {
      const record = this.teamRecords[carIdx];
      record.bestBrain = baseBrain.clone();
      record.bestFitness = 0;
      record.bestLapTime = null;
      record.bestLapSplits = [null, null, null, null];
      record.lastLapTime = null;
      record.avgSpeed = 0;
      record.topSpeed = 0;
      record.lapsCount = 0;
      record.stagnationCounter = 0;
      record.currentMutationRate = this.mutationRate;
    }

    const slot = track.getGridSlot(carIdx);
    const nextCpIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
    car.reset(slot.pos, slot.heading, true, nextCpIdx);
    car.updateDimensionsForTrackWidth(track.width);
    if (this.carCheckpointsInRun) this.carCheckpointsInRun[carIdx] = 0;
    if (this.carGenerationLaps) this.carGenerationLaps[carIdx] = 0;
    if (this.carMaxProgress) this.carMaxProgress[carIdx] = 0;
    if (this.lastCarCheckpointIdx) this.lastCarCheckpointIdx[carIdx] = nextCpIdx;
  }

  resetBestTimes(): void {
    this.globalBestLap = null;
    this.top5Laps = [];
    this.learningHistory = [];
    this.bestRacingLine = [];
    this.bestFitness = 0;
    this.resetGenerationCounters();
    for (let i = 0; i < this.teamRecords.length; i++) {
      const rec = this.teamRecords[i];
      if (rec) {
        rec.bestFitness = 0;
        rec.bestLapTime = null;
        rec.bestLapSplits = [null, null, null, null];
        rec.lastLapTime = null;
        rec.avgSpeed = 0;
        rec.topSpeed = 0;
        rec.lapsCount = 0;
        rec.stagnationCounter = 0;
      }
    }
    for (const car of this.cars) {
      car.fitness = 0;
      car.bestLapTime = null;
      car.lastLapTime = null;
      car.bestLapSplits = [null, null, null, null];
      car.currentLapSplits = [null, null, null, null];
      car.lastCheckpointDelta = null;
    }
  }
}
