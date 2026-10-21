// One expert car on the racing line: lap times, tracking error and track-limit use.
// node scripts/diag-line-follow.mjs [seconds=180] [track file]
import { build } from 'vite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = await mkdtemp(join(tmpdir(), 'f1-follow-'));
try {
  const entries = { car: 'physics/Car', presets: 'track/Presets', track: 'track/Track', vector: 'math/Vector2', spline: 'math/Spline' };
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: Object.fromEntries(Object.entries(entries).map(([k, p]) => [k, resolve('src/' + p + '.ts')])), formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const I = f => import(pathToFileURL(join(output, f + '.mjs')));
  const { Car } = await I('car'); const { Presets } = await I('presets'); const { Track } = await I('track'); const { Vector2 } = await I('vector'); const { Spline } = await I('spline');
  let track = Presets.createGrandPrixTrack(14);
  if (process.argv[3]) {
    const data = JSON.parse(await readFile('tracks/' + process.argv[3], 'utf8'));
    const width = Math.max(5, Math.min(20, Math.round(data.trackWidth)));
    track = new Track(Spline.generateClosedTrack(data.rawPoints.map(p => new Vector2(p.x, p.y)), width, 18, true), width);
  }
  const slot = track.getGridSlot(0);
  const car = new Car(slot.pos, slot.heading, null, '#fff', 'solo', 100, 25);
  car.currentCheckpointIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
  car.mistakesEnabled = false; car.lapPowerFactor = car.lapGripFactor = car.lapDragFactor = 1;
  car.rollLapPerformanceVariation = () => {};
  car.updateDimensionsForTrackWidth(track.width);
  const line = car.racingLine(track);
  const seconds = Number(process.argv[2] ?? 180);
  let err = 0, errMax = 0, frames = 0, wheelsOff = 0, excursions = 0, wasOut = false;
  for (let i = 0; i < seconds * 60; i++) {
    car.updateSensors(track);
    const p = car.planDrive(track);
    const ev = car.updatePhysics(p.expert, 1 / 60, track);
    const s = track.sampleSurface(car.pos);
    const e = Math.abs(s.lateral - line.offsetAt(s.index, s.fraction));
    if (car.speed > 20) { err += e; errMax = Math.max(errMax, e); frames++; }
    if (car.surfaceFractions.asphalt < 1) wheelsOff++;
    const out = !car.withinTrackLimits; if (out && !wasOut) { excursions++; console.log('excursion at point', s.index, 'v', car.speed.toFixed(1), 'lat', s.lateral.toFixed(2), 'line', line.offsetAt(s.index, s.fraction).toFixed(2)); } wasOut = out;
    if (ev) console.log('LAP', ev.lapTime.toFixed(2), ev.compromised ? 'compromised' : 'clean');
    if (!car.isAlive) { console.log('DEAD', car.eliminationReason, 'at', s.index); break; }
  }
  console.log({ meanErr: +(err / frames).toFixed(2), maxErr: +errMax.toFixed(2), wheelsOffPct: +(100 * wheelsOff / (seconds * 60)).toFixed(1), excursions });
} finally { await rm(output, { recursive: true, force: true }); }
