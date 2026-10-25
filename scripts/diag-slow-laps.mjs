// Why training laps run slow: node scripts/diag-slow-laps.mjs [seconds=1200] [seed=145]
// Trains the full field headless on the GP preset and splits every lap's time into where it went.
import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = await mkdtemp(join(tmpdir(), 'f1-slow-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: { population: resolve('src/ai/Population.ts'), presets: resolve('src/track/Presets.ts') }, formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const { Population } = await import(pathToFileURL(join(output, 'population.mjs')));
  const { Presets } = await import(pathToFileURL(join(output, 'presets.mjs')));
  const seconds = Number(process.argv[2] ?? 1200);
  let seed = Number(process.argv[3] ?? 145);
  Math.random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const track = Presets.createGrandPrixTrack(14);
  const pop = new Population(Population.MAX_CARS, track);
  const dt = 1 / 60;
  const acc = new Map();
  const fresh = () => ({ offRoad: 0, recovery: 0, pit: 0, yellow: 0, slow: 0, dead: 0, stress: 0, trial: 0, contact: 0 });
  const laps = [];
  pop.onLapCompleted = (car, event) => {
    const a = acc.get(car) ?? fresh();
    laps.push({ t: event.lapTime, gen: pop.generation, compromised: !!event.compromised || car.lapCompromised, ...a });
    acc.set(car, fresh());
  };
  const wrecks = new Map();
  const alive = new Map();
  const beyond = {};
  const prev = new Map();
  const stuckContext = { yellow: 0, waiting: 0, slow: 0, offRoad: 0, other: 0 };
  for (let step = 0; step < seconds * 60; step++) {
    pop.update(dt, track);
    for (const car of pop.cars) {
      const a = acc.get(car) ?? fresh(); acc.set(car, a);
      if (alive.get(car) && !car.isAlive) {
        const edge = Math.abs(track.sampleSurface(car.pos).lateral) - track.width / 2;
        const r = car.eliminationReason ?? '?';
        (beyond[r] ??= []).push(+edge.toFixed(1));
      }
      if (alive.get(car) && !car.isAlive) wrecks.set(car.eliminationReason ?? '?', (wrecks.get(car.eliminationReason ?? '?') ?? 0) + 1);
      if (alive.get(car) && !car.isAlive && car.eliminationReason === 'stuck') {
        const p = prev.get(car);
        if (p.offRoad) stuckContext.offRoad++; else if (p.yellow) stuckContext.yellow++; else if (p.waiting) stuckContext.waiting++; else if (p.slow) stuckContext.slow++; else stuckContext.other++;
      }
      alive.set(car, car.isAlive);
      prev.set(car, { yellow: car.yellowFlag, waiting: car.trafficWaiting, slow: car.speed < 5, offRoad: car.surface !== 'asphalt' });
      if (!car.isAlive) { a.dead += dt; continue; }
      if (car.surface !== 'asphalt') a.offRoad += dt;
      if (car.recoveryTimer > 0) a.recovery += dt;
      if (car.isPitting) a.pit += dt;
      if (car.yellowFlag) a.yellow += dt;
      if (car.speed < 15) a.slow += dt;
      if (car.stressLap) a.stress += dt;
      if (car.explorationTrial) a.trial += dt;
    }
  }
  const q = (v, p) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)]; };
  const times = laps.map(l => l.t);
  console.log('generations', pop.generation, 'laps', laps.length, 'best', Math.min(...times).toFixed(2), 'p10/p50/p90', q(times, .1).toFixed(2), q(times, .5).toFixed(2), q(times, .9).toFixed(2));
  const groups = { fast: laps.filter(l => l.t < 58), mid: laps.filter(l => l.t >= 58 && l.t < 68), slow: laps.filter(l => l.t >= 68) };
  for (const [name, g] of Object.entries(groups)) {
    if (!g.length) { console.log(name, 0); continue; }
    const mean = k => (g.reduce((s, l) => s + l[k], 0) / g.length).toFixed(2);
    console.log(name.padEnd(5), String(g.length).padStart(4), 'compromised', (100 * g.filter(l => l.compromised).length / g.length).toFixed(0) + '%',
      'offRoad', mean('offRoad'), 'recovery', mean('recovery'), 'pit', mean('pit'), 'yellow', mean('yellow'), 'v<15', mean('slow'), 'dead', mean('dead'), 'stress', mean('stress'), 'trial', mean('trial'));
  }
  // Lap time over training: median per tenth of the run.
  const tenth = Math.ceil(laps.length / 10);
  console.log('median by decile', Array.from({ length: 10 }, (_, i) => laps.slice(i * tenth, (i + 1) * tenth).map(l => l.t)).filter(s => s.length).map(s => q(s, .5).toFixed(1)).join(' '));
  const clean = laps.filter(l => !l.yellow && !l.recovery && !l.offRoad && !l.dead).map(l => l.t);
  console.log('clean laps', clean.length, 'p10/p50/p90', q(clean, .1)?.toFixed(2), q(clean, .5)?.toFixed(2), q(clean, .9)?.toFixed(2));
  console.log('wrecks per minute', ([...wrecks.values()].reduce((a, b) => a + b, 0) / (seconds / 60)).toFixed(1), JSON.stringify(Object.fromEntries(wrecks)));
  const wreckCount = [...wrecks.values()].reduce((a, b) => a + b, 0);
  console.log('per 100 laps: wrecks', (100 * wreckCount / laps.length).toFixed(1), 'laps under yellow', (100 * laps.filter(l => l.yellow > 0).length / laps.length).toFixed(1), 'mean yellow s on those', (laps.filter(l => l.yellow > 0).reduce((a, l) => a + l.yellow, 0) / Math.max(1, laps.filter(l => l.yellow > 0).length)).toFixed(1));
  for (const [r, v] of Object.entries(beyond)) console.log('metres beyond the track edge at', r, 'p10/p50/p90', q(v, .1), q(v, .5), q(v, .9), 'on asphalt', v.filter(e => e <= 0).length + '/' + v.length);
  console.log('stuck just before', JSON.stringify(stuckContext));
  console.log('team bests', pop.teamRecords.map(r => r.bestLapTime?.toFixed(1)).join(' '));
} finally { await rm(output, { recursive: true, force: true }); }
