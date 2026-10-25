// Session parity: training drives under the race's rules (only learning bookkeeping differs). A crash leaves a wreck under yellow for
// 15 s before the respawn, cars tow, defend and attack, stress laps run in every session (timed in
// the race), and training respawns carry race fuel loads.
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'f1-parity-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: dir, lib: { entry: {
    car: resolve('src/physics/Car.ts'), vector: resolve('src/math/Vector2.ts'), race: resolve('src/ai/RaceTraffic.ts'),
    track: resolve('src/track/Track.ts'), population: resolve('src/ai/Population.ts'), battle: resolve('src/ai/BattlePush.ts'),
    timing: resolve('src/physics/LapTiming.ts'), presets: resolve('src/track/Presets.ts'), fuel: resolve('src/race/RaceFuel.ts'), session: resolve('src/race/RaceSession.ts'),
  }, formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const load = name => import(pathToFileURL(join(dir, name + '.mjs')));
  const { Car } = await load('car');
  const { Vector2 } = await load('vector');
  const { planRaceLine, updateRaceSafety, WRECK_CLEAR_SECONDS } = await load('race');
  const { Track } = await load('track');
  const { Population } = await load('population');
  const { BattlePush } = await load('battle');
  const { timeSector } = await load('timing');
  const fuel = await load('fuel');
  const { RaceSession } = await load('session');
  const { Presets } = await load('presets');
  const dt = 1 / 60;

  // A long rectangle: straights of 600 m, corners at both ends.
  const raw = [[0,0],[100,0],[200,0],[300,0],[400,0],[500,0],[600,0],[600,200],[500,200],[400,200],[300,200],[200,200],[100,200],[0,200]].map(p => new Vector2(...p));
  const points = raw.map((center, i) => { const tangent = raw[(i + 1) % raw.length].sub(raw[(i + raw.length - 1) % raw.length]).normalize(), normal = tangent.normal();
    return { center, tangent, normal, left: center.add(normal.mul(7)), right: center.sub(normal.mul(7)), curvature: [0, 6, 7, 13].includes(i) ? .01 : 0 }; });
  const circuit = new Track(points, 14);
  const car = (x, y, v = 0) => { const c = new Car(new Vector2(x, y), 0); c.vel = new Vector2(v, 0); c.speed = v; c.currentCheckpointIdx = 2; c.mistakesEnabled = false; return c; };

  // 1. Training: a crashed car stays a wreck for WRECK_CLEAR_SECONDS under a local yellow, then respawns.
  {
    const training = new Population(2, circuit);
    assert.equal(training.isRaceMode, false);
    const [approach, crashed] = training.cars;
    for (const c of training.cars) { c.reset(new Vector2(150, 0), 0, true, 2); c.isManual = true; c.manualControl = { throttle: 0, brake: 0, steer: 0 }; }
    crashed.pos = new Vector2(300, 0);
    crashed.eliminate('barrier', 1);
    let steps = 0;
    for (; steps < (WRECK_CLEAR_SECONDS - 0.1) / dt; steps++) {
      approach.timeSinceCheckpoint = 0;
      training.update(dt, circuit);
      assert.equal(crashed.isAlive, false, `training respawned the wreck after ${(steps * dt).toFixed(2)} s`);
    }
    assert.equal(crashed.wreckRemoved, false, 'the wreck left before the marshals arrived');
    assert.equal(approach.yellowFlag, true, 'a training wreck must show a local yellow');
    for (let k = 0; k < 0.4 / dt; k++) { approach.timeSinceCheckpoint = 0; training.update(dt, circuit); }
    assert.equal(crashed.isAlive, true, 'the car respawns once the wreck is cleared');
    assert.equal(approach.yellowFlag, false);
    assert.equal(training.allDeadMaxTime > WRECK_CLEAR_SECONDS, true, 'an all-dead cycle must not start before the wrecks clear');
    // The yellow is driven the same everywhere; only a race lap is spoilt by it (learning bookkeeping).
    const trainee = car(150, 0, 30), racer = car(150, 3, 30), wreck = car(300, 0);
    racer.isRaceMode = true;
    wreck.isAlive = false;
    trainee.lapCompromised = racer.lapCompromised = false;
    updateRaceSafety([trainee, racer, wreck], circuit, dt);
    assert.ok(trainee.yellowFlag && racer.yellowFlag);
    assert.equal(trainee.lapCompromised, false, 'a training lap under yellow still evaluates the model');
    assert.equal(racer.lapCompromised, true, 'a race lap under yellow is not a reference lap');
  }

  // 2. Wheel-to-wheel in training (isRaceMode false everywhere below).
  {
    // Tow on a long straight: the follower sits behind the leader's lateral position and does not pull out at 25 m.
    const follower = car(150, 0, 40), leader = car(175, 2, 40);
    for (let k = 0; k < 90; k++) planRaceLine(follower, [follower, leader], circuit, dt);
    assert.equal(follower.overtakingTargetName, '', 'a car in the tow pulls out only close behind');
    assert.ok(Math.abs(follower.raceLineOffset - 2) < 0.3, `no tow in training: offset ${follower.raceLineOffset.toFixed(2)}`);
    // Close behind it pulls out to pass, and that lap is no longer a reference lap.
    const close = car(160, 2, 40);
    close.lapCompromised = false;
    planRaceLine(close, [close, leader], circuit, dt);
    assert.equal(close.overtakingTargetName, leader.driverName);
    assert.equal(close.lapCompromised, false, 'a training lap with a pass still evaluates the model');
    const racePass = car(160, 2, 40);
    racePass.isRaceMode = true; racePass.lapCompromised = false;
    planRaceLine(racePass, [racePass, leader], circuit, dt);
    assert.equal(racePass.overtakingTargetName, leader.driverName);
    assert.equal(racePass.lapCompromised, true, 'a race lap with a pass is not a reference lap');
    // Defence: before a braking zone with an attacker close behind, one move to the inside (on the GP circuit).
    const gp = Presets.createGrandPrixTrack(14), gpLine = car(0, 0).racingLine(gp);
    const k = gpLine.cornerDistance.findIndex((d, i) => d > 100 && d < 180 && gpLine.cornerSign[i] !== 0);
    assert.ok(k >= 0);
    const at = gp.points[k], heading = at.tangent.heading();
    const defender = car(0, 0, 50), attacker = car(0, 0, 52);
    defender.pos = at.center.clone(); attacker.pos = at.center.sub(at.tangent.mul(12));
    for (const c of [defender, attacker]) { c.heading = heading; c.vel = at.tangent.mul(c.speed); c.updateDimensionsForTrackWidth(14); }
    defender.currentControl = { steer: 0, throttle: 1, brake: 0 };
    const turn = gpLine.cornerSign[k];
    for (let step = 0; step < 60; step++) planRaceLine(defender, [defender, attacker], gp, dt);
    const move = defender.raceLineOffset - defender.raceLineBaseline;
    assert.ok(Math.sign(move) === turn && Math.abs(move) > 0.5, `no defence in training: shift ${move.toFixed(2)}`);
    // Battle push: a rival 20 m ahead on the same stretch starts an attack in training too.
    const pack = new Population(2, circuit);
    const [chaser, rival] = pack.cars;
    chaser.reset(new Vector2(150, 0), 0, true, 2); rival.reset(new Vector2(170, 0), 0, true, 2);
    for (const c of pack.cars) { c.vel = new Vector2(40, 0); c.speed = 40; c.mistakesEnabled = false; }
    chaser.battlePush = new BattlePush(() => 0);
    // A random stress lap (or a pressure change) would spoil the lap on its own.
    chaser.stressLap = false; chaser.pressureLearningBlocked = false; chaser.lapCompromised = false;
    pack.update(dt, circuit);
    assert.ok(chaser.battlePush.remaining > 0, 'no battle push in training');
    assert.equal(chaser.battleOpponent, rival.driverName);
    assert.equal(chaser.lapCompromised, false, 'a training attack does not spoil the lap for learning');
    assert.equal(chaser.replayBuffer.length, 0, 'the pushed expert is no sample to imitate');
  }

  // 3. Stress laps run in every session; in the race their time and sectors count, in training they are not learnt from.
  {
    const share = Car.config.stressLapShare;
    Car.config.stressLapShare = 1;
    const racer = car(150, 0, 40);
    racer.isRaceMode = true;
    racer.lapCompromised = false;
    racer.rollLapPerformanceVariation();
    assert.equal(racer.stressLap, true, 'stress laps must run in the race');
    assert.equal(racer.lapCompromised, false, 'a race stress lap is a valid time');
    racer.flyingLap = true;
    assert.equal(timeSector(racer, 0, 20), 20);
    assert.equal(racer.sectorEvent.valid, true, 'a race stress-lap sector counts');
    racer.updateSensors(circuit);
    assert.notDeepEqual(racer.planDrive(circuit).inputs.slice(0, racer.rayDistances.length), racer.rayDistances, 'the race network must see the same noisy LiDAR');
    const trainee = car(150, 0, 40);
    trainee.lapCompromised = false;
    trainee.rollLapPerformanceVariation();
    assert.equal(trainee.stressLap, true);
    assert.equal(trainee.lapCompromised, true, 'a training stress lap never sets a record');
    trainee.flyingLap = true;
    timeSector(trainee, 0, 20);
    assert.equal(trainee.sectorEvent.valid, false);
    Car.config.stressLapShare = share;
  }

  // 4. Fuel: one plan for the race and training; training respawns draw any race load.
  {
    assert.equal(RaceSession.FUEL_MARGIN, fuel.FUEL_MARGIN);
    assert.equal(RaceSession.FUEL_RESERVE_KG, fuel.FUEL_RESERVE_KG);
    const perLap = 1.8, max = fuel.planRaceFuel(perLap, fuel.TRAINING_RACE_LAPS).fuelKg;
    let low = Infinity, high = -Infinity;
    for (let k = 0; k <= 200; k++) { const kg = fuel.trainingFuelKg(perLap, () => k / 200); low = Math.min(low, kg); high = Math.max(high, kg); }
    assert.equal(low, fuel.TRAINING_MIN_FUEL_KG);
    assert.ok(Math.abs(high - max) < 1e-9 && max > 50 && max <= Car.MAX_FUEL_CAPACITY);
    const training = new Population(1, circuit);
    const [respawn] = training.cars;
    respawn.isAlive = false; respawn.wreckRemoved = true; respawn.respawnTimer = 0;
    training.update(dt, circuit);
    assert.equal(respawn.isAlive, true);
    assert.ok(respawn.fuelKg >= fuel.TRAINING_MIN_FUEL_KG && respawn.fuelKg <= Car.MAX_FUEL_CAPACITY && respawn.fuelKg !== 105, `respawn fuel ${respawn.fuelKg}`);
    assert.equal(respawn.lapStartFuel, respawn.fuelKg);
  }

  console.log('Session parity passed (training wrecks and yellows for 15 s, tow, pass, defence and battle push in training, stress laps timed in the race, race-range training fuel).');
} finally {
  await rm(dir, { recursive: true, force: true });
}
