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

  // 7. Training records: the first lap in new conditions sets the reference and keeps the proven brain.
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
  console.log(`weather tests passed (top speed ${(head * 3.6).toFixed(0)} / ${(still * 3.6).toFixed(0)} / ${(tail * 3.6).toFixed(0)} km/h head/still/tail 8 m/s; 15 m/s crosswind: ${gusty.lateral.toFixed(2)} m, ${(gusty.heading * 180 / Math.PI).toFixed(2)}° in 2 s; tyres ${mild.temp.toFixed(0)}° -> ${baked.temp.toFixed(0)}° on a 55° track)`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
