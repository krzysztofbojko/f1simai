// Corner split of every circuit in tracks/: braking zone → arc → exit, a corner per real bend.
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = await mkdtemp(join(tmpdir(), 'f1-corners-'));
try {
  const entries = { car: 'physics/Car', track: 'track/Track', presets: 'track/Presets', vector: 'math/Vector2', spline: 'math/Spline' };
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: Object.fromEntries(Object.entries(entries).map(([key, path]) => [key, resolve('src/' + path + '.ts')])), formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const load = key => import(pathToFileURL(join(output, key + '.mjs')));
  const [{ Car }, { Track }, { Presets }, { Vector2 }, { Spline, pointGapFor }] = await Promise.all(Object.keys(entries).map(load));
  const fromFile = async file => {
    const data = JSON.parse(await readFile('tracks/' + file, 'utf8'));
    const width = Car.getDimensionsForTrackWidth(data.trackWidth).effectiveTrackWidth;
    const keepOrder = data.direction === 'clockwise' || data.direction === 'counterclockwise';
    return new Track(Spline.generateClosedTrack(data.rawPoints.map(p => new Vector2(p.x, p.y)), width, keepOrder, pointGapFor(data.pointSpacing)), width);
  };
  const files = (await readdir('tracks')).filter(f => f.endsWith('.json') && f !== 'index.json').sort();
  const counts = {};
  const check = (name, track) => {
    const { corners, zone, phase } = track.corners, n = track.points.length;
    assert.equal(zone.length, n);
    assert.ok(corners.length >= 3, `${name}: ${corners.length} corners`);
    for (const c of corners) {
      // Arc points carry the corner's id and bend; its zone is one run braking → arc → exit.
      assert.equal(zone[c.apex], c.id); assert.equal(phase[c.apex], 2, `${name}: apex inside the arc`);
      let i = c.brakeStart, last = 0;
      for (let k = 0; i !== c.exitEnd && k < n; k++, i = (i + 1) % n) {
        assert.equal(zone[i], c.id, `${name}: corner ${c.id} zone is contiguous`);
        assert.ok(phase[i] >= last, `${name}: phases in order`); last = phase[i];
      }
    }
    // Each point lies in at most one zone, and every arc point bends.
    const arcPoints = [...phase].filter(p => p === 2).length;
    assert.ok(arcPoints > 0 && arcPoints < n, `${name}: arcs cover part of the lap`);
    counts[name] = corners.length;
  };
  for (const file of files) check(file.replace('.json', ''), await fromFile(file));
  check('gp-preset', Presets.createGrandPrixTrack(14));
  // Real corner counts (FIA numbering) the split should be close to: chicanes merge, kinks drop.
  for (const [name, real] of [['au-1953-melbourne', 14], ['it-1922-monza', 11], ['mc-1929-monaco', 19], ['at-1969-spielberg', 10], ['gb-1948-silverstone', 18]])
    assert.ok(counts[name] >= real * 0.5 && counts[name] <= real * 1.4, `${name}: ${counts[name]} corners for ${real} numbered turns`);
  console.log('Corner split passed:', Object.entries(counts).map(([k, v]) => `${k.replace(/^[a-z]{2}-\d{4}-/, '')} ${v}`).join(', '));
} finally {
  await rm(output, { recursive: true, force: true });
}
