import { Car } from './Car';
import type { Track } from '../track/Track';
import { Vector2 } from '../math/Vector2';
import { random } from '../math/Random';
import { PIT_SPEED_LIMIT, type PitLane } from '../track/PitLane';
import { passGate } from './LapTiming';
import type { LapFinishEvent } from './Car';
import { isSlick, nextDryCompound, weatherCompound, wrongForConditions, type TyreCompound } from './Tyres';


/**
 * Pit stops, the same in training, qualifying and the race. A car called in leaves the track at the
 * pit entry line before the start/finish straight and drives the pit lane (track/PitLane.ts): down
 * to the 80 km/h limit, to its team's box, where the crew changes the tyres and repairs the car,
 * and out past the exit line back onto the track once it is clear there. The stop costs the time
 * the lane takes plus the service; the lap and sectors are timed in the lane as on the track.
 * There is no refuelling: a car starts with the fuel for its run and stops only for tyres or repairs.
 *
 * The AI strategy stops for worn tyres or tyres wrong for the conditions, never for worn tyres in
 * the last laps of a race, and in a dry race uses two slick compounds (the mandatory stop comes at
 * half distance at the latest).
 */

/** Tyre wear (0..1, the worse axle) at which the strategy calls the car in. */
export const PIT_WEAR_LIMIT = 0.7;
/** No stop for worn tyres with this many laps or fewer to go. */
export const PIT_CLOSED_LAPS = 2;
/** Impact damage (0..1) at which the AI stops for a new nose and wing. */
export const PIT_DAMAGE_LIMIT = 0.5;
/** Pit-lane speed limit, m/s; the car leaves the lane accelerating from it. */
export const PIT_EXIT_SPEED = PIT_SPEED_LIMIT;
/** Room (m) the rejoining car needs alongside and ahead of it on the track. */
export const PIT_EXIT_CLEARANCE = 12;
/** A car approaching from behind blocks the exit while it would arrive within this many seconds. */
export const PIT_EXIT_GAP = 1.5;
/** Seconds the time of a finished stop stays above the car after the exit line. */
export const PIT_SHOW_TIME = 5;

/** Deceleration down to the limit on the entry road, to a stop at the box, and the pull-away, m/s². */
const ENTRY_DECEL = 3 * 9.81, STOP_DECEL = 8, LANE_ACCEL = 6, EXIT_ACCEL = 8;
/** Gap a car in the lane keeps to the one ahead, and where it waits behind its team-mate's box, m. */
const LANE_GAP = 8, QUEUE_GAP = 7;

/** Wheel change at the box per team (Population.F1_TEAMS order), s: the crews differ. */
export const PIT_CREW_BASE = [2.3, 2.4, 2.0, 2.1, 2.5, 2.6, 2.8, 2.3, 2.7, 2.6];
/** Crew time of a car without a team, s. */
const CREW_DEFAULT = 2.4;
/** Damage left for the wheel change, quickly repaired (+1..3 s), or a new nose and wing (+6..9 s). */
export const REPAIR_DAMAGE = 0.1, WING_DAMAGE = 0.25;
/** Chance of a slow stop (a stuck wheel nut, a jack), higher with a nose change; it costs 2..8 s. */
export const SLOW_STOP_CHANCE = 0.04, SLOW_STOP_WING_CHANCE = 0.08;

export type PitPhase = '' | 'lane' | 'queue' | 'service' | 'out';

/** A stop completed at the pit exit line. */
export interface PitStopEvent {
  /** Entry line to exit line, s. */
  laneTime: number;
  /** Stationary at the box, s. */
  serviceTime: number;
  /** What the crew did beyond the tyres: comma-separated 'repair', 'wing', 'slow'. */
  note: string;
  /** Race lap the stop was made on. */
  lap: number;
}

/** Stationary time at the box for this car as it arrives, with what the crew has to do. */
export function serviceTime(car: Car): { time: number; note: string } {
  const notes: string[] = [];
  let time = (PIT_CREW_BASE[car.teamIndex] ?? CREW_DEFAULT) + (random() + random() - 1) * 0.3;
  const damage = car.damage;
  let wing = false;
  if (damage >= WING_DAMAGE) {
    wing = true;
    time += 6 + 3 * Math.min(1, (damage - WING_DAMAGE) / (1 - WING_DAMAGE));
    notes.push('wing');
  } else if (damage >= REPAIR_DAMAGE) {
    time += 1 + 2 * (damage - REPAIR_DAMAGE) / (WING_DAMAGE - REPAIR_DAMAGE);
    notes.push('repair');
  }
  if (random() < (wing ? SLOW_STOP_WING_CHANCE : SLOW_STOP_CHANCE)) {
    time += 2 + 6 * random();
    notes.push('slow');
  }
  return { time, note: notes.join(',') };
}

/** Typical length of a stop on `track`: the lane at its limit plus an average crew. */
export function pitStopDuration(track: Track): number {
  const lane = track.pitLane;
  return (lane ? (lane.exit - lane.entry) / PIT_SPEED_LIMIT : 20) + CREW_DEFAULT;
}

/** Laps still to race, Infinity outside a race. */
export function lapsToGo(car: Car): number {
  return car.raceDistanceLaps > 0 ? car.raceDistanceLaps - car.raceLapsCompleted : Infinity;
}

/** Dry-race tyre rule: two different slick compounds, unless intermediates or wets were fitted. */
export function compoundRuleMet(car: Car): boolean {
  let slicks = 0;
  for (const compound of car.usedCompounds) {
    if (!isSlick(compound)) return true;
    slicks++;
  }
  return slicks >= 2;
}

/** AI pit request: tyres wrong for the conditions or worn out, a damaged car, or the mandatory stop of a dry race. */
export function updatePitRequest(car: Car): void {
  if (car.isPitting || car.wantsToPit || car.isFinishedRace) return;
  const toGo = lapsToGo(car);
  const wrongTyres = !car.isManual && wrongForConditions(car.tyreCompound, car.wetness);
  const worn = Math.max(car.tyreWearFront, car.tyreWearRear) > PIT_WEAR_LIMIT && toGo > PIT_CLOSED_LAPS;
  const damaged = !car.isManual && car.damage >= PIT_DAMAGE_LIMIT && toGo > PIT_CLOSED_LAPS;
  const mandatory = !car.isManual && car.raceDistanceLaps > 0 && !compoundRuleMet(car) && toGo <= Math.ceil(car.raceDistanceLaps / 2);
  if (wrongTyres || worn || damaged || mandatory) car.wantsToPit = true;
}

/** Compound fitted at the next stop: the player's request, else the strategy for the conditions. */
export function pitCompound(car: Car): TyreCompound {
  if (car.nextCompound) return car.nextCompound;
  const dry = nextDryCompound(car.tyreCompound);
  return weatherCompound(car.wetness, dry);
}

/** A car called in turns into the pit lane as it reaches the entry line. */
export function maybeEnterPitLane(car: Car, track: Track): void {
  const lane = track.pitLane;
  if (!lane || !car.wantsToPit || car.isPitting || !car.isAlive || car.isFinishedRace) return;
  const here = track.sampleSurface(car.pos);
  const d = lane.distanceOf(here.index) + here.fraction * track.spacing;
  // A window a few steps long at any speed: the car crosses the line between two steps.
  if (d < lane.entry || d > lane.entry + 15) return;
  car.isPitting = true;
  car.wantsToPit = false;
  car.pitStopsCount++;
  car.pitPhase = 'lane';
  car.pitDistance = d;
  car.pitEntryOffset = here.lateral;
  car.pitLaneTime = (d - lane.entry) / Math.max(1, car.speed);
  car.pitServiceTime = 0;
  car.pitNote = '';
  car.pitTimer = 0;
}

/** Where a car in the lane must stop next: its box, behind its team-mate there, behind the car ahead, or at the exit. */
function stopPoint(car: Car, lane: PitLane, track: Track, traffic: readonly Car[]): number {
  const box = lane.boxes[car.teamIndex >= 0 ? car.teamIndex % lane.boxes.length : Math.floor(lane.boxes.length / 2)];
  let stop = car.pitPhase === 'out' ? (pitExitClear(car, lane, track, traffic) ? Infinity : lane.exit - 0.5) : box;
  for (const other of traffic) {
    if (other === car || !other.isPitting || other.pitDistance <= car.pitDistance) continue;
    stop = Math.min(stop, other.pitDistance - LANE_GAP);
    // Double stack: the team-mate is at the box or on the way to it.
    if (car.pitPhase !== 'out' && other.teamIndex === car.teamIndex && car.teamIndex >= 0 && other.pitPhase !== 'out' && other.pitDistance <= box + 0.5) {
      stop = Math.min(stop, box - QUEUE_GAP);
    }
  }
  return stop;
}

/** Fastest speed at distance `d` in the lane: the limit between the limiter lines, a braking curve down to it before. */
function laneSpeedCap(lane: PitLane, d: number): number {
  if (d < lane.limiterStart) return Math.sqrt(PIT_SPEED_LIMIT * PIT_SPEED_LIMIT + 2 * ENTRY_DECEL * (lane.limiterStart - d));
  return d <= lane.limiterEnd ? PIT_SPEED_LIMIT : Infinity;
}

/**
 * One step in the pit lane: the car drives the lane at its limit to its box, stands for the service,
 * and leaves past the exit line when the track there is clear. The gates and the start/finish line
 * it runs beside are timed as on the track. `traffic` empty: nobody else in the lane, the exit is free.
 */
export function servicePitStop(car: Car, dt: number, track: Track, traffic: readonly Car[] = []): LapFinishEvent | null {
  const lane = track.pitLane;
  car.effectiveThrottle = 0;
  car.fuelBurnRatePerSec = 0;
  car.lateralG = 0;
  car.longitudinalG = 0;
  car.lapTime += dt;
  if (!car.isFinishedRace) car.totalRaceTime += dt;
  car.framesSinceLastCheckpoint = 0; // Prevent timeout while in the pit lane
  car.settleChassis();
  if (!lane) { finishService(car); rejoin(car, track, null); return null; }
  car.pitLaneTime += dt;

  if (car.pitPhase === 'service') {
    car.pitTimer = Math.max(0, car.pitTimer - dt);
    if (car.pitTimer > 0) { car.vel.set(0, 0); car.speed = car.speedKmh = 0; return null; }
    finishService(car);
    car.pitPhase = 'out';
  }

  const before = car.pitDistance, v0 = car.speed;
  const stop = stopPoint(car, lane, track, traffic), remaining = Math.max(0, stop - before);
  // Capped where the car will be at the end of the step too, so the limiter line is never crossed fast.
  const cap = Math.min(laneSpeedCap(lane, before), laneSpeedCap(lane, before + v0 * dt));
  const accel = before >= lane.limiterEnd ? EXIT_ACCEL : LANE_ACCEL, decel = before < lane.limiterStart ? ENTRY_DECEL : STOP_DECEL;
  let d: number, speed: number, stoppedFor = 0;
  if (v0 > 0 && v0 <= cap + 1e-9 && v0 * v0 >= 2 * STOP_DECEL * remaining) {
    // On the braking curve to the stopping point: the constant deceleration that ends exactly there,
    // so the stop does not depend on the step rate. The rest of the step is spent standing.
    const toStop = 2 * remaining / v0;
    if (toStop <= dt) { d = stop; speed = 0; stoppedFor = dt - toStop; }
    else { speed = v0 - v0 * v0 / (2 * remaining) * dt; d = before + (v0 + speed) / 2 * dt; }
  } else {
    speed = v0 > cap ? Math.max(cap, v0 - decel * dt) : Math.min(cap, v0 + accel * dt);
    // Pulling away towards a stop that is close: never past it.
    speed = Math.min(speed, Math.sqrt(2 * STOP_DECEL * remaining));
    d = Math.min(stop, before + (v0 + speed) / 2 * dt);
    if (d >= stop) speed = 0;
  }
  car.pitDistance = d;

  // Arrived at the box: the crew starts work.
  const box = lane.boxes[car.teamIndex >= 0 ? car.teamIndex % lane.boxes.length : Math.floor(lane.boxes.length / 2)];
  if (car.pitPhase !== 'out' && speed === 0 && Math.abs(d - box) < 0.5) {
    const service = serviceTime(car);
    car.pitPhase = 'service';
    car.pitServiceTime = service.time;
    car.pitTimer = Math.max(0, service.time - stoppedFor);
    car.pitNote = service.note;
  } else if (car.pitPhase === 'lane' && speed === 0) car.pitPhase = 'queue';
  else if (car.pitPhase === 'queue' && speed > 0) car.pitPhase = 'lane';

  const pose = lane.pose(d, car.pitEntryOffset);
  car.prevPos.set(car.pos.x, car.pos.y);
  car.pos = pose.pos;
  car.heading = pose.heading;
  car.vel.set(Math.cos(pose.heading) * speed, Math.sin(pose.heading) * speed);
  car.speed = speed;
  car.speedKmh = speed * 3.6;

  // Gates beside the lane, in order, each timed where the car passed it within the step.
  let event: LapFinishEvent | null = null;
  for (let guard = 0; guard < 4 && d > before; guard++) {
    const gate = track.checkpoints[car.currentCheckpointIdx % track.checkpoints.length];
    const at = lane.distanceOf(gate.index);
    if (at <= before || at > d) break;
    event = passGate(car, track, (at - before) / (d - before)) ?? event;
  }

  if (car.pitPhase === 'out' && d >= lane.exit) {
    // The exit line was crossed within the step: the lane time ends there.
    car.pitLaneTime -= (d - lane.exit) / Math.max(1, (v0 + speed) / 2);
    rejoin(car, track, lane);
  }
  return event;
}

/** Fresh tyres and a repaired car as the service ends. */
function finishService(car: Car): void {
  car.damage = 0;
  car.tyreCompound = pitCompound(car);
  car.usedCompounds.add(car.tyreCompound);
  car.tyreWearFront = car.tyreWearRear = 0; // fresh, pre-heated set
  car.tyreTempFront = car.tyreTempRear = 85;
}

/** Past the exit line: back on the track at the lane's speed, the stop shown above the car for a while. */
function rejoin(car: Car, track: Track, lane: PitLane | null): void {
  car.isPitting = false;
  car.pitPhase = '';
  car.pitTimer = 0;
  if (lane) {
    const tangent = Vector2.fromAngle(car.heading);
    const speed = Math.max(car.speed, PIT_EXIT_SPEED);
    car.vel.set(tangent.x * speed, tangent.y * speed);
    car.speed = speed;
    car.speedKmh = speed * 3.6;
  } else {
    const tangent = roadTangent(car, track);
    car.heading = tangent.heading();
    car.vel.set(tangent.x * PIT_EXIT_SPEED, tangent.y * PIT_EXIT_SPEED);
    car.speed = PIT_EXIT_SPEED;
    car.speedKmh = PIT_EXIT_SPEED * 3.6;
  }
  car.prevPos.set(car.pos.x, car.pos.y);
  car.lastPitLaneTime = car.pitLaneTime;
  car.lastPitServiceTime = car.pitServiceTime;
  car.lastPitNote = car.pitNote;
  car.pitShowTimer = PIT_SHOW_TIME;
  car.pitStopEvent = { laneTime: car.pitLaneTime, serviceTime: car.pitServiceTime, note: car.pitNote, lap: car.raceLapsCompleted + 1 };
  // The out-lap holds the stop and is no reference; the car merges onto its line from the pit-side edge.
  car.lapCompromised = true;
  car.raceLineFresh = true;
}

/** Direction of the road at the car (its heading on a track without a surface model). */
function roadTangent(car: Car, track: Track): Vector2 {
  return track.sampleSurface?.(car.pos).tangent ?? Vector2.fromAngle(car.heading);
}

function pitExitClear(car: Car, lane: PitLane, track: Track, traffic: readonly Car[]): boolean {
  if (traffic.length === 0) return true;
  const at = lane.point(lane.exit, lane.side * lane.rejoinOffset);
  const tangent = track.sampleSurface(at).tangent;
  for (const other of traffic) {
    if (other === car || !other.isAlive || other.wreckRemoved || other.isPitting || other.isFinishedRace) continue;
    const dx = other.pos.x - at.x, dy = other.pos.y - at.y;
    const along = dx * tangent.x + dy * tangent.y;
    if (Math.abs(dx * tangent.y - dy * tangent.x) > track.width) continue;
    const behind = Math.max(PIT_EXIT_CLEARANCE, (other.speed - PIT_EXIT_SPEED) * PIT_EXIT_GAP);
    if (along < PIT_EXIT_CLEARANCE && along > -behind) return false;
  }
  return true;
}
