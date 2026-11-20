// Small pure functions: compound grip against wetness, the tyre-choice thresholds and compound
// invariants, the LiDAR's ray entry into a car body, and the axle friction budget of one physics step.
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'f1-units-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: dir, emptyOutDir: true, minify: false, lib: { entry: {
    car: resolve('src/physics/Car.ts'), tyres: resolve('src/physics/Tyres.ts'), vector: resolve('src/math/Vector2.ts') },
    formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const load = name => import(pathToFileURL(join(dir, name + '.mjs')));
  const { Car } = await load('car');
  const { COMPOUND_SPECS, TYRE_COMPOUNDS, compoundGrip, weatherCompound, wrongForConditions, isSlick } = await load('tyres');
  const { Vector2 } = await load('vector');
  const close = (a, b, eps = 1e-12) => Math.abs(a - b) < eps;

  // 1. Compound grip: the spec at dry / damp / soaked, linear in between, clamped outside 0..1.
  for (const c of TYRE_COMPOUNDS) {
    const [dry, damp, wet] = COMPOUND_SPECS[c].grip;
    assert.ok(close(compoundGrip(c, 0), dry) && close(compoundGrip(c, 0.5), damp) && close(compoundGrip(c, 1), wet), `${c}: spec points`);
    assert.ok(close(compoundGrip(c, 0.25), (dry + damp) / 2) && close(compoundGrip(c, 0.75), (damp + wet) / 2), `${c}: linear between them`);
    assert.ok(close(compoundGrip(c, -1), dry) && close(compoundGrip(c, 2), wet), `${c}: clamped`);
  }
  for (const c of ['soft', 'medium', 'hard']) assert.ok(compoundGrip(c, 1) < compoundGrip(c, 0) * 0.6, `${c}: a slick loses most of its grip on a soaked track`);

  // 2. Tyre choice: the best family switches once from slicks to intermediates to wets as the
  //    track gets wetter, and a set counts as wrong only well past the switch (4% slower), so a
  //    track near a boundary does not call the cars in and out.
  const scan = fn => Array.from({ length: 1001 }, (_, i) => fn(i / 1000));
  const families = scan(w => weatherCompound(w, 'medium'));
  const order = families.filter((c, i) => i === 0 || c !== families[i - 1]);
  assert.deepEqual(order, ['medium', 'intermediate', 'wet'], 'slicks, then intermediates, then wets');
  const firstInter = families.indexOf('intermediate') / 1000;
  const wrongMedium = scan(w => wrongForConditions('medium', w));
  const firstWrong = wrongMedium.indexOf(true) / 1000;
  assert.ok(wrongMedium.slice(wrongMedium.indexOf(true)).every(Boolean), 'once slicks are wrong they stay wrong on a wetter track');
  assert.ok(firstWrong > firstInter, `intermediates are faster from ${firstInter}, slicks wrong from ${firstWrong}`);
  assert.ok(compoundGrip('intermediate', firstWrong) > compoundGrip('medium', firstWrong) * 1.04, 'wrong means 4% slower');
  const wrongWet = scan(w => wrongForConditions('wet', w));
  const lastWrongWet = wrongWet.lastIndexOf(true) / 1000;
  assert.ok(wrongWet.slice(0, wrongWet.lastIndexOf(true) + 1).every(Boolean) && lastWrongWet > 0.3 && lastWrongWet < 1, `full wets are wrong on a drier track, up to ${lastWrongWet}`);
  assert.ok(!wrongForConditions('hard', 0) && !wrongForConditions('soft', 0), 'any slick suits a dry track');
  assert.equal(weatherCompound(0, 'intermediate'), 'medium', 'a dry track from treaded tyres goes back to mediums');
  assert.ok(TYRE_COMPOUNDS.filter(isSlick).length === 3);
  // The switch points stay where wet-weather racing has them (a calibration must not move them out):
  // slicks to intermediates on a damp track, intermediates to full wets only on a soaked one.
  const firstWetTyre = families.indexOf('wet') / 1000;
  assert.ok(firstInter >= 0.15 && firstInter <= 0.35, `slicks → intermediates at wetness ${firstInter}`);
  assert.ok(firstWetTyre >= 0.6 && firstWetTyre <= 0.8, `intermediates → wets at wetness ${firstWetTyre}`);

  // 2b. Compound invariants a calibration must keep (no physics in them): on a dry track the softer
  //     slick grips more and wears faster, at its own optimum and at a shared 100 °C; the treaded
  //     tyres rank the other way round on a soaked track; each compound peaks at its optimum and
  //     loses grip monotonically away from it, by at most its cold (20%) or hot (25%) floor.
  const slicks = ['soft', 'medium', 'hard'];
  for (let i = 1; i < slicks.length; i++) {
    const [softer, harder] = [COMPOUND_SPECS[slicks[i - 1]], COMPOUND_SPECS[slicks[i]]];
    assert.ok(Car.tyreGrip(softer.optimum, 0, slicks[i - 1]) > Car.tyreGrip(harder.optimum, 0, slicks[i]), `${slicks[i - 1]} grips more than ${slicks[i]} at their optimum`);
    assert.ok(Car.tyreGrip(100, 0, slicks[i - 1]) > Car.tyreGrip(100, 0, slicks[i]), `${slicks[i - 1]} grips more than ${slicks[i]} at 100 °C`);
    assert.ok(softer.wear > harder.wear && softer.optimum < harder.optimum, `${slicks[i - 1]} wears faster and works cooler than ${slicks[i]}`);
  }
  assert.ok(compoundGrip('wet', 1) > compoundGrip('intermediate', 1) && compoundGrip('intermediate', 1) > compoundGrip('medium', 1), 'soaked: wet > intermediate > slick');
  assert.ok(compoundGrip('medium', 0) > compoundGrip('intermediate', 0) && compoundGrip('intermediate', 0) > compoundGrip('wet', 0), 'dry: slick > intermediate > wet');
  for (const c of TYRE_COMPOUNDS) {
    const { optimum, coldWidth, hotWidth } = COMPOUND_SPECS[c];
    const peak = Car.tyreGrip(optimum, 0, c);
    assert.ok(close(peak, compoundGrip(c, 0), 1e-12), `${c}: full grip at the optimum`);
    for (let d = 1; d <= 80; d++) {
      assert.ok(Car.tyreGrip(optimum - d, 0, c) < Car.tyreGrip(optimum - d + 1, 0, c) && Car.tyreGrip(optimum + d, 0, c) < Car.tyreGrip(optimum + d - 1, 0, c), `${c}: grip falls away from the optimum (${d} °C)`);
    }
    assert.ok(Car.tyreGrip(optimum - 200, 0, c) >= 0.8 * peak - 1e-12 && Car.tyreGrip(optimum + 200, 0, c) >= 0.75 * peak - 1e-12, `${c}: bounded thermal loss`);
    // One window width out, a side keeps exp(-1/2) of its depth.
    assert.ok(close(Car.tyreGrip(optimum - coldWidth, 0, c) / peak, 0.8 + 0.2 * Math.exp(-0.5), 1e-12) && close(Car.tyreGrip(optimum + hotWidth, 0, c) / peak, 0.75 + 0.25 * Math.exp(-0.5), 1e-12), `${c}: window widths`);
    assert.ok(Car.tyreGrip(optimum, 1, c) < Car.tyreGrip(optimum, 0.5, c) && Car.tyreGrip(optimum, 0.5, c) < peak, `${c}: wear costs grip`);
  }

  // 3. Ray entry into a 5.5 m body (half width from the car): along and across the heading,
  //    misses beside it and beyond the range, and none from inside.
  const body = new Car(new Vector2(0, 0), 0);
  body.pos = new Vector2(0, 0);
  const half = body.width / 2;
  assert.ok(close(body.rayEntry(new Vector2(-20, 0), 1, 0, 100), 20 - 2.75, 1e-9), 'head-on from behind');
  assert.ok(close(body.rayEntry(new Vector2(-20, half - 0.01), 1, 0, 100), 20 - 2.75, 1e-9), 'grazing the side');
  assert.equal(body.rayEntry(new Vector2(-20, half + 0.01), 1, 0, 100), Infinity, 'passing beside');
  assert.equal(body.rayEntry(new Vector2(-20, 0), 1, 0, 10), Infinity, 'out of range');
  assert.equal(body.rayEntry(new Vector2(-20, 0), -1, 0, 100), Infinity, 'pointing away');
  assert.equal(body.rayEntry(new Vector2(1, 0), 1, 0, 100), Infinity, 'from inside the body');
  assert.ok(close(body.rayEntry(new Vector2(0, -20), 0, 1, 100), 20 - half, 1e-9), 'from the side, across the heading');
  body.heading = Math.PI / 2;
  assert.ok(close(body.rayEntry(new Vector2(0, -20), 0, 1, 100), 20 - 2.75, 1e-9), 'turned 90°: the length lies along y');
  const d = Math.SQRT1_2;
  const diagonal = body.rayEntry(new Vector2(-20, -20), d, d, 100);
  assert.ok(diagonal > 20 * Math.SQRT2 - Math.hypot(2.75, half) - 1e-9 && diagonal < 20 * Math.SQRT2, `diagonal entry ${diagonal.toFixed(3)} m`);

  // 4. Axle friction budget over random states (seeded): speed, sideslip, yaw, steering, pedals,
  //    wetness, a surface per wheel, tyre temperatures, damage, a lock and the force in use last
  //    step. After one step each axle's force stays on its friction circle (the front's lateral
  //    share is the FRONT_GRIP_BIAS ellipse), a locked axle keeps at most LOCKED_LATERAL of it, and
  //    the kinematic response stays within the axles' combined lateral grip.
  let seed = 20261120;
  const draw = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const span = (lo, hi) => lo + (hi - lo) * draw();
  const surfaces = ['asphalt', 'kerb', 'grass', 'gravel'];
  const savedWeather = Car.config.weather, savedRandom = Math.random;
  // The car draws its driver variation from random() (Math.random here): seed it too, so the states replay.
  Math.random = draw;
  const budget = { states: 0, dynamic: 0, kinematic: 0, locked: 0, mixed: 0, worstFront: 0, worstRear: 0 };
  try {
    for (let n = 0; n < 2000; n++) {
      const wheels = Array.from({ length: 4 }, () => draw() < 0.6 ? 'asphalt' : surfaces[Math.floor(draw() * 4)]);
      // Wheels by quadrant of the car at the origin, heading +x: rear/front by x, left/right by y.
      const probe = { checkpoints: [], timingGates: [], width: 76, isOutOfBounds: () => false,
        sampleSurface: p => ({ surface: wheels[(p.x > 0 ? 2 : 0) + (p.y > 0 ? 1 : 0)], tangent: new Vector2(1, 0), index: 0, lateral: p.y }) };
      Car.config.weather = { ...savedWeather, wetness: draw() < 0.5 ? 0 : draw() };
      const c = new Car(new Vector2(0, 0), 0);
      c.pos = new Vector2(0, 0); c.prevPos = new Vector2(0, 0);
      c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1; c.mistakesEnabled = false;
      c.vel = new Vector2(span(-5, 90), span(-8, 8)); c.speed = c.vel.mag(); c.speedKmh = c.speed * 3.6;
      c.angularVelocity = span(-1.5, 1.5);
      c.wheelAngle = c.steeringHands = span(-c.maxSteerAngle, c.maxSteerAngle);
      c.slipAngleFront = span(-0.3, 0.3); c.slipAngleRear = span(-0.3, 0.3);
      c.tyreTempFront = c.tyreSurfaceTempFront = span(40, 130); c.tyreTempRear = c.tyreSurfaceTempRear = span(40, 130);
      c.tyreWearFront = span(0, 0.8); c.tyreWearRear = span(0, 0.8);
      c.damage = draw() < 0.7 ? 0 : draw();
      c.wheelLockFront = draw() < 0.15; c.wheelLockRear = draw() < 0.15;
      c.frontLateralInUse = span(0, 9000); c.rearLateralInUse = span(0, 9000);
      const pedal = draw();
      const control = { steer: span(-1, 1), throttle: pedal < 0.67 ? draw() : 0, brake: pedal > 0.33 ? draw() : 0 };
      c.throttleResponse = control.throttle; c.brakePressure = control.brake;
      c.timeSinceCheckpoint = 0;
      c.updatePhysics(control, [1 / 30, 1 / 60, 1 / 120][n % 3], probe);
      if (!c.isAlive) continue;
      const f = c.lastAxleForces, tol = 1 + 1e-9;
      const front = Math.hypot(f.frontFx, f.frontFy / Car.FRONT_GRIP_BIAS), rear = Math.hypot(f.rearFx, f.rearFy);
      const where = `state ${n} (v ${c.vel.x.toFixed(1)}/${c.vel.y.toFixed(1)}, wheels ${wheels.join('/')}, w ${f.dynamicWeight.toFixed(2)})`;
      assert.ok(front <= f.frontLimit * tol + 1e-9, `${where}: front ${front.toFixed(1)} N beyond its ${f.frontLimit.toFixed(1)} N circle`);
      assert.ok(rear <= f.rearLimit * tol + 1e-9, `${where}: rear ${rear.toFixed(1)} N beyond its ${f.rearLimit.toFixed(1)} N circle`);
      assert.ok(Math.abs(f.kinematicLateral) <= f.lateralLimit * tol + 1e-9 && f.lateralLimit <= (f.frontLimit + f.rearLimit) * tol + 1e-9, `${where}: kinematic lateral ${f.kinematicLateral.toFixed(1)} N beyond ${f.lateralLimit.toFixed(1)} N`);
      if (c.wheelLockFront) assert.ok(Math.abs(f.frontFy) <= Car.LOCKED_LATERAL * Car.FRONT_GRIP_BIAS * f.frontLimit * tol + 1e-9, `${where}: locked front keeps ${Math.abs(f.frontFy).toFixed(1)} N`);
      if (c.wheelLockRear) assert.ok(Math.abs(f.rearFy) <= Car.LOCKED_LATERAL * f.rearLimit * tol + 1e-9, `${where}: locked rear keeps ${Math.abs(f.rearFy).toFixed(1)} N`);
      budget.states++;
      if (f.dynamicWeight > 0) budget.dynamic++; else budget.kinematic++;
      if (c.wheelLockFront || c.wheelLockRear) budget.locked++;
      if (new Set(wheels).size > 1) budget.mixed++;
      if (f.frontLimit > 0) budget.worstFront = Math.max(budget.worstFront, front / f.frontLimit);
      if (f.rearLimit > 0) budget.worstRear = Math.max(budget.worstRear, rear / f.rearLimit);
    }
  } finally { Car.config.weather = savedWeather; Math.random = savedRandom; }
  assert.ok(budget.states > 1800 && budget.dynamic > 500 && budget.kinematic > 100 && budget.locked > 100 && budget.mixed > 500, `axle budget coverage ${JSON.stringify(budget)}`);
  console.log(`Unit checks passed (compound grip, tyre choice: intermediates from ${firstInter}, wets from ${firstWetTyre}, slicks wrong from ${firstWrong}, wets wrong up to ${lastWrongWet}; compound invariants; ray entry; axle friction budget over ${budget.states} random states, ${budget.dynamic} dynamic / ${budget.kinematic} kinematic / ${budget.locked} locked, peak use ${budget.worstFront.toFixed(3)} front, ${budget.worstRear.toFixed(3)} rear).`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
