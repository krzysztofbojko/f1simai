import { Car, encodeDriverTargets } from '../physics/Car';
import { Presets } from '../track/Presets';
import { Track } from '../track/Track';
import { NeuralNetwork, type TopologySpecifier } from './NeuralNetwork';
import { LINE_EXTRA_INPUTS, lineInputs, seedLineTarget } from './LineNet';

interface Sample { inputs: number[]; targets: number[] }

const cache = new WeakMap<Track, Map<string, NeuralNetwork>>();
const lineCache = new WeakMap<Track, Map<number, NeuralNetwork>>();
let fallbackTrack: Track | null = null;

/** Small deterministic generator so a given track always distils the same teacher data. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Behaviour cloning with DAgger-style exploration: the rule-based expert drives
 * while steering disturbances push the car into off-line states; every visited
 * state is labelled with the expert's own response. The result is a network that
 * can drive the circuit by itself and that evolution/online learning then refine.
 */
export function collectExpertSamples(track: Track, rayCount: number, seconds: number, seed = 1, lineSamples?: Sample[]): Sample[] {
  const random = rng(seed);
  const samples: Sample[] = [];
  const dummy = new NeuralNetwork([rayCount + 5, 4, 3]);
  const n = track.checkpoints.length;
  const car = new Car(track.startPosition, track.startAngle, dummy, '#fff', 'teacher', 60, rayCount);
  car.mistakesEnabled = false;
  car.updateDimensionsForTrackWidth(track.width);
  const dt = 1 / 60;
  let disturbance = 0, disturbanceLeft = 0, nextCheck = 0, offsetTarget = 0, nextOffset = 0;
  const offsetLimit = Math.max(0, track.width / 2 - 2);
  const respawn = () => {
    const slot = Math.floor(random() * n);
    const cp = track.checkpoints[slot];
    car.reset(cp.center.add(cp.tangent.normal().mul((random() - .5) * track.width * .5)), cp.tangent.heading(), true, (slot + 1) % n);
    car.vel = cp.tangent.mul(random() < .3 ? random() * 6 : random() * 55);
    car.speed = car.vel.mag();
    car.mistakesEnabled = false;
    car.isAlive = true;
  };
  for (let step = 0; step < seconds * 60; step++) {
    if (!car.isAlive) { respawn(); continue; }
    if (car.fuelKg < 15) car.fuelKg = 60;
    if (step >= nextOffset) {
      nextOffset = step + 120 + Math.floor(random() * 360);
      offsetTarget = random() < .3 ? 0 : (random() * 2 - 1) * offsetLimit;
    }
    car.raceLineOffset += Math.max(-1.8 * dt, Math.min(1.8 * dt, offsetTarget - car.raceLineOffset));
    car.lineDeviation = Math.abs(car.raceLineOffset);
    car.updateSensors(track);
    const plan = car.planDrive(track);
    if (lineSamples && step % 6 === 0) lineSamples.push({ inputs: lineInputs(track, car), targets: [seedLineTarget(track, track.sampleSurface(car.pos).index)] });
    if (step % 3 === 0) {
      samples.push({ inputs: plan.inputs, targets: [...encodeDriverTargets([plan.idealSteer, plan.expert.throttle, plan.expert.brake])] });
    }
    if (disturbanceLeft <= 0 && step >= nextCheck) {
      nextCheck = step + 60 + Math.floor(random() * 240);
      disturbanceLeft = 15 + Math.floor(random() * 30);
      disturbance = (random() < .5 ? -1 : 1) * (.05 + random() * .35);
    }
    const control = { ...plan.expert };
    if (disturbanceLeft > 0) { control.steer = Math.max(-1, Math.min(1, control.steer + disturbance)); disturbanceLeft--; }
    car.updatePhysics(control, dt, track);
    if (car.recoveryTimer > 0 && car.surface !== 'asphalt') respawn();
  }
  return samples;
}

export function distillDriverNetwork(rayCount: number, topology: TopologySpecifier = 'Standard', track?: Track): NeuralNetwork {
  const useTrack = track ?? (fallbackTrack ??= Presets.createGrandPrixTrack(14));
  const key = `${rayCount}|${JSON.stringify(topology)}`;
  let perTrack = cache.get(useTrack);
  if (!perTrack) { perTrack = new Map(); cache.set(useTrack, perTrack); }
  const cached = perTrack.get(key);
  if (cached) return cached.clone();

  const lineSamples: Sample[] = [];
  const samples = collectExpertSamples(useTrack, rayCount, 240, 1, lineSamples);
  trainLineNetwork(useTrack, rayCount, lineSamples);
  const net = new NeuralNetwork(NeuralNetwork.resolveLayerSizes(rayCount + 5, topology, 3));
  const random = rng(7);
  const order = samples.map((_, i) => i);
  for (let epoch = 0; epoch < 40; epoch++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const rate = 0.03 * (1 - epoch / 50);
    for (const index of order) net.train(samples[index].inputs, samples[index].targets, rate);
  }
  perTrack.set(key, net);
  return net.clone();
}

function trainLineNetwork(track: Track, rayCount: number, samples: Sample[]): void {
  const net = new NeuralNetwork([rayCount + LINE_EXTRA_INPUTS, 14, 8, 1]);
  const random = rng(11);
  const order = samples.map((_, i) => i);
  for (let epoch = 0; epoch < 30; epoch++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const rate = 0.03 * (1 - epoch / 40);
    for (const index of order) net.train(samples[index].inputs, samples[index].targets, rate);
  }
  let perTrack = lineCache.get(track);
  if (!perTrack) { perTrack = new Map(); lineCache.set(track, perTrack); }
  perTrack.set(rayCount, net);
}

/** Seed racing-line network (full-width outside-inside-outside), distilled on sensor inputs. */
export function distillLineNetwork(rayCount: number, track?: Track): NeuralNetwork {
  const useTrack = track ?? (fallbackTrack ??= Presets.createGrandPrixTrack(14));
  if (!lineCache.get(useTrack)?.has(rayCount)) distillDriverNetwork(rayCount, 'Standard', useTrack);
  return lineCache.get(useTrack)!.get(rayCount)!.clone();
}
