import type { Car } from '../physics/Car';

interface Pose { x: number; y: number; heading: number; pitch: number; roll: number; heave: number }
interface Frame { t: number; poses: Map<Car, Pose> }

/** Faster than any car can move: a larger jump between snapshots is a respawn or reset, not motion. */
const MAX_SPEED = 120;
const MAX_FRAMES = 32;

function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

/**
 * Smooths worker snapshots for display. Snapshots carry the simulation time; they arrive
 * irregularly (a worker tick can hold zero, one or two physics steps), so drawing the latest
 * one makes cars stutter. The display clock runs slightly behind the newest snapshot at the
 * measured simulation rate and every car is drawn interpolated between the two snapshots
 * around it.
 */
export class MotionInterpolator {
  private frames: Frame[] = [];
  private clock = 0;
  private rate = 1;
  private interval = 1 / 60;
  private lastSample = 0;
  private history: { t: number; arrival: number }[] = [];

  push(simTime: number, cars: Iterable<Car>, arrival = performance.now()): void {
    const last = this.frames[this.frames.length - 1];
    if (last && simTime < last.t) { this.frames.length = 0; this.history.length = 0; } // reset or new session
    const prev = this.frames[this.frames.length - 1];
    // Simulation rate over the last half second: single snapshot intervals are far too noisy.
    this.history.push({ t: simTime, arrival });
    while (this.history.length > 2 && arrival - this.history[1].arrival > 500) this.history.shift();
    const first = this.history[0];
    if (arrival - first.arrival > 50) this.rate = (simTime - first.t) / ((arrival - first.arrival) / 1000);
    if (prev && simTime === prev.t) return;
    if (prev) this.interval += (simTime - prev.t - this.interval) * 0.1;

    const poses = new Map<Car, Pose>();
    for (const car of cars) {
      poses.set(car, { x: car.pos.x, y: car.pos.y, heading: car.heading, pitch: car.pitch || 0, roll: car.roll || 0, heave: car.heave || 0 });
    }
    if (!prev) this.clock = simTime;
    this.frames.push({ t: simTime, poses });
    if (this.frames.length > MAX_FRAMES) this.frames.shift();
  }

  /** Moves every car known to the snapshots to its interpolated pose for this display frame. */
  apply(now = performance.now()): void {
    const frames = this.frames;
    if (frames.length === 0) return;
    const realDt = this.lastSample > 0 ? Math.min(0.1, (now - this.lastSample) / 1000) : 0;
    this.lastSample = now;

    const newest = frames[frames.length - 1].t;
    const target = newest - Math.max(1 / 60, this.interval) * 1.5;
    this.clock += realDt * Math.max(0, this.rate);
    const error = target - this.clock;
    if (Math.abs(error) > Math.max(0.25, this.interval * 6)) this.clock = target;
    else this.clock += error * Math.min(1, realDt * 1.5);
    this.clock = Math.max(frames[0].t, Math.min(newest, this.clock));

    // Drop frames the clock has passed for good, keeping the one just before it.
    while (frames.length > 2 && frames[1].t <= this.clock) frames.shift();

    let i = 0;
    while (i < frames.length - 2 && frames[i + 1].t < this.clock) i++;
    const a = frames[i], b = frames[Math.min(i + 1, frames.length - 1)];
    const span = b.t - a.t;
    const k = span > 0 ? Math.max(0, Math.min(1, (this.clock - a.t) / span)) : 1;

    for (const [car, pb] of b.poses) {
      const pa = a.poses.get(car);
      const teleport = !pa || Math.hypot(pb.x - pa.x, pb.y - pa.y) > span * MAX_SPEED + 2;
      const from = teleport ? pb : pa!;
      car.pos.x = from.x + (pb.x - from.x) * k;
      car.pos.y = from.y + (pb.y - from.y) * k;
      car.heading = lerpAngle(from.heading, pb.heading, k);
      car.pitch = from.pitch + (pb.pitch - from.pitch) * k;
      car.roll = from.roll + (pb.roll - from.roll) * k;
      car.heave = from.heave + (pb.heave - from.heave) * k;
    }
  }
}
