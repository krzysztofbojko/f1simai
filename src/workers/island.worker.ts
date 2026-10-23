// Training island: an independent headless population on the main worker's track.
// It trains at full speed and periodically exchanges faster driver models with the main worker.
import { Population } from '../ai/Population';
import { TopologySpecifier } from '../ai/NeuralNetwork';
import { normalizePressure } from '../ai/DriverPressure';
import { SerializedTrack, deserializeTrack, exportDriver, mergeBetterDrivers } from '../ai/Islands';
import { Track } from '../track/Track';
import { Car } from '../physics/Car';
import { clampStressShare } from '../physics/SimConfig';
import { Weather, isWeatherScenario } from '../physics/Weather';

export interface IslandSetup {
  type: 'SETUP';
  version: number;
  track: SerializedTrack;
  rayCount: number;
  topology: TopologySpecifier;
  driverPressure: number;
  mutationRate: number;
  startingFuelKg: number;
  stressLapShare: number;
  drivers: any[];
  weatherScenario: string;
  weatherSeed: number;
}

/** Simulated seconds between model exchanges with the main worker. */
const EXCHANGE_SECONDS = 30;
const DT = 1 / 60;
/** Each slice yields to the message queue, so pause and new tracks apply promptly. */
const SLICE_MS = 50;

let track: Track | null = null;
let population: Population | null = null;
let version = -1;
let running = false;
let sinceExchange = 0;
let steps = 0;
let busyMs = 0;
/** The island's own weather: the main field's forecast, its own seed. */
const weather = new Weather();
Car.config.weather = weather.state;

function slice(): void {
  if (!running || !population || !track) return;
  const start = performance.now();
  while (performance.now() - start < SLICE_MS) {
    for (let i = 0; i < 20; i++) {
      weather.step(DT);
      population.setConditions(weather.conditions);
      population.update(DT, track);
    }
    steps += 20;
    sinceExchange += 20 * DT;
  }
  busyMs += performance.now() - start;
  if (sinceExchange >= EXCHANGE_SECONDS) {
    sinceExchange = 0;
    self.postMessage({
      type: 'MODELS', version, steps, busyMs,
      drivers: population.cars.map((_, i) => exportDriver(population!, i)),
    });
    steps = 0; busyMs = 0;
  }
  setTimeout(slice, 0);
}

self.onmessage = (e: MessageEvent) => {
  const data = e.data;
  if (!data) return;
  switch (data.type) {
    case 'SETUP': {
      const setup = data as IslandSetup;
      track = deserializeTrack(setup.track);
      population = Population.create(track, { rayCount: setup.rayCount, topology: setup.topology,
        driverPressure: setup.driverPressure, mutationRate: setup.mutationRate, startingFuelKg: setup.startingFuelKg });
      Car.config.stressLapShare = clampStressShare(setup.stressLapShare);
      weather.reset(isWeatherScenario(setup.weatherScenario) ? setup.weatherScenario : 'sunny', setup.weatherSeed);
      population.setConditions(weather.conditions);
      // Start from the main field's best models; the island's own seeds diverge from there.
      mergeBetterDrivers(population, setup.drivers, Infinity);
      version = setup.version;
      sinceExchange = 0; steps = 0; busyMs = 0;
      break;
    }
    case 'CONFIG': {
      if (!population) break;
      population.setDriverPressure(normalizePressure(data.driverPressure));
      population.mutationRate = data.mutationRate;
      population.startingFuelKg = data.startingFuelKg;
      Car.config.stressLapShare = clampStressShare(data.stressLapShare);
      if (isWeatherScenario(data.weatherScenario) && data.weatherScenario !== weather.scenario) {
        weather.reset(data.weatherScenario, (Math.random() * 0x7fffffff) | 0);
        population.setConditions(weather.conditions);
      }
      break;
    }
    case 'MODELS': {
      if (population && data.version === version) mergeBetterDrivers(population, data.drivers);
      break;
    }
    case 'RUN': {
      const wasRunning = running;
      running = !!data.running;
      if (running && !wasRunning) setTimeout(slice, 0);
      break;
    }
  }
};
