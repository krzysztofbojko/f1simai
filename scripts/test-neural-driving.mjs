// Neural driving, single-track dynamics, damage and wreck behaviour.
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'f1-neural-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: dir, lib: { entry: {
    car: resolve('src/physics/Car.ts'), vector: resolve('src/math/Vector2.ts'), presets: resolve('src/track/Presets.ts'),
    network: resolve('src/ai/NeuralNetwork.ts'), population: resolve('src/ai/Population.ts'), traffic: resolve('src/physics/Traffic.ts'), pace: resolve('src/ai/PaceSearch.ts'), lines: resolve('src/ai/LineSearch.ts'), linenet: resolve('src/ai/LineNet.ts') },
    formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const load = async name => import(pathToFileURL(join(dir, name + '.mjs')));
  const { Car, decodeDriverOutputs, encodeDriverTargets } = await load('car');
  const { Vector2 } = await load('vector');
  const { Presets } = await load('presets');
  const { NeuralNetwork } = await load('network');
  const { Population } = await load('population');
  const { captureMotion, resolveTraffic } = await load('traffic');
  const { PaceSearch } = await load('pace');
  const { LineSearch } = await load('lines');
  const { LineNet, lineInputs, seedLineTarget } = await load('linenet');
  let state = 99;
  Math.random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const gp = Presets.createGrandPrixTrack(14);
  const idle = { throttle: 0, brake: 0, steer: 0 };
  const stub = { checkpoints: [], timingGates: [], width: 76, isOutOfBounds: () => false };

  // 1. Output encoding is invertible and bounded.
  const encoded = encodeDriverTargets([0.5, 1, 0]);
  const decoded = decodeDriverOutputs(encoded);
  assert.ok(Math.abs(decoded.steer - 0.5) < 1e-9 && Math.abs(decoded.throttle - 1) < 1e-9 && decoded.brake === 0);

  // 2. The network's outputs ARE the pedals: a constant-output brain controls the car.
  const slot = gp.getGridSlot(0);
  const makeCar = (brain) => { const c = new Car(slot.pos, slot.heading, brain, '#fff', 'test', 100, 25);
    c.currentCheckpointIdx = (slot.checkpointIdx + 1) % gp.checkpoints.length; c.mistakesEnabled = false; return c; };
  const constant = (steer, throttle, brake) => { const net = new NeuralNetwork([30, 4, 3]);
    for (const layer of net.layers) { layer.weights.forEach(row => row.fill(0)); layer.biases.fill(0); }
    const out = net.layers.at(-1); out.biases[0] = steer; out.biases[1] = throttle; out.biases[2] = brake;
    net.layers[0].biases.fill(0.0); net.layers[0].weights.forEach(r => r.fill(0));
    // tanh(hidden)=0 -> output = tanh(bias)
    return net; };
  const driven = makeCar(constant(0.3, 0.45, 0));
  driven.updateSensors(gp);
  const fullThrottle = driven.getAIControl(gp);
  assert.ok(fullThrottle.throttle > 0.2 && fullThrottle.throttle < 0.7, 'throttle must come from the network: ' + JSON.stringify(fullThrottle));
  const braking = makeCar(constant(0, 0, 0.5));
  braking.vel = Vector2.fromAngle(braking.heading).mul(30); braking.speed = 30;
  braking.updateSensors(gp);
  const brakeControl = braking.getAIControl(gp);
  assert.ok(brakeControl.brake > 0.3 && brakeControl.throttle === 0, 'brake must come from the network: ' + JSON.stringify(brakeControl));
  // Guardian: off the asphalt the rule-based expert takes over regardless of the network.
  const lost = makeCar(constant(0, 0.9, 0));
  lost.pos = gp.sampleSurface(slot.pos).center.add(gp.sampleSurface(slot.pos).tangent.normal().mul(10)); lost.vel = Vector2.fromAngle(lost.heading).mul(25); lost.speed = 25;
  lost.updateSensors(gp);
  const recover = lost.getAIControl(gp);
  assert.ok(recover.throttle < 0.5, 'guardian must cut throttle off the road');

  // 3. A distilled network drives a full lap by itself.
  const solo = new Population(1, gp, 25);
  for (const c of solo.cars) c.mistakesEnabled = false;
  for (let i = 0; i < 100 * 60 && solo.teamRecords[0].lapsCount < 1; i++) solo.update(1 / 60, gp);
  assert.ok(solo.teamRecords[0].lapsCount >= 1, 'network-driven car must complete a lap');
  assert.ok(solo.cars[0].brain.layerSizes.at(-1) === 3);

  // 4. Dynamic single-track model: over-limit cornering with power does not spin the car.
  for (const [speed, steer] of [[30, 0.3], [50, 0.15], [70, 0.3]]) {
    const c = new Car(new Vector2(0, 0), 0); c.vel = new Vector2(speed, 0); c.speed = speed;
    c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1;
    for (let i = 0; i < 300; i++) { c.framesSinceLastCheckpoint = 0; c.updatePhysics({ throttle: 1, brake: 0, steer }, 1 / 60, stub); }
    const beta = Math.atan2(c.vel.dot(Vector2.fromAngle(c.heading).normal()), c.vel.dot(Vector2.fromAngle(c.heading)));
    assert.ok(Math.abs(beta) < 0.6, `car spun at ${speed} m/s, steer ${steer}: beta ${beta}`);
    assert.ok(Math.abs(c.lateralG) < 6 && Number.isFinite(c.pos.x));
  }
  // Unsaturated cornering matches the kinematic yaw rate within a few percent.
  { const c = new Car(new Vector2(0, 0), 0); c.vel = new Vector2(20, 0); c.speed = 20; c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1;
    for (let i = 0; i < 120; i++) { c.framesSinceLastCheckpoint = 0; c.updatePhysics({ throttle: 0, brake: 0, steer: 0.15 }, 1 / 60, stub); }
    const kin = c.speed / 3.6 * Math.tan(0.15 * 0.4);
    assert.ok(Math.abs(c.angularVelocity - kin) / kin < 0.12, `yaw ${c.angularVelocity} vs ${kin}`);
    assert.equal(c.isSkidding, false); }
  // Heavy steering at speed saturates the front axle: understeer, not oversteer.
  { const c = new Car(new Vector2(0, 0), 0); c.vel = new Vector2(60, 0); c.speed = 60; c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1;
    for (let i = 0; i < 40; i++) { c.framesSinceLastCheckpoint = 0; c.updatePhysics({ throttle: 0, brake: 0, steer: 0.5 }, 1 / 60, stub); }
    assert.equal(c.isSkidding, true); }

  // 5. Impacts: damage accumulates, gentle contact does not wreck, hard contact does and the wreck keeps sliding.
  const body = (x, vx) => { const c = new Car(new Vector2(x, 0), 0); c.vel = new Vector2(vx, 0); c.speed = Math.abs(vx); c.isRaceMode = true; return c; };
  let a = body(0, 20), b = body(20, 12), m = captureMotion([a, b]); a.pos.x = 15; b.pos.x = 20.5;
  resolveTraffic([a, b], m);
  assert.ok(a.isAlive && b.isAlive && a.damage > 0 && a.damage < 1, 'an 8 m/s contact damages but does not wreck');
  const downforceBefore = 0; // damage reduces downforce => lower cornering limit
  const hurt = new Car(new Vector2(0, 0), 0); hurt.damage = 0.8;
  const fresh = new Car(new Vector2(0, 0), 0);
  for (const c of [hurt, fresh]) { c.vel = new Vector2(70, 0); c.speed = 70; c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1; c.updatePhysics({ throttle: 0, brake: 1, steer: 0 }, 1 / 60, stub); }
  assert.ok(hurt.speed > fresh.speed, 'a damaged car has less downforce and brakes worse');
  a = body(0, 40); b = body(20, 0); m = captureMotion([a, b]); a.pos.x = 17;
  resolveTraffic([a, b], m);
  assert.equal(a.eliminationReason, 'car');
  const sliding = [a, b].filter(c => !c.isAlive && c.speed > 0.5);
  assert.ok(sliding.length > 0, 'a wreck keeps momentum after the impact');
  const wreck = sliding[0], start = wreck.pos.x, speed0 = wreck.speed;
  for (let i = 0; i < 600 && wreck.speed > 0; i++) wreck.coastWreck(1 / 60, stub);
  assert.equal(wreck.speed, 0); assert.ok(wreck.pos.x > start, 'wreck slid forward');
  assert.ok(wreck.pos.x - start <= speed0 * speed0 / (2 * 12) + 1, 'wreck decelerates at ~12 m/s²');

  // 6. Barrier contact: graze costs little speed, a hit sheds a lot; no blanket per-step damping.
  const road = gp.points[40], fence = gp.runoff[40].leftBarrier;
  const probe = (inward) => { const c = new Car(fence.sub(road.normal.mul(1.0)), road.tangent.heading()); c.vel = road.tangent.mul(40).add(road.normal.mul(inward)); c.speed = c.vel.mag();
    const before = c.vel.dot(road.tangent); for (let i = 0; i < 6 && c.isAlive; i++) { c.framesSinceLastCheckpoint = 0; c.updatePhysics(idle, 1 / 60, gp); }
    return { alive: c.isAlive, along: c.vel.dot(road.tangent) / before, c }; };
  const graze = probe(1.5), hit = probe(8);
  assert.ok(graze.alive && graze.along > 0.8, 'a graze keeps most speed: ' + graze.along);
  assert.ok(hit.along < graze.along);
  // Limit probing: clean improving laps raise the margin, an excursion backs off and caps it.
  const pace = new PaceSearch();
  [60, 59.5, 59].forEach(t => pace.finishLap(t, true, false));
  assert.ok(pace.margin > 1.05, 'margin grows on clean faster laps: ' + pace.margin);
  const before = pace.margin;
  pace.finishLap(61, false, true);
  assert.ok(pace.margin < before && pace.ceiling <= before, 'excursion backs off');
  for (let i = 0; i < 40; i++) pace.finishLap(60, true, false);
  assert.ok(pace.margin <= pace.ceiling + 1e-9 && pace.margin <= PaceSearch.MAX);
  assert.equal(pace.value(true), pace.bestMargin);
  // Line search: new candidates alter individual lap sections.
  const search = new LineSearch(0);
  for (let i = 0; i < 14; i++) search.finish(60 + i * 0.01, true);
  assert.ok(search.profiles.some(p => p.trim.some(v => v !== 0)), 'per-section trims are explored');
  // Pedals are exclusive: brake demand lifts the throttle at the physics boundary.
  const pedalCar = new Car(gp.startPosition, gp.startAngle, new NeuralNetwork([30, 4, 3]), '#fff', 'pedals', 60, 25);
  pedalCar.vel = Vector2.fromAngle(pedalCar.heading).mul(30); pedalCar.speed = 30;
  pedalCar.updatePhysics({ throttle: 1, brake: 0.5, steer: 0 }, 1 / 60, gp);
  assert.equal(pedalCar.currentControl.throttle, 0, 'throttle and brake never together');
  pedalCar.updatePhysics({ throttle: 0.6, brake: 0.01, steer: 0 }, 1 / 60, gp);
  assert.equal(pedalCar.currentControl.brake, 0, 'a token brake is dropped');
  // Learned racing line: a faster candidate replaces the champion, a slower one does not.
  const lineNet = new LineNet(new NeuralNetwork([25 + 7, 6, 1]));
  lineNet.finish(60, true); // measures the seed line
  const champion = lineNet.best;
  lineNet.finish(61, true); // candidate slower
  assert.equal(lineNet.best, champion, 'slower candidate rejected');
  lineNet.finish(58, true);
  assert.ok(lineNet.bestTime <= 60, 'faster candidate becomes champion: ' + lineNet.bestTime);
  assert.ok(Math.abs(seedLineTarget(gp, 40)) <= 0.95 && lineInputs(gp, { pos: gp.startPosition, heading: gp.startAngle, speed: 20, rayDistances: new Array(25).fill(1) }).length === 32);
  // Pace margin and learned line survive a save/restore round trip (browser autosave).
  const savedPace = new PaceSearch(); [60, 59].forEach(t => savedPace.finishLap(t, true, false)); savedPace.fail();
  const restoredPace = new PaceSearch(); restoredPace.fromJSON(JSON.parse(JSON.stringify(savedPace.toJSON())));
  assert.deepEqual(restoredPace.toJSON(), savedPace.toJSON());
  const savedLine = new LineNet(new NeuralNetwork([32, 6, 1])); savedLine.finish(60, true);
  const restoredLine = new LineNet(new NeuralNetwork([32, 6, 1]));
  assert.ok(restoredLine.fromJSON(JSON.parse(JSON.stringify(savedLine.toJSON()))));
  const probeIn = new Array(32).fill(0.3);
  assert.equal(restoredLine.best.forward(probeIn)[0], savedLine.best.forward(probeIn)[0]);
  assert.equal(restoredLine.bestTime, savedLine.bestTime);
  assert.equal(new LineNet(new NeuralNetwork([20, 6, 1])).fromJSON(savedLine.toJSON()), false, 'different sensor layout is ignored');
  // Track limits: only an excursion with all four wheels off the asphalt counts, once per exit.
  const limitCar = new Car(gp.startPosition, gp.startAngle, new NeuralNetwork([30, 4, 3]), '#fff', 'limits', 60, 25);
  const centre = gp.checkpoints[10], normal = centre.tangent.normal();
  const place = lateral => { limitCar.pos = centre.center.add(normal.mul(lateral)); limitCar.heading = centre.tangent.heading(); limitCar.vel = centre.tangent.mul(1); limitCar.speed = 1; limitCar.isAlive = true; limitCar.updatePhysics(idle, 1 / 600, gp); };
  place(gp.width / 2 - 1.2); // one side of the car over the edge only
  assert.equal(limitCar.trackLimitExits, 0, 'two wheels over the edge are not an exit');
  place(gp.width / 2 + 6); place(gp.width / 2 + 6);
  assert.equal(limitCar.trackLimitExits, 1, 'all four wheels off counts once');
  place(0); place(gp.width / 2 + 6);
  assert.equal(limitCar.trackLimitExits, 2, 'a second excursion counts again');
  // ERS: wide-open throttle drains the battery, braking harvests, and depletion costs power.
  const ersCar = new Car(gp.startPosition, gp.startAngle, new NeuralNetwork([30, 4, 3]), '#fff', 'ers', 60, 25);
  const speedUp = (energy, steps) => { ersCar.reset(gp.startPosition, gp.startAngle, true, 1); ersCar.ersEnergy = energy; ersCar.vel = Vector2.fromAngle(ersCar.heading).mul(75); ersCar.speed = 75; for (let i = 0; i < steps; i++) ersCar.updatePhysics({ throttle: 1, brake: 0, steer: 0 }, 1 / 60, gp); return ersCar.speed; };
  const charged = speedUp(Car.ERS_CAPACITY, 15), chargedEnergy = ersCar.ersEnergy;
  const empty = speedUp(0, 15);
  assert.ok(chargedEnergy < Car.ERS_CAPACITY, 'deployment drains the battery');
  assert.ok(charged > empty + 0.1, `hybrid boost accelerates harder: ${charged} vs ${empty}`);
  ersCar.reset(gp.startPosition, gp.startAngle, true, 1); ersCar.ersEnergy = 1e6; ersCar.vel = Vector2.fromAngle(ersCar.heading).mul(60); ersCar.speed = 60;
  for (let i = 0; i < 30; i++) ersCar.updatePhysics({ throttle: 0, brake: 0.8, steer: 0 }, 1 / 60, gp);
  assert.ok(ersCar.ersEnergy > 1e6, 'braking harvests energy');
  // Tyres: bell-shaped thermal window, blankets in training, heating and wear in a race.
  assert.ok(Math.abs(Car.tyreGrip(Car.TYRE_OPTIMUM, 0) - 1) < 1e-9, 'full grip at the optimum');
  assert.ok(Car.tyreGrip(60, 0) < 0.9 && Car.tyreGrip(150, 0) < 0.9, 'cold and overheated tyres lose grip');
  assert.ok(Car.tyreGrip(100, 1) < Car.tyreGrip(100, 0.3), 'wear lowers grip');
  const tyreCar = new Car(gp.startPosition, gp.startAngle, new NeuralNetwork([30, 4, 3]), '#fff', 'tyres', 60, 25);
  const driveCorner = (race, steps) => { tyreCar.isRaceMode = race; tyreCar.reset(gp.startPosition, gp.startAngle, true, 1); tyreCar.vel = Vector2.fromAngle(tyreCar.heading).mul(45); tyreCar.speed = 45; for (let i = 0; i < steps; i++) tyreCar.updatePhysics({ throttle: 0.5, brake: 0, steer: 0.12 }, 1 / 60, stub); };
  driveCorner(false, 120);
  assert.equal(tyreCar.tyreTempFront, Car.TYRE_OPTIMUM, 'training runs on blankets');
  assert.equal(tyreCar.tyreGripFront, 1);
  driveCorner(true, 120);
  assert.ok(tyreCar.tyreTempFront !== 85 && tyreCar.tyreWearFront > 0, 'race tyres heat up and wear: ' + tyreCar.tyreTempFront);
  // Gearbox: 8 ratios, limiter-bound top speed, shift-cut and real gear/rpm bookkeeping.
  const gearCar = new Car(gp.startPosition, gp.startAngle, new NeuralNetwork([30, 4, 3]), '#fff', 'gears', 60, 25);
  const gearsSeen = new Set(); let maxRpm = 0, cutSteps = 0, prevGear = 1, prevForce = 0;
  for (let i = 0; i < 60 * 45; i++) {
    gearCar.framesSinceLastCheckpoint = 0; // no checkpoints on the stub track
    gearCar.updatePhysics({ throttle: 1, brake: 0, steer: 0 }, 1 / 60, stub);
    gearsSeen.add(gearCar.gear); maxRpm = Math.max(maxRpm, gearCar.engineRpm);
    if (gearCar.gear > prevGear) cutSteps++; prevGear = gearCar.gear;
  }
  assert.equal(gearCar.gear, 8, 'reaches top gear');
  assert.ok([...gearsSeen].length === 8, 'uses all eight gears: ' + [...gearsSeen]);
  assert.ok(maxRpm <= Car.REV_LIMIT + 1, 'never beyond the limiter: ' + maxRpm);
  assert.ok(cutSteps >= 7, 'upshifts happened');
  assert.ok(gearCar.speed > 90 && gearCar.speed < 108, 'top speed set by drag and the rev limit: ' + gearCar.speed);
  assert.ok(Car.GEAR_RATIOS[1] > Car.GEAR_RATIOS[2] && Car.GEAR_RATIOS[7] > Car.GEAR_RATIOS[8], 'ratios fall with gear');
  assert.ok(Car.icePowerFraction(4000) < Car.icePowerFraction(9000) && Math.abs(Car.icePowerFraction(12000) - 1) < 1e-9, 'power band');
  // Ride-height aero: normalised to ~1 at cornering heights, penalised when the floor chokes, heights fall with speed.
  assert.ok(Math.abs(Car.rideHeightLift(0.0244, 0.0464) - 1) < 0.03, 'unit lift at a typical cornering height');
  assert.ok(Car.rideHeightLift(0.004, 0.010) < Car.rideHeightLift(0.016, 0.032), 'a choked floor loses downforce');
  assert.ok(gearCar.rideHeightFront < Car.FRH_STATIC && gearCar.rideHeightRear < Car.RRH_STATIC, 'downforce compresses the axles at speed');
  console.log('Neural driving, dynamics, damage and wreck regressions passed.');
} finally { await rm(dir, { recursive: true, force: true }); }
