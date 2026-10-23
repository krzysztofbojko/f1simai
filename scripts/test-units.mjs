// Small pure functions: compound grip against wetness, the tyre-choice thresholds, and the LiDAR's
// ray entry into a car body.
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
  console.log(`Unit checks passed (compound grip, tyre choice: intermediates from ${firstInter}, slicks wrong from ${firstWrong}, wets wrong up to ${lastWrongWet}; ray entry).`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
