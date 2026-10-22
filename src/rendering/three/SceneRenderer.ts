import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Car, TrajectoryPoint } from '../../physics/Car';
import { Track } from '../../track/Track';
import type { RacingLine } from '../../track/RacingLine';
import { Vector2 } from '../../math/Vector2';
import { TrackMesh } from './TrackMesh';
import { CarFleet, CarView } from './CarFleet';
import { Effects } from './Effects';
import { Overlays } from './Overlays';
import { CameraRig } from './Cameras';
import { Labels } from './Labels';
import { RaceHud } from './Hud';
import { Textures } from './Textures';

export interface FrameState {
  track: Track;
  cars: Car[];
  player: Car | null;
  leader: Car | null;
  selected: Car | null;
  racingLine: TrajectoryPoint[] | null;
  /** The precomputed line the drivers aim for (see RacingLine). */
  plannedLine: RacingLine | null;
  drawMode: boolean;
  /** Simulation not advancing (paused, finished session): wheels stop and no new smoke or marks. */
  frozen: boolean;
  drawing: { points: Vector2[]; mouse: Vector2 | null; anchor: Vector2 | null } | null;
  raceState: string;
  startLights: number;
  winner: string | null;
}

/** Sun direction (towards the light): high afternoon sun from the upper left of the top view. */
const SUN = new THREE.Vector3(-0.45, 1, -0.35).normalize();
const SHADOW_MAP = 2048;

export type SkyKind = 'day' | 'overcast' | 'night';

/** Each sky panorama and the light that goes with it (night: floodlights from above). */
const SKIES: Record<SkyKind, { file: string; sun: number; sunColor: number; hemi: number; env: number; fog: number }> = {
  day: { file: 'sky_day.webp', sun: 2.6, sunColor: 0xfff1dc, hemi: 0.9, env: 0.5, fog: 0xc4d0d7 },
  overcast: { file: 'sky_overcast.webp', sun: 1.1, sunColor: 0xe6eaee, hemi: 1.4, env: 0.7, fog: 0x989b99 },
  night: { file: 'sky_night.webp', sun: 2.6, sunColor: 0xeef2ff, hemi: 0.7, env: 0.6, fog: 0x2a2633 },
};

/**
 * The 3D view of the circuit: Three.js scene with PBR materials, a shadow-casting sun that
 * follows the camera, a sky panorama for the backdrop and reflections, the instanced car fleet,
 * particles and the HTML label/HUD layers. Geometry is procedural; see Textures for the maps.
 */
export class SceneRenderer {
  showSensors = true;
  showCheckpoints = false;
  showRacingLine = true;
  showCarSpeed = true;
  readonly cameras = new CameraRig();

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  private readonly hemi = new THREE.HemisphereLight(0xdde8ff, 0x3b4a2c, 0.9);
  private skyKind: SkyKind | null = null;
  private readonly skies = new Map<SkyKind, { sky: THREE.Texture; env: THREE.Texture }>();
  private readonly trackMesh = new TrackMesh();
  private readonly fleet = new CarFleet();
  private readonly effects = new Effects();
  private readonly overlays = new Overlays();
  private readonly labels: Labels;
  private readonly hud: RaceHud;
  private sky: THREE.Texture = Textures.sky();
  private readonly groundColor = new THREE.Color(0x26331f);
  private readonly fog = new THREE.Fog(0xc4d0d7, 300, 2600);
  private readonly views: CarView[] = [];
  private readonly effectCars: Car[] = [];
  private readonly focusPoint = new THREE.Vector3();
  private readonly screen = new THREE.Vector2();
  private lastTime = performance.now();
  private fitPending = false;
  private framedBounds: { minX: number; maxX: number; minY: number; maxY: number } | null = null;

  constructor(canvas: HTMLCanvasElement, overlayRoot: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    const pmrem = new THREE.PMREMGenerator(this.renderer), room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    this.scene.environmentIntensity = 0.5;
    room.dispose();
    pmrem.dispose();
    this.scene.background = this.groundColor;
    this.setSky('day');

    this.scene.add(this.hemi);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    this.sun.shadow.bias = -0.0003;
    this.scene.add(this.sun, this.sun.target);

    this.scene.add(this.trackMesh.group, this.trackMesh.checkpoints, this.effects.group, this.fleet.group, this.overlays.group);

    const labelLayer = document.createElement('div');
    labelLayer.className = 'label-layer';
    overlayRoot.appendChild(labelLayer);
    this.labels = new Labels(labelLayer);
    this.hud = new RaceHud(overlayRoot);
  }

  resize(width: number, height: number): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.cameras.setViewport(width, height);
  }

  get trackBounds() { return this.trackMesh.bounds; }

  screenToWorld(sx: number, sy: number): Vector2 | null { return this.cameras.screenToWorld(sx, sy); }

  /** Nearest live car within `radius` CSS pixels of a screen point, for any camera. */
  pickCar(sx: number, sy: number, cars: Car[], radius = 24): Car | null {
    let best: Car | null = null, bestDist = radius;
    for (const car of cars) {
      if (!car.isAlive || !this.cameras.worldToScreen(car.pos.x, car.pos.y, 0.4, this.screen)) continue;
      const d = Math.hypot(this.screen.x - sx, this.screen.y - sy);
      if (d < bestDist) { bestDist = d; best = car; }
    }
    return best;
  }

  render(f: FrameState): void {
    const now = performance.now(), dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const rig = this.cameras;

    if (this.trackMesh.update(f.track)) {
      rig.setTrack(f.track);
      this.effects.clear();
      // Frame a different circuit; a width change of the same one keeps the user's view.
      this.fitPending = this.isNewLayout(this.trackMesh.bounds);
    }
    rig.setDrawMode(f.drawMode);
    if (this.fitPending && !f.drawMode) {
      rig.fit(this.trackMesh.bounds);
      this.framedBounds = { ...this.trackMesh.bounds };
      this.fitPending = false;
    }

    this.views.length = 0;
    this.effectCars.length = 0;
    if (!f.drawMode) {
      for (const car of f.cars) {
        this.views.push({ car, isLeader: car === f.leader, isPlayer: car.isManual, isSelected: car === f.selected });
        this.effectCars.push(car);
      }
      if (f.player && f.player.isAlive) {
        this.views.push({ car: f.player, isLeader: false, isPlayer: true, isSelected: f.player === f.selected });
        this.effectCars.push(f.player);
      }
    }
    const focus = f.selected ?? (f.player?.isAlive ? f.player : null) ?? f.leader ?? f.cars[0] ?? null;
    rig.update(dt, f.drawMode ? null : focus);

    this.fleet.group.visible = !f.drawMode;
    this.fleet.update(this.views, f.frozen ? 0 : dt, rig.pixelsPerMetre);
    this.effects.group.visible = !f.drawMode;
    if (!f.drawMode) this.effects.update(this.effectCars, dt, !f.frozen);
    this.effects.setProjection(rig.spriteScale(this.renderer.getPixelRatio()), rig.isPerspective);

    this.overlays.setRacingLine(this.showRacingLine && !f.drawMode ? f.racingLine : null);
    this.overlays.setPlannedLine(this.showRacingLine && !f.drawMode ? f.track : null, f.plannedLine);
    const sensorCar = this.showSensors && !f.drawMode ? (f.selected ?? f.leader) : null;
    this.overlays.setSensors(sensorCar && sensorCar.isAlive ? sensorCar : null);
    const badge = this.overlays.setDrawing(f.drawMode && f.drawing ? f.drawing.points : null, f.drawing?.mouse ?? null, f.drawing?.anchor ?? null);
    this.trackMesh.checkpoints.visible = this.showCheckpoints;

    this.updateSun();
    const perspective = rig.isPerspective;
    this.scene.background = perspective ? this.sky : this.groundColor;
    this.scene.fog = perspective ? this.fog : null;

    this.renderer.render(this.scene, rig.active);

    this.labels.update(rig, this.views, this.showCarSpeed, f.drawMode ? [] : this.trackMesh.staticLabels, badge);
    this.hud.update(f.raceState, f.startLights, f.winner, f.drawMode, rig.pixelsPerMetre);
  }

  /**
   * Setting for a circuit file from tracks/ (none: presets and drawn tracks): night races under
   * lights, a grey sky for some European rounds, a city skyline around street circuits.
   */
  setCircuit(trackFile = ''): void {
    const sky: SkyKind = /^(sg|ae|bh|sa|qa)-|las-vegas/.test(trackFile) ? 'night'
      : /^(gb|be|de|nl)-/.test(trackFile) ? 'overcast' : 'day';
    this.setSky(sky);
    this.trackMesh.setScenery(/^(mc|sg|az|sa)-|las-vegas|miami/.test(trackFile), sky === 'night');
  }

  /**
   * Switches the lighting at once; the panorama (backdrop and reflections, in place of the studio
   * environment) follows when it has loaded. Loaded skies are kept for the next switch.
   */
  private setSky(kind: SkyKind): void {
    if (kind === this.skyKind) return;
    this.skyKind = kind;
    const look = SKIES[kind];
    this.sun.intensity = look.sun;
    this.sun.color.set(look.sunColor);
    this.hemi.intensity = look.hemi;
    this.scene.environmentIntensity = look.env;
    this.fog.color.set(look.fog);
    const show = (loaded: { sky: THREE.Texture; env: THREE.Texture }) => {
      if (this.skyKind !== kind) return;
      this.sky = loaded.sky;
      this.scene.environment = loaded.env;
    };
    const cached = this.skies.get(kind);
    if (cached) { show(cached); return; }
    Textures.skyPanorama(look.file, sky => {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const loaded = { sky, env: pmrem.fromEquirectangular(sky).texture };
      pmrem.dispose();
      this.skies.set(kind, loaded);
      show(loaded);
    });
  }

  private isNewLayout(b: { minX: number; maxX: number; minY: number; maxY: number }): boolean {
    const a = this.framedBounds;
    if (!a) return true;
    const size = Math.max(a.maxX - a.minX, a.maxY - a.minY, 1);
    const shift = Math.hypot((a.minX + a.maxX - b.minX - b.maxX) / 2, (a.minY + a.maxY - b.minY - b.maxY) / 2);
    const resize = Math.abs((b.maxX - b.minX) - (a.maxX - a.minX)) + Math.abs((b.maxY - b.minY) - (a.maxY - a.minY));
    return shift > size * 0.1 || resize > size * 0.25;
  }

  /** The shadow frustum covers what is in view, so a close camera gets sharp car shadows. */
  private updateSun(): void {
    const view = this.cameras.focus(this.focusPoint);
    const extent = THREE.MathUtils.clamp(view * 0.6, 30, 1400);
    const cam = this.sun.shadow.camera;
    if (cam.right !== extent) {
      cam.left = -extent; cam.right = extent; cam.top = extent; cam.bottom = -extent;
      cam.near = 1; cam.far = 3000;
      cam.updateProjectionMatrix();
      this.sun.shadow.normalBias = extent * 2 / SHADOW_MAP * 1.5;
    }
    this.sun.target.position.copy(this.focusPoint);
    this.sun.position.copy(this.focusPoint).addScaledVector(SUN, 1200);
    this.sun.target.updateMatrixWorld();
  }
}
