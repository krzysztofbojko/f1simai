import type { SimSnapshot } from './sim.worker';

export class SimBridge {
  private worker: Worker | null = null;
  public latestSnapshot: SimSnapshot | null = null;
  public cpuCores: number = 8;
  public isReady: boolean = false;
  private bestBrainResolve: ((val: { json: string; generation: number }) => void) | null = null;
  private loadBrainResolve: ((val: boolean) => void) | null = null;
  private allModelsResolve: ((val: any) => void) | null = null;
  private loadAllModelsResolve: ((val: boolean) => void) | null = null;
  public onSnapshotCallback?: (snapshot: SimSnapshot) => void;

  constructor() {
    this.cpuCores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 8) : 8;
    this.initWorker();
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
            break;

          case 'SNAPSHOT':
            this.latestSnapshot = data.snapshot;
            if (this.onSnapshotCallback) {
              this.onSnapshotCallback(data.snapshot);
            }
            break;

          case 'BEST_BRAIN_RESULT':
            if (this.bestBrainResolve) {
              this.bestBrainResolve({ json: data.json, generation: data.generation });
              this.bestBrainResolve = null;
            }
            break;

          case 'LOAD_BRAIN_SUCCESS':
            if (this.loadBrainResolve) {
              this.loadBrainResolve(true);
              this.loadBrainResolve = null;
            }
            break;

          case 'LOAD_BRAIN_ERROR':
            if (this.loadBrainResolve) {
              this.loadBrainResolve(false);
              this.loadBrainResolve = null;
            }
            break;

          case 'ALL_MODELS_RESULT':
            if (this.allModelsResolve) {
              this.allModelsResolve(data.data);
              this.allModelsResolve = null;
            }
            break;

          case 'LOAD_ALL_MODELS_SUCCESS':
            if (this.loadAllModelsResolve) {
              this.loadAllModelsResolve(true);
              this.loadAllModelsResolve = null;
            }
            break;

          case 'LOAD_ALL_MODELS_ERROR':
            if (this.loadAllModelsResolve) {
              this.loadAllModelsResolve(false);
              this.loadAllModelsResolve = null;
            }
            break;
        }
      };

      this.worker.onerror = (err) => {
        console.error('SimWorker encountered an error:', err);
      };

      this.worker.postMessage({ type: 'INIT' });
    } catch (err) {
      console.warn('Web Worker could not be started in current environment:', err);
      this.worker = null;
      this.isReady = false;
    }
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
    return new Promise((resolve) => {
      this.bestBrainResolve = resolve;
      this.worker?.postMessage({ type: 'GET_BEST_BRAIN' });
    });
  }

  public loadBrain(json: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.loadBrainResolve = resolve;
      this.worker?.postMessage({ type: 'LOAD_BRAIN', json });
    });
  }

  public getAllModels(): Promise<any> {
    return new Promise((resolve) => {
      this.allModelsResolve = resolve;
      this.worker?.postMessage({ type: 'GET_ALL_MODELS' });
    });
  }

  public loadAllModels(models: any): Promise<boolean> {
    return new Promise((resolve) => {
      this.loadAllModelsResolve = resolve;
      this.worker?.postMessage({ type: 'LOAD_ALL_MODELS', models });
    });
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
