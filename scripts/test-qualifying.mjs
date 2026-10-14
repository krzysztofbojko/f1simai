// Qualifying rules (Q1/Q2/Q3 knockout) and the starting grid built from them.
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'f1-quali-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: dir, lib: { entry: {
    quali: resolve('src/race/Qualifying.ts'), presets: resolve('src/track/Presets.ts') },
    formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const { Qualifying } = await import(pathToFileURL(join(dir, 'quali.mjs')));
  const { Presets } = await import(pathToFileURL(join(dir, 'presets.mjs')));

  const drivers = Array.from({ length: 20 }, (_, i) => ({ color: `#c${i}`, driverName: `D${i}` }));
  const run = (q, color, laps) => laps.map(([time, valid = true]) => q.lapCompleted(color, time, valid));
  const toFlag = q => { while (q.phase === 'session') q.step(1); };
  const closeSession = q => q.step(0);
  const toNextSession = q => { while (q.phase === 'break') q.step(1); };

  // 1. Full knockout: the out-lap is untimed, 5 + 5 eliminated, the top ten decided in Q3.
  const q = new Qualifying(drivers, { sessionSeconds: [100, 100, 100], breakSeconds: 5 });
  assert.equal(q.participants().length, 20);
  drivers.forEach((d, i) => run(q, d.color, [[50], [80 + i * 0.1]]));
  assert.equal(q.standings()[0].color, '#c0', 'fastest Q1 lap leads');
  assert.ok(Math.abs(q.standings()[0].times[0] - 80) < 1e-9, 'out-lap (50 s) is never timed');
  toFlag(q);
  assert.equal(q.phase, 'overtime', 'cars still on a lap keep the session open after the flag');
  drivers.forEach((d, i) => assert.equal(q.lapCompleted(d.color, 90 + i, true), true, 'lap after the flag sends the car in'));
  closeSession(q);
  assert.equal(q.phase, 'break');
  assert.deepEqual(q.standings().slice(15).map(s => s.eliminatedIn), [1, 1, 1, 1, 1], 'five out after Q1');
  assert.deepEqual(q.standings().slice(15).map(s => s.position), [16, 17, 18, 19, 20]);
  toNextSession(q);
  assert.equal(q.session, 1);
  assert.equal(q.participants().length, 15);
  assert.equal(q.isRunning('#c19'), false, 'eliminated cars stay in the garage');
  // Q2: reverse the order among the 15 survivors.
  q.participants().forEach((color, i) => run(q, color, [[50], [70 - i * 0.1]]));
  toFlag(q); q.participants().forEach(c => q.lapCompleted(c, 99, true)); closeSession(q);
  const afterQ2 = q.standings();
  assert.deepEqual(afterQ2.slice(10, 15).map(s => s.color), ['#c4', '#c3', '#c2', '#c1', '#c0'], 'slowest five of Q2 are out, Q1 pace does not matter');
  assert.ok(afterQ2.slice(10, 15).every(s => s.eliminatedIn === 2));
  toNextSession(q);
  assert.equal(q.participants().length, 10);

  // 2. Q3: deleted laps, ties to the earlier time, a car without a Q3 lap classified behind.
  const [a, b, c, ...rest] = q.participants();
  q.lapCompleted(a, 50, true); q.lapCompleted(b, 50, true); q.lapCompleted(c, 50, true);
  q.lapCompleted(a, 60, false); // track limits
  q.lapCompleted(a, 65, true);
  q.lapCompleted(b, 65, true); // same time, set later
  for (const color of rest.slice(0, -1)) { q.lapCompleted(color, 50, true); q.lapCompleted(color, 66, true); }
  const noTime = rest[rest.length - 1];
  q.retire(noTime);
  assert.equal(q.isRunning(noTime), false, 'a retired car takes no further part');
  q.retire(c);
  toFlag(q);
  for (const color of q.participants()) q.lapCompleted(color, 99, true);
  closeSession(q);
  assert.ok(q.isFinished);
  const final = q.standings();
  assert.equal(final[0].color, a, 'deleted 60 s lap ignored; tie on 65 s goes to the earlier time');
  assert.equal(final[1].color, b);
  assert.deepEqual(final.slice(8, 10).map(s => s.color).sort(), [c, noTime].sort(), 'cars without a Q3 time line up behind those with one');
  assert.deepEqual(final.map(s => s.position), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(new Set(q.grid()).size, 20, 'grid holds every car once');
  assert.equal(q.grid()[0], a);

  // 3. A lap started before the flag counts; the overtime limit closes a session with stragglers.
  const late = new Qualifying(drivers.slice(0, 4), { sessionSeconds: [10, 10, 10], breakSeconds: 1 });
  late.lapCompleted('#c0', 1, true);
  for (let t = 0; t < 10; t++) late.step(1);
  assert.equal(late.phase, 'overtime');
  assert.equal(late.lapCompleted('#c0', 30, true), true);
  assert.equal(late.standings()[0].times[0], 30, 'the lap in progress at the flag is timed');
  let overtime = 0;
  while (late.phase === 'overtime' && overtime < 1000) { late.step(1); overtime++; }
  assert.equal(late.phase, 'break', 'session closes even if a car never returns');
  assert.ok(overtime <= Qualifying.MAX_OVERTIME_SECONDS + 1, 'within the overtime limit: ' + overtime);
  assert.equal(late.eliminatedAfter(0), 1, 'small fields knock out a quarter');

  // 4. 107%: a Q1 time slower than 107% of pole is flagged.
  const slow = new Qualifying(drivers.slice(0, 4), { sessionSeconds: [5, 5, 5], breakSeconds: 1 });
  ['#c0', '#c1', '#c2', '#c3'].forEach((color, i) => { slow.lapCompleted(color, 1, true); slow.lapCompleted(color, i === 3 ? 90 : 80 + i, true); });
  toFlag(slow); ['#c0', '#c1', '#c2', '#c3'].forEach(color => slow.lapCompleted(color, 99, false)); closeSession(slow);
  assert.equal(slow.standings().find(s => s.color === '#c3').outside107, true);
  assert.equal(slow.standings().find(s => s.color === '#c1').outside107, false);

  // 5. Twenty grid slots fit before the line: distinct, staggered, 8 m apart along the track.
  for (const track of [Presets.createGrandPrixTrack(14), Presets.createOvalTrack(14)]) {
    const slots = Array.from({ length: 21 }, (_, i) => track.getGridSlot(i));
    for (let i = 1; i < slots.length; i++) {
      assert.ok(slots[i].pos.dist(slots[i - 1].pos) > 4, 'slots do not overlap');
      if (i >= 2) assert.ok(Math.abs(slots[i].pos.dist(slots[i - 2].pos) - 16) < 3, 'rows are 16 m apart: ' + slots[i].pos.dist(slots[i - 2].pos));
    }
  }
  console.log('Qualifying regressions passed (knockout, out-lap, deleted laps, flag rule, ties, 107%, grid slots).');
} finally {
  await rm(dir, { recursive: true, force: true });
}
