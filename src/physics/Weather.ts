/**
 * Weather of a session: cloud cover (sun), rain, air and track temperature, the water on the
 * track and the wind with its gusts. A scenario sets the forecast; the state then evolves with
 * simulated time from a seeded random stream, so a seed always replays the same weather.
 * `sunny` is the calibrated reference: 25 °C air, 38 °C track, dry and still, exactly the
 * conditions the physics was tuned in.
 */
export type WeatherScenario = 'sunny' | 'hot' | 'cloudy' | 'windy' | 'shower' | 'rain' | 'storm' | 'changeable';

export const WEATHER_SCENARIOS: readonly WeatherScenario[] = ['sunny', 'hot', 'cloudy', 'windy', 'shower', 'rain', 'storm', 'changeable'];

export interface WeatherState {
  /** Cloud cover 0 clear .. 1 overcast; the sun heats the track through the gaps. */
  cloud: number;
  /** Rain intensity 0 none .. 1 downpour. */
  rain: number;
  airTemp: number;
  trackTemp: number;
  /** Water on the racing surface, 0 dry .. 1 soaked. */
  wetness: number;
  /** Mean wind speed (m/s) and the direction it blows towards (radians, world frame). */
  windSpeed: number;
  windDir: number;
  /** Gust multiplier on the mean wind (1 = steady). */
  gust: number;
  /** Wind velocity right now (m/s, world frame): speed x gust along the direction. */
  windX: number;
  windY: number;
}

interface ScenarioSpec {
  label: string;
  airTemp: number;
  /** Sun strength: 1 heats a clear track 13 °C above the air. */
  sun: number;
  /** Mean cloud cover and its random drift (sigma, time constant in seconds). */
  cloud: number;
  cloudSigma: number;
  cloudTau: number;
  /** Cloud cover above which it rains, and the rain at full cover. */
  rainThreshold: number;
  rainScale: number;
  wind: number;
  /** Gust spread (sigma of the multiplier). */
  gustSigma: number;
  /** Water on the track at the start of the session. */
  startWetness: number;
  /** One shower in the session: clouds build, it rains, then the sun returns. */
  shower?: boolean;
}

export const SCENARIO_SPECS: Record<WeatherScenario, ScenarioSpec> = {
  sunny:      { label: 'Słonecznie, stabilnie', airTemp: 25, sun: 1,   cloud: 0,    cloudSigma: 0,    cloudTau: 300, rainThreshold: 2,    rainScale: 0,   wind: 0,  gustSigma: 0,    startWetness: 0 },
  hot:        { label: 'Upał',                  airTemp: 34, sun: 1.6, cloud: 0,    cloudSigma: 0.04, cloudTau: 300, rainThreshold: 2,    rainScale: 0,   wind: 2,  gustSigma: 0.15, startWetness: 0 },
  cloudy:     { label: 'Pochmurno, chłodno',    airTemp: 17, sun: 1,   cloud: 0.8,  cloudSigma: 0.08, cloudTau: 240, rainThreshold: 2,    rainScale: 0,   wind: 3,  gustSigma: 0.2,  startWetness: 0 },
  windy:      { label: 'Silny wiatr',           airTemp: 21, sun: 1,   cloud: 0.35, cloudSigma: 0.1,  cloudTau: 180, rainThreshold: 2,    rainScale: 0,   wind: 11, gustSigma: 0.35, startWetness: 0 },
  shower:     { label: 'Przelotny deszcz',      airTemp: 21, sun: 1,   cloud: 0.3,  cloudSigma: 0.05, cloudTau: 60,  rainThreshold: 0.7,  rainScale: 1,   wind: 5,  gustSigma: 0.3,  startWetness: 0, shower: true },
  rain:       { label: 'Deszcz',                airTemp: 16, sun: 1,   cloud: 0.9,  cloudSigma: 0.04, cloudTau: 120, rainThreshold: 0.6,  rainScale: 0.8, wind: 5,  gustSigma: 0.25, startWetness: 0.75 },
  storm:      { label: 'Burza, ulewa',          airTemp: 15, sun: 1,   cloud: 0.98, cloudSigma: 0.02, cloudTau: 120, rainThreshold: 0.5,  rainScale: 1,   wind: 13, gustSigma: 0.45, startWetness: 1 },
  changeable: { label: 'Zmienna',               airTemp: 19, sun: 1,   cloud: 0.55, cloudSigma: 0.25, cloudTau: 150, rainThreshold: 0.72, rainScale: 1,   wind: 6,  gustSigma: 0.3,  startWetness: 0 },
};

export function isWeatherScenario(value: unknown): value is WeatherScenario {
  return typeof value === 'string' && (WEATHER_SCENARIOS as readonly string[]).includes(value);
}

/** Track temperature the sun, the air and the water settle towards. */
export function equilibriumTrackTemp(airTemp: number, sun: number, cloud: number, wetness: number, rain: number): number {
  return airTemp + 13 * sun * (1 - cloud) * (1 - 0.8 * wetness) - 2 * rain;
}

export function neutralWeather(): WeatherState {
  return { cloud: 0, rain: 0, airTemp: 25, trackTemp: 38, wetness: 0, windSpeed: 0, windDir: 0, gust: 1, windX: 0, windY: 0 };
}

/** Track-condition classes the training compares laps within. */
export type TrackConditions = 'dry' | 'damp' | 'wet';

/** Wetness band of each class, overlapping so a lap near a boundary still belongs to the class the session is in. */
export const CONDITION_BANDS: Record<TrackConditions, [number, number]> = { dry: [0, 0.2], damp: [0.1, 0.65], wet: [0.55, 1] };

/** Class of a wetness without hysteresis. */
export function conditionsOf(wetness: number): TrackConditions {
  return wetness < 0.15 ? 'dry' : wetness < 0.6 ? 'damp' : 'wet';
}

/** Time constants (s): track temperature, air temperature, gusts, wind direction drift. */
const TRACK_TAU = 240, AIR_TAU = 300, GUST_TAU = 3, DIR_TAU = 60, DIR_SIGMA = 0.25;
/** Rain soaks the track at this rate (1/s at full rain); the sun and a warm track dry it. */
const SOAK_RATE = 1 / 60, DRY_RATE = 1 / 520;

export class Weather {
  readonly state: WeatherState = neutralWeather();
  scenario: WeatherScenario = 'sunny';
  /** Session class with hysteresis, so it does not flicker around a threshold. */
  conditions: TrackConditions = 'dry';
  private seed = 1;
  private time = 0;
  private meanDir = 0;
  private showerStart = Infinity;
  private showerEnd = Infinity;

  constructor(scenario: WeatherScenario = 'sunny', seed = 1) { this.reset(scenario, seed); }

  get label(): string { return SCENARIO_SPECS[this.scenario].label; }

  /** Starts the forecast again: the session's first conditions, a new wind direction and shower. */
  reset(scenario: WeatherScenario, seed: number): void {
    const spec = SCENARIO_SPECS[scenario];
    this.scenario = scenario;
    this.seed = (seed >>> 0) || 1;
    this.time = 0;
    this.meanDir = this.next() * Math.PI * 2;
    this.showerStart = spec.shower ? 180 + this.next() * 300 : Infinity;
    this.showerEnd = this.showerStart + 240 + this.next() * 240;
    const s = this.state;
    s.cloud = spec.cloud;
    s.rain = this.rainFrom(s.cloud);
    s.airTemp = spec.airTemp - 4 * s.rain;
    s.wetness = spec.startWetness;
    s.trackTemp = equilibriumTrackTemp(s.airTemp, spec.sun, s.cloud, s.wetness, s.rain);
    s.windSpeed = spec.wind;
    s.windDir = this.meanDir;
    s.gust = 1;
    this.updateWind();
    this.conditions = conditionsOf(s.wetness);
  }

  /** Advances the weather by `dt` simulated seconds. */
  step(dt: number): void {
    const spec = SCENARIO_SPECS[this.scenario];
    const s = this.state;
    this.time += dt;
    // Clouds: a mean-reverting drift; a shower builds the cover up and then clears the sky.
    let target = spec.cloud, tau = spec.cloudTau;
    if (this.time >= this.showerStart) target = this.time < this.showerEnd ? 0.95 : 0.15;
    if (spec.cloudSigma > 0 || Math.abs(target - s.cloud) > 1e-9) {
      s.cloud += (target - s.cloud) * (dt / tau) + spec.cloudSigma * Math.sqrt(2 * dt / tau) * this.gauss();
      s.cloud = Math.max(0, Math.min(1, s.cloud));
    }
    s.rain = this.rainFrom(s.cloud);
    s.airTemp += (spec.airTemp - 4 * s.rain - s.airTemp) * (1 - Math.exp(-dt / AIR_TAU));
    // Water: rain soaks the track towards a level set by its intensity; sun and warmth dry it.
    if (s.rain > 0.02) {
      const soaked = Math.min(1, 0.35 + 0.75 * s.rain);
      if (s.wetness < soaked) s.wetness += (soaked - s.wetness) * SOAK_RATE * (0.5 + s.rain) * dt;
    }
    const evaporation = (0.3 + spec.sun * (1 - s.cloud)) * Math.max(0, (s.trackTemp - 5) / 30);
    s.wetness = Math.max(0, Math.min(1, s.wetness - DRY_RATE * evaporation * s.wetness * dt));
    if (s.wetness < 0.005 && s.rain <= 0.02) s.wetness = 0;
    const equilibrium = equilibriumTrackTemp(s.airTemp, spec.sun, s.cloud, s.wetness, s.rain);
    s.trackTemp += (equilibrium - s.trackTemp) * (1 - Math.exp(-dt / TRACK_TAU));
    // Wind: gusts around the mean and a slow swing of the direction.
    if (spec.gustSigma > 0) {
      s.gust += (1 - s.gust) * (dt / GUST_TAU) + spec.gustSigma * Math.sqrt(2 * dt / GUST_TAU) * this.gauss();
      s.gust = Math.max(0, Math.min(2.2, s.gust));
      s.windDir += (this.meanDir - s.windDir) * (dt / DIR_TAU) + DIR_SIGMA * Math.sqrt(2 * dt / DIR_TAU) * this.gauss();
    }
    this.updateWind();
    this.updateConditions();
  }

  private rainFrom(cloud: number): number {
    const spec = SCENARIO_SPECS[this.scenario];
    return cloud > spec.rainThreshold ? Math.min(1, spec.rainScale * (cloud - spec.rainThreshold) / (1 - spec.rainThreshold)) : 0;
  }

  private updateWind(): void {
    const s = this.state;
    s.windX = Math.cos(s.windDir) * s.windSpeed * s.gust;
    s.windY = Math.sin(s.windDir) * s.windSpeed * s.gust;
  }

  private updateConditions(): void {
    const w = this.state.wetness;
    if (this.conditions === 'dry' && w > 0.2) this.conditions = 'damp';
    else if (this.conditions === 'damp' && w < 0.1) this.conditions = 'dry';
    if (this.conditions === 'damp' && w > 0.65) this.conditions = 'wet';
    else if (this.conditions === 'wet' && w < 0.55) this.conditions = 'damp';
  }

  /** mulberry32: the weather's own stream, independent of the simulation's `random()`. */
  private next(): number {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private gauss(): number {
    return Math.sqrt(-2 * Math.log(1 - this.next())) * Math.cos(2 * Math.PI * this.next());
  }
}
