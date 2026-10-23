import { Car } from './Car';
import { nextDryCompound, weatherCompound, wrongForConditions, type TyreCompound } from './Tyres';

/**
 * Pit strategy: when a car asks to stop, which tyres it gets and the stop itself. A requested
 * stop is taken at the next crossing of the start/finish line.
 */

/** AI pit request: low fuel, tyres wrong for the conditions or worn out. */
export function updatePitRequest(car: Car): void {
  const wrongTyres = !car.isManual && wrongForConditions(car.tyreCompound, car.wetness);
  if ((car.fuelKg < 12.0 || wrongTyres || (car.tyresActive && Math.max(car.tyreWearFront, car.tyreWearRear) > 0.7)) && !car.isPitting) {
    car.wantsToPit = true;
  }
}

/** Compound fitted at the next stop: the player's request, else the strategy for the conditions. */
export function pitCompound(car: Car): TyreCompound {
  if (car.nextCompound) return car.nextCompound;
  const dry = nextDryCompound(car.tyreCompound);
  return weatherCompound(car.wetness, dry);
}

/** The car stops at the line: the stop lasts until the tank is full, at least 3.2 s. */
export function enterPits(car: Car): void {
  car.isPitting = true;
  car.pitTimer = Math.max(3.2, (Car.MAX_FUEL_CAPACITY - car.fuelKg) / 28);
  car.pitStopsCount++;
}

/** One step of a stop: refuelling, and at its end fresh tyres and a repaired car. */
export function servicePitStop(car: Car, dt: number): void {
  car.effectiveThrottle = 0;
  car.fuelBurnRatePerSec = 0;
  car.lateralG = 0;
  car.longitudinalG = 0;
  const serviceDt = Math.min(dt, Math.max(0, car.pitTimer));
  car.pitTimer = Math.max(0, car.pitTimer - dt);
  car.lapTime += dt;
  if (!car.isFinishedRace) {
    car.totalRaceTime += dt;
  }
  car.framesSinceLastCheckpoint = 0; // Prevent timeout while in pit box
  car.resetSuspension();
  car.vel.set(0, 0);
  car.speed = 0;
  car.speedKmh = 0;
  // Refueling during pit stop
  car.fuelKg = Math.min(Car.MAX_FUEL_CAPACITY, car.fuelKg + 28.0 * serviceDt);
  if (car.pitTimer <= 0) {
    car.isPitting = false;
    car.wantsToPit = false;
    car.damage = 0; // nose/wing change during the stop
    car.tyreCompound = pitCompound(car);
    car.tyreWearFront = car.tyreWearRear = 0; // fresh, pre-heated set
    car.tyreTempFront = car.tyreTempRear = 85;
    car.isOutOfFuel = false;
    car.fuelKg = Math.min(Car.MAX_FUEL_CAPACITY, car.fuelKg);
  }
}
