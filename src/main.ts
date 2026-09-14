import { Vector2 } from './math/Vector2';
import { Spline } from './math/Spline';
import { Track } from './track/Track';
import { Presets } from './track/Presets';
import { Population, LapLeaderboardEntry } from './ai/Population';
import { Car, CarControl } from './physics/Car';
import { Renderer } from './rendering/Renderer';
import { SimBridge } from './workers/SimBridge';
import type { SimSnapshot } from './workers/sim.worker';

class App {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private brainCanvas: HTMLCanvasElement;
  private gMeterCanvas: HTMLCanvasElement;
  private learningChartCanvas: HTMLCanvasElement;
  private renderer: Renderer;

  // Web Worker Multithreading Bridge
  private bridge: SimBridge;
  private latestStandings: LapLeaderboardEntry[] = [];

  // Track & AI
  private track: Track;
  private population: Population;
  private playerCar: Car | null = null;
  private isPlayerDriving: boolean = false;
  private selectedCar: Car | null = null;

  // Drawing state
  private isDrawMode: boolean = false;
  private isMouseDown: boolean = false;
  private rawDrawnPoints: Vector2[] = [];
  private mousePos: Vector2 | null = null;
  private straightAnchor: Vector2 | null = null;
  private isShiftHeld: boolean = false;
  private trackWidth: number = 14;

  // Simulation controls
  private isPaused: boolean = true;
  private speedMultiplier: number = 1;
  private isHeadlessFast: boolean = false;

  // Race Mode State
  private selectedRaceLaps: number = 50;
  private latestRaceState: 'IDLE' | 'GRID_START' | 'RACING' | 'FINISHED' = 'IDLE';
  private latestRaceStartLights: number = 0;
  private latestRaceCurrentLap: number = 1;
  private latestRaceTotalLaps: number = 50;
  private latestRaceWinner: string | null = null;
  private latestRaceStandings: any[] = [];
  private hasShownPodiumModal: boolean = false;

  // Input states for manual driving
  private keys: Record<string, boolean> = {};

  constructor() {
    this.canvas = document.getElementById('sim-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.brainCanvas = document.getElementById('brain-canvas') as HTMLCanvasElement;
    this.gMeterCanvas = document.getElementById('g-meter-canvas') as HTMLCanvasElement;
    this.learningChartCanvas = document.getElementById('learning-chart') as HTMLCanvasElement;
    this.renderer = new Renderer(this.ctx);

    const initDims = Car.getDimensionsForTrackWidth(this.trackWidth);
    this.track = Presets.createGrandPrixTrack(initDims.effectiveTrackWidth);
    this.rawDrawnPoints = Presets.GRAND_PRIX_POINTS.map(p => p.clone());
    this.population = new Population(10, this.track, 25);

    this.bridge = new SimBridge();
    this.setupBridgeSync();

    this.setupWindowEvents();
    this.setupUIEvents();
    this.resizeCanvas();

    // Start simulation loop
    requestAnimationFrame(this.loop.bind(this));
  }

  private setupBridgeSync(): void {
    const threadBadge = document.getElementById('thread-badge');
    if (threadBadge) {
      threadBadge.textContent = `⚡ ${this.bridge.cpuCores} RDZENI (WEB WORKER)`;
    }

    this.bridge.onSnapshotCallback = (snapshot: SimSnapshot) => {
      for (let i = 0; i < this.population.cars.length; i++) {
        const car = this.population.cars[i];
        const sc = snapshot.cars[i];
        if (!car || !sc) continue;

        car.pos.x = sc.x;
        car.pos.y = sc.y;
        car.heading = sc.angle;
        car.speedKmh = sc.speedKmh;
        car.isAlive = sc.isAlive;
        car.isManual = sc.isManual;
        if (sc.ctrl) car.manualControl = sc.ctrl;
        car.fitness = sc.fitness;
        car.currentLap = sc.currentLap;
        car.lapTime = sc.lapTime;
        car.lastLapTime = sc.lastLapTime;
        if (typeof sc.bestLapTime === 'number' && sc.bestLapTime > 0) {
          if (!car.bestLapTime || sc.bestLapTime < car.bestLapTime) {
            car.bestLapTime = sc.bestLapTime;
          }
        }
        car.fuelKg = sc.fuelKg;
        car.lateralG = sc.lateralG;
        car.longitudinalG = sc.longitudinalG;
        car.weightFrontRatio = sc.weightFrontRatio;
        car.brakingAggression = sc.brakingAggression;
        car.understeerSlip = sc.understeerSlip;
        car.oversteerSlip = sc.oversteerSlip;
        car.isSkidding = sc.isSkidding;
        car.skidMarks = sc.skidMarks.map(m => new Vector2(m.x, m.y));
        car.rayHits = sc.sensorRays.map(r => ({ point: new Vector2(r.x, r.y), dist: r.dist }));
        if (sc.currentSplits) car.currentLapSplits = [...sc.currentSplits];
        if (sc.bestSplits) car.bestLapSplits = [...sc.bestSplits];
        if (sc.lastCheckpointDelta) {
          car.lastCheckpointDelta = { ...sc.lastCheckpointDelta };
        } else {
          car.lastCheckpointDelta = null;
        }
        car.wantsToPit = sc.wantsToPit;
        car.isPitting = sc.isPitting;
        car.pitTimer = sc.pitTimer;
        car.pitStopsCount = sc.pitStopsCount;
        car.raceLapsCompleted = sc.raceLapsCompleted;
      }

      if (snapshot.timingGates && snapshot.timingGates.length > 0 && (!this.track.timingGates || this.track.timingGates.length === 0)) {
        this.track.timingGates = snapshot.timingGates.map(g => ({
          ...g,
          left: new Vector2(g.left.x, g.left.y),
          right: new Vector2(g.right.x, g.right.y),
          center: new Vector2(g.center.x, g.center.y),
          tangent: new Vector2(g.tangent.x, g.tangent.y),
          normal: new Vector2(g.normal.x, g.normal.y),
        }));
      }

      this.population.bestRacingLine = snapshot.bestRacingLine.map(p => ({ ...p }));
      this.population.leaderCheckpointSpeeds = [...snapshot.leaderCheckpointSpeeds];
      this.population.learningHistory = snapshot.learningHistory.map(h => ({ ...h }));
      this.population.globalBestLap = snapshot.globalBestLap;
      this.population.generation = snapshot.generation;

      this.latestRaceState = snapshot.raceState;
      this.latestRaceTotalLaps = snapshot.raceTotalLaps;
      this.latestRaceCurrentLap = snapshot.raceCurrentLap;
      this.latestRaceStartLights = snapshot.raceStartLights;
      this.latestRaceWinner = snapshot.raceWinner;
      this.latestRaceStandings = snapshot.raceStandings || [];

      if (snapshot.raceState === 'FINISHED' && !this.hasShownPodiumModal) {
        this.hasShownPodiumModal = true;
        this.showPodiumModal(snapshot.raceStandings, snapshot.raceWinner);
      }

      if (snapshot.teamStandings && snapshot.teamStandings.length > 0) {
        this.latestStandings = snapshot.teamStandings;
        for (const standing of snapshot.teamStandings) {
          const rec = this.population.teamRecords.find(t => t.color === standing.carColor);
          if (rec) {
            if (standing.hasFinishedLap && standing.lapTime > 0) {
              if (!rec.bestLapTime || standing.lapTime < rec.bestLapTime) {
                rec.bestLapTime = standing.lapTime;
              }
            }
            if (standing.lastLapTime !== undefined) {
              rec.lastLapTime = standing.lastLapTime;
            }
            rec.avgSpeed = standing.avgSpeed;
            rec.topSpeed = standing.topSpeed;
            rec.fuelRemaining = standing.fuelRemaining;
          }
          const car = this.population.cars.find(c => c.color === standing.carColor);
          if (car && standing.hasFinishedLap && standing.lapTime > 0) {
            if (!car.bestLapTime || standing.lapTime < car.bestLapTime) {
              car.bestLapTime = standing.lapTime;
            }
          }
          if (car && standing.lastLapTime !== undefined) {
            car.lastLapTime = standing.lastLapTime;
          }
        }
      }

      if (this.playerCar && snapshot.playerCar) {
        const sp = snapshot.playerCar;
        this.playerCar.pos.x = sp.x;
        this.playerCar.pos.y = sp.y;
        this.playerCar.heading = sp.angle;
        this.playerCar.speedKmh = sp.speedKmh;
        this.playerCar.isAlive = sp.isAlive;
        this.playerCar.fuelKg = sp.fuelKg;
        this.playerCar.currentLap = sp.currentLap;
        this.playerCar.lapTime = sp.lapTime;
        this.playerCar.bestLapTime = sp.bestLapTime;
        this.playerCar.lastLapTime = sp.lastLapTime;
        this.playerCar.lateralG = sp.lateralG;
        this.playerCar.longitudinalG = sp.longitudinalG;
        this.playerCar.weightFrontRatio = sp.weightFrontRatio;
        if (sp.currentSplits) this.playerCar.currentLapSplits = [...sp.currentSplits];
        if (sp.bestSplits) this.playerCar.bestLapSplits = [...sp.bestSplits];
        if (sp.lastCheckpointDelta) {
          this.playerCar.lastCheckpointDelta = { ...sp.lastCheckpointDelta };
        } else {
          this.playerCar.lastCheckpointDelta = null;
        }
        this.playerCar.wantsToPit = sp.wantsToPit;
        this.playerCar.isPitting = sp.isPitting;
        this.playerCar.pitTimer = sp.pitTimer;
        this.playerCar.pitStopsCount = sp.pitStopsCount;
        this.playerCar.raceLapsCompleted = sp.raceLapsCompleted;
      }

      if (snapshot.activeCarBrainJson) {
        const activeCar = this.selectedCar || this.population.currentLeader;
        if (activeCar && activeCar.brain) {
          try {
            activeCar.brain.fromJSON(snapshot.activeCarBrainJson);
          } catch (e) {}
        }
      }
    };
  }

  private resizeCanvas(): void {
    const wrapper = document.getElementById('canvas-wrapper')!;
    const dpr = window.devicePixelRatio || 1;
    const rect = wrapper.getBoundingClientRect();

    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.resetTransform();
    this.ctx.scale(dpr, dpr);
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

    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      this.keys[key] = true;
      if (key === 'p') {
        this.togglePlayerPit();
      }
      if (this.isPlayerDriving && ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'w', 's', 'a', 'd'].includes(key)) {
        e.preventDefault();
      }
      if (e.key === 'Shift') {
        this.isShiftHeld = true;
        if (this.isDrawMode && this.isMouseDown && !this.straightAnchor) {
          const last = this.rawDrawnPoints[this.rawDrawnPoints.length - 1];
          this.straightAnchor = last ? last.clone() : (this.mousePos ? this.mousePos.clone() : null);
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys[e.key.toLowerCase()] = false;
      if (e.key === 'Shift') {
        this.isShiftHeld = false;
        if (this.isDrawMode && this.isMouseDown && this.straightAnchor && this.mousePos) {
          this.commitStraightSegment(this.straightAnchor, this.mousePos);
        }
      }
    });
  }

  private setupUIEvents(): void {
    const canvas = this.canvas;

    // Drawing mouse events
    canvas.addEventListener('mousedown', (e) => {
      if (!this.isDrawMode) return;
      this.isMouseDown = true;
      const pt = this.getCanvasMousePos(e);
      this.rawDrawnPoints = [pt];
      this.straightAnchor = (e.shiftKey || this.isShiftHeld) ? pt.clone() : null;
    });

    canvas.addEventListener('mousemove', (e) => {
      this.mousePos = this.getCanvasMousePos(e);
      if (this.isDrawMode && this.isMouseDown) {
        if (e.shiftKey || this.isShiftHeld) {
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
      if (this.isDrawMode) return;
      const clickPos = this.getCanvasMousePos(e);
      let closestCar: Car | null = null;
      let minDist = 36; // 36px click tolerance radius

      for (const car of this.population.cars) {
        if (!car.isAlive) continue;
        const d = car.pos.dist(clickPos);
        if (d < minDist) {
          minDist = d;
          closestCar = car;
        }
      }

      if (this.playerCar && this.playerCar.isAlive) {
        const d = this.playerCar.pos.dist(clickPos);
        if (d < minDist) {
          minDist = d;
          closestCar = this.playerCar;
        }
      }

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
    leaderboardContainer?.addEventListener('click', (e) => {
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
        btnDraw.classList.add('active');
        btnDraw.innerHTML = '<span class="btn-icon">✅</span> Zakończ Rysowanie';
        drawBanner.classList.remove('hidden');
        this.rawDrawnPoints = [];
      } else {
        btnDraw.classList.remove('active');
        btnDraw.innerHTML = '<span class="btn-icon">✏️</span> Rysuj Własny Tor';
        drawBanner.classList.add('hidden');
        if (this.rawDrawnPoints.length > 5) {
          this.finishDrawnTrack();
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
        btnPlay.innerHTML = '<span class="btn-icon">⏸️</span> Pauza';
        btnPlay.classList.add('primary');
      } else {
        btnPlay.innerHTML = '<span class="btn-icon">▶️</span> Wznów';
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
      btnPlay.innerHTML = '<span class="btn-icon">▶️</span> Start';
      btnPlay.classList.remove('primary');

      if (this.latestRaceState !== 'IDLE') {
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

    const btnRefuel = document.getElementById('btn-refuel')!;
    btnRefuel.addEventListener('click', () => {
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
            btnPlay.innerHTML = '<span class="btn-icon">⏸️</span> Pauza';
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
        if (speed === 'max') {
          this.isHeadlessFast = true;
          this.speedMultiplier = 200;
          this.bridge.setSpeed('max');
        } else {
          this.isHeadlessFast = false;
          this.speedMultiplier = parseInt(speed || '1', 10);
          this.bridge.setSpeed(this.speedMultiplier);
        }
      });
    });

    // Preset buttons
    document.getElementById('preset-gp')!.addEventListener('click', () => {
      const dims = Car.getDimensionsForTrackWidth(this.trackWidth);
      this.track = Presets.createGrandPrixTrack(dims.effectiveTrackWidth);
      this.rawDrawnPoints = Presets.GRAND_PRIX_POINTS.map(p => p.clone());
      this.population = new Population(10, this.track, this.population.rayCount);
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
      this.rawDrawnPoints = Presets.OVAL_POINTS.map(p => p.clone());
      this.population = new Population(10, this.track, this.population.rayCount);
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

    // Sliders
    const widthSlider = document.getElementById('slider-track-width') as HTMLInputElement;
    const widthLabel = document.getElementById('val-track-width')!;
    widthSlider.addEventListener('input', () => {
      this.trackWidth = parseInt(widthSlider.value, 10);
      widthLabel.textContent = this.trackWidth.toString();
      const dims = Car.getDimensionsForTrackWidth(this.trackWidth);
      if (this.track.points.length > 0) {
        const sourcePoints = (this.rawDrawnPoints && this.rawDrawnPoints.length >= 4)
          ? this.rawDrawnPoints
          : this.track.points.map((p) => p.center);
        const newPoints = Spline.generateClosedTrack(sourcePoints, dims.effectiveTrackWidth, 18);
        if (newPoints.length > 3) {
          this.track = new Track(newPoints, dims.effectiveTrackWidth);
          this.population.resetAll(this.track);
          this.bridge.setTrackWidth(this.trackWidth);
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

    const mutSlider = document.getElementById('slider-mutation') as HTMLInputElement;
    const mutLabel = document.getElementById('val-mutation')!;
    mutSlider.addEventListener('input', () => {
      const val = parseInt(mutSlider.value, 10);
      mutLabel.textContent = `${val}%`;
      this.population.mutationRate = val / 100;
      this.bridge.setMutation(val / 100);
    });

    // Sensor raycast checkbox
    const checkSensors = document.getElementById('check-sensors') as HTMLInputElement;
    checkSensors.addEventListener('change', () => {
      this.renderer.showSensors = checkSensors.checked;
    });

    // LiDAR ray count slider
    const lidarSlider = document.getElementById('slider-lidar-count') as HTMLInputElement;
    const valLidar = document.getElementById('val-lidar-count')!;
    lidarSlider.addEventListener('input', () => {
      const count = parseInt(lidarSlider.value, 10);
      valLidar.textContent = count.toString();
      this.population.setRayCount(count, this.track);
      this.bridge.setLidarCount(count);
      if (this.playerCar) {
        this.playerCar = new Car(
          this.track.startPosition,
          this.track.startAngle,
          null,
          '#00D2BE',
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

    document.getElementById('btn-start-race')?.addEventListener('click', () => {
      this.startRace(this.selectedRaceLaps);
    });

    document.getElementById('btn-stop-race')?.addEventListener('click', () => {
      this.stopRace();
    });

    document.getElementById('btn-pit-player')?.addEventListener('click', () => {
      this.togglePlayerPit();
    });

    document.getElementById('btn-close-podium')?.addEventListener('click', () => {
      document.getElementById('podium-modal')?.classList.add('hidden');
    });

    document.getElementById('btn-restart-race-podium')?.addEventListener('click', () => {
      document.getElementById('podium-modal')?.classList.add('hidden');
      this.startRace(this.selectedRaceLaps);
    });
  }

  public startRace(totalLaps: number = 50): void {
    this.hasShownPodiumModal = false;
    this.selectedRaceLaps = totalLaps;
    this.bridge.startRace(totalLaps);
    this.isPaused = false;
    document.getElementById('btn-start-race')?.classList.add('hidden');
    document.getElementById('btn-stop-race')?.classList.remove('hidden');
    document.getElementById('race-info-banner')?.classList.remove('hidden');
    document.getElementById('start-banner')?.classList.add('hidden');
    const playBtn = document.getElementById('btn-play');
    if (playBtn) {
      playBtn.innerHTML = '<span class="btn-icon">⏸️</span> Pauza';
      playBtn.classList.remove('primary');
      playBtn.classList.add('active');
    }
  }

  public stopRace(): void {
    this.bridge.stopRace();
    document.getElementById('btn-start-race')?.classList.remove('hidden');
    document.getElementById('btn-stop-race')?.classList.add('hidden');
    document.getElementById('race-info-banner')?.classList.add('hidden');
    document.getElementById('podium-modal')?.classList.add('hidden');

    this.population.isRaceMode = false;
    this.latestRaceState = 'IDLE';
    this.resetCarPositions();
    this.latestRaceStandings = [];
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
      car.raceLapsCompleted = 0;
      car.totalRaceTime = 0;
      car.isPitting = false;
      car.wantsToPit = false;
    }
    if (this.playerCar) {
      this.playerCar.isRaceMode = false;
      const slot = this.track.getGridSlot(9);
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

  public resetBestTimes(): void {
    this.bridge.resetBestTimes();
    this.population.resetBestTimes();
    if (this.playerCar) {
      this.playerCar.bestLapTime = null;
      this.playerCar.lastLapTime = null;
      this.playerCar.bestLapSplits = [null, null, null, null];
      this.playerCar.currentLapSplits = [null, null, null, null];
      this.playerCar.lastCheckpointDelta = null;
    }
    if (this.latestStandings) {
      for (const s of this.latestStandings) {
        s.lapTime = 0;
        s.lastLapTime = null;
        s.hasFinishedLap = false;
      }
    }
    for (const rs of this.latestRaceStandings) {
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

    const btn = document.getElementById('btn-reset-best-times');
    if (btn) {
      btn.classList.add('highlight');
      setTimeout(() => btn.classList.remove('highlight'), 500);
    }

    this.updateHUD();
  }

  public getDriverTrueBest(carColor: string, entryLapTime?: number, entryHasFinished?: boolean): number | null {
    const car = this.population.cars.find(c => c.color === carColor)
      || (this.playerCar && this.playerCar.color === carColor ? this.playerCar : null);
    const teamRec = this.population.teamRecords.find(t => t.color === carColor);
    const rs = this.latestRaceStandings.find(s => s.carColor === carColor);

    const candidates: number[] = [];
    if (entryHasFinished && typeof entryLapTime === 'number' && entryLapTime > 0) {
      candidates.push(entryLapTime);
    }
    if (teamRec && typeof teamRec.bestLapTime === 'number' && teamRec.bestLapTime > 0) {
      candidates.push(teamRec.bestLapTime);
    }
    if (car && typeof car.bestLapTime === 'number' && car.bestLapTime > 0) {
      candidates.push(car.bestLapTime);
    }
    if (rs && typeof rs.bestLap === 'number' && rs.bestLap > 0) {
      candidates.push(rs.bestLap);
    }

    if (candidates.length === 0) return null;
    const trueBest = Math.min(...candidates);

    if (teamRec && (!teamRec.bestLapTime || trueBest < teamRec.bestLapTime)) {
      teamRec.bestLapTime = trueBest;
    }
    if (car && (!car.bestLapTime || trueBest < car.bestLapTime)) {
      car.bestLapTime = trueBest;
    }

    return trueBest;
  }

  private showPodiumModal(standings: any[], _winnerName: string | null): void {
    const modal = document.getElementById('podium-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    const lapsTag = document.getElementById('podium-laps-tag');
    if (lapsTag) lapsTag.textContent = `${this.latestRaceTotalLaps} OKRĄŻEŃ`;

    const podiumCards = document.getElementById('podium-cards');
    if (podiumCards && standings && standings.length >= 3) {
      const p1 = standings[0];
      const p2 = standings[1];
      const p3 = standings[2];

      podiumCards.innerHTML = `
        <div class="podium-card p2">
          <div class="podium-pos-badge" style="background:${p2.carColor}; color:#fff;">2</div>
          <div class="podium-driver">${p2.driverName}</div>
          <div class="podium-time">${p2.gap}</div>
          <div class="podium-time">🛑 ${p2.pitStops} PIT</div>
        </div>
        <div class="podium-card p1">
          <div class="podium-pos-badge" style="background:${p1.carColor}; color:#fff;">1</div>
          <div class="podium-driver">🏆 ${p1.driverName}</div>
          <div class="podium-time">ZWYCIĘZCA</div>
          <div class="podium-time">🛑 ${p1.pitStops} PIT</div>
        </div>
        <div class="podium-card p3">
          <div class="podium-pos-badge" style="background:${p3.carColor}; color:#fff;">3</div>
          <div class="podium-driver">${p3.driverName}</div>
          <div class="podium-time">${p3.gap}</div>
          <div class="podium-time">🛑 ${p3.pitStops} PIT</div>
        </div>
      `;
    }

    const tableBody = document.getElementById('podium-table-body');
    if (tableBody && standings) {
      tableBody.innerHTML = standings.map(s => `
        <tr>
          <td><strong>#${s.rank}</strong></td>
          <td><span class="team-dot" style="background-color:${s.carColor}"></span> ${s.driverName}</td>
          <td>${s.gap}</td>
          <td>${s.pitStops}</td>
          <td>${s.bestLap ? this.formatLapTime(s.bestLap) : '--:--.---'}</td>
          <td>${s.totalTime.toFixed(1)}s</td>
        </tr>
      `).join('');
    }
  }

  public async loadModelFromJSON(content: string): Promise<boolean> {
    try {
      const data = JSON.parse(content);
      if (data.type === 'F1_ALL_MODELS' || (Array.isArray(data.drivers) && data.drivers.length > 0)) {
        if (this.bridge && this.bridge.isReady) {
          await this.bridge.loadAllModels(data);
        }

        for (let i = 0; i < this.population.cars.length; i++) {
          const car = this.population.cars[i];
          const record = this.population.teamRecords[i];
          const driverData = data.drivers.find((d: any) => d.color === car.color) || data.drivers[i];
          if (driverData) {
            if (driverData.brain && car.brain) {
              car.brain.fromJSON(JSON.stringify(driverData.brain));
            }
            if (driverData.bestBrain && record?.bestBrain) {
              record.bestBrain.fromJSON(JSON.stringify(driverData.bestBrain));
            }
            if (typeof driverData.baseBrakingAggression === 'number') {
              car.baseBrakingAggression = driverData.baseBrakingAggression;
              car.brakingAggression = driverData.brakingAggression || driverData.baseBrakingAggression;
            }
            if (typeof driverData.bestLapTime === 'number') {
              car.bestLapTime = driverData.bestLapTime;
              if (record) record.bestLapTime = driverData.bestLapTime;
            }
          }
        }
        if (data.generation) this.population.generation = data.generation;
        if (data.globalBestLap) this.population.globalBestLap = data.globalBestLap;
        this.resetCarPositions();
        this.bridge.resetCarPositions();
        alert(`Załadowano modele AI wszystkich kierowców (Gen ${data.generation || 1})!`);
        return true;
      } else if (data.layers || data.weights) {
        if (this.bridge && this.bridge.isReady) {
          await this.bridge.loadBrain(content);
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

  public loadTrackFromJSON(content: string, sourceName?: string): boolean {
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

      if (typeof data.trackWidth === 'number' && !isNaN(data.trackWidth)) {
        this.trackWidth = Math.max(5, Math.min(20, Math.round(data.trackWidth)));
        const sliderWidth = document.getElementById('slider-track-width') as HTMLInputElement;
        const valWidth = document.getElementById('val-track-width');
        if (sliderWidth) sliderWidth.value = this.trackWidth.toString();
        if (valWidth) valWidth.textContent = this.trackWidth.toString();
      }

      const dims = Car.getDimensionsForTrackWidth(this.trackWidth);
      const splinePoints = Spline.generateClosedTrack(parsedPoints, dims.effectiveTrackWidth, 18);

      if (splinePoints.length < 8) {
        alert('Błąd: Nie udało się wygenerować zamkniętej pętli toru z podanych punktów.');
        return false;
      }

      this.track = new Track(splinePoints, dims.effectiveTrackWidth);
      this.rawDrawnPoints = parsedPoints;
      this.population = new Population(10, this.track, this.population.rayCount);
      this.selectedCar = null;
      this.bridge.setCustomTrack(parsedPoints.map(p => ({ x: p.x, y: p.y })), this.trackWidth);

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
      alert(`Tor "${trackName}" został pomyślnie załadowany!`);
      return true;
    } catch (e) {
      alert('Błąd: Plik nie jest poprawnym formatem JSON toru.');
      return false;
    }
  }

  private getCanvasMousePos(e: MouseEvent): Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    return new Vector2(e.clientX - rect.left, e.clientY - rect.top);
  }

  private finishDrawnTrack(): void {
    if (this.rawDrawnPoints.length < 5) return;

    const dims = Car.getDimensionsForTrackWidth(this.trackWidth);
    const splinePoints = Spline.generateClosedTrack(this.rawDrawnPoints, dims.effectiveTrackWidth, 18);
    if (splinePoints.length >= 8) {
      this.track = new Track(splinePoints, dims.effectiveTrackWidth);
      this.population = new Population(10, this.track, this.population.rayCount);
      this.bridge.setCustomTrack(this.rawDrawnPoints.map(p => ({ x: p.x, y: p.y })), this.trackWidth);
      if (this.playerCar) {
        this.playerCar.reset(this.track.startPosition, this.track.startAngle, true);
        this.playerCar.updateDimensionsForTrackWidth(this.trackWidth);
      }

      this.isDrawMode = false;
      const btnDraw = document.getElementById('btn-draw')!;
      btnDraw.classList.remove('active');
      btnDraw.innerHTML = '<span class="btn-icon">✏️</span> Rysuj Własny Tor';
      document.getElementById('draw-banner')!.classList.add('hidden');
    }
  }

  private getPlayerControl(): CarControl {
    let steer = 0;
    let throttle = 0;
    let brake = 0;

    if (this.keys['a'] || this.keys['arrowleft']) steer -= 1;
    if (this.keys['d'] || this.keys['arrowright']) steer += 1;
    if (this.keys['w'] || this.keys['arrowup']) throttle = 1;
    if (this.keys['s'] || this.keys['arrowdown']) brake = 1;

    return { steer, throttle, brake };
  }

  private loop(): void {
    const wrapper = document.getElementById('canvas-wrapper')!;
    const rect = wrapper.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    // Simulation updates
    if (!this.bridge.isReady) {
      // Fallback synchronous loop if Web Worker is not available
      if (!this.isPaused && !this.isDrawMode) {
        const steps = this.isHeadlessFast ? 200 : this.speedMultiplier;
        const fixedDt = 1 / 60;

        for (let s = 0; s < steps; s++) {
          this.population.update(fixedDt, this.track);

          if (this.playerCar && this.playerCar.isAlive) {
            this.playerCar.updateSensors(this.track);
            const control = this.getPlayerControl();
            const lapEvent = this.playerCar.updatePhysics(control, fixedDt, this.track);
            if (lapEvent) {
              this.population.recordLap(lapEvent, this.playerCar, true);
            }
          }
        }
      }
    } else if (this.isPlayerDriving) {
      // Web Worker is active: send real-time player input
      this.bridge.sendPlayerInput(this.getPlayerControl());
    }

    // Render frame
    this.renderer.clear(width, height);
    this.renderer.renderTrack(this.track);
    this.renderer.renderSkidMarks(this.population.cars);

    if (this.isDrawMode) {
      this.renderer.renderDrawingPath(this.rawDrawnPoints, this.mousePos, this.straightAnchor);
    } else {
      // Render optimal racing line (najbardziej optymalna nitka toru)
      this.renderer.renderOptimalRacingLine(this.population.bestRacingLine);

      // Render AI cars
      const leader = this.population.currentLeader;
      const hasSelected = !!this.selectedCar;
      for (const car of this.population.cars) {
        if (car !== leader && car !== this.selectedCar) {
          this.renderer.renderCar(car, false, car.isManual, false, hasSelected);
        }
      }
      // Render leader
      if (leader && leader !== this.selectedCar) {
        this.renderer.renderCar(leader, true, leader.isManual, false, hasSelected);
      }
      // Render selected car on top
      if (this.selectedCar && this.selectedCar !== this.playerCar) {
        this.renderer.renderCar(this.selectedCar, this.selectedCar === leader, this.selectedCar.isManual, true, true);
      }

      // Render Player car if driving
      if (this.playerCar && this.playerCar.isAlive) {
        const isPlayerSelected = this.selectedCar === this.playerCar;
        this.renderer.renderCar(this.playerCar, false, true, isPlayerSelected, hasSelected);
      }

      // Render 5 F1 Start Lights during countdown
      this.renderer.renderStartLights(this.latestRaceStartLights, this.latestRaceState);

      // Render Chequered Flag finish banner if race finished
      if (this.latestRaceState === 'FINISHED') {
        this.renderer.renderChequeredFlagBanner(this.latestRaceWinner);
      }
    }

    // Update Telemetry & UI
    this.updateHUD();

    requestAnimationFrame(this.loop.bind(this));
  }

  private updateHUD(): void {
    const leader = (this.isPlayerDriving && this.playerCar?.isAlive ? this.playerCar : this.population.currentLeader) || this.population.cars[0];
    const activeCar = this.selectedCar || leader;

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
          btnTakeover.innerHTML = '🤖 Oddaj AI';
          btnTakeover.classList.add('active');
        } else {
          btnTakeover.innerHTML = '🏎️ Prowadź Bolid (WASD)';
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
        btnDrive.innerHTML = `<span class="btn-icon">🏎️</span> Gracz: ${driverTitle} (WASD)`;
        btnDrive.classList.add('active');
      } else {
        btnDrive.innerHTML = '<span class="btn-icon">🏎️</span> Gracz (WASD)';
        btnDrive.classList.remove('active');
      }
    }

    // Stats bar
    document.getElementById('stat-gen')!.textContent = this.population.generation.toString();
    document.getElementById('stat-alive')!.textContent = `${this.population.aliveCount} / ${this.population.populationSize}`;
    document.getElementById('stat-fitness')!.textContent = Math.round(this.population.bestFitness).toLocaleString();

    if (this.population.globalBestLap) {
      document.getElementById('stat-best-lap')!.textContent = this.formatLapTime(this.population.globalBestLap);
    }

    // Race Mode HUD elements
    const raceTag = document.getElementById('race-status-tag');
    if (raceTag) {
      if (this.latestRaceState === 'GRID_START') {
        raceTag.textContent = 'START (GRID)';
        raceTag.className = 'panel-tag';
        raceTag.style.background = '#e10600';
      } else if (this.latestRaceState === 'RACING') {
        raceTag.textContent = 'WYŚCIG TRWA';
        raceTag.className = 'panel-tag cyan';
        raceTag.style.background = '';
      } else if (this.latestRaceState === 'FINISHED') {
        raceTag.textContent = 'META (FLAGA)';
        raceTag.className = 'panel-tag';
        raceTag.style.background = '#a855f7';
      } else {
        raceTag.textContent = 'TRENING';
        raceTag.className = 'panel-tag gold';
        raceTag.style.background = '';
      }
    }

    const raceLapCounter = document.getElementById('race-lap-counter');
    if (raceLapCounter) {
      raceLapCounter.textContent = `${this.latestRaceCurrentLap} / ${this.latestRaceTotalLaps}`;
    }
    const raceLeaderEl = document.getElementById('race-leader-name');
    if (raceLeaderEl) {
      const topCar = this.latestRaceStandings?.[0];
      raceLeaderEl.textContent = topCar ? topCar.driverName.split(' ')[0] : '-';
    }
    const racePitStatusEl = document.getElementById('race-pit-status');
    const pitPlayerBtn = document.getElementById('btn-pit-player');
    const playerControlledCar = (this.isPlayerDriving ? (this.population.cars.find(c => c.isManual) || this.playerCar) : null);
    if (playerControlledCar) {
      if (playerControlledCar.isPitting) {
        if (racePitStatusEl) racePitStatusEl.textContent = 'W BOKSIE!';
        if (pitPlayerBtn) pitPlayerBtn.classList.add('active');
      } else if (playerControlledCar.wantsToPit) {
        if (racePitStatusEl) racePitStatusEl.textContent = 'ZJAZD [P]';
        if (pitPlayerBtn) pitPlayerBtn.classList.add('active');
      } else {
        if (racePitStatusEl) racePitStatusEl.textContent = 'OTWARTE';
        if (pitPlayerBtn) pitPlayerBtn.classList.remove('active');
      }
    }

    // 10 Teams Leaderboard
    const leaderboardContainer = document.getElementById('leaderboard-list')!;
    const standings = (this.latestRaceState !== 'IDLE' && this.latestRaceStandings.length > 0)
      ? this.latestRaceStandings.map(rs => {
          const matchingEntry = (this.latestStandings || []).find(s => s.carColor === rs.carColor);
          const car = this.population.cars.find(c => c.color === rs.carColor);
          return {
            id: rs.rank,
            rank: rs.rank,
            lapTime: rs.bestLap || 0,
            lastLapTime: rs.lastLap ?? (matchingEntry?.lastLapTime ?? (car ? car.lastLapTime : null)),
            avgSpeed: matchingEntry ? matchingEntry.avgSpeed : (car ? Math.round(car.speedKmh) : 0),
            topSpeed: matchingEntry ? matchingEntry.topSpeed : (car ? Math.round(car.maxSpeedInLap * 3.6) : 0),
            fuelRemaining: car ? Math.round(car.fuelKg * 10) / 10 : (matchingEntry ? matchingEntry.fuelRemaining : 0),
            driverName: rs.driverName,
            carColor: rs.carColor,
            generation: this.population.generation,
            isPlayer: rs.isPlayer,
            hasFinishedLap: rs.bestLap !== null,
          };
        })
      : ((this.latestStandings && this.latestStandings.length > 0)
          ? this.latestStandings.map(s => ({ ...s }))
          : this.population.teamStandings.map(s => ({ ...s })));

    // In training mode, sort standings by immutable personal best lap time ascending (P1 on top)
    if (this.latestRaceState === 'IDLE') {
      standings.sort((a, b) => {
        const bestA = this.getDriverTrueBest(a.carColor, a.lapTime, a.hasFinishedLap);
        const bestB = this.getDriverTrueBest(b.carColor, b.lapTime, b.hasFinishedLap);
        if (bestA !== null && bestB !== null) return bestA - bestB;
        if (bestA !== null) return -1;
        if (bestB !== null) return 1;
        const carA = this.population.cars.find(c => c.color === a.carColor);
        const carB = this.population.cars.find(c => c.color === b.carColor);
        return (carB ? carB.fitness : 0) - (carA ? carA.fitness : 0);
      });
      standings.forEach((entry, idx) => {
        entry.rank = idx + 1;
      });
    }

    // Determine overall fastest lap in current session for calculating P1 / deltas
    const sessionBests = standings
      .map(e => this.getDriverTrueBest(e.carColor, e.lapTime, e.hasFinishedLap))
      .filter((t): t is number => typeof t === 'number' && t > 0);
    const sessionFastestLap = sessionBests.length > 0 ? Math.min(...sessionBests) : null;

    leaderboardContainer.innerHTML = standings
      .map((entry) => {
        const car = this.population.cars.find(c => c.color === entry.carColor)
          || (this.playerCar && this.playerCar.color === entry.carColor ? this.playerCar : null);
        const isSelected = this.selectedCar && (
          (entry.isPlayer && this.selectedCar === this.playerCar) ||
          (!entry.isPlayer && this.selectedCar === car)
        );

        const bestTimeVal = this.getDriverTrueBest(entry.carColor, entry.lapTime, entry.hasFinishedLap);
        const teamRec = this.population.teamRecords.find(t => t.color === entry.carColor);
        const lastTimeVal = (entry as any).lastLapTime ?? teamRec?.lastLapTime ?? car?.lastLapTime ?? null;
        const lastTimeStr = (lastTimeVal && lastTimeVal > 0) ? this.formatLapTime(lastTimeVal) : '--:--.---';

        // 1. Czas najlepszy (Personal Best) lub pozycja/strata w wyścigu
        let bestTimeStr: string;
        let deltaStr: string;

        if (this.latestRaceState !== 'IDLE') {
          const rs = this.latestRaceStandings.find(s => s.carColor === entry.carColor);
          bestTimeStr = bestTimeVal ? this.formatLapTime(bestTimeVal) : '--:--.---';
          deltaStr = rs ? rs.gap : '';
        } else if (bestTimeVal !== null) {
          bestTimeStr = this.formatLapTime(bestTimeVal);
          if (sessionFastestLap && Math.abs(bestTimeVal - sessionFastestLap) < 0.001) {
            deltaStr = 'P1';
          } else if (sessionFastestLap && bestTimeVal > sessionFastestLap) {
            deltaStr = `+${(bestTimeVal - sessionFastestLap).toFixed(3)}s`;
          } else {
            deltaStr = '';
          }
        } else {
          bestTimeStr = '--:--.---';
          deltaStr = '';
        }

        // 2. Czas aktualny (bieżący przejazd)
        let currentTimeStr: string;
        if (car && car.isPitting) {
          currentTimeStr = `PIT (${car.pitTimer.toFixed(1)}s)`;
        } else if (car && !car.isAlive) {
          if (this.latestRaceState !== 'IDLE') {
            currentTimeStr = '<span style="color:#ff5252; font-weight:700;">💥 DNF</span>';
          } else {
            currentTimeStr = 'PIT (RESPAWN)';
          }
        } else if (car && car.wantsToPit) {
          currentTimeStr = `${this.formatLapTime(car.lapTime)} [BOX]`;
        } else if (car) {
          currentTimeStr = this.formatLapTime(car.lapTime);
        } else {
          currentTimeStr = '--:--.---';
        }

        // 2b. Checkpoint Delta Badge (F1 broadcast style)
        let cpBadgeHtml = '';
        const targetCar = entry.isPlayer ? this.playerCar : car;
        if (targetCar && targetCar.isAlive && targetCar.lastCheckpointDelta) {
          const cp = targetCar.lastCheckpointDelta;
          const sign = cp.delta <= 0 ? '-' : '+';
          const valStr = `${sign}${Math.abs(cp.delta).toFixed(3)}s`;
          const gateLabel = `CP${cp.gateIndex + 1}`;
          let colorClass = 'cp-red';
          if (cp.isPurple) {
            colorClass = 'cp-purple';
          } else if (cp.delta <= 0) {
            colorClass = 'cp-green';
          }
          cpBadgeHtml = `<span class="cp-delta-pill ${colorClass}" title="${cp.gateName}: split ${this.formatLapTime(cp.splitTime)}">${gateLabel} ${valStr}</span>`;
        }

        const rankClass = entry.rank <= 3 ? `rank-${entry.rank}` : '';
        const dnfClass = (car && !car.isAlive) ? 'dnf-item' : '';
        const selectedClass = isSelected ? 'selected-item' : '';

        return `
          <div class="leaderboard-item ${rankClass} ${dnfClass} ${selectedClass}" data-car-color="${entry.carColor}" data-is-player="${entry.isPlayer ? 'true' : 'false'}">
            <div class="leaderboard-left">
              <div class="rank-badge">${entry.rank}</div>
              <div class="driver-details">
                <div class="driver-title">
                  <span class="team-dot" style="background-color: ${entry.carColor}"></span>
                  <span>${entry.driverName}</span>
                  ${isSelected ? '<span style="color:var(--f1-cyan); font-size:10px; margin-left:4px;">🎯</span>' : ''}
                </div>
                <div class="driver-stats-row">
                  <span class="avg-speed-badge">Śr: ${entry.avgSpeed} km/h</span>
                  <span>Vmax: ${entry.topSpeed} km/h</span>
                  <span>⛽ ${entry.fuelRemaining} kg</span>
                  ${car && car.pitStopsCount > 0 ? `<span style="color:#ffd700">🛑 ${car.pitStopsCount} PIT</span>` : ''}
                  ${this.latestRaceState !== 'IDLE' && car ? `<span>🏁 L${car.raceLapsCompleted}/${this.latestRaceTotalLaps}</span>` : (car && car.currentLap > 0 ? `<span>🏁 L${car.currentLap}</span>` : '')}
                  ${car && !car.isAlive && this.latestRaceState !== 'IDLE' ? '<span style="color:#ff5252; font-weight:700;">💥 DNF (ROZBITY)</span>' : ''}
                  ${car ? `<span>🛑 ${Math.round(car.brakingAggression * 100)}%</span>` : ''}
                </div>
              </div>
            </div>
            <div class="time-details">
              <div class="time-row-best">
                <span class="time-lbl">BEST</span>
                <span class="time-main">${bestTimeStr}</span>
                <span class="time-lbl" style="margin-left: 8px;">LAST</span>
                <span class="time-last-val">${lastTimeStr}</span>
                ${deltaStr ? `<span class="time-delta">${deltaStr}</span>` : ''}
              </div>
              <div class="time-row-curr">
                <span class="time-lbl">TERAZ</span>
                <span class="time-curr-val">${currentTimeStr}</span>
                ${cpBadgeHtml}
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    // Telemetry panel
    if (activeCar) {
      const speedKmh = Math.round(activeCar.speedKmh);
      document.getElementById('tele-speed')!.textContent = speedKmh.toString();

      let gear = '1';
      if (speedKmh < 10) gear = 'N';
      else if (speedKmh < 68) gear = '1';
      else if (speedKmh < 112) gear = '2';
      else if (speedKmh < 158) gear = '3';
      else if (speedKmh < 204) gear = '4';
      else if (speedKmh < 248) gear = '5';
      else if (speedKmh < 288) gear = '6';
      else if (speedKmh < 322) gear = '7';
      else gear = '8';
      document.getElementById('tele-gear')!.textContent = gear;

      // Fuel & Mass telemetry
      document.getElementById('tele-fuel')!.textContent = `${activeCar.fuelKg.toFixed(1)} kg`;
      const fuelPct = Math.min(100, Math.max(0, (activeCar.fuelKg / Car.MAX_FUEL_CAPACITY) * 100));
      document.getElementById('gauge-fuel')!.style.width = `${Math.round(fuelPct)}%`;
      document.getElementById('tele-mass')!.textContent = `${Math.round(activeCar.totalMass)} kg`;

      let ctrl: CarControl;
      if (activeCar.isManual || activeCar === this.playerCar) {
        ctrl = this.getPlayerControl();
      } else {
        ctrl = activeCar.getAIControl(this.track, this.population.leaderCheckpointSpeeds);
      }

      document.getElementById('gauge-throttle')!.style.width = `${Math.round(ctrl.throttle * 100)}%`;
      document.getElementById('gauge-brake')!.style.width = `${Math.round(ctrl.brake * 100)}%`;
      const teleBrakeAgg = document.getElementById('tele-brake-agg');
      if (teleBrakeAgg) {
        teleBrakeAgg.textContent = `(Styl: ${Math.round(activeCar.brakingAggression * 100)}%)`;
      }
      this.renderer.renderGMeter(activeCar, this.gMeterCanvas);
      const totalG = Math.hypot(activeCar.lateralG, activeCar.longitudinalG);
      document.getElementById('tele-g-total')!.textContent = `${totalG.toFixed(1)} G`;
      const frontPct = Math.round(activeCar.weightFrontRatio * 100);
      const rearPct = 100 - frontPct;
      document.getElementById('gauge-weight')!.style.width = `${frontPct}%`;
      document.getElementById('tele-weight-ratio')!.textContent = `${frontPct}% / ${rearPct}%`;

      document.getElementById('tele-lap-time')!.textContent = this.formatLapTime(activeCar.lapTime);
      const teleBestLap = document.getElementById('tele-best-lap-time');
      if (teleBestLap) {
        const standing = this.latestStandings?.find(s => s.carColor === activeCar.color);
        const bestTime = this.getDriverTrueBest(activeCar.color, standing?.lapTime, standing?.hasFinishedLap);
        teleBestLap.textContent = bestTime ? this.formatLapTime(bestTime) : '--:--.---';
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
          timeEl.textContent = this.formatLapTime(currSplit);
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
          timeEl.textContent = bestSplit ? this.formatLapTime(bestSplit) : '--:--.---';
          deltaEl.textContent = bestSplit ? 'PB' : '--';
          deltaEl.className = 'sec-delta';
          if (boxEl) boxEl.style.borderColor = '#232932';
        }
      }

      if (activeCar.brain) {
        this.renderer.renderBrain(activeCar.brain, this.brainCanvas);
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
      bestTag.textContent = `REKORD: ${this.formatLapTime(this.population.globalBestLap)}`;
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

  private formatLapTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  }
}

// Boot application
window.addEventListener('DOMContentLoaded', () => {
  new App();
});
