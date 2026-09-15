import { Vector2, IntersectionResult } from '../math/Vector2';
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
  public readonly dragCoeff: number = 0.70; // Cd * A
  public readonly airDensity: number = 1.225; // kg/m^3
  public readonly downforceCoeff: number = 2.65; // Cl * A
  public readonly baseTireGrip: number = 1.85; // Peak friction coefficient mu

  // Organic Performance Variations
  public lapPowerFactor: number = 1.0;
  public lapGripFactor: number = 1.0;
  public lapDragFactor: number = 1.0;

  // Kinematics (in SI units: meters, m/s, radians)
  public pos: Vector2;
  public vel: Vector2 = new Vector2(0, 0);
  public heading: number; // Radians
  public angularVelocity: number = 0;
  public speed: number = 0; // m/s
  public speedKmh: number = 0; // km/h
  public maxSpeedInLap: number = 0; // m/s
  public distanceCoveredInLap: number = 0; // meters

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
  public isOutOfFuel: boolean = false;
  public fitness: number = 0;
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
    this.vel = new Vector2(0, 0);
    this.heading = startHeading;
    this.angularVelocity = 0;
    this.speed = 0;
    this.speedKmh = 0;
    this.maxSpeedInLap = 0;
    this.distanceCoveredInLap = 0;
    this.isAlive = true;
    this.respawnTimer = 0;
    this.isOutOfFuel = false;
    this.fitness = 0;
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

  getAIControl(track: Track, leaderSpeeds?: number[]): CarControl {
    if (!this.brain || !this.isAlive) {
      return { throttle: 0, brake: 0, steer: 0 };
    }

    // AI pit strategy: request pit stop if fuel reserve is low
    if (this.fuelKg < 12.0 && !this.isPitting) {
      this.wantsToPit = true;
    }

    const n = track.checkpoints.length;
    // 1. Pure pursuit steering lookahead along the centerline
    const steerLookaheadOffset = Math.max(1, Math.min(4, Math.floor(1 + this.speed / 22)));
    const targetCp = track.checkpoints[(this.currentCheckpointIdx + steerLookaheadOffset) % n];

    const toTarget = targetCp.center.sub(this.pos).normalize();
    const headingVec = Vector2.fromAngle(this.heading);
    const cpAngleDiff = Math.atan2(headingVec.cross(toTarget), headingVec.dot(toTarget)) / Math.PI;

    const normalizedSpeed = Math.min(1.0, this.speed / 95.0);

    // 2. Speed-dependent multi-checkpoint braking zone calculation
    // Governed by braking aggression (0.5 to 1.5)
    const lookaheadSteps = Math.max(5, Math.min(16, Math.ceil(this.speed / 5.2)));
    let maxOverspeed = -1.0;
    let maxUpcomingCurvature = 0;

    const aeroDownforceAcc = (0.5 * this.airDensity * this.downforceCoeff * this.speed * this.speed) / this.totalMass;
    const effectiveLatGrip = this.baseTireGrip * Car.GRAVITY + aeroDownforceAcc;
    // F1 carbon-ceramic braking capability: ~4.5G to 5.5G at high speed with aero assistance
    const fuelLoadRatio = Math.max(0, Math.min(1.0, this.fuelKg / 50.0));
    const massBrakingAdaptation = 1.0 + (1.0 - fuelLoadRatio) * 0.04;
    const aBrake = (42.0 + aeroDownforceAcc * 0.40) * this.brakingAggression * massBrakingAdaptation;

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

      if (curK > 0.003) {
        const cornerRadius = 1.0 / curK;
        const safeV = Math.sqrt(Math.max(10, cornerRadius * effectiveLatGrip * 0.88));
        const maxAllowedV = Math.sqrt(safeV * safeV + 2.0 * aBrake * accumulatedDist);

        if (this.speed > maxAllowedV) {
          const overspeed = (this.speed - maxAllowedV) / 20.0;
          if (overspeed > maxOverspeed) {
            maxOverspeed = overspeed;
          }
        }
      }
    }

    const curvatureInput = Math.min(1.0, maxUpcomingCurvature * 24.0);
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

    const steer = Math.max(-1, Math.min(1, outputs[0]));

    // Check forward clearance using central LiDAR rays
    const midRayIdx = Math.floor(this.rayDistances.length / 2);
    const forwardDistNorm = this.rayDistances[midRayIdx] ?? 1.0;
    const leftForwardNorm = this.rayDistances[Math.max(0, midRayIdx - 1)] ?? 1.0;
    const rightForwardNorm = this.rayDistances[Math.min(this.rayDistances.length - 1, midRayIdx + 1)] ?? 1.0;
    const minCenterClearance = Math.min(forwardDistNorm, leftForwardNorm, rightForwardNorm);

    // 3. F1 Racing Throttle & Braking Policy:
    // - If approaching a corner too fast (overspeedDelta > 0):
    //     BRAKE FIRMLY (Carbon-ceramic deceleration: ~4.5G - 5.5G). Throttle = 0.
    // - If NOT overspeeding (overspeedDelta <= 0):
    //     ZERO BRAKING. Brake is strictly 0.0.
    //     On straights, gentle bends, and corner exits (Math.abs(steer) < 0.35):
    //     100% FULL THROTTLE (Flat out up to 420+ km/h!).
    //     In tight cornering (Math.abs(steer) >= 0.35):
    //     Modulate throttle for traction (50-80%), snapping to 100% as steering centers.
    let throttle: number;
    let brake: number;

    if (overspeedDelta > 0.0) {
      // Actively in braking zone before turn:
      throttle = 0.0;
      brake = Math.max(0.40, Math.min(1.0, 0.40 + overspeedDelta * 1.5));
    } else {
      // In acceleration or cruising zone - NO BRAKING!
      brake = 0.0;
      if (minCenterClearance > 0.18) {
        if (Math.abs(steer) < 0.35) {
          // Straights, gentle sweepers, and corner exits: 100% FLAT OUT
          throttle = 1.0;
        } else {
          // Apex cornering: traction control modulation
          const steerExcess = Math.abs(steer) - 0.35;
          throttle = Math.max(0.50, 1.0 - steerExcess * 0.80);
        }
      } else {
        // Approaching wall / close clearance: moderate throttle
        throttle = Math.max(0.25, Math.min(0.60, (outputs[1] + 0.3) * 0.9));
      }

      // Telemetry coaching from session leader:
      if (leaderSpeeds && leaderSpeeds.length > 0) {
        const leaderV = leaderSpeeds[this.currentCheckpointIdx % leaderSpeeds.length];
        if (leaderV && this.speedKmh < leaderV - 8) {
          throttle = 1.0;
        }
      }
    }

    // Point 4: Experience Replay Buffer sampling and online consolidation
    // Record both cornering technique AND straightaway full-throttle commitment
    const isCornering = (Math.abs(steer) > 0.08 || overspeedDelta > 0.05);
    const isHighSpeedStraight = (overspeedDelta <= 0 && this.speed > 25 && Math.abs(steer) < 0.10);
    const canRecordExperience = !this.isSkidding && (isCornering || isHighSpeedStraight);

    if (canRecordExperience) {
      const targetThrottle = overspeedDelta > 0 ? 0.0 : (Math.abs(steer) < 0.35 ? 1.0 : throttle);
      const targetBrake = brake;
      this.replayBuffer.push({
        inputs: [...inputs],
        targets: [steer, targetThrottle, targetBrake],
        reward: this.speedKmh, // Speed-based reward instead of monotonically accumulating fitness
      });
      if (this.replayBuffer.length > 40) {
        this.replayBuffer.shift();
      }
    }

    this.replayStepTimer++;
    // Gentle learning rate (0.001) to prevent weight drift and catastrophic forgetting
    if (this.replayStepTimer % 90 === 0 && this.replayBuffer.length >= 6 && this.brain) {
      const sorted = [...this.replayBuffer].sort((a, b) => b.reward - a.reward);
      const topBatch = sorted.slice(0, 3);
      for (const item of topBatch) {
        this.brain.train(item.inputs, item.targets, 0.001);
      }
    }

    return { steer, throttle, brake };
  }

  /**
   * Advanced vehicle dynamics step:
   * Simulates gravity, aerodynamic downforce, centrifugal force,
   * longitudinal & lateral dynamic weight transfer, and Kamm's friction circle.
   */
  updatePhysics(control: CarControl, dt: number, track: Track): LapFinishEvent | null {
    if (!this.isAlive) return null;

    if (this.isPitting) {
      this.pitTimer -= dt;
      this.totalRaceTime += dt;
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
    this.totalRaceTime += dt;
    this.framesSinceLastCheckpoint++;

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

    // Braking Force with Carbon-Ceramic deceleration (Brake bias ~56% front, 44% rear)
    let brakeForceMag = 0;
    let brakeFrontForce = 0;
    let brakeRearForce = 0;
    if (control.brake > 0.01) {
      const maxBrakeFront = this.baseTireGrip * 1.60 * normalLoadFront;
      const maxBrakeRear = this.baseTireGrip * 1.60 * normalLoadRear;
      brakeFrontForce = control.brake * maxBrakeFront;
      brakeRearForce = control.brake * maxBrakeRear;
      brakeForceMag = brakeFrontForce + brakeRearForce;
      if (forwardSpeed < 0) brakeForceMag = -brakeForceMag;
    }

    const rollingResist = -0.012 * totalNormalLoadZ * (forwardSpeed >= 0 ? 1 : -1);
    const netLongitudinalForce = driveForceMag - brakeForceMag + aeroDragForce + rollingResist;
    const accelForward = netLongitudinalForce / currentMass;
    this.longitudinalG = accelForward / Car.GRAVITY;

    let newForwardSpeed = forwardSpeed + accelForward * dt;
    if (forwardSpeed > 0 && newForwardSpeed < 0 && control.brake > 0.05) {
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
    this.lateralG = Math.abs(newForwardSpeed * idealYawRate) / Car.GRAVITY;

    let actualYawRate = idealYawRate;
    let outwardSlideAccel = 0;

    // Check if Centrifugal Force exceeds Total Tire Grip limit:
    if (centrifugalForceMag > totalMaxLateralForce && Math.abs(newForwardSpeed) > 10) {
      // Over the limit: Centrifugal force breaks tire adhesion!
      const gripRatio = totalMaxLateralForce / centrifugalForceMag;
      actualYawRate = idealYawRate * Math.max(0.35, gripRatio);
      this.isSkidding = true;

      // The un-balanced centrifugal force pushes car laterally outward towards the barriers!
      const excessCentrifugalForce = centrifugalForceMag - totalMaxLateralForce;
      const turnSign = Math.sign(steerAngle || idealYawRate);
      outwardSlideAccel = turnSign * (excessCentrifugalForce / currentMass);

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

    // Lateral velocity accounts for outward centrifugal slide and tire damping
    let newLateralSpeed = (lateralSpeed + outwardSlideAccel * dt) * Math.max(0, 1.0 - 12.0 * dt);

    // Recompose global velocity vector
    this.vel = newForwardDir.mul(newForwardSpeed).add(newRightDir.mul(newLateralSpeed));

    // 7. Position & Distance Update (1 px = 1 meter)
    const stepDelta = this.vel.mul(dt);
    this.pos.addMut(stepDelta);
    this.speed = this.vel.mag();
    this.speedKmh = this.speed * 3.6;
    this.maxSpeedInLap = Math.max(this.maxSpeedInLap, this.speed);
    this.distanceCoveredInLap += stepDelta.mag();

    // Continuous distance reward: reward forward distance made along the track
    if (forwardSpeed > 0) {
      this.fitness += forwardSpeed * 0.12 * dt;
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
    return this.checkTrackProgress(track);
  }

  private checkTrackProgress(track: Track): LapFinishEvent | null {
    if (track.isOutOfBounds(this.pos)) {
      this.isAlive = false;
      this.vel.set(0, 0);
      this.speed = 0;
      this.speedKmh = 0;
      this.respawnTimer = 0.5;
      // Penalty for crashing: crashing is strictly worse than braking and staying on track
      this.fitness = Math.max(0, this.fitness - 400);
      return null;
    }

    if (this.isOutOfFuel && this.speed < 1.0) {
      this.isAlive = false;
      this.vel.set(0, 0);
      this.speed = 0;
      this.speedKmh = 0;
      this.respawnTimer = 0.5;
      return null;
    }

    if (this.framesSinceLastCheckpoint > 600) {
      this.isAlive = false;
      this.vel.set(0, 0);
      this.speed = 0;
      this.speedKmh = 0;
      this.respawnTimer = 0.5;
      return null;
    }

    const nextCp = track.checkpoints[this.currentCheckpointIdx % track.checkpoints.length];
    const distToCp = this.pos.dist(nextCp.center);

    if (distToCp < Math.max(12, track.width * 0.75)) {
      this.checkpointsCleared++;

      // Point 2: Apex Clipping and Exit Speed Rewards
      if (Math.abs(nextCp.curvature) > 0.003) {
        const innerCurb = nextCp.curvature > 0 ? nextCp.p1 : nextCp.p2;
        const distToInner = this.pos.dist(innerCurb);
        if (distToInner < track.width * 0.32 && !this.isSkidding) {
          // Apex clipped cleanly!
          this.fitness += 1200;
        }
      } else if (this.currentCheckpointIdx > 0) {
        const prevCp = track.checkpoints[(this.currentCheckpointIdx - 1 + track.checkpoints.length) % track.checkpoints.length];
        if (Math.abs(prevCp.curvature) > 0.003 && this.speed > 25 && !this.isSkidding) {
          // High speed corner exit acceleration reward!
          this.fitness += 800 + Math.round(this.speedKmh * 3);
        }
      }

      // Reward clearing checkpoint; bonus if clean corner without washing out
      const cleanCornerBonus = !this.isSkidding ? 400 : 100;
      this.fitness += 1400 + cleanCornerBonus;
      this.framesSinceLastCheckpoint = 0;
      this.currentCheckpointIdx = (this.currentCheckpointIdx + 1) % track.checkpoints.length;

      // Check 4 timing checkpoints (CP1, CP2, CP3)
      if (track.timingGates && track.timingGates.length === 4) {
        for (let g = 0; g < 3; g++) {
          const gate = track.timingGates[g];
          if (this.currentLapSplits[g] === null && Math.abs(this.currentCheckpointIdx - gate.pointIndex) <= 1 && this.lapTime > 1.2) {
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
            // Positive reinforcement on sector improvement (green/purple sector)
            if (delta < 0 && this.brain && this.replayBuffer.length >= 3) {
              const topBatch = this.replayBuffer.slice(-3);
              const lr = this.isRaceMode ? 0.003 : 0.010;
              for (const item of topBatch) {
                this.brain.train(item.inputs, item.targets, lr);
              }
            }
          }
        }
      }

      // Completed a full lap!
      if (this.currentCheckpointIdx === 0) {
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
          const lapTimeBonus = Math.round(120000 / Math.max(10, finishedLapTime));
          this.fitness += 25000 + lapTimeBonus;
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
