import type { SimSnapshot, ComputeProfile, ComputeProfileOptions, ComputeProfileConfig, TopologySpecifier } from './sim.worker';

export type { ComputeProfile, ComputeProfileOptions, ComputeProfileConfig, TopologySpecifier };

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
  private nextRequestId = 1;
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
    const queues = [this.pendingBestBrain, this.pendingLoadBrain, this.pendingAllModels, this.pendingLoadAllModels];
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
        }
      };

      this.worker.onerror = (err) => {
        console.error('SimWorker encountered an error:', err);
        this.worker = null;
        this.isReady = false;
        this.rejectPending(err);
      };

      this.worker.postMessage({ type: 'INIT', profile: this.currentComputeProfile, topology: this.currentTopology });
    } catch (err) {
      console.warn('Web Worker could not be started in current environment:', err);
      this.worker = null;
      this.isReady = false;
      this.rejectPending(err);
    }
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

  public setPaused(isPaused: boolean): void {
    this.worker?.postMessage({ type: 'SET_PAUSED', isPaused });
  }

  public setSpeed(speed: number | 'max'): void {
    this.worker?.postMessage({ type: 'SET_SPEED', speed });
  }

  public setTrackWidth(trackWidth: number): void {
    this.worker?.postMessage({ type: 'SET_TRACK_WIDTH', trackWidth });
  }

  public setPreset(preset: 'gp' | 'oval'): void {
    this.worker?.postMessage({ type: 'SET_PRESET', preset });
  }

  public setCustomTrack(points: { x: number; y: number }[], trackWidth?: number): void {
    this.worker?.postMessage({ type: 'SET_CUSTOM_TRACK', points, trackWidth });
  }

  public setMutation(value: number): void {
    this.worker?.postMessage({ type: 'SET_MUTATION', value });
  }

  public setFuel(value: number): void {
    this.worker?.postMessage({ type: 'SET_FUEL', value });
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

  public startRace(totalLaps: number): void {
    this.worker?.postMessage({ type: 'START_RACE', totalLaps });
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
