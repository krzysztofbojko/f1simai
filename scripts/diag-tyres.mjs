// Tyre behaviour of a lone rule-based expert: what a calibration of the compounds is measured against.
//   stint:   each slick from new until 70% wear (the AI's pit threshold) or 60 laps, at a constant
//            50 kg of fuel so the lap time shows the tyre alone: pace of the first laps, degradation
//            per lap, laps to 70%, tread / carcass temperatures;
//   skidpad: steady cornering at 70% of the available grip at three speeds, temperatures after 60 s;
//   wet:     best lap on each compound across the wetness, and the crossovers.
// node scripts/diag-tyres.mjs [stint|skidpad|wet|all=all] [tracks=gp,au-1953-melbourne,it-1922-monza] [--json]
// GRIP='{"medium":[1,0.6,0.4]}' overrides compound grip points for a calibration trial.
import { build } from 'vite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = await mkdtemp(join(tmpdir(), 'f1-tyres-'));
try {
  const entries = { car: 'physics/Car', presets: 'track/Presets', track: 'track/Track', vector: 'math/Vector2', spline: 'math/Spline', weather: 'physics/Weather', tyres: 'physics/Tyres' };
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: Object.fromEntries(Object.entries(entries).map(([key, path]) => [key, resolve('src/' + path + '.ts')])), formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const load = name => import(pathToFileURL(join(output, name + '.mjs')));
  const [{ Car }, { Presets }, { Track }, { Vector2 }, { Spline, pointGapFor }, { neutralWeather }, { COMPOUND_SPECS, compoundGrip }] = await Promise.all(['car', 'presets', 'track', 'vector', 'spline', 'weather', 'tyres'].map(load));
  // Calibration trials without editing Tyres.ts: GRIP='{"medium":[1,0.6,0.4]}' replaces those spec points.
  // WATER='0.2,0.25': trial of a grip loss every tyre suffers from water on the track, 0 dry, the
  // first value soaked, saturating over the second (wetness scale).
  if (process.env.WATER) {
    const [loss, tau] = process.env.WATER.split(',').map(Number), base = Car.tyreGrip;
    const water = w => 1 - loss * (1 - Math.exp(-w / tau)) / (1 - Math.exp(-1 / tau));
    Car.tyreGrip = (temp, wear, compound, wetness = 0) => base(temp, wear, compound, wetness) * water(Math.max(0, Math.min(1, wetness)));
    console.log('WATER', loss, tau, [0.25, 0.5, 0.75, 1].map(w => water(w).toFixed(3)).join(' '));
  }
  if (process.env.GRIP) {
    for (const [compound, grip] of Object.entries(JSON.parse(process.env.GRIP))) COMPOUND_SPECS[compound].grip = grip;
    if (Math.abs(Car.tyreGrip(COMPOUND_SPECS.medium.optimum, 0, 'medium', 0.5) - compoundGrip('medium', 0.5)) > 1e-12) throw new Error('GRIP did not reach the car module');
    console.log('GRIP', JSON.stringify(Object.fromEntries(Object.entries(COMPOUND_SPECS).map(([c, s]) => [c, s.grip]))));
  }
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const mode = args[0] ?? 'all';
  const trackNames = (args[1] ?? 'gp,au-1953-melbourne,it-1922-monza').split(',');
  const json = process.argv.includes('--json');
  const report = {};
  let state = 99;
  Math.random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const round = (x, n = 2) => +x.toFixed(n);
  const loadTrack = async name => {
    if (name === 'gp') return Presets.createGrandPrixTrack(14);
    const data = JSON.parse(await readFile(join('tracks', name + '.json'), 'utf8'));
    const width = Car.getDimensionsForTrackWidth(data.trackWidth).effectiveTrackWidth;
    const keepOrder = data.direction === 'clockwise' || data.direction === 'counterclockwise';
    return new Track(Spline.generateClosedTrack(data.rawPoints.map(p => new Vector2(p.x, p.y)), width, keepOrder, pointGapFor(data.pointSpacing)), width);
  };
  const tracks = new Map();
  for (const name of trackNames) tracks.set(name, await loadTrack(name));

  // A lone expert on fresh tyres of one compound; `onStep` sees every step, `stop` ends the run.
  const drive = (track, compound, wetness, maxSeconds, onStep = () => {}, stop = () => false) => {
    Car.config.weather = { ...neutralWeather(), wetness };
    const slot = track.getGridSlot(0);
    const car = new Car(slot.pos, slot.heading, null, '#fff', 'tyres', 100, 25);
    car.currentCheckpointIdx = (slot.checkpointIdx + 1) % track.checkpoints.length;
    car.mistakesEnabled = false; car.lapPowerFactor = car.lapGripFactor = car.lapDragFactor = 1;
    car.rollLapPerformanceVariation = () => {};
    // Race mode: the planner's corner margins stay at their proven values (no pace search probing)
    // and a lap counts whatever the wetness; the physics is the same in every session.
    car.isRaceMode = true;
    car.tyreCompound = compound; car.tyreWearFront = car.tyreWearRear = 0;
    const laps = [];
    // A lap counts unless the car left the asphalt (grass or gravel); a wheel over the white line
    // (track limits) still gives a usable time.
    let offAsphalt = false;
    for (let i = 0; i < maxSeconds * 60 && car.isAlive; i++) {
      car.fuelKg = 50;
      car.updateSensors(track);
      const plan = car.planDrive(track);
      car.wantsToPit = false;
      const event = car.updatePhysics(plan.expert, 1 / 60, track);
      onStep(car);
      if (car.surface !== 'asphalt') offAsphalt = true;
      if (event) { laps.push({ time: event.lapTime, wear: Math.max(car.tyreWearFront, car.tyreWearRear), compromised: offAsphalt }); offAsphalt = false; }
      if (event && stop(car, laps)) break;
    }
    Car.config.weather = neutralWeather();
    return { car, laps };
  };

  if (mode === 'all' || mode === 'stint') {
    report.stint = [];
    for (const [name, track] of tracks) for (const compound of ['soft', 'medium', 'hard']) {
      let tread = 0, carcass = 0, frontTread = 0, n = 0;
      const { car, laps } = drive(track, compound, 0, 60 * 140, c => {
        if (c.speed < 20) return;
        tread += (c.tyreSurfaceTempFront + c.tyreSurfaceTempRear) / 2; carcass += (c.tyreTempFront + c.tyreTempRear) / 2; frontTread += c.tyreSurfaceTempFront; n++;
      }, (c, list) => list.length >= 61 || Math.max(c.tyreWearFront, c.tyreWearRear) >= 0.7);
      // Lap 1 is the standing start; laps 2–4 are the fresh-tyre pace, the slope over the stint the degradation.
      const flying = laps.slice(1);
      const early = flying.slice(0, 3).map(l => l.time);
      const xs = flying.map((_, i) => i), ys = flying.map(l => l.time);
      const mx = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length), my = ys.reduce((a, b) => a + b, 0) / Math.max(1, ys.length);
      const slope = xs.length > 2 ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0) : NaN;
      const worn = Math.max(car.tyreWearFront, car.tyreWearRear);
      report.stint.push({ track: name, compound, alive: car.isAlive, laps: flying.length, to70: worn >= 0.7 ? flying.length : null,
        firstLaps: early.length ? round(early.reduce((a, b) => a + b, 0) / early.length, 3) : null, degPerLap: round(slope, 3),
        wearPerLap: flying.length ? round(100 * worn / laps.length, 2) : null, tread: n ? round(tread / n, 1) : null, carcass: n ? round(carcass / n, 1) : null,
        frontTread: n ? round(frontTread / n, 1) : null, offLaps: laps.filter(l => l.compromised).length });
    }
    if (!json) { console.log('\nStint na nowych oponach (paliwo stałe 50 kg, ekspert)'); console.table(report.stint); }
  }

  if (mode === 'all' || mode === 'skidpad') {
    report.skidpad = [];
    const plane = { checkpoints: [], timingGates: [], width: 400, isOutOfBounds: () => false };
    for (const compound of ['soft', 'medium', 'hard']) for (const v of [30, 50, 70]) {
      Car.config.weather = neutralWeather();
      const c = new Car(new Vector2(0, 0), 0);
      c.pos = new Vector2(0, 0); c.prevPos = new Vector2(0, 0); c.vel = new Vector2(v, 0); c.speed = v;
      c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1; c.tyreCompound = compound; c.setTyreTemps(85);
      let steer = 0;
      for (let i = 0; i < 60 * 60; i++) {
        c.fuelKg = 50; c.timeSinceCheckpoint = 0;
        // 70% of the grip the axles have at this speed (weight plus downforce), by yaw rate.
        const grip = c.baseTireGrip * Math.min(c.tyreGripFront, c.tyreGripRear) * (1 + 0.5 * c.airDensity * c.downforceCoeff * v * v / (c.totalMass * Car.GRAVITY));
        const yawTarget = 0.7 * grip * Car.GRAVITY / v;
        steer = Math.max(-1, Math.min(1, steer + 0.02 * (yawTarget - c.angularVelocity) / Math.max(0.05, yawTarget)));
        const throttle = Math.max(0, Math.min(1, 0.4 + 0.3 * (v - c.speed)));
        c.updatePhysics({ steer, throttle, brake: 0 }, 1 / 60, plane);
      }
      report.skidpad.push({ compound, speed: v, latG: round(Math.abs(c.lateralG)), held: round(c.speed, 1), treadF: round(c.tyreSurfaceTempFront, 1), treadR: round(c.tyreSurfaceTempRear, 1),
        carcassF: round(c.tyreTempFront, 1), carcassR: round(c.tyreTempRear, 1), gripF: round(c.tyreGripFront, 3), gripR: round(c.tyreGripRear, 3) });
    }
    if (!json) { console.log('\nSkidpad: 70% dostępnej przyczepności, temperatury po 60 s'); console.table(report.skidpad); }
  }

  if (mode === 'all' || mode === 'wet') {
    report.wet = [];
    const track = tracks.values().next().value, name = tracks.keys().next().value;
    const steps = 20, compounds = ['medium', 'intermediate', 'wet'];
    const best = {};
    for (const compound of compounds) for (let k = 0; k <= steps; k++) {
      const { laps } = drive(track, compound, k / steps, 60 * 20, () => {}, (_, list) => list.length >= 4);
      const flying = laps.slice(1).filter(l => !l.compromised).map(l => l.time);
      (best[compound] ??= [])[k] = flying.length ? Math.min(...flying) : null;
    }
    const dry = best.medium[0];
    for (let k = 0; k <= steps; k++) {
      const row = { wetness: k / steps };
      for (const compound of compounds) row[compound] = best[compound][k] === null ? null : round(100 * best[compound][k] / dry, 1);
      row.fastest = compounds.filter(c => best[c][k] !== null).sort((a, b) => best[a][k] - best[b][k])[0] ?? null;
      report.wet.push(row);
    }
    // Where the wetter tyre first beats the drier one, interpolated between the samples, and the lap
    // time there against the dry lap (Pirelli: slick → intermediate at about 112%, → wet at about 116–118%).
    const crossover = (drier, wetter) => {
      for (let k = 1; k <= steps; k++) {
        const [a0, a1, b0, b1] = [best[drier][k - 1], best[drier][k], best[wetter][k - 1], best[wetter][k]];
        if (b1 === null || b0 === null) continue;
        if (a1 !== null && b1 >= a1) continue;
        if (a1 === null || a0 === null) return { wetness: k / steps, lapPct: round(100 * b1 / dry, 1) };
        const t = (a0 - b0) / ((a0 - b0) - (a1 - b1));
        return { wetness: round((k - 1 + t) / steps, 3), lapPct: round(100 * (b0 + (b1 - b0) * t) / dry, 1) };
      }
      return null;
    };
    report.crossovers = { track: name, dryLap: round(dry, 3), slickToIntermediate: crossover('medium', 'intermediate'), intermediateToWet: crossover('intermediate', 'wet'),
      soakedWet: best.wet[steps] === null ? null : round(100 * best.wet[steps] / dry, 1) };
    if (!json) {
      console.log(`
Najlepsze okrążenie wg wilgotności, % suchego okrążenia na medium (${name}, ekspert, po 3 okrążenia)`);
      console.table(report.wet);
      console.log('Zmiany opon:', JSON.stringify(report.crossovers));
    }
  }
  if (json) console.log(JSON.stringify(report));
} finally { await rm(output, { recursive: true, force: true }); }
