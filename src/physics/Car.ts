import { random } from '../math/Random';
import { normalizePressure, pressureProfile } from '../ai/DriverPressure';
import { PaceSearch } from '../ai/PaceSearch';
import { LineSearch } from '../ai/LineSearch';
import { LineProfile } from '../ai/LineProfile';
import type { LineNet } from '../ai/LineNet';
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

/** LiDAR rays + 5 driving inputs + 6 vehicle-state inputs (tyre temps, wear, ERS, gear, rpm). */
export const DRIVER_EXTRA_INPUTS = 11;
export const driverInputCount = (rayCount: number): number => rayCount + DRIVER_EXTRA_INPUTS;

export interface DrivePlan {
  inputs: number[];
  expert: CarControl;
  idealSteer: number;
  pushing: boolean;
  offRoad: boolean;
  overspeedDelta: number;
  minCenterClearance: number;
  guarded: boolean;
}

const STEER_ENCODING = 0.95;
const PEDAL_ENCODING = 0.9;
/** Map tanh network outputs to controls; encoded targets keep tanh away from saturation. */
export function decodeDriverOutputs(outputs: number[]): CarControl {
  const pedal = (v: number) => { const x = Math.max(0, Math.min(1, (v ?? 0) / PEDAL_ENCODING)); return x < 0.03 ? 0 : x; };
  const throttle = pedal(outputs[1]), brake = pedal(outputs[2]);
  // The dominant pedal wins: a small residual on the idle output must not cancel a clear command.
  return {
    steer: Math.max(-1, Math.min(1, (outputs[0] ?? 0) / STEER_ENCODING)),
    throttle: brake > throttle ? 0 : throttle,
    brake: brake > throttle ? brake : 0,
  };
}
export function encodeDriverTargets(t: ArrayLike<number>): [number, number, number] {
  return [
    Math.max(-1, Math.min(1, t[0])) * STEER_ENCODING,
    Math.max(0, Math.min(1, t[1])) * PEDAL_ENCODING,
    Math.max(0, Math.min(1, t[2])) * PEDAL_ENCODING,
  ];
}

export class Car {
  // Identification
  public id: number = Math.floor(random() * 9000) + 1000;
  public driverName: string = 'Bolid AI';

  // Spatial Scale: 1 px = 1 meter (50 px grid = 50 meters)
  public static readonly METERS_PER_PIXEL: number = 1.0;
  public static readonly GRAVITY: number = 9.81; // m/s^2
  /** Closing speed (m/s) at which a single contact wrecks a car; smaller hits accumulate as damage ∝ v². */
  public static readonly CRASH_CLOSING_SPEED: number = 12;
  /** Tyre cornering stiffness in N per N of vertical load per radian of slip angle. */
  public static readonly STEERING_LAG: number = 0.09; // s
  /** The front axle saturates slightly before the rear: a stable, understeer-biased balance at the limit. */
  public static readonly FRONT_GRIP_BIAS: number = 1.0;
  /** Slip-angle / yaw-inertia model above ~8 m/s (false = purely kinematic response). */
  public static DYNAMIC_YAW = true;
  /** Fraction of the lateral force in use that drive/brake may not take from the friction circle. */
  public static readonly STABILITY_RESERVE: number = 1.1;
  public static readonly YAW_FEEDBACK: number = 0.1;
  public static readonly CORNERING_STIFFNESS: number = 22;
  /** Magic Formula (Pacejka) axle curve with a post-peak drop instead of the saturating tanh. */
  public static PACEJKA = false;
  public static readonly MF_C = 1.35;
  public static readonly MF_E = -0.85;
  public static readonly MF_ALPHA_PEAK = 0.13; // rad
  /** Yaw inertia in kg·m² per kg of total mass (≈1170 kg·m² for a 900 kg car). */
  public static readonly YAW_INERTIA_FACTOR: number = 1.3;
  /** Conservative planning deceleration: ~55% of low-speed tyre braking (0.9·μ·g) before downforce. */
  public static readonly PLANNED_BRAKE_DECEL: number = 8.5;

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
  public readonly maxEnginePower: number = 750000; // 750 kW (~1000 HP): ICE + full MGU-K deployment
  /** Internal combustion share; the MGU-K adds up to ERS_POWER on top of it. */
  public static readonly ICE_POWER = 400000;
  /** 2026 power unit: MGU-K deploys up to 350 kW, no MGU-H. */
  public static readonly ERS_POWER = 350000;          // MGU-K, W
  public static readonly ERS_CAPACITY = 4_000_000;    // usable battery window, J
  public static readonly ERS_LAP_HARVEST = 8_500_000; // energy the MGU-K may recover per lap, J
  public static readonly ERS_REGEN_EFFICIENCY = 0.88;
  /** MGU-K harvesting limit under braking. */
  public static readonly ERS_HARVEST_POWER = 350000;
  /** Deployment tapers linearly from full power at 290 km/h to zero at 355 km/h. */
  public static readonly ERS_TAPER_START = 290 / 3.6;
  public static readonly ERS_TAPER_END = 355 / 3.6;
  /**
   * Energy management: below ERS_LOW_SOC deployment fades so a lap's deployment matches its harvest;
   * at ERS_CLIP_SOC the MGU-K stops deploying and clips.
   */
  public static readonly ERS_LOW_SOC = 0.9;
  public static readonly ERS_CLIP_SOC = 0.1;
  /** Part-throttle charging: the ICE drives the MGU-K as a generator through corners. */
  public static readonly ERS_PART_THROTTLE_CHARGE = 100000;
  /** Super clipping: on full throttle with a flat battery the ICE drives the MGU-K as a generator. */
  public static readonly ERS_CLIP_POWER = 50000;
  /** Seconds an AI car may spend off the asphalt trying to rejoin before it is retired as stuck. */
  public static readonly OFF_TRACK_RECOVERY_TIME = 12;
  /**
   * Quasi-static ride-height aero: downforce compresses the axles, the floor works best at a
   * particular height and chokes when it gets too close to the road. Ride height follows with a lag
   * so the stall threshold cannot chatter from step to step.
   */
  public static RIDE_HEIGHT_AERO = true;
  public static readonly FRH_STATIC = 0.030;
  public static readonly RRH_STATIC = 0.055;
  public static readonly AXLE_STIFFNESS_FRONT = 380000; // 2 x 145 kN/m springs + 90 kN/m heave element
  public static readonly AXLE_STIFFNESS_REAR = 305000;  // 2 x 115 kN/m + 75 kN/m
  public rideHeightFront = Car.FRH_STATIC;
  public rideHeightRear = Car.RRH_STATIC;
  public aeroStall = false;

  /** Lift-coefficient multiplier from front/rear ride height, normalised to 1 at a typical cornering height. */
  static rideHeightLift(frh: number, rrh: number): number {
    const front = 1 + 0.35 * Math.exp(-(((frh - 0.016) / 0.018) ** 2));
    const rear = 1 + 0.45 * (rrh / 0.035) * Math.exp(1 - rrh / 0.035);
    const stall = frh < 0.008 || rrh < 0.015 ? 0.75 + 0.25 * Math.max(0, Math.min(1, Math.min(frh / 0.008, rrh / 0.015))) : 1;
    return front * rear * stall / 1.83;
  }

  // 8-speed sequential gearbox. Ratios are overall (gear x final drive), geometric from 1st to 8th,
  // sized so 15 000 rpm in 8th is ~103 m/s with a 0.36 m wheel.
  public static readonly WHEEL_RADIUS = 0.36;
  public static readonly GEAR_RATIOS: readonly number[] = [0, ...Array.from({ length: 8 }, (_, i) => 14 * Math.pow(5.5 / 14, i / 7))];
  public static readonly IDLE_RPM = 4000;
  public static readonly UPSHIFT_RPM = 13500;
  public static readonly DOWNSHIFT_RPM = 7500;
  public static readonly REV_LIMIT = 15000;
  public static readonly SHIFT_CUT = 0.048;      // ignition cut on an upshift, s
  public static readonly SHIFT_COOLDOWN = 0.18;  // minimum time between shifts, s
  public gear = 1;
  public engineRpm = Car.IDLE_RPM;
  private shiftCutTimer = 0;
  private shiftCooldown = 0;

  /** Share of peak ICE power available at an engine speed: turbo spool below ~10 500 rpm, flat above (fuel-flow limited). */
  static icePowerFraction(rpm: number): number {
    const t = Math.max(0, Math.min(1, (rpm - Car.IDLE_RPM) / (10500 - Car.IDLE_RPM)));
    return 0.55 + 0.45 * Math.sin(t * Math.PI / 2);
  }

  /** Automatic shift logic with hysteresis, shift-cut and over-rev protection on downshifts. Returns ICE power fraction (0 while cut). */
  private stepGearbox(forwardSpeed: number, throttle: number, dt: number): number {
    this.shiftCutTimer = Math.max(0, this.shiftCutTimer - dt);
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);
    const wheelRpm = (g: number) => Math.abs(forwardSpeed) / Car.WHEEL_RADIUS * Car.GEAR_RATIOS[g] * 60 / (2 * Math.PI);
    if (this.shiftCooldown <= 0) {
      const rpm = wheelRpm(this.gear);
      if (rpm >= Car.UPSHIFT_RPM && this.gear < 8) {
        this.gear++; this.shiftCutTimer = Car.SHIFT_CUT; this.shiftCooldown = Car.SHIFT_COOLDOWN;
      } else if (this.gear > 1 && (rpm <= Car.DOWNSHIFT_RPM || forwardSpeed < 3) && wheelRpm(this.gear - 1) <= 14200) {
        this.gear--; this.shiftCooldown = Car.SHIFT_COOLDOWN;
      }
    }
    const rpm = wheelRpm(this.gear);
    // Clutch slip keeps the engine in its power band at launch.
    this.engineRpm = this.gear === 1 && rpm < 6000 ? Math.max(rpm, Car.IDLE_RPM + throttle * 4800) : Math.max(Car.IDLE_RPM, Math.min(Car.REV_LIMIT, rpm));
    if (this.shiftCutTimer > 0 || rpm >= Car.REV_LIMIT) return 0;
    return Car.icePowerFraction(this.engineRpm);
  }

  // Tyre thermal / wear model, per axle. Active in training and race; set TYRE_MODEL_IN_TRAINING = false for tyre blankets (optimal, no wear).
  public static TYRE_MODEL_IN_TRAINING = true;
  public static readonly TYRE_OPTIMUM = 100;     // deg C
  public static readonly TYRE_AMBIENT = 25;
  public static readonly TYRE_TRACK = 38;
  public static readonly TYRE_HEAT_CAPACITY = 12000; // J/K per axle (tread + carcass: ~40 s time constant)
  public static TYRE_HEAT_SCALE = 1;             // calibration of slip / hysteresis heating
  public static TYRE_FRONT_HEAT = 1.6;           // fronts work harder per newton (steering, braking)
  public static TYRE_LAT_HEAT = 2;               // cornering slip power weight
  public static TYRE_LONG_HEAT = 0.012;          // creep power as a fraction of |Fx|*v
  public static readonly TYRE_WEAR_RATE = 7e-9;   // wear per joule of friction work
  public tyreTempFront = 85;
  public tyreTempRear = 85;
  public tyreWearFront = 0;
  public tyreWearRear = 0;
  public ersEnergy = Car.ERS_CAPACITY * 0.85;
  private ersHarvestedLap = 0;
  public ersDeploying = false;
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
  private frontLateralInUse = 0;     // N of lateral tyre force used last step (stability reserve)
  private rearLateralInUse = 0;
  public wheelAngle: number = 0;     // Actual road-wheel angle (rad), lagging the steering command
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
  /** Distance (m) from the learned racing line while overtaking/avoiding; the line itself costs no speed. */
  public lineDeviation = 0;
  public lineSearch: LineSearch | null = null;
  /** The line this car really drives; the braking planner reads corner radii from it. Kept across resets. */
  public lineProfile: LineProfile | null = null;
  public pace = new PaceSearch();
  /** The car left the asphalt or touched a barrier by itself during the current lap. */
  public lapExcursion = false;
  public lineSearchSeed = this.id % 5;
  public lineSearchByPressure = new Map<number, LineSearch>();
  /** Learned racing line (sensor-driven network); falls back to `lineSearch` when absent. */
  public lineNet: LineNet | null = null;
  public lineNetByPressure = new Map<number, LineNet>();
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
  public offRoadStillTime = 0;
  /** Continuous time with the car's surface off the asphalt. */
  public offTrackTime = 0;
  public mistakes = new DriverMistakes();
  public mistakesEnabled = true;
  public tireUtilization = 0;
  /** Accumulated impact damage 0..1; at 1 the car is out. Reduces downforce and adds drag until repaired in the pits. */
  public damage = 0;
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
  /** Number of times all four wheels were outside the asphalt (track-limit exits). */
  public trackLimitExits = 0;
  private fullyOffTrack = false;
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
    this.baseBrakingAggression = 1.05 + random() * 0.30; // Pro F1 driving style
    this.brakingAggression = this.baseBrakingAggression;
    this.lapsUntilStyleShift = Math.floor(random() * 3) + 2; // Shifts every 2-4 laps
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
    this.lapPowerFactor = 1.0 + (random() * 0.04 - 0.02);
    this.lapGripFactor = 1.0 + (random() * 0.05 - 0.025);
    this.lapDragFactor = 1.0 + (random() * 0.03 - 0.015);

    // Style shift: driver's style shifts by a few % (+/- 5%) every few laps
    this.lapsUntilStyleShift--;
    if (this.lapsUntilStyleShift <= 0) {
      const shiftPct = (random() * 0.10 - 0.05); // -5% to +5%
      this.brakingAggression = Math.max(0.70, Math.min(1.35, this.baseBrakingAggression * (1.0 + shiftPct)));
      this.lapsUntilStyleShift = Math.floor(random() * 3) + 2;
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
    this.offRoadStillTime = 0;
    this.offTrackTime = 0;
    this.lapExcursion = false;
    this.tireUtilization = 0;
    this.damage = 0;
    this.respawnTimer = 0;
    this.isOutOfFuel = false;
    this.fitness = 0;
    this.peakFitness = 0;
    this.timeAlive = 0;
    this.lapTime = 0;
    this.lineNet?.resetTiming();
    this.currentLap = 0;
    this.currentCheckpointIdx = startCheckpointIdx;
    this.checkpointsCleared = 0;
    this.framesSinceLastCheckpoint = 0;
    this.lateralG = 0;
    this.longitudinalG = 0;
    this.pitchAngle = 0;
    this.rollAngle = 0;
    this.wheelAngle = 0;
    this.frontLateralInUse = this.rearLateralInUse = 0;
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
      this.trackLimitExits = 0;
      this.ersEnergy = Car.ERS_CAPACITY * 0.85;
      this.tyreTempFront = this.tyreTempRear = 85;
      this.tyreWearFront = this.tyreWearRear = 0;
    }
    this.ersHarvestedLap = 0;
    this.gear = 1; this.engineRpm = Car.IDLE_RPM; this.shiftCutTimer = 0; this.shiftCooldown = 0;
    this.fullyOffTrack = false;
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

  /** Grip multiplier of an axle from tyre temperature (asymmetric bell, 0.75..1) and wear (up to -25%). */
  static tyreGrip(temp: number, wear: number): number {
    const d = temp - Car.TYRE_OPTIMUM;
    const thermal = d < 0 ? 0.80 + 0.20 * Math.exp(-(d * d) / (2 * 22 * 22)) : 0.75 + 0.25 * Math.exp(-(d * d) / (2 * 26 * 26));
    return thermal * (1 - 0.25 * Math.pow(Math.max(0, Math.min(1, wear)), 1.4));
  }

  private get tyresActive(): boolean { return this.isRaceMode || Car.TYRE_MODEL_IN_TRAINING; }

  /** Grip the planner can expect from the current tyres (1 on blankets). */
  get tyreGripFront(): number { return this.tyresActive ? Car.tyreGrip(this.tyreTempFront, this.tyreWearFront) : 1; }
  get tyreGripRear(): number { return this.tyresActive ? Car.tyreGrip(this.tyreTempRear, this.tyreWearRear) : 1; }

  /** Heat balance of one axle: slip + hysteresis heating against airflow and track cooling. */
  private stepTyre(temp: number, wear: number, slipPower: number, load: number, speed: number, dt: number): [number, number] {
    const heat = (slipPower + 0.0075 * load * speed) * Car.TYRE_HEAT_SCALE;
    const cooling = 2 * (15 + 3.2 * Math.pow(Math.max(0, speed), 0.8)) * (temp - Car.TYRE_AMBIENT) + 60 * (temp - Car.TYRE_TRACK);
    const next = Math.max(Car.TYRE_AMBIENT, Math.min(180, temp + (heat - cooling) / Car.TYRE_HEAT_CAPACITY * dt));
    const nextWear = Math.min(1, wear + Car.TYRE_WEAR_RATE * Math.pow(temp / 100, 2) * slipPower * dt);
    return [next, nextWear];
  }

  /**
   * Sensor-to-feature pipeline plus a rule-based "expert" controller. The expert is
   * the teacher used to pre-train networks and the guardian that takes over in
   * emergencies; ordinary driving is decided by the neural network.
   */
  planDrive(track: Track, leaderSpeeds?: number[]): DrivePlan {
    // AI pit strategy: request pit stop if fuel reserve is low
    if ((this.fuelKg < 12.0 || (this.tyresActive && Math.max(this.tyreWearFront, this.tyreWearRear) > 0.7)) && !this.isPitting) {
      this.wantsToPit = true;
    }

    const n = track.checkpoints.length;
    if (!this.lineProfile || !this.lineProfile.matches(track)) this.lineProfile = new LineProfile(track.points.length);
    const here = track.sampleSurface(this.pos);
    if (here.surface === 'asphalt' && !this.isPitting && this.recoveryTimer <= 0 && !this.incidentActive && this.speed > 15) {
      this.lineProfile.record(here.index, here.lateral);
    }
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
    let remaining = Math.max(8, Math.min(14, 5 + this.speed * 0.25));
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
    const paceMargin = this.pace.value(this.isRaceMode);
    const safeLatGrip = this.baseTireGrip * Car.GRAVITY * pressure.cornerGrip * paceMargin * Math.min(this.tyreGripFront, this.tyreGripRear);
    // Estimated braking for planning; physical brake forces are unchanged.
    const pushing = this.battlePush.remaining > 0;
    const aBrake = Car.PLANNED_BRAKE_DECEL * this.brakingAggression * pressure.braking * (1 + (paceMargin - 1) * 0.5) * (pushing ? 1.08 : 1);

    let accumulatedDist = 0;
    let prevPos = this.pos;

    for (let k = 0; k <= lookaheadSteps; k++) {
      const cp = track.checkpoints[(this.currentCheckpointIdx + k) % n];
      accumulatedDist += prevPos.dist(cp.center);
      prevPos = cp.center;

      // Radius of the line actually driven through this point, not of the centreline.
      const curK = this.lineProfile.curvature(track, cp.index);
      if (curK > maxUpcomingCurvature) {
        maxUpcomingCurvature = curK;
      }

      if (curK > 0.002) {
        const cornerRadius = 1.0 / curK; // Physical corner radius in meters
        // Conservative corner aero downforce estimated at expected corner speed rather than straightaway speed
        const estimatedCornerSpeed = Math.sqrt(Math.max(25, cornerRadius * safeLatGrip));
        const cornerAeroAcc = (0.5 * this.airDensity * this.downforceCoeff * estimatedCornerSpeed * estimatedCornerSpeed) / this.totalMass;
        const effectiveCornerGrip = safeLatGrip + cornerAeroAcc * 0.65;
        const safeV = Math.sqrt(Math.max(25, cornerRadius * effectiveCornerGrip)) * (pushing ? 1.04 : 1) * (this.lineDeviation > .8 ? .88 : 1);

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
      // Vehicle state: lets the network learn tyre / hybrid / gearbox dependent driving.
      Math.max(0, Math.min(1, (this.tyreTempFront - 60) / 80)),
      Math.max(0, Math.min(1, (this.tyreTempRear - 60) / 80)),
      Math.max(0, Math.min(1, Math.max(this.tyreWearFront, this.tyreWearRear))),
      Math.max(0, Math.min(1, this.ersEnergy / Car.ERS_CAPACITY)),
      this.gear / 8,
      Math.max(0, Math.min(1, (this.engineRpm - Car.IDLE_RPM) / (Car.REV_LIMIT - Car.IDLE_RPM))),
    ];

    const midRay = Math.floor(this.rayDistances.length / 2);
    const leftRayAvg = this.rayDistances.slice(0, midRay).reduce((a, b) => a + b, 0) / Math.max(1, midRay);
    const rightRayAvg = this.rayDistances.slice(midRay + 1).reduce((a, b) => a + b, 0) / Math.max(1, midRay);
    const wallRepulsion = (rightRayAvg - leftRayAvg) * 0.8;

    const lookaheadDistance = Math.max(8, targetPosition.dist(this.pos));
    const pursuitAngle = Math.atan2(2 * this.wheelbase * Math.sin(cpAngleDiff * Math.PI), lookaheadDistance);
    // Yaw-rate feedback: steer toward the yaw rate the pursuit arc needs (catches
    // slides and spins that a purely geometric controller cannot see).
    const desiredYawRate = this.speed * 2 * Math.sin(cpAngleDiff * Math.PI) / lookaheadDistance;
    const yawFeedback = this.speed > 6 ? Math.max(-0.6, Math.min(0.6, Car.YAW_FEEDBACK * (desiredYawRate - this.angularVelocity) / this.maxSteerAngle)) : 0;
    // Steering lock usable at this speed: the kinematic angle for the grip-limited turn
    // plus a slip-angle allowance; more lock only saturates the front axle.
    const gripSteer = Math.min(1, (this.baseTireGrip * Car.GRAVITY * this.wheelbase / Math.max(1, this.speed * this.speed) + 0.14) / this.maxSteerAngle);
    const idealSteer = Math.max(-gripSteer, Math.min(gripSteer, pursuitAngle / this.maxSteerAngle + wallRepulsion * 0.1 + yawFeedback));
    let steer = idealSteer;

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
        // Emergency wall proximity: cut throttle and brake; once nearly stopped creep
        // along the pursuit path instead of waiting in front of the wall forever.
        if (this.speed < 4) { throttle = 0.3; brake = 0; }
        else { throttle = 0.0; brake = 0.40; }
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
      // Soft ground can hold a car at a standstill: push harder the longer it has not moved.
      this.offRoadStillTime = this.speed < 1.5 ? this.offRoadStillTime + 1 / 60 : 0;
      if (this.speed < 4) throttle = Math.min(1, Math.max(throttle, 0.22) + this.offRoadStillTime * 0.4);
      brake = this.speed > 18 ? 0.45 : this.speed > 10 ? 0.15 : 0;
    }
    const expert: CarControl = { steer, throttle, brake };
    return {
      inputs, expert, idealSteer, pushing, offRoad, overspeedDelta, minCenterClearance,
      guarded: offRoad || minCenterClearance <= 0.12 || this.yellowFlag || this.isPitting || this.recoveryTimer > 0,
    };
  }

  /**
   * Neural driving. The network's three outputs are the actual steering, throttle
   * and brake demand. The rule-based expert only overrides inside hard safety
   * envelopes (leaving asphalt, wall proximity, far over the braking plan,
   * steering far from the road) and then becomes the training label.
   */
  getAIControl(track: Track, leaderSpeeds?: number[], _enableLearning: boolean = false): CarControl {
    if (!this.brain || !this.isAlive) {
      const idleCtrl: CarControl = { throttle: 0, brake: 0, steer: 0 };
      this.currentControl = idleCtrl;
      return idleCtrl;
    }
    const plan = this.planDrive(track, leaderSpeeds);
    const driven = decodeDriverOutputs(this.brain.forward(plan.inputs));
    const expert = plan.expert;
    let { steer, throttle, brake } = driven;
    let intervened = false;

    // Steering stays within a corridor around a geometrically valid path.
    const steerLimit = 0.3;
    const clampedSteer = Math.max(plan.idealSteer - steerLimit, Math.min(plan.idealSteer + steerLimit, steer));
    if (clampedSteer !== steer) { steer = clampedSteer; intervened = true; }
    // Pedals are mutually exclusive as on a drive-by-wire car.
    if (brake > 0.02) throttle = 0;
    else brake = 0;
    // A car that is rotating away from the road direction is already losing it: the expert recovers.
    const roadHeading = track.sampleSurface?.(this.pos).tangent.heading();
    const headingError = roadHeading === undefined ? 0 : Math.atan2(Math.sin(this.heading - roadHeading), Math.cos(this.heading - roadHeading));
    const unstable = this.speed > 12 && Math.abs(headingError) > 0.22 && headingError * this.angularVelocity > 0;
    if (plan.guarded || unstable) {
      steer = expert.steer; throttle = expert.throttle; brake = expert.brake; intervened = true;
    } else if (plan.overspeedDelta > 0.2 && brake < expert.brake * 0.8) {
      // Far beyond the planned braking envelope: emergency braking.
      throttle = 0; brake = expert.brake; intervened = true;
    } else if (this.speed < 8 && expert.throttle > 0.15 && throttle < expert.throttle * 0.8) {
      // Launch / crawl assist: a stalled car must never wait for the network to move it.
      throttle = expert.throttle; brake = 0; intervened = true;
    } else if (plan.minCenterClearance < 0.2 && throttle > 0.3) {
      throttle = 0.3; intervened = true;
    }
    if (this.isSkidding) throttle = Math.min(throttle, 0.55);
    const control: CarControl = { steer, throttle, brake };
    this.currentControl = control;

    // Online learning: the network is corrected toward the expert only where the
    // guardian had to intervene (DAgger-style); free driving is left to selection.
    if (_enableLearning && intervened && !plan.offRoad && !this.pressureLearningBlocked && !plan.pushing && !this.incidentActive && this.recoveryTimer <= 0) {
      this.replayStepTimer++;
      this.replayBuffer.push({
        inputs: plan.inputs,
        targets: [plan.idealSteer, expert.throttle, expert.brake],
        reward: this.speedKmh,
      });
      if (this.replayBuffer.length > 50) this.replayBuffer.shift();
      if (this.replayStepTimer % 30 === 0 && this.replayBuffer.length >= 6 && this.brain) {
        for (const sample of this.replayBuffer.slice(-3)) {
          this.brain.train(sample.inputs, encodeDriverTargets(sample.targets), 0.004);
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
    if (this.lineNet) {
      this.lineNetByPressure.set(this.driverPressure, this.lineNet);
      this.lineNet = this.lineNetByPressure.get(next) ?? this.lineNet.fork();
      this.lineNetByPressure.set(next, this.lineNet);
    }
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
    // Throttle and brake are never applied together: any real brake demand lifts the throttle, a token one is dropped.
    if (control.brake > 0.02) control.throttle = 0;
    else control.brake = 0;
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
      this.lapExcursion = true;
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
        this.damage = 0; // nose/wing change during the stop
        this.tyreWearFront = this.tyreWearRear = 0; // fresh, pre-heated set
        this.tyreTempFront = this.tyreTempRear = 85;
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
    let downforceMag = 0.5 * this.airDensity * this.downforceCoeff * (1 - 0.35 * this.damage) * (speedMag * speedMag);
    if (Car.RIDE_HEIGHT_AERO) {
      const follow = 1 - Math.exp(-dt / 0.15);
      this.rideHeightFront += (Math.max(0, Car.FRH_STATIC - 0.45 * downforceMag / Car.AXLE_STIFFNESS_FRONT) - this.rideHeightFront) * follow;
      this.rideHeightRear += (Math.max(0, Car.RRH_STATIC - 0.55 * downforceMag / Car.AXLE_STIFFNESS_REAR) - this.rideHeightRear) * follow;
      this.aeroStall = this.rideHeightFront < 0.008 || this.rideHeightRear < 0.015;
      downforceMag *= Car.rideHeightLift(this.rideHeightFront, this.rideHeightRear);
    }
    const totalNormalLoadZ = gravityForce + downforceMag; // Gravity + Aero Downforce

    // Aerodynamic drag opposes the entire velocity relative to still air.
    const dragMagnitude = 0.5 * this.airDensity * this.dragCoeff * this.lapDragFactor * (1 + 0.15 * this.damage) * speedMag * speedMag;
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
    const frontLimit = mu * this.tyreGripFront * frontLoad;
    const rearLimit = mu * this.tyreGripRear * rearLoad;

    const icePower = this.stepGearbox(forwardSpeed, actualThrottle, dt);
    // Engine braking when off the throttle: compression drag through the current ratio.
    const engineBrakeForce = actualThrottle < 0.02 && control.brake <= 0.02
      ? (45 + 25 * this.engineRpm / Car.REV_LIMIT) * Car.GEAR_RATIOS[this.gear] / Car.WHEEL_RADIUS * Math.min(1, Math.abs(forwardSpeed) / 5) : 0;
    // Rolling resistance and braking share each axle's longitudinal tire budget.
    const rollingFront = Math.min(frontLimit, 0.012 * frontLoad);
    const rollingRear = Math.min(rearLimit, 0.012 * rearLoad + engineBrakeForce);
    // Hybrid power: MGU-K torque fill on a wide-open throttle, harvesting under braking and lift-and-coast.
    let ersPower = 0;
    this.ersDeploying = false;
    const harvestRoom = () => Math.max(0, Car.ERS_LAP_HARVEST - this.ersHarvestedLap);
    const storeEnergy = (joules: number) => {
      const stored = Math.min(joules, harvestRoom(), Car.ERS_CAPACITY - this.ersEnergy);
      this.ersEnergy += Math.max(0, stored);
      this.ersHarvestedLap += Math.max(0, stored);
    };
    if (actualThrottle > 0.65 && forwardSpeed > 0) {
      const soc = this.ersEnergy / Car.ERS_CAPACITY;
      const socScale = Math.max(0, Math.min(1, (soc - Car.ERS_CLIP_SOC) / (Car.ERS_LOW_SOC - Car.ERS_CLIP_SOC)));
      const taper = Math.max(0, Math.min(1, (Car.ERS_TAPER_END - forwardSpeed) / (Car.ERS_TAPER_END - Car.ERS_TAPER_START)));
      if (socScale > 0) {
        const joules = Math.min(Car.ERS_POWER * actualThrottle * taper * socScale * dt, this.ersEnergy);
        ersPower = joules / dt;
        this.ersEnergy -= joules;
        this.ersDeploying = ersPower > 0;
      } else if (forwardSpeed > 30 && harvestRoom() > 0) {
        // Super clipping: part of the ICE output recharges the battery instead of driving the wheels.
        ersPower = -Car.ERS_CLIP_POWER;
        storeEnergy(Car.ERS_CLIP_POWER * Car.ERS_REGEN_EFFICIENCY * dt);
      }
    } else if (actualThrottle >= 0.02 && forwardSpeed > 8 && harvestRoom() > 0) {
      ersPower = -Car.ERS_PART_THROTTLE_CHARGE * actualThrottle;
      storeEnergy(-ersPower * Car.ERS_REGEN_EFFICIENCY * dt);
    }
    const harvesting = !this.ersDeploying && forwardSpeed > 8 && (control.brake > 0.05 || (actualThrottle < 0.02 && forwardSpeed > 30));
    const engineForce = (actualThrottle > 0.005 || ersPower > 0)
      ? Math.max(0, Car.ICE_POWER * actualThrottle * icePower + ersPower) * this.lapPowerFactor / Math.max(12, Math.abs(forwardSpeed)) : 0;
    // Stability priority (traction control / brake-by-wire): each axle keeps the lateral
    // force it was using last step, so power or braking never silently removes the grip
    // that is holding the car on its line. Drive and brake use the rest of the friction circle.
    const longitudinalBudget = (limit: number, lateralInUse: number) => {
      const reserve = Math.min(limit, Car.STABILITY_RESERVE * lateralInUse);
      return Math.sqrt(Math.max(0, limit * limit - reserve * reserve));
    };
    const frontLongLimit = longitudinalBudget(frontLimit, this.frontLateralInUse);
    const rearLongLimit = longitudinalBudget(rearLimit, this.rearLateralInUse);
    const driveForce = Math.min(Math.max(0, rearLongLimit - rollingRear), engineForce);
    const brakeDemand = control.brake * (frontLimit + rearLimit);
    const brakeFront = Math.min(Math.max(0, frontLongLimit - rollingFront), brakeDemand * 0.56);
    const brakeRear = Math.min(Math.max(0, rearLongLimit - rollingRear), brakeDemand * 0.44);
    const vStar = forwardSpeed + (driveForce + dragForward) / currentMass * dt;
    const resistance = brakeFront + brakeRear + rollingFront + rollingRear;
    const resistanceScale = resistance > 0 ? Math.min(1, currentMass * Math.abs(vStar) / (dt * resistance)) : 0;
    const resistanceSign = Math.sign(vStar);
    if (harvesting) {
      // Brake-by-wire blends regen first: the MGU-K recovers up to ERS_HARVEST_POWER, never more than the brakes dissipate.
      const harvestPower = control.brake > 0.05
        ? Math.min(Car.ERS_HARVEST_POWER, (brakeFront + brakeRear) * resistanceScale * forwardSpeed)
        : Car.ERS_POWER * 0.3;
      storeEnergy(harvestPower * Car.ERS_REGEN_EFFICIENCY * dt);
    }
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
    // Steering actuator: the road wheels follow the command with a short lag.
    this.wheelAngle += (control.steer * this.maxSteerAngle - this.wheelAngle) * (1 - Math.exp(-dt / Car.STEERING_LAG));
    const yawPrevious = this.angularVelocity;
    const requestedYaw = this.angularVelocity + (targetYaw - this.angularVelocity) * (1 - Math.exp(-dt / 0.05));
    const turnForce = currentMass * nextForwardSpeed * requestedYaw;
    // Turning and slide correction act in the SAME axis and must be summed algebraically.
    const slideForce = -currentMass * lateralSpeed * Math.min(12, 1 / dt);
    const requestedLateral = turnForce + slideForce;
    const kinematicLateral = Math.max(-lateralLimit, Math.min(lateralLimit, requestedLateral));
    const yawLimit = Math.abs(nextForwardSpeed) > 0.001 ? lateralLimit / (currentMass * Math.abs(nextForwardSpeed)) : 0;
    const kinematicYaw = Math.max(-yawLimit, Math.min(yawLimit, requestedYaw));

    // Dynamic single-track model: slip angles -> saturating axle forces -> yaw
    // torque on a rigid body with yaw inertia. Below ~10 m/s slip angles become
    // ill-conditioned, so the kinematic response above takes over smoothly.
    const dynamicWeight = Car.DYNAMIC_YAW && nextForwardSpeed > 0 ? Math.max(0, Math.min(1, (nextForwardSpeed - 8) / 8)) : 0;
    let lateralForce = kinematicLateral;
    let slipRatio = Math.abs(requestedLateral) > 0 ? Math.max(0, 1 - lateralLimit / Math.abs(requestedLateral)) : 0;
    let frontSlip = slipRatio, rearSlip = slipRatio;
    let dynamicFrontForce = 0, dynamicRearForce = 0;
    let frontSlipPower = 0, rearSlipPower = 0;
    this.angularVelocity = kinematicYaw;
    if (dynamicWeight > 0) {
      const toRear = this.wheelbase * 0.46, toFront = this.wheelbase - toRear; // CoG to axles
      const u = Math.max(1, nextForwardSpeed);
      const wheelAngle = this.wheelAngle;
      const alphaFront = wheelAngle - Math.atan2(lateralSpeed + toFront * yawPrevious, u);
      const alphaRear = -Math.atan2(lateralSpeed - toRear * yawPrevious, u);
      const axleForce = (alpha: number, load: number, limit: number) => {
        if (limit <= 1) return 0;
        if (!Car.PACEJKA) return limit * Math.tanh(Car.CORNERING_STIFFNESS * load * alpha / limit);
        const B = 1 / (Car.MF_C * Car.MF_ALPHA_PEAK), Bx = B * alpha;
        return limit * Math.sin(Car.MF_C * Math.atan(Bx - Car.MF_E * (Bx - Math.atan(Bx))));
      };
      const frontForce = axleForce(alphaFront, frontLoad, frontLateral * Car.FRONT_GRIP_BIAS);
      const rearForce = axleForce(alphaRear, rearLoad, rearLateral);
      const yawInertia = currentMass * Car.YAW_INERTIA_FACTOR;
      const yawAcceleration = (toFront * frontForce - toRear * rearForce) / yawInertia;
      dynamicFrontForce = frontForce; dynamicRearForce = rearForce;
      frontSlipPower = Car.TYRE_LAT_HEAT * Math.abs(frontForce * u * Math.tan(alphaFront));
      rearSlipPower = Car.TYRE_LAT_HEAT * Math.abs(rearForce * u * Math.tan(alphaRear));
      const dynamicYaw = Math.max(-3.5, Math.min(3.5, yawPrevious + yawAcceleration * dt));
      const dynamicLateral = frontForce + rearForce;
      lateralForce = kinematicLateral * (1 - dynamicWeight) + dynamicLateral * dynamicWeight;
      this.angularVelocity = kinematicYaw * (1 - dynamicWeight) + dynamicYaw * dynamicWeight;
      const demand = (alpha: number, load: number, limit: number) => limit > 1 ? Math.max(0, 1 - limit / Math.max(1e-6, Car.CORNERING_STIFFNESS * load * Math.abs(alpha))) : 0;
      const dynFront = demand(alphaFront, frontLoad, frontLateral * Car.FRONT_GRIP_BIAS), dynRear = demand(alphaRear, rearLoad, rearLateral);
      // Slip is only meaningful from the slip-angle model; the kinematic request mixes in slide damping.
      frontSlip = dynFront; rearSlip = dynRear;
      slipRatio = Math.max(frontSlip, rearSlip);
    }
    if (dynamicWeight > 0) { this.frontLateralInUse = Math.abs(dynamicFrontForce); this.rearLateralInUse = Math.abs(dynamicRearForce); }
    else { const share = frontLoad / Math.max(1, frontLoad + rearLoad); this.frontLateralInUse = Math.abs(lateralForce) * share; this.rearLateralInUse = Math.abs(lateralForce) * (1 - share); }
    // Longitudinal creep heats the driven / braked axles too.
    frontSlipPower += Car.TYRE_LONG_HEAT * Math.abs(frontFx) * speedMag;
    rearSlipPower += Car.TYRE_LONG_HEAT * Math.abs(rearFx) * speedMag;
    if (this.tyresActive) {
      [this.tyreTempFront, this.tyreWearFront] = this.stepTyre(this.tyreTempFront, this.tyreWearFront, frontSlipPower * Car.TYRE_FRONT_HEAT, frontLoad, speedMag, dt);
      [this.tyreTempRear, this.tyreWearRear] = this.stepTyre(this.tyreTempRear, this.tyreWearRear, rearSlipPower, rearLoad, speedMag, dt);
    } else {
      this.tyreTempFront = this.tyreTempRear = Car.TYRE_OPTIMUM;
      this.tyreWearFront = this.tyreWearRear = 0;
    }
    this.tireUtilization = Math.min(1, Math.hypot(frontFx + rearFx, lateralForce) / Math.max(1, frontLimit + rearLimit));
    this.isSkidding = slipRatio > 0.01 || (Math.abs(lateralSpeed) > 4.5 && speedMag > 18);
    this.understeerSlip = frontSlip >= rearSlip ? slipRatio : 0;
    this.oversteerSlip = this.understeerSlip > 0 ? 0 : slipRatio;

    if (!this.lapCompromised && this.safeBrainPressure === this.driverPressure && this.isRaceMode && this.safeBrainBackup && this.brain && this.isSkidding && (this.oversteerSlip > 0.45 || Math.abs(this.angularVelocity) > 3.2)) {
      this.brain = this.safeBrainBackup.clone();
      this.replayBuffer = [];
    }
    if (this.isSkidding && random() < 0.28) {
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
      if (inwardSpeed < 0) {
        // Contact impulse: the wall removes the normal momentum and scrubs
        // tangential speed in proportion (Coulomb friction), so a graze costs a
        // little speed while a hard hit sheds a lot. No per-step blanket damping.
        this.vel.subMut(hit.normal.mul(inwardSpeed * 1.1));
        const tangential = this.vel.sub(hit.normal.mul(this.vel.dot(hit.normal)));
        const tangentialSpeed = tangential.mag();
        if (tangentialSpeed > 1e-6) this.vel.subMut(tangential.mul(Math.min(tangentialSpeed, 0.35 * Math.abs(inwardSpeed) * 1.1) / tangentialSpeed));
        // Off-centre impact twists the car: lateral offset of the body relative to the wall.
        const lever = Math.sign(this.vel.cross(hit.normal) || 1);
        this.angularVelocity = this.angularVelocity * 0.5 + lever * Math.min(1.2, this.barrierImpactSpeed * 0.06);
        this.damage += (this.barrierImpactSpeed / Car.CRASH_CLOSING_SPEED) ** 2;
      }
      if (this.barrierImpactSpeed >= Car.CRASH_CLOSING_SPEED || this.damage >= 1) {
        this.eliminate('barrier', 0.45, true);
        return null;
      }
      this.pos.addMut(hit.normal.mul(0.03));
      this.lapCompromised = true;
      this.lapExcursion = true;
      this.recoveryTimer = 2;
      this.replayBuffer = [];
      const collisionAcceleration = this.vel.sub(previousVelocity).div(dt);
      this.longitudinalG = collisionAcceleration.dot(forwardDir) / Car.GRAVITY;
      this.lateralG = collisionAcceleration.dot(rightDir) / Car.GRAVITY;
    } else this.pos = proposedPosition;
    this.updateSurface(track);
    const fullyOff = this.surfaceFractions.asphalt === 0;
    if (fullyOff && !this.fullyOffTrack) this.trackLimitExits++;
    this.fullyOffTrack = fullyOff;
    this.offTrackTime = this.surface !== 'asphalt' ? this.offTrackTime + dt : 0;
    if (this.surfaceFractions.asphalt < 1) { this.lapCompromised = true; this.lapExcursion = true; this.recoveryTimer = 2; }
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

    // Leaving the asphalt is never rewarded: it costs fitness for as long as any wheel is outside.
    if (this.surfaceFractions.asphalt < 1) {
      this.fitness = Math.max(0, this.fitness - (80 + this.speed * 5) * (1 - this.surfaceFractions.asphalt * 0.5) * dt);
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

  /** Dead car: slides to rest under gravel/skid deceleration, stopped by fences. */
  coastWreck(dt: number, track: Track): void {
    if (this.isAlive || this.speed < 0.05 || !Number.isFinite(dt) || dt <= 0) return;
    const decel = 12;
    const speed = Math.max(0, this.speed - decel * dt);
    this.vel.mulMut(speed / this.speed);
    this.angularVelocity *= Math.max(0, 1 - 3 * dt);
    const next = this.pos.add(this.vel.mul(dt));
    const nextHeading = this.heading + this.angularVelocity * dt;
    const hit = track.sweepBarrier?.(this.pos, next, this.heading, nextHeading);
    if (hit) {
      this.pos = Vector2.lerp(this.pos, next, hit.fraction);
      this.vel.set(0, 0);
    } else { this.pos = next; this.heading = nextHeading; }
    this.prevPos.set(this.pos.x, this.pos.y);
    this.speed = this.vel.mag();
    this.speedKmh = this.speed * 3.6;
    if (this.speed < 0.05) { this.vel.set(0, 0); this.speed = this.speedKmh = 0; }
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

  private eliminate(reason: 'barrier', penalty: number, keepMomentum = false): void {
    this.eliminationReason = reason;
    this.isAlive = false;
    this.effectiveThrottle = 0;
    this.lateralG = this.longitudinalG = 0;
    // A wrecked car keeps its remaining momentum and slides to rest (see coastWreck).
    if (keepMomentum) { this.vel.mulMut(0.7); this.speed = this.vel.mag(); this.speedKmh = this.speed * 3.6; }
    else { this.vel.set(0, 0); this.speed = this.speedKmh = 0; }
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

    // A car that cannot rejoin the asphalt within OFF_TRACK_RECOVERY_TIME is retired instead of idling for half a minute.
    if (this.framesSinceLastCheckpoint > (this.recoveryTimer > 0 ? 1800 : 600) || (!this.isManual && this.offTrackTime > Car.OFF_TRACK_RECOVERY_TIME)) {
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

      // Base checkpoint reward; a gate taken with a wheel off the asphalt earns nothing and costs fitness
      const onAsphalt = this.surfaceFractions.asphalt >= 1;
      if (onAsphalt) this.fitness += 1200;
      else this.fitness = Math.max(0, this.fitness - 600);

      // Clean checkpoint bonus: grip and stability count, the lateral position does not, so the
      // whole width of the asphalt is free for the racing line.
      if (isClean && onAsphalt) {
        this.fitness += 1000;
      } else if (this.isSkidding) {
        // Slid through checkpoint sideways / out of control
        this.fitness = Math.max(0, this.fitness - 200);
      }

      // Point 2: Apex Clipping and Exit Speed Rewards
      if (Math.abs(nextCp.curvature) > 0.003) {
        const innerCurb = nextCp.curvature > 0 ? nextCp.p1 : nextCp.p2;
        const distToInner = this.pos.dist(innerCurb);
        if (distToInner < track.width * 0.35 && isClean && onAsphalt) {
          // Apex clipped cleanly!
          this.fitness += 800;
        }
      } else if (clearedCpIdx > 0) {
        const prevCp = track.checkpoints[(clearedCpIdx - 1 + cpCount) % cpCount];
        if (Math.abs(prevCp.curvature) > 0.003 && this.speed > 22 && isClean && onAsphalt) {
          // High speed corner exit acceleration reward!
          this.fitness += 600 + Math.round(this.speedKmh * 2);
        }
      }

      this.framesSinceLastCheckpoint = 0;
      this.currentCheckpointIdx = (clearedCpIdx + 1) % cpCount;
      this.lineNet?.passPoint(clearedCpIdx, cpCount, this.lapTime);

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
        this.ersHarvestedLap = 0;
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
          if (!this.isManual) this.pace.finishLap(finishedLapTime, !compromised, this.lapExcursion);
          this.lapExcursion = false;
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
