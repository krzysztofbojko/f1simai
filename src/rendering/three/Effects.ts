import * as THREE from 'three';
import { Car } from '../../physics/Car';
import { ParticleSystem } from './Particles';

/** Rear wheel contact points in the car frame (m): x behind the CoG, ±z to the sides. */
const REAR_X = -1.98, REAR_Z = 0.72;
const SKID_CAPACITY = 12000;
const SKID_HALF_WIDTH = 0.18;
/** Plank load (N) above which the skid block throws sparks. */
const SPARK_PLANK_FORCE = 800;

interface CarTrail { lx: number; ly: number; rx: number; ry: number; skidding: boolean; impact: number; smoke: number; dust: number; sparks: number }

/**
 * Tyre marks as a ring buffer of quads (oldest overwritten first), so a long session keeps a
 * bounded, prealocated mesh.
 */
class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly pos = new Float32Array(SKID_CAPACITY * 4 * 3);
  private next = 0;
  private used = 0;
  private dirtyFrom = Infinity;
  private dirtyTo = -1;

  constructor() {
    const geometry = new THREE.BufferGeometry();
    const index = new Uint32Array(SKID_CAPACITY * 6);
    for (let i = 0; i < SKID_CAPACITY; i++) index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
    const nrm = new Float32Array(SKID_CAPACITY * 4 * 3);
    for (let i = 0; i < SKID_CAPACITY * 4; i++) nrm[i * 3 + 1] = 1;
    geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.setDrawRange(0, 0);
    const material = new THREE.MeshStandardMaterial({
      color: 0x050505, roughness: 0.6, transparent: true, opacity: 0.42, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -12,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
  }

  /** One quad from the previous to the current wheel position, `sx/sy` the car's lateral unit vector. */
  add(x0: number, y0: number, x1: number, y1: number, sx: number, sy: number): void {
    const i = this.next, o = i * 12, h = SKID_HALF_WIDTH, y = 0.016;
    this.pos.set([
      x0 - sx * h, y, y0 - sy * h, x0 + sx * h, y, y0 + sy * h,
      x1 - sx * h, y, y1 - sy * h, x1 + sx * h, y, y1 + sy * h,
    ], o);
    this.dirtyFrom = Math.min(this.dirtyFrom, i);
    this.dirtyTo = Math.max(this.dirtyTo, i);
    this.next = (i + 1) % SKID_CAPACITY;
    this.used = Math.min(SKID_CAPACITY, this.used + 1);
  }

  flush(): void {
    if (this.dirtyTo < 0) return;
    const attr = this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.clearUpdateRanges();
    attr.addUpdateRange(this.dirtyFrom * 12, (this.dirtyTo - this.dirtyFrom + 1) * 12);
    attr.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, this.used * 6);
    this.dirtyFrom = Infinity; this.dirtyTo = -1;
  }

  clear(): void { this.next = this.used = 0; this.mesh.geometry.setDrawRange(0, 0); }
}

/**
 * Visual effects driven by the car state: tyre smoke and marks when sliding, dust off the
 * gravel and grass, sparks from plank contact and barrier impacts.
 */
export class Effects {
  readonly group = new THREE.Group();
  readonly smoke = new ParticleSystem(5000, THREE.NormalBlending);
  readonly sparks = new ParticleSystem(2500, THREE.AdditiveBlending);
  private readonly skids = new SkidMarks();
  private readonly trails = new WeakMap<Car, CarTrail>();
  private readonly smokeColor = new THREE.Color(0xd8d8d8);
  private readonly gravelColor = new THREE.Color(0xa58e66);
  private readonly grassColor = new THREE.Color(0x6b6a3e);
  private readonly sparkColor = new THREE.Color(1, 0.62, 0.22);

  constructor() {
    this.group.add(this.skids.mesh, this.smoke.points, this.sparks.points);
  }

  clear(): void { this.skids.clear(); this.smoke.clear(); this.sparks.clear(); }

  setProjection(scale: number, perspective: boolean): void {
    this.smoke.setProjection(scale, perspective);
    this.sparks.setProjection(scale, perspective);
  }

  /** `emit` is false while the simulation stands still: live particles fade, nothing new appears. */
  update(cars: Car[], dt: number, emit = true): void {
    // Emission is rate-based; a long frame (tab switch) must not dump a burst of particles.
    const step = Math.min(dt, 0.05);
    if (emit) for (const car of cars) this.updateCar(car, step);
    this.skids.flush();
    this.smoke.update(dt);
    this.sparks.update(dt);
  }

  private updateCar(car: Car, dt: number): void {
    const c = Math.cos(car.heading), s = Math.sin(car.heading);
    // Lateral unit vector (car's right) and the rear contact points.
    const sx = -s, sy = c;
    const lx = car.pos.x + c * REAR_X - sx * REAR_Z, ly = car.pos.y + s * REAR_X - sy * REAR_Z;
    const rx = car.pos.x + c * REAR_X + sx * REAR_Z, ry = car.pos.y + s * REAR_X + sy * REAR_Z;
    let t = this.trails.get(car);
    if (!t) {
      t = { lx, ly, rx, ry, skidding: false, impact: car.barrierImpactSpeed, smoke: 0, dust: 0, sparks: 0 };
      this.trails.set(car, t);
    }
    const alive = car.isAlive && !car.wreckRemoved;
    const speed = car.speedKmh / 3.6, vx = c * speed, vy = s * speed;
    const skidding = alive && car.isSkidding;

    // Marks join the previous frame's contact points; a jump (reset, teleport) starts a new mark.
    const moved = Math.hypot(lx - t.lx, ly - t.ly);
    if (skidding && t.skidding && moved > 0.05 && moved < 8) {
      this.skids.add(t.lx, t.ly, lx, ly, sx, sy);
      this.skids.add(t.rx, t.ry, rx, ry, sx, sy);
    }

    if (skidding && speed > 3) {
      t.smoke += dt * 70;
      for (; t.smoke >= 1; t.smoke--) {
        const left = Math.random() < 0.5;
        this.puff(left ? lx : rx, left ? ly : ry, vx * 0.25, vy * 0.25, this.smokeColor, 0.32, 0.6, 3.6, 1.6);
      }
    }

    const offroad = alive ? (car.surfaceFractions?.gravel ?? 0) + (car.surfaceFractions?.grass ?? 0) * 0.5 : 0;
    if (offroad > 0.1 && speed > 6) {
      t.dust += dt * offroad * Math.min(1, speed / 40) * 90;
      const color = (car.surfaceFractions?.gravel ?? 0) > (car.surfaceFractions?.grass ?? 0) ? this.gravelColor : this.grassColor;
      for (; t.dust >= 1; t.dust--) {
        const left = Math.random() < 0.5;
        this.puff(left ? lx : rx, left ? ly : ry, vx * 0.15 - vx * 0.1 * Math.random(), vy * 0.15, color, 0.45, 0.5, 4.5, 1.3);
      }
    }

    if (alive && car.plankForce > SPARK_PLANK_FORCE && speed > 15) {
      t.sparks += dt * Math.min(400, car.plankForce / 40);
      for (; t.sparks >= 1; t.sparks--) this.spark(car.pos.x - c * 0.6, car.pos.y - s * 0.6, vx * 0.7, vy * 0.7, 6);
    }

    // A new impact (the worker reports the latest barrier impact speed) throws a burst.
    if (car.barrierImpactSpeed > 3 && car.barrierImpactSpeed !== t.impact) {
      const burst = Math.min(120, car.barrierImpactSpeed * 3);
      for (let i = 0; i < burst; i++) this.spark(car.pos.x, car.pos.y, vx * 0.3, vy * 0.3, 12);
      for (let i = 0; i < burst / 4; i++) this.puff(car.pos.x, car.pos.y, 0, 0, this.gravelColor, 0.5, 1, 5, 2);
    }
    t.impact = car.barrierImpactSpeed;
    t.lx = lx; t.ly = ly; t.rx = rx; t.ry = ry; t.skidding = skidding;
  }

  private puff(x: number, y: number, vx: number, vy: number, color: THREE.Color, alpha: number, size0: number, size1: number, life: number): void {
    const j = () => (Math.random() - 0.5) * 2;
    this.smoke.emit({
      x: x + j() * 0.2, y: 0.25, z: y + j() * 0.2,
      vx: vx + j() * 1.2, vy: 0.6 + Math.random() * 0.8, vz: vy + j() * 1.2,
      life: life * (0.7 + Math.random() * 0.6), size0, size1, color, alpha, lift: 0.4, drag: 1.4,
    });
  }

  private spark(x: number, y: number, vx: number, vy: number, spread: number): void {
    const j = () => (Math.random() - 0.5) * 2;
    this.sparks.emit({
      x, y: 0.08, z: y,
      vx: vx + j() * spread, vy: 1 + Math.random() * spread * 0.4, vz: vy + j() * spread,
      life: 0.2 + Math.random() * 0.35, size0: 0.22, size1: 0.06, color: this.sparkColor, alpha: 1, lift: -9.81, drag: 0.6,
    });
  }
}
