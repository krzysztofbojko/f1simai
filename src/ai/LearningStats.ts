import { emptyInterventions, type Car, type InterventionCounts } from '../physics/Car';
import type { NeuralNetwork } from './NeuralNetwork';
import type { Population } from './Population';
import { PaceSearch } from './PaceSearch';
import { PACE_FLOOR_BAND, type SupervisorAction, type SupervisorMode } from './TrainingSupervisor';

/**
 * Learning diagnostics: what each generation achieved and how the networks stand now. Pure
 * bookkeeping: it never draws from `random()`; only the training supervisor reads its history.
 */

export type LapOutcome = 'clean' | 'yellow' | 'compromised';
export type CrashKind = 'barrier' | 'car' | 'stuck' | 'wrong-way' | 'other';

export interface GenerationStats {
  generation: number;
  /** Simulated seconds the generation ran. */
  simSeconds: number;
  wallSeconds: number;
  /** Fastest and median clean lap of the generation. */
  bestLap: number | null;
  medianLap: number | null;
  /** Session record when the generation ended. */
  sessionBest: number | null;
  cleanLaps: number;
  /** Laps under someone else's yellow flag (still evaluated). */
  yellowLaps: number;
  /** Laps that never evaluate a brain (traffic, pressure change, island hand-over). */
  compromisedLaps: number;
  personalBests: number;
  /** Degraded brains sent back to the team's proven one. */
  reverts: number;
  trialsStarted: number;
  trialsWon: number;
  trialsLost: number;
  crashes: Record<CrashKind, number>;
  /** Share of AI steps the guardian overrode, overall and by cause (0..1); null without AI steps. */
  interventionRate: number | null;
  causes: InterventionCounts;
  onlineTrainSteps: number;
  islandAdoptions: number;
  /** Mean RMS weight distance of the team brains from the champion's. */
  diversity: number | null;
  meanMutationRate: number;
  /** Mean share of the champion's hidden neurons near the tanh limits in its last step; null without a champion. */
  hiddenSaturation: number | null;
  /** Mean grip margin of the AI drivers' pace search; null without AI drivers. */
  meanPaceMargin: number | null;
  /** Share of AI drivers whose pace search sits at its floor (0..1); null without AI drivers. */
  paceAtFloor: number | null;
}

export interface DriverStats {
  color: string;
  name: string;
  alive: boolean;
  champion: boolean;
  bestLap: number | null;
  lastLap: number | null;
  laps: number;
  /** Clean laps since the last personal best (the stagnation counter). */
  lapsSincePB: number;
  mutationRate: number;
  exploring: boolean;
  interventionRate: number | null;
  paceMargin: number;
  lineBest: number | null;
  distanceToChampion: number | null;
  crashes: number;
}

/** A driver at the end of a generation, as the session log keeps it. */
export type DriverLogRow = Pick<DriverStats, 'name' | 'color' | 'champion' | 'bestLap' | 'lastLap' | 'laps' | 'lapsSincePB'
  | 'mutationRate' | 'interventionRate' | 'crashes' | 'distanceToChampion' | 'paceMargin'>;

/** One finished generation in the session log: its summary and where every driver stood. */
export interface GenerationLogEntry extends GenerationStats {
  drivers: DriverLogRow[];
}

export interface LayerStats {
  inputs: number;
  outputs: number;
  meanAbsWeight: number;
  /** Share of neurons near the tanh limits in the last step (|a| > 0.95). */
  saturation: number;
}

export interface NetworkStats {
  driver: string;
  color: string;
  layerSizes: number[];
  parameters: number;
  layers: LayerStats[];
}

export type VerdictLevel = 'good' | 'warn' | 'bad' | 'info';

export interface Verdict {
  level: VerdictLevel;
  title: string;
  detail: string;
}

export interface LearningTrend {
  /** Seconds per generation (negative: getting faster) over the last generations with laps. */
  bestSlope: number | null;
  medianSlope: number | null;
  /** Change of the intervention share per generation. */
  interventionSlope: number | null;
  /** Generations since the session record last improved. */
  gensSinceRecord: number;
  /** Exploration trials that ended in a personal best, of all finished trials. */
  trialSuccess: number | null;
  /** Finished exploration trials over the session. */
  trials: number;
}

export interface LearningStatsView {
  generation: number;
  raceMode: boolean;
  sessionBest: number | null;
  /** The generation running now, so far. */
  current: GenerationStats;
  history: GenerationStats[];
  trend: LearningTrend;
  verdicts: Verdict[];
  drivers: DriverStats[];
  network: NetworkStats | null;
  supervisor: { mode: SupervisorMode; actions: SupervisorAction[] };
}

/** Generations the trend and the verdict look back over. */
export const TREND_WINDOW = 10;
/** Generations without a new record that count as a plateau. */
export const PLATEAU_GENERATIONS = 10;
/** Below this mean weight distance from the champion every team drives practically the same brain. */
export const COLLAPSE_DIVERSITY = 0.002;
const REGRESSION_MIN_GENERATIONS = 6;
/** Finished exploration trials before their success rate says anything. */
const MIN_TRIALS = 10;
const MAX_HISTORY = 400;
/** Generations of the session log that keep their per-driver rows; older ones keep only the summary. */
const LOG_DRIVER_GENERATIONS = 5000;

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Least-squares slope of y over x; null with fewer than two points or no spread in x. */
export function linearTrend(points: readonly { x: number; y: number }[]): number | null {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  return den > 0 ? num / den : null;
}

/** RMS difference of every weight and bias; null when the topologies differ. */
export function weightDistance(a: NeuralNetwork, b: NeuralNetwork): number | null {
  if (a.layerSizes.join() !== b.layerSizes.join()) return null;
  let sum = 0, count = 0;
  for (let l = 0; l < a.layers.length; l++) {
    const la = a.layers[l], lb = b.layers[l];
    for (let o = 0; o < la.weights.length; o++) {
      const ra = la.weights[o], rb = lb.weights[o];
      for (let i = 0; i < ra.length; i++) { sum += (ra[i] - rb[i]) ** 2; count++; }
      sum += (la.biases[o] - lb.biases[o]) ** 2; count++;
    }
  }
  return count ? Math.sqrt(sum / count) : 0;
}

export function layerStats(brain: NeuralNetwork): LayerStats[] {
  return brain.layers.map((layer, l) => {
    let abs = 0, count = 0;
    for (const row of layer.weights) for (const w of row) { abs += Math.abs(w); count++; }
    const saturated = layer.activations.filter(a => Math.abs(a) > 0.95).length;
    return { inputs: brain.layerSizes[l], outputs: brain.layerSizes[l + 1], meanAbsWeight: count ? abs / count : 0,
      saturation: layer.activations.length ? saturated / layer.activations.length : 0 };
  });
}

function addCauses(into: InterventionCounts, from: InterventionCounts): void {
  into.steer += from.steer; into.guard += from.guard; into.brake += from.brake; into.launch += from.launch; into.clearance += from.clearance;
}

const seconds = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2).replace('.', ',')} s/gen`;
const percent = (value: number) => `${Math.round(value * 100)}%`;

/** What the history says about the learning, most important first (Polish UI text). */
export function verdicts(history: readonly GenerationStats[], trend: LearningTrend): Verdict[] {
  const lapped = history.filter(g => g.bestLap !== null);
  if (lapped.length < 3) {
    return [{ level: 'info', title: 'Rozgrzewka', detail: `Za mało danych: ${lapped.length} z 3 generacji z czystym okrążeniem. Trend pojawi się po kolejnych generacjach.` }];
  }
  const result: Verdict[] = [];
  const recent = history.slice(-TREND_WINDOW);
  const firstRate = recent.find(g => g.interventionRate !== null)?.interventionRate ?? null;
  const lastRate = [...recent].reverse().find(g => g.interventionRate !== null)?.interventionRate ?? null;
  const rates = firstRate !== null && lastRate !== null ? `, interwencje strażnika ${percent(firstRate)} → ${percent(lastRate)}` : '';
  const improving = (trend.bestSlope !== null && trend.bestSlope < -0.02) || (trend.medianSlope !== null && trend.medianSlope < -0.05);
  // The guardian corrects the network less and less: it drives more of the lap by itself.
  const selfReliant = trend.interventionSlope !== null && trend.interventionSlope < -0.005;
  if (trend.gensSinceRecord >= PLATEAU_GENERATIONS) {
    const median = trend.medianSlope !== null && trend.medianSlope < -0.05 ? ` Mediana dalej spada (${seconds(trend.medianSlope)}), więc stawka dogania rekord.` : '';
    result.push({ level: 'warn', title: 'Plateau', detail: `${trend.gensSinceRecord} generacji bez rekordu sesji${rates}.${median} Można podnieść mutację, dodać wyspy albo zmienić topologię sieci.` });
  } else if (trend.gensSinceRecord <= 2 || improving) {
    const slope = trend.medianSlope ?? trend.bestSlope;
    result.push({ level: 'good', title: 'Uczy się', detail: `${slope !== null ? `Mediana okrążenia ${seconds(slope)}` : 'Nowe rekordy'}${rates}. Rekord sesji ${trend.gensSinceRecord === 0 ? 'w tej generacji' : `${trend.gensSinceRecord} gen. temu`}.` });
  } else if (selfReliant) {
    result.push({ level: 'good', title: 'Sieć uczy się jeździć sama', detail: `Strażnik poprawia ją coraz rzadziej${rates}; rekord sesji sprzed ${trend.gensSinceRecord} generacji.` });
  } else {
    result.push({ level: 'info', title: 'Stabilnie', detail: `Rekord sprzed ${trend.gensSinceRecord} generacji, brak wyraźnego trendu czasów${rates}.` });
  }
  // Lap times are noisy (random training fuel, stress laps): a regression needs a clear slope over enough generations.
  if (lapped.length >= REGRESSION_MIN_GENERATIONS && trend.medianSlope !== null && trend.medianSlope > 0.25 && trend.gensSinceRecord > 2) {
    result.push({ level: 'bad', title: 'Regres', detail: `Mediana czystych okrążeń rośnie (${seconds(trend.medianSlope)}): stawka jeździ coraz wolniej niż jej rekordy.` });
  }
  if (trend.interventionSlope !== null && trend.interventionSlope > 0.01) {
    result.push({ level: 'warn', title: 'Więcej interwencji', detail: `Strażnik poprawia sieć coraz częściej (${(trend.interventionSlope * 100).toFixed(1).replace('.', ',')} pp/gen).` });
  }
  const last = history[history.length - 1];
  if (last.diversity !== null && last.diversity < COLLAPSE_DIVERSITY) {
    result.push({ level: 'warn', title: 'Zapaść różnorodności', detail: 'Mózgi wszystkich zespołów są niemal identyczne z mistrzem: selekcja ma z czego wybierać tylko dzięki mutacji.' });
  }
  if (trend.trialSuccess !== null && trend.trials >= MIN_TRIALS && trend.trialSuccess < 0.05) {
    result.push({ level: 'info', title: 'Eksploracja bez efektu', detail: `Tylko ${percent(trend.trialSuccess)} z ${trend.trials} prób eksploracyjnych dało rekord życiowy.` });
  }
  return result;
}

export class LearningStats {
  /** Generation summaries for the charts; thinned in long sessions. */
  history: GenerationStats[] = [];
  /** Every finished generation of the session, never thinned (the downloadable log). */
  fullHistory: GenerationLogEntry[] = [];
  /** The training supervisor's actions and waiting suggestions over the session, oldest first. */
  supervisorActions: SupervisorAction[] = [];
  private current = LearningStats.blank(1);
  private cleanTimes: number[] = [];
  private wallStart = Date.now();
  /** Crashes per driver colour over the session. */
  private crashesByColor = new Map<string, number>();
  /** Last closed generation's intervention share per driver colour. */
  private lastRateByColor = new Map<string, number>();

  private static blank(generation: number): GenerationStats {
    return { generation, simSeconds: 0, wallSeconds: 0, bestLap: null, medianLap: null, sessionBest: null,
      cleanLaps: 0, yellowLaps: 0, compromisedLaps: 0, personalBests: 0, reverts: 0,
      trialsStarted: 0, trialsWon: 0, trialsLost: 0, crashes: { barrier: 0, car: 0, stuck: 0, 'wrong-way': 0, other: 0 },
      interventionRate: null, causes: emptyInterventions(), onlineTrainSteps: 0, islandAdoptions: 0,
      diversity: null, meanMutationRate: 0, hiddenSaturation: null, meanPaceMargin: null, paceAtFloor: null };
  }

  noteLap(lapTime: number, outcome: LapOutcome): void {
    if (outcome === 'compromised') { this.current.compromisedLaps++; return; }
    this.current.cleanLaps++;
    if (outcome === 'yellow') this.current.yellowLaps++;
    this.cleanTimes.push(lapTime);
    if (this.current.bestLap === null || lapTime < this.current.bestLap) this.current.bestLap = lapTime;
  }

  notePersonalBest(): void { this.current.personalBests++; }
  noteRevert(): void { this.current.reverts++; }
  noteTrial(result: 'start' | 'won' | 'lost'): void {
    if (result === 'start') this.current.trialsStarted++;
    else if (result === 'won') this.current.trialsWon++;
    else this.current.trialsLost++;
  }
  noteAdoptions(count: number): void { this.current.islandAdoptions += count; }

  noteCrash(car: Car): void {
    const reason = car.eliminationReason;
    const kind: CrashKind = reason === 'barrier' || reason === 'car' || reason === 'stuck' || reason === 'wrong-way' ? reason : 'other';
    this.current.crashes[kind]++;
    this.crashesByColor.set(car.color, (this.crashesByColor.get(car.color) ?? 0) + 1);
  }

  /** The generation so far: the cars' counters are read, not cleared. */
  private live(population: Population): GenerationStats {
    let steps = 0, interventions = 0, train = 0;
    const causes = emptyInterventions();
    for (const car of population.cars) {
      steps += car.aiSteps; interventions += car.aiInterventions; train += car.onlineTrainSteps;
      addCauses(causes, car.interventionCauses);
    }
    const scale = (n: number) => steps ? n / steps : 0;
    const records = population.teamRecords;
    const margins = population.cars.filter(car => !car.isManual).map(car => car.pace.margin);
    return {
      ...this.current,
      crashes: { ...this.current.crashes },
      generation: population.generation,
      simSeconds: population.generationTimer,
      wallSeconds: (Date.now() - this.wallStart) / 1000,
      medianLap: median(this.cleanTimes),
      sessionBest: population.globalBestLap,
      interventionRate: steps ? interventions / steps : null,
      causes: { steer: scale(causes.steer), guard: scale(causes.guard), brake: scale(causes.brake), launch: scale(causes.launch), clearance: scale(causes.clearance) },
      onlineTrainSteps: train,
      diversity: diversity(population),
      meanMutationRate: records.length ? records.reduce((sum, r) => sum + r.currentMutationRate, 0) / records.length : 0,
      hiddenSaturation: hiddenSaturation(championBrain(population)),
      meanPaceMargin: margins.length ? margins.reduce((sum, m) => sum + m, 0) / margins.length : null,
      paceAtFloor: margins.length ? margins.filter(m => m <= PaceSearch.MIN + PACE_FLOOR_BAND).length / margins.length : null,
    };
  }

  /** End of a generation: its summary joins the history and the cars' counters start again. */
  closeGeneration(population: Population): void {
    const summary = this.live(population);
    this.history.push(summary);
    this.fullHistory.push({ ...summary, crashes: { ...summary.crashes }, causes: { ...summary.causes },
      drivers: this.drivers(population).map(d => ({ name: d.name, color: d.color, champion: d.champion, bestLap: d.bestLap,
        lastLap: d.lastLap, laps: d.laps, lapsSincePB: d.lapsSincePB, mutationRate: d.mutationRate,
        interventionRate: d.interventionRate, crashes: d.crashes, distanceToChampion: d.distanceToChampion, paceMargin: d.paceMargin })) });
    const stale = this.fullHistory.length - 1 - LOG_DRIVER_GENERATIONS;
    if (stale >= 0) this.fullHistory[stale].drivers = [];
    if (this.history.length > MAX_HISTORY) {
      // Thin the older half so a long session keeps its whole trend in a bounded list.
      const half = this.history.length >> 1;
      this.history = this.history.filter((_, i) => i >= half || i % 2 === 0);
    }
    for (const car of population.cars) {
      if (car.aiSteps > 0) this.lastRateByColor.set(car.color, car.aiInterventions / car.aiSteps);
      car.aiSteps = car.aiInterventions = car.onlineTrainSteps = 0;
      car.interventionCauses = emptyInterventions();
    }
    this.current = LearningStats.blank(population.generation + 1);
    this.cleanTimes = [];
    this.wallStart = Date.now();
  }

  trend(population: Population): LearningTrend {
    const recent = this.history.slice(-TREND_WINDOW);
    const series = (pick: (g: GenerationStats) => number | null) =>
      linearTrend(recent.flatMap(g => { const y = pick(g); return y === null ? [] : [{ x: g.generation, y }]; }));
    let gensSinceRecord = 0;
    const best = population.globalBestLap;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const previous = i > 0 ? this.history[i - 1].sessionBest : null;
      const record = this.history[i].sessionBest;
      if (record !== null && (previous === null || record < previous - 1e-6)) break;
      gensSinceRecord++;
    }
    // The running generation set a new record: nothing has stalled.
    const lastRecord = this.history.length ? this.history[this.history.length - 1].sessionBest : null;
    if (best !== null && (lastRecord === null || best < lastRecord - 1e-6)) gensSinceRecord = 0;
    let won = this.current.trialsWon, lost = this.current.trialsLost;
    for (const g of this.history) { won += g.trialsWon; lost += g.trialsLost; }
    return { bestSlope: series(g => g.bestLap), medianSlope: series(g => g.medianLap), interventionSlope: series(g => g.interventionRate),
      gensSinceRecord, trialSuccess: won + lost > 0 ? won / (won + lost) : null, trials: won + lost };
  }

  private drivers(population: Population): DriverStats[] {
    const champion = population.championRecord();
    const championIndex = champion ? population.teamRecords.indexOf(champion) : -1;
    const championBest = champion?.bestBrain ?? null;
    return population.cars.map((car, i) => {
      const record = population.teamRecords[i];
      const lineBest = car.lineNet?.bestTime;
      return {
        color: car.color,
        name: record?.driverName ?? car.driverName,
        alive: car.isAlive,
        champion: i === championIndex,
        bestLap: record?.bestLapTime ?? null,
        lastLap: record?.lastLapTime ?? null,
        laps: record?.lapsCount ?? 0,
        lapsSincePB: record?.stagnationCounter ?? 0,
        mutationRate: record?.currentMutationRate ?? population.mutationRate,
        exploring: car.explorationTrial,
        interventionRate: car.aiSteps >= 600 ? car.aiInterventions / car.aiSteps : this.lastRateByColor.get(car.color) ?? (car.aiSteps ? car.aiInterventions / car.aiSteps : null),
        paceMargin: car.pace.margin,
        lineBest: typeof lineBest === 'number' && Number.isFinite(lineBest) ? lineBest : null,
        distanceToChampion: championBest && car.brain ? weightDistance(car.brain, championBest) : null,
        crashes: this.crashesByColor.get(car.color) ?? 0,
      };
    });
  }

  view(population: Population): LearningStatsView {
    const champion = population.championRecord();
    const liveBrain = championBrain(population);
    const network: NetworkStats | null = liveBrain && champion ? {
      driver: champion.driverName,
      color: champion.color,
      layerSizes: [...liveBrain.layerSizes],
      parameters: liveBrain.layers.reduce((sum, layer) => sum + layer.weights.length * (layer.weights[0]?.length ?? 0) + layer.biases.length, 0),
      layers: layerStats(liveBrain),
    } : null;
    const trend = this.trend(population);
    return {
      generation: population.generation,
      raceMode: population.isRaceMode,
      sessionBest: population.globalBestLap,
      current: this.live(population),
      history: this.history.map(g => ({ ...g, crashes: { ...g.crashes }, causes: { ...g.causes } })),
      trend,
      verdicts: verdicts(this.history, trend),
      drivers: this.drivers(population),
      network,
      supervisor: { mode: population.supervisor.mode, actions: this.supervisorActions.slice(-100).map(a => ({ ...a })) },
    };
  }
}

/** The champion team's car brain: its activations are those of the last step it drove. */
function championBrain(population: Population): NeuralNetwork | null {
  const champion = population.championRecord();
  if (!champion) return null;
  const index = population.teamRecords.indexOf(champion);
  return (index >= 0 ? population.cars[index]?.brain : null) ?? champion.bestBrain ?? null;
}

function hiddenSaturation(brain: NeuralNetwork | null): number | null {
  if (!brain || brain.layers.length < 2) return null;
  const hidden = layerStats(brain).slice(0, -1);
  return hidden.reduce((sum, l) => sum + l.saturation, 0) / hidden.length;
}

/** Mean weight distance of the other teams' record brains from the champion's. */
function diversity(population: Population): number | null {
  const champion = population.championRecord();
  if (!champion?.bestBrain) return null;
  let sum = 0, count = 0;
  for (const record of population.teamRecords) {
    if (record === champion || !record.bestBrain) continue;
    const distance = weightDistance(record.bestBrain, champion.bestBrain);
    if (distance !== null) { sum += distance; count++; }
  }
  return count ? sum / count : null;
}
