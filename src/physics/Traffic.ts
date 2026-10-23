import { gap as trackGap, laneChangePerMetre } from '../ai/RaceTraffic';
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
    let lateral = offset.cross(forward);
    if (track && road && ahead > 0) {
      // In the corridor where the car is now, or where it will be when it gets there: its line (and
      // planned shift) at the other car, reached by a lane change spread over distance, so a line
      // converging on a car ahead counts too.
      const there = track.sampleSurface(other.pos), line = car.racingLine(track);
      const planned = line.offsetAt(there.index, there.fraction) + car.raceLineOffset - car.raceLineBaseline;
      const spread = Math.max(10, Math.abs(planned - road.lateral) / laneChangePerMetre(car.speed));
      const now = there.lateral - road.lateral;
      const then = there.lateral - (road.lateral + (planned - road.lateral) * Math.min(1, ahead / spread));
      lateral = Math.abs(now) < Math.abs(then) ? now : then;
    }
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

/**
 * Wake of the cars ahead: a tow cuts drag up to 30% (fading out 50 m behind the car ahead),
 * dirty air cuts downforce up to 20% (fading out by 30 m). The wake is ±1.6 m wide and weakens
 * when the car ahead is slower. Sets `wakeDrag` / `wakeDownforce` on every car, the same in
 * training and the race: a model trained in the pack meets the same air in a race.
 */
export function computeWake(cars: Car[], track?: Track): void {
  for (const car of cars) {
    car.wakeDrag = 1;
    car.wakeDownforce = 1;
    if (!car.isAlive || car.isPitting || car.isFinishedRace || car.speed < 20) continue;
    const forward = Vector2.fromAngle(car.heading);
    const road = track?.sampleSurface(car.pos);
    let tow = 0, dirty = 0;
    for (const other of cars) {
      if (other === car || !other.isAlive || other.isPitting || other.isFinishedRace || other.speed < 20) continue;
      const offset = other.pos.sub(car.pos);
      if (offset.magSq() > 60 * 60) continue;
      const ahead = (track ? trackGap(track, car.pos, other.pos) : offset.dot(forward)) - 5.5;
      if (ahead <= 0 || ahead > 50) continue;
      const lateral = track && road ? track.sampleSurface(other.pos).lateral - road.lateral : offset.cross(forward);
      const strength = Math.exp(-((lateral / 1.6) ** 2)) * Math.min(1, other.speed / car.speed);
      tow = Math.max(tow, strength * Math.min(1, (50 - ahead) / 45));
      dirty = Math.max(dirty, strength * Math.max(0, Math.min(1, (30 - ahead) / 25)));
    }
    car.wakeDrag = 1 - 0.3 * tow;
    car.wakeDownforce = 1 - 0.2 * dirty;
  }
}

// Continuous separating-axis test for oriented 5.5 × 1.9 m physical bodies.
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
      const radius = 2.75 * (Math.abs(fa.dot(axis)) + Math.abs(fb.dot(axis))) + a.width / 2 * Math.abs(ra.dot(axis)) + b.width / 2 * Math.abs(rb.dot(axis))
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

/** Contact friction between two bodies (carbon on carbon / tyre on bodywork). */
const CONTACT_FRICTION = 0.3;

/** Corner (or face centre) of a 5.5 × 1.9 m body furthest along `dir`. */
function support(car: Car, dir: Vector2): Vector2 {
  const f = Vector2.fromAngle(car.heading), r = f.normal();
  const side = (d: number) => Math.abs(d) < 0.05 ? 0 : Math.sign(d);
  return car.pos.add(f.mul(2.75 * side(f.dot(dir)))).add(r.mul(car.width / 2 * side(r.dot(dir))));
}

/**
 * Inelastic impulse at the contact point with Coulomb friction: an off-centre touch
 * spins the cars (yaw inertia as in Car.updatePhysics), a head-on one only slows them.
 * The normal impulse stops the approach and friction only removes sliding, so no energy is gained.
 */
function applyContactImpulse(a: Car, b: Car, normal: Vector2, ia: number, ib: number): void {
  const point = Vector2.lerp(support(a, normal), support(b, normal.mul(-1)), 0.5);
  const ra = point.sub(a.pos), rb = point.sub(b.pos);
  const ja = ia / Car.YAW_INERTIA_FACTOR, jb = ib / Car.YAW_INERTIA_FACTOR; // 1/Iz, Iz = factor·m
  const yawBefore = [a.angularVelocity, b.angularVelocity];
  const relative = () => b.vel.add(rb.normal().mul(b.angularVelocity)).sub(a.vel.add(ra.normal().mul(a.angularVelocity)));
  const push = (dir: Vector2, impulse: number) => {
    a.vel.subMut(dir.mul(impulse * ia));
    b.vel.addMut(dir.mul(impulse * ib));
    a.angularVelocity -= ra.cross(dir) * impulse * ja;
    b.angularVelocity += rb.cross(dir) * impulse * jb;
  };
  const mass = (dir: Vector2) => ia + ib + ra.cross(dir) ** 2 * ja + rb.cross(dir) ** 2 * jb;
  const approach = relative().dot(normal);
  if (approach >= 0) return;
  const normalImpulse = -approach / mass(normal);
  push(normal, normalImpulse);
  const tangent = normal.normal();
  const slide = relative().dot(tangent);
  const limit = CONTACT_FRICTION * normalImpulse;
  push(tangent, Math.max(-limit, Math.min(limit, -slide / mass(tangent))));
  // Same bound as a barrier hit, so a touch cannot set up an unrecoverable spin.
  [a, b].forEach((car, k) => {
    const bound = Math.max(1.2, Math.abs(yawBefore[k]));
    car.angularVelocity = Math.max(-bound, Math.min(bound, car.angularVelocity));
  });
}

export function resolveTraffic(cars: Car[], motion: Map<Car, Motion>, onlyCar?: Car, pass = 0): void {
  let contacts = 0;
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    const a = cars[i], b = cars[j];
    if (onlyCar && a !== onlyCar && b !== onlyCar) continue;
    if (a.wreckRemoved || b.wreckRemoved || (!a.isAlive && !b.isAlive && a.speed < 0.5 && b.speed < 0.5) || a.isPitting || b.isPitting || a.isFinishedRace || b.isFinishedRace) continue;
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
    const radius = 2.75 * (Math.abs(fa.dot(hit.normal)) + Math.abs(fb.dot(hit.normal))) + a.width / 2 * Math.abs(fa.normal().dot(hit.normal)) + b.width / 2 * Math.abs(fb.normal().dot(hit.normal));
    const overlap = Math.max(.02, radius - b.pos.sub(a.pos).dot(hit.normal) + .02);
    const ia = a.isAlive || a.speed > 0.5 ? 1 / a.totalMass : 0, ib = b.isAlive || b.speed > 0.5 ? 1 / b.totalMass : 0, inv = ia + ib;
    a.pos.subMut(hit.normal.mul(overlap * ia / inv));
    b.pos.addMut(hit.normal.mul(overlap * ib / inv));
    if (closing > 0) applyContactImpulse(a, b, hit.normal, ia, ib);
    for (const car of [a, b]) {
      car.lapCompromised = true;
      car.lapContact = true;
      car.recoveryTimer = 2;
      car.incidentActive = false;
      car.replayBuffer = [];
      car.battlePush.remaining = 0;
      car.battleOpponent = '';
      if (closing > 0 && car.isAlive) car.damage += (closing / Car.CRASH_CLOSING_SPEED) ** 2;
      if ((closing >= Car.CRASH_CLOSING_SPEED || car.damage >= 1) && car.isAlive) {
        // The wreck keeps the momentum left after the impulse and slides to rest.
        car.isAlive = false;
        car.eliminationReason = 'car';
        car.respawnTimer = .5;
        car.effectiveThrottle = 0;
        car.angularVelocity = 0;
      }
      car.speed = car.vel.mag();
      car.speedKmh = car.speed * 3.6;
    }
  }
  // Resolve contacts created by separating a car from another in a dense pack.
  if (contacts > 0 && pass < 5) resolveTraffic(cars, captureMotion(cars), onlyCar, pass + 1);
}
