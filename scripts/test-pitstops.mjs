// Pit stops: the strategy (wear, conditions, the dry-race tyre rule, closed last laps), the pit
// lane (time lost, the car off the track, rejoining only into a clear track), no refuelling and
// the race fuel planned for the distance.
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'f1-pits-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: dir, emptyOutDir: true, minify: false, lib: { entry: {
    car: resolve('src/physics/Car.ts'), pits: resolve('src/physics/PitStrategy.ts'), presets: resolve('src/track/Presets.ts'),
    population: resolve('src/ai/Population.ts'), session: resolve('src/race/RaceSession.ts'), weather: resolve('src/physics/Weather.ts') },
    formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const load = name => import(pathToFileURL(join(dir, name + '.mjs')));
  const { Car } = await load('car');
  const pits = await load('pits');
  const { Presets } = await load('presets');
  const { Population } = await load('population');
  const { RaceSession } = await load('session');
  const { Weather } = await load('weather');
  let seed = 777;
  Math.random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const DT = 1 / 60;
  const track = Presets.createGrandPrixTrack(14);
  Car.config.weather.wetness = 0;

  // 1. Strategy.
  const car = new Car(track.startPosition, track.startAngle, null, '#fff', 'strategy', 60, 25);
  const ask = ({ wear = 0, laps = 0, distance = 0, compounds = ['medium'], wetness = 0, fuel = 60 }) => {
    car.wantsToPit = false; car.isPitting = false; car.isFinishedRace = false;
    car.tyreWearFront = car.tyreWearRear = wear; car.fuelKg = fuel;
    car.raceDistanceLaps = distance; car.raceLapsCompleted = laps;
    car.tyreCompound = compounds[compounds.length - 1]; car.usedCompounds = new Set(compounds);
    Car.config.weather.wetness = wetness;
    pits.updatePitRequest(car);
    Car.config.weather.wetness = 0;
    return car.wantsToPit;
  };
  assert.equal(ask({ wear: 0.75 }), true, 'training: worn tyres bring the car in');
  assert.equal(ask({ wear: 0.3, fuel: 2 }), false, 'low fuel is no reason to stop: there is no refuelling');
  assert.equal(ask({ wear: 0.75, distance: 30, laps: 10 }), true, 'race: worn tyres');
  assert.equal(ask({ wear: 0.9, distance: 30, laps: 28, compounds: ['medium', 'hard'] }), false, 'no stop for wear in the last two laps');
  assert.equal(ask({ wear: 0.2, distance: 30, laps: 28 }), true, 'the tyre rule still calls a car that has not stopped');
  assert.equal(ask({ wear: 0.2, distance: 30, laps: 28, wetness: 0.9, compounds: ['soft'] }), true, 'slicks on a soaked track: stop at any time');
  assert.equal(ask({ wear: 0.2, distance: 30, laps: 14 }), false, 'first half: one compound is fine');
  assert.equal(ask({ wear: 0.2, distance: 30, laps: 15 }), true, 'dry race: the second compound by half distance');
  assert.equal(ask({ wear: 0.2, distance: 30, laps: 20, compounds: ['medium', 'hard'] }), false, 'two slicks used: the rule is met');
  assert.equal(ask({ wear: 0.2, distance: 30, laps: 20, compounds: ['intermediate', 'medium'] }), false, 'a wet-weather set lifts the rule');
  assert.equal(ask({ wear: 0.2, distance: 0, laps: 50 }), false, 'training has no mandatory stop');
  car.isManual = true;
  assert.equal(ask({ wear: 0.2, distance: 30, laps: 20 }), false, "the player's strategy is the player's");
  car.isManual = false;

  // 2. The stop: pit-lane loss plus the tyre change, no fuel, fresh tyres, back at the pit-lane limit.
  assert.equal(pits.pitStopDuration(track), pits.PIT_LANE_LOSS + pits.TYRE_CHANGE_TIME);
  const lane = Presets.createGrandPrixTrack(14); lane.pitLaneLoss = 16;
  assert.equal(pits.pitStopDuration(lane), 18.5, 'a circuit may set its own pit-lane loss');
  const stopper = new Car(track.startPosition, track.startAngle, null, '#fff', 'stopper', 60, 25);
  stopper.reset(track.startPosition, track.startAngle, true, 1);
  stopper.fuelKg = 7.5; stopper.tyreCompound = 'medium'; stopper.usedCompounds = new Set(['medium']);
  stopper.tyreWearFront = stopper.tyreWearRear = 0.8; stopper.damage = 0.4;
  pits.enterPits(stopper, track);
  assert.ok(stopper.isPitting && stopper.pitStopsCount === 1 && !stopper.wantsToPit);
  let t = 0;
  const idle = { steer: 0, throttle: 0, brake: 0 };
  while (stopper.isPitting && t < 60) { stopper.updatePhysics(idle, DT, track); t += DT; }
  assert.ok(Math.abs(t - pits.pitStopDuration(track)) < 2 * DT, `stop lasted ${t.toFixed(2)} s`);
  assert.equal(stopper.fuelKg, 7.5, 'no refuelling at a stop');
  assert.equal(stopper.tyreCompound, 'hard');
  assert.ok(stopper.usedCompounds.has('hard') && stopper.usedCompounds.has('medium'));
  assert.ok(stopper.tyreWearFront === 0 && stopper.damage === 0);
  assert.ok(Math.abs(stopper.speed - pits.PIT_EXIT_SPEED) < 1e-9 && stopper.lapCompromised, 'rejoins at the pit-lane limit; the out-lap is no reference');
  assert.ok(Math.abs(stopper.lapTime - t) < 1e-6 && Math.abs(stopper.totalRaceTime - t) < 1e-6, 'the stop is in the lap and race time');

  // 3. The exit: a car alongside or one arriving fast from behind holds the rejoin.
  const waiting = new Car(track.startPosition, track.startAngle, null, '#fff', 'waiting', 60, 25);
  waiting.reset(track.startPosition, track.startAngle, true, 1);
  pits.enterPits(waiting, track);
  waiting.pitTimer = 0;
  const tangent = track.sampleSurface(waiting.pos).tangent;
  const other = new Car(waiting.pos.add(tangent.mul(-40)), track.startAngle, null, '#000', 'other', 60, 25);
  other.reset(waiting.pos.add(tangent.mul(-40)), tangent.heading(), true, 1);
  other.vel = tangent.mul(80); other.speed = 80;
  waiting.updatePhysics(idle, DT, track, [waiting, other]);
  assert.ok(waiting.isPitting, 'a car 40 m behind at 288 km/h would arrive within 1.5 s: wait');
  other.pos = waiting.pos.add(tangent.mul(5)); other.speed = 20;
  waiting.updatePhysics(idle, DT, track, [waiting, other]);
  assert.ok(waiting.isPitting, 'a car at the exit: wait');
  other.pos = waiting.pos.add(tangent.mul(-150));
  waiting.updatePhysics(idle, DT, track, [waiting, other]);
  assert.ok(!waiting.isPitting, 'clear track: rejoin');

  // 4. Race fuel: the distance at the field's consumption, no more than the tank, and the distance
  //    cut to what the tank covers. Nobody gains fuel during the race.
  const population = Population.create(track);
  const weather = new Weather('sunny', 3);
  const session = new RaceSession({ population, track, weather, playerCar: null, manualCarColor: null });
  population.onLapCompleted = (c, event) => session.onLapCompleted(c, event);
  population.fuelPerLap = 1.2;
  session.start({ totalLaps: 50, weatherSeed: 3 });
  const expected = 50 * 1.2 * (1 + RaceSession.FUEL_MARGIN) + RaceSession.FUEL_RESERVE_KG;
  assert.equal(session.totalLaps, 50);
  assert.ok(population.cars.every(c => Math.abs(c.fuelKg - expected) < 1e-9 && c.raceDistanceLaps === 50));
  population.fuelPerLap = 2;
  session.start({ totalLaps: 100, weatherSeed: 3 });
  const reachable = Math.floor((Car.MAX_FUEL_CAPACITY - RaceSession.FUEL_RESERVE_KG) / (2 * (1 + RaceSession.FUEL_MARGIN)));
  assert.equal(session.totalLaps, reachable, 'a distance the tank cannot cover is shortened');
  assert.ok(population.cars.every(c => c.fuelKg <= Car.MAX_FUEL_CAPACITY && c.raceDistanceLaps === reachable));

  // 5. A real race start with stops: worn tyres bring cars in at the line, they leave the track,
  //    come back on another compound, and no car's fuel ever rises.
  population.fuelPerLap = 1.2;
  session.start({ totalLaps: 10, weatherSeed: 3 });
  const step = () => {
    const phase = session.beforeStep(DT);
    if (phase !== 'run') return;
    population.update(DT, track);
    session.afterStep();
  };
  while (session.state === 'GRID_START') step();
  const worn = population.cars.slice(0, 4);
  for (const c of worn) c.tyreWearFront = c.tyreWearRear = 0.85;
  const fuel = new Map(population.cars.map(c => [c, c.fuelKg]));
  const seenPitting = new Set(), rejoined = new Set();
  for (let i = 0; i < 60 * 150 && session.state === 'RACING'; i++) {
    step();
    for (const c of population.cars) {
      assert.ok(c.fuelKg <= fuel.get(c) + 1e-9, `${c.driverName} gained fuel`);
      fuel.set(c, c.fuelKg);
      if (c.isPitting) seenPitting.add(c);
      else if (seenPitting.has(c)) rejoined.add(c);
    }
  }
  const stopped = worn.filter(c => c.isAlive || c.pitStopsCount > 0);
  assert.ok(stopped.length > 0 && stopped.every(c => c.pitStopsCount >= 1 && seenPitting.has(c)), 'worn cars stopped');
  assert.ok([...rejoined].every(c => c.usedCompounds.size >= 2 && c.tyreWearFront < 0.85), 'back on fresh tyres of another compound');
  console.log(`Pit stop regressions passed (strategy, ${pits.pitStopDuration(track)} s stop, exit clearance, no refuelling, race fuel ${expected.toFixed(1)} kg for 50 laps, ${rejoined.size} cars back from the pits).`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
