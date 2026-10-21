import { Car } from '../physics/Car';
import { Track } from '../track/Track';
import { Vector2 } from '../math/Vector2';

const lengths = new WeakMap<Track, number[]>();
function progress(track: Track, pos: Vector2): number {
  let cumulative = lengths.get(track);
  if (!cumulative) {
    cumulative = [0];
    for (let i = 0; i < track.points.length; i++) cumulative.push(cumulative[i] + track.points[i].center.dist(track.points[(i + 1) % track.points.length].center));
    lengths.set(track, cumulative);
  }
  const sample = track.sampleSurface(pos);
  return cumulative[sample.index] + sample.fraction * (cumulative[sample.index + 1] - cumulative[sample.index]);
}
export function gap(track: Track, from: Vector2, to: Vector2): number {
  const total = lengths.get(track)?.at(-1) ?? track.totalLength;
  const d = progress(track, to) - progress(track, from);
  return ((d + total / 2) % total + total) % total - total / 2;
}

/** Marshals clear a wreck this many seconds of simulation time after the accident. */
export const WRECK_CLEAR_SECONDS = 15;

/** A crashed car stays on track as a local hazard under yellow flags, then marshals remove it. */
export function updateRaceSafety(cars: Car[], track: Track, dt = 0): void {
  const elapsed = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  for (const car of cars) {
    if (car.isAlive || car.wreckRemoved) continue;
    car.wreckAge += elapsed;
    if (car.wreckAge >= WRECK_CLEAR_SECONDS) car.wreckRemoved = true;
  }
  const wrecks = cars.filter(c => !c.isAlive && !c.wreckRemoved && !c.isPitting && !c.isFinishedRace);
  for (const car of cars) {
    car.yellowFlag = car.isAlive && wrecks.some(wreck => {
      const distance = gap(track, car.pos, wreck.pos);
      return distance >= -30 && distance <= 200;
    });
    if (car.yellowFlag) {
      car.battlePush.remaining = 0;
      car.battleOpponent = '';
      car.lapCompromised = true;
      car.replayBuffer = [];
    }
  }
}

/** A pass: this side of the rival (±1) at this clearance; `lane` is where that is right now. */
const plans = new WeakMap<Car, { target: Car; side: number; clearance: number; lane: number }>();
/** A defender's single move to the inside before a braking zone, held until the corner is behind it. */
const defences = new WeakMap<Car, { shift: number; inCorner: boolean }>();
/** Moves off the line are spread over distance: about 3 m of lateral over 50 m of track, */
export const LANE_CHANGE_PER_METRE = 0.06;
/** at least this fast sideways (m/s) so a slow car can still steer round a wreck in time, */
export const LANE_CHANGE_MIN_RATE = 1.8;
/** and never faster than this, which keeps a lane change at speed under ~2 g. */
export const LANE_CHANGE_MAX_RATE = 2.5;
/** Lateral metres a planned shift moves per metre travelled at `speed`. */
export function laneChangePerMetre(speed: number): number {
  return Math.max(LANE_CHANGE_MIN_RATE, Math.min(LANE_CHANGE_MAX_RATE, LANE_CHANGE_PER_METRE * speed)) / Math.max(1, speed);
}
/** With the next corner further than this, a follower sits in the tow and pulls out late. */
export const TOW_STRAIGHT = 200;
/** Gap (m) at which a car in the tow pulls out to pass on a straight. */
export const TOW_PULL_OUT = 18;

/**
 * Lateral plan per car: the precomputed racing line plus the driver's learned shift, then the race
 * situation on top: pass (preferring the inside of the next corner), tow on straights, defend the
 * inside before a braking zone, and step out of the dirty air in fast corners. Every move is a
 * bounded, persistent shift from the line, so the car keeps the line's shape through a corner and
 * never swerves back into a rival mid-pass.
 */
export function planRaceLine(car: Car, cars: Car[], track: Track, dt: number): void {
  const sample = track.sampleSurface(car.pos), line = car.racingLine(track), bounds = line.limits(sample.index);
  const onLine = line.offsetAt(sample.index, sample.fraction);
  if (!car.isAlive || car.isManual || car.isPitting || !car.withinTrackLimits || car.recoveryTimer > 0) {
    // Hold the car's own position relative to the line; it merges back gradually once it may race again.
    plans.delete(car); defences.delete(car); car.overtakingTargetName = '';
    car.raceLineBaseline = onLine;
    car.raceLineOffset = Math.max(bounds.lower, Math.min(bounds.upper, sample.lateral));
    car.lineDeviation = Math.abs(car.raceLineOffset - onLine);
    return;
  }
  const limit = Math.max(0, track.width / 2 - 1.3);
  const learned = car.lineNet?.target(track, car, car.isRaceMode) ?? 0;
  const baseline = Math.max(bounds.lower, Math.min(bounds.upper, onLine + learned));
  car.racingLineLabel = car.lineNet ? `LINIA ML · ${baseline.toFixed(1)} m` : `LINIA · ${baseline.toFixed(1)} m`;
  const cornerAhead = line.cornerDistance[sample.index], turn = line.cornerSign[sample.index];
  /** This car's line (with its learned style) where `pos` is. */
  const lineAt = (pos: Vector2) => { const there = track.sampleSurface(pos); return line.offsetAt(there.index, there.fraction) + learned; };
  let plan = plans.get(car);
  if (car.raceLineFresh) {
    // From the grid or a respawn the car keeps its lane and merges onto the line gradually.
    // A reset also invalidates persistent plans from an earlier race.
    car.raceLineFresh = false;
    car.raceLineBaseline = baseline;
    car.raceLineOffset = Math.max(-limit, Math.min(limit, sample.lateral));
    plan = undefined;
    plans.delete(car); defences.delete(car);
  }
  if (plan && (plan.target.wreckRemoved || plan.target.isPitting || plan.target.isFinishedRace || (car.yellowFlag && plan.target.isAlive))) plan = undefined;
  /** Can the car drive its line shifted by `shift` metres: on asphalt, and clear of the cars around it where they are? */
  const laneFree = (shift: number, target?: Car): boolean => {
    if (Math.abs(baseline + shift) > Math.max(limit, Math.abs(baseline)) + 1e-6) return false;
    // Check the road, and cars alongside or in the entry/exit corridor.
    for (const distance of [0, 12, 25]) {
      const road = track.sampleSurface(sample.center.add(sample.tangent.mul(distance)));
      const lateral = line.offsetAt(road.index, road.fraction) + learned + shift;
      if (track.sampleSurface(road.center.add(road.tangent.normal().mul(lateral))).surface !== 'asphalt') return false;
    }
    return cars.every(other => {
      if (other === car || other.wreckRemoved || other.isPitting || other.isFinishedRace) return true;
      const distance = gap(track, car.pos, other.pos);
      if (distance < -5.5 || Math.abs(distance) > (other === target ? 50 : 22)) return true;
      // Compared where the other car is: the line may run elsewhere there than under this car.
      const lane = lineAt(other.pos) + shift;
      const reserved = plans.get(other);
      // A follower's future lane cannot block the queue leader from bypassing a wreck.
      // Protect adjacent bodies; a car ahead may be followed into its lane. A car more than one body
      // length behind must yield, rather than veto the leader's escape lane.
      if (other !== target && reserved && distance < 8 && Math.abs(reserved.lane - lane) < 2.8) return false;
      return Math.abs(track.sampleSurface(other.pos).lateral - lane) >= 2.8;
    });
  };
  if (plan && gap(track, car.pos, plan.target.pos) < -9 && laneFree(0)) plan = undefined;
  const ahead = cars.filter(other => other !== car && !other.wreckRemoved && !other.isPitting && !other.isFinishedRace)
    .map(other => ({ other, distance: gap(track, car.pos, other.pos) }))
    .filter(({ other, distance }) => distance > 5 && distance < (other.isAlive ? 70 : 100) && (!other.isAlive || Math.cos(other.heading - car.heading) > .8))
    .sort((a, b) => a.distance - b.distance);
  // Nearest running car ahead in the same direction: the one to tow behind or keep out of the wake of.
  const leader = ahead.find(({ other }) => other.isAlive);
  // On a long straight a race car stays in the tow and only pulls out close behind.
  const towing = car.isRaceMode && cornerAhead > TOW_STRAIGHT;
  if (!plan) {
    // A wreck to bypass, or a slower car to pass (never under yellow).
    const pass = ahead.find(({ other, distance }) => !other.isAlive
      || (distance < (towing ? TOW_PULL_OUT : 45) && !car.yellowFlag && car.speed >= other.speed - .5));
    const target = pass?.other;
    if (target) {
      const lateral = track.sampleSurface(target.pos).lateral, there = lineAt(target.pos);
      // Wreck bypasses need extra clearance for the curved approach, not just body width.
      const clearance = target.isAlive ? 3.2 : 4.2;
      // Into a corner the pass goes down the inside; elsewhere the side nearer to the car.
      const inside = target.isAlive && turn !== 0 && cornerAhead < 250 ? turn : 0;
      // A side squeezed against the white line is no room to pass (unless a wreck leaves no choice).
      const sides = [1, -1].map(side => ({ side, lane: Math.max(-limit, Math.min(limit, lateral + side * clearance)) }))
        .filter(({ side, lane }) => !target.isAlive || lane === lateral + side * clearance)
        .sort((a, b) => (b.side === inside ? 1 : 0) - (a.side === inside ? 1 : 0) || Math.abs(a.lane - sample.lateral) - Math.abs(b.lane - sample.lateral));
      const chosen = sides.find(candidate => laneFree(candidate.lane - there, target));
      if (chosen) plan = { target, side: chosen.side, clearance, lane: chosen.lane };
    }
  }
  if (plan) defences.delete(car);
  let defence = defences.get(car);
  if (defence) {
    if (cornerAhead === 0) defence.inCorner = true;
    else if (defence.inCorner) { defences.delete(car); defence = undefined; }
  }
  if (!plan && !defence && car.isRaceMode && !car.yellowFlag && turn !== 0 && cornerAhead > 60 && cornerAhead < 220 && car.currentControl.brake < 0.05) {
    // One move, made before the braking zone and never under braking: cover the inside of the next corner.
    const attacker = cars.some(other => {
      if (other === car || !other.isAlive || other.isPitting || other.isFinishedRace) return false;
      const distance = gap(track, car.pos, other.pos);
      return distance > -25 && distance < -4 && other.speed >= car.speed - 3;
    });
    const shift = turn * limit * 0.7 - baseline;
    if (attacker && Math.sign(shift) === turn && laneFree(shift)) defences.set(car, defence = { shift, inCorner: false });
  }
  const shift = car.raceLineOffset - car.raceLineBaseline;
  // NaN: the wanted lane is taken, so the car holds its lateral position (not its shift from a line that moves).
  const hold = NaN;
  let desired: number;
  if (plan) {
    // Beside the rival where it is now (it follows its own line), measured at the rival's position.
    plan.lane = Math.max(-limit, Math.min(limit, track.sampleSurface(plan.target.pos).lateral + plan.side * plan.clearance));
    const there = plan.lane - lineAt(plan.target.pos);
    desired = laneFree(there, plan.target) ? there : hold;
  }
  else if (defence) desired = laneFree(defence.shift) ? defence.shift : hold;
  else {
    desired = 0;
    const ahead = leader?.other.isAlive && !car.yellowFlag ? leader : undefined;
    const leaderLateral = ahead ? track.sampleSurface(ahead.other.pos).lateral : 0, leaderLine = ahead ? lineAt(ahead.other.pos) : 0;
    if (ahead && towing) desired = leaderLateral - leaderLine;
    else if (ahead && ahead.distance < 30 && cornerAhead === 0 && Math.abs(line.curvature[sample.index]) < 1 / 150 && Math.abs(leaderLateral - leaderLine) < 1.6) {
      // Fast corner in the wake: a slightly different line keeps air on the front wing.
      desired = leaderLateral > leaderLine ? -1 : 1;
    }
    if (!laneFree(desired)) desired = laneFree(0) ? 0 : hold;
  }
  // The shift moves at a bounded rate per metre travelled; the line itself is followed exactly.
  const step = laneChangePerMetre(car.speed) * Math.max(1, car.speed) * dt;
  const next = Number.isNaN(desired) ? car.raceLineOffset - baseline : shift + Math.max(-step, Math.min(step, desired - shift));
  car.raceLineBaseline = baseline;
  car.raceLineOffset = Math.max(-Math.max(limit, -bounds.lower), Math.min(Math.max(limit, bounds.upper), baseline + next));
  car.lineDeviation = Math.abs(car.raceLineOffset - baseline);
  car.overtakingTargetName = plan?.target.isAlive && !car.yellowFlag ? plan.target.driverName : '';
  if (plan) {
    plans.set(car,plan);
    // In training a pass is normal pack driving: slow laps never beat a best, and contacts/off-track still disqualify.
    // In a race the lap is flagged as before.
    if (car.isRaceMode) car.lapCompromised = true;
  } else plans.delete(car);
}
