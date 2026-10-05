import { gap as trackGap } from '../ai/RaceTraffic';
import { Track } from '../track/Track';
import { Car, type CarControl } from './Car';
import { Vector2 } from '../math/Vector2';

export interface Motion { pos: Vector2; heading: number }
export function captureMotion(cars: Car[]): Map<Car, Motion> {
  return new Map(cars.map(c => [c, { pos: c.pos.clone(), heading: c.heading }]));
}

/** Brake for any vehicle occupying the forward corridor, including stopped cars. */
export function avoidTraffic(car: Car, cars: Car[], control: CarControl, track?: Track): CarControl {
  car.trafficWaiting = false;
  if (car.isPitting) return control;
  if (car.isManual && !car.yellowFlag) return control;
  const forward = Vector2.fromAngle(car.heading);
  const road = track?.sampleSurface(car.pos);
  let brake = car.yellowFlag && car.speed > 22 ? Math.min(1, .3 + (car.speed - 22) / 8) : 0;
  for (const other of cars) {
    if (other === car || other.wreckRemoved || other.isPitting || other.isFinishedRace) continue;
    const offset = other.pos.sub(car.pos), ahead = track ? trackGap(track, car.pos, other.pos) : offset.dot(forward);
    const lateral = track && road ? track.sampleSurface(other.pos).lateral - road.lateral : offset.cross(forward);
    if (ahead <= 0 || Math.abs(lateral) > (car.yellowFlag && other.isAlive ? 16 : 2.2)) continue;
    const closing = Math.max(0, track ? car.speed - (other.isAlive ? other.speed : 0) : car.vel.sub(other.vel).dot(forward));
    const gap = ahead - 5.5;
    const safeGap = 2 + car.speed * .25 + closing * closing / 12;
    if (gap < safeGap) {
      brake = Math.max(brake, Math.min(1, .25 + (safeGap - gap) / Math.max(3, safeGap)));
      car.trafficWaiting = car.speed < 3;
    }
  }
  if (!brake) return control;
  car.battlePush.remaining = 0;
  car.battleOpponent = '';
  car.replayBuffer = [];
  return { ...control, throttle: 0, brake: Math.max(control.brake, brake) };
}

// Continuous separating-axis test for oriented 5.5 × 1.8 m physical bodies.
// Angular substeps bound rotational motion; translation is swept analytically.
function contact(a: Car, b: Car, ma: Motion, mb: Motion): { time: number; normal: Vector2 } | null {
  const da = a.pos.sub(ma.pos), db = b.pos.sub(mb.pos);
  const turnA = a.heading - ma.heading, turnB = b.heading - mb.heading;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(turnA), Math.abs(turnB)) / .02));
  for (let step = 0; step < steps; step++) {
    const start = step / steps, end = (step + 1) / steps;
    const fa = Vector2.fromAngle(ma.heading + turnA * (start + end) / 2), ra = fa.normal();
    const fb = Vector2.fromAngle(mb.heading + turnB * (start + end) / 2), rb = fb.normal();
    const offset = mb.pos.sub(ma.pos), delta = db.sub(da);
    let enter = start, leave = end, normal = offset.normalize(), smallest = Infinity;
    let valid = true;
    for (const axis of [fa, ra, fb, rb]) {
      const radius = 2.75 * (Math.abs(fa.dot(axis)) + Math.abs(fb.dot(axis))) + .9 * (Math.abs(ra.dot(axis)) + Math.abs(rb.dot(axis)))
        + 2.9 * (Math.abs(turnA) + Math.abs(turnB)) / (2 * steps);
      const d = offset.dot(axis), v = delta.dot(axis);
      const penetration = radius - Math.abs(d + v * start);
      if (penetration < smallest) { smallest = penetration; normal = axis.mul(d + v * start >= 0 ? 1 : -1); }
      if (Math.abs(v) < 1e-10) { if (Math.abs(d) > radius) { valid = false; break; } }
      else {
        const t1 = (-radius - d) / v, t2 = (radius - d) / v;
        const near = Math.min(t1, t2), far = Math.max(t1, t2);
        if (near > enter) { enter = near; normal = axis.mul(d + v * near >= 0 ? 1 : -1); }
        leave = Math.min(leave, far);
        if (enter > leave) { valid = false; break; }
      }
    }
    if (valid) return { time: enter, normal };
  }
  return null;
}

export function resolveTraffic(cars: Car[], motion: Map<Car, Motion>, onlyCar?: Car, pass = 0): void {
  let contacts = 0;
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    const a = cars[i], b = cars[j];
    if (onlyCar && a !== onlyCar && b !== onlyCar) continue;
    if (a.wreckRemoved || b.wreckRemoved || (!a.isAlive && !b.isAlive) || a.isPitting || b.isPitting || a.isFinishedRace || b.isFinishedRace) continue;
    const ma = motion.get(a), mb = motion.get(b);
    if (!ma || !mb) continue;
    const hit = contact(a, b, ma, mb);
    if (!hit) continue;
    contacts++;
    const closing = Math.max(0, a.vel.sub(b.vel).dot(hit.normal));
    a.pos = Vector2.lerp(ma.pos, a.pos, hit.time);
    b.pos = Vector2.lerp(mb.pos, b.pos, hit.time);
    a.heading = ma.heading + (a.heading - ma.heading) * hit.time;
    b.heading = mb.heading + (b.heading - mb.heading) * hit.time;
    // Separate initial overlaps as well as newly touching bodies.
    const fa = Vector2.fromAngle(a.heading), fb = Vector2.fromAngle(b.heading);
    const radius = 2.75 * (Math.abs(fa.dot(hit.normal)) + Math.abs(fb.dot(hit.normal))) + .9 * (Math.abs(fa.normal().dot(hit.normal)) + Math.abs(fb.normal().dot(hit.normal)));
    const overlap = Math.max(.02, radius - b.pos.sub(a.pos).dot(hit.normal) + .02);
    const ia = a.isAlive ? 1 / a.totalMass : 0, ib = b.isAlive ? 1 / b.totalMass : 0, inv = ia + ib;
    a.pos.subMut(hit.normal.mul(overlap * ia / inv));
    b.pos.addMut(hit.normal.mul(overlap * ib / inv));
    if (closing > 0) {
      const impulse = closing / inv; // Inelastic normal impulse, no artificial energy gain.
      a.vel.subMut(hit.normal.mul(impulse * ia));
      b.vel.addMut(hit.normal.mul(impulse * ib));
    }
    for (const car of [a, b]) {
      car.lapCompromised = true;
      car.recoveryTimer = 2;
      car.incidentActive = false;
      car.replayBuffer = [];
      car.battlePush.remaining = 0;
      car.battleOpponent = '';
      if (closing >= 8 && car.isAlive) {
        car.isAlive = false;
        car.eliminationReason = 'car';
        car.respawnTimer = .5;
        car.effectiveThrottle = 0;
        car.vel.set(0, 0);
        car.angularVelocity = 0;
      }
      car.speed = car.vel.mag();
      car.speedKmh = car.speed * 3.6;
    }
  }
  // Resolve contacts created by separating a car from another in a dense pack.
  if (contacts > 0 && pass < 5) resolveTraffic(cars, captureMotion(cars), onlyCar, pass + 1);
}
