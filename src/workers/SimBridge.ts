import { loadDriverPressure } from '../ai/DriverPressure';
import type { SimSnapshot, ComputeProfile, ComputeProfileOptions, ComputeProfileConfig, TopologySpecifier, LearningReport, LearningLog } from './sim.worker';
import type { SupervisorMode } from '../ai/TrainingSupervisor';

export type { ComputeProfile, ComputeProfileOptions, ComputeProfileConfig, TopologySpecifier, LearningReport, LearningLog };

interface PendingRequest<T> {
  id: number;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SimBridge {
  private worker: Worker | null = null;
  public latestSnapshot: SimSnapshot | null = null;
  public cpuCores: number = 8;
  public isReady: boolean = false;
  public currentComputeProfile: ComputeProfile = 'balanced';
  public currentTopology: TopologySpecifier = 'Standard';
  private pendingBestBrain: PendingRequest<{ json: string; generation: number }>[] = [];
  private pendingLoadBrain: PendingRequest<boolean>[] = [];
  private pendingAllModels: PendingRequest<any>[] = [];
  private pendingLoadAllModels: PendingRequest<boolean>[] = [];
  private pendingClearLearning: PendingRequest<boolean>[] = [];
  private pendingLearningStats: PendingRequest<LearningReport>[] = [];
  private pendingLearningLog: PendingRequest<LearningLog>[] = [];
  private nextRequestId = 1;
  public onTrackError?: (message: string) => void;
  /** The worker could not start or has failed: the simulation cannot run in this page. */
  public unavailable = false;
  public onUnavailable?: () => void;
  public onSnapshotCallback?: (snapshot: SimSnapshot) => void;

  constructor() {
    this.cpuCores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 8) : 8;
    this.initWorker();
  }

  private request<T>(
    queue: PendingRequest<T>[],
    message: unknown,
    timeoutMs: number = 5000
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('SimWorker is not available'));
        return;
      }
      const timer = setTimeout(() => {
        const index = queue.findIndex(item => item.resolve === resolve);
        if (index >= 0) queue.splice(index, 1);
        reject(new Error('SimWorker request timed out'));
      }, timeoutMs);
      const id = this.nextRequestId++;
      queue.push({ id, resolve, reject, timer });
      try {
        this.worker.postMessage({ ...(message as object), requestId: id });
      } catch (error) {
        const index = queue.findIndex(item => item.id === id);
        if (index >= 0) queue.splice(index, 1);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private resolveNext<T>(queue: PendingRequest<T>[], value: T, requestId?: number): void {
    const index = typeof requestId === 'number' ? queue.findIndex(item => item.id === requestId) : 0;
    const pending = index >= 0 ? queue.splice(index, 1)[0] : undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.resolve(value);
  }

  private rejectPending(reason: unknown): void {
    const error = reason instanceof Error ? reason : new Error('SimWorker error');
    const queues = [this.pendingBestBrain, this.pendingLoadBrain, this.pendingAllModels, this.pendingLoadAllModels, this.pendingClearLearning, this.pendingLearningStats, this.pendingLearningLog];
    for (const queue of queues) {
      while (queue.length) {
        const pending = queue.shift()!;
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    }
  }

  private initWorker(): void {
    try {
      this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });

      this.worker.onmessage = (e: MessageEvent) => {
        const data = e.data;
        if (!data) return;

        switch (data.type) {
          case 'READY':
            this.isReady = true;
            if (data.cpuCores) this.cpuCores = data.cpuCores;
            if (data.computeProfile) this.currentComputeProfile = data.computeProfile;
            if (data.topology) this.currentTopology = data.topology;
            break;

          case 'SNAPSHOT':
            this.latestSnapshot = data.snapshot;
            if (data.snapshot?.computeProfile) {
              this.currentComputeProfile = data.snapshot.computeProfile;
            }
            if (data.snapshot?.topology) {
              this.currentTopology = data.snapshot.topology;
            }
            if (this.onSnapshotCallback) {
              this.onSnapshotCallback(data.snapshot);
            }
            break;

          case 'TRACK_ERROR':
            this.onTrackError?.(data.message || 'Niepoprawna geometria toru.');
            break;

          case 'BEST_BRAIN_RESULT':
            this.resolveNext(this.pendingBestBrain, { json: data.json ?? '', generation: data.generation ?? 0 }, data.requestId);
            break;

          case 'LOAD_BRAIN_SUCCESS':
            this.resolveNext(this.pendingLoadBrain, true, data.requestId);
            break;

          case 'LOAD_BRAIN_ERROR':
            this.resolveNext(this.pendingLoadBrain, false, data.requestId);
            break;

          case 'ALL_MODELS_RESULT':
            this.resolveNext(this.pendingAllModels, data.data, data.requestId);
            break;

          case 'LOAD_ALL_MODELS_SUCCESS':
            this.resolveNext(this.pendingLoadAllModels, true, data.requestId);
            break;

          case 'LOAD_ALL_MODELS_ERROR':
            this.resolveNext(this.pendingLoadAllModels, false, data.requestId);
            break;

          case 'LEARNING_STATS_RESULT':
            this.resolveNext(this.pendingLearningStats, data.report, data.requestId);
            break;

          case 'LEARNING_LOG_RESULT':
            this.resolveNext(this.pendingLearningLog, data.log, data.requestId);
            break;

          case 'CLEAR_LEARNING_DONE':
            this.resolveNext(this.pendingClearLearning, true, data.requestId);
            break;
        }
      };

      this.worker.onerror = (err) => {
        console.error('SimWorker encountered an error:', err);
        this.worker = null;
        this.isReady = false;
        this.rejectPending(err);
        this.markUnavailable();
      };

      this.worker.postMessage({ type: 'INIT', profile: this.currentComputeProfile, topology: this.currentTopology, driverPressure: loadDriverPressure() });
    } catch (err) {
      console.warn('Web Worker could not be started in current environment:', err);
      this.worker = null;
      this.isReady = false;
      this.rejectPending(err);
      this.markUnavailable();
    }
  }

  private markUnavailable(): void {
    this.unavailable = true;
    this.onUnavailable?.();
  }

  public setComputeProfile(profile: ComputeProfile, options?: ComputeProfileOptions): void {
    this.currentComputeProfile = profile;
    this.worker?.postMessage({ type: 'SET_COMPUTE_PROFILE', profile, options });
  }

  public getComputeProfile(): ComputeProfile {
    return this.currentComputeProfile;
  }

  public setTopology(topology: TopologySpecifier): void {
    this.currentTopology = topology;
    this.worker?.postMessage({ type: 'SET_TOPOLOGY', topology });
  }

  public getTopology(): TopologySpecifier {
    return this.currentTopology;
  }

  /** Extra workers training independent fields; faster driver models flow back to the main field. */
  public setIslands(count: number): void {
    this.worker?.postMessage({ type: 'SET_ISLANDS', count });
  }

  public setPaused(isPaused: boolean): void {
    this.worker?.postMessage({ type: 'SET_PAUSED', isPaused });
  }

  public setSpeed(speed: number | 'max'): void {
    this.worker?.postMessage({ type: 'SET_SPEED', speed });
  }

  public setTrackWidth(trackWidth: number, points?: { x: number; y: number }[], keepOrder = false, pointGap?: number): void {
    this.worker?.postMessage({ type: 'SET_TRACK_WIDTH', trackWidth, points, keepOrder, pointGap });
  }

  public setPreset(preset: 'gp' | 'oval'): void {
    this.worker?.postMessage({ type: 'SET_PRESET', preset });
  }

  /** `keepOrder`: the points' order is the driving direction (imported real circuits). */
  /** `pitLaneLoss`: seconds a pass through this circuit's pit lane costs (omitted: the default). */
  /** `pointGap`: see `Spline.generateClosedTrack` (omitted: drawn-track gap). */
  public setCustomTrack(points: { x: number; y: number }[], trackWidth?: number, keepOrder = false, pitLaneLoss?: number, pointGap?: number): void {
    this.worker?.postMessage({ type: 'SET_CUSTOM_TRACK', points, trackWidth, keepOrder, pitLaneLoss, pointGap });
  }

  public setDriverPressure(value: number): void {
    this.worker?.postMessage({type: 'SET_DRIVER_PRESSURE', value});
  }

  /** Weather forecast (see `Weather.ts`); applies at once and to every following session. */
  public setWeather(scenario: string, seed?: number): void {
    this.worker?.postMessage({ type: 'SET_WEATHER', scenario, seed });
  }

  /** The player's tyre compound. */
  public setTyres(settings: { compound?: string }): void {
    this.worker?.postMessage({ type: 'SET_TYRES', ...settings });
  }

  public setMutation(value: number): void {
    this.worker?.postMessage({ type: 'SET_MUTATION', value });
  }

  /** Training supervisor: act on learning symptoms by itself ('auto') or only suggest ('suggest'). */
  public setSupervisorMode(mode: SupervisorMode): void {
    this.worker?.postMessage({ type: 'SET_SUPERVISOR_MODE', mode });
  }

  /** Applies a waiting supervisor suggestion; resolves with the fresh learning report. */
  public applySupervisorAction(id: number): Promise<LearningReport> {
    return this.request(this.pendingLearningStats, { type: 'APPLY_SUPERVISOR_ACTION', id });
  }

  public setFuel(value: number): void {
    this.worker?.postMessage({ type: 'SET_FUEL', value });
  }

  /** Share of training laps driven as stress laps (0..0.6). */
  public setStressLaps(value: number): void {
    this.worker?.postMessage({ type: 'SET_STRESS_LAPS', value });
  }

  public setLidarCount(value: number): void {
    this.worker?.postMessage({ type: 'SET_LIDAR_COUNT', value });
  }

  public resetPopulation(): void {
    this.worker?.postMessage({ type: 'RESET_POPULATION' });
  }

  public evolvePopulation(): void {
    this.worker?.postMessage({ type: 'EVOLVE_POPULATION' });
  }

  public resetCarPositions(): void {
    this.worker?.postMessage({ type: 'RESET_CAR_POSITIONS' });
  }

  public refuel(): void {
    this.worker?.postMessage({ type: 'REFUEL' });
  }

  public resetSingleBrain(carColor: string): void {
    this.worker?.postMessage({ type: 'RESET_SINGLE_BRAIN', carColor });
  }

  public setActiveCarColor(carColor: string | null): void {
    this.worker?.postMessage({ type: 'SET_ACTIVE_CAR_COLOR', carColor });
  }

  public sendPlayerInput(control: { steer: number; throttle: number; brake: number }): void {
    this.worker?.postMessage({ type: 'PLAYER_INPUT', control });
  }

  public setPlayerDriving(active: boolean, carColor?: string | null): void {
    this.worker?.postMessage({ type: 'SET_PLAYER_DRIVING', active, carColor });
  }

  public getBestBrain(): Promise<{ json: string; generation: number }> {
    return this.request(this.pendingBestBrain, { type: 'GET_BEST_BRAIN' });
  }

  public loadBrain(json: string): Promise<boolean> {
    return this.request(this.pendingLoadBrain, { type: 'LOAD_BRAIN', json });
  }

  public getAllModels(): Promise<any> {
    return this.request(this.pendingAllModels, { type: 'GET_ALL_MODELS' });
  }

  public loadAllModels(models: any): Promise<boolean> {
    return this.request(this.pendingLoadAllModels, { type: 'LOAD_ALL_MODELS', models });
  }

  /** Learning diagnostics: generation history, trends, drivers and the champion network. */
  public getLearningStats(): Promise<LearningReport> {
    return this.request(this.pendingLearningStats, { type: 'GET_LEARNING_STATS' });
  }

  /** The whole learning session (every generation since learning started) for download. */
  public getLearningLog(): Promise<LearningLog> {
    return this.request(this.pendingLearningLog, { type: 'GET_LEARNING_LOG' }, 30000);
  }

  /** Clean slate: every driver forgets what it learned (networks, lines, pace, records, generations). */
  public clearLearning(): Promise<boolean> {
    return this.request(this.pendingClearLearning, { type: 'CLEAR_LEARNING' }, 30000);
  }

  /** `withQualifying` runs Q1–Q3 first; `useQualifyingGrid` lines the race up in qualifying order. */
  public startRace(totalLaps: number, options: { withQualifying?: boolean; useQualifyingGrid?: boolean } = {}): void {
    this.worker?.postMessage({ type: 'START_RACE', totalLaps, ...options });
  }

  public stopRace(): void {
    this.worker?.postMessage({ type: 'STOP_RACE' });
  }

  public togglePlayerPit(): void {
    this.worker?.postMessage({ type: 'TOGGLE_PLAYER_PIT' });
  }

  public resetBestTimes(): void {
    this.worker?.postMessage({ type: 'RESET_BEST_TIMES' });
  }
}
