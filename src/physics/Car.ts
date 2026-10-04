import { Vector2, IntersectionResult, segmentsIntersect } from '../math/Vector2';
import { Track } from '../track/Track';
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

  // Mass & Fuel Specifications (FIA Regulations)
  public static readonly BASE_DRY_MASS: number = 798; // kg
  public static readonly MAX_FUEL_CAPACITY: number = 110; // kg (FIA standard tank)
  public fuelKg: number = 105.0; // kg (realistic race fuel load)
  public fuelBurnRatePerSec: number = 0; // kg/s
  public totalFuelConsumed: number = 0; // kg

  // Physical specifications (F1 Dimensions & Weights)
  public length: number = 30; // Visual length (px)
  public width: number = 14;  // Visual width (px)

  public static getDimensionsForTrackWidth(trackWidthMeters: number): { width: number; length: number; effectiveTrackWidth: number } {
    // trackWidthMeters is in realistic 5m - 20m range
    // Maps meters to simulation pixel geometry (5m -> 32px, 14m -> 76px, 20m -> 106px)
    const clampedMeters = Math.max(5, Math.min(20, trackWidthMeters));
    const effectiveTrackWidth = Math.max(28, Math.round(clampedMeters * 5.4));

    // Keep car prominent and clearly visible even on narrow tracks
    const scale = clampedMeters <= 8 ? 1.15 : 1.0;
    const width = Math.round(14 * scale);
    const length = Math.round(30 * scale);

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
  public readonly dragCoeff: number = 1.00; // Cd * A [m^2] (typowo ~1.0-1.4 dla F1; 0.70 dawalo Vmax ~425 km/h)
  public readonly airDensity: number = 1.225; // kg/m^3
  public readonly downforceCoeff: number = 3.10; // Cl * A [m^2] (~2.4 t docisku przy 400 km/h)
  public readonly baseTireGrip: number = 1.85; // Peak friction coefficient mu
  public readonly brakeGripMultiplier: number = 1.10; // hamowanie moze uzyc nieco wiecej tarcia niz boczne (1.6 dawalo mu=2.96 i ~10 G)

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
    // 1. Pure pursuit steering lookahead along the centerline
    const targetCp = track.checkpoints[(this.currentCheckpointIdx + 2) % n];

    const toTarget = targetCp.center.sub(this.pos).normalize();
    const headingVec = Vector2.fromAngle(this.heading);
    const cpAngleDiff = Math.atan2(headingVec.cross(toTarget), headingVec.dot(toTarget)) / Math.PI;

    const normalizedSpeed = Math.min(1.0, this.speed / 95.0);

    // 2. Speed-dependent multi-checkpoint braking zone calculation
    // Lookahead up to 24 steps (~430m) to provide ample runway for high-speed braking
    const lookaheadSteps = Math.max(8, Math.min(24, Math.ceil(this.speed / 3.4)));
    let maxOverspeed = -1.0;
    let maxUpcomingCurvature = 0;

    // Corner safe lateral grip uses base tire friction with margin (~1.5G usable before aero)
    const safeLatGrip = this.baseTireGrip * Car.GRAVITY * 0.82;
    // Achievable braking deceleration with margin (12.0 m/s^2 provides ample runway and settling buffer)
    const aBrake = 12.0 * this.brakingAggression;

    let accumulatedDist = 0;
    let prevPos = this.pos;

    for (let k = 1; k <= lookaheadSteps; k++) {
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
        const safeV = Math.sqrt(Math.max(25, cornerRadius * effectiveCornerGrip));

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

    const idealSteer = Math.max(-1, Math.min(1, cpAngleDiff * 1.4 + wallRepulsion * 0.7 - this.angularVelocity * 0.15));
    const steer = Math.max(-1, Math.min(1, outputs[0] * 0.45 + idealSteer * 0.55));

    // Check forward clearance using central LiDAR rays
    const forwardDistNorm = this.rayDistances[midRay] ?? 1.0;
    const leftForwardNorm = this.rayDistances[Math.max(0, midRay - 1)] ?? 1.0;
    const rightForwardNorm = this.rayDistances[Math.min(this.rayDistances.length - 1, midRay + 1)] ?? 1.0;
    const minCenterClearance = Math.min(forwardDistNorm, leftForwardNorm, rightForwardNorm);

    // 3. F1 Racing Throttle & Braking Policy:
    let throttle: number;
    let brake: number;

    if (overspeedDelta > 0.0) {
      // Actively in braking zone before turn: FIRM BRAKE, ZERO THROTTLE
      throttle = 0.0;
      brake = Math.max(0.65, Math.min(1.0, 0.60 + overspeedDelta * 1.5));
    } else if (overspeedDelta > -0.15) {
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

    const control: CarControl = { steer, throttle, brake };
    this.currentControl = control;

    // Online learning via replay buffer
    if (_enableLearning) {
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

  /**
   * Advanced vehicle dynamics step:
   * Simulates gravity, aerodynamic downforce, centrifugal force,
   * longitudinal & lateral dynamic weight transfer, and Kamm's friction circle.
   */
  updatePhysics(control: CarControl, dt: number, track: Track): LapFinishEvent | null {
    if (!this.isAlive) {
      this.effectiveThrottle = 0;
      this.lateralG = 0;
      this.longitudinalG = 0;
      return null;
    }

    this.currentControl = { ...control };

    if (this.isPitting) {
      this.effectiveThrottle = 0;
      this.lateralG = 0;
      this.longitudinalG = 0;
      this.pitTimer -= dt;
      if (!this.isFinishedRace) {
        this.totalRaceTime += dt;
      }
      this.framesSinceLastCheckpoint = 0; // Prevent timeout while in pit box
      this.vel.set(0, 0);
      this.speed = 0;
      this.speedKmh = 0;
      // Refueling during pit stop
      this.fuelKg = Math.min(Car.MAX_FUEL_CAPACITY, this.fuelKg + 28.0 * dt);
      if (this.pitTimer <= 0) {
        this.isPitting = false;
        this.wantsToPit = false;
        this.isOutOfFuel = false;
        this.fuelKg = Math.min(Car.MAX_FUEL_CAPACITY, Math.max(55.0, this.fuelKg));
      }
      return null;
    }

    this.timeAlive += dt;
    this.lapTime += dt;
    if (!this.isFinishedRace) {
      this.totalRaceTime += dt;
    }
    this.framesSinceLastCheckpoint++;

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
      // Limp mode: can only crawl to the pit lane (~18 km/h)
      actualThrottle = Math.min(0.08, actualThrottle);
      this.fuelBurnRatePerSec = 0;
    } else {
      const baseBurn = 0.004;
      const loadBurn = 0.062 * actualThrottle * (0.30 + 0.70 * (this.speed / 95));
      this.fuelBurnRatePerSec = baseBurn + loadBurn;
      const fuelConsumed = this.fuelBurnRatePerSec * dt;
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

    // Aero Drag
    const effectiveDragCoeff = this.dragCoeff * this.lapDragFactor;
    const aeroDragMag = 0.5 * this.airDensity * effectiveDragCoeff * (speedMag * speedMag);
    const aeroDragForce = -aeroDragMag * (forwardSpeed >= 0 ? 1 : -1);

    // 4. Longitudinal Forces & Dynamic Pitch Weight Transfer
    // Static distribution: 46% Front, 54% Rear
    // Dynamic weight transfer: Delta Fz = m * a_x * (h / L)
    const prevAccelX = this.longitudinalG * Car.GRAVITY;
    const dynamicPitchTransfer = currentMass * (-prevAccelX) * (this.cogHeight / this.wheelbase);

    const normalLoadFront = Math.max(100, (0.46 * totalNormalLoadZ) + dynamicPitchTransfer);
    const normalLoadRear = Math.max(100, (0.54 * totalNormalLoadZ) - dynamicPitchTransfer);
    this.weightFrontRatio = normalLoadFront / totalNormalLoadZ;

    // Visual pitch angle (nose dive under braking, squat under acceleration)
    this.pitchAngle = Math.max(-0.06, Math.min(0.06, -this.longitudinalG * 0.015));

    // Longitudinal Engine Force (Traction on rear wheels)
    let driveForceMag = 0;
    if (actualThrottle > 0.005) {
      const effectivePower = this.maxEnginePower * actualThrottle * this.lapPowerFactor;
      const powerForce = effectivePower / Math.max(12.0, forwardSpeed);
      // Rear traction limit governed by dynamic rear vertical load: F = mu * Fz_rear
      const rearTractionLimit = this.baseTireGrip * this.lapGripFactor * normalLoadRear;
      driveForceMag = Math.min(rearTractionLimit, powerForce);
    }

    // Braking Force (carbon-carbon brakes, F1) (Brake bias ~56% front, 44% rear)
    let maxBrakeMag = 0;
    let brakeFrontForce = 0;
    let brakeRearForce = 0;
    if (control.brake > 0.01) {
      const maxBrakeFront = this.baseTireGrip * this.brakeGripMultiplier * normalLoadFront;
      const maxBrakeRear = this.baseTireGrip * this.brakeGripMultiplier * normalLoadRear;
      brakeFrontForce = control.brake * maxBrakeFront;
      brakeRearForce = control.brake * maxBrakeRear;
      maxBrakeMag = brakeFrontForce + brakeRearForce;
    }

    // Velocity before resistance forces
    const vStar = forwardSpeed + ((driveForceMag + aeroDragForce) / currentMass) * dt;

    // Rolling resistance acts only against motion or when drive is engaged
    const maxRollingResist = (Math.abs(vStar) > 0.001 || driveForceMag > 0) ? 0.012 * totalNormalLoadZ : 0;
    const maxResistMag = maxBrakeMag + maxRollingResist;

    // Resistive forces can only bring vehicle to a stop, never accelerate backwards
    const forceToStop = (currentMass * Math.abs(vStar)) / dt;
    const actualResistMag = Math.min(maxResistMag, forceToStop);
    const netResistForce = -Math.sign(vStar) * actualResistMag;

    const netLongitudinalForce = driveForceMag + aeroDragForce + netResistForce;
    const accelForward = netLongitudinalForce / currentMass;
    const rawLongG = accelForward / Car.GRAVITY;
    this.longitudinalG = Number.isFinite(rawLongG) ? Math.max(-8.0, Math.min(4.0, rawLongG)) : 0;

    let newForwardSpeed = vStar + (netResistForce / currentMass) * dt;
    if (Math.abs(newForwardSpeed) < 1e-6) {
      newForwardSpeed = 0;
    }

    // 5. Steering, Centrifugal Force & Kamm's Circle
    const steerAngle = control.steer * this.maxSteerAngle;
    const idealYawRate = (newForwardSpeed / this.wheelbase) * Math.tan(steerAngle);

    // Dynamic Lateral Weight Transfer (Roll onto outside wheels)
    // Delta Fz_roll = m * a_y * (h / W)
    const prevAccelY = this.lateralG * Car.GRAVITY;
    const dynamicRollTransfer = currentMass * prevAccelY * (this.cogHeight / this.trackWidthMeters);
    const rollGripLoss = Math.min(0.08, (Math.abs(dynamicRollTransfer) / totalNormalLoadZ) * 0.15);
    // Visual roll angle
    this.rollAngle = Math.max(-0.08, Math.min(0.08, this.lateralG * 0.018));

    // Kamm's Circle of Forces (Friction Circle):
    // If tire is braking heavily, remaining lateral grip is reduced:
    // F_y_avail = F_y_max * sqrt(1 - (F_x / F_x_max)^2)
    const frontLongitudinalUsage = Math.min(0.98, brakeFrontForce / Math.max(1, this.baseTireGrip * normalLoadFront));
    const rearLongitudinalUsage = Math.min(0.98, Math.max(brakeRearForce, driveForceMag) / Math.max(1, this.baseTireGrip * normalLoadRear));

    const frontGripFactor = Math.sqrt(Math.max(0.05, 1.0 - frontLongitudinalUsage * frontLongitudinalUsage));
    const rearGripFactor = Math.sqrt(Math.max(0.05, 1.0 - rearLongitudinalUsage * rearLongitudinalUsage));

    // Maximum cornering force supported by front and rear axles
    const effectiveTireMu = this.baseTireGrip * this.lapGripFactor * (1.0 - rollGripLoss);
    const frontMaxLateralForce = effectiveTireMu * normalLoadFront * frontGripFactor;
    const rearMaxLateralForce = effectiveTireMu * normalLoadRear * rearGripFactor;
    const totalMaxLateralForce = frontMaxLateralForce + rearMaxLateralForce;

    // Outward Centrifugal Force: F_cf = m * v * omega = m * v^2 / R
    const centrifugalForceMag = currentMass * Math.abs(newForwardSpeed * idealYawRate);
    // The ideal steering path can demand more lateral force than the tires can supply.
    // Report tire-supported lateral acceleration, not the unconstrained demand.
    const actualLateralForce = Math.min(centrifugalForceMag, totalMaxLateralForce);

    let actualYawRate = idealYawRate;

    // Check if Centrifugal Force exceeds Total Tire Grip limit:
    if (centrifugalForceMag > totalMaxLateralForce && Math.abs(newForwardSpeed) > 10) {
      // Over the limit: Centrifugal force breaks tire adhesion!
      const gripRatio = Math.max(0, Math.min(1, totalMaxLateralForce / centrifugalForceMag));
      // Actual yaw rate is bounded by physically available tire lateral force: omega = F_lat_avail / (m * v)
      actualYawRate = idealYawRate * gripRatio;
      this.isSkidding = true;

      // Tire scrub: sliding dissipates forward velocity
      newForwardSpeed *= (1.0 - 0.09 * dt);

      // Understeer vs Oversteer balance
      if (frontGripFactor < rearGripFactor) {
        this.understeerSlip = 1.0 - gripRatio; // Front washes out
      } else {
        this.oversteerSlip = 1.0 - gripRatio;  // Rear steps out
      }
    } else {
      this.isSkidding = Math.abs(lateralSpeed) > 4.5 && speedMag > 18;
      this.understeerSlip = 0;
      this.oversteerSlip = 0;
    }

    // Safety check in race mode: if car experiences severe instability or critical oversteer, rollback brain to safe baseline
    if (this.isRaceMode && this.safeBrainBackup && this.brain && this.isSkidding && (this.oversteerSlip > 0.45 || Math.abs(actualYawRate) > 3.2)) {
      this.brain = this.safeBrainBackup.clone();
      this.replayBuffer = [];
    }

    if (this.isSkidding && Math.random() < 0.28) {
      this.skidMarks.push(this.pos.clone());
      if (this.skidMarks.length > 60) this.skidMarks.shift();
    }

    // 6. Update Heading & Velocity
    this.angularVelocity = actualYawRate;
    this.heading += this.angularVelocity * dt;

    const newForwardDir = Vector2.fromAngle(this.heading);
    const newRightDir = newForwardDir.normal();

    // Shared lateral force budget: slide damping uses residual tire force after turning force
    const residualLateralForce = Math.sqrt(Math.max(0, totalMaxLateralForce * totalMaxLateralForce - actualLateralForce * actualLateralForce));
    const maxSlideDampAccel = residualLateralForce / currentMass;
    let outwardSlideAccel = 0;
    let slideDampForce = 0;
    if (Math.abs(lateralSpeed) > 0.001) {
      const desiredDampAccel = Math.min(Math.abs(lateralSpeed) / dt, Math.abs(lateralSpeed) * 12.0);
      const actualDampAccelMag = Math.min(desiredDampAccel, maxSlideDampAccel);
      outwardSlideAccel = -Math.sign(lateralSpeed) * actualDampAccelMag;
      slideDampForce = actualDampAccelMag * currentMass;
    }
    let newLateralSpeed = lateralSpeed + outwardSlideAccel * dt;

    // Combined lateral G reflects total lateral acceleration (turning + slide damping) without exceeding tire limit
    const totalCombinedLateralForce = Math.min(totalMaxLateralForce, Math.hypot(actualLateralForce, slideDampForce));
    const rawLatG = totalCombinedLateralForce / (currentMass * Car.GRAVITY);
    this.lateralG = Number.isFinite(rawLatG) ? Math.max(0, Math.min(8.0, rawLatG)) : 0;

    // Recompose global velocity vector
    this.vel = newForwardDir.mul(newForwardSpeed).add(newRightDir.mul(newLateralSpeed));

    // 7. Position & Distance Update (1 px = 1 meter)
    const stepDelta = this.vel.mul(dt);
    this.prevPos.set(this.pos.x, this.pos.y);
    this.pos.addMut(stepDelta);
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
      if (effectiveSpeed > 0 && effectiveAlignment > 0) {
        const alignBonus = Math.max(0.15, effectiveAlignment);
        this.fitness += effectiveSpeed * alignBonus * 0.15 * dt;
      } else if (effectiveSpeed < 0 && !isHighCurvature) {
        // Penalty for moving backwards along track
        this.fitness = Math.max(0, this.fitness + effectiveSpeed * 0.45 * dt);
      }

      // Penalty for wrong heading / driving in reverse direction (never terminate on high curvature)
      if (effectiveAlignment < -0.20 && !isHighCurvature) {
        const wrongWayPenalty = (250.0 * Math.abs(effectiveAlignment) + Math.abs(this.speed) * 6.0) * dt;
        this.fitness = Math.max(0, this.fitness - wrongWayPenalty);

        if (effectiveAlignment < -0.45 && directionalSpeed < -5.0 && this.speed > 8.0) {
          this.wrongWayTimer += dt;
          if (this.wrongWayTimer > 1.6) {
            // Terminate car driving backwards at speed on straight/gentle corner
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
      const slipMagnitude = Math.abs(newLateralSpeed) + (this.understeerSlip + this.oversteerSlip) * 14.0;
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

  private checkTrackProgress(track: Track): LapFinishEvent | null {
    if (this.fitness > this.peakFitness) {
      this.peakFitness = this.fitness;
    }
    if (track.isOutOfBounds(this.pos)) {
      this.isAlive = false;
      this.effectiveThrottle = 0;
      this.lateralG = 0;
      this.longitudinalG = 0;
      this.vel.set(0, 0);
      this.speed = 0;
      this.speedKmh = 0;
      this.respawnTimer = 0.5;
      // Meaningful crash penalty costing substantially more than a small fixed value,
      // while strictly preserving the relative ranking and gradient of checkpoint progress:
      this.fitness = Math.max(0, Math.round(this.fitness * 0.45));
      return null;
    }

    if (this.isOutOfFuel && this.speed < 1.0) {
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

    if (this.framesSinceLastCheckpoint > 600) {
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

    const isNearCp = distToCp < Math.max(12, track.width * 0.75);
    // (1) Checkpoint zaliczaj tylko przy ruchu zgodnym z tangentem toru
    const isMovingForwardAlongTrack = this.vel.dot(nextCp.tangent) > 0.5;

    if (isMovingForwardAlongTrack && (crossedGate || isNearCp)) {
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
          this.fitness += 30000 + lapTimeBonus;
          if (!this.bestLapTime || finishedLapTime < this.bestLapTime) {
            this.bestLapTime = finishedLapTime;
            this.bestLapSplits = [...this.currentLapSplits];
            if (this.brain) {
              this.safeBrainBackup = this.brain.clone();
            }
          }

          // Trigger pit stop upon crossing start/finish line if requested
          if (this.wantsToPit) {
            this.isPitting = true;
            this.pitTimer = 3.2; // 3.2s stationary pit stop
            this.pitStopsCount++;
          }

          this.rollLapPerformanceVariation();
          this.currentLapTrajectory = [];
          this.maxSpeedInLap = 0;
          this.distanceCoveredInLap = 0;
          this.lapTime = 0;
          this.currentLapSplits = [null, null, null, null];

          return {
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
