// Builds loadable track files (F1_AI_TRACK JSON) for real F1 circuits.
// Geometry: scripts/data/f1-circuits.geojson (bacinger/f1-circuits, MIT).
// Facts: scripts/data/wikipedia-f1-circuits.json, parsed from
// https://pl.wikipedia.org/wiki/Lista_torów_Formuły_1 (CC BY-SA 4.0).
// Every track is validated with the simulator's own Spline + Track before it is written.
import { build } from 'vite';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const OUT_DIR = resolve('tracks');
const SPACING = 25;           // m between control points (the spline drops points closer than 18 m)
/** Other steps tried when the spline makes a corner tighter than MIN_RADIUS (a hairpin cut between samples). */
const SPACING_FALLBACK = [24, 23, 22, 21, 20, 26, 27, 28, 29, 30];
/** Tightest centre-line radius allowed (m): the car turns no tighter than about 8.5 m at full lock. */
const MIN_RADIUS = 9.5;
/**
 * Typical asphalt width of each circuit (m, averaged over the lap; approximate public figures).
 * A track loads at its real width; where the simulator's validation rejects it (the asphalt of
 * neighbouring sections would overlap), the next narrower whole metre is tried, down to 8 m.
 */
const REAL_WIDTH = {
  'ae-2009': 15, 'ar-1952': 12, 'at-1969': 13, 'au-1953': 13, 'az-2016': 12, 'be-1925': 12,
  'bh-2002': 15, 'br-1940': 13, 'br-1977': 12, 'ca-1978': 11, 'cn-2004': 15, 'de-1927': 13,
  'de-1932': 13, 'es-1991': 13, 'fr-1960': 13, 'fr-1969': 13, 'gb-1948': 15, 'hu-1986': 12,
  'it-1914': 13, 'it-1922': 13, 'it-1953': 12, 'jp-1962': 12, 'mc-1929': 10, 'mx-1962': 13,
  'my-1999': 16, 'nl-1948': 11, 'pt-1972': 12, 'pt-2008': 13, 'qa-2004': 12, 'ru-2014': 14,
  'sa-2021': 12, 'sg-2008': 11, 'tr-2005': 15, 'us-1909': 15, 'us-1956': 11, 'us-2012': 15,
  'us-2022': 13, 'us-2023': 15, 'za-1961': 12,
};
const MIN_WIDTH = 8;
const widthsFor = id => {
  const real = REAL_WIDTH[id] ?? 14;
  return Array.from({ length: Math.max(1, real - MIN_WIDTH + 1) }, (_, i) => real - i);
};
const LENGTH_TOLERANCE = 0.05;
const SCALE_TOLERANCE = 0.002; // generated centre line within 0.2 % of the target length
const EARTH_RADIUS = 6371008.8;

/** bacinger id -> circuit name in the Wikipedia list. */
const MATCH = {
  'au-1953': 'Albert Park Circuit',
  'bh-2002': 'Bahrain International Circuit',
  'cn-2004': 'Shanghai International Circuit',
  'es-1991': 'Circuit de Barcelona-Catalunya',
  'mc-1929': 'Circuit de Monaco',
  'ca-1978': 'Circuit Gilles Villeneuve',
  'fr-1969': 'Circuit Paul Ricard',
  'at-1969': 'Red Bull Ring',
  'gb-1948': 'Silverstone Circuit',
  'de-1932': 'Hockenheimring',
  'hu-1986': 'Hungaroring',
  'be-1925': 'Circuit de Spa-Francorchamps',
  'it-1922': 'Autodromo Nazionale di Monza',
  'sg-2008': 'Marina Bay Street Circuit',
  'ru-2014': 'Sochi Autodrom',
  'jp-1962': 'Suzuka International Racing Course',
  'us-2012': 'Circuit of the Americas',
  'mx-1962': 'Autódromo Hermanos Rodríguez',
  'br-1940': 'Autódromo José Carlos Pace',
  'ae-2009': 'Yas Marina Circuit',
  'it-1953': 'Autodromo Enzo e Dino Ferrari',
  'de-1927': 'Nürburgring',
  'pt-2008': 'Autódromo Internacional do Algarve',
  'it-1914': 'Mugello Circuit',
  'my-1999': 'Sepang International Circuit',
  'tr-2005': 'Istanbul Park',
  'nl-1948': 'Circuit Park Zandvoort',
  'fr-1960': 'Circuit de Nevers Magny-Cours',
  'pt-1972': 'Autódromo do Estoril',
  'br-1977': 'Autódromo Internacional Nelson Piquet',
  'sa-2021': 'Jeddah Corniche Circuit',
  'us-2022': 'Miami International Autodrome',
  'qa-2004': 'Losail International Circuit',
  'az-2016': 'Baku City Circuit',
  'us-2023': 'Las Vegas Street Circuit',
  'us-1909': 'Indianapolis Motor Speedway',
  'ar-1952': 'Autódromo Oscar Alfredo Gálvez',
  'za-1961': 'Kyalami Circuit',
  'us-1956': 'Watkins Glen',
};

/** Where the Polish list's direction column is wrong, the source order (driving direction) wins. */
const DIRECTION_OVERRIDE = {
  'us-2023': 'counterclockwise', // Las Vegas Strip Circuit runs anticlockwise; the list says "Prawoskrętny"
};

/** Start line moved along the lap (m, negative = earlier) where the source starts at a corner. */
const START_OFFSET = {
  'mc-1929': -200, // the source starts at Sainte Dévote; the line is on Boulevard Albert 1er, before it
};

/** Notes for files whose geometry is not the layout F1 raced on. */
const NOTES = {
  'za-1961': 'Geometria to dzisiejsza konfiguracja Kyalami (ok. 4,5 km), nie tor z lat F1 (4,261 km).',
  'sg-2008': 'Geometria to konfiguracja od 2023 r. (4,94 km); długość z listy dotyczy wcześniejszej wersji.',
};

/** Target lengths where the source geometry is not the layout the list's length describes (null = keep the source scale). */
const TARGET_LENGTH = {
  'za-1961': null,
  'sg-2008': 4940,
};

const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Equirectangular projection around the first point: metres, x east, y south (screen down). */
function project(coords) {
  const [lon0, lat0] = coords[0], k = Math.PI / 180, cos0 = Math.cos(lat0 * k);
  return coords.map(([lon, lat]) => ({ x: EARTH_RADIUS * (lon - lon0) * k * cos0, y: -EARTH_RADIUS * (lat - lat0) * k }));
}

/** Closed polyline resampled at a fixed arc-length step, starting at the first point. */
function resample(points, step) {
  const n = points.length, cum = [0];
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    cum.push(cum[i] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = cum[n], count = Math.round(total / step), out = [];
  for (let s = 0, seg = 0; s < count; s++) {
    const d = s * total / count;
    while (cum[seg + 1] < d) seg++;
    const a = points[seg], b = points[(seg + 1) % n], f = (d - cum[seg]) / (cum[seg + 1] - cum[seg] || 1);
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
  }
  return { points: out, length: total };
}

/** Shoelace sum in screen coordinates (y down): positive = clockwise on screen, north up. */
const isClockwise = pts => pts.reduce((sum, p, i) => { const q = pts[(i + 1) % pts.length]; return sum + p.x * q.y - q.x * p.y; }, 0) > 0;

const output = await mkdtemp(join(tmpdir(), 'f1-tracks-'));
try {
  const entries = { car: 'physics/Car', track: 'track/Track', vector: 'math/Vector2', spline: 'math/Spline' };
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: Object.fromEntries(Object.entries(entries).map(([key, path]) => [key, resolve('src/' + path + '.ts')])), formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const modules = Object.fromEntries(await Promise.all(Object.keys(entries).map(async key => [key, await import(pathToFileURL(join(output, key + '.mjs')))])));
  const { Car } = modules.car, { Track } = modules.track, { Vector2 } = modules.vector, { Spline } = modules.spline;

  const geo = JSON.parse(await readFile('scripts/data/f1-circuits.geojson', 'utf8'));
  const wiki = JSON.parse(await readFile('scripts/data/wikipedia-f1-circuits.json', 'utf8'));
  const byName = new Map(wiki.map(r => [r.name, r]));

  await mkdir(OUT_DIR, { recursive: true });
  for (const f of await readdir(OUT_DIR)) if (f.endsWith('.json')) await unlink(join(OUT_DIR, f));

  const index = [], skipped = [], warnings = [], used = new Set();
  for (const feature of geo.features) {
    const p = feature.properties, row = byName.get(MATCH[p.id]);
    if (!row) { skipped.push({ id: p.id, name: p.Name, reason: 'brak na liście torów F1 z Wikipedii' }); continue; }
    used.add(row.name);

    let coords = feature.geometry.coordinates;
    const [a, b] = [coords[0], coords[coords.length - 1]];
    if (a[0] === b[0] && a[1] === b[1]) coords = coords.slice(0, -1);
    const projected = project(coords);
    let chosen = null, failure = '';
    for (const spacing of [SPACING, ...SPACING_FALLBACK]) {
      const notes = [];
      let { points, length } = resample(projected, spacing);

      // The source lists points from the start line in driving direction; trust the
      // Wikipedia direction where they disagree, keeping the start point.
      const sourceDirection = isClockwise(points) ? 'clockwise' : 'counterclockwise';
      let direction = sourceDirection;
      const wanted = DIRECTION_OVERRIDE[p.id] ?? row.direction;
      if (wanted === 'clockwise' || wanted === 'counterclockwise') {
        direction = wanted;
        if (direction !== sourceDirection) {
          points = [points[0], ...points.slice(1).reverse()];
          notes.push(`${row.name}: kolejność punktów odwrócona do kierunku z Wikipedii (${direction})`);
        }
      }

      if (START_OFFSET[p.id]) {
        const shift = ((Math.round(START_OFFSET[p.id] / (length / points.length)) % points.length) + points.length) % points.length;
        points = [...points.slice(shift), ...points.slice(0, shift)];
        notes.push(`${row.name}: linia startu przesunięta o ${START_OFFSET[p.id]} m`);
      }

      // The spline smooths the corners, so the centre line comes out a little shorter than the
      // polyline: scale the layout until the simulated lap is as long as the real one.
      const official = row.lengthMeters || p.length;
      const target = p.id in TARGET_LENGTH ? (TARGET_LENGTH[p.id] ?? length) : official;
      const build = scale => {
        const scaled = points.map(q => ({ x: q.x * scale, y: q.y * scale }));
        // Shift into positive coordinates with a 100 m margin.
        const minX = Math.min(...scaled.map(q => q.x)), minY = Math.min(...scaled.map(q => q.y));
        const raw = scaled.map(q => ({ x: Math.round((q.x - minX + 100) * 10) / 10, y: Math.round((q.y - minY + 100) * 10) / 10 }));
        let lastError = '';
        for (const width of widthsFor(p.id)) {
          try {
            const effective = Car.getDimensionsForTrackWidth(width).effectiveTrackWidth;
            const spline = Spline.generateClosedTrack(raw.map(q => new Vector2(q.x, q.y)), effective, true);
            if (spline.length < 8) throw new Error('za mało punktów');
            return { raw, width, track: new Track(spline, effective) };
          } catch (error) { lastError = error.message; }
        }
        return { error: lastError };
      };
      let scale = 1, accepted = build(scale);
      for (let i = 0; i < 6 && accepted.track && Math.abs(accepted.track.totalLength - target) / target > SCALE_TOLERANCE; i++) {
        scale *= target / accepted.track.totalLength;
        accepted = build(scale);
      }
      const minRadius = accepted.track ? Math.min(...accepted.track.points.map(q => 1 / Math.max(1e-6, Math.abs(q.curvature)))) : 0;
      const candidate = { accepted, length, scale, direction, official, target, notes, minRadius, spacing };
      if (!accepted.track) failure = accepted.error;
      if (accepted.track && (!chosen?.accepted.track || minRadius > chosen.minRadius)) chosen = candidate;
      if (accepted.track && minRadius >= MIN_RADIUS) break;
    }
    const { accepted, length, scale, direction, official, target, notes, minRadius, spacing } = chosen ?? { accepted: { error: failure } };
    if (accepted.track) {
      warnings.push(...notes);
      if (spacing !== SPACING) warnings.push(`${row.name}: krok ${spacing} m zamiast ${SPACING} m, najciaśniejszy promień ${minRadius.toFixed(1)} m`);
      if (minRadius < MIN_RADIUS) warnings.push(`${row.name}: najciaśniejszy promień ${minRadius.toFixed(1)} m < ${MIN_RADIUS} m`);
    }
    if (!accepted.track) { skipped.push({ id: p.id, name: row.name, reason: `symulator odrzuca geometrię: ${accepted.error}` }); continue; }

    const generated = Math.round(accepted.track.totalLength);
    if (Math.abs(scale - 1) > LENGTH_TOLERANCE) {
      warnings.push(`${row.name}: geometria przeskalowana ×${scale.toFixed(3)} do ${target} m (źródło: ${p.length} m, może to być inna konfiguracja)`);
    }
    if (Math.abs(generated - target) / target > LENGTH_TOLERANCE) warnings.push(`${row.name}: długość ${generated} m, docelowa ${target} m`);

    const [location, country] = row.location.includes(', ') ? row.location.split(/, (?=[^,]+$)/) : [row.location, row.location];
    const file = `${p.id}-${slug(p.Location)}.json`;
    const data = {
      type: 'F1_AI_TRACK', version: 1,
      name: row.name,
      country, location,
      circuitType: row.type.toLowerCase(),
      direction,
      lengthMeters: official,
      generatedLengthMeters: generated,
      sourceLengthMeters: Math.round(length),
      scale: Math.round(scale * 10000) / 10000,
      seasons: row.seasons,
      grandsPrix: row.grandsPrix,
      grandPrix: row.grandPrix,
      trackWidth: accepted.width,
      ...(NOTES[p.id] ? { note: NOTES[p.id] } : {}),
      source: {
        geometry: `bacinger/f1-circuits ${p.id} (MIT, https://github.com/bacinger/f1-circuits)`,
        data: 'https://pl.wikipedia.org/wiki/Lista_torów_Formuły_1 (CC BY-SA 4.0)',
      },
      rawPoints: accepted.raw,
    };
    await writeFile(join(OUT_DIR, file), JSON.stringify(data, null, 1) + '\n');
    index.push({ file, name: row.name, location, country, direction, lengthMeters: official, generatedLengthMeters: generated, trackWidth: accepted.width, circuitType: data.circuitType, grandsPrix: row.grandsPrix });
  }

  index.sort((x, y) => x.name.localeCompare(y.name, 'pl'));
  const missing = wiki.filter(r => !used.has(r.name)).map(r => ({ name: r.name, location: r.location, seasons: r.seasons }));
  await writeFile(join(OUT_DIR, 'index.json'), JSON.stringify({ tracks: index, skipped, missingGeometry: missing }, null, 1) + '\n');

  const directionText = d => d === 'clockwise' ? 'zgodnie z ruchem wskazówek' : 'przeciwnie do ruchu wskazówek';
  await writeFile(join(OUT_DIR, 'README.md'), `# Tory Formuły 1

Pliki \`F1_AI_TRACK\` do wczytania w symulatorze: przycisk **Wczytaj tor** albo przeciągnięcie pliku na widok toru.
Współrzędne są w metrach, pierwszy punkt leży na linii start/meta, a kolejność punktów to kierunek jazdy
(pole \`direction\`; symulator jej nie odwraca). Pliki generuje \`npm run build:tracks\` (\`scripts/build-tracks.mjs\`),
który sprawdza każdy tor tą samą walidacją co symulator; \`trackWidth\` to typowa rzeczywista szerokość asfaltu (przybliżona), a gdy walidacja jej nie przyjmuje, najbliższa węższa (co 1 m, min. 8 m).

| Plik | Tor | Kraj | Długość (plik / lista) | Kierunek | Szerokość |
|---|---|---|---|---|---|
${index.map(t => `| \`${t.file}\` | ${t.name} | ${t.country} | ${t.generatedLengthMeters} m / ${t.lengthMeters} m | ${directionText(t.direction)} | ${t.trackWidth} m |`).join('\n')}

Geometria jest przeskalowana (pole \`scale\`, zwykle 1,00–1,02), tak by linia środkowa po wygładzeniu splajnem symulatora
miała oficjalną długość toru (\`generatedLengthMeters\` ≈ \`lengthMeters\`, tolerancja 0,2 %). Wyjątki: Kyalami zachowuje skalę źródła
(dzisiejsza konfiguracja, inna niż w F1), Marina Bay ma długość konfiguracji od 2023 r. (4940 m).

## Pominięte

${skipped.map(s => `- ${s.name} (\`${s.id}\`): ${s.reason}`).join('\n')}

Bez geometrii w źródle (${missing.length} torów z listy): ${missing.map(m => m.name).join(', ')}.

## Źródła i licencje

- Geometria: [bacinger/f1-circuits](https://github.com/bacinger/f1-circuits), licencja MIT, © 2019-2025 Tomislav Bacinger (\`scripts/data/f1-circuits.LICENSE\`).
- Dane torów (typ, kierunek, lokalizacja, długość, sezony, liczba Grand Prix): [Lista torów Formuły 1](https://pl.wikipedia.org/wiki/Lista_tor%C3%B3w_Formu%C5%82y_1), Wikipedia, licencja CC BY-SA 4.0.
- Wyjątki: Las Vegas ma kierunek przeciwny do podanego na liście (tor jeździ się przeciwnie do ruchu wskazówek zegara). W Monaco źródło zaczyna się w zakręcie Sainte Dévote, więc linia startu jest przesunięta o 200 m wstecz, na Boulevard Albert 1er.

Test wytrzymałościowy: \`npm run test:tracks [minuty=20] [wątki=12] [filtr]\` trenuje pełną stawkę na każdym torze bez przeglądarki i sprawdza kierunek, długość, ukończone okrążenia, przejechaną część toru i średnią prędkość.
`);

  console.log(`Zapisano ${index.length} torów do ${OUT_DIR}`);
  for (const t of index) console.log(`  ${t.file.padEnd(36)} ${String(t.generatedLengthMeters).padStart(5)} m / ${String(t.lengthMeters).padStart(5)} m  szer. ${t.trackWidth} m  ${t.direction}`);
  if (skipped.length) { console.log('Pominięte:'); for (const s of skipped) console.log(`  ${s.id} ${s.name}: ${s.reason}`); }
  if (warnings.length) { console.log('Uwagi:'); for (const w of warnings) console.log(`  ${w}`); }
  console.log(`Bez geometrii w źródle: ${missing.length} torów z listy Wikipedii`);
} finally {
  await rm(output, { recursive: true, force: true });
}
