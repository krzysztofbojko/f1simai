// Driving in each weather scenario: the full field training (default) or a lone rule-based expert.
// Reports laps, lap times, time off the asphalt, wrecks, wheel locks, slides and aquaplaning, and for the field
// the guardian's interventions by cause (brake = emergency braking beyond the plan).
// node scripts/diag-weather.mjs [seconds=600] [scenarios=sunny,windy,storm,shower] [seeds=1,2,3] [--expert] [--json] [--wrecks]
// --switch creates the field in dry weather and then changes the forecast, as the weather panel does
// during a session (the rain soaks a track the cars are on slicks on);
// --wrecks lists every wreck with the car's state 1 s before it; GRIP='{"wet":[0.75,0.72,0.67]}' overrides compound grip points.
import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = await mkdtemp(join(tmpdir(), 'f1-weather-diag-'));
try {
  const entries = { car: 'physics/Car', weather: 'physics/Weather', population: 'ai/Population', presets: 'track/Presets', tyres: 'physics/Tyres' };
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: Object.fromEntries(Object.entries(entries).map(([key, path]) => [key, resolve('src/' + path + '.ts')])), formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const load = name => import(pathToFileURL(join(output, name + '.mjs')));
  const [{ Car }, { Weather }, { Population }, { Presets }, { COMPOUND_SPECS }] = await Promise.all(['car', 'weather', 'population', 'presets', 'tyres'].map(load));
  if (process.env.GRIP) for (const [compound, grip] of Object.entries(JSON.parse(process.env.GRIP))) COMPOUND_SPECS[compound].grip = grip;
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const seconds = Number(args[0] ?? 600);
  const scenarios = (args[1] ?? 'sunny,windy,storm,shower').split(',');
  const seeds = (args[2] ?? '1,2,3').split(',').map(Number);
  const expert = process.argv.includes('--expert');
  const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const rows = [], wreckLog = [];
  for (const scenario of scenarios) for (const seed of seeds) {
    let state = seed * 7919 + 1;
    Math.random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
    const weather = new Weather(process.argv.includes('--switch') ? 'sunny' : scenario, seed);
    Car.config.weather = weather.state;
    const track = Presets.createGrandPrixTrack(14);
    const pop = new Population(expert ? 1 : Population.MAX_CARS, track);
    if (process.argv.includes('--switch')) weather.changeForecast(scenario, seed);
    pop.setConditions(weather.conditions);
    if (expert) for (const c of pop.cars) {
      c.mistakesEnabled = false;
      c.getAIControl = (t, l) => { const p = c.planDrive(t, l); c.currentControl = p.expert; return p.expert; };
    }
    const laps = [];
    pop.onLapCompleted = (car, event) => { if (!event.compromised) laps.push(event.lapTime); };
    const alive = new Map(), history = new Map();
    let frames = 0, offRoad = 0, locked = 0, sliding = 0, wrecks = 0, wetSum = 0, aquaplaning = 0;
    for (let step = 0; step < seconds * 60; step++) {
      weather.step(1 / 60);
      pop.setConditions(weather.conditions);
      pop.update(1 / 60, track);
      wetSum += weather.state.wetness;
      for (const car of pop.cars) {
        if (alive.get(car) && !car.isAlive) {
          wrecks++;
          const before = (history.get(car) ?? [])[0] ?? {};
          wreckLog.push({ scenario, seed, t: +(step / 60).toFixed(1), reason: car.eliminationReason, idx: track.sampleSurface(car.pos).index, ...before });
        }
        alive.set(car, car.isAlive);
        if (car.isAlive) {
          // The car's state a second ago (60 steps), for the wreck log.
          const h = history.get(car) ?? []; history.set(car, h);
          h.push({ v: +car.speed.toFixed(1), surface: car.surface, wet: +weather.state.wetness.toFixed(2), tyre: car.tyreCompound, slide: car.isSliding, stress: car.stressLap,
            guarded: car.lastGuarded, emergency: car.lastEmergencyBrake, thr: +car.currentControl.throttle.toFixed(2), brk: +car.currentControl.brake.toFixed(2), steer: +car.currentControl.steer.toFixed(2),
            latG: +car.lateralG.toFixed(2), gripF: +car.tyreGripFront.toFixed(2), gripR: +car.tyreGripRear.toFixed(2), uS: +car.understeerSlip.toFixed(2), oS: +car.oversteerSlip.toFixed(2), recovery: car.recoveryTimer > 0, aqua: +car.aquaplaning.toFixed(2) });
          if (h.length > 60) h.shift();
        } else history.delete(car);
        if (!car.isAlive || car.isPitting) continue;
        frames++;
        if (car.surface !== 'asphalt') offRoad++;
        if (car.wheelLockFront || car.wheelLockRear) locked++;
        if (car.isSliding) sliding++;
        if (car.aquaplaning > 0) aquaplaning++;
      }
    }
    const causes = { steer: 0, guard: 0, brake: 0, launch: 0, clearance: 0 };
    let aiSteps = 0;
    for (const car of pop.cars) { aiSteps += car.aiSteps; for (const key of Object.keys(causes)) causes[key] += car.interventionCauses[key]; }
    const pct = n => +(100 * n / Math.max(1, frames)).toFixed(2);
    const row = { scenario, seed, wetness: +(wetSum / (seconds * 60)).toFixed(2), laps: laps.length,
      best: laps.length ? +Math.min(...laps).toFixed(2) : null, median: laps.length ? +median(laps).toFixed(2) : null,
      offRoadPct: pct(offRoad), lockPct: pct(locked), slidePct: pct(sliding), aquaplanePct: pct(aquaplaning), wrecksPerMin: +(wrecks / (seconds / 60)).toFixed(2),
      ...(expert ? {} : { emergencyBrakePct: +(100 * causes.brake / Math.max(1, aiSteps)).toFixed(3), guardPct: +(100 * causes.guard / Math.max(1, aiSteps)).toFixed(2) }) };
    rows.push(row);
    if (!process.argv.includes('--json')) console.log(JSON.stringify(row));
  }
  const mean = (list, key) => { const v = list.map(r => r[key]).filter(x => typeof x === 'number'); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3) : null; };
  const summary = scenarios.map(scenario => {
    const list = rows.filter(r => r.scenario === scenario);
    return Object.fromEntries([['scenario', scenario], ...Object.keys(list[0]).filter(k => !['scenario', 'seed'].includes(k)).map(k => [k, mean(list, k)])]);
  });
  if (process.argv.includes('--wrecks')) {
    console.log(`
Wraki (${wreckLog.length}), stan auta 1 s wcześniej:`);
    for (const w of wreckLog) console.log(JSON.stringify(w));
    const share = key => wreckLog.length ? +(wreckLog.filter(w => w[key]).length / wreckLog.length).toFixed(2) : 0;
    const by = key => Object.entries(wreckLog.reduce((m, w) => { m[w[key]] = (m[w[key]] ?? 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
    console.log('przyczyny', JSON.stringify(by('reason')), 'opony', JSON.stringify(by('tyre')), 'nawierzchnia 1 s wcześniej', JSON.stringify(by('surface')),
      'udział: stres', share('stress'), 'strażnik', share('guarded'), 'hamowanie awaryjne', share('emergency'), 'poślizg', share('slide'), 'odzyskiwanie', share('recovery'));
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify({ rows, summary }));
  else { console.log(`\n${expert ? 'Ekspert solo' : 'Stawka w treningu'}, ${seconds} s, ziarna ${seeds.join(',')}: średnie`); console.table(summary); }
} finally { await rm(output, { recursive: true, force: true }); }
