import { loadDriverPressure, normalizePressure } from './ai/DriverPressure';
import { Vector2 } from './math/Vector2';
import { Spline } from './math/Spline';
import { Track } from './track/Track';
import { Presets } from './track/Presets';
import { getRacingLine } from './track/RacingLine';
import { Population } from './ai/Population';
import { Car, CarControl, driverInputCount } from './physics/Car';
import { clampStressShare, DEFAULT_STRESS_LAP_SHARE } from './physics/SimConfig';
import { COMPOUND_SPECS, isCompound } from './physics/Tyres';
import { isWeatherScenario, type WeatherState } from './physics/Weather';
import { SceneRenderer } from './rendering/three/SceneRenderer';
import { MotionInterpolator } from './rendering/MotionInterpolator';
import type { CameraMode } from './rendering/three/Cameras';
import { HudCharts } from './rendering/HudCharts';
import { hydrateIcons, setControlContent } from './ui/icons';
import { SimBridge, type ComputeProfile, type TopologySpecifier } from './workers/SimBridge';
import type { SimSnapshot } from './workers/sim.worker';
import { SnapshotSync, type SyncTarget } from './ui/SnapshotSync';
import { RaceUI, type RaceUIHost } from './ui/RaceUI';
import { InputController } from './ui/InputController';
import { formatLapTime } from './ui/format';
import realTrackIndex from '../tracks/index.json';

/** Real F1 circuits built by scripts/build-tracks.mjs; each file is fetched only when picked. */
const REAL_TRACK_FILES = import.meta.glob<string>(['../tracks/*.json', '!../tracks/index.json'], { query: '?raw', import: 'default' });

function loadFlag(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}

function loadSetting(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function wetnessLabel(wetness: number): string {
  return wetness < 0.15 ? 'suchy' : wetness < 0.45 ? 'przesychający' : wetness < 0.7 ? 'wilgotny' : wetness < 0.9 ? 'mokry' : 'zalany';
}

/** Weather in one telemetry line: sky, temperatures, the wind and where it blows, the surface. */
function weatherLine(w: WeatherState): string {
  const sky = w.rain > 0.6 ? '⛈ ulewa' : w.rain > 0.02 ? '🌧 deszcz' : w.cloud > 0.65 ? '☁ pochmurno' : w.cloud > 0.3 ? '⛅ przejaśnienia' : '☀ słońce';
  // The arrow points where the wind blows to, in the top view (screen y grows downwards, as world y).
  const arrows = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
  const dir = arrows[((Math.round(w.windDir / (Math.PI / 4)) % 8) + 8) % 8];
  const wind = Math.hypot(w.windX, w.windY);
  return `POGODA ${sky} · powietrze ${Math.round(w.airTemp)}° · tor ${Math.round(w.trackTemp)}°${w.windSpeed > 0.5 ? ` · wiatr ${dir} ${wind.toFixed(0)} m/s` : ''} · nawierzchnia ${wetnessLabel(w.wetness)}`;
}

class App {
  private canvas: HTMLCanvasElement;
  private brainCanvas: HTMLCanvasElement;
  private gMeterCanvas: HTMLCanvasElement;
  private learningChartCanvas: HTMLCanvasElement;
  private renderer: SceneRenderer;
  private motion = new MotionInterpolator();
  private readonly hudCharts = new HudCharts();

  // Web Worker Multithreading Bridge
  private bridge: SimBridge;

  // Track & AI
  private track: Track;
  private population: Population;
  private playerCar: Car | null = null;
  private isPlayerDriving: boolean = false;
  private selectedCar: Car | null = null;

  private followSelected = false;
  private viewSize = { width: 0, height: 0 };
  private panStart: { x: number; y: number } | null = null;
  private didPan = false;

  // Drawing state
  private isDrawMode: boolean = false;
  private isMouseDown: boolean = false;
  private rawDrawnPoints: Vector2[] = [];
  /** Driving direction of an imported real circuit: its point order is kept. Null for drawn tracks and presets. */
  private trackDirection: 'clockwise' | 'counterclockwise' | null = null;
  private drawSourceBackup: Vector2[] = [];
  private drawnTrackRejected = false;
  private mousePos: Vector2 | null = null;
  private straightAnchor: Vector2 | null = null;
  private trackWidth: number = 14;

  // Simulation controls
  private isPaused: boolean = true;

  // Race Mode State
  private selectedRaceLaps: number = 50;
  private withQualifying = loadFlag('f1_with_qualifying');
  /** The session as the worker last reported it, and the display copy of the field it keeps. */
  private readonly sync = new SnapshotSync();
  private readonly raceUI: RaceUI;
  private readonly input: InputController;
  /** The page state the snapshots update and the race screens read. */
  private readonly page: SyncTarget & RaceUIHost;

  private driverPressure = loadDriverPressure();

  constructor() {
    this.canvas = document.getElementById('sim-canvas') as HTMLCanvasElement;
    this.brainCanvas = document.getElementById('brain-canvas') as HTMLCanvasElement;
    this.gMeterCanvas = document.getElementById('g-meter-canvas') as HTMLCanvasElement;
    this.learningChartCanvas = document.getElementById('learning-chart') as HTMLCanvasElement;
    this.renderer = new SceneRenderer(this.canvas, document.getElementById('canvas-wrapper')!);

    const initDims = Car.getDimensionsForTrackWidth(this.trackWidth);
    this.track = Presets.createGrandPrixTrack(initDims.effectiveTrackWidth);
    this.rawDrawnPoints = Presets.GRAND_PRIX_POINTS.map(p => p.clone());
    this.population = new Population(Population.MAX_CARS, this.track, 25);
    this.population.setDriverPressure(this.driverPressure, true);

    const app = this;
    const page = {
      get session() { return app.sync.session; },
      get population() { return app.population; },
      get track() { return app.track; },
      get playerCar() { return app.playerCar; },
      get selectedCar() { return app.selectedCar; },
      get isPlayerDriving() { return app.isPlayerDriving; },
      get motion() { return app.motion; },
      startQualifiedRace: () => app.startRace(app.selectedRaceLaps, { useQualifyingGrid: true }),
    };
    this.page = page;
    this.raceUI = new RaceUI(page);
    this.input = new InputController({
      isDriving: () => this.isPlayerDriving,
      onPitToggle: () => this.togglePlayerPit(),
      onShift: down => this.onShift(down),
    });

    this.bridge = new SimBridge();
    this.setupBridgeSync();

    this.setupWindowEvents();
    this.setupUIEvents();
    this.resizeCanvas();

    this.setupAutosave();

    // Start simulation loop
    requestAnimationFrame(this.loop.bind(this));
  }

  private static readonly AUTOSAVE_KEY = 'f1_autosave_models';
  private autosaveMarker = '';
  /** Bumped by the clean slate, so an autosave read before it is never written back. */
  private learningEpoch = 0;

  /** Training results (best laps, brains, generation) survive page reloads for the same circuit. */
  private setupAutosave(): void {
    const circuit = () => `${this.track.totalLength.toFixed(1)}|${this.population.rayCount}|in${driverInputCount(this.population.rayCount)}`;
    let restored = false;
    const tryRestore = async () => {
      restored = true;
      try {
        const raw = localStorage.getItem(App.AUTOSAVE_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (saved.circuit !== circuit() || !saved.models) return;
        if (await this.loadModelFromJSON(JSON.stringify(saved.models), true)) {
          this.autosaveMarker = `${saved.models.generation}|${saved.models.globalBestLap}`;
        }
      } catch (e) { console.warn('Nie udało się odczytać autozapisu:', e); }
    };
    const save = async () => {
      if (!this.bridge.isReady) return;
      if (!restored) { await tryRestore(); return; }
      try {
        const epoch = this.learningEpoch;
        const models = await this.bridge.getAllModels();
        if (!models || !Array.isArray(models.drivers) || epoch !== this.learningEpoch) return;
        const marker = `${models.generation}|${models.globalBestLap}|${models.drivers.map((d: any) => `${d.bestLapTime}/${d.pace?.margin}/${d.lineNet?.bestTime}`).join(',')}`;
        if (marker === this.autosaveMarker) return;
        const write = (m: any) => localStorage.setItem(App.AUTOSAVE_KEY, JSON.stringify({ circuit: circuit(), savedAt: Date.now(), models: m }));
        try { write(models); }
        catch { write({ ...models, drivers: models.drivers.map((d: any) => ({ ...d, brain: null })) }); } // quota: keep records + best brains
        this.autosaveMarker = marker;
      } catch (e) { console.warn('Autozapis nie powiódł się:', e); }
    };
    window.setInterval(save, 10000);
    window.setTimeout(() => { if (!restored) void save(); }, 1500);
  }

  /** Without the simulation worker nothing can run: say so instead of showing a frozen grid. */
  private showWorkerUnavailable(): void {
    const banner = document.getElementById('start-banner');
    if (!banner) return;
    banner.classList.remove('hidden');
    const title = banner.querySelector('.start-title');
    if (title) title.textContent = 'Symulacja niedostępna';
    const text = banner.querySelector('p');
    if (text) text.textContent = 'Ta przeglądarka nie uruchomiła Web Workera z symulacją (wymagane moduły ES w workerach). Otwórz stronę w aktualnej wersji Chrome, Firefoksa, Safari lub Edge i odśwież.';
    banner.querySelector('#btn-start-banner')?.classList.add('hidden');
  }

  private setupBridgeSync(): void {
    this.bridge.onTrackError = message => alert(message);
    this.bridge.onUnavailable = () => this.showWorkerUnavailable();
    if (this.bridge.unavailable) this.showWorkerUnavailable();
    const threadBadge = document.getElementById('thread-badge');
    if (threadBadge) {
      threadBadge.textContent = `${this.bridge.cpuCores} rdzeni`;
      threadBadge.title = `${this.bridge.cpuCores} rdzeni CPU · symulacja w Web Workerze`;
    }

    this.bridge.onSnapshotCallback = (snapshot: SimSnapshot) => {
      this.sync.apply(snapshot, this.page);
      this.raceUI.onSnapshot(snapshot);
    };
  }

  private resizeCanvas(): void {
    const wrapper = document.getElementById('canvas-wrapper')!;
    const rect = wrapper.getBoundingClientRect();
    this.renderer.resize(rect.width, rect.height);
  }

  private commitStraightSegment(from: Vector2, to: Vector2): void {
    const dist = from.dist(to);
    if (dist > 8) {
      const steps = Math.max(1, Math.floor(dist / 14));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        this.rawDrawnPoints.push(Vector2.lerp(from, to, t));
      }
    }
    this.straightAnchor = null;
  }

  private setupWindowEvents(): void {
    window.addEventListener('resize', () => this.resizeCanvas());

  }

  /** Shift while drawing: held, the stroke becomes a straight from where it was; released, the straight is laid. */
  private onShift(down: boolean): void {
    if (!this.isDrawMode || !this.isMouseDown) return;
    if (down && !this.straightAnchor) {
      const last = this.rawDrawnPoints[this.rawDrawnPoints.length - 1];
      this.straightAnchor = last ? last.clone() : (this.mousePos ? this.mousePos.clone() : null);
    } else if (!down && this.straightAnchor && this.mousePos) {
      this.commitStraightSegment(this.straightAnchor, this.mousePos);
    }
  }

  private setupUIEvents(): void {
    const canvas = this.canvas;

    const cameras = this.renderer.cameras;
    document.getElementById('btn-zoom-in')!.addEventListener('click', () => cameras.zoomAt(1.25));
    document.getElementById('btn-zoom-out')!.addEventListener('click', () => cameras.zoomAt(1 / 1.25));
    document.getElementById('btn-camera-fit')!.addEventListener('click', () => {
      this.followSelected = false;
      cameras.mode = 'top';
      cameras.fit(this.renderer.trackBounds);
    });
    const cameraModes: CameraMode[] = ['top', 'chase', 'tv'];
    document.querySelectorAll<HTMLButtonElement>('[data-camera-mode]').forEach(button => {
      button.addEventListener('click', () => {
        const mode = button.dataset.cameraMode as CameraMode;
        if (!cameraModes.includes(mode)) return;
        cameras.mode = mode;
        // Chase and TV need a car: default to the leader, as the follow button does.
        if (mode !== 'top' && !this.selectedCar) {
          this.selectedCar = this.population.currentLeader || this.population.cars[0] || null;
          this.bridge.setActiveCarColor(this.selectedCar?.color || null);
        }
      });
    });
    document.getElementById('btn-camera-follow')!.addEventListener('click', () => {
      this.followSelected = !this.followSelected;
      if (this.followSelected && !this.selectedCar) {
        this.selectedCar = this.population.currentLeader || this.population.cars[0];
        this.bridge.setActiveCarColor(this.selectedCar?.color || null);
      }
    });
    canvas.addEventListener('wheel', e => {
      if (this.isDrawMode) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      cameras.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
    canvas.addEventListener('pointerdown', e => {
      if (this.isDrawMode || e.button !== 0) return;
      this.didPan = false;
      this.panStart = { x: e.clientX, y: e.clientY };
      const rect = canvas.getBoundingClientRect();
      cameras.beginPan(e.clientX - rect.left, e.clientY - rect.top);
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (!this.panStart) return;
      const dx = e.clientX - this.panStart.x, dy = e.clientY - this.panStart.y;
      if (Math.hypot(dx, dy) > 4) this.didPan = true;
      if (this.didPan) {
        this.followSelected = false;
        const rect = canvas.getBoundingClientRect();
        cameras.panTo(e.clientX - rect.left, e.clientY - rect.top);
      }
    });
    const endPan = () => { this.panStart = null; cameras.endPan(); };
    canvas.addEventListener('pointerup', endPan);
    canvas.addEventListener('pointercancel', endPan);

    // Drawing mouse events
    canvas.addEventListener('mousedown', (e) => {
      if (!this.isDrawMode) return;
      this.isMouseDown = true;
      this.drawnTrackRejected = false;
      const pt = this.getCanvasMousePos(e);
      this.rawDrawnPoints = [pt];
      this.straightAnchor = (e.shiftKey || this.input.shiftHeld) ? pt.clone() : null;
    });

    canvas.addEventListener('mousemove', (e) => {
      this.mousePos = this.getCanvasMousePos(e);
      if (this.isDrawMode && this.isMouseDown) {
        if (e.shiftKey || this.input.shiftHeld) {
          if (!this.straightAnchor) {
            const last = this.rawDrawnPoints[this.rawDrawnPoints.length - 1];
            this.straightAnchor = last ? last.clone() : this.mousePos.clone();
          }
          // Straight line guide stretches dynamically while Shift is held
        } else {
          if (this.straightAnchor) {
            this.commitStraightSegment(this.straightAnchor, this.mousePos);
          }
          const last = this.rawDrawnPoints[this.rawDrawnPoints.length - 1];
          if (!last || last.dist(this.mousePos) > 12) {
            this.rawDrawnPoints.push(this.mousePos.clone());
          }
        }
      }
    });

    window.addEventListener('mouseup', () => {
      if (this.isDrawMode && this.isMouseDown) {
        if (this.straightAnchor && this.mousePos) {
          this.commitStraightSegment(this.straightAnchor, this.mousePos);
        }
        this.isMouseDown = false;
        this.finishDrawnTrack();
      }
    });

    // Canvas click to select a car on track
    canvas.addEventListener('click', (e) => {
      if (this.isDrawMode || this.didPan) return;
      const rect = canvas.getBoundingClientRect();
      const candidates = this.playerCar ? [...this.population.cars, this.playerCar] : this.population.cars;
      // Constant screen-space selection radius, for any camera.
      const closestCar = this.renderer.pickCar(e.clientX - rect.left, e.clientY - rect.top, candidates, 24);

      if (closestCar) {
        this.selectedCar = (this.selectedCar === closestCar) ? null : closestCar;
        this.bridge.setActiveCarColor(this.selectedCar ? this.selectedCar.color : null);
        if (this.isPlayerDriving && this.selectedCar) {
          for (const c of this.population.cars) {
            c.isManual = (c === this.selectedCar);
          }
          this.bridge.setPlayerDriving(true, this.selectedCar.color);
        }
      }
    });

    // Leaderboard item click to select driver
    const leaderboardContainer = document.getElementById('leaderboard-list');
    leaderboardContainer?.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const item = (e.target as HTMLElement).closest('.leaderboard-item') as HTMLElement | null;
      if (!item) return;

      const isPlayer = item.getAttribute('data-is-player') === 'true';
      const carColor = item.getAttribute('data-car-color');

      if (isPlayer && this.playerCar) {
        this.selectedCar = (this.selectedCar === this.playerCar) ? null : this.playerCar;
        this.bridge.setActiveCarColor(null);
      } else if (carColor) {
        const matched = this.population.cars.find(c => c.color === carColor);
        if (matched) {
          this.selectedCar = (this.selectedCar === matched) ? null : matched;
          this.bridge.setActiveCarColor(this.selectedCar ? this.selectedCar.color : null);
          if (this.isPlayerDriving && this.selectedCar) {
            for (const c of this.population.cars) {
              c.isManual = (c === this.selectedCar);
            }
            this.bridge.setPlayerDriving(true, this.selectedCar.color);
          }
        }
      }
    });

    const btnClearSelection = document.getElementById('btn-clear-selection');
    btnClearSelection?.addEventListener('click', () => {
      this.selectedCar = null;
      this.bridge.setActiveCarColor(null);
      if (this.isPlayerDriving) {
        const leader = this.population.currentLeader || this.population.cars[0];
        if (leader) {
          for (const c of this.population.cars) {
            c.isManual = (c === leader);
          }
          this.bridge.setPlayerDriving(true, leader.color);
        }
      }
    });

    // Reset brain for selected / active car
    const handleResetBrain = () => {
      const target = this.selectedCar || (this.isPlayerDriving && this.playerCar?.isAlive ? null : this.population.currentLeader) || this.population.cars[0];
      if (target && target !== this.playerCar) {
        this.population.resetSingleCarBrain(target, this.track);
        this.bridge.resetSingleBrain(target.color);
        const btn1 = document.getElementById('btn-reset-selected-brain');
        const btn2 = document.getElementById('btn-reset-current-brain');
        [btn1, btn2].forEach(b => {
          if (b) {
            b.classList.add('highlight');
            setTimeout(() => b.classList.remove('highlight'), 500);
          }
        });
      }
    };

    document.getElementById('btn-reset-selected-brain')?.addEventListener('click', handleResetBrain);
    document.getElementById('btn-reset-current-brain')?.addEventListener('click', handleResetBrain);

    document.getElementById('btn-reset-best-times')?.addEventListener('click', () => {
      this.resetBestTimes();
    });

    // Control buttons
    const btnDraw = document.getElementById('btn-draw')!;
    const drawBanner = document.getElementById('draw-banner')!;
    btnDraw.addEventListener('click', () => {
      this.isDrawMode = !this.isDrawMode;
      if (this.isDrawMode) {
        this.followSelected = false;
        btnDraw.classList.add('active');
        setControlContent(btnDraw, 'check', 'Zakończ rysowanie');
        drawBanner.classList.remove('hidden');
        this.drawnTrackRejected = false;
        this.drawSourceBackup = this.rawDrawnPoints.map(p => p.clone());
        this.rawDrawnPoints = [];
      } else {
        btnDraw.classList.remove('active');
        setControlContent(btnDraw, 'pencil', 'Rysuj tor');
        drawBanner.classList.add('hidden');
        if (this.rawDrawnPoints.length > 5 && !this.drawnTrackRejected) {
          this.finishDrawnTrack();
        } else {
          this.rawDrawnPoints = this.drawSourceBackup.map(p => p.clone());
        }
      }
    });

    const btnPlay = document.getElementById('btn-play')!;
    const btnStop = document.getElementById('btn-stop')!;
    const startBanner = document.getElementById('start-banner');
    const btnStartBanner = document.getElementById('btn-start-banner');

    const setPlayState = (play: boolean) => {
      this.isPaused = !play;
      this.bridge.setPaused(this.isPaused);
      if (play) {
        startBanner?.classList.add('hidden');
        setControlContent(btnPlay, 'pause', 'Pauza');
        btnPlay.classList.add('primary');
      } else {
        setControlContent(btnPlay, 'play', 'Wznów');
        btnPlay.classList.remove('primary');
      }
    };

    btnPlay.addEventListener('click', () => {
      setPlayState(this.isPaused);
    });

    btnStartBanner?.addEventListener('click', () => {
      setPlayState(true);
    });

    btnStop.addEventListener('click', () => {
      this.isPaused = true;
      this.bridge.setPaused(true);
      setControlContent(btnPlay, 'play', 'Start');
      btnPlay.classList.remove('primary');

      if (this.sync.session.raceState !== 'IDLE') {
        this.stopRace();
      } else {
        this.resetCarPositions();
        this.bridge.resetCarPositions();
      }
      startBanner?.classList.remove('hidden');
    });

    const btnRestart = document.getElementById('btn-restart')!;
    btnRestart.addEventListener('click', () => {
      const prevColor = this.selectedCar?.color;
      this.population.evolve(this.track);
      this.bridge.evolvePopulation();
      if (prevColor) {
        this.selectedCar = this.population.cars.find(c => c.color === prevColor) || null;
      }
    });

    document.getElementById('btn-clear-learning')?.addEventListener('click', () => { void this.clearLearning(); });

    const btnRefuel = document.getElementById('btn-refuel')!;
    btnRefuel.addEventListener('click', () => {
      // Training only: nobody refuels in qualifying or a race.
      if (this.sync.session.raceState !== 'IDLE') return;
      for (const car of this.population.cars) {
        car.fuelKg = this.population.startingFuelKg;
        car.isOutOfFuel = false;
      }
      if (this.playerCar) {
        this.playerCar.fuelKg = this.population.startingFuelKg;
        this.playerCar.isOutOfFuel = false;
      }
      this.bridge.refuel();
      btnRefuel.classList.add('highlight');
      setTimeout(() => btnRefuel.classList.remove('highlight'), 600);
    });

    const btnDrive = document.getElementById('btn-drive')!;
    const playerHud = document.getElementById('player-hud')!;
    const btnTakeover = document.getElementById('btn-takeover-driver');

    const togglePlayerDriving = (forceState?: boolean) => {
      this.isPlayerDriving = (forceState !== undefined) ? forceState : !this.isPlayerDriving;
      btnDrive.classList.toggle('active', this.isPlayerDriving);
      playerHud.classList.toggle('hidden', !this.isPlayerDriving);

      if (this.isPlayerDriving) {
        if (!this.selectedCar) {
          this.selectedCar = this.population.currentLeader || this.population.cars[0];
        }

        if (this.selectedCar) {
          for (const car of this.population.cars) {
            car.isManual = (car === this.selectedCar);
          }
          this.bridge.setPlayerDriving(true, this.selectedCar.color);
          this.bridge.setActiveCarColor(this.selectedCar.color);
        } else {
          this.bridge.setPlayerDriving(true, null);
        }

        // Auto-unpause if paused so player can drive immediately
        if (this.isPaused) {
          this.isPaused = false;
          this.bridge.setPaused(false);
          const btnPlay = document.getElementById('btn-play');
          const startBanner = document.getElementById('start-banner');
          startBanner?.classList.add('hidden');
          if (btnPlay) {
            setControlContent(btnPlay, 'pause', 'Pauza');
            btnPlay.classList.add('primary');
          }
        }
      } else {
        for (const car of this.population.cars) {
          car.isManual = false;
        }
        this.bridge.setPlayerDriving(false, null);
      }
      this.updateHUD();
    };

    btnDrive.addEventListener('click', () => togglePlayerDriving());
    btnTakeover?.addEventListener('click', () => {
      if (this.isPlayerDriving && this.selectedCar?.isManual) {
        togglePlayerDriving(false);
      } else {
        togglePlayerDriving(true);
      }
    });

    // Speed controls
    const speedButtons = document.querySelectorAll('.speed-btn');
    speedButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        speedButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const speed = btn.getAttribute('data-speed');
        this.bridge.setSpeed(speed === 'max' ? 'max' : parseInt(speed || '1', 10));
      });
    });

    // Preset buttons
    document.getElementById('preset-gp')!.addEventListener('click', () => {
      const dims = Car.getDimensionsForTrackWidth(this.trackWidth);
      this.track = Presets.createGrandPrixTrack(dims.effectiveTrackWidth);
      this.renderer.setCircuit();
      this.rawDrawnPoints = Presets.GRAND_PRIX_POINTS.map(p => p.clone());
      this.trackDirection = null;
      this.population = new Population(Population.MAX_CARS, this.track, this.population.rayCount, this.population.topology);
      this.population.setDriverPressure(this.driverPressure, true);
      this.bridge.setPreset('gp');
      if (this.selectedCar) {
        const color = this.selectedCar.color;
        this.selectedCar = this.population.cars.find(c => c.color === color) || null;
      }
      if (this.playerCar) {
        this.playerCar.reset(this.track.startPosition, this.track.startAngle, true);
        this.playerCar.updateDimensionsForTrackWidth(this.trackWidth);
      }
    });

    document.getElementById('preset-oval')!.addEventListener('click', () => {
      const dims = Car.getDimensionsForTrackWidth(this.trackWidth);
      this.track = Presets.createOvalTrack(dims.effectiveTrackWidth);
      this.renderer.setCircuit();
      this.rawDrawnPoints = Presets.OVAL_POINTS.map(p => p.clone());
      this.trackDirection = null;
      this.population = new Population(Population.MAX_CARS, this.track, this.population.rayCount, this.population.topology);
      this.population.setDriverPressure(this.driverPressure, true);
      this.bridge.setPreset('oval');
      if (this.selectedCar) {
        const color = this.selectedCar.color;
        this.selectedCar = this.population.cars.find(c => c.color === color) || null;
      }
      if (this.playerCar) {
        this.playerCar.reset(this.track.startPosition, this.track.startAngle, true);
        this.playerCar.updateDimensionsForTrackWidth(this.trackWidth);
      }
    });

    this.setupRealTrackSelect();

    // Sliders
    const widthSlider = document.getElementById('slider-track-width') as HTMLInputElement;
    const widthLabel = document.getElementById('val-track-width')!;
    // Rebuilding the track retrains the seed networks (~2 s): dragging only moves the label,
    // releasing the slider applies the width once.
    widthSlider.addEventListener('input', () => { widthLabel.textContent = widthSlider.value; });
    widthSlider.addEventListener('change', () => {
      const previousWidth = this.trackWidth;
      this.trackWidth = parseInt(widthSlider.value, 10);
      if (this.trackWidth === previousWidth) return;
      widthLabel.textContent = this.trackWidth.toString();
      const dims = Car.getDimensionsForTrackWidth(this.trackWidth);
      if (this.track.points.length > 0) {
        const sourcePoints = (this.rawDrawnPoints && this.rawDrawnPoints.length >= 4)
          ? this.rawDrawnPoints
          : this.track.points.map((p) => p.center);
        const newPoints = Spline.generateClosedTrack(sourcePoints, dims.effectiveTrackWidth, 18, !!this.trackDirection);
        if (newPoints.length > 3) {
          try { this.track = new Track(newPoints, dims.effectiveTrackWidth); }
          catch (error) {
            this.trackWidth = previousWidth;
            widthSlider.value = String(previousWidth); widthLabel.textContent = String(previousWidth);
            alert(error instanceof Error ? error.message : 'Niepoprawna szerokość toru.'); return;
          }
          this.population.resetAll(this.track);
          this.bridge.setTrackWidth(this.trackWidth, sourcePoints.map(p => ({ x: p.x, y: p.y })), !!this.trackDirection);
          if (this.playerCar) {
            this.playerCar.reset(this.track.startPosition, this.track.startAngle, true);
            this.playerCar.updateDimensionsForTrackWidth(this.trackWidth);
          }
        }
      }
    });

    const fuelSlider = document.getElementById('slider-fuel') as HTMLInputElement;
    const valFuel = document.getElementById('val-fuel')!;
    fuelSlider.addEventListener('input', () => {
      const f = parseInt(fuelSlider.value, 10);
      valFuel.textContent = f.toString();
      this.population.startingFuelKg = f;
      this.bridge.setFuel(f);
    });

    const pressureSlider = document.getElementById('slider-driver-pressure') as HTMLInputElement;
    const pressureLabel = document.getElementById('val-driver-pressure')!;
    const displayPressure = () => {
      pressureSlider.value = String(this.driverPressure);
      pressureLabel.textContent = `${this.driverPressure > 0 ? '+' : ''}${this.driverPressure} · ${this.driverPressure < 0 ? 'Spokojna' : this.driverPressure > 0 ? 'Atak' : 'Zrównoważona'}`;
    };
    displayPressure();
    pressureSlider.addEventListener('input', () => {
      this.driverPressure = normalizePressure(Number(pressureSlider.value));
      displayPressure();
      this.population.setDriverPressure(this.driverPressure);
      this.bridge.setDriverPressure(this.driverPressure);
      try { localStorage.setItem('f1_driver_pressure', String(this.driverPressure)); } catch {}
    });

    const mutSlider = document.getElementById('slider-mutation') as HTMLInputElement;
    const mutLabel = document.getElementById('val-mutation')!;
    mutSlider.addEventListener('input', () => {
      const val = parseInt(mutSlider.value, 10);
      mutLabel.textContent = `${val}%`;
      this.population.mutationRate = val / 100;
      this.bridge.setMutation(val / 100);
    });

    // Stress laps (domain randomisation): share of training laps in randomised conditions.
    const stressSlider = document.getElementById('slider-stress-laps') as HTMLInputElement | null;
    const stressLabel = document.getElementById('val-stress-laps');
    const applyStress = (percent: number, save: boolean) => {
      const share = clampStressShare(percent / 100);
      this.bridge.setStressLaps(share);
      if (stressLabel) stressLabel.textContent = `${Math.round(share * 100)}%`;
      if (save) try { localStorage.setItem('f1_stress_laps', String(Math.round(share * 100))); } catch {}
    };
    let savedStress = DEFAULT_STRESS_LAP_SHARE * 100;
    try { const v = localStorage.getItem('f1_stress_laps'); if (v !== null && Number.isFinite(Number(v))) savedStress = Number(v); } catch {}
    if (stressSlider) {
      stressSlider.value = String(savedStress);
      stressSlider.addEventListener('input', () => applyStress(parseInt(stressSlider.value, 10), false));
      stressSlider.addEventListener('change', () => applyStress(parseInt(stressSlider.value, 10), true));
    }
    applyStress(savedStress, false);

    // Sensor raycast checkbox
    const checkSensors = document.getElementById('check-sensors') as HTMLInputElement;
    checkSensors.addEventListener('change', () => {
      this.renderer.showSensors = checkSensors.checked;
    });

    // LiDAR ray count slider
    const lidarSlider = document.getElementById('slider-lidar-count') as HTMLInputElement;
    const valLidar = document.getElementById('val-lidar-count')!;
    // A new ray count retrains the seed networks: applied once on release, not on every drag step.
    lidarSlider.addEventListener('input', () => { valLidar.textContent = lidarSlider.value; });
    lidarSlider.addEventListener('change', () => {
      const count = parseInt(lidarSlider.value, 10);
      if (count === this.population.rayCount) return;
      valLidar.textContent = count.toString();
      this.population.setRayCount(count, this.track);
      this.bridge.setLidarCount(count);
      if (this.playerCar) {
        this.playerCar = new Car(
          this.track.startPosition,
          this.track.startAngle,
          null,
          '#FFD700',
          'Kierowca (Gracz)',
          this.population.startingFuelKg,
          count
        );
        this.playerCar.updateDimensionsForTrackWidth(this.trackWidth);
        this.playerCar.isManual = true;
      }
    });

    // Car speed badge checkbox
    const checkCarSpeed = document.getElementById('check-car-speed') as HTMLInputElement;
    if (checkCarSpeed) {
      checkCarSpeed.addEventListener('change', () => {
        this.renderer.showCarSpeed = checkCarSpeed.checked;
      });
    }

    // Racing line checkbox
    const checkRacingLine = document.getElementById('check-racing-line') as HTMLInputElement;
    checkRacingLine.addEventListener('change', () => {
      this.renderer.showRacingLine = checkRacingLine.checked;
    });

    // AI Topology select
    const selectTopology = document.getElementById('select-topology') as HTMLSelectElement | null;
    if (selectTopology) {
      selectTopology.addEventListener('change', () => {
        if (this.sync.session.raceState !== 'IDLE' && this.sync.session.raceState !== 'FINISHED') {
          return;
        }
        const topology = selectTopology.value as TopologySpecifier;
        const prevSelectedColor = this.selectedCar ? this.selectedCar.color : null;
        this.population.setTopology(topology, this.track);
        this.bridge.setTopology(topology);
        if (prevSelectedColor) {
          if (this.playerCar && this.playerCar.color === prevSelectedColor) {
            this.selectedCar = this.playerCar;
          } else {
            this.selectedCar = this.population.cars.find(c => c.color === prevSelectedColor) || null;
          }
          this.bridge.setActiveCarColor(this.selectedCar ? this.selectedCar.color : null);
        }
        if (this.playerCar) {
          this.playerCar.reset(this.track.startPosition, this.track.startAngle, true);
          this.playerCar.updateDimensionsForTrackWidth(this.trackWidth);
        }
      });
    }

    // Compute profile select
    const selectComputeProfile = document.getElementById('select-compute-profile') as HTMLSelectElement | null;
    if (selectComputeProfile) {
      selectComputeProfile.addEventListener('change', () => {
        const profile = selectComputeProfile.value as ComputeProfile;
        this.bridge.setComputeProfile(profile);
      });
    }

    // Training islands on spare cores
    const islandsSlider = document.getElementById('slider-islands') as HTMLInputElement | null;
    const valIslands = document.getElementById('val-islands');
    if (islandsSlider) {
      islandsSlider.max = String(Math.max(0, Math.min(15, this.bridge.cpuCores - 2)));
      islandsSlider.addEventListener('input', () => { if (valIslands) valIslands.textContent = islandsSlider.value; });
      islandsSlider.addEventListener('change', () => this.bridge.setIslands(parseInt(islandsSlider.value, 10)));
    }

    // Model export & import
    document.getElementById('btn-save-model')!.addEventListener('click', async () => {
      let modelsPayload: any = null;
      if (this.bridge && this.bridge.isReady) {
        try {
          modelsPayload = await this.bridge.getAllModels();
        } catch (e) {
          console.warn('Nie udało się pobrać modeli z Workera:', e);
        }
      }

      if (!modelsPayload) {
        // Fallback to main thread population if worker unavailable
        const driversData = this.population.cars.map((car, idx) => {
          const record = this.population.teamRecords[idx];
          return {
            driverName: car.driverName,
            teamName: record?.teamName || '',
            color: car.color,
            carName: record?.carName || '',
            brain: car.brain ? JSON.parse(car.brain.toJSON()) : null,
            bestBrain: record?.bestBrain ? JSON.parse(record.bestBrain.toJSON()) : null,
            bestLapTime: record?.bestLapTime || car.bestLapTime,
            bestLapPressure: record?.bestLapPressure ?? car.bestLapPressure,
            bestLapSplits: record?.bestLapSplits ? [...record.bestLapSplits] : (car.bestLapSplits ? [...car.bestLapSplits] : null),
            bestFitness: record?.bestFitness || car.fitness,
            baseBrakingAggression: car.baseBrakingAggression,
            brakingAggression: car.brakingAggression,
          };
        });

        modelsPayload = {
          type: 'F1_ALL_MODELS',
          version: 2,
          generation: this.population.generation,
          globalBestLap: this.population.globalBestLap,
          rayCount: this.population.rayCount,
          savedAt: new Date().toISOString(),
          drivers: driversData
        };
      }

      const json = JSON.stringify(modelsPayload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const gen = modelsPayload.generation || this.population.generation || 1;
      const dateStr = new Date().toISOString().slice(0, 10);
      a.download = `f1-wszyscy-kierowcy-gen${gen}-${dateStr}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    const inputModelFile = document.getElementById('input-model-file') as HTMLInputElement;
    document.getElementById('btn-load-model')!.addEventListener('click', () => {
      inputModelFile.click();
    });

    inputModelFile.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = async (event) => {
          const content = event.target?.result as string;
          await this.loadModelFromJSON(content);
          inputModelFile.value = '';
        };
        reader.readAsText(file);
      }
    });

    // Track export & import
    const btnSaveTrack = document.getElementById('btn-save-track');
    btnSaveTrack?.addEventListener('click', () => {
      if (!this.track || this.track.points.length < 8) {
        alert('Brak aktywnego toru do zapisania.');
        return;
      }

      const defaultName = `Tor-F1-${this.trackWidth}m-${new Date().toISOString().slice(0, 10)}`;
      const inputName = prompt('Podaj nazwę dla zapisywanego toru:', defaultName);
      if (inputName === null) return;
      const trackName = inputName.trim() || defaultName;

      const ptsToSave = (this.rawDrawnPoints && this.rawDrawnPoints.length >= 4)
        ? this.rawDrawnPoints
        : this.track.points.map(p => p.center);

      const trackData = {
        type: 'F1_AI_TRACK',
        version: 1,
        name: trackName,
        trackWidth: this.trackWidth,
        ...(this.trackDirection ? { direction: this.trackDirection } : {}),
        rawPoints: ptsToSave.map(p => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })),
        centerPoints: this.track.points.map(p => ({ x: Math.round(p.center.x * 10) / 10, y: Math.round(p.center.y * 10) / 10 })),
        lengthMeters: Math.round(this.track.totalLength / 2),
        savedAt: new Date().toISOString()
      };

      const json = JSON.stringify(trackData, null, 2);
      try {
        localStorage.setItem('f1_last_custom_track', json);
      } catch (e) {
        // Ignore localStorage error
      }

      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const sanitizedName = trackName.toLowerCase().replace(/[^a-z0-9_-]/gi, '_');
      a.download = `${sanitizedName}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    const inputTrackFile = document.getElementById('input-track-file') as HTMLInputElement;
    document.getElementById('btn-load-track')?.addEventListener('click', () => {
      inputTrackFile.click();
    });

    inputTrackFile?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            const content = event.target?.result as string;
            this.loadTrackFromJSON(content, file.name);
          } catch (err) {
            alert('Wystąpił błąd podczas wczytywania pliku toru.');
          } finally {
            inputTrackFile.value = '';
          }
        };
        reader.readAsText(file);
      }
    });

    // Drag & Drop JSON files onto canvas
    const canvasWrapper = document.getElementById('canvas-wrapper');
    if (canvasWrapper) {
      canvasWrapper.addEventListener('dragover', (e) => {
        e.preventDefault();
      });
      canvasWrapper.addEventListener('drop', (e) => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (file && file.name.endsWith('.json')) {
          const reader = new FileReader();
          reader.onload = async (ev) => {
            const content = ev.target?.result as string;
            try {
              const data = JSON.parse(content);
              if (data.type === 'F1_AI_TRACK' || data.rawPoints || data.centerPoints || (Array.isArray(data) && data[0]?.x !== undefined)) {
                this.loadTrackFromJSON(content, file.name);
              } else if (data.type === 'F1_ALL_MODELS' || data.drivers || data.layers || data.weights) {
                await this.loadModelFromJSON(content);
              } else {
                alert('Nie rozpoznano zawartości upuszczonego pliku JSON.');
              }
            } catch (err) {
              alert('Nie rozpoznano zawartości upuszczonego pliku JSON.');
            }
          };
          reader.readAsText(file);
        }
      });
    }

    // Grand Prix Race Mode Button Listeners
    document.querySelectorAll('.race-lap-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.race-lap-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedRaceLaps = parseInt(btn.getAttribute('data-laps') || '50', 10);
      });
    });

    const checkQualifying = document.getElementById('check-qualifying') as HTMLInputElement | null;
    if (checkQualifying) {
      checkQualifying.checked = this.withQualifying;
      checkQualifying.addEventListener('change', () => {
        this.withQualifying = checkQualifying.checked;
        try { localStorage.setItem('f1_with_qualifying', this.withQualifying ? '1' : '0'); } catch {}
      });
    }

    // Weather and tyres: restored from the last session and sent to the worker at once.
    const selectWeather = document.getElementById('select-weather') as HTMLSelectElement | null;
    const selectCompound = document.getElementById('select-player-compound') as HTMLSelectElement | null;
    if (selectWeather) {
      const saved = loadSetting('f1_weather');
      if (isWeatherScenario(saved)) selectWeather.value = saved;
      const apply = () => {
        this.bridge.setWeather(selectWeather.value);
        try { localStorage.setItem('f1_weather', selectWeather.value); } catch {}
      };
      selectWeather.addEventListener('change', apply);
      apply();
    }
    if (selectCompound) {
      const saved = loadSetting('f1_player_compound');
      if (isCompound(saved)) selectCompound.value = saved;
      const apply = () => {
        this.bridge.setTyres({ compound: selectCompound.value });
        try { localStorage.setItem('f1_player_compound', selectCompound.value); } catch {}
      };
      selectCompound.addEventListener('change', apply);
      apply();
    }

    document.getElementById('btn-start-race')?.addEventListener('click', () => {
      this.startRace(this.selectedRaceLaps, { withQualifying: this.withQualifying });
    });

    document.getElementById('btn-stop-race')?.addEventListener('click', () => {
      this.stopRace();
    });

    document.getElementById('btn-pit-player')?.addEventListener('click', () => {
      this.togglePlayerPit();
    });

    document.getElementById('btn-restart-race-podium')?.addEventListener('click', () => {
      document.getElementById('podium-modal')?.classList.add('hidden');
      this.startRace(this.selectedRaceLaps, { withQualifying: this.withQualifying });
    });
  }

  public startRace(totalLaps: number = 50, options: { withQualifying?: boolean; useQualifyingGrid?: boolean } = {}): void {
    this.raceUI.sessionStarted();
    this.selectedRaceLaps = totalLaps;
    this.bridge.startRace(totalLaps, options);
    // Show the right banner at once instead of waiting for the next snapshot.
    this.sync.session.raceState = options.withQualifying ? 'QUALIFYING' : 'GRID_START';
    this.isPaused = false;
    const selectTopology = document.getElementById('select-topology') as HTMLSelectElement | null;
    if (selectTopology) {
      selectTopology.disabled = true;
    }
    document.getElementById('btn-start-race')?.classList.add('hidden');
    document.getElementById('btn-stop-race')?.classList.remove('hidden');
    document.getElementById('race-info-banner')?.classList.remove('hidden');
    document.getElementById('start-banner')?.classList.add('hidden');
    const playBtn = document.getElementById('btn-play');
    if (playBtn) {
      setControlContent(playBtn, 'pause', 'Pauza');
      playBtn.classList.remove('primary');
      playBtn.classList.add('active');
    }
  }

  public stopRace(): void {
    this.raceUI.sessionStopped();
    this.bridge.stopRace();
    const selectTopology = document.getElementById('select-topology') as HTMLSelectElement | null;
    if (selectTopology) {
      selectTopology.disabled = false;
    }
    document.getElementById('btn-start-race')?.classList.remove('hidden');
    document.getElementById('btn-stop-race')?.classList.add('hidden');
    document.getElementById('race-info-banner')?.classList.add('hidden');
    document.getElementById('quali-info-banner')?.classList.add('hidden');

    this.population.isRaceMode = false;
    this.sync.session.raceState = 'IDLE';
    this.resetCarPositions();
    this.sync.session.standings = [];
  }

  public resetCarPositions(): void {
    for (let i = 0; i < this.population.cars.length; i++) {
      const car = this.population.cars[i];
      const record = this.population.teamRecords[i];
      car.isRaceMode = false;
      // CRITICAL: Preserve learned neural network! Restore the bestBrain without destroying it!
      if (record && record.bestBrain && !car.isManual) {
        car.brain = record.bestBrain.clone();
        car.safeBrainBackup = record.bestBrain.clone();
      }
      const slot = this.track.getGridSlot(i);
      const nextCpIdx = (slot.checkpointIdx + 1) % this.track.checkpoints.length;
      car.reset(slot.pos, slot.heading, true, nextCpIdx);
      car.updateDimensionsForTrackWidth(this.track.width);
      car.fuelKg = this.population.startingFuelKg;
      car.isAlive = true;
      car.pitStopsCount = 0;
      car.trackLimitExits = 0;
      car.raceLapsCompleted = 0;
      car.totalRaceTime = 0;
      car.isPitting = false;
      car.wantsToPit = false;
    }
    if (this.playerCar) {
      this.playerCar.isRaceMode = false;
      const slot = this.track.getGridSlot(this.population.cars.length);
      const nextCpIdx = (slot.checkpointIdx + 1) % this.track.checkpoints.length;
      this.playerCar.reset(slot.pos, slot.heading, true, nextCpIdx);
      this.playerCar.updateDimensionsForTrackWidth(this.track.width);
      this.playerCar.fuelKg = this.population.startingFuelKg;
      this.playerCar.isAlive = true;
    }
  }

  public togglePlayerPit(): void {
    this.bridge.togglePlayerPit();
    if (this.playerCar) {
      this.playerCar.wantsToPit = !this.playerCar.wantsToPit;
    }
    const currentDriven = this.population.cars.find(c => c.isManual) || this.selectedCar;
    if (currentDriven) {
      currentDriven.wantsToPit = !currentDriven.wantsToPit;
    }
  }

  /** Clean slate: forget everything the drivers learned, here, in the worker and in the autosave. */
  public async clearLearning(): Promise<void> {
    if (!confirm('Czysta tablica: wszyscy kierowcy zapomną wszystko, czego się nauczyli (sieci, linie przejazdu, tempo, rekordy, generacje), a autozapis zostanie usunięty. Trwająca sesja zostanie przerwana. Tor i ustawienia zostają.\n\nTej operacji nie można cofnąć. Kontynuować?')) return;
    this.learningEpoch++;
    const forgetAutosave = () => { try { localStorage.removeItem(App.AUTOSAVE_KEY); } catch {} this.autosaveMarker = ''; };
    forgetAutosave();
    const previous = this.population, selectedColor = this.selectedCar?.color;
    this.population = new Population(Population.MAX_CARS, this.track, previous.rayCount, previous.topology);
    this.population.setDriverPressure(this.driverPressure, true);
    this.population.mutationRate = previous.mutationRate;
    this.population.startingFuelKg = previous.startingFuelKg;
    this.selectedCar = selectedColor ? this.population.cars.find(c => c.color === selectedColor) || null : null;
    try { await this.bridge.clearLearning(); }
    catch (e) { console.warn('Czyszczenie nauki w Workerze nie powiodło się:', e); }
    // An autosave started before the reset may have finished meanwhile.
    forgetAutosave();
    this.clearTimingDisplay();
    const btn = document.getElementById('btn-clear-learning');
    if (btn) {
      btn.classList.add('highlight');
      setTimeout(() => btn.classList.remove('highlight'), 500);
    }
  }

  public resetBestTimes(): void {
    this.bridge.resetBestTimes();
    this.population.resetBestTimes();
    this.clearTimingDisplay();
    const btn = document.getElementById('btn-reset-best-times');
    if (btn) {
      btn.classList.add('highlight');
      setTimeout(() => btn.classList.remove('highlight'), 500);
    }
  }

  /** Blank lap times, splits and standings in the UI until the next snapshot fills them. */
  private clearTimingDisplay(): void {
    if (this.playerCar) {
      this.playerCar.bestLapTime = null;
      this.playerCar.lastLapTime = null;
      this.playerCar.bestLapSplits = [null, null, null, null];
      this.playerCar.currentLapSplits = [null, null, null, null];
      this.playerCar.lastCheckpointDelta = null;
    }
    if (this.sync.session.teamStandings) {
      for (const s of this.sync.session.teamStandings) {
        s.lapTime = 0;
        s.lastLapTime = null;
        s.hasFinishedLap = false;
      }
    }
    for (const rs of this.sync.session.standings) {
      rs.bestLap = null;
      rs.lastLap = null;
    }
    const bestLapEl = document.getElementById('stat-best-lap');
    if (bestLapEl) bestLapEl.textContent = '--:--.---';

    for (let g = 0; g < 4; g++) {
      const timeEl = document.getElementById(`tele-sec-${g}-time`);
      const deltaEl = document.getElementById(`tele-sec-${g}-delta`);
      const boxEl = document.getElementById(`tele-sec-${g}`);
      if (timeEl) timeEl.textContent = '--:--.---';
      if (deltaEl) {
        deltaEl.textContent = '--';
        deltaEl.className = 'sec-delta';
      }
      if (boxEl) boxEl.style.borderColor = '#232932';
    }

    this.updateHUD();
  }

  public async loadModelFromJSON(content: string, silent = false): Promise<boolean> {
    try {
      const data = JSON.parse(content);
      if (data.type === 'F1_ALL_MODELS' || (Array.isArray(data.drivers) && data.drivers.length > 0)) {
        if (this.bridge && this.bridge.isReady) {
          const loaded = await this.bridge.loadAllModels(data);
          if (!loaded) {
            if (!silent) alert('Nie udało się załadować modeli AI do workera.');
            return false;
          }
        }

        for (let i = 0; i < this.population.cars.length; i++) {
          const car = this.population.cars[i];
          const record = this.population.teamRecords[i];
          const driverData = data.drivers.find((d: any) => d.color === car.color) || data.drivers[i];
          if (driverData) {
            if (driverData.brain && car.brain && driverData.brain.layerSizes?.[0] === car.brain.layerSizes[0]) {
              car.brain.fromJSON(JSON.stringify(driverData.brain));
            }
            if (driverData.bestBrain && record?.bestBrain && driverData.bestBrain.layerSizes?.[0] === record.bestBrain.layerSizes[0]) {
              record.bestBrain.fromJSON(JSON.stringify(driverData.bestBrain));
            }
            if (typeof driverData.baseBrakingAggression === 'number') {
              car.baseBrakingAggression = driverData.baseBrakingAggression;
              car.brakingAggression = driverData.brakingAggression || driverData.baseBrakingAggression;
            }
            if (typeof driverData.bestLapTime === 'number') {
              car.bestLapTime = driverData.bestLapTime;
              car.bestLapPressure = normalizePressure(driverData.bestLapPressure ?? 0);
              car.safeBrainPressure = car.bestLapPressure;
              if (record) record.bestLapPressure = car.bestLapPressure;
              if (record) record.bestLapTime = driverData.bestLapTime;
            }
            if (Array.isArray(driverData.bestLapSplits) && driverData.bestLapSplits.length === 4) {
              car.bestLapSplits = [...driverData.bestLapSplits];
              if (record) record.bestLapSplits = [...driverData.bestLapSplits];
            } else {
              car.bestLapSplits = [null, null, null, null];
              if (record) record.bestLapSplits = [null, null, null, null];
            }
          }
        }
        if (data.generation) this.population.generation = data.generation;
        if (Object.prototype.hasOwnProperty.call(data, 'globalBestLap')) {
          this.population.globalBestLap = typeof data.globalBestLap === 'number' ? data.globalBestLap : null;
        }
        this.resetCarPositions();
        this.bridge.resetCarPositions();
        if (!silent) alert(`Załadowano modele AI wszystkich kierowców (Gen ${data.generation || 1})!`);
        return true;
      } else if (data.layers || data.weights) {
        if (this.bridge && this.bridge.isReady) {
          const loaded = await this.bridge.loadBrain(content);
          if (!loaded) {
            alert('Nie udało się załadować modelu AI do workera.');
            return false;
          }
        }
        for (let i = 0; i < 5; i++) {
          if (this.population.cars[i]?.brain) {
            this.population.cars[i].brain!.fromJSON(content);
          }
        }
        this.resetCarPositions();
        this.bridge.resetCarPositions();
        alert('Pojedynczy model AI został załadowany!');
        return true;
      } else {
        alert('Niepoprawny format pliku modelu AI.');
        return false;
      }
    } catch (err) {
      console.error('Błąd podczas parsowania modelu JSON:', err);
      alert('Błąd podczas ładowania pliku modelu JSON.');
      return false;
    }
  }

  private setupRealTrackSelect(): void {
    const select = document.getElementById('select-real-track') as HTMLSelectElement | null;
    if (!select) return;
    const km = (m: number) => (m / 1000).toLocaleString('pl-PL', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
    for (const t of realTrackIndex.tracks) {
      if (!REAL_TRACK_FILES[`../tracks/${t.file}`]) continue;
      const option = document.createElement('option');
      option.value = t.file;
      option.textContent = `${t.name} — ${t.country} (${km(t.generatedLengthMeters)} km)`;
      option.title = `${t.location}, ${t.circuitType}, ${t.direction === 'clockwise' ? 'prawoskrętny' : 'lewoskrętny'}, GP: ${t.grandsPrix}`;
      select.appendChild(option);
    }
    select.addEventListener('change', async () => {
      const load = REAL_TRACK_FILES[`../tracks/${select.value}`];
      if (!load) return;
      select.disabled = true;
      try {
        if (!this.loadTrackFromJSON(await load(), select.value, true)) select.value = '';
      } catch (error) {
        alert(error instanceof Error ? error.message : 'Nie udało się wczytać toru.');
        select.value = '';
      } finally {
        select.disabled = false;
      }
    });
    // Any other way of setting the track clears the circuit choice.
    for (const id of ['preset-gp', 'preset-oval', 'btn-draw']) {
      document.getElementById(id)?.addEventListener('click', () => { select.value = ''; });
    }
  }

  /** `quiet` skips the success alert (picking a circuit from the list already shows the result). */
  public loadTrackFromJSON(content: string, sourceName?: string, quiet = false): boolean {
    try {
      const data = JSON.parse(content);

      let rawList: any[] = [];
      if (Array.isArray(data)) {
        rawList = data;
      } else if (Array.isArray(data.rawPoints) && data.rawPoints.length >= 4) {
        rawList = data.rawPoints;
      } else if (Array.isArray(data.points) && data.points.length >= 4) {
        rawList = data.points;
      } else if (Array.isArray(data.centerPoints) && data.centerPoints.length >= 4) {
        rawList = data.centerPoints;
      }

      if (!rawList || rawList.length < 4) {
        alert('Błąd: Plik nie zawiera wystarczającej liczby punktów toru (minimum 4).');
        return false;
      }

      const parsedPoints: Vector2[] = [];
      for (const pt of rawList) {
        if (pt && typeof pt.x === 'number' && typeof pt.y === 'number') {
          parsedPoints.push(new Vector2(pt.x, pt.y));
        } else if (Array.isArray(pt) && pt.length >= 2 && typeof pt[0] === 'number' && typeof pt[1] === 'number') {
          parsedPoints.push(new Vector2(pt[0], pt[1]));
        }
      }

      if (parsedPoints.length < 4) {
        alert('Błąd: Nie znaleziono poprawnych współrzędnych punktów toru.');
        return false;
      }

      const nextWidth = typeof data.trackWidth === 'number' && Number.isFinite(data.trackWidth)
        ? Math.max(5, Math.min(20, Math.round(data.trackWidth))) : this.trackWidth;
      const dims = Car.getDimensionsForTrackWidth(nextWidth);
      // Real circuits carry their driving direction: keep the file's point order.
      const direction = data.direction === 'clockwise' || data.direction === 'counterclockwise' ? data.direction : null;
      const splinePoints = Spline.generateClosedTrack(parsedPoints, dims.effectiveTrackWidth, 18, !!direction);

      if (splinePoints.length < 8) {
        alert('Błąd: Nie udało się wygenerować zamkniętej pętli toru z podanych punktów.');
        return false;
      }

      const nextTrack = new Track(splinePoints, dims.effectiveTrackWidth);
      this.track = nextTrack;
      this.renderer.setCircuit(sourceName);
      this.trackWidth = nextWidth;
      (document.getElementById('slider-track-width') as HTMLInputElement).value = String(nextWidth);
      document.getElementById('val-track-width')!.textContent = String(nextWidth);
      this.rawDrawnPoints = parsedPoints;
      this.trackDirection = direction;
      this.population = new Population(Population.MAX_CARS, this.track, this.population.rayCount, this.population.topology);
      this.population.setDriverPressure(this.driverPressure, true);
      this.selectedCar = null;
      const pitLaneLoss = typeof data.pitLaneLoss === 'number' && data.pitLaneLoss > 0 ? data.pitLaneLoss : undefined;
      this.track.pitLaneLoss = pitLaneLoss ?? null;
      this.bridge.setCustomTrack(parsedPoints.map(p => ({ x: p.x, y: p.y })), this.trackWidth, !!direction, pitLaneLoss);

      if (this.playerCar) {
        this.playerCar.reset(this.track.startPosition, this.track.startAngle, true);
        this.playerCar.updateDimensionsForTrackWidth(this.trackWidth);
      }

      try {
        localStorage.setItem('f1_last_custom_track', content);
      } catch (e) {
        // Ignore localStorage error
      }

      const trackName = data.name || sourceName || 'Własny Tor';
      if (!quiet) alert(`Tor "${trackName}" został pomyślnie załadowany!`);
      return true;
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Błąd: Niepoprawny plik toru.');
      return false;
    }
  }

  private getCanvasMousePos(e: MouseEvent): Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    // Above the horizon (low cameras) there is no ground point; fall back to the screen position.
    return this.renderer.screenToWorld(sx, sy) ?? new Vector2(sx, sy);
  }

  private finishDrawnTrack(): void {
    if (this.rawDrawnPoints.length < 5) return;

    const dims = Car.getDimensionsForTrackWidth(this.trackWidth);
    const splinePoints = Spline.generateClosedTrack(this.rawDrawnPoints, dims.effectiveTrackWidth, 18);
    if (splinePoints.length >= 8) {
      try { this.track = new Track(splinePoints, dims.effectiveTrackWidth); this.renderer.setCircuit(); }
      catch (error) {
        this.rawDrawnPoints = this.drawSourceBackup.map(p => p.clone());
        this.drawnTrackRejected = true;
        alert(error instanceof Error ? error.message : 'Niepoprawna geometria toru.');
        return;
      }
      this.trackDirection = null;
      this.population = new Population(Population.MAX_CARS, this.track, this.population.rayCount, this.population.topology);
      this.population.setDriverPressure(this.driverPressure, true);
      this.selectedCar = null;
      this.bridge.setActiveCarColor(null);
      this.bridge.setCustomTrack(this.rawDrawnPoints.map(p => ({ x: p.x, y: p.y })), this.trackWidth);
      if (this.playerCar) {
        this.playerCar.reset(this.track.startPosition, this.track.startAngle, true);
        this.playerCar.updateDimensionsForTrackWidth(this.trackWidth);
      }

      this.isDrawMode = false;
      const btnDraw = document.getElementById('btn-draw')!;
      btnDraw.classList.remove('active');
      setControlContent(btnDraw, 'pencil', 'Rysuj tor');
      document.getElementById('draw-banner')!.classList.add('hidden');
    }
  }

  private loop(): void {
    const wrapper = document.getElementById('canvas-wrapper')!;
    const rect = wrapper.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    // The simulation runs only in the worker; the page sends the player's input to it.
    if (this.isPlayerDriving && this.bridge.isReady) this.bridge.sendPlayerInput(this.input.playerControl());

    // Render frame
    if (this.bridge.isReady) this.motion.apply();
    if (width !== this.viewSize.width || height !== this.viewSize.height) {
      this.viewSize = { width, height };
      this.renderer.resize(width, height);
    }
    const cameras = this.renderer.cameras;
    if (this.followSelected && !this.selectedCar) this.followSelected = false;
    if (this.followSelected && this.selectedCar && cameras.mode === 'top' && !this.isDrawMode) {
      cameras.target.set(this.selectedCar.pos.x, this.selectedCar.pos.y);
    }
    document.querySelector('.camera-controls')!.classList.toggle('hidden', this.isDrawMode);
    const followButton = document.getElementById('btn-camera-follow')!;
    followButton.classList.toggle('active', this.followSelected);
    followButton.setAttribute('aria-pressed', String(this.followSelected));
    document.querySelectorAll<HTMLElement>('[data-camera-mode]').forEach(button => {
      const active = button.dataset.cameraMode === cameras.mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    document.getElementById('camera-zoom-value')!.textContent = cameras.mode === 'top' ? `${Math.round(cameras.zoom * 100)}%`
      : cameras.mode === 'chase' ? `${Math.round(cameras.chaseDistance)} m` : 'TV';
    const focusName = this.selectedCar?.driverName ?? this.population.currentLeader?.driverName ?? '';
    document.getElementById('camera-status')!.textContent = cameras.mode === 'chase' ? `Kamera pościgowa: ${focusName} • Kółko: odległość`
      : cameras.mode === 'tv' ? `Kamery TV: ${focusName}`
      : this.followSelected && this.selectedCar ? `Śledzenie: ${this.selectedCar.driverName}` : 'Kółko: zoom • Przeciągnij: przesuń • Kliknij zawodnika w tabeli';

    this.renderer.render({
      track: this.track,
      cars: this.population.cars,
      player: this.playerCar,
      leader: this.population.currentLeader,
      selected: this.selectedCar,
      racingLine: this.population.bestRacingLine,
      plannedLine: this.isDrawMode ? null : getRacingLine(this.track),
      drawMode: this.isDrawMode,
      frozen: this.isPaused || this.sync.session.raceState === 'FINISHED' || this.sync.session.raceState === 'QUALI_FINISHED',
      drawing: this.isDrawMode ? { points: this.rawDrawnPoints, mouse: this.mousePos, anchor: this.straightAnchor } : null,
      raceState: this.sync.session.raceState,
      startLights: this.sync.session.startLights,
      winner: this.sync.session.winner,
      weather: this.sync.session.weather,
    });

    // Update Telemetry & UI
    this.updateHUD();

    requestAnimationFrame(this.loop.bind(this));
  }

  private updateHUD(): void {
    const leader = (this.isPlayerDriving && this.playerCar?.isAlive ? this.playerCar : this.population.currentLeader) || this.population.cars[0];
    const activeCar = this.selectedCar || leader;
    const surfaces = { asphalt: 'ASFALT', grass: 'TRAWA', gravel: 'ŻWIR' };
    const reasons = { car: 'WYPADEK Z INNYM BOLIDEM', barrier: 'UDERZENIE W BANDĘ', fuel: 'BRAK PALIWA', stuck: 'BRAK POSTĘPU', 'wrong-way': 'JAZDA POD PRĄD' };
    document.getElementById('tele-surface')!.textContent = activeCar ? surfaces[activeCar.surface] : '—';
    const effectivePressure = activeCar?.effectiveDriverPressure ?? this.driverPressure;
    const targetPressure = activeCar?.driverPressure ?? this.driverPressure;
    const pressureText = (p: number) => `${p > 0 ? '+' : ''}${Math.round(p)}`;
    const rpmEl = document.getElementById('tele-rpm');
    if (rpmEl) rpmEl.textContent = activeCar ? `${Math.round(activeCar.engineRpm / 10) * 10} rpm · prześwit ${Math.round(activeCar.rideHeightFront * 1000)}/${Math.round(activeCar.rideHeightRear * 1000)} mm${activeCar.aeroStall ? ' ⚠ ZERWANIE PRZEPŁYWU' : ''}${activeCar.plankForce > 0 ? ' ⚠ DOBIJANIE DESKI' : ''}${activeCar.porpoisingHz > 0 ? ` ⚠ MORŚWINOWANIE ${activeCar.porpoisingHz.toFixed(1)} Hz` : ''}${activeCar.wakeDrag < 0.97 ? ` · cień aero opór −${Math.round((1 - activeCar.wakeDrag) * 100)}% docisk −${Math.round((1 - activeCar.wakeDownforce) * 100)}%` : ''}` : 'rpm'
    const tyreEl = document.getElementById('tele-tyres');
    if (tyreEl) tyreEl.textContent = activeCar ? `OPONY ${COMPOUND_SPECS[activeCar.tyreCompound].label.toUpperCase()} · P ${Math.round(activeCar.tyreTempFront)}° T ${Math.round(activeCar.tyreTempRear)}° · zużycie ${Math.round(Math.max(activeCar.tyreWearFront, activeCar.tyreWearRear) * 100)}% · hamulce P ${Math.round(activeCar.brakeTempFront)}° T ${Math.round(activeCar.brakeTempRear)}°${activeCar.wheelLockFront || activeCar.wheelLockRear ? ' ⚠ BLOKADA KÓŁ' : ''}${activeCar.aquaplaning > 0.02 ? ' ⚠ AQUAPLANING' : ''}` : 'OPONY';
    const weatherEl = document.getElementById('tele-weather');
    if (weatherEl) weatherEl.textContent = weatherLine(this.sync.session.weather);
    const ersEl = document.getElementById('tele-ers');
    if (ersEl) ersEl.textContent = activeCar ? `ERS ${Math.round(activeCar.ersEnergy / Car.ERS_CAPACITY * 100)}%` : 'ERS';
    document.getElementById('tele-pressure')!.textContent = activeCar?.isManual ? 'RĘCZNIE'
      : `PRESJA ${pressureText(effectivePressure)}${Math.abs(targetPressure-effectivePressure) > .1 ? ` → ${pressureText(targetPressure)}` : ''}`;
    document.getElementById('tele-incident')!.textContent = activeCar?.wreckRemoved && (this.sync.session.raceState === 'QUALIFYING' || this.sync.session.raceState === 'QUALI_FINISHED')
      ? 'W GARAŻU (KWALIFIKACJE)'
      : activeCar?.eliminationReason
      ? activeCar.wreckRemoved ? 'DNF — BOLID USUNIĘTY' : reasons[activeCar.eliminationReason] : activeCar?.yellowFlag ? 'ŻÓŁTA FLAGA — ZAKAZ WYPRZEDZANIA' : activeCar?.incidentActive ? 'POMYŁKA KIEROWCY' : activeCar && activeCar.recoveryTimer > 0 ? 'ODZYSKIWANIE KONTROLI' : activeCar?.overtakingTargetName ? `WYPRZEDZANIE: ${activeCar.overtakingTargetName}` : activeCar?.battleOpponent ? `ATAK: ${activeCar.battleOpponent}` : activeCar?.racingLineLabel || (activeCar && activeCar.damage > 0.05 ? `USZKODZENIA ${Math.round(Math.min(1, activeCar.damage) * 100)}%` : 'JAZDA');

    // Update telemetry header and brain tag
    const teleHeader = document.getElementById('telemetry-header-title');
    if (teleHeader) {
      if (this.isPlayerDriving && activeCar?.isManual) {
        teleHeader.textContent = `TELEMETRIA: ${activeCar.driverName.toUpperCase()} (GRACZ - MANUAL)`;
      } else if (this.selectedCar) {
        teleHeader.textContent = `TELEMETRIA: ${activeCar.driverName.toUpperCase()} (WYBRANY)`;
      } else if (this.isPlayerDriving && activeCar === this.playerCar) {
        teleHeader.textContent = 'TELEMETRIA: GRACZ (MANUAL)';
      } else {
        teleHeader.textContent = 'TELEMETRIA BOLIDU (LIDER)';
      }
    }

    const brainTag = document.getElementById('brain-target-tag');
    if (brainTag) {
      if (this.isPlayerDriving && activeCar?.isManual) {
        brainTag.textContent = 'GRACZ (MANUAL)';
      } else if (this.selectedCar) {
        const surnameMatch = activeCar.driverName.match(/^([^\s]+)\s+([^\s(]+)/);
        const shortName = surnameMatch ? surnameMatch[2] : activeCar.driverName.split(' ')[0];
        brainTag.textContent = `WYBRANY: ${shortName.toUpperCase()}`;
      } else {
        brainTag.textContent = 'LIDER';
      }
    }

    // Update selection banner
    const selectionBanner = document.getElementById('selection-banner');
    const selectedDriverName = document.getElementById('selected-driver-name');
    const btnTakeover = document.getElementById('btn-takeover-driver');
    if (this.selectedCar) {
      selectionBanner?.classList.remove('hidden');
      if (selectedDriverName) {
        selectedDriverName.textContent = this.isPlayerDriving && this.selectedCar.isManual
          ? `${this.selectedCar.driverName} (STEROWANY WASD)`
          : this.selectedCar.driverName;
      }
      if (btnTakeover) {
        if (this.isPlayerDriving && this.selectedCar.isManual) {
          setControlContent(btnTakeover, 'chip', 'Oddaj AI');
          btnTakeover.classList.add('active');
        } else {
          setControlContent(btnTakeover, 'wheel', 'Prowadź bolid (WASD)');
          btnTakeover.classList.remove('active');
        }
      }
    } else {
      selectionBanner?.classList.add('hidden');
    }

    const btnDrive = document.getElementById('btn-drive');
    if (btnDrive) {
      if (this.isPlayerDriving) {
        const currentDriven = this.population.cars.find(c => c.isManual) || this.selectedCar;
        const driverTitle = currentDriven ? currentDriven.driverName.split(' ')[0] : 'WŁ.';
        setControlContent(btnDrive, 'wheel', `Gracz: ${driverTitle} (WASD)`);
        btnDrive.classList.add('active');
      } else {
        setControlContent(btnDrive, 'wheel', 'Gracz (WASD)');
        btnDrive.classList.remove('active');
      }
    }

    // Stats bar
    document.getElementById('stat-gen')!.textContent = this.population.generation.toString();
    document.getElementById('stat-alive')!.textContent = `${this.population.aliveCount} / ${this.population.populationSize}`;
    document.getElementById('stat-fitness')!.textContent = Math.round(this.population.bestFitness).toLocaleString();

    document.getElementById('stat-best-lap')!.textContent = this.population.globalBestLap ? formatLapTime(this.population.globalBestLap) : '--:--.---';

    this.raceUI.update();

    // Telemetry panel
    if (activeCar) {
      const speedKmh = Math.round(activeCar.speedKmh);
      document.getElementById('tele-speed')!.textContent = speedKmh.toString();

      const gear = speedKmh < 10 ? 'N' : String(activeCar.gear);
      document.getElementById('tele-gear')!.textContent = gear;

      // Fuel & Mass telemetry
      document.getElementById('tele-fuel')!.textContent = `${activeCar.fuelKg.toFixed(1)} kg`;
      const fuelPct = Math.min(100, Math.max(0, (activeCar.fuelKg / Car.MAX_FUEL_CAPACITY) * 100));
      document.getElementById('gauge-fuel')!.style.width = `${Math.round(fuelPct)}%`;
      document.getElementById('tele-mass')!.textContent = `${Math.round(activeCar.totalMass)} kg`;

      let demandCtrl: CarControl;
      if (activeCar.isManual || activeCar === this.playerCar) {
        demandCtrl = this.input.playerControl();
      } else {
        demandCtrl = activeCar.currentControl;
      }

      const validDemandThrottle = typeof demandCtrl.throttle === 'number' && Number.isFinite(demandCtrl.throttle)
        ? Math.max(0, Math.min(1, demandCtrl.throttle))
        : 0;
      const validDemandBrake = typeof demandCtrl.brake === 'number' && Number.isFinite(demandCtrl.brake)
        ? Math.max(0, Math.min(1, demandCtrl.brake))
        : 0;

      const demandThrottlePct = Math.round(validDemandThrottle * 100);
      const brakePct = Math.round(validDemandBrake * 100);

      // Effective throttle: reflects drive-by-wire brake cut, fuel depletion, and limp mode; zeroed when inactive or in pit
      let effectiveThrottleVal: number;
      if (!activeCar.isAlive || activeCar.isPitting) {
        effectiveThrottleVal = 0;
      } else if (typeof activeCar.effectiveThrottle === 'number' && Number.isFinite(activeCar.effectiveThrottle)) {
        effectiveThrottleVal = activeCar.effectiveThrottle;
      } else if (activeCar.isManual || activeCar === this.playerCar) {
        const brakeOverrideCut = Math.max(0, 1.0 - validDemandBrake * 1.4);
        effectiveThrottleVal = validDemandThrottle * brakeOverrideCut;
      } else {
        effectiveThrottleVal = validDemandThrottle;
      }
      effectiveThrottleVal = Math.max(0, Math.min(1, effectiveThrottleVal));
      const effectiveThrottlePct = Math.round(effectiveThrottleVal * 100);

      document.getElementById('gauge-throttle')!.style.width = `${effectiveThrottlePct}%`;
      document.getElementById('gauge-brake')!.style.width = `${brakePct}%`;

      const teleThrottlePct = document.getElementById('tele-throttle-pct');
      if (teleThrottlePct) {
        teleThrottlePct.textContent = `${effectiveThrottlePct}%`;
      }

      const teleThrottleDemand = document.getElementById('tele-throttle-demand');
      if (teleThrottleDemand) {
        if (Math.abs(demandThrottlePct - effectiveThrottlePct) >= 1) {
          teleThrottleDemand.textContent = `(Żądanie: ${demandThrottlePct}%)`;
          teleThrottleDemand.style.display = 'inline';
        } else {
          teleThrottleDemand.textContent = '';
          teleThrottleDemand.style.display = 'none';
        }
      }

      const teleBrakePct = document.getElementById('tele-brake-pct');
      if (teleBrakePct) {
        teleBrakePct.textContent = `${brakePct}%`;
      }
      const teleBrakeAgg = document.getElementById('tele-brake-agg');
      if (teleBrakeAgg) {
        teleBrakeAgg.textContent = `(Styl: ${Math.round(activeCar.brakingAggression * 100)}%)`;
      }
      this.hudCharts.renderGMeter(activeCar, this.gMeterCanvas);
      const totalG = Math.hypot(activeCar.lateralG, activeCar.longitudinalG);
      const teleGTotal = document.getElementById('tele-g-total')!;
      teleGTotal.textContent = `${totalG.toFixed(1)} G`;
      teleGTotal.title = `Boczne: ${activeCar.lateralG.toFixed(1)} G | Wzdłużne: ${activeCar.longitudinalG.toFixed(1)} G`;
      const frontPct = Math.round(activeCar.weightFrontRatio * 100);
      const rearPct = 100 - frontPct;
      document.getElementById('gauge-weight')!.style.width = `${frontPct}%`;
      document.getElementById('tele-weight-ratio')!.textContent = `${frontPct}% / ${rearPct}%`;

      document.getElementById('tele-lap-time')!.textContent = formatLapTime(activeCar.lapTime);
      const teleBestLap = document.getElementById('tele-best-lap-time');
      if (teleBestLap) {
        const standing = this.sync.session.teamStandings?.find(s => s.carColor === activeCar.color);
        const bestTime = this.raceUI.getDriverTrueBest(activeCar.color, standing?.lapTime, standing?.hasFinishedLap);
        teleBestLap.textContent = bestTime ? formatLapTime(bestTime) : '--:--.---';
      }
      document.getElementById('tele-lap-num')!.textContent = (activeCar.currentLap + 1).toString();

      // 4 Checkpoints / Sector Matrix in Telemetry
      for (let g = 0; g < 4; g++) {
        const timeEl = document.getElementById(`tele-sec-${g}-time`);
        const deltaEl = document.getElementById(`tele-sec-${g}-delta`);
        const boxEl = document.getElementById(`tele-sec-${g}`);
        if (!timeEl || !deltaEl) continue;

        const currSplit = activeCar.currentLapSplits ? activeCar.currentLapSplits[g] : null;
        const bestSplit = activeCar.bestLapSplits ? activeCar.bestLapSplits[g] : null;

        if (currSplit !== null && currSplit !== undefined) {
          timeEl.textContent = formatLapTime(currSplit);
          if (bestSplit !== null && bestSplit !== undefined) {
            const diff = currSplit - bestSplit;
            const sign = diff <= 0 ? '-' : '+';
            deltaEl.textContent = `${sign}${Math.abs(diff).toFixed(3)}s`;
            const isPurple = activeCar.lastCheckpointDelta?.gateIndex === g && activeCar.lastCheckpointDelta?.isPurple;
            if (isPurple) {
              deltaEl.className = 'sec-delta purple';
              if (boxEl) boxEl.style.borderColor = 'rgba(168, 85, 247, 0.6)';
            } else if (diff <= 0) {
              deltaEl.className = 'sec-delta ahead';
              if (boxEl) boxEl.style.borderColor = 'rgba(0, 230, 118, 0.5)';
            } else {
              deltaEl.className = 'sec-delta behind';
              if (boxEl) boxEl.style.borderColor = 'rgba(225, 6, 0, 0.5)';
            }
          } else {
            deltaEl.textContent = 'PB BASE';
            deltaEl.className = 'sec-delta ahead';
            if (boxEl) boxEl.style.borderColor = 'rgba(0, 210, 190, 0.4)';
          }
        } else {
          timeEl.textContent = bestSplit ? formatLapTime(bestSplit) : '--:--.---';
          deltaEl.textContent = bestSplit ? 'PB' : '--';
          deltaEl.className = 'sec-delta';
          if (boxEl) boxEl.style.borderColor = '#232932';
        }
      }

      if (activeCar.brain) {
        this.hudCharts.renderBrain(activeCar.brain, this.brainCanvas);
      }
    }

    // Render live learning progress chart
    this.renderLearningChart();
  }

  private renderLearningChart(): void {
    const canvas = this.learningChartCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Dark background
    ctx.fillStyle = '#090b0e';
    ctx.fillRect(0, 0, w, h);

    const history = this.population.learningHistory;
    const bestTag = document.getElementById('chart-best-tag');
    if (this.population.globalBestLap && bestTag) {
      bestTag.textContent = `REKORD: ${formatLapTime(this.population.globalBestLap)}`;
    }

    if (history.length < 2) {
      ctx.fillStyle = '#6b7280';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Rejestrowanie pierwszych czasów okrążeń...', w / 2, h / 2 + 3);
      return;
    }

    const padL = 40;
    const padR = 15;
    const padT = 12;
    const padB = 20;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    let minTime = Infinity;
    let maxTime = -Infinity;
    for (const item of history) {
      if (item.avgLap < minTime) minTime = item.avgLap;
      if (item.avgLap > maxTime) maxTime = item.avgLap;
      if (item.bestLap < minTime) minTime = item.bestLap;
      if (item.bestLap > maxTime) maxTime = item.bestLap;
    }

    minTime = Math.max(10, Math.floor(minTime - 2));
    maxTime = Math.ceil(maxTime + 2);
    const timeRange = Math.max(5, maxTime - minTime);

    // Horizontal grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#6b7280';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';

    const numGridLines = 3;
    for (let i = 0; i <= numGridLines; i++) {
      const t = minTime + (timeRange * i) / numGridLines;
      const y = padT + plotH - (plotH * (t - minTime)) / timeRange;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillText(`${t.toFixed(0)}s`, padL - 5, y + 3);
    }

    // Draw individual lap dots
    for (let i = 0; i < history.length; i++) {
      const item = history[i];
      const x = padL + (plotW * i) / (history.length - 1);
      const y = padT + plotH - (plotH * (item.avgLap - minTime)) / timeRange;

      ctx.fillStyle = item.teamColor || '#ff8000';
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw session best lap progression curve (glowing gold)
    ctx.strokeStyle = '#ffd700';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
      const item = history[i];
      const x = padL + (plotW * i) / (history.length - 1);
      const y = padT + plotH - (plotH * (item.bestLap - minTime)) / timeRange;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // End point highlight
    const lastItem = history[history.length - 1];
    const lastX = padL + plotW;
    const lastY = padT + plotH - (plotH * (lastItem.bestLap - minTime)) / timeRange;
    ctx.fillStyle = '#ffd700';
    ctx.beginPath();
    ctx.arc(lastX, lastY, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Boot application
window.addEventListener('DOMContentLoaded', () => {
  hydrateIcons();
  new App();
});
