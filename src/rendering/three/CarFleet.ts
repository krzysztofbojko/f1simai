import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Car } from '../../physics/Car';
import { Textures } from './Textures';

/** Instances per part; the field is 20 cars plus the player. */
const CAPACITY = 48;
/** The model is built for this length (m) and scaled to `car.length`. */
const MODEL_LENGTH = 5.5;
const WHEEL_RADIUS = 0.36, WHEEL_WIDTH = 0.36;
const WHEELS: [number, number, boolean][] = [[1.62, -0.72, true], [1.62, 0.72, true], [-1.98, -0.72, false], [-1.98, 0.72, false]];
/** Body pivot height for pitch and roll (near the CoG). */
const PIVOT = 0.32;
/**
 * Real F1 body motion is about a degree and a few millimetres; the visual doubles it so the
 * suspension model reads at broadcast distances.
 */
const BODY_MOTION_GAIN = 2;
const MAX_STEER = 0.3; // rad at steer = ±1

export interface CarView { car: Car; isLeader: boolean; isPlayer: boolean; isSelected: boolean }

function indexed(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(list.map(g => g.index ? g.toNonIndexed() : g));
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

/** A side profile (x forward, y up) extruded sideways from z0 over `depth`. */
function profile(points: [number, number][], depth: number, z0: number, bevel = 0.03): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 4 }).translate(0, 0, z0);
}

function tube(points: [number, number, number][], radius: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  return new THREE.TubeGeometry(curve, 24, radius, 6, false);
}

/** Painted bodywork: monocoque, nose, sidepods, engine cover with airbox and fin, wing flaps. */
function bodyGeometry(): THREE.BufferGeometry {
  return indexed([
    new THREE.CylinderGeometry(0.07, 0.19, 1.45, 14).rotateZ(-Math.PI / 2).scale(1, 0.75, 1).translate(1.88, 0.3, 0),
    profile([[-0.35, 0.14], [1.2, 0.16], [1.2, 0.46], [0.75, 0.6], [-0.35, 0.62]], 0.56, -0.28),
    profile([[-2.1, 0.25], [-0.35, 0.18], [-0.35, 0.62], [0.05, 0.98], [-0.3, 1.0], [-1.3, 0.72], [-2.1, 0.5]], 0.46, -0.23),
    profile([[-1.4, 0.13], [0.5, 0.13], [0.55, 0.5], [0.25, 0.58], [-0.5, 0.5], [-1.4, 0.28]], 0.38, 0.3),
    profile([[-1.4, 0.13], [0.5, 0.13], [0.55, 0.5], [0.25, 0.58], [-0.5, 0.5], [-1.4, 0.28]], 0.38, -0.68),
    profile([[-2.15, 0.5], [-0.9, 0.8], [-0.9, 0.86], [-2.3, 0.95]], 0.02, -0.01, 0),
    box(0.16, 0.025, 1.5, 2.38, 0.2, 0),
    box(0.18, 0.04, 0.92, -2.42, 0.98, 0),
  ]);
}

/** Carbon parts: floor, wings and endplates, diffuser, halo, suspension arms, mirrors. */
function carbonGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    box(3.7, 0.04, 1.36, -0.5, 0.07, 0),
    box(0.52, 0.035, 1.78, 2.46, 0.1, 0),
    box(0.34, 0.04, 0.94, -2.5, 0.84, 0),
    box(0.2, 0.03, 0.7, -2.45, 0.38, 0),
    box(0.1, 0.42, 0.05, -2.32, 0.6, 0),
    box(0.55, 0.2, 1.0, -2.3, 0.16, 0),
    box(0.5, 0.25, 0.3, -2.25, 0.35, 0),
    box(0.75, 0.02, 0.4, 0.35, 0.64, 0),
    tube([[-0.05, 0.66, -0.27], [0.35, 0.73, -0.2], [0.55, 0.75, 0], [0.35, 0.73, 0.2], [-0.05, 0.66, 0.27]], 0.03),
    tube([[0.55, 0.75, 0], [0.68, 0.68, 0], [0.8, 0.56, 0]], 0.03),
  ];
  for (const side of [-1, 1]) {
    parts.push(box(0.55, 0.22, 0.03, 2.44, 0.16, side * 0.88));
    parts.push(box(0.62, 0.58, 0.03, -2.48, 0.7, side * 0.48));
    parts.push(box(0.08, 0.06, 0.14, 0.7, 0.72, side * 0.42), box(0.02, 0.08, 0.02, 0.7, 0.66, side * 0.38));
    for (const [x, inner] of [[1.62, 0.28], [-1.98, 0.22]]) {
      const len = 0.62 - inner, mid = side * (inner + len / 2);
      parts.push(box(0.06, 0.03, len, x, 0.44, mid), box(0.06, 0.03, len, x, 0.27, mid));
    }
  }
  return indexed(parts);
}

/** Tyre: open tread cylinder plus two sidewall rings (groups: tread, sidewall, sidewall). Axis along z. */
function tyreGeometry(): THREE.BufferGeometry {
  const r = WHEEL_RADIUS, w = WHEEL_WIDTH;
  const tread = new THREE.CylinderGeometry(r, r, w, 28, 1, true).rotateX(Math.PI / 2);
  const outer = new THREE.RingGeometry(0.235, r, 28).translate(0, 0, w / 2);
  const inner = new THREE.RingGeometry(0.235, r, 28).rotateY(Math.PI).translate(0, 0, -w / 2);
  return mergeGeometries([tread, outer, inner], true);
}

export class CarFleet {
  readonly group = new THREE.Group();
  private readonly body: THREE.InstancedMesh;
  private readonly carbon: THREE.InstancedMesh;
  private readonly helmet: THREE.InstancedMesh;
  private readonly tyres: THREE.InstancedMesh;
  private readonly rims: THREE.InstancedMesh;
  private readonly lights: THREE.InstancedMesh;
  private readonly rings: THREE.InstancedMesh;
  private readonly selection: THREE.Mesh;
  private readonly spin = new WeakMap<Car, number>();
  private time = 0;

  // Scratch objects: the update allocates nothing per frame.
  private readonly m = { ground: new THREE.Matrix4(), body: new THREE.Matrix4(), part: new THREE.Matrix4(), tmp: new THREE.Matrix4() };
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly colorCache = new Map<string, THREE.Color>();

  constructor() {
    const paint = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.35 });
    const carbon = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.45, metalness: 0.3 });
    const helmet = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, metalness: 0.1 });
    const tread = new THREE.MeshStandardMaterial({ color: 0x131315, roughness: 0.9 });
    const sidewall = new THREE.MeshStandardMaterial({ map: Textures.sidewall(), roughness: 0.85 });
    const rim = new THREE.MeshStandardMaterial({ map: Textures.rim(), roughness: 0.35, metalness: 0.7 });
    const light = new THREE.MeshBasicMaterial({ color: 0xff1030, toneMapped: false });
    const ring = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false });

    const make = (geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], count: number, cast = true) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = cast;
      mesh.receiveShadow = cast;
      mesh.count = 0;
      // Instances move every frame; their union bounds are not tracked, so never cull the batch.
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    };
    this.body = make(bodyGeometry(), paint, CAPACITY);
    this.carbon = make(carbonGeometry(), carbon, CAPACITY);
    this.helmet = make(new THREE.SphereGeometry(0.135, 16, 12).translate(0.3, 0.7, 0), helmet, CAPACITY);
    this.tyres = make(tyreGeometry(), [tread, sidewall, sidewall], CAPACITY * 4);
    this.rims = make(new THREE.CylinderGeometry(0.235, 0.235, WHEEL_WIDTH - 0.05, 24).rotateX(Math.PI / 2), rim, CAPACITY * 4);
    this.lights = make(new THREE.BoxGeometry(0.05, 0.08, 0.14).translate(-2.66, 0.46, 0), light, CAPACITY, false);
    this.rings = make(new THREE.RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2).translate(0, 0.04, 0), ring, CAPACITY, false);
    for (const mesh of [this.body, this.helmet, this.rings]) mesh.setColorAt(0, this.c.set(0xffffff));

    const dashed = new THREE.MeshBasicMaterial({ map: Textures.dashedRing(), transparent: true, depthWrite: false, toneMapped: false });
    this.selection = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), dashed);
    this.selection.position.y = 0.05;
    this.selection.visible = false;
    this.group.add(this.selection);
  }

  private teamColor(hex: string): THREE.Color {
    let c = this.colorCache.get(hex);
    if (!c) { c = new THREE.Color(hex); this.colorCache.set(hex, c); }
    return c;
  }

  /**
   * Places every car: body with pitch/roll/heave from the suspension model, wheels rolling with
   * speed and the fronts steering. `pixelsPerMetre` keeps markers readable in the top view.
   */
  update(views: CarView[], dt: number, pixelsPerMetre: number | null): void {
    this.time += dt;
    const { ground, body, part, tmp } = this.m;
    let n = 0, lit = 0, ringCount = 0;
    this.selection.visible = false;
    const markerRadius = Math.max(pixelsPerMetre ? 12 / pixelsPerMetre : 0, 3.6);

    for (const view of views) {
      const car = view.car;
      if (car.wreckRemoved || n >= CAPACITY) continue;
      const scale = car.length / MODEL_LENGTH;
      this.q.setFromAxisAngle(this.v.set(0, 1, 0), -car.heading);
      ground.compose(this.v.set(car.pos.x, 0, car.pos.y), this.q, this.s.set(scale, scale, scale));

      // Body: pitch (+ nose down) and roll (leans away from the turn) about the pivot, heave down.
      const g = car.isAlive ? BODY_MOTION_GAIN : 0;
      this.e.set(-(car.roll || 0) * g, 0, -(car.pitch || 0) * g);
      body.makeRotationFromEuler(this.e);
      body.premultiply(tmp.makeTranslation(0, PIVOT, 0));
      body.multiply(tmp.makeTranslation(0, -PIVOT - (car.heave || 0) * g, 0));
      body.premultiply(ground);
      this.body.setMatrixAt(n, body);
      this.carbon.setMatrixAt(n, body);
      this.helmet.setMatrixAt(n, body);

      const team = this.teamColor(car.color);
      this.body.setColorAt(n, car.isAlive ? team : this.c.copy(team).multiplyScalar(0.25));
      this.helmet.setColorAt(n, this.c.set(view.isPlayer ? 0x00d2be : 0xffdd00));

      // Wheels roll at road speed; the spin angle is integrated per car.
      const speed = car.speedKmh / 3.6;
      const spin = ((this.spin.get(car) ?? 0) + speed / WHEEL_RADIUS * dt) % (Math.PI * 2);
      this.spin.set(car, spin);
      const steer = car.isAlive ? -(car.currentControl?.steer ?? 0) * MAX_STEER : 0;
      for (let w = 0; w < 4; w++) {
        const [x, z, front] = WHEELS[w];
        part.makeRotationZ(-spin);
        if (front) part.premultiply(tmp.makeRotationY(steer));
        part.premultiply(tmp.makeTranslation(x, WHEEL_RADIUS, z));
        part.premultiply(ground);
        this.tyres.setMatrixAt(n * 4 + w, part);
        this.rims.setMatrixAt(n * 4 + w, part);
      }

      const braking = (car.currentControl?.brake ?? 0) > 0.1;
      if (car.isAlive && (car.speedKmh < 90 || car.isSkidding || braking)) this.lights.setMatrixAt(lit++, body);

      const ring = view.isLeader ? 0x00d2be : view.isPlayer ? 0xff8000 : null;
      if (car.isAlive && ring !== null && !view.isSelected) {
        part.compose(this.v.set(car.pos.x, 0, car.pos.y), this.q.identity(), this.s.setScalar(markerRadius));
        this.rings.setMatrixAt(ringCount, part);
        this.rings.setColorAt(ringCount++, this.c.set(ring));
      }
      if (view.isSelected) {
        const sel = this.selection;
        sel.visible = true;
        sel.position.set(car.pos.x, 0.05, car.pos.y);
        sel.scale.setScalar(markerRadius * 1.15);
        sel.rotation.y = this.time * 0.8;
        (sel.material as THREE.MeshBasicMaterial).color.copy(team);
      }
      n++;
    }

    for (const [mesh, count] of [[this.body, n], [this.carbon, n], [this.helmet, n], [this.tyres, n * 4], [this.rims, n * 4], [this.lights, lit], [this.rings, ringCount]] as const) {
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}
