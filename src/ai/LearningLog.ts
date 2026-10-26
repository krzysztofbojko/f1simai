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
  version: 1;
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
    sessionBest: 'Session lap record when the generation ended (s).',
    cleanLaps: 'Laps that evaluate a brain, including yellowLaps.',
    yellowLaps: "Clean laps run under someone else's yellow flag.",
    compromisedLaps: 'Laps that never evaluate a brain (traffic, pressure change, island hand-over).',
    personalBests: 'Driver personal bests set in the generation: laps faster than the team reference (the record, or the supervisor-refreshed reference); each saves that brain as the team record brain.',
    reverts: 'Degraded brains (lap > 2.5 s slower than the team reference) sent back to the team record brain.',
    trialsStarted: 'Exploration trials started: a stronger mutation of the record brain after 8 clean laps without a personal best.',
    trialsWon: 'Exploration trials that ended in a personal best.',
    trialsLost: 'Exploration trials that failed and were reverted.',
    crashes: 'Eliminations by cause: barrier, car (collision), stuck, wrong-way, other.',
    interventionRate: 'Share of AI control steps the guardian overrode (0..1).',
    causes: 'Share of AI steps per intervention cause (0..1): steer (steering corridor), guard (full takeover), brake (emergency braking), launch (pull-away assist), clearance (throttle cap near a wall).',
    onlineTrainSteps: 'Online training updates of the networks from guardian corrections.',
    islandAdoptions: 'Faster drivers taken over from island workers (parallel training copies).',
    diversity: 'Mean RMS weight distance of the team record brains from the champion brain; below 0.002 all teams drive practically one brain.',
    meanMutationRate: 'Mean annealed mutation rate of the teams (raised by failed trials, lowered by personal bests).',
    hiddenSaturation: "Mean share of the champion's hidden neurons with |tanh activation| > 0.95 in its last step.",
    meanPaceMargin: 'Mean grip margin of the pace search (planner grip budget multiplier, 0.9..1.15) over the AI drivers.',
    paceAtFloor: 'Share of AI drivers whose pace-search margin sits within 0.02 of its 0.9 floor (0..1).',
    drivers: 'Each driver at the end of the generation.',
  },
  driver: {
    name: 'Driver name', color: 'Team colour (identifies the team)', champion: 'Holds the session champion brain',
    bestLap: 'Personal best clean lap (s)', lastLap: 'Last lap (s)', laps: 'Laps in the session',
    lapsSincePB: 'Clean laps since the last personal best (8 starts an exploration trial)', mutationRate: 'Team mutation rate',
    interventionRate: 'Share of steps the guardian overrode', crashes: 'Crashes in the session',
    distanceToChampion: 'RMS weight distance from the champion brain',
    lineBest: 'Best time of the racing-line network (s), current drivers only', paceMargin: 'Grip margin from the pace search, current drivers only',
  },
  summary: 'sessionBest (s); trend: slopes in s/generation over the last 10 generations (negative = faster), gensSinceRecord, trialSuccess; '
    + 'verdicts and insights: automatic diagnoses (level bad/warn/info/good, since = first generation of the symptom).',
  network: 'Champion network: layer sizes, parameter count, mean |weight| and tanh saturation per layer.',
  supervisor: 'Training supervisor. mode: auto (acts) or suggest (waits for the user). actions: every action and suggestion of the session, '
    + 'with generation (whose end triggered it), kind (pace-reset: pace search back to margin 1; mutation-reset: team mutation rates back to the floor; '
    + 'reference-refresh: team reference = 20th percentile of its last 20 clean laps, records unchanged; selection: the 3 weakest teams try a crossover '
    + 'of the champion and a top-5 brain as an exploration trial), reason and action (Polish UI text), status (applied/pending/expired) and appliedAt.',
} as const;

export function learningLog(view: LearningStatsView, generations: GenerationLogEntry[], insights: Insight[],
  meta: { sessionState: string; simTime: number; config: LearningLogConfig; supervisorActions: SupervisorAction[] }): LearningLog {
  return {
    type: 'F1_LEARNING_LOG',
    version: 1,
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
  };
}

/** Compact JSON: six significant digits keep lap times to the millisecond for lap times and shares, and keep long sessions small. */
export function stringifyLearningLog(log: LearningLog): string {
  return JSON.stringify(log, (_, value) => typeof value === 'number' && !Number.isInteger(value) && Number.isFinite(value)
    ? Number(value.toPrecision(6)) : value);
}
