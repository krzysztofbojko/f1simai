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

/** Wreck clearance is measured in completed leader laps, not accelerated wall time. */
export function updateRaceSafety(cars: Car[], track: Track): void {
  const leaderLap = Math.max(0, ...cars.map(c => c.raceLapsCompleted));
  for (const car of cars) {
    if (car.isAlive || car.wreckRemoved) continue;
    if (car.wreckClearLap === null) car.wreckClearLap = leaderLap + (Math.random() < .5 ? 1 : 2);
    if (leaderLap >= car.wreckClearLap) car.wreckRemoved = true;
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

const plans = new WeakMap<Car, { target: Car; lane: number }>();
/** A persistent, bounded offset prevents swerving back into a rival mid-pass. */
export function planRaceLine(car: Car, cars: Car[], track: Track, dt: number): void {
  if (!car.isAlive || car.isManual || car.isPitting || car.surface !== 'asphalt' || car.recoveryTimer > 0) {
    plans.delete(car); car.overtakingTargetName = ''; car.raceLineOffset = 0; return;
  }
  const sample = track.sampleSurface(car.pos), limit = Math.max(0, track.width / 2 - 1.6);
  let plan = plans.get(car);
  // Reset also invalidates persistent plans from an earlier race.
  if (plan && !car.overtakingTargetName && plan.target.isAlive && car.raceLineOffset === 0) plan = undefined;
  if (plan && (plan.target.wreckRemoved || plan.target.isPitting || plan.target.isFinishedRace || (car.yellowFlag && plan.target.isAlive))) plan = undefined;
  const laneFree = (lane: number, target?: Car): boolean => {
    if (Math.abs(lane) > limit) return false;
    // Check the road, and cars alongside or in the entry/exit corridor.
    for (const distance of [0, 12, 25]) {
      const road = track.sampleSurface(sample.center.add(sample.tangent.mul(distance)));
      if (track.sampleSurface(road.center.add(road.tangent.normal().mul(lane))).surface !== 'asphalt') return false;
    }
    return cars.every(other => {
      if (other === car || other.wreckRemoved || other.isPitting || other.isFinishedRace) return true;
      const distance = gap(track, car.pos, other.pos);
      const lateral = track.sampleSurface(other.pos).lateral;
      const reserved = plans.get(other);
      if (other !== target && reserved && (other.raceLineOffset !== 0 || other.overtakingTargetName) && Math.abs(distance) < 22 && Math.abs(reserved.lane - lane) < 2.8) return false;
      return Math.abs(distance) > (other === target ? 50 : 22) || Math.abs(lateral - lane) >= 2.8;
    });
  };
  if (plan && gap(track, car.pos, plan.target.pos) < -9 && laneFree(0)) plan = undefined;
  if (!plan) {
    const target = cars.filter(other => other !== car && !other.wreckRemoved && !other.isPitting && !other.isFinishedRace)
      .map(other => ({other, distance: gap(track, car.pos, other.pos)}))
      .filter(({other,distance}) => distance > 5 && distance < (other.isAlive ? 45 : 100) && (!other.isAlive || (!car.yellowFlag && car.speed >= other.speed - .5 && Math.cos(other.heading - car.heading) > .8)))
      .sort((a,b) => a.distance - b.distance)[0]?.other;
    if (target) {
      const lateral = track.sampleSurface(target.pos).lateral;
      const candidates = [lateral + 3.2, lateral - 3.2].sort((a,b) => Math.abs(a-sample.lateral)-Math.abs(b-sample.lateral));
      const lane = candidates.find(candidate => laneFree(candidate, target));
      if (lane !== undefined) plan = {target,lane};
    }
  }
  const desired = plan ? laneFree(plan.lane, plan.target) ? plan.lane : sample.lateral : laneFree(0) ? 0 : car.raceLineOffset;
  car.raceLineOffset += Math.max(-1.8 * dt, Math.min(1.8 * dt, desired - car.raceLineOffset));
  car.raceLineOffset = Math.max(-limit, Math.min(limit, car.raceLineOffset));
  car.overtakingTargetName = plan?.target.isAlive && !car.yellowFlag ? plan.target.driverName : '';
  if (plan) { plans.set(car,plan); car.lapCompromised = true; } else plans.delete(car);
}
