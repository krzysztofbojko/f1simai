// Car-to-car wrecks in training: the state of both cars a frame before. node diag-crash.mjs [seconds] [seed]
import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const output = await mkdtemp(join(tmpdir(), 'f1-crash-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: { population: resolve(root, 'src/ai/Population.ts'), presets: resolve(root, 'src/track/Presets.ts'), gap: resolve(root, 'src/ai/RaceTraffic.ts') }, formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const { Population } = await import(pathToFileURL(join(output, 'population.mjs')));
  const { Presets } = await import(pathToFileURL(join(output, 'presets.mjs')));
  const { gap } = await import(pathToFileURL(join(output, 'gap.mjs')));
  const seconds = Number(process.argv[2] ?? 1200);
  let seed = Number(process.argv[3] ?? 1);
  Math.random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const track = Presets.createGrandPrixTrack(14);
  const pop = new Population(Population.MAX_CARS, track);
  const snap = car => {
    const s = track.sampleSurface(car.pos);
    let yaw = car.heading - Math.atan2(s.tangent.y, s.tangent.x); yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    return { alive: car.isAlive, v: +car.speed.toFixed(1), lat: +s.lateral.toFixed(1), yawDeg: Math.round(yaw * 57.3), rec: +car.recoveryTimer.toFixed(1), inc: car.incidentActive, skid: car.isSkidding || car.isSliding, surf: car.surface, yellow: car.yellowFlag, battle: car.battlePush.remaining > 0, pass: car.overtakingTargetName || '', wait: car.trafficWaiting, dmg: +car.damage.toFixed(2), pos: car.pos.clone() };
  };
  let prev = new Map();
  const events = [];
  for (let step = 0; step < seconds * 60; step++) {
    for (const car of pop.cars) prev.set(car, snap(car));
    pop.update(1 / 60, track);
    for (const car of pop.cars) {
      const p = prev.get(car);
      if (!p.alive || car.isAlive || car.eliminationReason !== 'car') continue;
      let other = null, d = Infinity;
      for (const o of pop.cars) { if (o === car) continue; const dd = o.pos.dist(car.pos); if (dd < d) { d = dd; other = o; } }
      const q = prev.get(other);
      const along = gap(track, p.pos, q.pos);
      events.push({ t: +(step / 60).toFixed(1), self: { ...p, pos: undefined }, other: { ...q, pos: undefined }, otherAhead: +along.toFixed(1), closing: +(p.v - q.v).toFixed(1) });
    }
  }
  const count = (f) => events.filter(f).length;
  console.log('car wrecks', events.length);
  console.log('hit a wreck (other already dead)', count(e => !e.other.alive));
  console.log('self ahead / behind of the other (rear-ender = behind)', count(e => e.otherAhead < 0), count(e => e.otherAhead > 0));
  console.log('self or other in recovery/incident/skid', count(e => e.self.rec > 0 || e.self.inc || e.self.skid), count(e => e.other.rec > 0 || e.other.inc || e.other.skid));
  console.log('self off asphalt / other off asphalt', count(e => e.self.surf !== 'asphalt'), count(e => e.other.surf !== 'asphalt'));
  console.log('self yaw > 30° / other yaw > 30°', count(e => Math.abs(e.self.yawDeg) > 30), count(e => Math.abs(e.other.yawDeg) > 30));
  console.log('yellow', count(e => e.self.yellow), 'battle', count(e => e.self.battle || e.other.battle), 'pass plan', count(e => e.self.pass || e.other.pass));
  console.log('damage before >= 0.5 (accumulated)', count(e => e.self.dmg >= 0.5));
  for (const e of events.slice(0, 40)) console.log(JSON.stringify(e));
} finally { await rm(output, { recursive: true, force: true }); }
