import type { GenerationLogEntry, LearningStatsView } from './LearningStats';
import type { Insight } from './LearningInsights';
import type { SupervisorAction, SupervisorMode } from './TrainingSupervisor';

/**
 * The downloadable log of a learning session: every finished generation since learning last
 * started, the settings it ran with and a description of each field, so that a person or a
 * language model can analyse it without the source code.
 */

export interface LearningLogConfig {
  track: { lengthMeters: number; widthMeters: number };
  rayCount: number;
  topology: unknown;
  layerSizes: number[] | null;
  populationSize: number;
  mutationRate: number;
  startingFuelKg: number;
  driverPressure: number;
  stressLapShare: number;
  computeProfile: string;
  islands: { count: number; running: boolean; adopted: number };
  weather: { scenario: string; state: unknown };
}

export interface LearningLog {
  type: 'F1_LEARNING_LOG';
  version: 2;
  exportedAt: string;
  generation: number;
  sessionState: string;
  raceMode: boolean;
  simTime: number;
  config: LearningLogConfig;
  schema: typeof LEARNING_LOG_SCHEMA;
  summary: Pick<LearningStatsView, 'sessionBest' | 'trend' | 'verdicts'> & { insights: Insight[] };
  current: LearningStatsView['current'];
  generations: GenerationLogEntry[];
  drivers: LearningStatsView['drivers'];
  network: LearningStatsView['network'];
  supervisor: { mode: SupervisorMode; actions: SupervisorAction[] };
  corners: CornerLogRow[];
}

/** One corner of the track with the champion's learned budgets. */
export interface CornerLogRow {
  corner: number;
  /** Distance of the braking zone start, arc start and arc end from the start/finish line (m). */
  brakeAt: number;
  arcFrom: number;
  arcTo: number;
  /** Radius at the apex (m). */
  apexRadius: number;
  cornerMargin: number;
  brakeMargin: number;
  cleanPasses: number;
  problems: number;
  /** Judged problem passes by cause (a pass may count under several). */
  reasons: Record<string, number>;
  /** Mean sliding (s) of the corner's passes without a problem. */
  cleanSlide: number;
  stepBacks: number;
  probeFails: number;
  timeReverts: number;
}

/** What each field means: times in seconds, shares in 0..1, weight distances as RMS. */
export const LEARNING_LOG_SCHEMA = {
  about: 'F1 race simulator with neuro-evolution drivers. Each team evolves its own neural network; a rule-based guardian corrects '
    + 'the network where it would crash and those corrections also train it online (DAgger). A generation ends after a target number of laps. '
    + 'Lower lap times are better. Text in verdicts and insights is Polish UI text.',
  generations: 'Every finished generation of the session in order (never thinned). Entries older than the last 5000 keep an empty drivers list.',
  current: 'The generation still running when the log was exported (partial counts).',
  generation: {
    generation: 'Generation number.',
    simSeconds: 'Simulated seconds the generation ran.',
    wallSeconds: 'Wall-clock seconds the generation took.',
    bestLap: 'Fastest clean lap of the generation (s), null without clean laps.',
    medianLap: 'Median clean lap of the generation (s).',
    sessionBest: 'Session lap record when the generation ended (s). A single lap: noisy, it never picks a brain.',
    bestRating: 'Best team rating when the generation ended (s): the median of the last 20 clean laps of a team\'s accepted brains. The robust progress measure.',
    cleanLaps: 'Laps that evaluate a brain, including yellowLaps.',
    yellowLaps: "Clean laps run under someone else's yellow flag.",
    compromisedLaps: 'Laps that never evaluate a brain (traffic, pressure change, island hand-over).',
    personalBests: 'Accepted brains: the median of a brain\'s 4 clean laps beat its team rating, so it became the team record brain.',
    reverts: 'Brains sent back to the team record brain: their 4-lap median did not beat the team rating, or one lap was over max(2.5 s, 3 spreads) slower than it.',
    trialsStarted: 'Exploration trials started: a stronger mutation of the record brain after 8 clean laps without an accepted brain.',
    trialsWon: 'Exploration trials accepted (4-lap median beat the team rating).',
    trialsLost: 'Exploration trials that failed and were reverted.',
    crashes: 'Eliminations by cause: barrier, car (collision), stuck, wrong-way, other.',
    interventionRate: 'Share of AI control steps the guardian overrode (0..1).',
    causes: 'Share of AI steps per intervention cause (0..1): steer (steering corridor), guard (full takeover), brake (emergency braking), launch (pull-away assist), clearance (throttle cap near a wall).',
    onlineTrainSteps: 'Online training updates of the networks from guardian corrections.',
    islandAdoptions: 'Faster drivers taken over from island workers (parallel training copies).',
    diversity: 'Mean RMS weight distance of the team record brains from the champion brain; below 0.002 all teams drive practically one brain.',
    meanMutationRate: 'Mean annealed mutation rate of the teams (raised by failed trials, lowered by accepted brains).',
    hiddenSaturation: "Mean share of the champion's hidden neurons with |tanh activation| > 0.95 in its last step.",
    meanPaceMargin: 'Mean grip margin of the pace search (planner grip budget multiplier, 0.9..1.15) over the AI drivers.',
    paceAtFloor: 'Share of AI drivers whose pace-search margin sits within 0.02 of its 0.9 floor (0..1).',
    drivers: 'Each driver at the end of the generation.',
  },
  driver: {
    name: 'Driver name', color: 'Team colour (identifies the team)', champion: 'Holds the session champion brain (best team rating)',
    bestLap: 'Personal best clean lap (s)', rating: 'Team rating: median of the last 20 clean laps of its accepted brains (s)', lastLap: 'Last lap (s)', laps: 'Laps in the session',
    lapsSincePB: 'Clean laps since the last accepted brain (8 starts an exploration trial)', mutationRate: 'Team mutation rate',
    interventionRate: 'Share of steps the guardian overrode', crashes: 'Crashes in the session',
    distanceToChampion: 'RMS weight distance from the champion brain',
    lineBest: 'Best time of the racing-line network (s), current drivers only', paceMargin: 'Mean grip margin of the pace search over the 32 sections of the lap (planner corner budget multiplier, 0.9..1.15), current drivers only', paceRange: 'Lowest and highest proven section margin [min, max]',
  },
  summary: 'sessionBest (s); trend: slopes in s/generation over the last 10 generations (negative = faster), gensSinceRecord, trialSuccess; '
    + 'verdicts and insights: automatic diagnoses (level bad/warn/info/good, since = first generation of the symptom).',
  corners: 'The track split into corners (braking zone → arc → exit) with the champion\'s per-corner limit search: cornerMargin multiplies the '
    + 'planner\'s corner grip budget and brakeMargin its braking budget into the corner (0.9..1.15, proven values). Two clean passes with room '
    + 'raise a budget, a slide/excursion/guardian takeover (arc) or locked wheels/emergency braking/arriving too fast (braking) steps it back. '
    + 'cleanPasses and problems count judged passes of the session; reasons splits the problems by cause (slide: sliding clearly longer than '
    + 'the corner usually slides, lock: locked wheels, guard: guardian took over, offArc/offBrake: left the track in the arc/braking zone, '
    + 'entry: arrived too fast, emergency: emergency braking, crash); cleanSlide is the normal sliding (s) of a clean pass; stepBacks, '
    + 'probeFails and timeReverts count budgets stepped back after repeated problems, probes ended by a problem and probes ended by a slower corner time.',
  network: 'Champion network: layer sizes, parameter count, mean |weight| and tanh saturation per layer.',
  supervisor: 'Training supervisor. mode: auto (acts) or suggest (waits for the user). actions: every action and suggestion of the session, '
    + 'with generation (whose end triggered it), kind (pace-reset: pace search back to margin 1; mutation-reset: team mutation rates back to the floor; '
    + 'selection: the 3 weakest teams try a crossover '
    + 'of the champion and a top-5 brain as an exploration trial), reason and action (Polish UI text), status (applied/pending/expired) and appliedAt.',
} as const;

export function learningLog(view: LearningStatsView, generations: GenerationLogEntry[], insights: Insight[],
  meta: { sessionState: string; simTime: number; config: LearningLogConfig; supervisorActions: SupervisorAction[]; corners: CornerLogRow[] }): LearningLog {
  return {
    type: 'F1_LEARNING_LOG',
    version: 2,
    exportedAt: new Date().toISOString(),
    generation: view.generation,
    sessionState: meta.sessionState,
    raceMode: view.raceMode,
    simTime: meta.simTime,
    config: meta.config,
    schema: LEARNING_LOG_SCHEMA,
    summary: { sessionBest: view.sessionBest, trend: view.trend, verdicts: view.verdicts, insights },
    current: view.current,
    generations,
    drivers: view.drivers,
    network: view.network,
    supervisor: { mode: view.supervisor.mode, actions: meta.supervisorActions },
    corners: meta.corners,
  };
}

/** Compact JSON: six significant digits keep lap times to the millisecond for lap times and shares, and keep long sessions small. */
export function stringifyLearningLog(log: LearningLog): string {
  return JSON.stringify(log, (_, value) => typeof value === 'number' && !Number.isInteger(value) && Number.isFinite(value)
    ? Number(value.toPrecision(6)) : value);
}
