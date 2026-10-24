// Expert-driven car per pace margin on the GP preset: lap times, tyre temperatures, braking and
// the slowest corners, over several seeds.
// node scripts/diag-corners.mjs [laps] [pace,pace,...] [seeds]
// Real circuits instead: node scripts/diag-corners.mjs --tracks [filter] (slowest point of a lap on each file in tracks/).
// Env overrides for calibration: HEAT (Car.TYRE_HEAT_SCALE), BRAKE (Car.PLAN_BRAKE_GRIP), CORNERS=1 (corner table).
import { build } from 'vite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = await mkdtemp(join(tmpdir(), 'f1-corners-'));
try {
  const entries = { car: 'physics/Car', presets: 'track/Presets', random: 'math/Random', track: 'track/Track', vector: 'math/Vector2', spline: 'math/Spline', line: 'track/RacingLine' };
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: Object.fromEntries(Object.entries(entries).map(([key, path]) => [key, resolve('src/' + path + '.ts')])), formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const load = name => import(pathToFileURL(join(output, name + '.mjs')));
  const [{ Car }, { Presets }, { seedRandom }, { Track }, { Vector2 }, { Spline, pointGapFor }, { getRacingLine }] = await Promise.all(Object.keys(entries).map(load));
  if (process.env.HEAT) Car.TYRE_HEAT_SCALE = Number(process.env.HEAT);
  if (process.env.BRAKE) Car.PLAN_BRAKE_GRIP = Number(process.env.BRAKE);

  const soloCar = (track) => {
    const slot = track.getGridSlot(0);
    const car = new Car(slot.pos, slot.heading, null, '#fff', 'solo', 100, 25);
    car.currentCheckpointIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
    car.mistakesEnabled = false; car.lapPowerFactor = car.lapGripFactor = car.lapDragFactor = 1;
    car.rollLapPerformanceVariation = () => {};
    return car;
  };

  if (process.argv[2] === '--tracks') {
    const filter = process.argv[3] ?? '';
    const { tracks } = JSON.parse(await readFile('tracks/index.json', 'utf8'));
    const radius = k => 1 / Math.max(1e-6, Math.abs(k));
    const speeds = [];
    for (const t of tracks.filter(x => x.file.includes(filter))) {
      seedRandom(1);
      // Loaded the way the app loads a track file (see scripts/test-tracks.mjs).
      const data = JSON.parse(await readFile(join('tracks', t.file), 'utf8'));
      const width = Car.getDimensionsForTrackWidth(data.trackWidth).effectiveTrackWidth;
      const keepOrder = data.direction === 'clockwise' || data.direction === 'counterclockwise';
      const track = new Track(Spline.generateClosedTrack(data.rawPoints.map(p => new Vector2(p.x, p.y)), width, keepOrder, pointGapFor(data.pointSpacing)), width);
      const minCentre = Math.min(...track.points.map(q => radius(q.curvature)));
      const minLine = Math.min(...Array.from(getRacingLine(track).curvature, radius));
      const car = soloCar(track);
      let laps = 0, lapTime = NaN, slow = null;
      for (let step = 0; step < 450 * 60 && laps < 2; step++) {
        car.updateSensors(track);
        const plan = car.planDrive(track);
        const ev = car.updatePhysics(plan.expert, 1 / 60, track);
        if (!car.isAlive) break;
        if (ev) { laps++; lapTime = ev.lapTime; }
        // The flying lap only: the first starts from the grid.
        if (laps === 1 && (!slow || car.speed < slow.v)) {
          const here = track.sampleSurface(car.pos);
          slow = { v: car.speed, rc: radius(track.points[here.index].curvature), rl: radius(car.lineProfile.curvature(track, here.index)), latG: Math.abs(car.lateralG), util: car.tireUtilization };
        }
      }
      if (slow) speeds.push(slow.v * 3.6);
      console.log(`${t.file.padEnd(36)} min R centre ${minCentre.toFixed(1).padStart(5)} line ${minLine.toFixed(1).padStart(5)} m  `
        + (slow && laps >= 2 ? `vmin ${(slow.v * 3.6).toFixed(0).padStart(3)} km/h (R ${slow.rc.toFixed(0)}/${slow.rl.toFixed(0)} m, ${slow.latG.toFixed(2)} g, util ${slow.util.toFixed(2)})  lap ${lapTime.toFixed(2)} s` : 'no flying lap')
        + (car.isAlive ? '' : `  OUT ${car.eliminationReason}`));
    }
    const sorted = speeds.sort((a, b) => a - b);
    if (sorted.length) console.log(`vmin over ${sorted.length} tracks: lowest ${sorted[0].toFixed(0)}, median ${sorted[sorted.length >> 1].toFixed(0)} km/h`);
  } else {
  const laps = Number(process.argv[2] ?? 4);
  const paces = (process.argv[3] ?? '1,1.15,1.3').split(',').map(Number);
  const seeds = Number(process.argv[4] ?? 4);
  const gp = Presets.createGrandPrixTrack(14);
  const dt = 1 / 60;
  // Corners: runs of centreline curvature above 1/120 m.
  const isCorner = (i) => Math.abs(gp.points[i].curvature) > 1 / 120;
  const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;

  const drive = (pace, seed) => {
    seedRandom(seed);
    const car = soloCar(gp);
    car.pace.margin = car.pace.bestMargin = car.pace.ceiling = pace;
    car.pace.finishLap = () => {}; car.pace.fail = () => {};
    const r = { lapTimes: [], temps: [], off: 0, locked: 0, brakeDist: 0, brakeDv: 0, brakeTime: 0, corners: [], out: null };
    let current = null, prevSpeed = car.speed;
    for (let step = 0; step < laps * 150 * 60 && r.lapTimes.length < laps; step++) {
      car.updateSensors(gp);
      const plan = car.planDrive(gp);
      const ev = car.updatePhysics(plan.expert, dt, gp);
      if (!car.isAlive) { r.out = car.eliminationReason; break; }
      const here = gp.sampleSurface(car.pos);
      if (here.surface !== 'asphalt') r.off += dt;
      // Statistics from the second lap on (the first starts from the grid).
      if (r.lapTimes.length >= 1) {
        if (car.wheelLockFront || car.wheelLockRear) r.locked += dt;
        if (plan.expert.brake > 0.05) { r.brakeDist += car.speed * dt; r.brakeDv += prevSpeed - car.speed; r.brakeTime += dt; }
        if (isCorner(here.index)) {
          if (!current) current = { start: here.index, vMin: Infinity, util: 0, latG: 0 };
          current.vMin = Math.min(current.vMin, car.speed);
          current.util = Math.max(current.util, car.tireUtilization);
          current.latG = Math.max(current.latG, Math.abs(car.lateralG));
        } else if (current) { r.corners.push(current); current = null; }
      }
      prevSpeed = car.speed;
      if (ev) { r.lapTimes.push(ev.lapTime); r.temps.push((car.tyreTempFront + car.tyreTempRear) / 2); }
    }
    return r;
  };

  console.log(`HEAT ${Car.TYRE_HEAT_SCALE}  BRAKE ${Car.PLAN_BRAKE_GRIP}  ${laps} laps x ${seeds} seeds`);
  for (const pace of paces) {
    const runs = Array.from({ length: seeds }, (_, s) => drive(pace, s + 1));
    const flying = runs.flatMap((r) => r.lapTimes.slice(1));
    const temps = runs.flatMap((r) => r.temps.slice(1));
    const brakeTime = runs.reduce((a, r) => a + r.brakeTime, 0);
    console.log(`pace ${pace.toFixed(2)}  flying ${mean(flying).toFixed(2)} s (best ${Math.min(...flying).toFixed(2)})`
      + `  out ${runs.filter((r) => r.out).length}/${seeds}  off ${mean(runs.map((r) => r.off)).toFixed(1)} s`
      + `  tyres ${mean(temps).toFixed(0)} C  braking ${(runs.reduce((a, r) => a + r.brakeDist, 0) / Math.max(1, flying.length)).toFixed(0)} m/lap`
      + ` @ ${(runs.reduce((a, r) => a + r.brakeDv, 0) / Math.max(dt, brakeTime) / 9.81).toFixed(2)} g  locked ${mean(runs.map((r) => r.locked)).toFixed(1)} s`);
    if (process.env.CORNERS) {
      // The last lap of the first seed that finished, slowest corners first.
      const r = runs.find((x) => x.lapTimes.length > 1);
      if (!r) continue;
      const perLap = r.corners.slice(-Math.ceil(r.corners.length / (r.lapTimes.length - 1)));
      for (const c of perLap.sort((a, b) => a.vMin - b.vMin).slice(0, 8))
        console.log(`  corner @${String(c.start).padStart(5)}  vmin ${(c.vMin * 3.6).toFixed(0).padStart(3)} km/h  util ${c.util.toFixed(2)}  latG ${c.latG.toFixed(2)}`);
    }
  }
  }
} finally { await rm(output, { recursive: true, force: true }); }
