// Endurance test of the real-circuit files in tracks/: every track is loaded the way the app loads
// a JSON file, then a full field trains on it headless for a share of the wall-clock budget.
// Reports length, laps, best lap, average/top speed (a scale check) and how much of the lap was driven.
// node scripts/test-tracks.mjs [minutes=20] [threads=12] [filter]
import { build } from 'vite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir, availableParallelism } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

if (isMainThread) {
  const minutes = Number(process.argv[2] ?? 20);
  const threads = Math.max(1, Math.min(Number(process.argv[3] ?? 12), availableParallelism()));
  const filter = process.argv[4] ?? '';
  const { tracks } = JSON.parse(await readFile('tracks/index.json', 'utf8'));
  const queue = tracks.filter(t => t.file.includes(filter));
  // Each track gets the same wall time; the rounds of `threads` tracks fill the budget.
  const perTrack = minutes * 60 / Math.ceil(queue.length / threads);
  const output = await mkdtemp(join(tmpdir(), 'f1-tracks-test-'));
  try {
    const entries = { population: 'ai/Population', car: 'physics/Car', track: 'track/Track', vector: 'math/Vector2', spline: 'math/Spline' };
    await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
      lib: { entry: Object.fromEntries(Object.entries(entries).map(([key, path]) => [key, resolve('src/' + path + '.ts')])), formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
    console.log(`${queue.length} torów, ${threads} wątków, ${perTrack.toFixed(0)} s na tor (łącznie ~${minutes} min)`);
    const results = [];
    let next = 0;
    const run = () => new Promise(done => {
      const take = () => {
        if (next >= queue.length) return done();
        const t = queue[next++];
        const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { output, file: join('tracks', t.file), seconds: perTrack, seed: next * 7919 } });
        worker.once('message', r => {
          results.push(r);
          console.log(format(r));
        });
        worker.once('error', error => { results.push({ file: t.file, error: error.message }); console.log(`${t.file}: BŁĄD ${error.message}`); });
        worker.once('exit', take);
      };
      take();
    });
    await Promise.all(Array.from({ length: threads }, run));

    results.sort((a, b) => a.file.localeCompare(b.file));
    const problems = results.filter(r => r.error || r.issues?.length);
    console.log('\nPODSUMOWANIE');
    for (const r of results) console.log(format(r));
    console.log(problems.length ? `\nProblemy: ${problems.length}\n${problems.map(r => `  ${r.file}: ${r.error ?? r.issues.join('; ')}`).join('\n')}` : '\nWszystkie tory bez problemów.');
    if (problems.some(r => r.error)) process.exitCode = 1;
  } finally { await rm(output, { recursive: true, force: true }); }
} else {
  const { output, file, seconds, seed } = workerData;
  const load = name => import(pathToFileURL(join(output, name + '.mjs')));
  const [{ Population }, { Car }, { Track }, { Vector2 }, { Spline }] = await Promise.all(['population', 'car', 'track', 'vector', 'spline'].map(load));
  let state = seed >>> 0;
  Math.random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };

  // Same path as loading the file in the app (main.ts loadTrackFromJSON -> worker SET_CUSTOM_TRACK).
  const data = JSON.parse(await readFile(file, 'utf8'));
  const width = Car.getDimensionsForTrackWidth(data.trackWidth).effectiveTrackWidth;
  const keepOrder = data.direction === 'clockwise' || data.direction === 'counterclockwise';
  const track = new Track(Spline.generateClosedTrack(data.rawPoints.map(p => new Vector2(p.x, p.y)), width, 18, keepOrder), width);
  const pop = new Population(Population.MAX_CARS, track);

  // Driving direction as seen on screen (y down): signed area of the centre line in point order.
  const pts = track.points;
  const area = pts.reduce((sum, p, i) => { const q = pts[(i + 1) % pts.length].center; return sum + p.center.x * q.y - q.x * p.center.y; }, 0);
  const simDirection = area > 0 ? 'clockwise' : 'counterclockwise';

  const visited = new Uint8Array(pts.length);
  let laps = 0, best = Infinity, topSpeed = 0, offRoad = 0, samples = 0, deaths = 0, invalid = 0, simSeconds = 0;
  const alive = new Map();
  pop.onLapCompleted = (car, event) => {
    laps++;
    if (!event.compromised && event.lapTime < best) best = event.lapTime;
  };
  const start = performance.now();
  for (let step = 0; performance.now() - start < seconds * 1000; step++) {
    pop.update(1 / 60, track);
    simSeconds += 1 / 60;
    if (step % 10) continue;
    for (const car of pop.cars) {
      const was = alive.get(car);
      if (was && !car.isAlive) deaths++;
      alive.set(car, car.isAlive);
      if (!car.isAlive) continue;
      if (!Number.isFinite(car.pos.x) || !Number.isFinite(car.pos.y) || !Number.isFinite(car.speedKmh)) { invalid++; continue; }
      samples++;
      topSpeed = Math.max(topSpeed, car.speedKmh);
      if (car.surface !== 'asphalt') offRoad++;
      else visited[track.sampleSurface(car.pos).index] = 1;
    }
  }
  const coverage = visited.reduce((a, b) => a + b, 0) / visited.length;
  const avgSpeed = Number.isFinite(best) ? track.totalLength / best * 3.6 : null;
  const issues = [];
  if (simDirection !== data.direction) issues.push(`kierunek w symulatorze ${simDirection}, w pliku ${data.direction}`);
  if (Math.abs(track.totalLength - data.lengthMeters) / data.lengthMeters > 0.01 && !data.note) issues.push(`długość ${Math.round(track.totalLength)} m zamiast ${data.lengthMeters} m`);
  if (invalid) issues.push(`${invalid} próbek z NaN`);
  if (!laps) issues.push('żadne okrążenie nie zostało ukończone');
  if (coverage < 0.98) issues.push(`przejechane tylko ${(coverage * 100).toFixed(0)}% toru`);
  if (avgSpeed !== null && (avgSpeed < 100 || avgSpeed > 280)) issues.push(`nierealna średnia prędkość ${avgSpeed.toFixed(0)} km/h`);
  parentPort.postMessage({
    file: data && file.split('/').pop(), name: data.name, length: Math.round(track.totalLength), width: data.trackWidth,
    direction: data.direction, simMinutes: simSeconds / 60, generation: pop.generation, laps,
    best: Number.isFinite(best) ? best : null, avgSpeed, topSpeed, offRoadPct: 100 * offRoad / Math.max(1, samples),
    deaths, coverage, issues,
  });
}

function format(r) {
  if (r.error) return `${r.file}: BŁĄD ${r.error}`;
  const lap = r.best ? `${Math.floor(r.best / 60)}:${(r.best % 60).toFixed(3).padStart(6, '0')}` : '   —   ';
  return `${r.file.padEnd(36)} ${String(r.length).padStart(5)} m  sym ${r.simMinutes.toFixed(0).padStart(3)} min  okr ${String(r.laps).padStart(4)}  best ${lap}`
    + `  śr ${r.avgSpeed ? r.avgSpeed.toFixed(0).padStart(3) : '  —'} km/h  max ${r.topSpeed.toFixed(0)} km/h  poza ${r.offRoadPct.toFixed(1)}%  tor ${(r.coverage * 100).toFixed(0)}%`
    + (r.issues.length ? `  !! ${r.issues.join('; ')}` : '');
}
