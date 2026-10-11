// Diagnostics for neural driving: node scripts/diag-nn.mjs [seconds] [--expert]
// Compares network-driven laps with the rule-based expert on the GP preset.
import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const output = await mkdtemp(join(tmpdir(), 'f1-diag-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: { car: resolve('src/physics/Car.ts'), population: resolve('src/ai/Population.ts'), presets: resolve('src/track/Presets.ts') }, formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  let randomState = Number(process.env.SEED ?? 123456789);
  Math.random = () => { randomState = (Math.imul(1664525, randomState) + 1013904223) >>> 0; return randomState / 4294967296; };
  const { Car } = await import(pathToFileURL(join(output, 'car.mjs')));
  if (process.env.KIN) Car.DYNAMIC_YAW = false;
  const { Population } = await import(pathToFileURL(join(output, 'population.mjs')));
  const { Presets } = await import(pathToFileURL(join(output, 'presets.mjs')));
  const seconds = Number(process.argv[2] ?? 300);
  const expert = process.argv.includes('--expert');
  const gp = Presets.createGrandPrixTrack(14);
  const t0 = Date.now();
  const population = new Population(Number(process.env.POP ?? 10), gp, 25);
  console.log('init ms', Date.now() - t0);
  if (process.env.PRESSURE) population.setDriverPressure(Number(process.env.PRESSURE), true);
  if (expert) for (const c of population.cars) { const orig = c.getAIControl.bind(c); c.getAIControl = (t, l) => { const p = c.planDrive(t, l); c.currentControl = p.expert; return p.expert; }; }
  const flips = {}; const lapStats = { clean: 0, compromised: 0 };
  const prevComp = population.cars.map(c => c.lapCompromised), prevDmg = population.cars.map(() => 0);
  const origRec = population.recordLap.bind(population);
  population.recordLap = (e, c, ...r) => { (e.compromised ? lapStats.compromised++ : lapStats.clean++); return origRec(e, c, ...r); };
  const sites = {};
  for (const c of population.cars) { let v = c.lapCompromised; Object.defineProperty(c, 'lapCompromised', { get: () => v, set: (nv) => { if (nv && !v) { const l = new Error().stack.split('\n')[2].trim(); sites[l] = (sites[l] ?? 0) + 1; } v = nv; } }); }
  const offStats = {}; const latUse = []; const both = { n: 0 };
  const deaths = {};
  const lastAlive = population.cars.map(() => true);
  const t1 = Date.now();
  for (let i = 0; i < seconds * 60; i++) {
    population.update(1 / 60, gp);
    population.cars.forEach((c, k) => { if (!prevComp[k] && c.lapCompromised) { const why = c.pressureLearningBlocked ? 'pressure' : c.incidentActive ? 'mistake' : c.surfaceFractions.asphalt < 1 ? 'offAsphalt:' + c.surface : c.damage > prevDmg[k] ? 'contact' : population.cars.some(o => o !== c && o.pos.dist(c.pos) < 8) ? 'traffic-near' : 'other:rec' + (c.recoveryTimer > 0) + ':v' + Math.round(c.speed / 20); flips[why] = (flips[why] ?? 0) + 1; } prevComp[k] = c.lapCompromised; prevDmg[k] = c.damage; });
    population.cars.forEach((c, k) => { if (c.isAlive && c.surface !== 'asphalt') { const key = `car${k}@cp${c.currentCheckpointIdx}:${c.surface}`; offStats[key] = (offStats[key] ?? 0) + 1; } });
    if (process.argv.includes('--gravel') && i % 120 === 0) { const c = population.cars[1]; if (c.isAlive && c.surface === 'gravel') console.log('gravelTrace', (i/60).toFixed(0), 'v', c.speed.toFixed(1), 'wait', c.trafficWaiting, 'frames', c.framesSinceLastCheckpoint, 'rec', c.recoveryTimer.toFixed(1), 'ctrl', JSON.stringify(c.currentControl), 'hd', c.heading.toFixed(2), 'lat', gp.sampleSurface(c.pos).lateral.toFixed(1), 'tan', gp.sampleSurface(c.pos).tangent.heading().toFixed(2), 'pos', c.pos.x.toFixed(0), c.pos.y.toFixed(0), 'half', (gp.width/2).toFixed(1), 'fx', c.engineForce?.toFixed?.(0)); }
    if (process.env.FIRSTOFF && !globalThis.firstOff && population.cars[Number(process.env.FIRSTOFF)].surface !== 'asphalt') { globalThis.firstOff = i; console.log('firstOff', (i/60).toFixed(1)); }
    population.cars.forEach(c => { if (c.isAlive && c.speed > 15) { latUse.push(Math.abs(gp.sampleSurface(c.pos).lateral)); if (c.currentControl.throttle > 0.02 && c.currentControl.brake > 0.02) both.n++; } });
    if (process.argv.includes('--car') && i >= 60 * Number(process.env.TSTART ?? 0) && i < 60 * (Number(process.env.TSTART ?? 0) + 8) && i % 6 === 0) { const c = population.cars[Number(process.env.CAR ?? 2)]; const sm = gp.sampleSurface(c.pos); console.log((i / 60).toFixed(1), 'cp', c.currentCheckpointIdx, 'v', c.speed.toFixed(1), 'lat', sm.lateral.toFixed(1), 'headErr', (Math.atan2(Math.sin(c.heading - sm.tangent.heading()), Math.cos(c.heading - sm.tangent.heading()))).toFixed(2), 'yaw', c.angularVelocity.toFixed(2), 'ctrl', c.currentControl.steer.toFixed(2), c.currentControl.throttle.toFixed(2), c.currentControl.brake.toFixed(2), 'g', c.lateralG.toFixed(1), c.surface); }
    if (process.argv.includes('--trace') && i % 30 === 0 && i < 60 * 14) console.log((i / 60).toFixed(1), population.cars.map(c => `${c.isAlive ? '' : 'X'}${c.currentCheckpointIdx}:${c.speed.toFixed(0)}/${c.currentControl.steer.toFixed(1)}/${c.lateralG.toFixed(1)}`).join('  '));
    if ((i + 1) % (600 * 60) === 0) console.log('t', (i + 1) / 60, 'gen', population.generation, 'best', population.globalBestLap && +population.globalBestLap.toFixed(2), 'teamBests', population.teamRecords.map(r => r.bestLapTime && +r.bestLapTime.toFixed(1)).join(','));
    population.cars.forEach((c, k) => { if (lastAlive[k] && !c.isAlive) { const key = c.eliminationReason; deaths[key] = (deaths[key] ?? 0) + 1; if (process.argv.includes('--debug')) console.log('death', k, key, 'cp', c.currentCheckpointIdx, 'speed', c.speed.toFixed(1), 'ctrl', JSON.stringify(c.currentControl), c.surface, 'lat', gp.sampleSurface(c.pos).lateral.toFixed(1), 'dmg', c.damage.toFixed(2), 'at', (i / 60).toFixed(0)); if (key === 'car' && process.argv.includes('--near')) for (const o of population.cars) if (o !== c && o.pos.dist(c.pos) < 20) console.log('   near', o.isAlive ? 'alive' : 'dead', 'cp', o.currentCheckpointIdx, 'v', o.speed.toFixed(1), 'lat', gp.sampleSurface(o.pos).lateral.toFixed(1), 'offs', o.raceLineOffset.toFixed(1), 'ctrl', JSON.stringify(o.currentControl), 'dist', o.pos.dist(c.pos).toFixed(1), 'wait', o.trafficWaiting); } lastAlive[k] = c.isAlive; });
  }
  console.log('sim ms', Date.now() - t1);
  console.log({ flips, lapStats, sites }); console.log('ers', population.cars.map(c => Math.round(c.ersEnergy/4e4)).join(' ')); latUse.sort((a,b)=>a-b); console.log('latUse p50/p90/p99 of half-width', [.5,.9,.99].map(q => +(latUse[Math.floor(q*(latUse.length-1))]/(gp.width/2)).toFixed(2)), 'pedals both', both.n); console.log('paceMargins', population.cars.map(c => +c.pace.margin.toFixed(2) + '/' + +c.pace.bestMargin.toFixed(2) + '/c' + +c.pace.ceiling.toFixed(2)).join(' ')); console.log('offStats', Object.entries(offStats).sort((a,b)=>b[1]-a[1]).slice(0,12)); console.log({ expert, bestLap: population.globalBestLap, deaths, laps: population.teamRecords.map(r => r.lapsCount), best: population.teamRecords.map(r => r.bestLapTime && +r.bestLapTime.toFixed(2)) });
} finally { await rm(output, { recursive: true, force: true }); }
