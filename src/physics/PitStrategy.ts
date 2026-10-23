import { Car } from './Car';
import type { Track } from '../track/Track';
import { Vector2 } from '../math/Vector2';
import { isSlick, nextDryCompound, weatherCompound, wrongForConditions, type TyreCompound } from './Tyres';

/**
 * Pit stops, the same in training, qualifying and the race. A requested stop is taken at the next
 * crossing of the start/finish line: the car leaves the track into the pit lane, loses the time a
 * pass through the lane costs (`Track.pitLaneLoss`, default PIT_LANE_LOSS) plus the tyre change,
 * gets fresh tyres and a repaired nose, and rejoins at the line once the track there is clear.
 * There is no refuelling: a car starts with the fuel for its run and stops only for tyres.
 *
 * The AI strategy stops for worn tyres or tyres wrong for the conditions, never for worn tyres in
 * the last laps of a race, and in a dry race uses two slick compounds (the mandatory stop comes at
 * half distance at the latest).
 */

/** Time lost driving through the pit lane at its speed limit instead of along the straight, s. */
export const PIT_LANE_LOSS = 20;
/** Stationary time of a tyre change, s. */
export const TYRE_CHANGE_TIME = 2.5;
/** Tyre wear (0..1, the worse axle) at which the strategy calls the car in. */
export const PIT_WEAR_LIMIT = 0.7;
/** No stop for worn tyres with this many laps or fewer to go. */
export const PIT_CLOSED_LAPS = 2;
/** Speed limit of the pit lane: the car rejoins at it, m/s. */
export const PIT_EXIT_SPEED = 80 / 3.6;
/** Room (m) the rejoining car needs alongside and ahead of it on the track. */
export const PIT_EXIT_CLEARANCE = 12;
/** A car approaching from behind blocks the exit while it would arrive within this many seconds. */
export const PIT_EXIT_GAP = 1.5;

/** Total length of a stop on `track`: pit-lane loss plus the tyre change. */
export function pitStopDuration(track: Track): number {
  return (track.pitLaneLoss ?? PIT_LANE_LOSS) + TYRE_CHANGE_TIME;
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

/** AI pit request: tyres wrong for the conditions or worn out, or the mandatory stop of a dry race. */
export function updatePitRequest(car: Car): void {
  if (car.isPitting || car.wantsToPit || car.isFinishedRace) return;
  const toGo = lapsToGo(car);
  const wrongTyres = !car.isManual && wrongForConditions(car.tyreCompound, car.wetness);
  const worn = Math.max(car.tyreWearFront, car.tyreWearRear) > PIT_WEAR_LIMIT && toGo > PIT_CLOSED_LAPS;
  const mandatory = !car.isManual && car.raceDistanceLaps > 0 && !compoundRuleMet(car) && toGo <= Math.ceil(car.raceDistanceLaps / 2);
  if (wrongTyres || worn || mandatory) car.wantsToPit = true;
}

/** Compound fitted at the next stop: the player's request, else the strategy for the conditions. */
export function pitCompound(car: Car): TyreCompound {
  if (car.nextCompound) return car.nextCompound;
  const dry = nextDryCompound(car.tyreCompound);
  return weatherCompound(car.wetness, dry);
}

/** The car turns into the pit lane at the line: off the track, out of traffic, for the length of the stop. */
export function enterPits(car: Car, track: Track): void {
  car.isPitting = true;
  car.wantsToPit = false;
  car.pitTimer = pitStopDuration(track);
  car.pitStopsCount++;
}

/**
 * One step in the pit lane: the clocks run, the car stands. When the stop is over it gets its
 * tyres and rejoins at the line, along the track at the pit-lane speed, as soon as no car on the
 * track occupies the exit or would reach it within PIT_EXIT_GAP. `traffic` empty: the exit is free.
 */
export function servicePitStop(car: Car, dt: number, track: Track, traffic: readonly Car[] = []): void {
  car.effectiveThrottle = 0;
  car.fuelBurnRatePerSec = 0;
  car.lateralG = 0;
  car.longitudinalG = 0;
  car.pitTimer = Math.max(0, car.pitTimer - dt);
  car.lapTime += dt;
  if (!car.isFinishedRace) {
    car.totalRaceTime += dt;
  }
  car.framesSinceLastCheckpoint = 0; // Prevent timeout while in the pit lane
  car.resetSuspension();
  car.vel.set(0, 0);
  car.speed = 0;
  car.speedKmh = 0;
  if (car.pitTimer > 0 || !pitExitClear(car, track, traffic)) return;

  car.damage = 0; // nose/wing change during the stop
  car.tyreCompound = pitCompound(car);
  car.usedCompounds.add(car.tyreCompound);
  car.tyreWearFront = car.tyreWearRear = 0; // fresh, pre-heated set
  car.tyreTempFront = car.tyreTempRear = 85;
  car.isPitting = false;
  // Out of the lane along the road at the speed limit; the out-lap holds the stop and is no reference.
  const tangent = roadTangent(car, track);
  car.heading = tangent.heading();
  car.vel.set(tangent.x * PIT_EXIT_SPEED, tangent.y * PIT_EXIT_SPEED);
  car.speed = PIT_EXIT_SPEED;
  car.speedKmh = PIT_EXIT_SPEED * 3.6;
  car.prevPos.set(car.pos.x, car.pos.y);
  car.lapCompromised = true;
}

/** Direction of the road at the car (its heading on a track without a surface model). */
function roadTangent(car: Car, track: Track): Vector2 {
  return track.sampleSurface?.(car.pos).tangent ?? Vector2.fromAngle(car.heading);
}

function pitExitClear(car: Car, track: Track, traffic: readonly Car[]): boolean {
  if (traffic.length === 0) return true;
  const tangent = roadTangent(car, track);
  for (const other of traffic) {
    if (other === car || !other.isAlive || other.wreckRemoved || other.isPitting || other.isFinishedRace) continue;
    const dx = other.pos.x - car.pos.x, dy = other.pos.y - car.pos.y;
    const along = dx * tangent.x + dy * tangent.y;
    if (Math.abs(dx * tangent.y - dy * tangent.x) > track.width) continue;
    const behind = Math.max(PIT_EXIT_CLEARANCE, (other.speed - PIT_EXIT_SPEED) * PIT_EXIT_GAP);
    if (along < PIT_EXIT_CLEARANCE && along > -behind) return false;
  }
  return true;
}
