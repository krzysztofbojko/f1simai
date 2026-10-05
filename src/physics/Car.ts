import { normalizePressure, pressureProfile } from '../ai/DriverPressure';
import { LineSearch } from '../ai/LineSearch';
import { Vector2, IntersectionResult, segmentsIntersect } from '../math/Vector2';
import { BattlePush } from '../ai/BattlePush';
import { DriverMistakes } from '../ai/DriverMistakes';
import { Track, type SurfaceType } from '../track/Track';
import { NeuralNetwork } from '../ai/NeuralNetwork';

export interface CarControl {
  throttle: number; // 0 to 1
  brake: number;    // 0 to 1
  steer: number;    // -1 (full left) to 1 (full right)
}

export interface CheckpointDelta {
  gateIndex: number;    // 0, 1, 2, 3 for CP1, CP2, CP3, CP4
  gateName: string;     // "CP 1", "CP 2", "CP 3", "CP 4"
  delta: number;        // in seconds (e.g. -0.150 or +0.210)
  splitTime: number;    // current elapsed lap time at checkpoint
  isPurple?: boolean;   // overall session best
}

export interface TrajectoryPoint {
  x: number;
  y: number;
  speed: number;
  throttle: number;
  brake: number;
}

export interface LapFinishEvent {
  compromised?: boolean;
  pressure?: number;
  lapTime: number;
  trajectory: TrajectoryPoint[];
  maxSpeed: number;
  avgSpeed: number;
  fuelRemaining: number;
}

export class Car {
  // Identification
  public id: number = Math.floor(Math.random() * 9000) + 1000;
  public driverName: string = 'Bolid AI';

  // Spatial Scale: 1 px = 1 meter (50 px grid = 50 meters)
  public static readonly METERS_PER_PIXEL: number = 1.0;
  public static readonly GRAVITY: number = 9.81; // m/s^2

  // Simulation mass and fuel parameters
  public static readonly BASE_DRY_MASS: number = 798; // kg
  public static readonly MAX_FUEL_CAPACITY: number = 110; // kg (simulation tank capacity)
  public fuelKg: number = 105.0; // kg (realistic race fuel load)
  public fuelBurnRatePerSec: number = 0; // kg/s
  public totalFuelConsumed: number = 0; // kg

  // Physical specifications (F1 Dimensions & Weights)
  public length: number = 5.5; // Physical and rendered length (m)
  public width: number = 1.8; // Physical and rendered width (m)

  public static getDimensionsForTrackWidth(trackWidthMeters: number): { width: number; length: number; effectiveTrackWidth: number } {
    // The rendered body matches the collision body, including at high zoom.
    const effectiveTrackWidth = Math.max(5, Math.min(20, trackWidthMeters));
    const width = 1.8;
    const length = 5.5;

    return { width, length, effectiveTrackWidth };
  }

  public updateDimensionsForTrackWidth(trackWidth: number): void {
    const dims = Car.getDimensionsForTrackWidth(trackWidth);
    this.width = dims.width;
    this.length = dims.length;
  }
  public readonly wheelbase: number = 3.6; // Meters
  public readonly trackWidthMeters: number = 1.8; // Meters
  public readonly cogHeight: number = 0.32; // Center of gravity height (meters)
  public readonly maxEnginePower: number = 750000; // 750 kW (~1000 HP)
  public readonly launchTractionForce: number = 12500; // N
  public readonly maxSteerAngle: number = 0.40; // ~23 degrees
  public readonly dragCoeff: number = 1.00; // Cd * A [m^2]
  public readonly airDensity: number = 1.225; // kg/m^3
  public readonly downforceCoeff: number = 3.10; // Cl * A [m^2]
  public readonly baseTireGrip: number = 1.85; // Peak friction coefficient mu

  // Organic Performance Variations
  public lapPowerFactor: number = 1.0;
  public lapGripFactor: number = 1.0;
  public lapDragFactor: number = 1.0;

  // Kinematics (in SI units: meters, m/s, radians)
  public pos: Vector2;
  public prevPos: Vector2;
  public vel: Vector2 = new Vector2(0, 0);
  public heading: number; // Radians
  public angularVelocity: number = 0;
  public speed: number = 0; // m/s
  public speedKmh: number = 0; // km/h
  public maxSpeedInLap: number = 0; // m/s
  public distanceCoveredInLap: number = 0; // meters
  public wrongWayTimer: number = 0;

  // Cornering, Gravity & Weight Transfer Telemetry
  public lateralG: number = 0;       // Centrifugal / lateral G-force
  public longitudinalG: number = 0;  // Acceleration / Braking G-force
  public pitchAngle: number = 0;     // Nose dive (braking) or squat (accel) in radians
  public rollAngle: number = 0;      // Body roll into outside tires in radians
  public weightFrontRatio: number = 0.46; // Dynamic front weight distribution
  public understeerSlip: number = 0; // 0 to 1
  public oversteerSlip: number = 0;  // 0 to 1

  // Sensors (LIDAR)
  public static readonly RAY_MAX_DIST: number = 240;
  public rayAngles: number[] = [];
  public rayDistances: number[] = [];
  public rayHits: IntersectionResult[] = [];

  public static generateRayAngles(count: number): number[] {
    const maxAngle = Math.PI * 0.60; // 108 degrees left and right (216 deg total field of view)
    if (count <= 1) return [0];
    const angles: number[] = [];
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const angle = -maxAngle + t * (maxAngle * 2);
      angles.push(angle);
    }
    return angles;
  }

  // Trajectory recording for optimal racing line
  public currentLapTrajectory: TrajectoryPoint[] = [];

  // State & Driving Style
  public baseBrakingAggression: number = 1.0;
  public brakingAggression: number = 1.0;
  public lapsUntilStyleShift: number = 3;
  public replayBuffer: { inputs: number[]; targets: [number, number, number]; reward: number }[] = [];
  public replayStepTimer: number = 0;

  public surface: SurfaceType = 'asphalt';
  public surfaceFractions = { asphalt: 1, grass: 0, gravel: 0 };
  public eliminationReason: 'barrier' | 'car' | 'fuel' | 'stuck' | 'wrong-way' | null = null;
  public barrierImpactSpeed = 0;
  public incidentActive = false;
  public recoveryTimer = 0;
  public lapCompromised = false;
  public battlePush = new BattlePush();
  public battleOpponent = '';
  public raceLineOffset = 0;
  public lineSearch: LineSearch | null = null;
  public lineSearchSeed = this.id % 5;
  public lineSearchByPressure = new Map<number, LineSearch>();
  public driverPressure = 0;
  public effectiveDriverPressure = 0;
  public bestLapPressure = 0;
  public safeBrainPressure = 0;
  public pressureLearningBlocked = false;
  private pressureStart = 0;
  private pressureElapsed = 2;
  public racingLineLabel = '';
  public overtakingTargetName = '';
  public yellowFlag = false;
  public trafficWaiting = false;
  public wreckRemoved = false;
  public wreckClearLap: number | null = null;
  public mistakes = new DriverMistakes();
  public mistakesEnabled = true;
  public tireUtilization = 0;
  public isAlive: boolean = true;
  public isRaceMode: boolean = false;
  public respawnTimer: number = 0;
  public isManual: boolean = false;
  public manualControl: CarControl = { steer: 0, throttle: 0, brake: 0 };
  public currentControl: CarControl = { steer: 0, throttle: 0, brake: 0 };
  public effectiveThrottle: number = 0;
  public isOutOfFuel: boolean = false;
  public fitness: number = 0;
  public peakFitness: number = 0;
  public timeAlive: number = 0;
  public lapTime: number = 0;
  public bestLapTime: number | null = null;
  public lastLapTime: number | null = null;
  public currentLapSplits: (number | null)[] = [null, null, null, null];
  public bestLapSplits: (number | null)[] = [null, null, null, null];
  public lastCheckpointDelta: CheckpointDelta | null = null;
  public currentLap: number = 0;
  public currentCheckpointIdx: number = 0;
  public checkpointsCleared: number = 0;
  public framesSinceLastCheckpoint: number = 0;
  public isSkidding: boolean = false;
  public skidMarks: Vector2[] = [];

  // Brain & Livery
  public brain: NeuralNetwork | null = null;
  public safeBrainBackup: NeuralNetwork | null = null;
  public color: string = '#E10600';

  // Race & Pit Stop State
  public wantsToPit: boolean = false;
  public isPitting: boolean = false;
  public pitTimer: number = 0;
  public pitStopsCount: number = 0;
  public totalRaceTime: number = 0;
  public raceLapsCompleted: number = 0;
  public isFinishedRace: boolean = false;

  constructor(
    startPos: Vector2,
    startHeading: number,
    brain: NeuralNetwork | null = null,
    color: string = '#E10600',
    driverName: string = 'Bolid AI',
    initialFuel: number = 105.0,
    rayCount: number = 25
  ) {
    this.pos = startPos.clone();
    this.prevPos = startPos.clone();
    this.heading = startHeading;
    this.brain = brain;
    if (brain) {
      this.safeBrainBackup = brain.clone();
    }
    this.color = color;
    this.driverName = driverName;
    this.fuelKg = initialFuel;
    this.baseBrakingAggression = 1.05 + Math.random() * 0.30; // Pro F1 driving style
    this.brakingAggression = this.baseBrakingAggression;
    this.lapsUntilStyleShift = Math.floor(Math.random() * 3) + 2; // Shifts every 2-4 laps
    this.rayAngles = Car.generateRayAngles(rayCount);
    this.rayDistances = new Array(this.rayAngles.length).fill(1);
    this.rollLapPerformanceVariation();
  }

  public setRayCount(rayCount: number): void {
    this.rayAngles = Car.generateRayAngles(rayCount);
    this.rayDistances = new Array(this.rayAngles.length).fill(1);
    this.rayHits = [];
  }

  public rollLapPerformanceVariation(): void {
    this.lapPowerFactor = 1.0 + (Math.random() * 0.04 - 0.02);
    this.lapGripFactor = 1.0 + (Math.random() * 0.05 - 0.025);
    this.lapDragFactor = 1.0 + (Math.random() * 0.03 - 0.015);

    // Style shift: driver's style shifts by a few % (+/- 5%) every few laps
    this.lapsUntilStyleShift--;
    if (this.lapsUntilStyleShift <= 0) {
      const shiftPct = (Math.random() * 0.10 - 0.05); // -5% to +5%
      this.brakingAggression = Math.max(0.70, Math.min(1.35, this.baseBrakingAggression * (1.0 + shiftPct)));
      this.lapsUntilStyleShift = Math.floor(Math.random() * 3) + 2;
    }
  }

  get totalMass(): number {
    return Car.BASE_DRY_MASS + Math.max(0, this.fuelKg);
  }

  reset(startPos: Vector2, startHeading: number, resetFuel: boolean = false, startCheckpointIdx: number = 0): void {
    this.pos = startPos.clone();
    this.prevPos = startPos.clone();
    this.vel = new Vector2(0, 0);
    this.heading = startHeading;
    this.angularVelocity = 0;
    this.speed = 0;
    this.speedKmh = 0;
    this.maxSpeedInLap = 0;
    this.distanceCoveredInLap = 0;
    this.wrongWayTimer = 0;
    this.isAlive = true;
    this.surface = 'asphalt';
    this.surfaceFractions = { asphalt: 1, grass: 0, gravel: 0 };
    this.eliminationReason = null;
    this.barrierImpactSpeed = 0;
    this.incidentActive = false;
    this.recoveryTimer = 0;
    this.lapCompromised = this.pressureLearningBlocked;
    this.mistakes.reset();
    this.battlePush.reset();
    this.battleOpponent = '';
    this.raceLineOffset = 0;
    this.overtakingTargetName = '';
    this.yellowFlag = false;
    this.trafficWaiting = false;
    this.wreckRemoved = false;
    this.wreckClearLap = null;
    this.tireUtilization = 0;
    this.respawnTimer = 0;
    this.isOutOfFuel = false;
    this.fitness = 0;
    this.peakFitness = 0;
    this.timeAlive = 0;
    this.lapTime = 0;
    this.currentLap = 0;
    this.currentCheckpointIdx = startCheckpointIdx;
    this.checkpointsCleared = 0;
    this.framesSinceLastCheckpoint = 0;
    this.lateralG = 0;
    this.longitudinalG = 0;
    this.pitchAngle = 0;
    this.rollAngle = 0;
    this.understeerSlip = 0;
    this.oversteerSlip = 0;
    this.isSkidding = false;
    this.skidMarks = [];
    this.currentLapTrajectory = [];
    this.currentLapSplits = [null, null, null, null];
    this.lastCheckpointDelta = null;
    this.wantsToPit = false;
    this.isPitting = false;
    this.pitTimer = 0;
    this.isFinishedRace = false;
    this.currentControl = { steer: 0, throttle: 0, brake: 0 };
    this.effectiveThrottle = 0;
    if (resetFuel) {
      this.fuelKg = 105.0;
      this.totalFuelConsumed = 0;
      this.pitStopsCount = 0;
      this.totalRaceTime = 0;
      this.raceLapsCompleted = 0;
    }
    this.rollLapPerformanceVariation();
  }

  updateSensors(track: Track): void {
    this.rayHits = [];
    this.rayDistances = [];

    for (let i = 0; i < this.rayAngles.length; i++) {
      const rayAngle = this.heading + this.rayAngles[i];
      const hit = track.castRay(this.pos, rayAngle, Car.RAY_MAX_DIST);
      this.rayHits.push(hit);
      this.rayDistances.push(hit.dist / Car.RAY_MAX_DIST);
    }
  }

  getAIControl(track: Track, leaderSpeeds?: number[], _enableLearning: boolean = false): CarControl {
    if (!this.brain || !this.isAlive) {
      const idleCtrl: CarControl = { throttle: 0, brake: 0, steer: 0 };
      this.currentControl = idleCtrl;
      return idleCtrl;
    }

    // AI pit strategy: request pit stop if fuel reserve is low
    if (this.fuelKg < 12.0 && !this.isPitting) {
      this.wantsToPit = true;
    }

    const n = track.checkpoints.length;
    // Project onto nearby centerline segments and aim a short physical distance
    // ahead. A whole checkpoint of lookahead cuts across narrow hairpins.
    let nearestDistance = Infinity;
    let segmentIndex = (this.currentCheckpointIdx - 1 + n) % n;
    let segmentFraction = 0;
    for (let offset = -3; offset <= 3; offset++) {
      const index = (this.currentCheckpointIdx + offset + n) % n;
      const start = track.checkpoints[index].center;
      const end = track.checkpoints[(index + 1) % n].center;
      const edge = end.sub(start);
      const fraction = Math.max(0, Math.min(1, this.pos.sub(start).dot(edge) / Math.max(0.001, edge.magSq())));
      const distance = this.pos.distSq(start.add(edge.mul(fraction)));
      if (distance < nearestDistance) { nearestDistance = distance; segmentIndex = index; segmentFraction = fraction; }
    }
    let remaining = Math.max(5, Math.min(12, 4 + this.speed * 0.25));
    let targetPosition = track.checkpoints[segmentIndex].center;
    for (let step = 0; step < n; step++) {
      const start = track.checkpoints[segmentIndex].center;
      const end = track.checkpoints[(segmentIndex + 1) % n].center;
      const length = start.dist(end);
      const available = length * (1 - segmentFraction);
      if (remaining <= available) {
        targetPosition = Vector2.lerp(start, end, segmentFraction + remaining / Math.max(0.001, length));
        break;
      }
      remaining -= available;
      segmentIndex = (segmentIndex + 1) % n;
      segmentFraction = 0;
      targetPosition = end;
    }
    if (this.raceLineOffset !== 0) {
      const road = track.sampleSurface(targetPosition);
      targetPosition = targetPosition.add(road.tangent.normal().mul(this.raceLineOffset));
    }
    const toTarget = targetPosition.sub(this.pos).normalize();
    const headingVec = Vector2.fromAngle(this.heading);
    const cpAngleDiff = Math.atan2(headingVec.cross(toTarget), headingVec.dot(toTarget)) / Math.PI;

    const normalizedSpeed = Math.min(1.0, this.speed / 95.0);

    // 2. Speed-dependent multi-checkpoint braking zone calculation
    // Lookahead up to 24 steps (~430m) to provide ample runway for high-speed braking
    const lookaheadSteps = Math.max(8, Math.min(24, Math.ceil(this.speed / 3.4)));
    let maxOverspeed = -1.0;
    let maxUpcomingCurvature = 0;

    // Corner safe lateral grip uses base tire friction with margin (~1.5G usable before aero)
    const pressure = pressureProfile(this.yellowFlag || this.isPitting || this.recoveryTimer > 0 || this.surface !== 'asphalt'
      ? Math.min(0, this.effectiveDriverPressure) : this.effectiveDriverPressure);
    const safeLatGrip = this.baseTireGrip * Car.GRAVITY * pressure.cornerGrip;
    // Estimated braking for planning; physical brake forces are unchanged.
    const pushing = this.battlePush.remaining > 0;
    const aBrake = 6.0 * this.brakingAggression * pressure.braking * (pushing ? 1.08 : 1);

    let accumulatedDist = 0;
    let prevPos = this.pos;

    for (let k = 0; k <= lookaheadSteps; k++) {
      const cp = track.checkpoints[(this.currentCheckpointIdx + k) % n];
      accumulatedDist += prevPos.dist(cp.center);
      prevPos = cp.center;

      const curK = Math.abs(cp.curvature);
      if (curK > maxUpcomingCurvature) {
        maxUpcomingCurvature = curK;
      }

      if (curK > 0.002) {
        const cornerRadius = 1.0 / curK; // Physical corner radius in meters
        // Conservative corner aero downforce estimated at expected corner speed rather than straightaway speed
        const estimatedCornerSpeed = Math.sqrt(Math.max(25, cornerRadius * safeLatGrip));
        const cornerAeroAcc = (0.5 * this.airDensity * this.downforceCoeff * estimatedCornerSpeed * estimatedCornerSpeed) / this.totalMass;
        const effectiveCornerGrip = safeLatGrip + cornerAeroAcc * 0.65;
        const safeV = Math.sqrt(Math.max(25, cornerRadius * effectiveCornerGrip)) * (pushing ? 1.04 : 1) * (Math.abs(this.raceLineOffset) > .8 ? .88 : 1);

        const maxAllowedV = Math.sqrt(safeV * safeV + 2.0 * aBrake * accumulatedDist);

        if (this.speed > maxAllowedV) {
          const overspeed = (this.speed - maxAllowedV) / Math.max(8.0, safeV * 0.35);
          if (overspeed > maxOverspeed) {
            maxOverspeed = overspeed;
          }
        }
      }
    }

    const curvatureInput = Math.min(1.0, maxUpcomingCurvature * 25.0);
    const overspeedDelta = Math.max(-1.0, Math.min(1.0, maxOverspeed));

    const inputs: number[] = [
      ...this.rayDistances,
      normalizedSpeed,
      Math.max(-1.0, Math.min(1.0, this.angularVelocity * 1.5)),
      cpAngleDiff,
      curvatureInput,
      overspeedDelta,
    ];

    const outputs = this.brain.forward(inputs);

    const midRay = Math.floor(this.rayDistances.length / 2);
    const leftRayAvg = this.rayDistances.slice(0, midRay).reduce((a, b) => a + b, 0) / Math.max(1, midRay);
    const rightRayAvg = this.rayDistances.slice(midRay + 1).reduce((a, b) => a + b, 0) / Math.max(1, midRay);
    const wallRepulsion = (rightRayAvg - leftRayAvg) * 0.8;

    const lookaheadDistance = Math.max(5, targetPosition.dist(this.pos));
    const pursuitAngle = Math.atan2(2 * this.wheelbase * Math.sin(cpAngleDiff * Math.PI), lookaheadDistance);
    const idealSteer = Math.max(-1, Math.min(1, pursuitAngle / this.maxSteerAngle + wallRepulsion * 0.1));
    // Learned steering is a bounded correction to a geometrically valid path.
    let steer = Math.max(-1, Math.min(1, idealSteer + outputs[0] * 0.025));

    // Check forward clearance using central LiDAR rays
    const forwardDistNorm = this.rayDistances[midRay] ?? 1.0;
    const leftForwardNorm = this.rayDistances[Math.max(0, midRay - 1)] ?? 1.0;
    const rightForwardNorm = this.rayDistances[Math.min(this.rayDistances.length - 1, midRay + 1)] ?? 1.0;
    const minCenterClearance = Math.min(forwardDistNorm, leftForwardNorm, rightForwardNorm) * (76 / Math.max(5, track.width));

    // 3. F1 Racing Throttle & Braking Policy:
    let throttle: number;
    let brake: number;

    if (overspeedDelta > 0.0) {
      // Actively in braking zone before turn: FIRM BRAKE, ZERO THROTTLE
      throttle = 0.0;
      brake = Math.max(pressure.brakeFloor, Math.min(1.0, .60 - (.65 - pressure.brakeFloor) + overspeedDelta * 1.5));
    } else if (overspeedDelta > -pressure.coastMargin) {
      // Transition / lift & coast zone: cut throttle, prevent violent bang-bang throttle spikes
      throttle = 0.0;
      brake = 0.0;
    } else {
      // In acceleration or cruising zone - NO BRAKING!
      brake = 0.0;
      if (minCenterClearance > 0.22) {
        if (Math.abs(steer) < 0.35) {
          // Straights, gentle sweepers, and corner exits: 100% FLAT OUT
          throttle = 1.0;
        } else {
          // Apex cornering: traction control modulation
          const steerExcess = Math.abs(steer) - 0.35;
          throttle = Math.max(0.35, 1.0 - steerExcess * 0.80);
        }
      } else if (minCenterClearance > 0.12) {
        // Approaching barrier/wall: lift to maintain control, never demand acceleration
        throttle = 0.20;
      } else {
        // Emergency wall proximity: cut throttle completely and apply emergency stability braking
        throttle = 0.0;
        brake = 0.40;
      }

      // Telemetry coaching from session leader (only when firmly outside braking zones and clear of walls):
      if (leaderSpeeds && leaderSpeeds.length > 0 && overspeedDelta <= -0.20 && minCenterClearance > 0.25) {
        const leaderV = leaderSpeeds[this.currentCheckpointIdx % leaderSpeeds.length];
        if (leaderV && this.speedKmh < leaderV - 8) {
          throttle = 1.0;
        }
      }
    }

    // 4. Traction & Stability Control:
    if (this.isSkidding) {
      throttle = Math.min(throttle, 0.20);
    }
    const currentCp = track.checkpoints[this.currentCheckpointIdx % n];
    if (currentCp && headingVec.dot(currentCp.tangent) < 0.90) {
      throttle = Math.min(throttle, 0.45);
    }

    const offRoad = (track.sampleSurface?.(this.pos).surface ?? 'asphalt') !== 'asphalt';
    if (offRoad) {
      // The geometric pursuit target remains on asphalt; at low speed it brings
      // the car back without the asphalt-edge LiDAR treating escape as a wall.
      steer = Math.max(-1, Math.min(1, pursuitAngle / this.maxSteerAngle));
      throttle = this.speed > 12 ? 0 : Math.abs(pursuitAngle) < 0.8 ? 0.22 : 0.1;
      brake = this.speed > 18 ? 0.45 : this.speed > 10 ? 0.15 : 0;
    }
    const control: CarControl = { steer, throttle, brake };
    this.currentControl = control;

    // Online learning via replay buffer
    if (_enableLearning && !this.pressureLearningBlocked && !pushing && !this.incidentActive && this.recoveryTimer <= 0 && (!track.sampleSurface || !offRoad)) {
      this.replayStepTimer++;

      if (!this.isSkidding && (Math.abs(steer) > 0.08 || this.speed > 25)) {
        this.replayBuffer.push({
          inputs,
          targets: [idealSteer, throttle, brake],
          reward: this.speedKmh,
        });
        if (this.replayBuffer.length > 50) {
          this.replayBuffer.shift();
        }
      }

      if (this.replayStepTimer % 90 === 0 && this.replayBuffer.length >= 6 && this.brain) {
        const topSamples = [...this.replayBuffer]
          .sort((a, b) => b.reward - a.reward)
          .slice(0, 3);
        for (const sample of topSamples) {
          this.brain.train(sample.inputs, sample.targets, 0.001);
        }
      }
    }

    return control;
  }

  /** Switch planning context without replacing the car or its brain. */
  setDriverPressure(value: number, immediate = false): void {
    const next = normalizePressure(value);
    if (next === this.driverPressure && !immediate) return;
    if (this.lineSearch) this.lineSearchByPressure.set(this.driverPressure, this.lineSearch);
    this.lineSearch = this.lineSearchByPressure.get(next) ?? new LineSearch(this.lineSearchSeed);
    this.lineSearchByPressure.set(next, this.lineSearch);
    this.pressureStart = this.effectiveDriverPressure;
    this.driverPressure = next;
    this.pressureElapsed = immediate ? 2 : 0;
    if (immediate) this.effectiveDriverPressure = next;
    else if (!this.isManual) {
      this.pressureLearningBlocked = true;
      this.lapCompromised = true;
      this.replayBuffer = [];
      this.replayStepTimer = 0;
    }
  }

  advanceDriverPressure(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.pressureElapsed = Math.min(2, this.pressureElapsed + dt);
    this.effectiveDriverPressure = this.pressureStart + (this.driverPressure - this.pressureStart) * this.pressureElapsed / 2;
  }

  /**
   * Hybrid vehicle dynamics step with SI forces, bounded tire friction,
   * signed telemetry and a finite kinematic steering response.
   */
  updatePhysics(control: CarControl, dt: number, track: Track): LapFinishEvent | null {
    if (!this.isAlive) {
      this.effectiveThrottle = 0;
      this.lateralG = 0;
      this.longitudinalG = 0;
      return null;
    }

    if (!Number.isFinite(dt) || dt <= 0) return null;
    control = {
      throttle: Math.max(0, Math.min(1, Number.isFinite(control.throttle) ? control.throttle : 0)),
      brake: Math.max(0, Math.min(1, Number.isFinite(control.brake) ? control.brake : 0)),
      steer: Math.max(-1, Math.min(1, Number.isFinite(control.steer) ? control.steer : 0)),
    };
    const risk = Math.max(0, Math.min(1, (this.tireUtilization - 0.55) / 0.45));
    const incident = this.mistakes.step(control, dt, risk,
      this.mistakesEnabled && !this.isManual && !!this.brain && !this.isPitting && !this.isFinishedRace && this.speed > 10 && !this.yellowFlag && !this.wantsToPit && this.surface === 'asphalt' && (this.recoveryTimer <= 0 || this.mistakes.remaining > 0), pressureProfile(this.effectiveDriverPressure).mistakes);
    control = incident.control;
    this.incidentActive = incident.affected;
    if (incident.affected) {
      this.lapCompromised = true;
      this.replayBuffer = [];
      this.replayStepTimer = 0;
      this.recoveryTimer = 2;
    } else this.recoveryTimer = Math.max(0, this.recoveryTimer - dt);
    this.currentControl = { ...control };
    this.updateSurface(track);
    if (this.surfaceFractions.asphalt < 1) {
      this.lapCompromised = true;
      this.recoveryTimer = 2;
      this.replayBuffer = [];
      this.replayStepTimer = 0;
    }

    if (this.isPitting) {
      this.effectiveThrottle = 0;
      this.fuelBurnRatePerSec = 0;
      this.lateralG = 0;
      this.longitudinalG = 0;
      const serviceDt = Math.min(dt, Math.max(0, this.pitTimer));
      this.pitTimer = Math.max(0, this.pitTimer - dt);
      this.lapTime += dt;
      if (!this.isFinishedRace) {
        this.totalRaceTime += dt;
      }
      this.framesSinceLastCheckpoint = 0; // Prevent timeout while in pit box
      this.vel.set(0, 0);
      this.speed = 0;
      this.speedKmh = 0;
      // Refueling during pit stop
      this.fuelKg = Math.min(Car.MAX_FUEL_CAPACITY, this.fuelKg + 28.0 * serviceDt);
      if (this.pitTimer <= 0) {
        this.isPitting = false;
        this.wantsToPit = false;
        this.isOutOfFuel = false;
        this.fuelKg = Math.min(Car.MAX_FUEL_CAPACITY, this.fuelKg);
      }
      return null;
    }

    this.timeAlive += dt;
    this.lapTime += dt;
    if (!this.isFinishedRace) {
      this.totalRaceTime += dt;
    }
    if (!this.trafficWaiting) this.framesSinceLastCheckpoint++;

    if (this.fitness > this.peakFitness) {
      this.peakFitness = this.fitness;
    }

    // 1. Throttle modulation with Brake Override:
    // In racing drive-by-wire, pressing the brake pedal cuts throttle
    const brakeOverrideCut = Math.max(0, 1.0 - control.brake * 1.4);
    let actualThrottle = control.throttle * brakeOverrideCut;

    if (this.fuelKg <= 0.001) {
      this.fuelKg = 0;
      this.isOutOfFuel = true;
      // No propulsive energy remains once the tank is empty.
      actualThrottle = 0;
      this.fuelBurnRatePerSec = 0;
    } else {
      const baseBurn = 0.004;
      const loadBurn = 0.062 * actualThrottle * (0.30 + 0.70 * (this.speed / 95));
      this.fuelBurnRatePerSec = baseBurn + loadBurn;
      const fuelConsumed = Math.min(this.fuelKg, this.fuelBurnRatePerSec * dt);
      this.fuelKg = Math.max(0, this.fuelKg - fuelConsumed);
      this.totalFuelConsumed += fuelConsumed;
    }

    this.effectiveThrottle = actualThrottle;

    const currentMass = this.totalMass;

    // 2. Local Vehicle Vectors
    const forwardDir = Vector2.fromAngle(this.heading);
    const rightDir = forwardDir.normal();

    const forwardSpeed = this.vel.dot(forwardDir);
    const lateralSpeed = this.vel.dot(rightDir);
    const speedMag = this.vel.mag();

    // 3. Gravity and Aerodynamics Normal Load (Fz)
    const gravityForce = currentMass * Car.GRAVITY; // Gravity F = m * g
    const downforceMag = 0.5 * this.airDensity * this.downforceCoeff * (speedMag * speedMag);
    const totalNormalLoadZ = gravityForce + downforceMag; // Gravity + Aero Downforce

    // Aerodynamic drag opposes the entire velocity relative to still air.
    const dragMagnitude = 0.5 * this.airDensity * this.dragCoeff * this.lapDragFactor * speedMag * speedMag;
    const dragScale = speedMag > 0 ? Math.min(dragMagnitude / speedMag, currentMass / dt) : 0;
    const dragForward = -forwardSpeed * dragScale;
    const dragLateral = -lateralSpeed * dragScale;

    // Keep axle loads positive without inventing extra total normal load.
    const pitchTransfer = -currentMass * this.longitudinalG * Car.GRAVITY * this.cogHeight / this.wheelbase;
    const frontLoad = Math.max(totalNormalLoadZ * 0.05, Math.min(totalNormalLoadZ * 0.95, totalNormalLoadZ * 0.46 + pitchTransfer));
    const rearLoad = totalNormalLoadZ - frontLoad;
    this.weightFrontRatio = frontLoad / totalNormalLoadZ;
    const rollTransfer = currentMass * this.lateralG * Car.GRAVITY * this.cogHeight / this.trackWidthMeters;
    const rollGripLoss = Math.min(0.08, Math.abs(rollTransfer) / totalNormalLoadZ * 0.15);
    const fractions = this.surfaceFractions;
    const surfaceMu = fractions.asphalt * this.baseTireGrip + fractions.grass * 0.45 + fractions.gravel * 0.60;
    const mu = surfaceMu * this.lapGripFactor * (1 - rollGripLoss);
    const frontLimit = mu * frontLoad;
    const rearLimit = mu * rearLoad;

    // Rolling resistance and braking share each axle's longitudinal tire budget.
    const rollingFront = Math.min(frontLimit, 0.012 * frontLoad);
    const rollingRear = Math.min(rearLimit, 0.012 * rearLoad);
    const engineForce = actualThrottle > 0.005
      ? this.maxEnginePower * actualThrottle * this.lapPowerFactor / Math.max(12, Math.abs(forwardSpeed)) : 0;
    const driveForce = Math.min(Math.max(0, rearLimit - rollingRear), engineForce);
    const brakeDemand = control.brake * (frontLimit + rearLimit);
    const brakeFront = Math.min(Math.max(0, frontLimit - rollingFront), brakeDemand * 0.56);
    const brakeRear = Math.min(Math.max(0, rearLimit - rollingRear), brakeDemand * 0.44);
    const vStar = forwardSpeed + (driveForce + dragForward) / currentMass * dt;
    const resistance = brakeFront + brakeRear + rollingFront + rollingRear;
    const resistanceScale = resistance > 0 ? Math.min(1, currentMass * Math.abs(vStar) / (dt * resistance)) : 0;
    const resistanceSign = Math.sign(vStar);
    const frontFx = -resistanceSign * (brakeFront + rollingFront) * resistanceScale;
    const rearFx = Math.max(-rearLimit, Math.min(rearLimit, driveForce - resistanceSign * (brakeRear + rollingRear) * resistanceScale));
    const longitudinalForce = frontFx + rearFx + dragForward;

    // Remaining lateral force is computed from the same friction circle on each axle.
    const frontLateral = Math.sqrt(Math.max(0, frontLimit * frontLimit - frontFx * frontFx));
    const rearLateral = Math.sqrt(Math.max(0, rearLimit * rearLimit - rearFx * rearFx));
    const lateralLimit = frontLateral + rearLateral;
    const nextForwardSpeed = forwardSpeed + longitudinalForce / currentMass * dt;
    const targetYaw = nextForwardSpeed / this.wheelbase * Math.tan(control.steer * this.maxSteerAngle);
    // Finite steering response; this remains a bounded hybrid, not a yaw-inertia solver.
    const requestedYaw = this.angularVelocity + (targetYaw - this.angularVelocity) * (1 - Math.exp(-dt / 0.05));
    const turnForce = currentMass * nextForwardSpeed * requestedYaw;
    // Turning and slide correction act in the SAME axis and must be summed algebraically.
    const slideForce = -currentMass * lateralSpeed * Math.min(12, 1 / dt);
    const requestedLateral = turnForce + slideForce;
    const lateralForce = Math.max(-lateralLimit, Math.min(lateralLimit, requestedLateral));
    const yawLimit = Math.abs(nextForwardSpeed) > 0.001 ? lateralLimit / (currentMass * Math.abs(nextForwardSpeed)) : 0;
    this.angularVelocity = Math.max(-yawLimit, Math.min(yawLimit, requestedYaw));
    this.tireUtilization = Math.min(1, Math.hypot(frontFx + rearFx, requestedLateral) / Math.max(1, frontLimit + rearLimit));
    const slipRatio = Math.abs(requestedLateral) > 0 ? Math.max(0, 1 - lateralLimit / Math.abs(requestedLateral)) : 0;
    this.isSkidding = slipRatio > 0.01 || (Math.abs(lateralSpeed) > 4.5 && speedMag > 18);
    this.understeerSlip = frontLateral / Math.max(1, frontLoad) < rearLateral / Math.max(1, rearLoad) ? slipRatio : 0;
    this.oversteerSlip = this.understeerSlip > 0 ? 0 : slipRatio;

    if (!this.lapCompromised && this.safeBrainPressure === this.driverPressure && this.isRaceMode && this.safeBrainBackup && this.brain && this.isSkidding && (this.oversteerSlip > 0.45 || Math.abs(this.angularVelocity) > 3.2)) {
      this.brain = this.safeBrainBackup.clone();
      this.replayBuffer = [];
    }
    if (this.isSkidding && Math.random() < 0.28) {
      this.skidMarks.push(this.pos.clone());
      if (this.skidMarks.length > 60) this.skidMarks.shift();
    }

    // Integrate global velocity exactly once from the resultant force. Rotating
    // the body does not rotate momentum or introduce an extra lateral impulse.
    const acceleration = forwardDir.mul(longitudinalForce / currentMass)
      .add(rightDir.mul((lateralForce + dragLateral) / currentMass));
    const previousVelocity = this.vel.clone();
    this.vel.addMut(acceleration.mul(dt));
    // Soil/ploughing resistance is separate from tire grip, opposing the full
    // velocity with a bounded impulse (including a sideways slide).
    const soilDeceleration = Car.GRAVITY * (fractions.grass * 0.04 + fractions.gravel * 0.35);
    const integratedSpeed = this.vel.mag();
    if (integratedSpeed > 0 && soilDeceleration > 0) this.vel.mulMut(Math.max(0, 1 - soilDeceleration * dt / integratedSpeed));
    const previousHeading = this.heading;
    this.heading += this.angularVelocity * dt;
    const newForwardDir = Vector2.fromAngle(this.heading);
    const measuredAcceleration = this.vel.sub(previousVelocity).div(dt);
    this.longitudinalG = measuredAcceleration.dot(forwardDir) / Car.GRAVITY;
    this.lateralG = measuredAcceleration.dot(rightDir) / Car.GRAVITY;
    this.pitchAngle = Math.max(-0.06, Math.min(0.06, -this.longitudinalG * 0.015));
    this.rollAngle = Math.max(-0.08, Math.min(0.08, this.lateralG * 0.018));

    // 7. Position & Distance Update (1 px = 1 meter)
    const stepDelta = this.vel.mul(dt);
    this.prevPos.set(this.pos.x, this.pos.y);
    const proposedPosition = this.pos.add(stepDelta);
    const hit = track.sweepBarrier?.(this.pos, proposedPosition, previousHeading, this.heading);
    if (hit) {
      this.pos = Vector2.lerp(this.pos, proposedPosition, hit.fraction);
      this.heading = previousHeading + (this.heading - previousHeading) * hit.fraction;
      const inwardSpeed = this.vel.dot(hit.normal);
      this.barrierImpactSpeed = Math.max(0, -inwardSpeed);
      if (this.barrierImpactSpeed >= 12) {
        this.eliminate('barrier', 0.45);
        return null;
      }
      if (inwardSpeed < 0) this.vel.subMut(hit.normal.mul(inwardSpeed));
      this.vel.mulMut(0.8);
      this.pos.addMut(hit.normal.mul(0.03));
      this.angularVelocity *= 0.5;
      this.lapCompromised = true;
      this.recoveryTimer = 2;
      this.replayBuffer = [];
      const collisionAcceleration = this.vel.sub(previousVelocity).div(dt);
      this.longitudinalG = collisionAcceleration.dot(forwardDir) / Car.GRAVITY;
      this.lateralG = collisionAcceleration.dot(rightDir) / Car.GRAVITY;
    } else this.pos = proposedPosition;
    this.updateSurface(track);
    if (this.surfaceFractions.asphalt < 1) { this.lapCompromised = true; this.recoveryTimer = 2; }
    this.speed = this.vel.mag();
    this.speedKmh = this.speed * 3.6;
    this.maxSpeedInLap = Math.max(this.maxSpeedInLap, this.speed);
    this.distanceCoveredInLap += stepDelta.mag();

    // 7b. Directional Progress along Track & Penalties
    const cpCount = track.checkpoints.length;
    if (cpCount > 0) {
      const targetCp = track.checkpoints[this.currentCheckpointIdx % cpCount];
      const prevCp = track.checkpoints[(this.currentCheckpointIdx - 1 + cpCount) % cpCount];
      const trackTangent = targetCp.tangent;
      const trackAlignment = newForwardDir.dot(trackTangent);
      const directionalSpeed = this.vel.dot(trackTangent);

      // Local curve detection: avoid false positive wrong-way in tight hairpins
      const isHighCurvature = Math.abs(targetCp.curvature) > 0.0025 || Math.abs(prevCp.curvature) > 0.0025;
      const toTarget = targetCp.center.sub(this.pos);
      const distToTarget = toTarget.mag();
      const toTargetDir = distToTarget > 0.001 ? toTarget.div(distToTarget) : trackTangent;
      const approachAlignment = newForwardDir.dot(toTargetDir);
      const approachSpeed = this.vel.dot(toTargetDir);

      const effectiveAlignment = isHighCurvature ? Math.max(trackAlignment, approachAlignment) : trackAlignment;
      const effectiveSpeed = isHighCurvature ? Math.max(directionalSpeed, approachSpeed) : directionalSpeed;

      // Positive directional progress along track
      if (this.surface === 'asphalt' && effectiveSpeed > 0 && effectiveAlignment > 0) {
        const alignBonus = Math.max(0.15, effectiveAlignment);
        this.fitness += effectiveSpeed * alignBonus * 0.15 * dt;
      } else if (effectiveSpeed < 0 && !isHighCurvature) {
        // Penalty for moving backwards along track
        this.fitness = Math.max(0, this.fitness + effectiveSpeed * 0.45 * dt);
      }

      // Penalty for wrong heading / driving in reverse direction (never terminate on high curvature)
      if (this.recoveryTimer <= 0 && effectiveAlignment < -0.20 && !isHighCurvature) {
        const wrongWayPenalty = (250.0 * Math.abs(effectiveAlignment) + Math.abs(this.speed) * 6.0) * dt;
        this.fitness = Math.max(0, this.fitness - wrongWayPenalty);

        if (effectiveAlignment < -0.45 && directionalSpeed < -5.0 && this.speed > 8.0) {
          this.wrongWayTimer += dt;
          if (this.wrongWayTimer > 1.6) {
            // Terminate car driving backwards at speed on straight/gentle corner
            this.eliminationReason = 'wrong-way';
            this.isAlive = false;
            this.effectiveThrottle = 0;
            this.lateralG = 0;
            this.longitudinalG = 0;
            this.vel.set(0, 0);
            this.speed = 0;
            this.speedKmh = 0;
            this.respawnTimer = 0.5;
            // Fixed penalty preserving relative progress info
            this.fitness = Math.max(0, this.fitness - 1500);
            return null;
          }
        } else {
          this.wrongWayTimer = Math.max(0, this.wrongWayTimer - dt * 0.5);
        }
      } else {
        this.wrongWayTimer = 0;
      }
    }

    // Penalty for skidding and loss of adhesion
    if (this.isSkidding) {
      const slipMagnitude = Math.abs(this.vel.dot(newForwardDir.normal())) + (this.understeerSlip + this.oversteerSlip) * 14.0;
      const skidPenalty = (45.0 + slipMagnitude * 6.0) * dt;
      this.fitness = Math.max(0, this.fitness - skidPenalty);
    }

    // 8. Trajectory Recording for Racing Line
    const lastPt = this.currentLapTrajectory[this.currentLapTrajectory.length - 1];
    if (!lastPt || Math.hypot(this.pos.x - lastPt.x, this.pos.y - lastPt.y) > 6.0) {
      this.currentLapTrajectory.push({
        x: this.pos.x,
        y: this.pos.y,
        speed: this.speedKmh,
        throttle: actualThrottle,
        brake: control.brake,
      });
    }

    // 9. Track Checkpoint & Progress check
    if (this.fitness > this.peakFitness) {
      this.peakFitness = this.fitness;
    }
    const finishEvent = this.checkTrackProgress(track);
    if (this.fitness > this.peakFitness) {
      this.peakFitness = this.fitness;
    }
    return finishEvent;
  }

  private footprint(halfLength: number): Vector2[] {
    const forward = Vector2.fromAngle(this.heading), side = forward.normal();
    return [-1, 1].flatMap(front => [-1, 1].map(left => this.pos.add(forward.mul(front * halfLength)).add(side.mul(left * 0.9))));
  }

  private updateSurface(track: Track): void {
    const fractions = { asphalt: 0, grass: 0, gravel: 0 };
    if (track.sampleSurface) {
      for (const wheel of this.footprint(this.wheelbase / 2)) fractions[track.sampleSurface(wheel).surface] += 0.25;
    } else fractions.asphalt = 1;
    this.surfaceFractions = fractions;
    this.surface = fractions.gravel > 0 ? 'gravel' : fractions.grass > 0 ? 'grass' : 'asphalt';
  }

  private eliminate(reason: 'barrier', penalty: number): void {
    this.eliminationReason = reason;
    this.isAlive = false;
    this.effectiveThrottle = 0;
    this.lateralG = this.longitudinalG = 0;
    this.vel.set(0, 0);
    this.speed = this.speedKmh = 0;
    this.respawnTimer = 0.5;
    this.fitness = Math.max(0, Math.round(this.fitness * penalty));
    this.replayBuffer = [];
    this.replayStepTimer = 0;
  }

  private checkTrackProgress(track: Track): LapFinishEvent | null {
    if (this.fitness > this.peakFitness) {
      this.peakFitness = this.fitness;
    }
    // Asphalt is a surface transition, not a collision. Legacy test doubles
    // without barrier geometry retain their explicitly supplied hard boundary.
    if (!track.sweepBarrier) {
      const corners = this.footprint(2.75);
      if (track.isOutOfBounds(this.pos) || corners.some(corner => track.isOutOfBounds(corner))) {
        this.eliminate('barrier', 0.45); return null;
      }
    } else if (track.sampleSurface(this.pos).outsideBarrier) {
      // Safety fallback for invalid/spawned positions already outside the fence.
      this.eliminate('barrier', 0.45); return null;
    }

    if (this.isOutOfFuel && this.speed < 1.0) {
      this.eliminationReason = 'fuel';
      this.isAlive = false;
      this.effectiveThrottle = 0;
      this.lateralG = 0;
      this.longitudinalG = 0;
      this.vel.set(0, 0);
      this.speed = 0;
      this.speedKmh = 0;
      this.respawnTimer = 0.5;
      this.fitness = Math.max(0, Math.round(this.fitness * 0.75));
      return null;
    }

    if (this.framesSinceLastCheckpoint > (this.recoveryTimer > 0 ? 1800 : 600)) {
      this.eliminationReason = 'stuck';
      this.isAlive = false;
      this.effectiveThrottle = 0;
      this.lateralG = 0;
      this.longitudinalG = 0;
      this.vel.set(0, 0);
      this.speed = 0;
      this.speedKmh = 0;
      this.respawnTimer = 0.5;
      // Stagnation penalty preserving relative ranking
      this.fitness = Math.max(0, Math.round(this.fitness * 0.50));
      return null;
    }

    const cpCount = track.checkpoints.length;
    if (cpCount === 0) return null;
    const clearedCpIdx = this.currentCheckpointIdx % cpCount;
    const nextCp = track.checkpoints[clearedCpIdx];
    const distToCp = this.pos.dist(nextCp.center);

    // Cheap AABB broadphase before exact segmentsIntersect
    let crossedGate = false;
    const minX1 = Math.min(this.prevPos.x, this.pos.x);
    const maxX1 = Math.max(this.prevPos.x, this.pos.x);
    const minY1 = Math.min(this.prevPos.y, this.pos.y);
    const maxY1 = Math.max(this.prevPos.y, this.pos.y);

    const minX2 = Math.min(nextCp.p1.x, nextCp.p2.x);
    const maxX2 = Math.max(nextCp.p1.x, nextCp.p2.x);
    const minY2 = Math.min(nextCp.p1.y, nextCp.p2.y);
    const maxY2 = Math.max(nextCp.p1.y, nextCp.p2.y);

    if (maxX1 >= minX2 && minX1 <= maxX2 && maxY1 >= minY2 && minY1 <= maxY2) {
      crossedGate = segmentsIntersect(this.prevPos, this.pos, nextCp.p1, nextCp.p2);
    }

    const isNearCp = clearedCpIdx !== 0 && distToCp < Math.min(3, track.width * 0.2) && this.surface === 'asphalt';
    // (1) Checkpoint zaliczaj tylko przy ruchu zgodnym z tangentem toru
    const isMovingForwardAlongTrack = this.vel.dot(nextCp.tangent) > 0.5;

    if (this.surface === 'asphalt' && isMovingForwardAlongTrack && (crossedGate || isNearCp)) {
      this.checkpointsCleared++;

      const forwardDir = Vector2.fromAngle(this.heading);
      const trackAlignment = forwardDir.dot(nextCp.tangent);
      const isClean = !this.isSkidding && trackAlignment > 0.45 && Math.abs(this.angularVelocity) < 2.0;

      // Base checkpoint reward
      this.fitness += 1200;

      // Clean checkpoint bonus (higher reward for staying centered on racing line without sliding)
      if (isClean) {
        const halfWidth = Math.max(1, track.width * 0.5);
        const centerRatio = Math.max(0, Math.min(1, 1.0 - distToCp / halfWidth));
        this.fitness += 500 + Math.round(centerRatio * 500);
      } else if (this.isSkidding) {
        // Slid through checkpoint sideways / out of control
        this.fitness = Math.max(0, this.fitness - 200);
      }

      // Point 2: Apex Clipping and Exit Speed Rewards
      if (Math.abs(nextCp.curvature) > 0.003) {
        const innerCurb = nextCp.curvature > 0 ? nextCp.p1 : nextCp.p2;
        const distToInner = this.pos.dist(innerCurb);
        if (distToInner < track.width * 0.35 && isClean) {
          // Apex clipped cleanly!
          this.fitness += 800;
        }
      } else if (clearedCpIdx > 0) {
        const prevCp = track.checkpoints[(clearedCpIdx - 1 + cpCount) % cpCount];
        if (Math.abs(prevCp.curvature) > 0.003 && this.speed > 22 && isClean) {
          // High speed corner exit acceleration reward!
          this.fitness += 600 + Math.round(this.speedKmh * 2);
        }
      }

      this.framesSinceLastCheckpoint = 0;
      this.currentCheckpointIdx = (clearedCpIdx + 1) % cpCount;

      // Check 4 timing checkpoints (CP1, CP2, CP3)
      if (track.timingGates && track.timingGates.length === 4) {
        for (let g = 0; g < 3; g++) {
          const gate = track.timingGates[g];
          if (this.currentLapSplits[g] === null && clearedCpIdx === gate.pointIndex && this.lapTime > 1.2) {
            const split = this.lapTime;
            this.currentLapSplits[g] = split;
            const prevPbSplit = this.bestLapSplits[g];
            const delta = prevPbSplit !== null ? (split - prevPbSplit) : 0;
            this.lastCheckpointDelta = {
              gateIndex: g,
              gateName: gate.name,
              delta,
              splitTime: split
            };
            // Positive reinforcement on sector improvement (fitness bonus)
            if (delta < 0) {
              const sectorBonus = Math.min(3000, Math.round(Math.abs(delta) * 1000));
              this.fitness += 1500 + sectorBonus;
            }
          }
        }
      }

      // Completed a full lap crossing the start/finish line (cleared checkpoint 0)!
      if (clearedCpIdx === 0) {
        if (this.checkpointsCleared >= track.checkpoints.length * 0.8) {
          const finishedLapTime = this.lapTime;
          this.lastLapTime = finishedLapTime;
          this.currentLapSplits[3] = finishedLapTime;
          const prevPbFinish = this.bestLapSplits[3] || this.bestLapTime;
          this.lastCheckpointDelta = {
            gateIndex: 3,
            gateName: 'CP 4 (META)',
            delta: prevPbFinish !== null ? (finishedLapTime - prevPbFinish) : 0,
            splitTime: finishedLapTime
          };

          const finishedTrajectory = [...this.currentLapTrajectory];
          const finishedMaxSpeedKmh = Math.round(this.maxSpeedInLap * 3.6);
          const avgSpeedKmh = finishedLapTime > 0
            ? Math.round((track.totalLength / finishedLapTime) * 3.6 * 10) / 10
            : 0;

          this.currentLap++;
          this.raceLapsCompleted++;
          // Substantial lap completion reward inversely proportional to lapTime
          const lapTimeBonus = Math.round(150000 / Math.max(10, finishedLapTime));
          if (!this.lapCompromised) this.fitness += 30000 + lapTimeBonus;
          const compromised = this.lapCompromised || this.pressureLearningBlocked;
          if (!compromised && (!this.bestLapTime || finishedLapTime < this.bestLapTime)) {
            this.bestLapTime = finishedLapTime;
            this.bestLapPressure = this.driverPressure;
            this.bestLapSplits = [...this.currentLapSplits];
            if (this.brain) {
              this.safeBrainBackup = this.brain.clone();
              this.safeBrainPressure = this.driverPressure;
            }
          }

          // Trigger pit stop upon crossing start/finish line if requested
          if (this.wantsToPit) {
            this.isPitting = true;
            this.pitTimer = Math.max(3.2, (Car.MAX_FUEL_CAPACITY - this.fuelKg) / 28);
            this.pitStopsCount++;
          }

          this.pressureLearningBlocked = this.pressureElapsed < 2;
          this.lapCompromised = this.incidentActive || this.recoveryTimer > 0 || this.pressureLearningBlocked;
          this.rollLapPerformanceVariation();
          this.currentLapTrajectory = [];
          this.maxSpeedInLap = 0;
          this.distanceCoveredInLap = 0;
          this.lapTime = 0;
          this.currentLapSplits = [null, null, null, null];

          return {
            compromised,
            pressure: this.driverPressure,
            lapTime: finishedLapTime,
            trajectory: finishedTrajectory,
            maxSpeed: finishedMaxSpeedKmh,
            avgSpeed: avgSpeedKmh,
            fuelRemaining: Math.round(this.fuelKg * 10) / 10,
          };
        } else {
          // First time crossing the start/finish line from grid slot: start flying lap!
          this.lapTime = 0;
          this.currentLapSplits = [null, null, null, null];
          this.lastCheckpointDelta = null;
          this.currentLapTrajectory = [];
          this.maxSpeedInLap = 0;
          this.distanceCoveredInLap = 0;
        }
      }
    }

    return null;
  }
}
