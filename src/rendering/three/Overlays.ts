import * as THREE from 'three';
import { Car, TrajectoryPoint } from '../../physics/Car';
import { Vector2 } from '../../math/Vector2';
import { DynamicRibbon, Point2 } from './Geometry';
import type { RacingLine } from '../../track/RacingLine';
import type { Track } from '../../track/Track';

const LINE_HEIGHT = 0.03;
const MAX_RAYS = 64;

function overlay(m: THREE.Material, layer = 6): THREE.Material {
  m.polygonOffset = true;
  m.polygonOffsetFactor = -layer;
  m.polygonOffsetUnits = -layer * 4;
  m.depthWrite = false;
  m.transparent = true;
  m.toneMapped = false;
  return m;
}

/** Longest stretch (m) of the planned line drawn straight: sparser track points are subdivided by Catmull-Rom. */
const PLANNED_SAMPLE = 6;

/**
 * Analysis overlays drawn on the asphalt: the planned racing line coloured by the speed it allows,
 * the fastest driven lap coloured by brake/throttle, the selected car's sensor rays, and the track
 * being drawn in the editor.
 */
export class Overlays {
  readonly group = new THREE.Group();
  private readonly lineGlow = new DynamicRibbon(512);
  private readonly lineCore = new DynamicRibbon(512);
  private readonly apexes: THREE.InstancedMesh;
  private readonly lineGroup = new THREE.Group();
  private lastLine: TrajectoryPoint[] | null = null;
  private readonly plannedCore = new DynamicRibbon(1024);
  private readonly plannedGroup = new THREE.Group();
  private lastPlanned: RacingLine | null = null;
  private reference: Car | null = null;

  private readonly rays: THREE.LineSegments;
  private readonly hits: THREE.Points;
  private readonly rayPos = new Float32Array(MAX_RAYS * 2 * 3);
  private readonly rayCol = new Float32Array(MAX_RAYS * 2 * 3);
  private readonly hitPos = new Float32Array(MAX_RAYS * 3);
  private readonly hitCol = new Float32Array(MAX_RAYS * 3);

  private readonly drawGroup = new THREE.Group();
  private readonly drawPath = new DynamicRibbon(512);
  private readonly drawStraight = new DynamicRibbon(4);
  private readonly drawStart: THREE.Mesh;
  private readonly drawSnap: THREE.Mesh;

  private readonly colors = { brake: new THREE.Color('#FF3333'), throttle: new THREE.Color('#00E676'), neutral: new THREE.Color('#00D2BE'), slow: new THREE.Color('#FF6A3D'), fast: new THREE.Color('#4FC3F7') };
  private readonly m = new THREE.Matrix4();

  constructor() {
    this.lineGroup.add(
      new THREE.Mesh(this.lineGlow.geometry, overlay(new THREE.MeshBasicMaterial({ color: 0x00d2be, opacity: 0.2 }), 6)),
      new THREE.Mesh(this.lineCore.geometry, overlay(new THREE.MeshBasicMaterial({ vertexColors: true, opacity: 0.95 }), 7)),
    );
    this.apexes = new THREE.InstancedMesh(new THREE.CircleGeometry(0.7, 12).rotateX(-Math.PI / 2), overlay(new THREE.MeshBasicMaterial({ color: 0xffd700 }), 8), 256);
    this.apexes.count = 0;
    this.apexes.frustumCulled = false;
    this.lineGroup.add(this.apexes);
    for (const o of this.lineGroup.children) o.frustumCulled = false;
    this.plannedGroup.add(new THREE.Mesh(this.plannedCore.geometry, overlay(new THREE.MeshBasicMaterial({ vertexColors: true, opacity: 0.8 }), 5)));
    for (const o of this.plannedGroup.children) o.frustumCulled = false;

    const rayGeo = new THREE.BufferGeometry();
    rayGeo.setAttribute('position', new THREE.BufferAttribute(this.rayPos, 3).setUsage(THREE.DynamicDrawUsage));
    rayGeo.setAttribute('color', new THREE.BufferAttribute(this.rayCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.rays = new THREE.LineSegments(rayGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, toneMapped: false, depthTest: false }));
    const hitGeo = new THREE.BufferGeometry();
    hitGeo.setAttribute('position', new THREE.BufferAttribute(this.hitPos, 3).setUsage(THREE.DynamicDrawUsage));
    hitGeo.setAttribute('color', new THREE.BufferAttribute(this.hitCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.hits = new THREE.Points(hitGeo, new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, vertexColors: true, toneMapped: false, depthTest: false }));
    for (const o of [this.rays, this.hits]) { o.frustumCulled = false; o.renderOrder = 10; }

    this.drawGroup.add(
      new THREE.Mesh(this.drawPath.geometry, overlay(new THREE.MeshBasicMaterial({ color: 0x00d2be }), 8)),
      new THREE.Mesh(this.drawStraight.geometry, overlay(new THREE.MeshBasicMaterial({ color: 0xffd700 }), 9)),
    );
    this.drawStart = new THREE.Mesh(new THREE.CircleGeometry(11.5, 32).rotateX(-Math.PI / 2), overlay(new THREE.MeshBasicMaterial({ color: 0xffffff }), 10));
    this.drawStart.add(new THREE.Mesh(new THREE.CircleGeometry(10, 32).rotateX(-Math.PI / 2).translate(0, 0.01, 0), overlay(new THREE.MeshBasicMaterial({ color: 0xe10600 }), 11)));
    this.drawSnap = new THREE.Mesh(new THREE.CircleGeometry(25, 40).rotateX(-Math.PI / 2), overlay(new THREE.MeshBasicMaterial({ color: 0x00d2be, opacity: 0.4 }), 9));
    this.drawGroup.add(this.drawStart, this.drawSnap);
    for (const o of this.drawGroup.children) o.frustumCulled = false;

    this.group.add(this.plannedGroup, this.lineGroup, this.rays, this.hits, this.drawGroup);
  }

  /** The precomputed racing line the drivers aim for, from orange (slow) to blue (fast) by the speed it allows. */
  setPlannedLine(track: Track | null, line: RacingLine | null): void {
    this.plannedGroup.visible = !!track && !!line;
    if (!track || !line || line === this.lastPlanned) return;
    this.lastPlanned = line;
    // A nominal car on fresh tyres, planned the way the AI plans its corners.
    const car = this.reference ??= new Car(new Vector2(), 0);
    const speeds = line.speedProfile(car.baseTireGrip * Car.PLAN_CORNER_GRIP,
      0.5 * car.airDensity * car.downforceCoeff * Car.PLAN_AERO_SHARE / car.totalMass, car.baseTireGrip * Car.PLAN_BRAKE_GRIP);
    const n = track.points.length, low = speeds.reduce((a, b) => Math.min(a, b), Infinity), high = speeds.reduce((a, b) => Math.max(a, b), -Infinity);
    const steps = Math.max(1, Math.ceil(track.spacing / PLANNED_SAMPLE));
    const points: Point2[] = [], shade: THREE.Color[] = [];
    for (let i = 0; i < n; i++) {
      const p0 = line.point(i - 1), p1 = line.point(i), p2 = line.point(i + 1), p3 = line.point(i + 2);
      for (let s = 0; s < steps; s++) {
        const t = s / steps, t2 = t * t, t3 = t2 * t;
        const at = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
        points.push({ x: at(p0.x, p1.x, p2.x, p3.x), y: at(p0.y, p1.y, p2.y, p3.y) });
        const v = speeds[i] * (1 - t) + speeds[(i + 1) % n] * t;
        shade.push(this.colors.slow.clone().lerp(this.colors.fast, high > low ? (v - low) / (high - low) : 1));
      }
    }
    this.plannedCore.set(points, 0.45, LINE_HEIGHT - 0.004, true, i => shade[i % shade.length]);
  }

  setRacingLine(line: TrajectoryPoint[] | null): void {
    this.lineGroup.visible = !!line && line.length >= 4;
    if (!line || line.length < 4 || line === this.lastLine) return;
    this.lastLine = line;
    const first = line[0], last = line[line.length - 1];
    const closed = Math.hypot(first.x - last.x, first.y - last.y) < 70;
    this.lineGlow.set(line, 1.4, LINE_HEIGHT, closed);
    this.lineCore.set(line, 0.35, LINE_HEIGHT + 0.002, closed, i => line[i].brake > 0.15 ? this.colors.brake : line[i].throttle > 0.5 ? this.colors.throttle : this.colors.neutral);
    let k = 0;
    for (let i = 0; i < line.length && k < 256; i += 8) {
      this.apexes.setMatrixAt(k++, this.m.makeTranslation(line[i].x, LINE_HEIGHT + 0.004, line[i].y));
    }
    this.apexes.count = k;
    this.apexes.instanceMatrix.needsUpdate = true;
  }

  /** Sensor rays of one car, red when short and green when long (as in the 2D view). */
  setSensors(car: Car | null): void {
    const n = car ? Math.min(MAX_RAYS, car.rayHits.length) : 0;
    for (let i = 0; i < n; i++) {
      // From the hit distance: on the main thread only the hits are synced from the worker.
      const hit = car!.rayHits[i], ratio = Math.min(1, hit.dist / Car.RAY_MAX_DIST);
      const r = 1 - ratio, g = ratio, b = 0.27;
      this.rayPos.set([car!.pos.x, 0.5, car!.pos.y, hit.point.x, 0.1, hit.point.y], i * 6);
      this.rayCol.set([r, g, b, r, g, b], i * 6);
      this.hitPos.set([hit.point.x, 0.1, hit.point.y], i * 3);
      this.hitCol.set([r, g, b], i * 3);
    }
    for (const o of [this.rays, this.hits]) {
      for (const name of ['position', 'color']) o.geometry.getAttribute(name).needsUpdate = true;
    }
    this.rays.geometry.setDrawRange(0, n * 2);
    this.hits.geometry.setDrawRange(0, n);
  }

  /**
   * The editor's path: the drawn polyline to the cursor, the Shift straight-line guide, the
   * start marker and the loop-closing target. Returns the straight guide's midpoint for its badge.
   */
  setDrawing(points: Vector2[] | null, mouse: Vector2 | null, anchor: Vector2 | null): Point2 | null {
    this.drawGroup.visible = !!points && points.length > 0;
    if (!points || !points.length) return null;
    const path: Point2[] = points.slice();
    let badge: Point2 | null = null;
    if (anchor && mouse) {
      path.push(anchor);
      this.drawStraight.set([anchor, mouse], 3, 0.06);
      badge = { x: (anchor.x + mouse.x) / 2, y: (anchor.y + mouse.y) / 2 };
    } else {
      if (mouse) path.push(mouse);
      this.drawStraight.clear();
    }
    if (path.length >= 2) this.drawPath.set(path, 4, 0.05);
    else this.drawPath.clear();
    const start = points[0];
    this.drawStart.position.set(start.x, 0.07, start.y);
    this.drawSnap.visible = !!mouse && points.length > 5 && mouse.dist(start) < 40;
    this.drawSnap.position.set(start.x, 0.065, start.y);
    return badge;
  }
}
