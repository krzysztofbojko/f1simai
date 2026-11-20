// How often the slide flags and wheel locks fire per speed band, for a lone rule-based expert.
// The kinematic → dynamic lateral blend sits at 8–16 m/s, so a flag share in that band well above
// the 16–25 m/s one points at the blend rather than at the driving.
// node scripts/diag-lowspeed.mjs [seconds=240] [tracks=gp,mc-1929-monaco,it-1922-monza,hu-1986-budapest] [--json]
import { build } from 'vite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = await mkdtemp(join(tmpdir(), 'f1-lowspeed-'));
try {
  const entries = { car: 'physics/Car', presets: 'track/Presets', track: 'track/Track', vector: 'math/Vector2', spline: 'math/Spline' };
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: Object.fromEntries(Object.entries(entries).map(([key, path]) => [key, resolve('src/' + path + '.ts')])), formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const load = name => import(pathToFileURL(join(output, name + '.mjs')));
  const [{ Car }, { Presets }, { Track }, { Vector2 }, { Spline, pointGapFor }] = await Promise.all(['car', 'presets', 'track', 'vector', 'spline'].map(load));
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const seconds = Number(args[0] ?? 240);
  const names = (args[1] ?? 'gp,mc-1929-monaco,it-1922-monza,hu-1986-budapest').split(',');
  const bands = [[0, 8], [8, 12], [12, 16], [16, 25], [25, Infinity]];
  const label = ([lo, hi]) => hi === Infinity ? `>${lo}` : `${lo}-${hi}`;
  const loadTrack = async name => {
    if (name === 'gp') return Presets.createGrandPrixTrack(14);
    const data = JSON.parse(await readFile(join('tracks', name + '.json'), 'utf8'));
    const width = Car.getDimensionsForTrackWidth(data.trackWidth).effectiveTrackWidth;
    const keepOrder = data.direction === 'clockwise' || data.direction === 'counterclockwise';
    return new Track(Spline.generateClosedTrack(data.rawPoints.map(p => new Vector2(p.x, p.y)), width, keepOrder, pointGapFor(data.pointSpacing)), width);
  };
  const report = [];
  for (const name of names) {
    let state = 12345;
    Math.random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
    const track = await loadTrack(name);
    const slot = track.getGridSlot(0);
    const car = new Car(slot.pos, slot.heading, null, '#fff', 'solo', 100, 25);
    car.currentCheckpointIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
    car.mistakesEnabled = false; car.lapPowerFactor = car.lapGripFactor = car.lapDragFactor = 1;
    car.rollLapPerformanceVariation = () => {};
    const stats = bands.map(() => ({ steps: 0, sliding: 0, skidding: 0, lock: 0, throttle: 0, latG: 0 }));
    const laps = [];
    let offRoad = 0, steps = 0;
    for (let i = 0; i < seconds * 60 && car.isAlive; i++) {
      car.updateSensors(track);
      const plan = car.planDrive(track);
      const event = car.updatePhysics(plan.expert, 1 / 60, track);
      if (event) laps.push(+event.lapTime.toFixed(3));
      steps++;
      if (car.surface !== 'asphalt') offRoad++;
      const s = stats[bands.findIndex(([lo, hi]) => car.speed >= lo && car.speed < hi)];
      s.steps++;
      if (car.isSliding) s.sliding++;
      if (car.isSkidding) s.skidding++;
      if (car.wheelLockFront || car.wheelLockRear) s.lock++;
      s.throttle += plan.expert.throttle;
      s.latG += Math.abs(car.lateralG);
    }
    const pct = (n, d) => d ? +(100 * n / d).toFixed(1) : 0;
    const rows = Object.fromEntries(bands.map((band, k) => {
      const s = stats[k];
      return [label(band), { share: pct(s.steps, steps), sliding: pct(s.sliding, s.steps), skidding: pct(s.skidding, s.steps), lock: pct(s.lock, s.steps),
        throttle: s.steps ? +(s.throttle / s.steps).toFixed(2) : 0, latG: s.steps ? +(s.latG / s.steps).toFixed(2) : 0 }];
    }));
    const clean = laps.slice(1);
    const result = { track: name, alive: car.isAlive, reason: car.eliminationReason ?? null, laps: laps.length,
      best: clean.length ? Math.min(...clean) : null, offRoadPct: pct(offRoad, steps), bands: rows };
    report.push(result);
    if (!process.argv.includes('--json')) {
      console.log(`\n${name}: okrążenia ${laps.length} [${laps.join(', ')}], najlepsze (bez 1.) ${result.best ?? '—'} s, poza asfaltem ${result.offRoadPct}%${car.isAlive ? '' : `, ODPADŁ: ${result.reason}`}`);
      console.table(rows);
    }
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(report));
} finally { await rm(output, { recursive: true, force: true }); }
