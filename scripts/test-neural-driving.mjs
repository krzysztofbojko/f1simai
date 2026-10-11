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
    network: resolve('src/ai/NeuralNetwork.ts'), population: resolve('src/ai/Population.ts'), traffic: resolve('src/physics/Traffic.ts') },
    formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const load = async name => import(pathToFileURL(join(dir, name + '.mjs')));
  const { Car, decodeDriverOutputs, encodeDriverTargets } = await load('car');
  const { Vector2 } = await load('vector');
  const { Presets } = await load('presets');
  const { NeuralNetwork } = await load('network');
  const { Population } = await load('population');
  const { captureMotion, resolveTraffic } = await load('traffic');
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
  console.log('Neural driving, dynamics, damage and wreck regressions passed.');
} finally { await rm(dir, { recursive: true, force: true }); }
