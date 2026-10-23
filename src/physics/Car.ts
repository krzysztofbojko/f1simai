import { random } from '../math/Random';
import { normalizePressure, pressureProfile } from '../ai/DriverPressure';
import { PaceSearch } from '../ai/PaceSearch';
import { LineSearch } from '../ai/LineSearch';
import { LineProfile } from '../ai/LineProfile';
import type { LineNet } from '../ai/LineNet';
import { Vector2, IntersectionResult } from '../math/Vector2';
import { BattlePush } from '../ai/BattlePush';
import { DriverMistakes } from '../ai/DriverMistakes';
import { Track, type SurfaceType } from '../track/Track';
import { getRacingLine, RacingLine } from '../track/RacingLine';
import { COMPOUND_SPECS, compoundGrip, isSlick, weatherCompound, type TyreCompound } from './Tyres';
import { checkTrackProgress } from './LapTiming';
import { scoreStep } from './Fitness';
import { pitCompound, servicePitStop } from './PitStrategy';
import { planDrive } from './DrivePlanner';

import { createSimConfig, type SimConfig } from './SimConfig';
export { DEFAULT_STRESS_LAP_SHARE, clampStressShare } from './SimConfig';
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
  /** Time of the sector that ends at this gate (null when the lap was not timed from its start). */
  sectorTime: number | null;
  isPurple?: boolean;   // session best sector
}

/** A timed sector, left in `Car.sectorEvent` for the session to read in the same step. */
export interface SectorEvent {
  gateIndex: number;
  sectorTime: number;
  splitTime: number;
  /** A flying lap without an excursion beyond the track limits (and not a training stress lap). */
  valid: boolean;
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
  /** Fuel burnt over the lap, kg. */
  fuelUsed?: number;
}

/** LiDAR rays + 5 driving inputs + 8 vehicle-state inputs (tyre temps, wear, ERS, gear, rpm, ride height F/R). */
export const DRIVER_EXTRA_INPUTS = 13;
export const driverInputCount = (rayCount: number): number => rayCount + DRIVER_EXTRA_INPUTS;

export interface DrivePlan {
  inputs: number[];
  expert: CarControl;
  idealSteer: number;
  pushing: boolean;
  offRoad: boolean;
  overspeedDelta: number;
  /** Forward clearance in units of the track width, scaled so 1 ≈ RAY_MAX_DIST / CLEARANCE_REF_WIDTH widths. */
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

/** Numbers kept per body during a LiDAR scan: heading cos/sin, half width, ray origin relative to it, bounding radius. */
const SCAN_FRAME = 6;

/**
 * Entry distance of a ray into an oriented 5.5 m body (heading `fx, fy`, half width `half`), the
 * ray starting at `ox, oy` relative to the body with unit direction `dx, dy`; Infinity if it misses
 * within `maxDist` or starts inside.
 */
function slabEntry(fx: number, fy: number, half: number, ox: number, oy: number, dx: number, dy: number, maxDist: number): number {
  // Slabs of the oriented box: along the heading (half length 2.75 m) and across it (half width).
  let enter = 0, leave = maxDist;
  for (let axis = 0; axis < 2; axis++) {
    const o = axis ? oy * fx - ox * fy : ox * fx + oy * fy;
    const d = axis ? dy * fx - dx * fy : dx * fx + dy * fy;
    const extent = axis ? half : 2.75;
    if (Math.abs(d) < 1e-9) { if (Math.abs(o) > extent) return Infinity; continue; }
    const t1 = (-extent - o) / d, t2 = (extent - o) / d;
    enter = Math.max(enter, Math.min(t1, t2));
    leave = Math.min(leave, Math.max(t1, t2));
    if (enter > leave) return Infinity;
  }
  return enter > 0 ? enter : Infinity;
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
  /** Steering actuator (driver's hands and rack): first-order lag of the road wheels behind the command. */
  public static readonly STEERING_LAG: number = 0.09; // s
  /** The front axle saturates slightly before the rear: a stable, understeer-biased balance at the limit. */
  public static readonly FRONT_GRIP_BIAS: number = 1.0;
  /** Fraction of the lateral force in use that drive/brake may not take from the friction circle. */
  public static readonly STABILITY_RESERVE: number = 1.1;
  public static readonly YAW_FEEDBACK: number = 0.1;
  /** Slip demand above which the car counts as sliding rather than working the tyres at their limit. */
  public static readonly SLIDE_SLIP: number = 0.38;
  /** Tyre cornering stiffness in N per N of vertical load per radian of slip angle. */
  public static readonly CORNERING_STIFFNESS: number = 22;
  /** Yaw inertia in kg·m² per kg of total mass (≈1170 kg·m² for a 900 kg car). */
  public static readonly YAW_INERTIA_FACTOR: number = 1.3;
  /**
   * Tyre load sensitivity across an axle: each wheel's friction scales as (Fz/Fz_mean)^-k, so the
   * loaded outer wheel gains less grip than the inner one loses. With no roll the axle keeps μ·Fz,
   * so grip against speed stays as calibrated.
   */
  public static LOAD_SENSITIVITY_EXP = 0.12;

  /** Load-equivalent grip of an axle (μ·this = its friction limit) with `transfer` moved to the outer wheel. */
  static axleGripLoad(axleLoad: number, transfer: number): number {
    const mean = axleLoad / 2;
    if (mean <= 0) return 0;
    const shift = Math.min(mean, Math.abs(transfer));
    const k = 1 - Car.LOAD_SENSITIVITY_EXP;
    return mean * (((mean - shift) / mean) ** k + ((mean + shift) / mean) ** k);
  }

  /**
   * Drag and downforce multipliers from the aerodynamic wake of the cars ahead
   * (Traffic.computeWake), refreshed every step, the same in training and the race: a tow cuts
   * drag, dirty air cuts downforce, the front wing most (1 = clean air).
   */
  public wakeDrag = 1;
  public wakeDownforce = 1;

  /**
   * Planner grip budget at driver pressure 0: shares of the tyre friction (with downforce) the
   * expert plans to use in corners and under braking. Downforce is counted at the planned speed,
   * derated for ride height and set-up losses.
   */
  public static PLAN_CORNER_GRIP = 0.55;
  public static PLAN_BRAKE_GRIP = 0.40;
  public static PLAN_AERO_SHARE = 0.90;
  /**
   * Live push: while the tyres have grip to spare (low utilisation, no slide, cool enough, room to
   * the outside edge) the corner the car is in may be taken up to this share faster than planned.
   */
  public static PLAN_PUSH_MAX = 0.12;
  public static readonly PUSH_UTILISATION_FREE = 0.55;
  public static readonly PUSH_UTILISATION_FULL = 0.85;
  public static PUSH_TYRE_MAX_TEMP = 125;
  public static readonly PUSH_EDGE_ROOM = 2;
  public static readonly PUSH_RISE_TIME = 0.6;
  /** Corners the plan could take faster than this are treated as flat out. */
  public static readonly PLAN_MAX_SPEED = 110;
  /** Hairpins (radius under 20 m) are braked for at their entry rather than at the apex sample. */
  public static readonly PLAN_HAIRPIN_CURVATURE = 0.05;
  /**
   * Pedal actuators (first-order lags, s): brake pressure builds and bleeds off, engine torque
   * follows the throttle. A demand that flickers between frames reaches the tyres as a smooth force.
   */
  public static readonly BRAKE_APPLY_TAU = 0.06;
  /** Share of the planned deceleration at which the expert starts squeezing the brake (ramps to the full demand at 1). */
  public static readonly BRAKE_ONSET = 0.9;
  public static readonly BRAKE_RELEASE_TAU = 0.1;
  public static readonly THROTTLE_TAU = 0.08;

  // Simulation mass and fuel parameters
  public static readonly BASE_DRY_MASS: number = 798; // kg
  public static readonly MAX_FUEL_CAPACITY: number = 110; // kg (simulation tank capacity)
  /**
   * Fuel flow at full power, kg/s: the 100 kg/h limit of the rules. The flow follows the power the
   * engine makes (throttle and the rpm power curve); a 300 km race needs about 100 kg.
   */
  public static readonly FUEL_FLOW_MAX = 100 / 3600;
  /** Fuel flow at idle and on the overrun, kg/s. */
  public static readonly FUEL_FLOW_IDLE = 0.0006;
  public fuelKg: number = 105.0; // kg (realistic race fuel load)
  public fuelBurnRatePerSec: number = 0; // kg/s
  public totalFuelConsumed: number = 0; // kg
  /** Fuel in the tank when the current lap started (fuel used per lap, for race fuel planning). */
  public lapStartFuel: number = 105.0;

  // Physical specifications (F1 Dimensions & Weights)
  public length: number = 5.5; // Physical and rendered length (m)
  public width: number = 1.9; // Physical and rendered width (m), 2026 regulations

  public static getDimensionsForTrackWidth(trackWidthMeters: number): { width: number; length: number; effectiveTrackWidth: number } {
    // The rendered body matches the collision body, including at high zoom.
    const effectiveTrackWidth = Math.max(5, Math.min(20, trackWidthMeters));
    const width = 1.9;
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
  /** Gates (about 18 m apart) a car rejoining the asphalt may have passed off the road; see checkTrackProgress. */
  public static readonly MAX_REJOIN_SKIPPED_GATES = 8;
  /**
   * Quasi-static ride-height aero: downforce compresses the axles, the floor works best at a
   * particular height and chokes when it gets too close to the road. Ride height follows with a lag
   * so the stall threshold cannot chatter from step to step.
   */
  public static readonly FRH_STATIC = 0.030;
  public static readonly RRH_STATIC = 0.055;
  public static readonly AXLE_STIFFNESS_FRONT = 380000; // 2 x 145 kN/m springs + 90 kN/m heave element
  public static readonly AXLE_STIFFNESS_REAR = 305000;  // 2 x 115 kN/m + 75 kN/m
  public rideHeightFront = Car.FRH_STATIC;
  public rideHeightRear = Car.RRH_STATIC;
  public aeroStall = false;

  /**
   * Dynamic suspension: the sprung mass heaves and pitches on the axle springs and asymmetric
   * dampers, driven by front/rear downforce and the elastic share of longitudinal load transfer.
   * Ride height follows from the body motion, and the tyre loads from the suspension forces (body
   * motion delays the transfer).
   *
   * Body roll on the corner springs and anti-roll bars: each axle's roll stiffness and damping set
   * its share of the lateral load transfer, transients included.
   */
  /** Corner (wheel-rate) springs, N/m; the axle heave stiffness adds a third element on top. */
  public static readonly CORNER_SPRING_FRONT = 145000;
  public static readonly CORNER_SPRING_REAR = 115000;
  /** Anti-roll bars, N/m at the wheel: sized so the front takes ~52% of the steady transfer, as before. */
  public static ARB_FRONT = 45000;
  public static ARB_REAR = 46500;
  /** Roll inertia in kg·m² per kg of sprung mass, and the roll damping ratio. */
  public static readonly ROLL_INERTIA_FACTOR = 0.42;
  public static ROLL_DAMPING_ZETA = 0.6;
  /**
   * Plank (skid block) contact: below zero ride height the floor meets the road through a stiff,
   * damped contact; it carries load the tyres no longer get and drags with titanium-on-asphalt friction.
   */
  public static readonly PLANK_STIFFNESS = 3_500_000; // N/m
  public static readonly PLANK_DAMPING = 85000;       // N·s/m
  public static readonly PLANK_FRICTION = 0.32;
  /** Road roughness amplitude off the asphalt, m (bumps of a few metres' wavelength). */
  public static readonly GRASS_ROUGHNESS = 0.006;
  public static readonly GRAVEL_ROUGHNESS = 0.014;
  public static readonly SPRUNG_MASS_SHARE = 0.85;
  /** Pitch inertia in kg·m² per kg of sprung mass. */
  public static readonly PITCH_INERTIA_FACTOR = 1.85;
  /** Damping ratios of the axle dampers: bump (compression) and rebound. */
  public static DAMPER_BUMP_ZETA = 0.5;
  public static DAMPER_REBOUND_ZETA = 0.7;
  /** Share of longitudinal transfer taken by suspension geometry instead of the springs. */
  public static ANTI_DIVE = 0.5;
  public static ANTI_SQUAT = 0.3;
  /** The floor's flow follows its height with this lag, so the stall threshold cannot chatter. */
  public static readonly FLOOR_FLOW_LAG = 0.05;
  /** Suspension sub-step, s. */
  public static readonly SUSPENSION_SUBSTEP = 1 / 240;
  /** Body heave (m, + = compressed), pitch (rad, + = nose down) and their rates. */
  public heave = 0;
  public heaveRate = 0;
  public pitch = 0;
  public pitchRate = 0;
  /** Body roll (rad, same sign as lateralG) and its rate. */
  public roll = 0;
  public rollRate = 0;
  /** Floor contact force of the last suspension step, N (front + rear). */
  public plankForce = 0;
  /** Road surface height under each axle, m (+ = raised, pushes the car up). */
  public roadFront = 0;
  public roadRear = 0;
  private roadTargetFront = 0;
  private roadTargetRear = 0;
  /** Lateral load transfer of each axle from the last suspension step, N (+ = to the outer wheel). */
  public rollTransferFront = 0;
  public rollTransferRear = 0;
  /** Spring + damper force of each axle on the body, N (+ = holding the body up). */
  public suspensionForceFront = 0;
  public suspensionForceRear = 0;
  /** Ride height the floor's airflow currently sees, m. */
  public floorHeightFront = Car.FRH_STATIC;
  public floorHeightRear = Car.RRH_STATIC;

  resetSuspension(): void {
    this.heave = this.heaveRate = this.pitch = this.pitchRate = this.roll = this.rollRate = 0;
    this.rollTransferFront = this.rollTransferRear = 0;
    this.plankForce = this.roadFront = this.roadRear = this.roadTargetFront = this.roadTargetRear = 0;
    this.suspensionForceFront = this.suspensionForceRear = 0;
    this.rideHeightFront = this.floorHeightFront = Car.FRH_STATIC;
    this.rideHeightRear = this.floorHeightRear = Car.RRH_STATIC;
    this.aeroStall = false;
    this.floorStall = this.porpoisingHz = this.bounceWindow = this.bounceCrossings = this.lastHeaveRate = 0;
    this.bounceMin = Infinity; this.bounceMax = -Infinity;
  }

  /** Roll stiffness of each axle, N·m/rad: corner springs plus anti-roll bar over the track width. */
  get rollStiffnessFront(): number { return (Car.CORNER_SPRING_FRONT / 2 + Car.ARB_FRONT) * this.trackWidthMeters ** 2; }
  get rollStiffnessRear(): number { return (Car.CORNER_SPRING_REAR / 2 + Car.ARB_REAR) * this.trackWidthMeters ** 2; }

  /**
   * Heave, pitch and roll of the sprung mass over one step, semi-implicit Euler in sub-steps.
   * `downFront/downRear` are the aero loads on each axle, `ax`/`ay` the body accelerations (m/s²).
   */
  stepSuspension(dt: number, downFront: number, downRear: number, ax: number, ay = 0): void {
    const ms = this.totalMass * Car.SPRUNG_MASS_SHARE, pitchInertia = ms * Car.PITCH_INERTIA_FACTOR;
    const a = this.wheelbase * 0.54, b = this.wheelbase * 0.46; // CoG to front / rear axle
    const kf = Car.AXLE_STIFFNESS_FRONT, kr = Car.AXLE_STIFFNESS_REAR;
    const critF = 2 * Math.sqrt(kf * ms * 0.46), critR = 2 * Math.sqrt(kr * ms * 0.54);
    const damper = (rate: number, critical: number) => rate * critical * (rate > 0 ? Car.DAMPER_BUMP_ZETA : Car.DAMPER_REBOUND_ZETA);
    // Elastic share of the transfer: the rest goes straight through the wishbones (anti-dive / anti-squat).
    const pitchMoment = -ms * ax * this.cogHeight * (1 - (ax < 0 ? Car.ANTI_DIVE : Car.ANTI_SQUAT));
    const steps = Math.max(1, Math.ceil(dt / Car.SUSPENSION_SUBSTEP - 1e-9)), h = dt / steps;
    // Roll: the sprung mass's lateral inertia at CoG height against both axles' roll springs;
    // damping is shared like the heave dampers, so a transient loads the axles differently.
    const kRollF = this.rollStiffnessFront, kRollR = this.rollStiffnessRear, rollInertia = ms * Car.ROLL_INERTIA_FACTOR;
    const cRoll = 2 * Car.ROLL_DAMPING_ZETA * Math.sqrt((kRollF + kRollR) * rollInertia);
    const cRollF = cRoll * critF / (critF + critR), cRollR = cRoll - cRollF;
    const rollMoment = ms * ay * this.cogHeight;
    // Off-road bumps: a new bump height under each axle every ~2.5 m of travel, the road easing towards it.
    const roughness = this.surfaceFractions.grass * Car.GRASS_ROUGHNESS + this.surfaceFractions.gravel * Car.GRAVEL_ROUGHNESS;
    const roadPrevFront = this.roadFront, roadPrevRear = this.roadRear;
    if (roughness > 0 || this.roadFront !== 0 || this.roadRear !== 0) {
      const travel = dt * Math.max(1, this.speed) / 2.5;
      if (roughness === 0) this.roadTargetFront = this.roadTargetRear = 0;
      else {
        if (random() < travel) this.roadTargetFront = roughness * (2 * random() - 1);
        if (random() < travel) this.roadTargetRear = roughness * (2 * random() - 1);
      }
      const follow = 1 - Math.exp(-4 * travel);
      this.roadFront += (this.roadTargetFront - this.roadFront) * follow;
      this.roadRear += (this.roadTargetRear - this.roadRear) * follow;
      if (roughness === 0 && Math.abs(this.roadFront) + Math.abs(this.roadRear) < 1e-5) this.roadFront = this.roadRear = 0;
    }
    const roadRateFront = (this.roadFront - roadPrevFront) / dt, roadRateRear = (this.roadRear - roadPrevRear) / dt;
    const plank = (gap: number, closing: number) => gap >= 0 ? 0
      : Math.max(0, Car.PLANK_STIFFNESS * -gap + Car.PLANK_DAMPING * Math.max(0, closing));
    let ff = 0, fr = 0, pf = 0, pr = 0;
    for (let i = 0; i < steps; i++) {
      this.rollRate += (rollMoment - (kRollF + kRollR) * this.roll - cRoll * this.rollRate) / rollInertia * h;
      this.roll += this.rollRate * h;
      const roadF = roadPrevFront + roadRateFront * (i + 1) * h, roadR = roadPrevRear + roadRateRear * (i + 1) * h;
      // Spring compression counts the body sinking and the road rising under the wheels.
      const xf = this.heave + a * this.pitch + roadF, xr = this.heave - b * this.pitch + roadR;
      const vf = this.heaveRate + a * this.pitchRate + roadRateFront, vr = this.heaveRate - b * this.pitchRate + roadRateRear;
      ff = kf * xf + damper(vf, critF);
      fr = kr * xr + damper(vr, critR);
      pf = plank(Car.FRH_STATIC - xf, vf);
      pr = plank(Car.RRH_STATIC - xr, vr);
      this.heaveRate += (downFront + downRear - ff - fr - pf - pr) / ms * h;
      this.pitchRate += (a * (downFront - ff - pf) - b * (downRear - fr - pr) + pitchMoment) / pitchInertia * h;
      this.heave += this.heaveRate * h;
      this.pitch += this.pitchRate * h;
    }
    this.suspensionForceFront = ff;
    this.suspensionForceRear = fr;
    this.plankForce = pf + pr;
    // Elastic transfer through each axle's roll springs and dampers; the unsprung mass transfers directly.
    const unsprung = (this.totalMass - ms) * ay * this.cogHeight / this.trackWidthMeters;
    this.rollTransferFront = (kRollF * this.roll + cRollF * this.rollRate) / this.trackWidthMeters + unsprung * 0.46;
    this.rollTransferRear = (kRollR * this.roll + cRollR * this.rollRate) / this.trackWidthMeters + unsprung * 0.54;
    this.rideHeightFront = Car.FRH_STATIC - (this.heave + a * this.pitch + this.roadFront);
    this.rideHeightRear = Car.RRH_STATIC - (this.heave - b * this.pitch + this.roadRear);
    // Bounce frequency: heave-rate reversals over 1 s windows, reported when the body moves > 2 mm.
    if ((this.heaveRate > 0) !== (this.lastHeaveRate > 0)) this.bounceCrossings++;
    this.lastHeaveRate = this.heaveRate;
    this.bounceMin = Math.min(this.bounceMin, this.heave);
    this.bounceMax = Math.max(this.bounceMax, this.heave);
    this.bounceWindow += dt;
    if (this.bounceWindow >= 1) {
      this.porpoisingHz = this.bounceMax - this.bounceMin > 0.002 ? this.bounceCrossings / 2 / this.bounceWindow : 0;
      this.bounceWindow = this.bounceCrossings = 0;
      this.bounceMin = Infinity; this.bounceMax = -Infinity;
    }
    const flow = 1 - Math.exp(-dt / Car.FLOOR_FLOW_LAG);
    this.floorHeightFront += (Math.max(0, this.rideHeightFront) - this.floorHeightFront) * flow;
    this.floorHeightRear += (Math.max(0, this.rideHeightRear) - this.floorHeightRear) * flow;
  }

  /**
   * Lift-coefficient multiplier from front/rear ride height, normalised to 1 at a typical cornering height.
   * `stall` overrides the floor's choke factor (1 = attached flow, 0.75 = fully stalled).
   */
  static rideHeightLift(frh: number, rrh: number, stall?: number): number {
    const front = 1 + 0.35 * Math.exp(-(((frh - 0.016) / 0.018) ** 2));
    const rear = 1 + 0.45 * (rrh / 0.035) * Math.exp(1 - rrh / 0.035);
    stall ??= frh < 0.008 || rrh < 0.015 ? 0.75 + 0.25 * Math.max(0, Math.min(1, Math.min(frh / 0.008, rrh / 0.015))) : 1;
    return front * rear * stall / 1.83;
  }

  /**
   * Porpoising: the floor's flow stalls below 8/15 mm and only reattaches above 12/19 mm, each change
   * developing over FLOOR_FLOW_LAG. With the sprung mass bouncing on its springs this hysteresis
   * sustains a 3–10 Hz limit cycle near the stall height, the same in training and the race.
   */
  /** Downforce lost when the floor flow is fully stalled in the porpoising model (a choked diffuser). */
  public static PORPOISING_STALL_LOSS = 0.4;
  /** Stalled share of the floor flow, 0..1. */
  public floorStall = 0;
  /** Measured body bounce frequency while porpoising, Hz (0 = none). */
  public porpoisingHz = 0;
  private bounceWindow = 0;
  private bounceCrossings = 0;
  private bounceMin = Infinity;
  private bounceMax = -Infinity;
  private lastHeaveRate = 0;

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

  // Tyre thermal / wear model, per axle, the same in training and the race.
  /**
   * Correlation time (s) of each of the two filter stages that shape the stress-lap LiDAR error.
   * A misjudged distance drifts instead of flickering every physics step: white per-step noise
   * made the steering chatter at the step rate and its effect depended on the step rate.
   */
  public static readonly SENSOR_NOISE_TAU = 0.05;
  public static readonly TYRE_OPTIMUM = 100;     // deg C
  public static readonly TYRE_AMBIENT = 25;      // air (deg C) of the calibrated reference weather
  public static readonly TYRE_TRACK = 38;        // track surface (deg C) of the reference weather
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

  /**
   * Carbon brakes, per axle, always modelled: braking work heats the discs, airflow cools them.
   * Cold front discs (below BRAKE_WINDOW_LOW) and overheated ones (above BRAKE_WINDOW_HIGH) turn
   * less of the pedal into torque; the rear is brake-by-wire, whose controller meets its torque
   * target with the MGU-K first and the disc for the rest, whatever the disc's temperature. There is no ABS: brake torque beyond what the tyre can transmit on its
   * friction circle (by more than LOCK_MARGIN, for longer than the wheel takes to stop turning,
   * LOCK_DELAY) locks the axle. A locked axle slides at LOCKED_GRIP of its grip, keeps only
   * LOCKED_LATERAL of its cornering force and flat-spots the tyres, until the driver eases the
   * pedal below what the tyre can take.
   */
  public static readonly BRAKE_BIAS = 0.6;               // front share of the brake torque (the axle loads under braking)
  public static readonly BRAKE_TEMP_START = 300;          // deg C after the out-lap / formation lap
  public static readonly BRAKE_HEAT_CAPACITY_FRONT = 3200; // J/K: discs, pads and bells of the axle
  public static readonly BRAKE_HEAT_CAPACITY_REAR = 2400;
  public static readonly BRAKE_COOLING_STILL = 30;        // W/K standing
  public static readonly BRAKE_COOLING_PER_MS = 5;        // W/K per m/s of airflow through the ducts
  public static readonly BRAKE_WINDOW_LOW = 350;          // deg C: full friction from here...
  public static readonly BRAKE_WINDOW_HIGH = 950;         // ...to here, then fade
  public static readonly BRAKE_COLD_EFFICIENCY = 0.7;     // at air temperature
  public static readonly BRAKE_FADE_EFFICIENCY = 0.65;    // at BRAKE_WINDOW_HIGH + 350 deg C and above
  public static readonly LOCK_MARGIN = 0.15;
  public static readonly LOCK_DELAY = 0.1;                // s of excess torque before the wheel stops
  public static readonly LOCK_MIN_SPEED = 3;              // m/s
  public static readonly LOCKED_GRIP = 0.85;
  public static readonly LOCKED_LATERAL = 0.3;
  public static readonly LOCK_WEAR_RATE = 0.01;           // tyre wear per second locked (flat spot)
  public brakeTempFront = Car.BRAKE_TEMP_START;
  public brakeTempRear = Car.BRAKE_TEMP_START;
  public wheelLockFront = false;
  public wheelLockRear = false;
  private lockTimerFront = 0;
  private lockTimerRear = 0;

  /** Share of the pedal's torque a disc at `temp` delivers (1 inside the window). */
  static brakeEfficiency(temp: number, airTemp = Car.TYRE_AMBIENT): number {
    if (temp < Car.BRAKE_WINDOW_LOW) {
      const warm = Math.max(0, Math.min(1, (temp - airTemp) / Math.max(1, Car.BRAKE_WINDOW_LOW - airTemp)));
      return Car.BRAKE_COLD_EFFICIENCY + (1 - Car.BRAKE_COLD_EFFICIENCY) * warm;
    }
    if (temp <= Car.BRAKE_WINDOW_HIGH) return 1;
    return 1 - (1 - Car.BRAKE_FADE_EFFICIENCY) * Math.min(1, (temp - Car.BRAKE_WINDOW_HIGH) / 350);
  }

  /**
   * Lock state of an axle after a step: torque above the tyre's capacity by LOCK_MARGIN for
   * LOCK_DELAY locks it; a locked axle frees once the torque is back within the capacity.
   */
  static stepLock(locked: boolean, timer: number, rolling: boolean, torque: number, capacity: number, dt: number): [boolean, number] {
    if (!rolling || torque <= 0) return [false, 0];
    if (locked) return torque > capacity ? [true, timer] : [false, 0];
    const next = torque > capacity * (1 + Car.LOCK_MARGIN) ? timer + dt : 0;
    return [next >= Car.LOCK_DELAY - 1e-9, next];
  }

  /** Efficiency of the front (hydraulic) brakes: what the driver feels at the pedal. */
  get brakeEfficiency(): number {
    return Car.brakeEfficiency(this.brakeTempFront, Car.config.weather.airTemp);
  }

  /**
   * Aquaplaning: on standing water (wetness above AQUAPLANE_WETNESS) a slick rides up on a film
   * of water above AQUAPLANE_SPEED and loses up to AQUAPLANE_MAX_LOSS of its grip, the loss
   * growing with the water and the speed. Treaded tyres clear the water.
   */
  public static readonly AQUAPLANE_WETNESS = 0.6;
  public static readonly AQUAPLANE_SPEED = 200 / 3.6;
  public static readonly AQUAPLANE_RANGE = 100 / 3.6;
  public static readonly AQUAPLANE_MAX_LOSS = 0.5;
  /** Grip lost to aquaplaning in the last step, 0..AQUAPLANE_MAX_LOSS. */
  public aquaplaning = 0;

  static aquaplaneLoss(compound: TyreCompound, wetness: number, speed: number): number {
    if (!isSlick(compound) || wetness <= Car.AQUAPLANE_WETNESS || speed <= Car.AQUAPLANE_SPEED) return 0;
    const water = (wetness - Car.AQUAPLANE_WETNESS) / (1 - Car.AQUAPLANE_WETNESS);
    return Car.AQUAPLANE_MAX_LOSS * Math.min(1, water) * Math.min(1, (speed - Car.AQUAPLANE_SPEED) / Car.AQUAPLANE_RANGE);
  }

  /**
   * Disc temperatures over `dt`: exact relaxation towards air + heat / cooling, so the result does
   * not depend on the step. `heatFront` / `heatRear` are the braking powers the discs take, W.
   */
  private stepBrakes(heatFront: number, heatRear: number, speed: number, dt: number): void {
    const air = Car.config.weather.airTemp;
    const cooling = Car.BRAKE_COOLING_STILL + Car.BRAKE_COOLING_PER_MS * Math.max(0, speed);
    const relax = (temp: number, heat: number, capacity: number) => {
      const settled = air + heat / cooling;
      return settled + (temp - settled) * Math.exp(-cooling * dt / capacity);
    };
    this.brakeTempFront = relax(this.brakeTempFront, heatFront, Car.BRAKE_HEAT_CAPACITY_FRONT);
    this.brakeTempRear = relax(this.brakeTempRear, heatRear, Car.BRAKE_HEAT_CAPACITY_REAR);
  }
  /** Compound fitted (see `Tyres.ts`); medium is the calibrated reference. */
  public tyreCompound: TyreCompound = 'medium';
  /** Compound fitted at every pit stop (player choice, or the same set in qualifying); null lets the strategy pick. */
  public nextCompound: TyreCompound | null = null;
  /** Weather, track conditions and stress-lap share of this simulation (see `SimConfig.ts`). */
  public static readonly config: SimConfig = createSimConfig();
  /** Wetness range seen during the current lap (LapTiming). */
  public lapWetMin = 0;
  public lapWetMax = 0;
  /** Crosswind side force area (Cy*A, m^2) and its centre of pressure behind the centre of gravity (m). */
  public static SIDE_FORCE_AREA = 1.5;
  public static SIDE_FORCE_LEVER = 0.3;
  /** Share of downforce lost per sin^2 of the airflow yaw angle; the front wing loses most. */
  public static CROSSWIND_DOWNFORCE_LOSS = 0.6;
  public ersEnergy = Car.ERS_CAPACITY * 0.85;
  public ersHarvestedLap = 0;
  public ersDeploying = false;
  public readonly maxSteerAngle: number = 0.40; // ~23 degrees
  public readonly dragCoeff: number = 1.00; // Cd * A [m^2]
  /** Air density at the calibrated reference weather (25 deg C, sea level), kg/m^3. */
  public static readonly AIR_DENSITY_REF = 1.225;
  /**
   * Air density from the weather's air temperature at constant pressure (ideal gas), equal to
   * AIR_DENSITY_REF at 25 deg C: cold air gives more downforce and drag, hot air less.
   */
  get airDensity(): number { return Car.AIR_DENSITY_REF * (273.15 + Car.TYRE_AMBIENT) / (273.15 + Car.config.weather.airTemp); }
  public readonly downforceCoeff: number = 3.10; // Cl * A [m^2]
  public readonly baseTireGrip: number = 1.85; // Peak friction coefficient mu

  // Organic Performance Variations
  public lapPowerFactor: number = 1.0;
  public lapGripFactor: number = 1.0;
  public lapDragFactor: number = 1.0;
  /** This lap is a stress lap (see `SimConfig.stressLapShare`). */
  public stressLap = false;
  /** The brain is a stagnation-breaking mutation of the record brain, on trial until its next clean lap. */
  public explorationTrial = false;
  /** Stress-lap LiDAR error seen by the network: per-reading noise and a per-lap calibration bias. */
  private sensorNoise = 0;
  private sensorBias = 0;
  private readonly noisyRays: number[] = [];
  /** Per-ray noise state: a Gauss-Markov drift and the error that follows it (see `SENSOR_NOISE_TAU`). */
  private sensorDrift: number[] = [];
  private sensorError: number[] = [];

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
  // Forward clearance (DrivePlan.minCenterClearance) is a ray distance over the track width:
  // a wider track sees its walls further ahead in a corner, so the thresholds scale with it.
  // Value = (distance / RAY_MAX_DIST) · CLEARANCE_REF_WIDTH / width, so CLEAR_FULL = 0.22 means
  // the wall is 0.22·240/76 ≈ 0.69 track widths ahead (≈ 9.7 m on a 14 m track).
  public static readonly CLEARANCE_REF_WIDTH = 76;
  public static readonly CLEAR_FULL = 0.22;   // above: full throttle allowed
  public static readonly CLEAR_LIFT = 0.12;   // above: lift to 20%; below: emergency, guarded
  public static readonly CLEAR_COACH = 0.25;  // leader-speed coaching only with this much room
  public static readonly CLEAR_CAP = 0.2;     // guardian caps network throttle at 30% below this
  /** Lateral acceleration (g) the network may add to or take from the expert's steering. */
  public static readonly BRAIN_STEER_G = 2;
  /** Lateral room (m) beyond the car's half width in which a side ray's hit still blocks the path ahead. */
  public static readonly CORRIDOR_MARGIN = 0.15;
  /** Time to contact (s) with a car the LiDAR sees in the path below which the car brakes and steers round it. */
  public static readonly CAR_AVOID_TTC = 3.5;
  /** Lateral room (m) beyond the car's half width in which a car seen ahead counts as in the path. */
  public static readonly CAR_AVOID_MARGIN = 0.8;
  /** Lateral acceleration (g) the steering may use to move out of the path of a car seen ahead. */
  public static readonly CAR_AVOID_G = 1.5;
  /** Above this urgency (0..1, from the time to contact) the guardian drives the avoidance instead of the network. */
  public static readonly CAR_AVOID_GUARD = 0.25;
  /** Side gap (m) to a car alongside below which the car steers away from it, */
  public static readonly CAR_SIDE_GAP = 0.6;
  /** widened by this many seconds of the speed at which the gap is closing. */
  public static readonly CAR_SIDE_LOOKAHEAD = 0.4;
  public rayAngles: number[] = [];
  /** What each ray sees first: barrier/edge or another car's body (the network input). */
  public rayDistances: number[] = [];
  /** Track edges only: forward clearance and the line network are calibrated to walls. */
  public rayWallDistances: number[] = [];
  /** The car each ray hit, or null when it ended on the track edge. */
  public rayCars: (Car | null)[] = [];
  public rayHits: IntersectionResult[] = [];
  /** Scan buffers of `updateSensors`: the bodies in reach and SCAN_FRAME numbers per body. */
  private readonly scanBodies: Car[] = [];
  private readonly scanFrames: number[] = [];

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
  /**
   * Track limits as raced: the wheels of one side may run over the kerb beyond the white line
   * (the grass then costs them grip); the whole car off, or any wheel in the gravel, is an excursion.
   */
  get withinTrackLimits(): boolean { return this.surfaceFractions.asphalt >= 0.5 && this.surfaceFractions.gravel === 0; }
  public eliminationReason: 'barrier' | 'car' | 'fuel' | 'stuck' | 'wrong-way' | null = null;
  public barrierImpactSpeed = 0;
  public incidentActive = false;
  public recoveryTimer = 0;
  public lapCompromised = false;
  public battlePush = new BattlePush();
  public battleOpponent = '';
  /** Planned lateral position (m from the centreline) at the car; see `raceLineBaseline`. */
  public raceLineOffset = 0;
  /**
   * The racing line (plus the learned style) at the car when `raceLineOffset` was planned. Their
   * difference is the deliberate move off the line (overtaking, defending, tow); steering applies it
   * to the line further ahead, so the car follows the line's shape instead of a fixed lane.
   */
  public raceLineBaseline = 0;
  /** Set by a reset (grid, respawn): the next lateral plan starts from where the car stands. */
  public raceLineFresh = true;
  /** Distance (m) from the learned racing line while overtaking/avoiding; the line itself costs no speed. */
  public lineDeviation = 0;
  /** Driver taste for late apexes, see RacingLine.STYLES. */
  public apexStyle: number = RacingLine.STYLES[this.id % RacingLine.STYLES.length];
  public lineSearch: LineSearch | null = null;
  /** The line this car really drives; the braking planner reads corner radii from it. Kept across resets. */
  public lineProfile: LineProfile | null = null;
  /** Track point last blended into the line profile: one sample per pass, not per frame. */
  public lineProfileIndex = -1;
  public pace = new PaceSearch();
  /** The car left the asphalt or touched a barrier by itself during the current lap. */
  public lapExcursion = false;
  /** Touched another car this lap: an excursion may have been forced and says nothing about the pace. */
  public lapContact = false;
  /** Smoothed spare grip in the current corner (0..1), see PLAN_PUSH_MAX. */
  public cornerPush = 0;
  public lastStepDt = 1 / 60;
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
  public pressureElapsed = 2;
  public racingLineLabel = '';
  public overtakingTargetName = '';
  public yellowFlag = false;
  public trafficWaiting = false;
  public wreckRemoved = false;
  /** Seconds since the car became a wreck in a race or qualifying session. */
  public wreckAge = 0;
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
  private readonly appliedControl: CarControl = { steer: 0, throttle: 0, brake: 0 };
  /** Pedals as the actuators deliver them (see BRAKE_APPLY_TAU); steering passes through. */
  private readonly actuatedControl: CarControl = { steer: 0, throttle: 0, brake: 0 };
  /** Delivered brake pressure and engine torque request, 0..1. */
  public brakePressure = 0;
  public throttleResponse = 0;
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
  /** The current lap started at the line (not on the grid or at a respawn): its splits and sectors are timed. */
  public flyingLap = false;
  /** Sector completed in the last step; the session takes it (and clears it) for the session-best sectors. */
  public sectorEvent: SectorEvent | null = null;
  /** Race time at the last crossing of the start/finish line, interpolated within the step. */
  public lineCrossingRaceTime = 0;
  public currentLap: number = 0;
  public currentCheckpointIdx: number = 0;
  public checkpointsCleared: number = 0;
  public framesSinceLastCheckpoint: number = 0;
  public isSkidding: boolean = false;
  /** Tyres well past their peak (or a real slide): only this cuts the throttle; working slip at the limit does not. */
  public isSliding: boolean = false;
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
  /** Race distance in laps while racing (the pit strategy plans with it); 0 outside a race. */
  public raceDistanceLaps = 0;
  /** Compounds fitted during this race (start set and every stop), for the dry-race tyre rule. */
  public usedCompounds = new Set<TyreCompound>();
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
    this.rayWallDistances = new Array(this.rayAngles.length).fill(1);
    this.rayCars = new Array(this.rayAngles.length).fill(null);
    this.rollLapPerformanceVariation();
  }

  public setRayCount(rayCount: number): void {
    this.rayAngles = Car.generateRayAngles(rayCount);
    this.rayDistances = new Array(this.rayAngles.length).fill(1);
    this.rayWallDistances = new Array(this.rayAngles.length).fill(1);
    this.rayCars = new Array(this.rayAngles.length).fill(null);
    this.rayHits = [];
  }

  public rollLapPerformanceVariation(): void {
    this.lapPowerFactor = 1.0 + (random() * 0.04 - 0.02);
    this.lapGripFactor = 1.0 + (random() * 0.05 - 0.025);
    this.lapDragFactor = 1.0 + (random() * 0.03 - 0.015);
    this.stressLap = Car.config.stressLapShare > 0 && !this.isManual && random() < Car.config.stressLapShare;
    if (this.stressLap) {
      this.lapPowerFactor = 1.0 + (random() * 0.08 - 0.04);
      this.lapGripFactor = 1.0 + (random() * 0.11 - 0.08); // -8% .. +3%
      this.sensorNoise = 0.01 + random() * 0.03;
      this.sensorBias = random() * 0.04 - 0.02;
      this.sensorDrift = []; this.sensorError = [];
      // Learning bookkeeping only: in training a stress lap never sets a record or evaluates a model.
      // In qualifying and the race it is driven the same way and its time counts.
      if (!this.isRaceMode) this.lapCompromised = true;
    }

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
    this.raceLineBaseline = 0;
    this.raceLineFresh = true;
    this.overtakingTargetName = '';
    this.yellowFlag = false;
    this.trafficWaiting = false;
    this.wreckRemoved = false;
    this.wreckAge = 0;
    this.offRoadStillTime = 0;
    this.offTrackTime = 0;
    this.lapExcursion = false;
    this.lapContact = false;
    this.cornerPush = 0;
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
    this.resetSuspension();
    this.wheelAngle = 0;
    this.frontLateralInUse = this.rearLateralInUse = 0;
    this.understeerSlip = 0;
    this.oversteerSlip = 0;
    this.isSkidding = false;
    this.isSliding = false;
    this.skidMarks = [];
    this.currentLapTrajectory = [];
    this.currentLapSplits = [null, null, null, null];
    this.lastCheckpointDelta = null;
    this.flyingLap = false;
    this.sectorEvent = null;
    this.lineCrossingRaceTime = 0;
    this.wantsToPit = false;
    this.isPitting = false;
    this.pitTimer = 0;
    this.isFinishedRace = false;
    this.currentControl = { steer: 0, throttle: 0, brake: 0 };
    this.effectiveThrottle = 0;
    this.brakePressure = this.throttleResponse = 0;
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
      this.brakeTempFront = this.brakeTempRear = Car.BRAKE_TEMP_START;
      this.wheelLockFront = this.wheelLockRear = false;
      this.lockTimerFront = this.lockTimerRear = 0;
      this.tyreCompound = weatherCompound(Car.config.weather.wetness, 'medium');
      this.nextCompound = null;
      this.raceDistanceLaps = 0;
      this.usedCompounds = new Set([this.tyreCompound]);
    }
    this.lapStartFuel = this.fuelKg;
    this.lapWetMin = this.lapWetMax = Car.config.weather.wetness;
    this.ersHarvestedLap = 0;
    this.gear = 1; this.engineRpm = Car.IDLE_RPM; this.shiftCutTimer = 0; this.shiftCooldown = 0;
    this.fullyOffTrack = false;
    this.rollLapPerformanceVariation();
  }

  /**
   * LiDAR as the network sees it on a stress lap; the guardian keeps the true readings. Each
   * reading's error has the standard deviation `sensorNoise` and is band-limited: Gauss-Markov
   * drift (exact in dt) smoothed once more, so it varies over tenths of a second at any step rate.
   */
  noisyRayDistances(): number[] {
    const gauss = () => (random() + random() + random() - 1.5) * 2; // ~N(0, 1)
    const n = this.rayDistances.length;
    if (this.sensorError.length !== n) {
      // Start from the stationary spread (the second stage halves the drift's variance).
      this.sensorDrift = Array.from({ length: n }, () => gauss() * this.sensorNoise * Math.SQRT2);
      this.sensorError = Array.from({ length: n }, () => gauss() * this.sensorNoise);
    }
    const k = Math.exp(-this.lastStepDt / Car.SENSOR_NOISE_TAU);
    const kick = this.sensorNoise * Math.SQRT2 * Math.sqrt(1 - k * k);
    // Overwritten in place every step; the planner copies it into the network inputs.
    const noisy = this.noisyRays;
    noisy.length = n;
    for (let i = 0; i < n; i++) {
      this.sensorDrift[i] = this.sensorDrift[i] * k + gauss() * kick;
      this.sensorError[i] += (this.sensorDrift[i] - this.sensorError[i]) * (1 - k);
      noisy[i] = Math.max(0, Math.min(1, this.rayDistances[i] + this.sensorBias + this.sensorError[i]));
    }
    return noisy;
  }

  /**
   * LiDAR scan: each ray stops at the track edge or at the first body of `cars` in its way
   * (the same 5.5 m × width box the collision model uses). Cars in the pits, finished or
   * removed by the marshals are not on track and are not seen.
   */
  updateSensors(track: Track, cars: readonly Car[] = []): void {
    // Arrays reused across steps; consumers copy them (inputs spread, snapshots).
    const n = this.rayAngles.length;
    this.rayHits.length = n;
    this.rayDistances.length = n;
    this.rayWallDistances.length = n;
    this.rayCars.length = n;
    // The bodies in reach, each with its frame worked out once per scan instead of once per ray.
    const reach = (Car.RAY_MAX_DIST + 3.5) ** 2;
    const bodies = this.scanBodies, frames = this.scanFrames;
    bodies.length = 0;
    for (const o of cars) {
      if (o === this || o.wreckRemoved || o.isPitting || o.isFinishedRace || o.pos.distSq(this.pos) >= reach) continue;
      const k = bodies.length * SCAN_FRAME;
      const half = o.width / 2;
      frames[k] = Math.cos(o.heading); frames[k + 1] = Math.sin(o.heading); frames[k + 2] = half;
      frames[k + 3] = this.pos.x - o.pos.x; frames[k + 4] = this.pos.y - o.pos.y;
      frames[k + 5] = Math.hypot(2.75, half) + 0.01; // bounding circle, a little generous
      bodies.push(o);
    }
    for (let i = 0; i < n; i++) {
      const rayAngle = this.heading + this.rayAngles[i];
      let hit = track.castRay(this.pos, rayAngle, Car.RAY_MAX_DIST);
      this.rayWallDistances[i] = hit.dist / Car.RAY_MAX_DIST;
      let seen: Car | null = null;
      if (bodies.length) {
        const dx = Math.cos(rayAngle), dy = Math.sin(rayAngle);
        let nearest = hit.dist;
        for (let b = 0; b < bodies.length; b++) {
          const k = b * SCAN_FRAME, ox = frames[k + 3], oy = frames[k + 4], radius = frames[k + 5];
          // A ray that misses the bounding circle within `nearest` misses the body.
          const along = -(ox * dx + oy * dy);
          if (along < -radius || along - radius >= nearest || Math.abs(ox * dy - oy * dx) > radius) continue;
          const t = slabEntry(frames[k], frames[k + 1], frames[k + 2], ox, oy, dx, dy, nearest);
          if (t < nearest) { nearest = t; seen = bodies[b]; }
        }
        if (seen) hit = { point: new Vector2(this.pos.x + dx * nearest, this.pos.y + dy * nearest), dist: nearest };
      }
      this.rayHits[i] = hit;
      this.rayCars[i] = seen;
      this.rayDistances[i] = hit.dist / Car.RAY_MAX_DIST;
    }
  }

  /** Distance along a ray from `origin` (unit direction dx, dy) to where it enters this body; Infinity if it misses within `maxDist` or starts inside. */
  rayEntry(origin: Vector2, dx: number, dy: number, maxDist: number): number {
    return slabEntry(Math.cos(this.heading), Math.sin(this.heading), this.width / 2, origin.x - this.pos.x, origin.y - this.pos.y, dx, dy, maxDist);
  }

  /**
   * Grip multiplier of an axle from tyre temperature (asymmetric bell around the compound's
   * window, 0.75..1), wear (up to -25%) and the compound's grip on a track this wet.
   */
  static tyreGrip(temp: number, wear: number, compound: TyreCompound = 'medium', wetness = 0): number {
    const spec = COMPOUND_SPECS[compound];
    const d = temp - spec.optimum;
    const thermal = d < 0 ? 0.80 + 0.20 * Math.exp(-(d * d) / (2 * spec.coldWidth * spec.coldWidth)) : 0.75 + 0.25 * Math.exp(-(d * d) / (2 * spec.hotWidth * spec.hotWidth));
    return thermal * (1 - 0.25 * Math.pow(Math.max(0, Math.min(1, wear)), 1.4)) * compoundGrip(compound, wetness);
  }

  /** Track wetness this car drives on. */
  get wetness(): number { return Car.config.weather.wetness; }

  /** Grip the planner can expect from the current tyres. */
  get tyreGripFront(): number { return Car.tyreGrip(this.tyreTempFront, this.tyreWearFront, this.tyreCompound, this.wetness); }
  get tyreGripRear(): number { return Car.tyreGrip(this.tyreTempRear, this.tyreWearRear, this.tyreCompound, this.wetness); }

  /**
   * Heat balance of one axle: slip + hysteresis heating against airflow and track cooling.
   * The air and the track surface come from the weather: a sun-baked track pushes the tyres out
   * of their window and wears them faster, a cold one keeps them from warming up.
   * Water cools the tyre (spray, cooler surface) and lubricates it, so it wears less.
   */
  private stepTyre(front: boolean, slipPower: number, load: number, speed: number, dt: number): void {
    const temp = front ? this.tyreTempFront : this.tyreTempRear, wear = front ? this.tyreWearFront : this.tyreWearRear;
    const wet = this.wetness, air = Car.config.weather.airTemp;
    const heat = (slipPower + 0.0075 * load * speed) * Car.TYRE_HEAT_SCALE;
    const cooling = (2 * (15 + 3.2 * Math.pow(Math.max(0, speed), 0.8)) * (temp - air) + 60 * (temp - Car.config.weather.trackTemp)) * (1 + 0.9 * wet);
    const next = Math.max(air - 8 * wet, Math.min(180, temp + (heat - cooling) / Car.TYRE_HEAT_CAPACITY * dt));
    const wearRate = Car.TYRE_WEAR_RATE * COMPOUND_SPECS[this.tyreCompound].wear * (1 - 0.6 * wet);
    const nextWear = Math.min(1, wear + wearRate * Math.pow(temp / 100, 2) * slipPower * dt);
    if (front) { this.tyreTempFront = next; this.tyreWearFront = nextWear; }
    else { this.tyreTempRear = next; this.tyreWearRear = nextWear; }
  }

  /** Compound fitted at the next stop: the player's request, else the strategy for the conditions (PitStrategy.ts). */
  pitCompound(): TyreCompound {
    return pitCompound(this);
  }

  /** This driver's racing line on `track` (shared by every car with the same apex style). */
  racingLine(track: Track): RacingLine { return getRacingLine(track, this.apexStyle); }

  /** Network inputs and the expert's controls for this step (DrivePlanner.ts). */
  planDrive(track: Track, leaderSpeeds?: number[]): DrivePlan {
    return planDrive(this, track, leaderSpeeds);
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

    // Steering stays within a corridor around a geometrically valid path. The corridor is a lateral
    // acceleration: wide at low speed, a few degrees at most on a straight at 300 km/h.
    const steerLimit = Math.min(0.3, Math.atan(Car.BRAIN_STEER_G * Car.GRAVITY * this.wheelbase / Math.max(1, this.speed * this.speed)) / this.maxSteerAngle);
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
    } else if (plan.minCenterClearance < Car.CLEAR_CAP && throttle > 0.3) {
      throttle = 0.3; intervened = true;
    }
    if (this.isSliding) throttle = Math.min(throttle, 0.55);
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
  /** `traffic`: the cars on the track, for the pit exit (none given: the exit is always clear). */
  updatePhysics(control: CarControl, dt: number, track: Track, traffic: readonly Car[] = []): LapFinishEvent | null {
    this.lastStepDt = dt;
    this.sectorEvent = null;
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
    // A car-owned copy, so callers' control objects are never aliased or mutated.
    const applied = this.appliedControl;
    applied.steer = control.steer; applied.throttle = control.throttle; applied.brake = control.brake;
    this.currentControl = applied;
    // The driver's demand is `applied`; the forces below use what the actuators deliver.
    this.brakePressure += (control.brake - this.brakePressure)
      * (1 - Math.exp(-dt / (control.brake > this.brakePressure ? Car.BRAKE_APPLY_TAU : Car.BRAKE_RELEASE_TAU)));
    this.throttleResponse += (control.throttle - this.throttleResponse) * (1 - Math.exp(-dt / Car.THROTTLE_TAU));
    if (this.brakePressure < 1e-4) this.brakePressure = 0;
    if (this.throttleResponse < 1e-4) this.throttleResponse = 0;
    const actuated = this.actuatedControl;
    actuated.steer = control.steer; actuated.throttle = this.throttleResponse; actuated.brake = this.brakePressure;
    control = actuated;
    this.updateSurface(track);
    if (!this.withinTrackLimits) {
      this.lapCompromised = true;
      this.lapExcursion = true;
      this.recoveryTimer = 2;
      this.replayBuffer = [];
      this.replayStepTimer = 0;
    }

    if (this.isPitting) {
      servicePitStop(this, dt, track, traffic);
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
      this.fuelBurnRatePerSec = Car.FUEL_FLOW_IDLE + Car.FUEL_FLOW_MAX * actualThrottle * Car.icePowerFraction(this.engineRpm);
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
    // Airflow the car meets: its own motion against the wind. Downforce and drag grow with the
    // airspeed; downforce fades as the wind turns the flow off the car's axis. Still air: airSpeed = speedMag.
    const weather = Car.config.weather;
    const windy = weather.windX !== 0 || weather.windY !== 0;
    const windLat = windy ? weather.windX * rightDir.x + weather.windY * rightDir.y : 0;
    const airFwd = windy ? forwardSpeed - (weather.windX * forwardDir.x + weather.windY * forwardDir.y) : forwardSpeed;
    const airLat = lateralSpeed - windLat;
    const airSpeed = windy ? Math.hypot(airFwd, airLat) : speedMag;
    const crosswindLoss = windy && airSpeed > 1e-6 ? Car.CROSSWIND_DOWNFORCE_LOSS * (airLat / airSpeed) ** 2 : 0;

    // 3. Gravity and Aerodynamics Normal Load (Fz)
    const gravityForce = currentMass * Car.GRAVITY; // Gravity F = m * g
    let downforceMag = 0.5 * this.airDensity * this.downforceCoeff * (1 - 0.35 * this.damage) * (airSpeed * airSpeed) * (1 - crosswindLoss);
    // The floor works at the height its airflow sees; the body then moves under that load. Its
    // flow stalls and reattaches with hysteresis, which can set up porpoising near the stall height.
    const low = this.floorStall > 0.5
      ? this.floorHeightFront < 0.012 || this.floorHeightRear < 0.019
      : this.floorHeightFront < 0.008 || this.floorHeightRear < 0.015;
    this.floorStall += ((low ? 1 : 0) - this.floorStall) * (1 - Math.exp(-dt / Car.FLOOR_FLOW_LAG));
    this.aeroStall = this.floorStall > 0.5;
    downforceMag *= Car.rideHeightLift(this.floorHeightFront, this.floorHeightRear, 1 - Car.PORPOISING_STALL_LOSS * this.floorStall);
    // Dirty air takes 60% of its loss from the front wing (46% is the clean-air split).
    const wakeLostDownforce = downforceMag * (1 - this.wakeDownforce);
    downforceMag -= wakeLostDownforce;
    // A crosswind stalls the front wing first: 60% of its loss comes off the front axle.
    const crosswindFrontShift = crosswindLoss > 0 ? 0.14 * downforceMag * crosswindLoss / (1 - crosswindLoss) : 0;
    const aeroFront = downforceMag * 0.46 - 0.14 * wakeLostDownforce - crosswindFrontShift;
    this.stepSuspension(dt, aeroFront, downforceMag - aeroFront, this.longitudinalG * Car.GRAVITY, this.lateralG * Car.GRAVITY);

    // Aerodynamic drag opposes the velocity relative to the air (a headwind costs top speed,
    // a tailwind adds it); plank friction scrubs along the road against the motion. A crosswind
    // also pushes the car sideways through the side force, centred behind the centre of gravity.
    const plankDrag = Car.PLANK_FRICTION * this.plankForce;
    const aeroDrag = 0.5 * this.airDensity * this.dragCoeff * this.lapDragFactor * this.wakeDrag * (1 + 0.15 * this.damage) * airSpeed * airSpeed;
    const aeroScale = airSpeed > 0 ? Math.min(aeroDrag / airSpeed, currentMass / dt) : 0;
    const plankScale = speedMag > 0 ? Math.min(plankDrag / speedMag, currentMass / dt) : 0;
    const sideForce = 0.5 * this.airDensity * Car.SIDE_FORCE_AREA * airSpeed * windLat;
    const dragForward = -airFwd * aeroScale - forwardSpeed * plankScale;
    const dragLateral = -airLat * aeroScale - lateralSpeed * plankScale + sideForce;

    // Keep axle loads positive without inventing extra total normal load.
    const pitchTransfer = -currentMass * this.longitudinalG * Car.GRAVITY * this.cogHeight / this.wheelbase;
    // Tyres carry the static weight, the springs/dampers and the transfer that bypasses them:
    // the geometric (anti-dive/squat) share of the sprung mass and all of the unsprung mass.
    const anti = this.longitudinalG < 0 ? Car.ANTI_DIVE : Car.ANTI_SQUAT;
    const direct = pitchTransfer * (1 - Car.SPRUNG_MASS_SHARE + Car.SPRUNG_MASS_SHARE * anti);
    const frontSprung = gravityForce * 0.46 + this.suspensionForceFront + direct;
    const rearSprung = gravityForce * 0.54 + this.suspensionForceRear - direct;
    const totalLoad = Math.max(gravityForce * 0.1, frontSprung + rearSprung);
    const frontLoad = Math.max(totalLoad * 0.05, Math.min(totalLoad * 0.95, frontSprung));
    const rearLoad = totalLoad - frontLoad;
    this.weightFrontRatio = frontLoad / (frontLoad + rearLoad);
    const fractions = this.surfaceFractions;
    const surfaceMu = fractions.asphalt * this.baseTireGrip + fractions.grass * 0.45 + fractions.gravel * 0.60;
    this.aquaplaning = Car.aquaplaneLoss(this.tyreCompound, this.wetness, speedMag);
    const mu = surfaceMu * this.lapGripFactor * (1 - this.aquaplaning);
    // Roll moves load to the outer wheels; with load sensitivity that costs the axle grip.
    const frontGripLoad = Car.axleGripLoad(frontLoad, this.rollTransferFront);
    const rearGripLoad = Car.axleGripLoad(rearLoad, this.rollTransferRear);
    const frontLimit = mu * this.tyreGripFront * frontGripLoad;
    const rearLimit = mu * this.tyreGripRear * rearGripLoad;

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
    // The discs turn the pedal into torque by their temperature; torque beyond what the tyre can
    // transmit (by more than LOCK_MARGIN) locks the axle, which then slides at LOCKED_GRIP.
    const airTemp = Car.config.weather.airTemp;
    const torqueFront = brakeDemand * Car.BRAKE_BIAS * Car.brakeEfficiency(this.brakeTempFront, airTemp);
    const torqueRear = brakeDemand * (1 - Car.BRAKE_BIAS); // brake-by-wire meets the rear target
    const roomFront = Math.max(0, frontLongLimit - rollingFront), roomRear = Math.max(0, rearLongLimit - rollingRear);
    // What each tyre can transmit along the road on its friction circle, with the lateral force it carries.
    const gripAlong = (limit: number, lateral: number, rollingForce: number) => Math.max(0, Math.sqrt(Math.max(0, limit * limit - lateral * lateral)) - rollingForce);
    const rolling = forwardSpeed > Car.LOCK_MIN_SPEED;
    [this.wheelLockFront, this.lockTimerFront] = Car.stepLock(this.wheelLockFront, this.lockTimerFront, rolling, torqueFront, gripAlong(frontLimit, this.frontLateralInUse, rollingFront), dt);
    [this.wheelLockRear, this.lockTimerRear] = Car.stepLock(this.wheelLockRear, this.lockTimerRear, rolling, torqueRear, gripAlong(rearLimit, this.rearLateralInUse, rollingRear), dt);
    const brakeFront = this.wheelLockFront ? roomFront * Car.LOCKED_GRIP : Math.min(roomFront, torqueFront);
    const brakeRear = this.wheelLockRear ? roomRear * Car.LOCKED_GRIP : Math.min(roomRear, torqueRear);
    const vStar = forwardSpeed + (driveForce + dragForward) / currentMass * dt;
    const resistance = brakeFront + brakeRear + rollingFront + rollingRear;
    const resistanceScale = resistance > 0 ? Math.min(1, currentMass * Math.abs(vStar) / (dt * resistance)) : 0;
    const resistanceSign = Math.sign(vStar);
    let regenBraking = 0;
    if (harvesting) {
      // Brake-by-wire blends regen first: the MGU-K recovers up to ERS_HARVEST_POWER, never more than the brakes dissipate.
      const harvestPower = control.brake > 0.05
        ? Math.min(Car.ERS_HARVEST_POWER, (brakeFront + brakeRear) * resistanceScale * forwardSpeed)
        : Car.ERS_POWER * 0.3;
      if (control.brake > 0.05) regenBraking = harvestPower;
      storeEnergy(harvestPower * Car.ERS_REGEN_EFFICIENCY * dt);
    }
    // The discs take the braking work of a turning wheel (the rear minus what the MGU-K recovers);
    // a locked wheel's work goes into the tyre instead.
    const brakeSpeed = Math.abs(forwardSpeed) * resistanceScale;
    this.stepBrakes(this.wheelLockFront ? 0 : brakeFront * brakeSpeed,
      this.wheelLockRear ? 0 : Math.max(0, brakeRear * brakeSpeed - regenBraking), speedMag, dt);
    if (this.wheelLockFront) this.tyreWearFront = Math.min(1, this.tyreWearFront + Car.LOCK_WEAR_RATE * dt);
    if (this.wheelLockRear) this.tyreWearRear = Math.min(1, this.tyreWearRear + Car.LOCK_WEAR_RATE * dt);
    const frontFx = -resistanceSign * (brakeFront + rollingFront) * resistanceScale;
    const rearFx = Math.max(-rearLimit, Math.min(rearLimit, driveForce - resistanceSign * (brakeRear + rollingRear) * resistanceScale));
    const longitudinalForce = frontFx + rearFx + dragForward;

    // Remaining lateral force is computed from the same friction circle on each axle.
    // A locked axle slides along its velocity and keeps little cornering force.
    const frontLateral = Math.sqrt(Math.max(0, frontLimit * frontLimit - frontFx * frontFx)) * (this.wheelLockFront ? Car.LOCKED_LATERAL : 1);
    const rearLateral = Math.sqrt(Math.max(0, rearLimit * rearLimit - rearFx * rearFx)) * (this.wheelLockRear ? Car.LOCKED_LATERAL : 1);
    const lateralLimit = frontLateral + rearLateral;
    const nextForwardSpeed = forwardSpeed + longitudinalForce / currentMass * dt;
    // Steering actuator: the road wheels follow the command with a short lag.
    this.wheelAngle += (control.steer * this.maxSteerAngle - this.wheelAngle) * (1 - Math.exp(-dt / Car.STEERING_LAG));
    // The kinematic yaw follows the road wheels, as the slip-angle model below does: a jump or
    // chatter in the command reaches the body only through the steering lag, at every speed.
    const targetYaw = nextForwardSpeed / this.wheelbase * Math.tan(this.wheelAngle);
    // Finite steering response; this remains a bounded hybrid, not a yaw-inertia solver.
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
    const dynamicWeight = nextForwardSpeed > 0 ? Math.max(0, Math.min(1, (nextForwardSpeed - 8) / 8)) : 0;
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
        return limit * Math.tanh(Car.CORNERING_STIFFNESS * load * alpha / limit);
      };
      const frontForce = axleForce(alphaFront, frontLoad, frontLateral * Car.FRONT_GRIP_BIAS);
      const rearForce = axleForce(alphaRear, rearLoad, rearLateral);
      const yawInertia = currentMass * Car.YAW_INERTIA_FACTOR;
      // The crosswind side force acts behind the centre of gravity and twists the car with each gust.
      const yawAcceleration = (toFront * frontForce - toRear * rearForce - Car.SIDE_FORCE_LEVER * sideForce) / yawInertia;
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
    const wetNow = this.wetness;
    if (wetNow < this.lapWetMin) this.lapWetMin = wetNow;
    if (wetNow > this.lapWetMax) this.lapWetMax = wetNow;
    this.stepTyre(true, frontSlipPower * Car.TYRE_FRONT_HEAT, frontLoad, speedMag, dt);
    this.stepTyre(false, rearSlipPower, rearLoad, speedMag, dt);
    this.tireUtilization = Math.min(1, Math.hypot(frontFx + rearFx, lateralForce) / Math.max(1, frontLimit + rearLimit));
    const drifting = Math.abs(lateralSpeed) > 4.5 && speedMag > 18;
    this.isSkidding = slipRatio > 0.01 || drifting;
    this.isSliding = slipRatio > Car.SLIDE_SLIP || drifting;
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
    this.pitchAngle = this.pitch;
    this.rollAngle = this.roll;
    if (!this.dynamicStateFinite()) { this.recoverInvalidState(previousHeading); return null; }

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
    if (!this.withinTrackLimits) { this.lapCompromised = true; this.lapExcursion = true; this.recoveryTimer = 2; }
    this.speed = this.vel.mag();
    this.speedKmh = this.speed * 3.6;
    this.maxSpeedInLap = Math.max(this.maxSpeedInLap, this.speed);
    this.distanceCoveredInLap += stepDelta.mag();

    // 7b. Directional progress along the track, wrong-way retirement and penalties (Fitness.ts)
    if (scoreStep(this, track, newForwardDir, dt)) return null;

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

  footprint(halfLength: number): Vector2[] {
    const forward = Vector2.fromAngle(this.heading), side = forward.normal();
    return [-1, 1].flatMap(front => [-1, 1].map(left => this.pos.add(forward.mul(front * halfLength)).add(side.mul(left * this.width / 2))));
  }

  private readonly wheelPoints = [new Vector2(), new Vector2(), new Vector2(), new Vector2()];
  private updateSurface(track: Track): void {
    // Updated in place each step; snapshots copy it.
    const fractions = this.surfaceFractions;
    fractions.asphalt = fractions.grass = fractions.gravel = 0;
    if (track.sampleSurface) {
      // Same corners and arithmetic as footprint(), without allocating them.
      const fx = Math.cos(this.heading), fy = Math.sin(this.heading), half = this.wheelbase / 2;
      let k = 0;
      for (let front = -1; front <= 1; front += 2) for (let left = -1; left <= 1; left += 2) {
        const wheel = this.wheelPoints[k++], along = front * half, across = left * this.width / 2;
        wheel.x = this.pos.x + fx * along + -fy * across;
        wheel.y = this.pos.y + fy * along + fx * across;
        fractions[track.sampleSurface(wheel).surface] += 0.25;
      }
    } else fractions.asphalt = 1;
    this.surface = fractions.gravel > 0 ? 'gravel' : fractions.grass > 0 ? 'grass' : 'asphalt';
  }

  private dynamicStateFinite(): boolean {
    return Number.isFinite(this.vel.x + this.vel.y + this.pos.x + this.pos.y + this.heading + this.angularVelocity
      + this.heave + this.heaveRate + this.pitch + this.pitchRate + this.roll + this.rollRate
      + this.tyreTempFront + this.tyreTempRear + this.brakeTempFront + this.brakeTempRear + this.ersEnergy + this.fuelKg);
  }

  private static invalidStateWarned = false;
  /**
   * A non-finite value would otherwise stay in the car's state for good. The step is dropped
   * before the position moves, the broken values are reset and the car is retired like a crash
   * (it respawns normally).
   */
  private recoverInvalidState(previousHeading: number): void {
    if (!Car.invalidStateWarned) { Car.invalidStateWarned = true; console.warn(`Car ${this.driverName}: non-finite physics state, car retired`); }
    if (!Number.isFinite(this.pos.x + this.pos.y)) this.pos.set(this.prevPos.x, this.prevPos.y);
    this.heading = Number.isFinite(previousHeading) ? previousHeading : 0;
    this.angularVelocity = 0;
    this.resetSuspension();
    this.pitchAngle = this.rollAngle = 0;
    if (!Number.isFinite(this.tyreTempFront)) this.tyreTempFront = 85;
    if (!Number.isFinite(this.tyreTempRear)) this.tyreTempRear = 85;
    if (!Number.isFinite(this.brakeTempFront)) this.brakeTempFront = Car.BRAKE_TEMP_START;
    if (!Number.isFinite(this.brakeTempRear)) this.brakeTempRear = Car.BRAKE_TEMP_START;
    if (!Number.isFinite(this.ersEnergy)) this.ersEnergy = 0;
    if (!Number.isFinite(this.fuelKg)) this.fuelKg = 0;
    this.eliminate('barrier', 0.45);
  }

  eliminate(reason: 'barrier', penalty: number, keepMomentum = false): void {
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

  /** Gates, laps and splits (LapTiming.ts). */
  private checkTrackProgress(track: Track): LapFinishEvent | null {
    return checkTrackProgress(this, track);
  }

}
