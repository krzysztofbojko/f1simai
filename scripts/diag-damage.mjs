// Where car damage comes from in training: node scripts/diag-damage.mjs [seconds=1200] [seed=1]
import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = await mkdtemp(join(tmpdir(), 'f1-damage-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: { population: resolve('src/ai/Population.ts'), presets: resolve('src/track/Presets.ts') }, formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const { Population } = await import(pathToFileURL(join(output, 'population.mjs')));
  const { Presets } = await import(pathToFileURL(join(output, 'presets.mjs')));
  const seconds = Number(process.argv[2] ?? 1200);
  let seed = Number(process.argv[3] ?? 1);
  Math.random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const track = Presets.createGrandPrixTrack(14);
  const pop = new Population(Population.MAX_CARS, track);
  const hits = { car: [], barrier: [] };
  const before = new Map();
  let wreckDamage = { car: [], barrier: [] };
  for (let step = 0; step < seconds * 60; step++) {
    for (const car of pop.cars) before.set(car, { damage: car.damage, alive: car.isAlive });
    pop.update(1 / 60, track);
    for (const car of pop.cars) {
      const b = before.get(car);
      if (!b.alive) continue;
      const delta = car.damage - b.damage;
      if (delta > 1e-9) {
        const near = pop.cars.some(o => o !== car && o.pos.dist(car.pos) < 8);
        hits[near ? 'car' : 'barrier'].push(12 * Math.sqrt(delta));
      }
      if (!car.isAlive && (car.eliminationReason === 'car' || car.eliminationReason === 'barrier')) {
        const single = 12 * Math.sqrt(Math.max(0, car.damage - b.damage));
        wreckDamage[car.eliminationReason].push({ before: b.damage, single });
      }
    }
  }
  const q = (v, p) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) * p)].toFixed(1) : '-'; };
  const laps = pop.teamRecords.reduce((s, r) => s + r.lapsCount, 0);
  for (const [k, v] of Object.entries(hits)) {
    console.log(`${k} contacts`, v.length, 'per 100 laps', (100 * v.length / laps).toFixed(0), 'closing m/s p25/p50/p75/p90', q(v, .25), q(v, .5), q(v, .75), q(v, .9),
      'share of damage from < 3 / 3-6 / 6-12 m/s', ['<3', '3-6', '6-12'].map((_, i) => { const lo = [0, 3, 6][i], hi = [3, 6, 12][i]; const tot = v.reduce((s, x) => s + Math.min(x, 12) ** 2, 0); return (100 * v.filter(x => x >= lo && x < hi).reduce((s, x) => s + x * x, 0) / tot).toFixed(0) + '%'; }).join(' / '));
  }
  for (const [k, v] of Object.entries(wreckDamage)) {
    console.log(`${k} wrecks`, v.length, 'single hit >= 12 m/s', v.filter(w => w.single >= 12).length, 'finished by accumulation', v.filter(w => w.single < 12).length,
      'damage before the last hit p50', q(v.map(w => w.before), .5), 'last hit m/s p50', q(v.filter(w => w.single < 12).map(w => w.single), .5));
  }
  console.log('laps', laps);
} finally { await rm(output, { recursive: true, force: true }); }
