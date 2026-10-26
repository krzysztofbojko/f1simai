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
    network: resolve('src/ai/NeuralNetwork.ts'), population: resolve('src/ai/Population.ts'), traffic: resolve('src/physics/Traffic.ts'), pace: resolve('src/ai/PaceSearch.ts'), lines: resolve('src/ai/LineSearch.ts'), linenet: resolve('src/ai/LineNet.ts'), tyres: resolve('src/physics/Tyres.ts') },
    formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const load = async name => import(pathToFileURL(join(dir, name + '.mjs')));
  const { Car, decodeDriverOutputs, encodeDriverTargets, driverInputCount } = await load('car');
  const { Vector2 } = await load('vector');
  const { Presets } = await load('presets');
  const { NeuralNetwork } = await load('network');
  const { Population } = await load('population');
  const { captureMotion, resolveTraffic } = await load('traffic');
  const { PaceSearch } = await load('pace');
  const { LineSearch } = await load('lines');
  const { LineNet, lineInputs } = await load('linenet');
  const { COMPOUND_SPECS, weatherCompound, wrongForConditions } = await load('tyres');
  let state = 99;
  Math.random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const gp = Presets.createGrandPrixTrack(14);
  const idle = { throttle: 0, brake: 0, steer: 0 };
  const stub = { checkpoints: [], timingGates: [], width: 76, isOutOfBounds: () => false };

  // 1. Output encoding is invertible and bounded.
  const encoded = encodeDriverTargets([0.5, 1, 0]);
  const decoded = decodeDriverOutputs(encoded);
  // A residual brake output must not cancel a clear throttle command (and vice versa).
  assert.deepEqual(decodeDriverOutputs([0, 0.85, 0.04]), { steer: 0, throttle: 0.85 / 0.9, brake: 0 });
  assert.equal(decodeDriverOutputs([0, 0.05, 0.6]).throttle, 0);
  assert.ok(Math.abs(decoded.steer - 0.5) < 1e-9 && Math.abs(decoded.throttle - 1) < 1e-9 && decoded.brake === 0);

  // Every grid slot starts behind the gate it must cross next (a slot past it on a curve could
  // never clear it and the AI would turn back towards it).
  for (const [name, t] of [['GP 14 m', gp], ['GP 20 m', Presets.createGrandPrixTrack(20)], ['oval', Presets.createOvalTrack(14)]]) {
    const n = t.checkpoints.length;
    for (let i = 0; i < 24; i++) {
      const s = t.getGridSlot(i), next = t.checkpoints[(s.checkpointIdx + 1) % n];
      assert.ok(s.pos.sub(next.center).dot(next.tangent) < 0, `${name} slot ${i} is past its next gate ${(s.checkpointIdx + 1) % n}`);
    }
  }

  // 2. The network's outputs ARE the pedals: a constant-output brain controls the car.
  const slot = gp.getGridSlot(0);
  const makeCar = (brain) => { const c = new Car(slot.pos, slot.heading, brain, '#fff', 'test', 100, 25);
    c.currentCheckpointIdx = (slot.checkpointIdx + 1) % gp.checkpoints.length; c.mistakesEnabled = false; return c; };
  const constant = (steer, throttle, brake) => { const net = new NeuralNetwork([driverInputCount(25), 4, 3]);
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

  // 4. Dynamic single-track model: over-limit cornering, with power or lifting off, does not spin
  //    the car at any point of the run (the limit balance is understeer).
  for (const [speed, steer, throttle] of [[30, 0.3, 1], [50, 0.15, 1], [70, 0.3, 1], [70, 0.15, 0], [70, 0.08, 0]]) {
    const c = new Car(new Vector2(0, 0), 0); c.vel = new Vector2(speed, 0); c.speed = speed;
    c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1;
    let beta = 0;
    for (let i = 0; i < 300; i++) {
      c.timeSinceCheckpoint = 0; c.updatePhysics({ throttle, brake: 0, steer }, 1 / 60, stub);
      const b = Math.atan2(c.vel.dot(Vector2.fromAngle(c.heading).normal()), c.vel.dot(Vector2.fromAngle(c.heading)));
      if (Math.abs(b) > Math.abs(beta)) beta = b;
    }
    assert.ok(Math.abs(beta) < 0.6, `car spun at ${speed} m/s, steer ${steer}, throttle ${throttle}: peak beta ${beta}`);
    assert.ok(Math.abs(c.lateralG) < 6 && Number.isFinite(c.pos.x));
  }
  // Skid marks follow the distance slid: the same marks at 30, 60 and 120 Hz, and no draw from the random stream.
  { const marks = [30, 60, 120].map(hz => { const c = new Car(new Vector2(0, 0), 0); c.vel = new Vector2(0, 40); c.speed = 40;
      c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1;
      const draw = Math.random; let draws = 0; Math.random = () => { draws++; return draw(); };
      for (let i = 0; i < hz; i++) { c.timeSinceCheckpoint = 0; c.updatePhysics(idle, 1 / hz, stub); }
      Math.random = draw;
      assert.equal(draws, 0, `a slide at ${hz} Hz draws from the random stream`);
      return c.skidMarks.length; });
    assert.ok(marks[0] > 5 && Math.max(...marks) - Math.min(...marks) <= 2, `skid marks per second of sliding at 30/60/120 Hz: ${marks.join(' / ')}`); }
  // Unsaturated cornering matches the kinematic yaw rate within a few percent.
  { const c = new Car(new Vector2(0, 0), 0); c.vel = new Vector2(20, 0); c.speed = 20; c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1;
    for (let i = 0; i < 120; i++) { c.timeSinceCheckpoint = 0; c.updatePhysics({ throttle: 0, brake: 0, steer: 0.15 }, 1 / 60, stub); }
    const kin = c.speed / 3.6 * Math.tan(0.15 * 0.4);
    assert.ok(Math.abs(c.angularVelocity - kin) / kin < 0.12, `yaw ${c.angularVelocity} vs ${kin}`);
    assert.equal(c.isSkidding, false); }
  // Heavy steering at speed saturates the front axle: understeer, not oversteer.
  { const c = new Car(new Vector2(0, 0), 0); c.vel = new Vector2(60, 0); c.speed = 60; c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1;
    for (let i = 0; i < 40; i++) { c.timeSinceCheckpoint = 0; c.updatePhysics({ throttle: 0, brake: 0, steer: 0.5 }, 1 / 60, stub); }
    assert.equal(c.isSkidding, true); }
  // Pedal actuators: brake pressure builds within ~0.2 s, independent of the step; a demand that
  // flickers every frame between brake and full throttle reaches the tyres as a smooth force.
  { const pressureAfter = dt => { const c = new Car(new Vector2(0, 0), 0); c.vel = new Vector2(60, 0); c.speed = 60;
      for (let t = 0; t < Math.round(0.1 / dt); t++) { c.timeSinceCheckpoint = 0; c.updatePhysics({ throttle: 0, brake: 1, steer: 0 }, dt, stub); }
      return c.brakePressure; };
    const p = [1 / 30, 1 / 60, 1 / 120].map(pressureAfter);
    assert.ok(p.every(x => Math.abs(x - p[1]) < 0.01), `brake pressure depends on the step: ${p}`);
    assert.ok(p[1] > 0.75 && p[1] < 0.9, `brake pressure after 0.1 s: ${p[1]}`);
    const c = new Car(new Vector2(0, 0), 0); c.vel = new Vector2(70, 0); c.speed = 70; c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1;
    let last = null, maxStep = 0;
    for (let i = 0; i < 90; i++) {
      c.timeSinceCheckpoint = 0;
      c.updatePhysics(i % 2 ? { throttle: 1, brake: 0, steer: 0 } : { throttle: 0, brake: 0.66, steer: 0 }, 1 / 60, stub);
      if (i > 30 && last !== null) maxStep = Math.max(maxStep, Math.abs(c.longitudinalG - last));
      last = c.longitudinalG;
    }
    assert.ok(maxStep < 0.4, `flickering pedals jerk the car by ${maxStep.toFixed(2)} g per frame`); }
  // The expert (teacher of the seed networks) brakes in one progressive application per corner,
  // not on/off at the edge of the braking envelope (that was ~12 switches per second).
  { const c = new Car(gp.startPosition, gp.startAngle, null, '#fff', 'teacher', 60);
    const slot = gp.getGridSlot(0);
    c.reset(slot.pos, slot.heading, true, (slot.checkpointIdx + 1) % gp.checkpoints.length);
    c.mistakesEnabled = false; c.isRaceMode = true; c.updateDimensionsForTrackWidth(gp.width);
    let switches = 0, frames = 0, braking = 0, wasOn = false;
    for (let i = 0; i < 90 * 60 && c.isAlive; i++) {
      c.updateSensors(gp);
      const control = c.planDrive(gp).expert;
      const on = control.brake > 0.02;
      if (i > 0 && on !== wasOn) switches++;
      wasOn = on; frames++; if (on) braking++;
      c.updatePhysics(control, 1 / 60, gp);
    }
    assert.ok(c.isAlive && c.currentLap >= 1, `the expert must lap the GP circuit: ${JSON.stringify({ alive: c.isAlive, reason: c.eliminationReason, laps: c.currentLap, frames, cp: c.currentCheckpointIdx })}`);
    assert.ok(braking > 0, 'the expert never braked');
    assert.ok(switches / (frames / 60) < 2, `expert brake switches ${(switches / (frames / 60)).toFixed(1)} times per second`); }
  // Steering actuator: a step in the command starts the road wheels moving gently (no jump into
  // motion), settles without overshoot and gives the same angle at every step rate.
  { const wheelAfter = (dt, seconds) => { const c = new Car(new Vector2(0, 0), 0); c.vel = new Vector2(30, 0); c.speed = 30;
      const angles = [];
      for (let t = 0; t < Math.round(seconds / dt); t++) { c.timeSinceCheckpoint = 0; c.updatePhysics({ throttle: 0, brake: 0, steer: 0.5 }, dt, stub); angles.push(c.wheelAngle); }
      return angles; };
    const target = 0.5 * new Car(new Vector2(0, 0), 0).maxSteerAngle;
    const at = [1 / 30, 1 / 60, 1 / 120].map(dt => wheelAfter(dt, 0.1).at(-1));
    assert.ok(at.every(x => Math.abs(x - at[1]) < 1e-9), `road-wheel angle depends on the step: ${at}`);
    const fine = wheelAfter(1 / 120, 0.5);
    // One 1/120 s step covers 1.5% of the way (a single 0.09 s lag covered 8.8%).
    assert.ok(fine[0] < target * 0.03, `the wheels jump into motion: ${fine[0]} rad after one step`);
    assert.ok(fine[1] - fine[0] > fine[0], 'the wheels must speed up from rest');
    assert.ok(fine.every((x, i) => x <= target + 1e-12 && (i === 0 || x >= fine[i - 1])), 'the wheels overshoot or swing back');
    assert.ok(Math.abs(fine.at(-1) - target) < target * 0.01, `wheels not settled after 0.5 s: ${fine.at(-1)} of ${target}`); }
  // The expert steers smoothly: the road wheels never snap (that was over 6800 deg/s² at 60 Hz and
  // 14500 at 120 Hz, from a first-order actuator and a pursuit loop faster than the steering lag).
  for (const hz of [60, 120]) {
    const c = new Car(gp.startPosition, gp.startAngle, null, '#fff', 'teacher', 60);
    const slot = gp.getGridSlot(0);
    c.reset(slot.pos, slot.heading, true, (slot.checkpointIdx + 1) % gp.checkpoints.length);
    c.mistakesEnabled = false; c.updateDimensionsForTrackWidth(gp.width);
    let lastAngle = c.wheelAngle, lastRate = null, maxAccel = 0;
    for (let i = 0; i < 60 * hz && c.isAlive; i++) {
      c.updateSensors(gp);
      c.updatePhysics(c.planDrive(gp).expert, 1 / hz, gp);
      const rate = (c.wheelAngle - lastAngle) * hz;
      if (i > 5 * hz && lastRate !== null) maxAccel = Math.max(maxAccel, Math.abs(rate - lastRate) * hz * 180 / Math.PI);
      lastAngle = c.wheelAngle; lastRate = rate;
    }
    assert.ok(c.isAlive, `the expert crashed at ${hz} Hz: ${c.eliminationReason}`);
    assert.ok(maxAccel < (hz === 60 ? 4000 : 6000), `road wheels snap at ${maxAccel.toFixed(0)} deg/s² (${hz} Hz)`);
  }

  // 5. Impacts: damage accumulates up to 1, gentle contact does not wreck, hard contact does and the wreck keeps sliding.
  const body = (x, vx) => { const c = new Car(new Vector2(x, 0), 0); c.vel = new Vector2(vx, 0); c.speed = Math.abs(vx); c.isRaceMode = true; return c; };
  let a = body(0, 20), b = body(20, 12), m = captureMotion([a, b]); a.pos.x = 15; b.pos.x = 20.5;
  resolveTraffic([a, b], m);
  assert.ok(a.isAlive && b.isAlive && a.damage > 0 && a.damage < 1, 'an 8 m/s contact damages but does not wreck');
  // A touch under CONTACT_DAMAGE_MIN_SPEED leaves no damage; repeated medium hits saturate damage without a wreck.
  a = body(0, 14); b = body(20, 12); m = captureMotion([a, b]); a.pos.x = 15; b.pos.x = 20.5;
  resolveTraffic([a, b], m);
  assert.ok(a.isAlive && a.damage === 0 && b.damage === 0, 'a 2 m/s touch must not damage');
  const worn = body(0, 0);
  for (let k = 0; k < 6; k++) worn.addImpactDamage(8);
  assert.ok(worn.isAlive && worn.damage === 1, 'accumulated damage saturates at 1 and never wrecks the car');
  // Damage reduces downforce => lower cornering limit.
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
  const at = gp.checkpoints[40].index, road = gp.points[at], fence = gp.runoff[at].leftBarrier;
  const probe = (inward) => { const c = new Car(fence.sub(road.normal.mul(1.0)), road.tangent.heading()); c.vel = road.tangent.mul(40).add(road.normal.mul(inward)); c.speed = c.vel.mag();
    const before = c.vel.dot(road.tangent); for (let i = 0; i < 6 && c.isAlive; i++) { c.timeSinceCheckpoint = 0; c.updatePhysics(idle, 1 / 60, gp); }
    return { alive: c.isAlive, along: c.vel.dot(road.tangent) / before, c }; };
  const graze = probe(1.5), hit = probe(8);
  assert.ok(graze.alive && graze.along > 0.8, 'a graze keeps most speed: ' + graze.along);
  assert.ok(hit.along < graze.along);
  // Limit probing: a probe that improves the median raises the margin, an excursion backs off and caps it.
  const pace = new PaceSearch();
  [60, 60, 60, 59.5, 59.5, 59.5, 59, 59, 59, 59].forEach(t => pace.finishLap(t, true, false));
  assert.ok(pace.bestMargin > 1.05, 'margin grows on clean faster laps: ' + pace.bestMargin);
  pace.finishLap(59, true, false);
  assert.ok(pace.margin > pace.bestMargin, 'and probes on');
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
  const pedalCar = new Car(gp.startPosition, gp.startAngle, new NeuralNetwork([driverInputCount(25), 4, 3]), '#fff', 'pedals', 60, 25);
  pedalCar.vel = Vector2.fromAngle(pedalCar.heading).mul(30); pedalCar.speed = 30;
  pedalCar.updatePhysics({ throttle: 1, brake: 0.5, steer: 0 }, 1 / 60, gp);
  assert.equal(pedalCar.currentControl.throttle, 0, 'throttle and brake never together');
  pedalCar.updatePhysics({ throttle: 0.6, brake: 0.01, steer: 0 }, 1 / 60, gp);
  assert.equal(pedalCar.currentControl.brake, 0, 'a token brake is dropped');
  // Learned racing line: per-section trims judged on section clocks, network candidates on two laps.
  const S = LineNet.SECTIONS, points = S * 2;
  /** Drive a lap through `points` track points; `section(i)` is the time spent in section i. */
  const lapWith = (net, section) => {
    let t = 0;
    for (let p = 0; p < points; p++) { net.passPoint(p, points, t); t += section(Math.floor(p / 2)) / 2; }
    net.passPoint(0, points, t);
    return net.finish(t, true);
  };
  const lineNet = new LineNet(new NeuralNetwork([25 + 7, 6, 1]));
  lapWith(lineNet, () => 4); // measures the seed line (section 0 has no start time on the first lap)
  assert.equal(lineNet.mode, 'trim', 'after measuring the champion the next lap moves a section');
  const moved = [...lineNet.mutated];
  assert.ok(moved.length >= 1 && moved.every(k => lineNet.currentTrim[k] !== 0), 'trim candidate moves the line');
  const span = new Set(moved.flatMap(k => [(k - 1 + S) % S, k, (k + 1) % S]));
  assert.equal(lapWith(lineNet, i => span.has(i) ? 3.9 : 4), false, 'one lap is not enough for a section move');
  assert.equal(lapWith(lineNet, i => span.has(i) ? 3.9 : 4), true, 'faster section neighbourhood keeps the move');
  assert.ok(moved.every(k => lineNet.bestTrim[k] !== 0), 'accepted trims become the champion line');
  assert.equal(lineNet.mode, 'network');
  const champion = lineNet.best;
  assert.equal(lapWith(lineNet, () => 3.9), false, 'one fast lap is not enough for a network candidate');
  assert.equal(lineNet.best, champion);
  assert.equal(lapWith(lineNet, () => 4.2), false, 'two-lap mean slower than the champion: rejected');
  assert.equal(lineNet.best, champion, 'slower candidate rejected');
  lapWith(lineNet, () => 4); // champion re-measure
  const trimBefore = lineNet.bestTrim.slice();
  lapWith(lineNet, () => 4.5); lapWith(lineNet, () => 4.5); // slower trim candidate
  assert.deepEqual(Array.from(lineNet.bestTrim), Array.from(trimBefore), 'slower section moves are discarded');
  assert.equal(lapWith(lineNet, () => 3.8), false);
  assert.equal(lapWith(lineNet, () => 3.8), true, 'faster network candidate becomes champion');
  assert.notEqual(lineNet.best, champion);
  assert.ok(lineNet.bestTime < S * 3.9, 'champion time follows the candidate mean: ' + lineNet.bestTime);
  // A team-mate's faster line is evaluated next and adopted only if it is faster for this car too.
  const mate = new LineNet(new NeuralNetwork([25 + 7, 6, 1]));
  mate.bestTrim.fill(1.5);
  lineNet.propose(mate);
  assert.ok(lineNet.hasProposal);
  lapWith(lineNet, () => 3.8);
  assert.equal(lineNet.mode, 'network', 'proposal evaluated as a candidate');
  assert.ok(Array.from(lineNet.currentTrim).every(v => v === 1.5));
  lapWith(lineNet, () => 3.7); lapWith(lineNet, () => 3.7);
  assert.ok(Array.from(lineNet.bestTrim).every(v => v === 1.5), 'faster proposal adopted');
  assert.equal(lineNet.hasProposal, false);
  // A reset mid-lap leaves no section clock: the trim lap falls back to the whole-lap time.
  const reset = new LineNet(new NeuralNetwork([25 + 7, 6, 1]));
  lapWith(reset, () => 4);
  const resetMoved = [...reset.mutated];
  for (let p = 0; p < points / 2; p++) reset.passPoint(p, points, p);
  reset.resetTiming();
  assert.equal(reset.finish(S * 5, true), false);
  reset.resetTiming();
  assert.equal(reset.finish(S * 5, true), false, 'slower whole laps reject the move');
  assert.ok(resetMoved.every(k => reset.bestTrim[k] === 0));
  // Sections are bounded and interpolated; racing uses the champion.
  const racingTarget = lineNet.target(gp, { pos: gp.startPosition, heading: gp.startAngle, speed: 50, rayDistances: new Array(25).fill(1) }, true);
  assert.ok(Number.isFinite(racingTarget) && Math.abs(racingTarget) <= LineNet.MAX_DELTA + LineNet.MAX_TRIM);
  assert.ok(lineInputs(gp, { pos: gp.startPosition, heading: gp.startAngle, speed: 20, rayDistances: new Array(25).fill(1) }).length === 32);
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
  savedLine.bestTrim[3] = -1.25; const trimmed = new LineNet(new NeuralNetwork([32, 6, 1]));
  assert.ok(trimmed.fromJSON(JSON.parse(JSON.stringify(savedLine.toJSON()))));
  assert.equal(trimmed.bestTrim[3], -1.25, 'section trims survive save/restore');
  assert.ok(new LineNet(new NeuralNetwork([32, 6, 1])).fromJSON({ ...savedLine.toJSON(), bestTrim: undefined }), 'older saves without trims still load');
  assert.equal(new LineNet(new NeuralNetwork([20, 6, 1])).fromJSON(savedLine.toJSON()), false, 'different sensor layout is ignored');
  // Track limits: only an excursion with all four wheels off the asphalt counts, once per exit.
  const limitCar = new Car(gp.startPosition, gp.startAngle, new NeuralNetwork([driverInputCount(25), 4, 3]), '#fff', 'limits', 60, 25);
  const centre = gp.checkpoints[10], normal = centre.tangent.normal();
  const place = lateral => { limitCar.pos = centre.center.add(normal.mul(lateral)); limitCar.heading = centre.tangent.heading(); limitCar.vel = centre.tangent.mul(1); limitCar.speed = 1; limitCar.isAlive = true; limitCar.updatePhysics(idle, 1 / 600, gp); };
  place(gp.width / 2 - 1.2); // one side of the car over the edge only
  assert.equal(limitCar.trackLimitExits, 0, 'two wheels over the edge are not an exit');
  place(gp.width / 2 + 6); place(gp.width / 2 + 6);
  assert.equal(limitCar.trackLimitExits, 1, 'all four wheels off counts once');
  place(0); place(gp.width / 2 + 6);
  assert.equal(limitCar.trackLimitExits, 2, 'a second excursion counts again');
  // ERS: wide-open throttle drains the battery, braking harvests, and depletion costs power.
  const ersCar = new Car(gp.startPosition, gp.startAngle, new NeuralNetwork([driverInputCount(25), 4, 3]), '#fff', 'ers', 60, 25);
  const speedUp = (energy, steps) => { ersCar.reset(gp.startPosition, gp.startAngle, true, 1); ersCar.ersEnergy = energy; ersCar.vel = Vector2.fromAngle(ersCar.heading).mul(75); ersCar.speed = 75; for (let i = 0; i < steps; i++) ersCar.updatePhysics({ throttle: 1, brake: 0, steer: 0 }, 1 / 60, gp); return ersCar.speed; };
  const charged = speedUp(Car.ERS_CAPACITY, 15), chargedEnergy = ersCar.ersEnergy;
  const empty = speedUp(0, 15);
  assert.ok(chargedEnergy < Car.ERS_CAPACITY, 'deployment drains the battery');
  assert.ok(charged > empty + 0.1, `hybrid boost accelerates harder: ${charged} vs ${empty}`);
  // Standing start on a flat straight: 0-100 km/h is traction-limited (~2.5 s, as an F1 car), the
  // MGU-K adds only the torque the rear tyres can use, then deploys its full 350 kW above 40% charge.
  {
    const flat = { checkpoints: [], timingGates: [], width: 76, isOutOfBounds: () => false };
    const origin = { x: 0, y: 0, clone() { return this; } };
    const launch = soc => {
      const c = new Car(origin, 0);
      c.pos = c.vel.clone(); c.prevPos = c.vel.clone();
      c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1;
      c.ersEnergy = Car.ERS_CAPACITY * soc;
      const at = {}; let t = 0, energyAt100 = null;
      for (let i = 0; i < 60 * 12; i++) {
        c.timeSinceCheckpoint = 0;
        c.updatePhysics({ throttle: 1, brake: 0, steer: 0 }, 1 / 60, flat);
        t += 1 / 60;
        for (const kmh of [100, 200, 300]) if (at[kmh] === undefined && c.speedKmh >= kmh) at[kmh] = t;
        if (energyAt100 === null && at[100] !== undefined) energyAt100 = c.ersEnergy;
      }
      return { at, used100: Car.ERS_CAPACITY * soc - energyAt100 };
    };
    const full = launch(0.85), half = launch(0.5);
    assert.ok(full.at[100] > 2.35 && full.at[100] < 2.65, `0-100 km/h ${full.at[100].toFixed(2)} s`);
    assert.ok(full.at[200] < 4.85, `0-200 km/h ${full.at[200].toFixed(2)} s`);
    assert.ok(full.at[300] < 9, `0-300 km/h ${full.at[300]?.toFixed(2)} s`);
    assert.ok(half.at[200] < 4.85, `0-200 km/h at 50% charge ${half.at[200].toFixed(2)} s`);
    // A traction-limited launch must not burn the battery for nothing (350 kW for 2.5 s would be 875 kJ).
    assert.ok(full.used100 < 300000, `MGU-K energy to 100 km/h: ${Math.round(full.used100 / 1000)} kJ`);
  }
  ersCar.reset(gp.startPosition, gp.startAngle, true, 1); ersCar.ersEnergy = 1e6; ersCar.vel = Vector2.fromAngle(ersCar.heading).mul(60); ersCar.speed = 60;
  for (let i = 0; i < 30; i++) ersCar.updatePhysics({ throttle: 0, brake: 0.8, steer: 0 }, 1 / 60, gp);
  assert.ok(ersCar.ersEnergy > 1e6, 'braking harvests energy');
  // Half a second at brake 0.8 from 60 m/s recovers well above the old 120 kW-limited ~44 kJ.
  assert.ok(ersCar.ersEnergy - 1e6 > 100000, 'strong braking harvests up to ERS_HARVEST_POWER: ' + (ersCar.ersEnergy - 1e6));
  assert.ok(ersCar.ersEnergy - 1e6 <= Car.ERS_HARVEST_POWER * Car.ERS_REGEN_EFFICIENCY * 0.5 + 1, 'harvest stays within the MGU-K limit');
  // Energy balance: harvesting turns motion into charge, never creates it. With an empty tank and no
  // pedals, kinetic plus battery energy only falls; lifting with harvest room slows the car more than
  // lifting with a spent allowance; a full battery takes nothing and adds no drag.
  { const coast = (allowance, energy, fuel = 50) => {
      const c = new Car(new Vector2(0, 0), 0); c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1;
      c.vel = new Vector2(60, 0); c.speed = 60; c.fuelKg = fuel; c.gear = 6; c.engineRpm = 9000;
      c.ersEnergy = energy; c.ersHarvestedLap = Car.ERS_LAP_HARVEST - allowance;
      const e0 = 0.5 * c.totalMass * c.speed ** 2 + c.ersEnergy;
      for (let i = 0; i < 60; i++) { c.timeSinceCheckpoint = 0; c.updatePhysics(idle, 1 / 60, stub); }
      return { speed: c.speed, gained: c.ersEnergy - energy, balance: 0.5 * c.totalMass * c.speed ** 2 + c.ersEnergy - e0 }; };
    const harvesting = coast(Car.ERS_LAP_HARVEST, 1e6), spent = coast(0, 1e6), full = coast(Car.ERS_LAP_HARVEST, Car.ERS_CAPACITY), empty = coast(Car.ERS_LAP_HARVEST, 1e6, 0);
    assert.ok(harvesting.gained > 50000 && spent.gained === 0 && full.gained === 0, `lift-and-coast harvest ${Math.round(harvesting.gained / 1000)} kJ`);
    assert.ok(harvesting.speed < spent.speed - 0.5, `the MGU-K brakes the car it charges: ${harvesting.speed.toFixed(2)} vs ${spent.speed.toFixed(2)} m/s`);
    assert.equal(full.speed, spent.speed, 'a full battery adds no drag');
    assert.ok(empty.balance < 0 && harvesting.balance < 0, `kinetic + battery energy falls without fuel: ${Math.round(empty.balance)} J`); }
  // 2026 rules: no more than ERS_LAP_HARVEST recovered between two crossings of the line.
  ersCar.reset(gp.startPosition, gp.startAngle, true, 1);
  let recovered = 0;
  for (let cycle = 0; cycle < 120; cycle++) {
    ersCar.ersEnergy = 0; ersCar.vel = Vector2.fromAngle(ersCar.heading).mul(80); ersCar.speed = 80; ersCar.isAlive = true;
    for (let i = 0; i < 30; i++) { ersCar.updatePhysics({ throttle: 0, brake: 1, steer: 0 }, 1 / 60, stub); ersCar.timeSinceCheckpoint = 0; }
    recovered += ersCar.ersEnergy;
  }
  assert.ok(recovered <= Car.ERS_LAP_HARVEST + 1 && recovered > Car.ERS_LAP_HARVEST * 0.95, 'per-lap harvest limit: ' + recovered);
  // A flat battery stops deployment and super-clips on full throttle.
  ersCar.reset(gp.startPosition, gp.startAngle, true, 1); ersCar.ersEnergy = Car.ERS_CAPACITY * 0.05;
  ersCar.vel = Vector2.fromAngle(ersCar.heading).mul(70); ersCar.speed = 70;
  // Clipping takes ICE output, so it waits until the gearbox has shifted up from the reset (no power on the limiter or in a shift).
  let deployed = false;
  for (let i = 0; i < 120; i++) { ersCar.updatePhysics({ throttle: 1, brake: 0, steer: 0 }, 1 / 60, stub); ersCar.timeSinceCheckpoint = 0; deployed ||= ersCar.ersDeploying; }
  assert.ok(!deployed && ersCar.ersEnergy > Car.ERS_CAPACITY * 0.05, 'flat battery clips instead of deploying');
  // Off-track: an AI car parked on the runoff keeps trying to rejoin for OFF_TRACK_RECOVERY_TIME, then retires.
  const offCar = new Car(gp.startPosition, gp.startAngle, new NeuralNetwork([driverInputCount(25), 4, 3]), '#fff', 'off', 60, 25);
  offCar.reset(gp.startPosition, gp.startAngle, true, 1);
  const offSample = gp.sampleSurface(gp.startPosition);
  offCar.pos = offSample.center.add(offSample.tangent.normal().mul(gp.width / 2 + 2.5));
  offCar.vel = new Vector2(0, 0); offCar.speed = 0;
  const parked = { throttle: 0, brake: 1, steer: 0 };
  for (let i = 0; i < 60 * 10; i++) { offCar.updatePhysics(parked, 1 / 60, gp); offCar.timeSinceCheckpoint = 0; }
  assert.ok(offCar.surface !== 'asphalt', 'test car is on the runoff: ' + offCar.surface);
  assert.ok(offCar.isAlive, 'ten seconds off track is still within the recovery window');
  for (let i = 0; i < 60 * 3 && offCar.isAlive; i++) { offCar.updatePhysics(parked, 1 / 60, gp); offCar.timeSinceCheckpoint = 0; }
  assert.equal(offCar.eliminationReason, 'stuck', 'more than twelve seconds off track retires the car');
  // Tyres: bell-shaped thermal window, heating and wear, the same in training and the race.
  assert.ok(Math.abs(Car.tyreGrip(Car.TYRE_OPTIMUM, 0) - 1) < 1e-9, 'full grip at the optimum');
  assert.ok(Car.tyreGrip(60, 0) < 0.9 && Car.tyreGrip(150, 0) < 0.9, 'cold and overheated tyres lose grip');
  assert.ok(Car.tyreGrip(100, 1) < Car.tyreGrip(100, 0.3), 'wear lowers grip');
  const tyreCar = new Car(gp.startPosition, gp.startAngle, new NeuralNetwork([driverInputCount(25), 4, 3]), '#fff', 'tyres', 60, 25);
  const driveCorner = (race, steps) => { tyreCar.isRaceMode = race; tyreCar.reset(gp.startPosition, gp.startAngle, true, 1); tyreCar.lapPowerFactor = tyreCar.lapGripFactor = tyreCar.lapDragFactor = 1; tyreCar.vel = Vector2.fromAngle(tyreCar.heading).mul(45); tyreCar.speed = 45; for (let i = 0; i < steps; i++) tyreCar.updatePhysics({ throttle: 0.5, brake: 0, steer: 0.12 }, 1 / 60, stub); };
  driveCorner(false, 120);
  const training = { temp: tyreCar.tyreTempFront, wear: tyreCar.tyreWearFront };
  assert.ok(training.temp !== Car.TYRE_OPTIMUM && training.wear > 0, 'training tyres heat up and wear: ' + training.temp);
  driveCorner(true, 120);
  assert.ok(tyreCar.tyreTempFront === training.temp && tyreCar.tyreWearFront === training.wear, 'race tyres heat up and wear exactly as in training: ' + tyreCar.tyreTempFront);
  // Compounds: soft > medium > hard in grip and the reverse in wear; treaded tyres win only on a wet track.
  const peak = (c, w = 0) => Car.tyreGrip(COMPOUND_SPECS[c].optimum, 0, c, w);
  assert.ok(Math.abs(peak('medium') - 1) < 1e-9, 'a dry medium is the calibrated reference');
  assert.ok(peak('soft') > peak('medium') && peak('medium') > peak('hard'), 'soft grips most, hard least');
  assert.ok(peak('hard') > peak('intermediate') && peak('intermediate') > peak('wet'), 'treaded tyres are slow in the dry');
  assert.ok(peak('intermediate', 0.5) > peak('soft', 0.5) && peak('intermediate', 0.5) > peak('wet', 0.5), 'intermediates rule a damp track');
  assert.ok(peak('wet', 1) > peak('intermediate', 1) && peak('intermediate', 1) > peak('soft', 1), 'full wets rule a soaked track');
  assert.equal(weatherCompound(0, 'soft'), 'soft'); assert.equal(weatherCompound(0.5, 'soft'), 'intermediate'); assert.equal(weatherCompound(1, 'hard'), 'wet');
  assert.ok(wrongForConditions('soft', 1) && wrongForConditions('wet', 0) && !wrongForConditions('hard', 0), 'wrong tyres for the weather are recognised');
  // A corner every compound holds (a hard tyre at 0.12 slides and overheats, which is a different test).
  const stint = (compound, wetness, steer = 0.1) => {
    Car.config.weather.wetness = wetness;
    tyreCar.isRaceMode = true; tyreCar.reset(gp.startPosition, gp.startAngle, true, 1); tyreCar.tyreCompound = compound;
    tyreCar.lapPowerFactor = tyreCar.lapGripFactor = tyreCar.lapDragFactor = 1; // the compound alone, not this lap's spread
    tyreCar.vel = Vector2.fromAngle(tyreCar.heading).mul(45); tyreCar.speed = 45;
    for (let i = 0; i < 240; i++) tyreCar.updatePhysics({ throttle: 0.5, brake: 0, steer }, 1 / 60, stub);
    Car.config.weather.wetness = 0;
    return { wear: tyreCar.tyreWearFront, temp: tyreCar.tyreTempFront };
  };
  assert.ok(stint('soft', 0).wear > stint('medium', 0).wear && stint('medium', 0).wear > stint('hard', 0).wear, 'softer compounds wear faster');
  assert.ok(stint('medium', 1, 0).temp < stint('medium', 0, 0).temp, 'a wet track cools the tyres');
  assert.ok(stint('wet', 1, 0).wear < stint('wet', 0, 0).wear, 'full wets wear less on water than on a dry track');
  // Pit stops fit the player's request, else the next slick or the tyre for the weather.
  tyreCar.isRaceMode = true; tyreCar.reset(gp.startPosition, gp.startAngle, true, 1);
  assert.equal(tyreCar.tyreCompound, 'medium'); assert.equal(tyreCar.pitCompound(), 'hard');
  Car.config.weather.wetness = 0.9; assert.equal(tyreCar.pitCompound(), 'wet');
  tyreCar.nextCompound = 'soft'; assert.equal(tyreCar.pitCompound(), 'soft');
  Car.config.weather.wetness = 0; tyreCar.isRaceMode = false; Car.config.weather.wetness = 1;
  assert.equal(tyreCar.wetness, 1, 'training drives in the weather too');
  tyreCar.reset(gp.startPosition, gp.startAngle, true, 1);
  assert.equal(tyreCar.tyreCompound, 'wet', 'a training car on a soaked track gets full wets'); Car.config.weather.wetness = 0;
  // Gearbox: 8 ratios, limiter-bound top speed, shift-cut and real gear/rpm bookkeeping.
  const gearCar = new Car(gp.startPosition, gp.startAngle, new NeuralNetwork([driverInputCount(25), 4, 3]), '#fff', 'gears', 60, 25);
  const gearsSeen = new Set(); let maxRpm = 0, cutSteps = 0, prevGear = 1;
  for (let i = 0; i < 60 * 45; i++) {
    gearCar.timeSinceCheckpoint = 0; // no checkpoints on the stub track
    gearCar.ersEnergy = Car.ERS_CAPACITY; // charged battery: top speed set by drag, MGU-K taper and gearing
    gearCar.updatePhysics({ throttle: 1, brake: 0, steer: 0 }, 1 / 60, stub);
    gearsSeen.add(gearCar.gear); maxRpm = Math.max(maxRpm, gearCar.engineRpm);
    if (gearCar.gear > prevGear) cutSteps++; prevGear = gearCar.gear;
  }
  assert.equal(gearCar.gear, 8, 'reaches top gear');
  assert.ok(gearsSeen.size === 8, 'uses all eight gears: ' + [...gearsSeen]);
  assert.ok(maxRpm <= Car.REV_LIMIT + 1, 'never beyond the limiter: ' + maxRpm);
  assert.ok(cutSteps >= 7, 'upshifts happened');
  assert.ok(gearCar.speed > 90 && gearCar.speed < 108, 'top speed set by drag, MGU-K taper and the rev limit: ' + gearCar.speed);
  assert.ok(Car.GEAR_RATIOS[1] > Car.GEAR_RATIOS[2] && Car.GEAR_RATIOS[7] > Car.GEAR_RATIOS[8], 'ratios fall with gear');
  assert.ok(Car.icePowerFraction(4000) < Car.icePowerFraction(9000) && Math.abs(Car.icePowerFraction(12000) - 1) < 1e-9, 'power band');
  // Ride-height aero: normalised to ~1 at cornering heights, penalised when the floor chokes, heights fall with speed.
  assert.ok(Math.abs(Car.rideHeightLift(0.0244, 0.0464) - 1) < 0.03, 'unit lift at a typical cornering height');
  assert.ok(Car.rideHeightLift(0.004, 0.010) < Car.rideHeightLift(0.016, 0.032), 'a choked floor loses downforce');
  assert.ok(gearCar.rideHeightFront < Car.FRH_STATIC && gearCar.rideHeightRear < Car.RRH_STATIC, 'downforce compresses the axles at speed');
  // Network inputs: rays + 5 driving inputs + 8 vehicle-state inputs that follow the car.
  const inputCar = new Car(gp.startPosition, gp.startAngle, new NeuralNetwork([driverInputCount(25), 4, 3]), '#fff', 'inputs', 60, 25);
  inputCar.updateDimensionsForTrackWidth(gp.width); inputCar.updateSensors(gp);
  inputCar.tyreTempFront = 140; inputCar.tyreTempRear = 60; inputCar.tyreWearFront = 0.4; inputCar.ersEnergy = Car.ERS_CAPACITY / 2; inputCar.gear = 4;
  const planned = inputCar.planDrive(gp).inputs;
  assert.equal(planned.length, driverInputCount(25));
  const vehicleState = planned.slice(-8);
  assert.deepEqual([vehicleState[0], vehicleState[1]], [1, 0], 'tyre temperatures are normalised and clamped');
  assert.ok(Math.abs(vehicleState[2] - 0.4) < 1e-9 && Math.abs(vehicleState[3] - 0.5) < 1e-9 && vehicleState[4] === 0.5, 'wear, ERS and gear: ' + vehicleState);
  assert.ok(Math.abs(vehicleState[6] - 1 / 1.5) < 1e-9 && Math.abs(vehicleState[7] - 1 / 1.5) < 1e-9, 'static ride heights: ' + vehicleState);
  // Checkpoint rewards do not depend on the lateral position: the racing line may use the whole road.
  {
    const n = gp.checkpoints.length;
    const straight = gp.checkpoints.findIndex((cp, i) => i > 5 && [-2, -1, 0, 1].every(d => Math.abs(gp.checkpoints[(i + d + n) % n].curvature) < 0.001));
    assert.ok(straight > 0, 'GP preset has a straight');
    const gain = lateral => {
      const cp = gp.checkpoints[straight], before = gp.checkpoints[(straight - 1 + n) % n];
      const car = makeCar(constant(0, 0, 0));
      const start = before.center.add(cp.center.sub(before.center).mul(0.7)).add(cp.tangent.normal().mul(lateral));
      car.reset(start, cp.tangent.heading(), true, straight);
      car.mistakesEnabled = false; car.vel = cp.tangent.mul(30); car.speed = 30; car.fitness = 0;
      for (let i = 0; i < 60 && car.currentCheckpointIdx === straight; i++) car.updatePhysics(idle, 1 / 60, gp);
      assert.notEqual(car.currentCheckpointIdx, straight, 'checkpoint cleared');
      return car.fitness;
    };
    const centre = gain(0), edge = gain(gp.width / 2 - 2);
    assert.ok(Math.abs(centre - edge) < 40, `edge of the road scores like the centre: ${centre} vs ${edge}`);
  }
  console.log('Neural driving, dynamics, damage and wreck regressions passed.');
} finally { await rm(dir, { recursive: true, force: true }); }
