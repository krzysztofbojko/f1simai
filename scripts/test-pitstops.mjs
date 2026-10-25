// Pit stops: the strategy (wear, conditions, the dry-race tyre rule, closed last laps), the pit
// lane (beside the track, the speed limit, the team boxes, the time from the entry to the exit
// line, timing in the lane, the same at any step rate, rejoining only into a clear track), the
// service time (crew, damage, slow stops, double stacking), no refuelling and the race fuel.
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'f1-pits-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: dir, emptyOutDir: true, minify: false, lib: { entry: {
    car: resolve('src/physics/Car.ts'), pits: resolve('src/physics/PitStrategy.ts'), presets: resolve('src/track/Presets.ts'),
    population: resolve('src/ai/Population.ts'), session: resolve('src/race/RaceSession.ts'), weather: resolve('src/physics/Weather.ts'),
    track: resolve('src/track/Track.ts'), spline: resolve('src/math/Spline.ts'), vector: resolve('src/math/Vector2.ts'), random: resolve('src/math/Random.ts'),
    lane: resolve('src/track/PitLane.ts') },
    formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const load = name => import(pathToFileURL(join(dir, name + '.mjs')));
  const { Car } = await load('car');
  const pits = await load('pits');
  const { Presets } = await load('presets');
  const { Population } = await load('population');
  const { RaceSession } = await load('session');
  const { Weather } = await load('weather');
  const { Track } = await load('track');
  const { Spline, pointGapFor } = await load('spline');
  const { Vector2 } = await load('vector');
  const { seedRandom } = await load('random');
  const { PIT_SPEED_LIMIT } = await load('lane');
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

  // 2. The lane: beside the track on GP and Albert Park, clear of every other stretch of track.
  const { tracks: circuits } = JSON.parse(await readFile(resolve('tracks/index.json'), 'utf8'));
  const melData = JSON.parse(await readFile(resolve('tracks', circuits.find(c => c.file.startsWith('au-1953')).file), 'utf8'));
  const melbourne = new Track(Spline.generateClosedTrack(melData.rawPoints.map(p => new Vector2(p.x, p.y)), melData.trackWidth, true, pointGapFor(melData.pointSpacing)), melData.trackWidth);
  for (const [name, t] of [['GP', track], ['Albert Park', melbourne]]) {
    const lane = t.pitLane;
    assert.ok(lane && lane.entry < lane.limiterStart && lane.limiterStart < lane.boxes[0] && lane.boxes.at(-1) < lane.limiterEnd && lane.limiterEnd < lane.exit, `${name}: entry, limiter, boxes, exit in order`);
    for (let d = lane.limiterStart; d <= lane.limiterEnd; d += 5) {
      const p = lane.point(d, lane.side * lane.laneOffset), here = t.sampleSurface(p);
      const apart = Math.abs(lane.distanceOf(here.index) - d);
      assert.ok(Math.abs(here.lateral) > t.width / 2 + 3 && apart < 30, `${name}: lane ${d} m off the asphalt, beside its own straight`);
    }
  }

  // 3. A stop: in at the entry line, the limit, the team box, the service, out at the exit line.
  const idle = { steer: 0, throttle: 0, brake: 0 };
  const lane = track.pitLane;
  const runStop = (dt, damage = 0.4, team = 2) => {
    seedRandom(11);
    const at = lane.point(lane.entry + 2, 0), heading = track.sampleSurface(at).tangent.heading();
    const c = new Car(at, heading, null, '#fff', 'stopper', 60, 25);
    c.reset(at, heading, true, (track.gateIndexOf(lane.index(lane.entry + 2)) + 1) % track.checkpoints.length);
    c.teamIndex = team; c.fuelKg = 7.5; c.tyreCompound = 'medium'; c.usedCompounds = new Set(['medium']);
    c.tyreWearFront = c.tyreWearRear = 0.8; c.damage = damage; c.wantsToPit = true;
    c.vel = Vector2.fromAngle(heading).mul(70); c.speed = 70;
    let t = 0, fastest = 0, offTrack = true, stoppedAt = null, inBoxBy = 0, event = null, gatesBefore = c.currentCheckpointIdx;
    c.updatePhysics(idle, dt, track); t += dt;
    assert.ok(c.isPitting && c.pitStopsCount === 1 && !c.wantsToPit, 'the car turns in at the entry line');
    const fuelIn = c.fuelKg;
    while (t < 90 && !event) {
      c.updatePhysics(idle, dt, track); t += dt;
      if (c.isPitting && c.pitDistance > lane.limiterStart && c.pitDistance < lane.limiterEnd) fastest = Math.max(fastest, c.speed);
      if (c.isPitting && c.pitDistance > lane.limiterStart + 5 && c.pitDistance < lane.limiterEnd - 5) offTrack &&= Math.abs(track.sampleSurface(c.pos).lateral) > track.width / 2;
      if (c.pitPhase === 'service' && stoppedAt === null) {
        stoppedAt = c.pitDistance;
        const fast = lane.point(c.pitDistance, lane.side * lane.laneOffset);
        inBoxBy = c.pos.dist(fast);
      }
      event = c.pitStopEvent;
    }
    return { c, t, fastest, offTrack, stoppedAt, inBoxBy, event, gatesBefore, fuelIn };
  };
  const stop = runStop(DT);
  const { c: stopper, event } = stop;
  assert.ok(event && !stopper.isPitting, 'the stop ends at the exit line');
  assert.ok(stop.fastest <= PIT_SPEED_LIMIT + 1e-9, `80 km/h between the limiter lines (${(stop.fastest * 3.6).toFixed(1)} km/h)`);
  assert.ok(stop.offTrack, 'the lane runs off the track, beside it');
  assert.ok(Math.abs(stop.stoppedAt - lane.boxes[2]) < 0.6, 'the car stops at its team box');
  assert.ok(Math.abs(stop.inBoxBy - (lane.boxOffset - lane.laneOffset)) < 0.05, `the box is in the working lane, beside the fast lane (${stop.inBoxBy.toFixed(2)} m)`);
  assert.ok(Math.abs(event.laneTime - stop.t) < 0.1, `lane time ${event.laneTime.toFixed(2)} s runs from the entry line to the exit line (${stop.t.toFixed(2)} s)`);
  assert.ok(event.note.includes('wing') && event.serviceTime > 2.0 + 6 - 0.31 && event.serviceTime < 2.0 + 9 + 0.31 + (event.note.includes('slow') ? 8 : 0), `a new nose for damage 0.4 (${event.serviceTime.toFixed(2)} s, ${event.note})`);
  assert.ok(event.laneTime > event.serviceTime + 10, 'the lane itself costs time at the limit');
  assert.equal(stopper.fuelKg, stop.fuelIn, 'no refuelling at a stop');
  assert.equal(stopper.tyreCompound, 'hard');
  assert.ok(stopper.usedCompounds.has('hard') && stopper.usedCompounds.has('medium'));
  assert.ok(stopper.tyreWearFront === 0 && stopper.damage === 0);
  assert.ok(stopper.speed >= pits.PIT_EXIT_SPEED - 1e-9 && stopper.lapCompromised, 'rejoins at speed; the out-lap is no reference');
  assert.ok(Math.abs(stopper.totalRaceTime - stop.t) < 1e-6, 'the stop is in the race time');
  assert.ok(stopper.currentCheckpointIdx !== stop.gatesBefore, 'the gates beside the lane are timed');
  assert.equal(stopper.pitShowTimer, pits.PIT_SHOW_TIME, 'the stop stays above the car');
  for (let i = 0; i < Math.round(pits.PIT_SHOW_TIME / DT) - 1; i++) stopper.updatePhysics(idle, DT, track);
  assert.ok(stopper.pitShowTimer > 0 && stopper.lastPitLaneTime === event.laneTime, 'still shown just before 5 s');
  stopper.updatePhysics(idle, DT, track); stopper.updatePhysics(idle, DT, track);
  assert.equal(stopper.pitShowTimer, 0, 'gone after 5 s');
  for (const dt of [1 / 30, 1 / 120]) {
    const other = runStop(dt, 0);
    const base = runStop(DT, 0);
    assert.ok(Math.abs(other.event.laneTime - base.event.laneTime) < 2 * dt, `lane time at ${Math.round(1 / dt)} Hz ${other.event.laneTime.toFixed(3)} s vs ${base.event.laneTime.toFixed(3)} s`);
  }

  // 4. Service time: the crews differ, damage costs a repair or a new nose, some stops go wrong.
  seedRandom(5);
  const crew = new Car(track.startPosition, track.startAngle, null, '#fff', 'crew', 60, 25);
  const draws = (team, damage, n) => { crew.teamIndex = team; crew.damage = damage; return Array.from({ length: n }, () => pits.serviceTime(crew)); };
  const mean = list => list.reduce((a, s) => a + s.time, 0) / list.length;
  const clean = draws(2, 0, 2000);
  const slowShare = clean.filter(s => s.note.includes('slow')).length / clean.length;
  assert.ok(slowShare > 0.02 && slowShare < 0.06, `slow stops ${(slowShare * 100).toFixed(1)}%`);
  const tidy = clean.filter(s => !s.note);
  assert.ok(tidy.every(s => s.time >= 1.7 - 1e-9 && s.time <= 2.3 + 1e-9), 'the fastest crew: 2.0 ± 0.3 s');
  assert.ok(mean(draws(6, 0, 500).filter(s => !s.note)) - mean(tidy) > 0.6, 'the slowest crew takes about 0.8 s longer');
  assert.ok(draws(2, 0.05, 200).every(s => !s.note.includes('repair') && !s.note.includes('wing')), 'light damage is fixed within the wheel change');
  assert.ok(draws(2, 0.15, 200).filter(s => !s.note.includes('slow')).every(s => s.note === 'repair' && s.time > 1.7 + 1 && s.time < 2.3 + 3), 'moderate damage: a quick repair');
  assert.ok(draws(2, 0.6, 200).filter(s => !s.note.includes('slow')).every(s => s.note === 'wing' && s.time > 1.7 + 6 && s.time < 2.3 + 9), 'a broken wing: a new nose');

  // 5. Double stack: the second car of a team waits in the working lane behind its team-mate's box.
  //    A car of another team drives past both in the fast lane without slowing.
  {
    seedRandom(3);
    const make = (offset, name, team) => {
      const at = lane.point(lane.entry + 2 - offset, 0), heading = track.sampleSurface(at).tangent.heading();
      const c = new Car(at, heading, null, '#fff', name, 60, 25);
      c.reset(at, heading, true, (track.gateIndexOf(lane.index(lane.entry + 2 - offset)) + 1) % track.checkpoints.length);
      c.teamIndex = team; c.wantsToPit = true; c.vel = Vector2.fromAngle(heading).mul(60); c.speed = 60;
      return c;
    };
    const first = make(0, 'first', 4), second = make(40, 'second', 4), passer = make(0, 'passer', 9);
    passer.wantsToPit = false; passer.isAlive = false;
    const all = [first, second, passer];
    const box = lane.boxOf(4), side = (c) => lane.offset(c.pitDistance, c.pitEntryOffset, lane.boxOf(c.teamIndex));
    let queued = false, overlap = false, firstOut = Infinity, secondService = Infinity, passerSlowest = Infinity, passedService = false;
    for (let i = 0; i < 60 * 120 && all.some(c => c.pitStopsCount === 0 || c.isPitting); i++) {
      // The passer comes down the fast lane at the limit while one car of the team is serviced and the other waits.
      if (first.pitPhase === 'service' && second.pitPhase === 'queue' && !passer.isAlive) {
        passer.isAlive = true; passer.isPitting = true; passer.pitPhase = 'lane'; passer.pitStopsCount = 1;
        passer.pitDistance = box - 60; passer.pitEntryOffset = 0; passer.speed = PIT_SPEED_LIMIT;
      }
      for (const c of all) if (c.isAlive) c.updatePhysics(idle, DT, track, all);
      queued ||= second.pitPhase === 'queue';
      for (const [a, b] of [[first, second], [first, passer], [second, passer]]) {
        if (a.isPitting && b.isPitting && Math.abs(a.pitDistance - b.pitDistance) < 5.6 && Math.abs(side(a) - side(b)) < 2.0) overlap = true;
      }
      if (first.pitPhase === 'out' && firstOut === Infinity) firstOut = i;
      if (second.pitPhase === 'service' && secondService === Infinity) secondService = i;
      if (passer.isPitting && passer.pitDistance < lane.boxOf(9) - 30) {
        passerSlowest = Math.min(passerSlowest, passer.speed);
        if (Math.abs(passer.pitDistance - box) < 3 && (first.pitPhase === 'service' || second.pitPhase === 'service' || second.pitPhase === 'queue')) passedService = true;
      }
    }
    assert.ok(queued && !overlap, 'the team-mate queues behind, no car ever inside another');
    assert.ok(Math.abs(second.lastPitServiceTime) > 0 && secondService >= firstOut, 'its service starts once the first car has left the box');
    assert.ok(passedService, 'the passer reached the box while a car of the other team stood there');
    assert.ok(passerSlowest > 0.95 * PIT_SPEED_LIMIT, `a car in the box does not block the fast lane (slowest ${(passerSlowest * 3.6).toFixed(1)} km/h)`);
    assert.ok(Math.abs(lane.inBox(box, box) - 1) < 1e-9 && lane.inBox(box - 30, box) === 0 && lane.inBox(box + 10, box) === 0, 'in the box at the box, in the fast lane before and after');
  }

  // 6. The exit: a car alongside or one arriving fast from behind holds the rejoin.
  const waiting = runStop(DT, 0).c;
  waiting.isPitting = true; waiting.pitPhase = 'out'; waiting.pitDistance = lane.exit - 3; waiting.speed = 0; waiting.vel.set(0, 0);
  const exitAt = lane.point(lane.exit, lane.side * lane.rejoinOffset), tangent = track.sampleSurface(exitAt).tangent;
  const other = new Car(exitAt.add(tangent.mul(-40)), tangent.heading(), null, '#000', 'other', 60, 25);
  other.reset(exitAt.add(tangent.mul(-40)), tangent.heading(), true, 1);
  other.vel = tangent.mul(80); other.speed = 80;
  for (let i = 0; i < 60; i++) waiting.updatePhysics(idle, DT, track, [waiting, other]);
  assert.ok(waiting.isPitting, 'a car 40 m behind at 288 km/h would arrive within 1.5 s: wait');
  other.pos = exitAt.add(tangent.mul(5)); other.speed = 20;
  for (let i = 0; i < 60; i++) waiting.updatePhysics(idle, DT, track, [waiting, other]);
  assert.ok(waiting.isPitting, 'a car at the exit: wait');
  other.pos = exitAt.add(tangent.mul(-300));
  for (let i = 0; i < 120 && waiting.isPitting; i++) waiting.updatePhysics(idle, DT, track, [waiting, other]);
  assert.ok(!waiting.isPitting, 'clear track: rejoin');

  // 7. Race fuel: the distance at the field's consumption, no more than the tank, and the distance
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

  // 8. A real race start with stops: worn tyres bring cars in at the pit entry, they drive the lane,
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
  assert.ok(rejoined.size === 0 || (session.fastestPitStop && session.fastestPitStop.laneTime > 10), 'the race keeps its quickest stop');
  console.log(`Pit stop regressions passed (strategy, lane on GP and Albert Park, ${event.laneTime.toFixed(1)} s stop with a new nose, 30/60/120 Hz, crews, slow stops ${(slowShare * 100).toFixed(1)}%, double stack, exit clearance, no refuelling, race fuel ${expected.toFixed(1)} kg for 50 laps, ${rejoined.size} cars back from the pits).`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
