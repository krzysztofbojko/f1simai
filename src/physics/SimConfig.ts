import { neutralWeather, type TrackConditions, type WeatherState } from './Weather';

export const DEFAULT_STRESS_LAP_SHARE = 0.25;
/** Stress-lap share from a setting: 0..0.6, anything invalid falls back to the default. */
export function clampStressShare(value: unknown): number {
  const v = Number(value);
  return Number.isFinite(v) ? Math.max(0, Math.min(0.6, v)) : DEFAULT_STRESS_LAP_SHARE;
}

/**
 * What every car of one simulation shares and the simulation sets: the weather it drives in, the
 * session's track-condition class and the share of stress laps. Each worker owns one
 * (`Car.config`); the physics only reads it. The page never writes it: it gets the weather in the
 * snapshot and hands it to the renderer.
 */
export interface SimConfig {
  /**
   * Weather every car drives in (see `Weather.ts`): air and track temperature, water on the
   * track, the wind. Set by the session each step; the neutral default is the reference weather.
   */
  weather: WeatherState;
  /** Track-condition class of the session; training laps outside its wetness band do not evaluate a brain. */
  conditions: TrackConditions;
  /**
   * Share of laps driven as stress laps (domain randomisation) in every session: wider grip and
   * power spread the planner does not know about, plus noisy, mis-calibrated LiDAR for the
   * network. The guardian's corrections on these laps teach robustness; in training the laps
   * never set a record or evaluate a model, so luckier conditions cannot win selection. In
   * qualifying and the race they are timed like any other lap.
   */
  stressLapShare: number;
}

export function createSimConfig(): SimConfig {
  return { weather: neutralWeather(), conditions: 'dry', stressLapShare: DEFAULT_STRESS_LAP_SHARE };
}
