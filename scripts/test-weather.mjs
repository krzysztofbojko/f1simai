// Weather: forecast evolution, its effect on the car (wind, track temperature) and on training records.
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'f1-weather-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: dir, lib: { entry: {
    car: resolve('src/physics/Car.ts'), weather: resolve('src/physics/Weather.ts'), vector: resolve('src/math/Vector2.ts'),
    presets: resolve('src/track/Presets.ts'), network: resolve('src/ai/NeuralNetwork.ts'), population: resolve('src/ai/Population.ts') },
    formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const load = async name => import(pathToFileURL(join(dir, name + '.mjs')));
  const { Car, driverInputCount } = await load('car');
  const { Weather, neutralWeather, conditionsOf } = await load('weather');
  const { Vector2 } = await load('vector');
  const { Presets } = await load('presets');
  const { NeuralNetwork } = await load('network');
  const { Population } = await load('population');
  let state = 7;
  Math.random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const run = (weather, seconds, each = () => {}) => { for (let i = 0; i < seconds; i++) { weather.step(1); each(weather.state, i); } };

  // 1. Reference weather: the conditions the physics was calibrated in, unchanged all session.
  const sunny = new Weather('sunny', 3);
  run(sunny, 3600);
  for (const [key, value] of Object.entries(neutralWeather())) {
    if (key !== 'windDir') assert.ok(Math.abs(sunny.state[key] - value) < 1e-9, `sunny ${key}: ${sunny.state[key]} vs ${value}`);
  }

  // 2. A seed replays the same weather.
  const a = new Weather('changeable', 11), b = new Weather('changeable', 11);
  run(a, 900); run(b, 900);
  assert.deepEqual(a.state, b.state, 'same seed, same weather');

  // 3. A shower: the track gets wet and cooler under the rain, then the sun dries it.
  const shower = new Weather('shower', 5);
  let maxRain = 0, maxWet = 0, coolest = Infinity;
  const startTemp = shower.state.trackTemp;
  run(shower, 3600, s => { maxRain = Math.max(maxRain, s.rain); maxWet = Math.max(maxWet, s.wetness); coolest = Math.min(coolest, s.trackTemp); });
  assert.ok(maxRain > 0.3 && maxWet > 0.6, `the shower soaks the track: rain ${maxRain.toFixed(2)} wetness ${maxWet.toFixed(2)}`);
  assert.ok(coolest < startTemp - 5, `rain cools the track: ${startTemp.toFixed(1)} -> ${coolest.toFixed(1)}`);
  assert.ok(shower.state.wetness < 0.15 && shower.state.rain === 0, `the sun dries the track after the shower: ${shower.state.wetness.toFixed(3)}`);
  assert.equal(shower.conditions, 'dry');

  // 4. Hot sun bakes the track; a storm soaks it with gusting wind.
  const hot = new Weather('hot', 2); run(hot, 1200);
  assert.ok(hot.state.trackTemp > 50, 'hot track: ' + hot.state.trackTemp.toFixed(1));
  const storm = new Weather('storm', 2);
  let minGust = Infinity, maxGust = 0;
  run(storm, 600, s => { minGust = Math.min(minGust, s.gust); maxGust = Math.max(maxGust, s.gust); });
  assert.ok(storm.state.wetness > 0.9 && storm.conditions === 'wet', 'a storm keeps the track soaked');
  assert.ok(maxGust - minGust > 0.8, `gusts vary the wind: ${minGust.toFixed(2)}..${maxGust.toFixed(2)}`);
  assert.equal(conditionsOf(0.05), 'dry'); assert.equal(conditionsOf(0.4), 'damp'); assert.equal(conditionsOf(0.9), 'wet');

  // 5. Wind on the car: a headwind costs top speed, a tailwind adds it; a crosswind pushes the car off line.
  const gp = Presets.createGrandPrixTrack(14);
  const stub = { checkpoints: [], timingGates: [], width: 76, isOutOfBounds: () => false };
  const car = new Car(gp.startPosition, gp.startAngle, new NeuralNetwork([driverInputCount(25), 4, 3]), '#fff', 'wind', 60, 25);
  const setWind = (along, across) => {
    const f = Vector2.fromAngle(gp.startAngle), r = f.normal();
    Car.config.weather = { ...neutralWeather(), windSpeed: Math.hypot(along, across), windX: f.x * along + r.x * across, windY: f.y * along + r.y * across };
  };
  const topSpeed = along => {
    setWind(along, 0);
    car.reset(gp.startPosition, gp.startAngle, true, 1);
    for (let i = 0; i < 60 * 40; i++) { car.updatePhysics({ throttle: 1, brake: 0, steer: 0 }, 1 / 60, stub); car.framesSinceLastCheckpoint = 0; }
    return car.vel.mag();
  };
  const still = topSpeed(0), head = topSpeed(-8), tail = topSpeed(8);
  assert.ok(head < still - 2 && tail > still + 2, `top speed (m/s) headwind ${head.toFixed(1)} still ${still.toFixed(1)} tailwind ${tail.toFixed(1)}`);
  const drift = across => {
    setWind(0, across);
    car.reset(gp.startPosition, gp.startAngle, true, 1);
    car.vel = Vector2.fromAngle(car.heading).mul(60); car.speed = 60;
    for (let i = 0; i < 60 * 2; i++) { car.updatePhysics({ throttle: 0.6, brake: 0, steer: 0 }, 1 / 60, stub); car.framesSinceLastCheckpoint = 0; }
    return { lateral: car.pos.sub(gp.startPosition).dot(Vector2.fromAngle(gp.startAngle).normal()), heading: car.heading - gp.startAngle };
  };
  const calm = drift(0), gusty = drift(15);
  assert.ok(Math.abs(calm.lateral) < 0.01 && Math.abs(calm.heading) < 1e-6, 'still air: the car runs straight');
  assert.ok(Math.abs(gusty.heading) > 0.002 || Math.abs(gusty.lateral) > 0.05, `a crosswind moves the car: ${gusty.lateral.toFixed(3)} m, ${gusty.heading.toFixed(4)} rad`);

  // 6. A baking track runs the tyres hotter and wears them faster.
  const stint = weather => {
    Car.config.weather = weather;
    car.isRaceMode = true; car.reset(gp.startPosition, gp.startAngle, true, 1);
    car.vel = Vector2.fromAngle(car.heading).mul(45); car.speed = 45;
    for (let i = 0; i < 60 * 40; i++) { car.updatePhysics({ throttle: 0.4, brake: 0, steer: 0.03 }, 1 / 60, stub); car.framesSinceLastCheckpoint = 0; }
    return { temp: car.tyreTempFront, wear: car.tyreWearFront };
  };
  const mild = stint(neutralWeather()), baked = stint({ ...neutralWeather(), airTemp: 34, trackTemp: 55 });
  assert.ok(baked.temp > mild.temp + 2 && baked.wear > mild.wear, `hot track: ${mild.temp.toFixed(1)}° -> ${baked.temp.toFixed(1)}°, wear ${mild.wear.toExponential(2)} -> ${baked.wear.toExponential(2)}`);
  Car.config.weather = neutralWeather(); car.isRaceMode = false;

  // 7. Air density follows the air temperature (the calibration holds at 25 °C): cold air drags more.
  Car.config.weather = neutralWeather();
  assert.ok(Math.abs(car.airDensity - 1.225) < 1e-12, 'reference density at 25 °C');
  Car.config.weather = { ...neutralWeather(), airTemp: 5 }; const coldAir = car.airDensity;
  Car.config.weather = { ...neutralWeather(), airTemp: 35 }; const hotAir = car.airDensity;
  assert.ok(coldAir > 1.3 && hotAir < 1.19, `density ${coldAir.toFixed(3)} at 5 °C, ${hotAir.toFixed(3)} at 35 °C`);
  const vmax = airTemp => {
    Car.config.weather = { ...neutralWeather(), airTemp };
    car.reset(gp.startPosition, gp.startAngle, true, 1);
    car.lapPowerFactor = car.lapGripFactor = car.lapDragFactor = 1;
    for (let i = 0; i < 60 * 40; i++) { car.updatePhysics({ throttle: 1, brake: 0, steer: 0 }, 1 / 60, stub); car.framesSinceLastCheckpoint = 0; }
    return car.vel.mag();
  };
  const vCold = vmax(5), vHot = vmax(35);
  assert.ok(vCold < vHot - 1, `top speed ${(vCold * 3.6).toFixed(0)} km/h in cold air, ${(vHot * 3.6).toFixed(0)} km/h in hot air`);

  // 8. Wind dries a wet track faster.
  const drying = wind => {
    const w = new Weather('sunny', 4);
    w.state.wetness = 0.5; w.state.windSpeed = wind;
    run(w, 600);
    return w.state.wetness;
  };
  const stillDry = drying(0), windDry = drying(10);
  assert.ok(windDry < stillDry * 0.8, `after 10 min: wetness ${stillDry.toFixed(3)} in still air, ${windDry.toFixed(3)} in a 10 m/s wind`);

  // 9. Aquaplaning: slicks on standing water lose grip above 200 km/h; treaded tyres and a damp track do not.
  assert.equal(Car.aquaplaneLoss('soft', 0.9, 180 / 3.6), 0, 'below 200 km/h');
  assert.equal(Car.aquaplaneLoss('soft', 0.5, 280 / 3.6), 0, 'a damp track has no standing water');
  assert.equal(Car.aquaplaneLoss('wet', 1, 280 / 3.6), 0, 'full wets clear the water');
  assert.equal(Car.aquaplaneLoss('intermediate', 1, 280 / 3.6), 0, 'intermediates clear the water');
  assert.ok(Car.aquaplaneLoss('medium', 1, 280 / 3.6) > Car.aquaplaneLoss('medium', 1, 230 / 3.6) && Car.aquaplaneLoss('medium', 1, 230 / 3.6) > Car.aquaplaneLoss('medium', 0.8, 230 / 3.6), 'the loss grows with speed and water');
  assert.ok(Math.abs(Car.aquaplaneLoss('soft', 1, 400 / 3.6) - Car.AQUAPLANE_MAX_LOSS) < 1e-12, 'bounded');
  const aquaplane = compound => {
    Car.config.weather = { ...neutralWeather(), wetness: 0.95, rain: 0.8 };
    car.reset(gp.startPosition, gp.startAngle, true, 1); car.tyreCompound = compound;
    car.vel = Vector2.fromAngle(car.heading).mul(75); car.speed = 75;
    car.updatePhysics({ throttle: 1, brake: 0, steer: 0 }, 1 / 60, stub);
    return car.aquaplaning;
  };
  assert.ok(aquaplane('soft') > 0.1 && aquaplane('wet') === 0, 'a slick at 270 km/h on a soaked track aquaplanes, a full wet does not');

  // 10. Brakes: the work of a stop heats the discs, the airflow cools them, the window sets the
  //     torque, and torque beyond the tyre locks the wheels. The same in training and the race.
  Car.config.weather = neutralWeather();
  assert.equal(Car.brakeEfficiency(600), 1);
  assert.ok(Math.abs(Car.brakeEfficiency(25) - Car.BRAKE_COLD_EFFICIENCY) < 1e-12 && Car.brakeEfficiency(200) < 1 && Car.brakeEfficiency(200) > Car.brakeEfficiency(100), 'cold discs bite less, warming up');
  assert.ok(Car.brakeEfficiency(1100) < 1 && Car.brakeEfficiency(1400) === Car.BRAKE_FADE_EFFICIENCY, 'overheated discs fade');
  const plane = { checkpoints: [], timingGates: [], width: 76, isOutOfBounds: () => false };
  const brakeCar = (speed, discs, dt = 1 / 60, race = false) => {
    const c = new Car(new Vector2(0, 0), 0); c.isRaceMode = race;
    c.pos = new Vector2(0, 0); c.prevPos = new Vector2(0, 0); c.vel = new Vector2(speed, 0); c.speed = speed;
    c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1;
    if (discs !== undefined) c.brakeTempFront = c.brakeTempRear = discs;
    return c;
  };
  const stop = (discs, race = false) => {
    const c = brakeCar(83, discs, 1 / 60, race);
    let peak = 0, locked = false;
    while (c.speed > 20) { c.updatePhysics({ throttle: 0, brake: 1, steer: 0 }, 1 / 60, plane); c.framesSinceLastCheckpoint = 0; peak = Math.max(peak, c.brakeTempFront); locked ||= c.wheelLockFront || c.wheelLockRear; }
    return { distance: c.pos.x, peak, locked, rear: c.brakeTempRear };
  };
  const warm = stop(Car.BRAKE_TEMP_START), cold = stop(25), raceStop = stop(Car.BRAKE_TEMP_START, true);
  assert.ok(warm.peak > Car.BRAKE_TEMP_START + 250 && warm.peak < Car.BRAKE_WINDOW_HIGH, `a stop from 300 km/h heats the front discs to ${warm.peak.toFixed(0)} °C`);
  assert.ok(!warm.locked, 'full pedal in a straight line on a dry track does not lock the wheels');
  assert.ok(cold.distance > warm.distance + 5, `cold discs stop later: ${cold.distance.toFixed(1)} m vs ${warm.distance.toFixed(1)} m`);
  assert.deepEqual(raceStop, warm, 'the same stop in training and in a race');
  // Cooling at speed, independent of the step.
  const cool = dt => { const c = brakeCar(70, 900); for (let t = 0; t < 10 - 1e-9; t += dt) { c.vel = new Vector2(70, 0); c.speed = 70; c.updatePhysics({ throttle: 0.5, brake: 0, steer: 0 }, dt, plane); c.framesSinceLastCheckpoint = 0; } return c.brakeTempFront; };
  const cooled = [1 / 30, 1 / 60, 1 / 120].map(cool);
  assert.ok(cooled[1] < 400 && Math.max(...cooled) - Math.min(...cooled) < 2, `10 s at 250 km/h cools 900 °C discs to ${cooled.map(t => t.toFixed(1)).join(' / ')} °C at 30/60/120 Hz`);
  // Full pedal in a corner asks the fronts for more than their friction circle leaves: they lock,
  // lose most of their cornering force and take a flat spot; a light pedal on a straight frees them.
  const corner = pedal => {
    const c = brakeCar(60, 600);
    for (let i = 0; i < 60; i++) { c.updatePhysics({ throttle: 0.3, brake: 0, steer: 0.05 }, 1 / 60, plane); c.framesSinceLastCheckpoint = 0; }
    const wear = c.tyreWearFront;
    let locked = 0, lateral = 0;
    for (let i = 0; i < 30; i++) { c.updatePhysics({ throttle: 0, brake: pedal, steer: 0.05 }, 1 / 60, plane); c.framesSinceLastCheckpoint = 0; if (c.wheelLockFront) { locked++; lateral += c.frontLateralInUse / c.totalMass / Car.GRAVITY; } }
    const flatSpot = c.tyreWearFront - wear;
    for (let i = 0; i < 3; i++) { c.updatePhysics({ throttle: 0, brake: 0.1, steer: 0 }, 1 / 60, plane); c.framesSinceLastCheckpoint = 0; }
    return { locked, lateral: locked ? lateral / locked : 0, flatSpot, freed: !c.wheelLockFront };
  };
  const stab = corner(1), trail = corner(0.3);
  assert.ok(stab.locked > 10 && trail.locked === 0, `fronts locked ${stab.locked} steps at full pedal, ${trail.locked} at 30%`);
  assert.ok(stab.lateral < 0.5 && stab.flatSpot > 2 * trail.flatSpot && stab.freed, `locked fronts carry ${stab.lateral.toFixed(2)} g sideways, flat spot ${(stab.flatSpot * 100).toFixed(2)}% wear; freed on a light pedal`);
  Car.config.weather = neutralWeather();

  // 11. Training records: the first lap in new conditions sets the reference and keeps the proven brain.
  const population = new Population(1, gp);
  population.autoEvolutionEnabled = false;
  const driver = population.cars[0], record = population.teamRecords[0];
  const lap = lapTime => ({ lapTime, trajectory: [], maxSpeed: 300, avgSpeed: 180, fuelRemaining: 90 });
  population.recordLap(lap(60), driver, false, gp);
  const proven = JSON.stringify(record.bestBrain.layers[0].weights);
  driver.brain.layers[0].weights[0][0] += 3;
  population.setConditions('wet');
  population.recordLap(lap(75), driver, false, gp);
  assert.equal(record.bestLapTime, 75, 'a wet lap sets the wet reference');
  assert.equal(record.bestLapConditions, 'wet');
  assert.equal(JSON.stringify(record.bestBrain.layers[0].weights), proven, 'the dry champion brain is kept');
  population.setConditions('dry');
  population.recordLap(lap(61), driver, false, gp);
  assert.equal(record.bestLapTime, 61, 'back in the dry a new reference is set again');
  console.log(`weather tests passed (top speed ${(head * 3.6).toFixed(0)} / ${(still * 3.6).toFixed(0)} / ${(tail * 3.6).toFixed(0)} km/h head/still/tail 8 m/s; 15 m/s crosswind: ${gusty.lateral.toFixed(2)} m, ${(gusty.heading * 180 / Math.PI).toFixed(2)}° in 2 s; tyres ${mild.temp.toFixed(0)}° -> ${baked.temp.toFixed(0)}° on a 55° track; air ${coldAir.toFixed(3)} / ${hotAir.toFixed(3)} kg/m³ at 5 / 35 °C; brakes ${warm.peak.toFixed(0)} °C after a stop from 300 km/h, cold discs +${(cold.distance - warm.distance).toFixed(1)} m)`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
