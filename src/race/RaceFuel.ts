import { Car } from '../physics/Car';

/**
 * Race fuel shared by the race session and training: the laps times the fuel the field burns per
 * lap, plus this share and the reserve. There is no refuelling: a distance the tank cannot cover
 * is shortened to the laps it can.
 */
export const FUEL_MARGIN = 0.04;
export const FUEL_RESERVE_KG = 1.5;
/** Fuel per metre of lap before the field has completed a lap on the track (kg/m). */
export const FUEL_PER_METRE = 0.00035;
/** Race distance a training car's fuel load is drawn for (the default race length). */
export const TRAINING_RACE_LAPS = 50;
/** Lightest training load: a car near the end of a race. */
export const TRAINING_MIN_FUEL_KG = 5;

/** Race distance and starting fuel for `requestedLaps` at `perLapKg` (the field's average burn). */
export function planRaceFuel(perLapKg: number, requestedLaps: number): { totalLaps: number; fuelKg: number } {
  const perLap = perLapKg * (1 + FUEL_MARGIN);
  const reachable = Math.floor((Car.MAX_FUEL_CAPACITY - FUEL_RESERVE_KG) / perLap);
  const totalLaps = Math.max(1, Math.min(requestedLaps, reachable));
  return { totalLaps, fuelKg: Math.min(Car.MAX_FUEL_CAPACITY, totalLaps * perLap + FUEL_RESERVE_KG) };
}

/**
 * Fuel a training car respawns with: any load a race car carries, from a full race start down to
 * the last laps, so the network learns every car mass it meets in a race.
 */
export function trainingFuelKg(perLapKg: number, random: () => number): number {
  const max = Math.max(TRAINING_MIN_FUEL_KG, planRaceFuel(perLapKg, TRAINING_RACE_LAPS).fuelKg);
  return TRAINING_MIN_FUEL_KG + random() * (max - TRAINING_MIN_FUEL_KG);
}
