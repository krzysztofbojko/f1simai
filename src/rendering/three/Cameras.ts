import * as THREE from 'three';
import { Car } from '../../physics/Car';
import { Track } from '../../track/Track';
import { Vector2 } from '../../math/Vector2';

export type CameraMode = 'top' | 'chase' | 'tv';

const MIN_ZOOM = 0.25, MAX_ZOOM = 40;
/** Elevation of the top camera: tilted for depth, straight down while drawing a track. */
const TOP_TILT = THREE.MathUtils.degToRad(58);
const DRAW_TILT = Math.PI / 2;
const TOP_DISTANCE = 3000;
/** One broadcast camera per this much track (m). */
const TV_SPACING = 140;

/**
 * Camera rig. The top view is orthographic and keeps the 2D view's controls (zoom at the cursor,
 * drag to pan, fit, follow): `zoom` is pixels per metre and `target` the ground point at the
 * screen centre. Chase and TV are perspective cameras that track one car.
 */
export class CameraRig {
  mode: CameraMode = 'top';
  readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 8000);
  readonly persp = new THREE.PerspectiveCamera(55, 1, 0.5, 6000);
  zoom = 1;
  readonly target = new THREE.Vector2(0, 0);
  chaseDistance = 10;

  private tilt = TOP_TILT;
  private width = 1;
  private height = 1;
  private saved: { zoom: number; x: number; y: number; mode: CameraMode } | null = null;
  private panAnchor: THREE.Vector2 | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly ndc = new THREE.Vector2();
  private readonly hit = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private readonly chasePos = new THREE.Vector3();
  private readonly chaseLook = new THREE.Vector3();
  private chaseCar: Car | null = null;
  private stations: THREE.Vector3[] = [];
  private station = -1;
  private tvFov = 30;

  get active(): THREE.Camera { return this.mode === 'top' ? this.ortho : this.persp; }
  get isPerspective(): boolean { return this.mode !== 'top'; }

  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.persp.aspect = this.width / this.height;
    this.persp.updateProjectionMatrix();
    // The editor keeps screen pixel = world metre from the top-left corner, at any size.
    if (this.inDrawMode) this.target.set(this.width / 2, this.height / 2);
    this.updateTop();
  }

  /** The editor draws in screen pixels at 1 px = 1 m, straight from above (as the 2D editor did). */
  setDrawMode(on: boolean): void {
    if (on === (this.saved !== null)) return;
    if (on) {
      this.saved = { zoom: this.zoom, x: this.target.x, y: this.target.y, mode: this.mode };
      this.mode = 'top';
      this.zoom = 1;
      this.target.set(this.width / 2, this.height / 2);
      this.tilt = DRAW_TILT;
    } else {
      const s = this.saved!;
      this.zoom = s.zoom;
      this.target.set(s.x, s.y);
      this.mode = s.mode;
      this.tilt = TOP_TILT;
      this.saved = null;
    }
    this.updateTop();
  }

  get inDrawMode(): boolean { return this.saved !== null; }

  setTrack(track: Track): void {
    this.stations = [];
    this.station = -1;
    const pts = track.points, run = track.runoff;
    if (pts.length < 3 || run.length !== pts.length) return;
    let travelled = TV_SPACING / 2;
    for (let i = 0; i < pts.length; i++) {
      const next = pts[(i + 1) % pts.length];
      travelled += pts[i].center.dist(next.center);
      if (travelled < TV_SPACING) continue;
      travelled = 0;
      // On the outside of the bend, a few metres behind the barrier and raised like a gantry.
      let curvature = 0;
      for (let k = -4; k <= 4; k++) curvature += pts[(i + k + pts.length) % pts.length].curvature;
      const outsideRight = curvature >= 0;
      const barrier = outsideRight ? run[i].rightBarrier : run[i].leftBarrier;
      const out = pts[i].normal.mul(outsideRight ? -6 : 6);
      this.stations.push(new THREE.Vector3(barrier.x + out.x, 7, barrier.y + out.y));
    }
  }

  private updateTop(): void {
    const c = this.ortho, hw = this.width / (2 * this.zoom), hh = this.height / (2 * this.zoom);
    c.left = -hw; c.right = hw; c.top = hh; c.bottom = -hh;
    c.updateProjectionMatrix();
    c.position.set(this.target.x, Math.sin(this.tilt) * TOP_DISTANCE, this.target.y + Math.cos(this.tilt) * TOP_DISTANCE);
    c.up.set(0, 0, -1);
    c.lookAt(this.target.x, 0, this.target.y);
    c.updateMatrixWorld();
  }

  /** Positions the chase/TV camera on `focus` (smoothed); the top camera only needs `target`. */
  update(dt: number, focus: Car | null): void {
    this.updateTop();
    if (this.mode === 'top' || !focus) return;
    const c = Math.cos(focus.heading), s = Math.sin(focus.heading);
    const px = focus.pos.x, pz = focus.pos.y;
    if (this.mode === 'chase') {
      const d = this.chaseDistance;
      const wantPos = this.v.set(px - c * d, 1.2 + d * 0.3, pz - s * d);
      const snap = this.chaseCar !== focus || this.chasePos.distanceTo(wantPos) > 80;
      this.chaseCar = focus;
      if (snap) {
        this.chasePos.copy(wantPos);
        this.chaseLook.set(px + c * 3, 0.8, pz + s * 3);
      } else {
        this.chasePos.lerp(wantPos, 1 - Math.exp(-dt * 6));
        this.chaseLook.lerp(this.v.set(px + c * 3, 0.8, pz + s * 3), 1 - Math.exp(-dt * 12));
      }
      this.persp.fov = 55;
      this.persp.position.copy(this.chasePos);
      this.persp.up.set(0, 1, 0);
      this.persp.lookAt(this.chaseLook);
    } else {
      if (!this.stations.length) { this.mode = 'chase'; return; }
      const car = this.v.set(px, 0.6, pz);
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < this.stations.length; i++) {
        const d = this.stations[i].distanceTo(car);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      // Hysteresis: cut only when another camera is clearly closer.
      const current = this.station >= 0 ? this.stations[this.station].distanceTo(car) : Infinity;
      const cut = this.station < 0 || this.chaseCar !== focus || bestDist < current * 0.7 || current > 300;
      if (cut) { this.station = best; this.chaseLook.copy(car); }
      else this.chaseLook.lerp(car, 1 - Math.exp(-dt * 8));
      this.chaseCar = focus;
      const cam = this.stations[this.station];
      const dist = cam.distanceTo(this.chaseLook);
      const fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(10 / dist)), 6, 50);
      this.tvFov = cut ? fov : this.tvFov + (fov - this.tvFov) * (1 - Math.exp(-dt * 3));
      this.persp.fov = this.tvFov;
      this.persp.position.copy(cam);
      this.persp.up.set(0, 1, 0);
      this.persp.lookAt(this.chaseLook);
    }
    this.persp.updateProjectionMatrix();
    this.persp.updateMatrixWorld();
  }

  /** Ground point (simulation x, y) under a screen position, or null above the horizon. */
  screenToWorld(sx: number, sy: number): Vector2 | null {
    this.ndc.set(sx / this.width * 2 - 1, -(sy / this.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.active);
    const p = this.raycaster.ray.intersectPlane(this.ground, this.hit);
    return p ? new Vector2(p.x, p.z) : null;
  }

  /** Projects a world point to CSS pixels; returns false when it is behind the camera. */
  worldToScreen(x: number, y: number, height: number, out: THREE.Vector2): boolean {
    const v = this.v.set(x, height, y).project(this.active);
    out.set((v.x + 1) / 2 * this.width, (1 - v.y) / 2 * this.height);
    return v.z > -1 && v.z < 1;
  }

  zoomAt(factor: number, sx = this.width / 2, sy = this.height / 2): void {
    if (this.mode === 'chase') { this.chaseDistance = THREE.MathUtils.clamp(this.chaseDistance / factor, 4, 60); return; }
    if (this.mode !== 'top') return;
    const before = this.screenToWorld(sx, sy);
    this.zoom = THREE.MathUtils.clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    this.updateTop();
    const after = this.screenToWorld(sx, sy);
    if (before && after) {
      this.target.x += before.x - after.x;
      this.target.y += before.y - after.y;
    }
    this.updateTop();
  }

  beginPan(sx: number, sy: number): void {
    const p = this.mode === 'top' ? this.screenToWorld(sx, sy) : null;
    this.panAnchor = p ? new THREE.Vector2(p.x, p.y) : null;
  }

  /** Keeps the ground point grabbed at `beginPan` under the cursor (exact for the orthographic view). */
  panTo(sx: number, sy: number): void {
    if (!this.panAnchor) return;
    const p = this.screenToWorld(sx, sy);
    if (!p) return;
    this.target.x += this.panAnchor.x - p.x;
    this.target.y += this.panAnchor.y - p.y;
    this.updateTop();
  }

  endPan(): void { this.panAnchor = null; }

  fit(b: { minX: number; maxX: number; minY: number; maxY: number }): void {
    const sin = Math.sin(this.tilt);
    this.zoom = THREE.MathUtils.clamp(Math.min(this.width / (b.maxX - b.minX + 100), this.height / ((b.maxY - b.minY + 100) * sin)), MIN_ZOOM, MAX_ZOOM);
    this.target.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    this.updateTop();
  }

  /** Pixels per metre in the top view (null for perspective cameras, where it varies with depth). */
  get pixelsPerMetre(): number | null { return this.mode === 'top' ? this.zoom : null; }

  /** Point-sprite scale for the active camera, in device pixels. */
  spriteScale(pixelRatio: number): number {
    return this.mode === 'top' ? this.zoom * pixelRatio : this.height * pixelRatio / (2 * Math.tan(THREE.MathUtils.degToRad(this.persp.fov) / 2));
  }

  /** Ground point the shadows are centred on, and roughly how much ground is in view (m). */
  focus(out: THREE.Vector3): number {
    if (this.mode === 'top') {
      out.set(this.target.x, 0, this.target.y);
      return Math.max(this.width, this.height / Math.sin(this.tilt)) / this.zoom;
    }
    out.copy(this.chaseLook).setY(0);
    return 160;
  }
}
