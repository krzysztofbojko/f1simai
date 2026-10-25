import { Car, type CarControl, type CheckpointDelta } from '../physics/Car';
import type { TyreCompound } from '../physics/Tyres';
import type { PitPhase } from '../physics/PitStrategy';
import { Vector2 } from '../math/Vector2';

export interface SerializedRay {
  x: number;
  y: number;
  dist: number;
}

/**
 * One car as the display sees it: the worker builds it from the simulated car for every
 * snapshot (`toCarView`), the main thread copies it onto its display car (`applyCarView`).
 */
export interface CarView {
  id: number;
  color: string;
  driverName: string;
  x: number;
  y: number;
  angle: number;
  speedKmh: number;
  isAlive: boolean;
  surface: Car['surface'];
  surfaceFractions: Car['surfaceFractions'];
  eliminationReason: Car['eliminationReason'];
  barrierImpactSpeed: number;
  damage: number;
  ersSoc: number;
  gear: number;
  rideHeightFront: number;
  rideHeightRear: number;
  /** Sprung-mass heave (m), pitch and roll (rad), for the 3D body motion. */
  heave: number;
  pitch: number;
  roll: number;
  /** Road-wheel steering angle (rad, + = right) as the actuator delivers it, for the 3D front wheels. */
  wheelAngle: number;
  aeroStall: boolean;
  wakeDrag: number;
  plankForce: number;
  porpoisingHz: number;
  wakeDownforce: number;
  engineRpm: number;
  tyreTempFront: number;
  tyreTempRear: number;
  tyreWearFront: number;
  tyreWearRear: number;
  tyreCompound: TyreCompound;
  brakeTempFront: number;
  brakeTempRear: number;
  wheelLockFront: boolean;
  wheelLockRear: boolean;
  aquaplaning: number;
  incidentActive: boolean;
  battleOpponent: string;
  overtakingTargetName: string;
  racingLineLabel: string;
  driverPressure: number;
  effectiveDriverPressure: number;
  bestLapPressure: number;
  yellowFlag: boolean;
  wreckRemoved: boolean;
  recoveryTimer: number;
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
  isSliding: boolean;
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
  pitPhase: PitPhase;
  pitLaneTime: number;
  lastPitLaneTime: number | null;
  lastPitServiceTime: number;
  lastPitNote: string;
  pitShowTimer: number;
  teamIndex: number;
  trackLimitExits: number;
  raceLapsCompleted: number;
}

/** Snapshot of one car; reads the car only. Headless snapshots leave out skid marks and rays. */
export function toCarView(car: Car, ctrl?: CarControl, isHeadless: boolean = false): CarView {
  const delta: CheckpointDelta | null = car.lastCheckpointDelta ? { ...car.lastCheckpointDelta } : null;
  return {
    id: car.id,
    color: car.color,
    driverName: car.driverName,
    x: car.pos.x,
    y: car.pos.y,
    angle: car.heading,
    speedKmh: car.speedKmh,
    isAlive: car.isAlive,
    surface: car.surface,
    surfaceFractions: { ...car.surfaceFractions },
    eliminationReason: car.eliminationReason,
    barrierImpactSpeed: car.barrierImpactSpeed,
    damage: car.damage,
    ersSoc: Math.round(car.ersEnergy / Car.ERS_CAPACITY * 100) / 100,
    gear: car.gear,
    rideHeightFront: Math.round(car.rideHeightFront * 10000) / 10,
    rideHeightRear: Math.round(car.rideHeightRear * 10000) / 10,
    heave: car.heave,
    pitch: car.pitch,
    roll: car.roll,
    wheelAngle: car.wheelAngle,
    aeroStall: car.aeroStall,
    wakeDrag: Math.round(car.wakeDrag * 100) / 100,
    plankForce: Math.round(car.plankForce),
    porpoisingHz: Math.round(car.porpoisingHz * 10) / 10,
    wakeDownforce: Math.round(car.wakeDownforce * 100) / 100,
    engineRpm: Math.round(car.engineRpm),
    tyreTempFront: Math.round(car.tyreTempFront),
    tyreTempRear: Math.round(car.tyreTempRear),
    tyreWearFront: Math.round(car.tyreWearFront * 1000) / 1000,
    tyreWearRear: Math.round(car.tyreWearRear * 1000) / 1000,
    tyreCompound: car.tyreCompound,
    brakeTempFront: Math.round(car.brakeTempFront),
    brakeTempRear: Math.round(car.brakeTempRear),
    wheelLockFront: car.wheelLockFront,
    wheelLockRear: car.wheelLockRear,
    aquaplaning: Math.round(car.aquaplaning * 100) / 100,
    incidentActive: car.incidentActive,
    battleOpponent: car.battleOpponent,
    overtakingTargetName: car.overtakingTargetName,
    racingLineLabel: car.racingLineLabel,
    driverPressure: car.driverPressure,
    effectiveDriverPressure: car.effectiveDriverPressure,
    bestLapPressure: car.bestLapPressure,
    yellowFlag: car.yellowFlag,
    wreckRemoved: car.wreckRemoved,
    recoveryTimer: car.recoveryTimer,
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
    isSliding: car.isSliding,
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
    pitPhase: car.pitPhase,
    pitLaneTime: car.pitLaneTime,
    lastPitLaneTime: car.lastPitLaneTime,
    lastPitServiceTime: car.lastPitServiceTime,
    lastPitNote: car.lastPitNote,
    pitShowTimer: car.pitShowTimer,
    teamIndex: car.teamIndex,
    trackLimitExits: car.trackLimitExits,
    raceLapsCompleted: car.raceLapsCompleted
  };
}

const unit = (v: unknown, min: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(1, v)) : 0;

/** A view's controls, clamped to their ranges (non-finite values read as 0). */
function validControl(ctrl: CarControl | undefined): CarControl {
  return { steer: unit(ctrl?.steer, -1), throttle: unit(ctrl?.throttle, 0), brake: unit(ctrl?.brake, 0) };
}

/** Copies a snapshot view onto the main thread's display car. A best lap only ever improves here. */
export function applyCarView(car: Car, view: CarView): void {
  car.pos.x = view.x;
  car.pos.y = view.y;
  car.heading = view.angle;
  car.speedKmh = view.speedKmh;
  car.isAlive = view.isAlive;
  car.surface = view.surface;
  car.surfaceFractions = { ...view.surfaceFractions };
  car.eliminationReason = view.eliminationReason;
  car.barrierImpactSpeed = view.barrierImpactSpeed;
  car.damage = view.damage ?? 0;
  car.ersEnergy = (view.ersSoc ?? 0.85) * Car.ERS_CAPACITY;
  car.gear = view.gear ?? 1;
  car.engineRpm = view.engineRpm ?? Car.IDLE_RPM;
  car.rideHeightFront = (view.rideHeightFront ?? 30) / 1000;
  car.rideHeightRear = (view.rideHeightRear ?? 55) / 1000;
  car.aeroStall = !!view.aeroStall;
  car.heave = view.heave ?? 0;
  car.pitch = view.pitch ?? 0;
  car.roll = view.roll ?? 0;
  car.wheelAngle = view.wheelAngle ?? 0;
  car.wakeDrag = view.wakeDrag ?? 1;
  car.wakeDownforce = view.wakeDownforce ?? 1;
  car.plankForce = view.plankForce ?? 0;
  car.porpoisingHz = view.porpoisingHz ?? 0;
  car.tyreTempFront = view.tyreTempFront ?? 100;
  car.tyreTempRear = view.tyreTempRear ?? 100;
  car.tyreWearFront = view.tyreWearFront ?? 0;
  car.tyreWearRear = view.tyreWearRear ?? 0;
  car.tyreCompound = view.tyreCompound ?? 'medium';
  car.brakeTempFront = view.brakeTempFront ?? Car.BRAKE_TEMP_START;
  car.brakeTempRear = view.brakeTempRear ?? Car.BRAKE_TEMP_START;
  car.wheelLockFront = view.wheelLockFront ?? false;
  car.wheelLockRear = view.wheelLockRear ?? false;
  car.aquaplaning = view.aquaplaning ?? 0;
  car.incidentActive = view.incidentActive;
  car.battleOpponent = view.battleOpponent;
  car.overtakingTargetName = view.overtakingTargetName;
  car.racingLineLabel = view.racingLineLabel;
  car.driverPressure = view.driverPressure;
  car.effectiveDriverPressure = view.effectiveDriverPressure;
  car.bestLapPressure = view.bestLapPressure;
  car.yellowFlag = view.yellowFlag;
  car.wreckRemoved = view.wreckRemoved;
  car.recoveryTimer = view.recoveryTimer;
  car.isManual = view.isManual;
  const ctrl = validControl(view.ctrl);
  car.currentControl = ctrl;
  if (car.isManual) car.manualControl = { ...ctrl };
  car.effectiveThrottle = unit(view.effectiveThrottle, 0);
  car.fitness = view.fitness;
  car.currentLap = view.currentLap;
  car.lapTime = view.lapTime;
  car.lastLapTime = view.lastLapTime;
  if (typeof view.bestLapTime === 'number' && view.bestLapTime > 0 && (!car.bestLapTime || view.bestLapTime < car.bestLapTime)) {
    car.bestLapTime = view.bestLapTime;
  }
  car.fuelKg = view.fuelKg;
  car.lateralG = view.lateralG;
  car.longitudinalG = view.longitudinalG;
  car.weightFrontRatio = view.weightFrontRatio;
  car.brakingAggression = view.brakingAggression;
  car.understeerSlip = view.understeerSlip;
  car.oversteerSlip = view.oversteerSlip;
  car.isSkidding = view.isSkidding;
  car.isSliding = view.isSliding;
  car.skidMarks = view.skidMarks.map(m => new Vector2(m.x, m.y));
  car.rayHits = view.sensorRays.map(r => ({ point: new Vector2(r.x, r.y), dist: r.dist }));
  if (view.currentSplits) car.currentLapSplits = [...view.currentSplits];
  if (view.bestSplits) car.bestLapSplits = [...view.bestSplits];
  car.lastCheckpointDelta = view.lastCheckpointDelta ? { ...view.lastCheckpointDelta } : null;
  car.wantsToPit = view.wantsToPit;
  car.isPitting = view.isPitting;
  car.pitTimer = view.pitTimer;
  car.pitStopsCount = view.pitStopsCount;
  car.pitPhase = view.pitPhase ?? '';
  car.pitLaneTime = view.pitLaneTime ?? 0;
  car.lastPitLaneTime = view.lastPitLaneTime ?? null;
  car.lastPitServiceTime = view.lastPitServiceTime ?? 0;
  car.lastPitNote = view.lastPitNote ?? '';
  car.pitShowTimer = view.pitShowTimer ?? 0;
  car.teamIndex = view.teamIndex ?? -1;
  car.trackLimitExits = view.trackLimitExits ?? 0;
  car.raceLapsCompleted = view.raceLapsCompleted;
}
