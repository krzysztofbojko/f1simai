import { random } from '../math/Random';
import { NeuralNetwork } from './NeuralNetwork';
import { PaceSearch } from './PaceSearch';
import { LONG_WINDOW, STUCK_GENERATIONS } from './LearningInsights';
import type { GenerationStats } from './LearningStats';
import type { Population, TeamRecord } from './Population';
import { teamRating } from './TeamRating';

/**
 * Training supervisor: after every generation it reads the learning history and the field, and
 * acts on the symptoms the diagnostics only describe (pace probe stuck at its floor, annealing
 * stuck at its ceiling, a stalled session). Every action is
 * learning bookkeeping or a new exploration trial; none touches the vehicle physics.
 * In 'suggest' mode an action waits in the log until the user applies it.
 */

export type SupervisorMode = 'auto' | 'suggest';
export type SupervisorActionKind = 'pace-reset' | 'mutation-reset' | 'selection';

export interface SupervisorAction {
  id: number;
  /** Generation whose end triggered the action. */
  generation: number;
  kind: SupervisorActionKind;
  /** The symptom, Polish UI text. */
  reason: string;
  /** What the action does, Polish UI text. */
  action: string;
  status: 'applied' | 'pending' | 'expired';
  /** Generation the action was applied in (later than `generation` when the user applied a suggestion). */
  appliedAt: number | null;
}

/** Generations an action kind waits before it may act again. */
export const SUPERVISOR_COOLDOWN = 30;
/** Generations the pace probe must sit at its floor before it is reset. */
const PACE_WINDOW = 10;
/** A margin this close to `PaceSearch.MIN` counts as sitting at the floor. */
export const PACE_FLOOR_BAND = 0.02;
/** Share of the field at the floor that makes it a field-wide problem, not one clumsy driver. */
const PACE_FLOOR_SHARE = 0.5;
/** Weakest teams that get a crossover trial in one selection round. */
const SELECTION_COUNT = 3;
/** The partner brain for the champion's crossover comes from this many fastest teams. */
const SELECTION_POOL = 5;

const dec = (value: number, digits: number) => value.toFixed(digits).replace('.', ',');

/** The trailing generations that all show the symptom. */
function streak(history: readonly GenerationStats[], test: (g: GenerationStats) => boolean): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0 && test(history[i]); i--) n++;
  return n;
}

interface Finding { kind: SupervisorActionKind; reason: string; action: string }

export class TrainingSupervisor {
  mode: SupervisorMode = 'auto';

  constructor(private readonly mutationFloor: number, private readonly mutationCeiling: number) {}

  /** End of a generation: detect, then act (auto) or leave a suggestion (suggest). */
  review(population: Population): void {
    if (population.isRaceMode) return;
    const stats = population.learningStats;
    const history = stats.fullHistory;
    const generation = history.length ? history[history.length - 1].generation : population.generation;
    for (const finding of this.detect(population, history)) {
      const log = stats.supervisorActions;
      const last = [...log].reverse().find(a => a.kind === finding.kind);
      if (last && last.generation <= generation && generation - last.generation < SUPERVISOR_COOLDOWN) continue;
      // A newer suggestion of the same kind replaces the one still waiting.
      for (const a of log) if (a.kind === finding.kind && a.status === 'pending') a.status = 'expired';
      const entry: SupervisorAction = { id: (log[log.length - 1]?.id ?? 0) + 1, generation, ...finding, status: 'pending', appliedAt: null };
      log.push(entry);
      if (this.mode === 'auto') this.execute(population, entry);
    }
  }

  /** The user applies a waiting suggestion; false if it is gone or no longer waiting. */
  apply(population: Population, id: number): boolean {
    const entry = population.learningStats.supervisorActions.find(a => a.id === id);
    if (!entry || entry.status !== 'pending' || population.isRaceMode) return false;
    this.execute(population, entry);
    return true;
  }

  private execute(population: Population, entry: SupervisorAction): void {
    if (entry.kind === 'pace-reset') this.resetPace(population);
    else if (entry.kind === 'mutation-reset') this.resetMutation(population);
    else this.select(population);
    entry.status = 'applied';
    entry.appliedAt = population.generation;
  }

  private detect(population: Population, history: readonly GenerationStats[]): Finding[] {
    const found: Finding[] = [];
    if (!history.length) return found;
    const last = history[history.length - 1];

    const floorStreak = streak(history, g => g.paceAtFloor !== null && g.paceAtFloor >= PACE_FLOOR_SHARE);
    if (floorStreak >= PACE_WINDOW) {
      found.push({ kind: 'pace-reset',
        reason: `Od ${floorStreak} gen. ${Math.round((last.paceAtFloor ?? 0) * 100)}% kierowców ma zapas tempa przy minimum (${dec(PaceSearch.MIN, 2)}): planner jedzie z zapasem przyczepności, cofanie mózgów tego nie naprawi.`,
        action: 'Reset szukania tempa: zapas wraca do 1,00, sufit do maksimum.' });
    }

    const recent = history.slice(-LONG_WINDOW);
    const won = recent.reduce((s, g) => s + g.trialsWon, 0), lost = recent.reduce((s, g) => s + g.trialsLost, 0);
    if (recent.length >= LONG_WINDOW && recent.every(g => g.meanMutationRate >= 0.95 * this.mutationCeiling) && won === 0 && lost >= 10) {
      found.push({ kind: 'mutation-reset',
        reason: `Mutacja od ${recent.length} gen. przy maksimum (${dec(last.meanMutationRate, 3)}), 0 z ${lost} prób eksploracji wygranych.`,
        action: `Reset wyżarzania: stopa mutacji zespołów wraca do ${dec(this.mutationFloor, 3)}.` });
    }

    const sinceRecord = population.learningStats.trend(population).gensSinceRecord;
    if (sinceRecord >= 2 * STUCK_GENERATIONS && population.championRecord()?.bestBrain) {
      found.push({ kind: 'selection',
        reason: `${sinceRecord} gen. bez rekordu sesji, a w treningu zespoły nie wymieniają się mózgami.`,
        action: `Selekcja: ${SELECTION_COUNT} najsłabsze zespoły jadą próbę z krzyżówką mistrza i jednego z ${SELECTION_POOL} najszybszych (przegrana próba wraca do ich rekordu).` });
    }
    return found;
  }

  private resetPace(population: Population): void {
    for (const car of population.cars) {
      if (!car.isManual && car.pace.margin <= PaceSearch.MIN + PACE_FLOOR_BAND) car.pace.resetProbe();
    }
  }

  private resetMutation(population: Population): void {
    for (const record of population.teamRecords) record.currentMutationRate = this.mutationFloor;
  }

  /** The selection automatic generations lack: the weakest teams try the champion crossed with a fast team. */
  private select(population: Population): void {
    const champion = population.championRecord();
    if (!champion?.bestBrain) return;
    const records = population.teamRecords;
    const time = (r: TeamRecord) => teamRating(r) ?? r.bestLapTime ?? Infinity;
    const ranked = records.map((record, index) => ({ record, index }))
      .filter(({ record }) => record !== champion && record.bestBrain)
      .sort((a, b) => time(a.record) - time(b.record));
    const pool = ranked.slice(0, SELECTION_POOL);
    const weakest = ranked.filter(({ index }) => !population.cars[index]?.explorationTrial && !population.cars[index]?.isManual)
      .slice(-SELECTION_COUNT);
    for (const { record, index } of weakest) {
      const partner = pool.length ? pool[Math.floor(random() * pool.length)].record : champion;
      const brain = NeuralNetwork.crossover(champion.bestBrain, partner.bestBrain!);
      brain.mutate(population.mutationRate, population.mutationStrength);
      population.startTrial(population.cars[index], record, brain);
    }
  }
}
