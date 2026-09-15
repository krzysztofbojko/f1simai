import { Car, LapFinishEvent, TrajectoryPoint } from '../physics/Car';
import { NeuralNetwork } from './NeuralNetwork';
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
  public mutationRate: number = 0.08;
  public mutationStrength: number = 0.22;
  public startingFuelKg: number = 105.0;
  public rayCount: number = 25;

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

  constructor(size: number = 10, track: Track, rayCount: number = 25) {
    this.populationSize = Math.min(10, Math.max(1, size));
    this.rayCount = rayCount;
    this.initPopulation(track);
  }

  private initPopulation(track: Track): void {
    this.cars = [];
    this.teamRecords = [];
    const baseBrain = NeuralNetwork.createTrainedDriverNetwork(this.rayCount);

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
  }

  get aliveCount(): number {
    return this.cars.filter(c => c.isAlive).length;
  }

  recordLap(lapEvent: LapFinishEvent, car: Car, isPlayer: boolean = false): void {
    if (!this.globalBestLap || lapEvent.lapTime < this.globalBestLap) {
      this.globalBestLap = lapEvent.lapTime;
      if (lapEvent.trajectory.length > 5) {
        this.bestRacingLine = [...lapEvent.trajectory];
        // Point 1: AI Telemetry Coaching - map leader trajectory speeds
        this.leaderCheckpointSpeeds = lapEvent.trajectory.map(p => p.speed);
      }
    }

    const t = this.teamRecords.find(r => r.color === car.color);
    if (t) {
      t.lapsCount++;
      t.lastLapTime = lapEvent.lapTime;
      if (!t.bestLapTime || lapEvent.lapTime < t.bestLapTime) {
        t.bestLapTime = lapEvent.lapTime;
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

  update(dt: number, track: Track): void {
    let maxFitness = -Infinity;
    let leader: Car | null = null;

    // Find current session champion brain across all teams
    const sortedByLap = this.teamRecords
      .filter(t => t.bestLapTime !== null)
      .sort((a, b) => a.bestLapTime! - b.bestLapTime!);
    const championBrain = sortedByLap.length > 0 && sortedByLap[0].bestBrain
      ? sortedByLap[0].bestBrain
      : null;

    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      const record = this.teamRecords[i];

      if (car.isAlive) {
        car.updateSensors(track);
        // Point 1: pass leader speeds for telemetry coaching, or use human player WASD input
        const control = car.isManual ? car.manualControl : car.getAIControl(track, this.leaderCheckpointSpeeds);
        const lapEvent = car.updatePhysics(control, dt, track);

        if (lapEvent) {
          this.recordLap(lapEvent, car, car.isManual);
        }

        if (car.fitness > maxFitness) {
          maxFitness = car.fitness;
          leader = car;
        }

        if (record && car.fitness > record.bestFitness) {
          record.bestFitness = car.fitness;
        }
      } else if (!this.isRaceMode) {
        // Individual car respawn & online team learning
        car.respawnTimer -= dt;
        if (car.respawnTimer <= 0) {
          const slot = track.getGridSlot(i);

          if (!car.isManual) {
            const baseBrain = record.bestBrain || car.brain;
            let newBrain: NeuralNetwork;

            if (championBrain && Math.random() < 0.25 && championBrain !== baseBrain) {
              // Benchmark & crossover with session P1 champion
              newBrain = NeuralNetwork.crossover(baseBrain ? baseBrain : championBrain, championBrain);
            } else if (baseBrain) {
              // Revert to proven championship brain
              newBrain = baseBrain.clone();
            } else {
              newBrain = NeuralNetwork.createTrainedDriverNetwork(this.rayCount);
            }

            car.brain = newBrain;
          }

          const nextCpIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
          car.reset(slot.pos, slot.heading, true, nextCpIdx);
          car.updateDimensionsForTrackWidth(track.width);
          car.isAlive = true;
        }
      }
    }

    this.currentLeader = leader || this.cars.find(c => c.isAlive) || this.cars[0];
  }

  evolve(track: Track): void {
    // 1. Update team records with best fitness & brains from this generation
    for (let i = 0; i < this.populationSize; i++) {
      const car = this.cars[i];
      const record = this.teamRecords[i];
      if (car && record) {
        if (car.fitness > record.bestFitness) {
          record.bestFitness = car.fitness;
          if (car.brain) {
            record.bestBrain = car.brain.clone();
          }
        }
      }
    }

    // 2. Identify session champion brain across all 10 teams
    let championBrain: NeuralNetwork | null = null;
    const sortedByLap = this.teamRecords
      .filter(t => t.bestLapTime !== null)
      .sort((a, b) => a.bestLapTime! - b.bestLapTime!);

    if (sortedByLap.length > 0 && sortedByLap[0].bestBrain) {
      championBrain = sortedByLap[0].bestBrain;
    } else {
      const sortedByFit = [...this.teamRecords].sort((a, b) => b.bestFitness - a.bestFitness);
      if (sortedByFit.length > 0 && sortedByFit[0].bestBrain) {
        championBrain = sortedByFit[0].bestBrain;
      }
    }

    const currentMaxFitness = Math.max(...this.cars.map(c => c.fitness), 0);
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

      let teamBrain: NeuralNetwork;

      const isLeader =
        (sortedByLap.length > 0 && record === sortedByLap[0]) ||
        (sortedByLap.length === 0 && record.bestFitness === this.bestFitness && record.bestFitness > 0);

      const baseBrain = record.bestBrain || (this.cars[i] ? this.cars[i].brain : null);

      if (isLeader && baseBrain) {
        // P1 Leader: Fine-tune winning package (low variance mutation)
        teamBrain = baseBrain.clone();
        teamBrain.mutate(this.mutationRate * 0.5, this.mutationStrength * 0.6);
      } else if (baseBrain) {
        // Rivalry: 40% benchmark against session champion, 60% proprietary evolution
        if (championBrain && Math.random() < 0.40) {
          teamBrain = NeuralNetwork.crossover(baseBrain, championBrain);
          teamBrain.mutate(this.mutationRate, this.mutationStrength);
        } else {
          teamBrain = baseBrain.clone();
          teamBrain.mutate(this.mutationRate, this.mutationStrength);
        }
      } else {
        teamBrain = new NeuralNetwork([inputCount, 18, 14, 3]);
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
      newCar.lastLapTime = record.lastLapTime;
      newCars.push(newCar);
    }

    this.cars = newCars;
    this.generation++;
  }

  setRayCount(count: number, track: Track): void {
    this.rayCount = count;
    this.initPopulation(track);
    this.generation = 1;
    this.bestFitness = 0;
    this.globalBestLap = null;
    this.bestCarEver = null;
    this.bestRacingLine = [];
    this.top5Laps = [];
  }

  resetAll(track: Track): void {
    const baseBrain = NeuralNetwork.createTrainedDriverNetwork(this.rayCount);
    for (let i = 0; i < this.cars.length; i++) {
      const slot = track.getGridSlot(i);
      const brain = baseBrain.clone();
      if (i > 0) brain.mutate(0.04, 0.10);
      this.cars[i].brain = brain;
      const nextCpIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
      this.cars[i].reset(slot.pos, slot.heading, true, nextCpIdx);
      this.cars[i].updateDimensionsForTrackWidth(track.width);
      this.cars[i].lastLapTime = null;
      if (this.teamRecords[i]) {
        this.teamRecords[i].bestBrain = brain.clone();
        this.teamRecords[i].bestFitness = 0;
        this.teamRecords[i].bestLapTime = null;
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
    this.leaderCheckpointSpeeds = [];
    this.learningHistory = [];
  }

  resetSingleCarBrain(car: Car, track: Track): void {
    const carIdx = this.cars.indexOf(car);
    if (carIdx < 0) return;

    const baseBrain = NeuralNetwork.createTrainedDriverNetwork(this.rayCount);
    if (carIdx > 0) {
      baseBrain.mutate(0.04, 0.10);
    }
    car.brain = baseBrain;
    car.replayBuffer = [];
    car.replayStepTimer = 0;
    car.baseBrakingAggression = 1.05 + Math.random() * 0.30;
    car.brakingAggression = car.baseBrakingAggression;
    car.lastLapTime = null;
    car.lapsUntilStyleShift = Math.floor(Math.random() * 3) + 2;

    if (this.teamRecords[carIdx]) {
      const record = this.teamRecords[carIdx];
      record.bestBrain = baseBrain.clone();
      record.bestFitness = 0;
      record.bestLapTime = null;
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
  }

  resetBestTimes(): void {
    this.globalBestLap = null;
    this.top5Laps = [];
    this.learningHistory = [];
    this.bestRacingLine = [];
    for (let i = 0; i < this.teamRecords.length; i++) {
      const rec = this.teamRecords[i];
      if (rec) {
        rec.bestLapTime = null;
        rec.lastLapTime = null;
        rec.avgSpeed = 0;
        rec.topSpeed = 0;
        rec.lapsCount = 0;
      }
    }
    for (const car of this.cars) {
      car.bestLapTime = null;
      car.lastLapTime = null;
      car.bestLapSplits = [null, null, null, null];
      car.currentLapSplits = [null, null, null, null];
      car.lastCheckpointDelta = null;
    }
  }
}
