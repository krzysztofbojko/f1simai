import { normalizePressure } from './DriverPressure';
import { Population, TeamRecord } from './Population';
import { Car } from '../physics/Car';
import { Track } from '../track/Track';
import { TrackPoint } from '../math/Spline';
import { Vector2 } from '../math/Vector2';

/** Track geometry as plain data; `deserializeTrack` rebuilds the identical track in another worker. */
export interface SerializedTrack {
  width: number;
  points: { center: [number, number]; left: [number, number]; right: [number, number]; tangent: [number, number]; normal: [number, number]; curvature: number }[];
}

export function serializeTrack(track: Track): SerializedTrack {
  const xy = (v: Vector2): [number, number] => [v.x, v.y];
  return {
    width: track.width,
    points: track.points.map(p => ({ center: xy(p.center), left: xy(p.left), right: xy(p.right), tangent: xy(p.tangent), normal: xy(p.normal), curvature: p.curvature })),
  };
}

export function deserializeTrack(data: SerializedTrack): Track {
  const v = ([x, y]: [number, number]) => new Vector2(x, y);
  const points: TrackPoint[] = data.points.map(p => ({ center: v(p.center), left: v(p.left), right: v(p.right), tangent: v(p.tangent), normal: v(p.normal), curvature: p.curvature }));
  return new Track(points, data.width);
}

/** One driver's learned state, in the `F1_ALL_MODELS` file format. */
export function exportDriver(population: Population, index: number): any {
  const car = population.cars[index];
  const record = population.teamRecords[index];
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
    lastLapTime: record?.lastLapTime ?? car.lastLapTime,
    pace: car.pace.toJSON(),
    ers: Math.round(car.ersEnergy),
    tyres: { tempFront: car.tyreTempFront, tempRear: car.tyreTempRear, wearFront: car.tyreWearFront, wearRear: car.tyreWearRear },
    lineNet: car.lineNet ? car.lineNet.toJSON() : null,
    lapsCount: record?.lapsCount ?? 0,
    avgSpeed: record?.avgSpeed ?? 0,
    topSpeed: record?.topSpeed ?? 0,
    baseBrakingAggression: car.baseBrakingAggression,
    brakingAggression: car.brakingAggression,
  };
}

/**
 * Restore a driver from exported data. `live` keeps the car's physical state
 * (ERS, tyres) and its session counters: the car is on track and keeps driving.
 */
export function applyDriverModel(car: Car, record: TeamRecord | undefined, driverData: any, live = false): void {
  if (driverData.brain && car.brain) {
    car.brain.fromJSON(JSON.stringify(driverData.brain));
    car.safeBrainBackup = car.brain.clone();
  }
  if (driverData.bestBrain && record) {
    if (!record.bestBrain && car.brain) {
      record.bestBrain = car.brain.clone();
    }
    record.bestBrain?.fromJSON(JSON.stringify(driverData.bestBrain));
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
  if (typeof driverData.bestFitness === 'number' && record) {
    record.bestFitness = driverData.bestFitness;
  }
  if (driverData.pace) car.pace.fromJSON(driverData.pace);
  if (!live && typeof driverData.ers === 'number') car.ersEnergy = Math.max(0, Math.min(Car.ERS_CAPACITY, driverData.ers));
  if (!live && driverData.tyres) {
    const t = driverData.tyres, num = (v: unknown, d: number) => typeof v === 'number' && Number.isFinite(v) ? v : d;
    car.tyreTempFront = num(t.tempFront, 85); car.tyreTempRear = num(t.tempRear, 85);
    car.tyreWearFront = Math.max(0, Math.min(1, num(t.wearFront, 0))); car.tyreWearRear = Math.max(0, Math.min(1, num(t.wearRear, 0)));
  }
  if (driverData.lineNet && car.lineNet) car.lineNet.fromJSON(driverData.lineNet);
  // Classification columns: keep the last lap, lap count and speeds with the best time.
  if (!live && typeof driverData.lastLapTime === 'number' && driverData.lastLapTime > 0) {
    car.lastLapTime = driverData.lastLapTime;
    if (record) record.lastLapTime = driverData.lastLapTime;
  }
  if (!live && record && typeof driverData.lapsCount === 'number') record.lapsCount = driverData.lapsCount;
  if (record && typeof driverData.avgSpeed === 'number') record.avgSpeed = driverData.avgSpeed;
  if (record && typeof driverData.topSpeed === 'number') record.topSpeed = driverData.topSpeed;
}

/**
 * Island migration: a driver takes another population's model only for a strictly
 * faster clean lap at the same driver pressure and with the same network inputs.
 * The lap in progress is flagged, so a mixed lap never evaluates either model.
 * Returns the number of drivers that changed.
 */
export function mergeBetterDrivers(population: Population, drivers: any[]): number {
  let adopted = 0;
  for (let i = 0; i < population.cars.length; i++) {
    const car = population.cars[i], record = population.teamRecords[i];
    const data = drivers.find(d => d?.color === car.color);
    if (!data || typeof data.bestLapTime !== 'number' || !(data.bestLapTime > 0) || !data.bestBrain) continue;
    const own = record?.bestLapTime ?? car.bestLapTime;
    if (own !== null && own !== undefined && own > 0 && data.bestLapTime >= own - 1e-3) continue;
    if (normalizePressure(data.bestLapPressure ?? 0) !== car.driverPressure) continue;
    if (!car.brain || !Array.isArray(data.bestBrain.layerSizes) || data.bestBrain.layerSizes.join() !== car.brain.layerSizes.join()) continue;
    if (car.isManual || car.isRaceMode) continue;
    // The proven network drives from now on, not the island's current mutation.
    applyDriverModel(car, record, { ...data, brain: data.bestBrain }, true);
    car.lapCompromised = true;
    car.replayBuffer = [];
    car.replayStepTimer = 0;
    if (population.globalBestLap === null || data.bestLapTime < population.globalBestLap) population.globalBestLap = data.bestLapTime;
    adopted++;
  }
  return adopted;
}
