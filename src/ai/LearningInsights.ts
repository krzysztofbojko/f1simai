import { COLLAPSE_DIVERSITY, TREND_WINDOW, median, type CrashKind, type GenerationStats, type LearningTrend } from './LearningStats';
import type { InterventionCounts } from '../physics/Car';

/**
 * Notes on what the learning charts show: each detector reads the generation history and says,
 * in Polish UI text, when a symptom (times drifting the wrong way, a stuck parameter, learning
 * that no longer pays off) started. Pure reading: nothing in the driving or the evolution uses it.
 */

export type InsightLevel = 'bad' | 'warn' | 'info' | 'good';
export type InsightChart = 'laps' | 'interventions' | 'events' | 'diversity' | 'mutation' | 'network' | 'general';

export interface Insight {
  level: InsightLevel;
  /** The chart the note explains ('general' for the whole session). */
  chart: InsightChart;
  title: string;
  detail: string;
  /** First generation of the symptom. */
  since: number;
}

export interface InsightContext {
  sessionBest: number | null;
  trend: LearningTrend;
  /** Island workers running beside the main field. */
  islandCount: number;
  /** Bounds of the teams' annealed mutation rate, when known. */
  mutationFloor?: number;
  mutationCeiling?: number;
}

/** Generations the slow trends (drift, stuck parameters) look back over. */
export const LONG_WINDOW = 30;
/** Lapped generations a long-window trend needs before it says anything. */
const MIN_LONG_POINTS = 20;
/** Standard errors a slope must clear to count as a trend rather than lap-time noise. */
const SIGNIFICANT = 2.5;
/** Generations without a record before the session counts as stuck. */
export const STUCK_GENERATIONS = 30;

const LEVEL_RANK: Record<InsightLevel, number> = { bad: 0, warn: 1, info: 2, good: 3 };
const CAUSES: { key: keyof InterventionCounts; label: string; hint: string }[] = [
  { key: 'steer', label: 'Korytarz skrętu', hint: 'sieć kieruje poza bezpieczny korytarz skrętu' },
  { key: 'guard', label: 'Strażnik przejmuje', hint: 'strażnik musi przejmować całe sterowanie w groźnych sytuacjach' },
  { key: 'brake', label: 'Hamowanie awaryjne', hint: 'sieć hamuje za późno' },
  { key: 'launch', label: 'Asysta ruszania', hint: 'sieć nie potrafi ruszyć z miejsca ani przyspieszyć z małej prędkości' },
  { key: 'clearance', label: 'Limit gazu przy ścianie', hint: 'sieć daje za dużo gazu tuż przy ścianie' },
];
const CRASH_HINT: Record<CrashKind, string> = {
  barrier: 'uderzenia w bariery: za szybko w zakrętach albo zła linia',
  car: 'kolizje z innymi autami',
  stuck: 'auta stają i nie potrafią ruszyć',
  'wrong-way': 'auta zawracają i jadą pod prąd',
  other: 'inne eliminacje',
};

const dec = (value: number, digits: number) => value.toFixed(digits).replace('.', ',');
const lapText = (t: number) => `${dec(t, 2)} s`;
const perGen = (v: number) => `${v >= 0 ? '+' : '−'}${dec(Math.abs(v), 2)} s/gen`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const sum = (gens: readonly GenerationStats[], pick: (g: GenerationStats) => number) => gens.reduce((total, g) => total + pick(g), 0);
const crashCount = (g: GenerationStats) => Object.values(g.crashes).reduce((total, n) => total + n, 0);
/** Crashes per simulated minute, so short and long generations compare. */
const crashRate = (g: GenerationStats) => g.simSeconds > 0 ? crashCount(g) / (g.simSeconds / 60) : 0;

interface Fit { slope: number; /** Standard error of the slope. */ se: number; /** Residual spread around the line. */ sd: number; n: number }

/** Least-squares line with the spread of its residuals; null with fewer than three points or no spread in x. */
export function fitLine(points: readonly { x: number; y: number }[]): Fit | null {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0;
  for (const p of points) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; }
  if (sxx <= 0) return null;
  const slope = sxy / sxx;
  let rss = 0;
  for (const p of points) rss += (p.y - my - slope * (p.x - mx)) ** 2;
  const sd = Math.sqrt(rss / (n - 2));
  return { slope, se: sd / Math.sqrt(sxx), sd, n };
}

const fitOf = (gens: readonly GenerationStats[], pick: (g: GenerationStats) => number | null) =>
  fitLine(gens.flatMap(g => { const y = pick(g); return y === null ? [] : [{ x: g.generation, y }]; }));

/** The trailing generations that all show the symptom. */
function streak(history: readonly GenerationStats[], test: (g: GenerationStats) => boolean): GenerationStats[] {
  let i = history.length;
  while (i > 0 && test(history[i - 1])) i--;
  return history.slice(i);
}

/** The generation after the last one that improved the session record. */
function recordSince(history: readonly GenerationStats[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const record = history[i].sessionBest, previous = i > 0 ? history[i - 1].sessionBest : null;
    if (record !== null && (previous === null || record < previous - 1e-6)) return history[Math.min(i + 1, history.length - 1)].generation;
  }
  return history[0].generation;
}

function minBy(gens: readonly GenerationStats[], pick: (g: GenerationStats) => number | null): GenerationStats {
  let best = gens[0], low = Infinity;
  for (const g of gens) { const v = pick(g); if (v !== null && v < low) { low = v; best = g; } }
  return best;
}

type Detector = (history: readonly GenerationStats[], ctx: InsightContext) => Insight | null;

// ---- Lap times ----

const wrongDirection: Detector = (history, ctx) => {
  const recent = history.filter(g => g.bestLap !== null).slice(-LONG_WINDOW);
  if (recent.length < MIN_LONG_POINTS || ctx.trend.gensSinceRecord < TREND_WINDOW) return null;
  const med = fitOf(recent, g => g.medianLap), best = fitOf(recent, g => g.bestLap);
  if (!med || !best || med.slope <= 0.1 || med.slope < SIGNIFICANT * med.se || best.slope <= 0.05 || best.slope < SIGNIFICANT * best.se) return null;
  return { level: 'bad', chart: 'laps', title: 'Czasy idą w złą stronę', since: minBy(recent, g => g.medianLap).generation,
    detail: `Mediana czystych okrążeń rośnie o ${perGen(med.slope)}, najlepsze w generacji o ${perGen(best.slope)}, a rekordu sesji nie ma od ${ctx.trend.gensSinceRecord} gen. `
      + 'Populacja traci to, co już umiała: sprawdź cofnięcia mózgu i mutację albo wczytaj najlepszy model. Jeśli w tym czasie zmieniła się pogoda, to może być efekt warunków.' };
};

const strayed: Detector = history => {
  // A single record can come from a light random fuel load, so the field is judged by the median of its
  // generation bests over TREND_WINDOW generations, against the best such stretch of the session.
  const lapped = history.filter(g => g.bestLap !== null);
  if (lapped.length < 2 * TREND_WINDOW) return null;
  let bestEnd = -1, bestMedian = Infinity;
  for (let end = TREND_WINDOW; end <= lapped.length; end++) {
    const m = median(lapped.slice(end - TREND_WINDOW, end).map(g => g.bestLap!))!;
    if (m <= bestMedian) { bestMedian = m; bestEnd = end; }
  }
  const now = median(lapped.slice(-TREND_WINDOW).map(g => g.bestLap!))!;
  if (lapped.length - bestEnd < TREND_WINDOW || now <= bestMedian * 1.03) return null;
  const from = lapped[bestEnd - TREND_WINDOW].generation, to = lapped[bestEnd - 1].generation;
  const reverts = sum(history.filter(g => g.generation > to), g => g.reverts);
  const lost = lapped.slice(bestEnd - TREND_WINDOW).find(g => g.bestLap! > bestMedian * 1.03) ?? lapped[bestEnd];
  return { level: 'bad', chart: 'laps', title: 'Model zbłądził', since: lost.generation,
    detail: `Najlepsze okrążenia generacji (mediana z ${TREND_WINDOW}) to dziś ${lapText(now)}, a w najlepszym okresie sesji (gen. ${from}–${to}) było ${lapText(bestMedian)} (+${dec((now / bestMedian - 1) * 100, 1)}%). `
      + `${reverts ? `Cofnięcia mózgu (${reverts}) nie przywracają tempa` : 'Mózgi nie są cofane do rekordowych'}: populacja odpłynęła od najlepszego rozwiązania. `
      + 'Wczytaj najlepszy model albo obniż mutację; tak samo może wyglądać zmiana pogody.' };
};

const noise: Detector = (history, ctx) => {
  const recent = history.filter(g => g.medianLap !== null).slice(-LONG_WINDOW);
  if (recent.length < MIN_LONG_POINTS || ctx.trend.gensSinceRecord < TREND_WINDOW) return null;
  const med = fitOf(recent, g => g.medianLap);
  if (!med || Math.abs(med.slope) >= SIGNIFICANT * med.se) return null;
  return { level: 'info', chart: 'laps', title: 'Postęp w szumie', since: recent[0].generation,
    detail: `Przez ostatnie ${med.n} gen. mediana zmienia się o ${perGen(med.slope)}, mniej niż wynosi jej rozrzut (±${dec(med.sd, 2)} s). `
      + 'Ruchy na wykresie to szum paliwa i losowych okrążeń, nie nauka.' };
};

const championOnly: Detector = history => {
  const recent = history.filter(g => g.bestLap !== null && g.medianLap !== null).slice(-LONG_WINDOW);
  if (recent.length < MIN_LONG_POINTS) return null;
  const gap = (g: GenerationStats) => g.medianLap! - g.bestLap!;
  const fit = fitOf(recent, gap);
  const last = gap(recent[recent.length - 1]);
  if (!fit || fit.slope <= 0.05 || fit.slope < SIGNIFICANT * fit.se || last < 1.5) return null;
  return { level: 'warn', chart: 'laps', title: 'Tylko lider jest szybki', since: minBy(recent, gap).generation,
    detail: `Luka między medianą a najlepszym okrążeniem rośnie o ${perGen(fit.slope)} i wynosi już ${lapText(last)}: reszta zespołów nie nadąża za liderem. `
      + 'Wyspy albo wczytanie najlepszego modelu wszystkim kierowcom przeniosą jego mózg dalej.' };
};

const blind: Detector = history => {
  const tail = streak(history, g => {
    const total = g.cleanLaps + g.compromisedLaps;
    // Traffic alone compromises over half the laps of a full field, so only a near-total loss counts.
    return g.cleanLaps < 3 || (total > 0 && g.compromisedLaps / total > 0.8);
  });
  if (tail.length < 5) return null;
  const clean = sum(tail, g => g.cleanLaps), compromised = sum(tail, g => g.compromisedLaps);
  return { level: 'bad', chart: 'laps', title: 'Nauka na ślepo', since: tail[0].generation,
    detail: `Średnio ${dec(clean / tail.length, 1)} czystych okrążeń na generację, ${pct(compromised / Math.max(1, clean + compromised))} okrążeń skażonych. `
      + 'Bez czystych okrążeń mózgi nie są oceniane i ewolucja nie ma sygnału: wydłuż generację albo zmniejsz ruch i presję.' };
};

// ---- Guardian interventions ----

const guardianDrives: Detector = history => {
  const tail = streak(history, g => g.interventionRate !== null && g.interventionRate > 0.4);
  if (tail.length < TREND_WINDOW) return null;
  return { level: 'warn', chart: 'interventions', title: 'Jedzie strażnik, nie sieć', since: tail[0].generation,
    detail: `Strażnik poprawia średnio ${pct(sum(tail, g => g.interventionRate!) / tail.length)} kroków sieci. `
      + 'Czasy okrążeń mówią więcej o plannerze niż o sieci, która nie nauczyła się jeszcze jechać sama.' };
};

const causeShares = (g: GenerationStats) => {
  const total = CAUSES.reduce((s, c) => s + g.causes[c.key], 0);
  return (key: keyof InterventionCounts) => total > 0 ? g.causes[key] / total : 0;
};

const dominantCause: Detector = history => {
  const recent = history.slice(-TREND_WINDOW).filter(g => g.interventionRate !== null && g.interventionRate > 0.05);
  if (recent.length < 5) return null;
  const totals = CAUSES.map(c => sum(recent, g => g.causes[c.key]));
  const all = totals.reduce((s, n) => s + n, 0);
  const top = totals.indexOf(Math.max(...totals));
  if (all <= 0 || totals[top] / all <= 0.7) return null;
  const cause = CAUSES[top];
  const tail = streak(history, g => causeShares(g)(cause.key) > 0.7);
  return { level: 'info', chart: 'interventions', title: `Dominuje: ${cause.label.toLowerCase()}`, since: (tail[0] ?? recent[0]).generation,
    detail: `${cause.label} to ${pct(totals[top] / all)} interwencji w ostatnich ${recent.length} gen.: ${cause.hint}. Błąd jest systematyczny, w jednym kanale sterowania.` };
};

const onlineStalled: Detector = history => {
  const tail = streak(history, g => g.interventionRate !== null && g.interventionRate > 0.05 && g.onlineTrainSteps === 0);
  if (tail.length < 5) return null;
  return { level: 'warn', chart: 'interventions', title: 'Korekty online stoją', since: tail[0].generation,
    detail: `Strażnik interweniuje (${pct(sum(tail, g => g.interventionRate!) / tail.length)} kroków), ale sieć nie dostaje z tego żadnej korekty (DAgger). Uczy się już tylko przez mutację.` };
};

const interventionsFlat: Detector = history => {
  const recent = history.slice(-LONG_WINDOW).filter(g => g.interventionRate !== null);
  if (recent.length < LONG_WINDOW) return null;
  const rates = recent.map(g => g.interventionRate!);
  const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
  if (Math.max(...rates) - Math.min(...rates) >= 0.01 || mean <= 0.1) return null;
  return { level: 'info', chart: 'interventions', title: 'Interwencje bez zmian', since: recent[0].generation,
    detail: `Od ${recent.length} gen. udział interwencji stoi na ${pct(mean)} mimo ${sum(recent, g => g.onlineTrainSteps)} korekt online: sieć przestała uczyć się od strażnika.` };
};

// ---- Events ----

const crashSurge: Detector = history => {
  if (history.length < TREND_WINDOW + 1) return null;
  const base = median(history.slice(-LONG_WINDOW - 1, -1).map(crashRate)) ?? 0;
  const threshold = Math.max(2 * base, base + 0.5);
  const last = history[history.length - 1];
  if (crashCount(last) < 3 || crashRate(last) <= threshold) return null;
  const tail = streak(history, g => crashRate(g) > threshold);
  const kinds = Object.keys(last.crashes) as CrashKind[];
  const top = kinds.reduce((a, b) => sum(tail, g => g.crashes[b]) > sum(tail, g => g.crashes[a]) ? b : a);
  return { level: tail.length >= 3 ? 'bad' : 'warn', chart: 'events', title: 'Lawina wypadków', since: tail[0].generation,
    detail: `W gen. ${last.generation} ${crashCount(last)} wypadków (${dec(crashRate(last), 1)}/min symulacji, zwykle ${dec(base, 1)}/min). Najczęściej: ${CRASH_HINT[top]}.` };
};

const changesHurt: Detector = (history, ctx) => {
  if (history.length < TREND_WINDOW) return null;
  const recent = history.slice(-TREND_WINDOW);
  const reverts = sum(recent, g => g.reverts), bests = sum(recent, g => g.personalBests);
  if (reverts < 10 || reverts < 2 * bests) return null;
  const mutation = recent[recent.length - 1].meanMutationRate;
  const advice = ctx.mutationFloor !== undefined && mutation <= ctx.mutationFloor * 1.5
    ? 'Mutacja jest już niska, więc jazdę psują raczej korekty online albo losowe warunki (paliwo, ruch).'
    : 'Obniż mutację.';
  return { level: 'warn', chart: 'events', title: 'Więcej cofnięć niż rekordów', since: recent[0].generation,
    detail: `W ostatnich ${recent.length} gen. ${reverts} cofnięć mózgu przy ${bests} przyjętych lepszych mózgach: zmiany w sieciach częściej pogarszają jazdę, niż ją poprawiają. ${advice}` };
};

const noOneImproves: Detector = history => {
  const tail = streak(history, g => g.personalBests === 0);
  if (tail.length < TREND_WINDOW) return null;
  return { level: 'warn', chart: 'events', title: 'Nikt się nie poprawia', since: tail[0].generation,
    detail: `Od ${tail.length} gen. żaden zespół nie przyjął lepszego mózgu (${sum(tail, g => g.cleanLaps)} czystych okrążeń). Każdy zespół stoi w miejscu, nie tylko lider.` };
};

const islandsUseless: Detector = (history, ctx) => {
  if (ctx.islandCount <= 0) return null;
  const tail = streak(history, g => g.islandAdoptions === 0);
  if (tail.length < LONG_WINDOW) return null;
  return { level: 'info', chart: 'events', title: 'Wyspy bez pożytku', since: tail[0].generation,
    detail: `Wyspy (${ctx.islandCount}) od ${tail.length} gen. nie oddały ani jednego szybszego kierowcy: zajmują rdzenie bez efektu.` };
};

// ---- Diversity and mutation ----

const diversityCollapse: Detector = history => {
  const tail = streak(history, g => g.diversity !== null && g.diversity < COLLAPSE_DIVERSITY);
  if (!tail.length) return null;
  return { level: 'warn', chart: 'diversity', title: 'Zapaść różnorodności', since: tail[0].generation,
    detail: 'Mózgi wszystkich zespołów są niemal identyczne z mistrzem: selekcja ma z czego wybierać tylko dzięki mutacji. Wyspy albo wyższa mutacja przywrócą rozrzut.' };
};

const towardCollapse: Detector = history => {
  const recent = history.slice(-TREND_WINDOW).filter(g => g.diversity !== null);
  if (recent.length < 8) return null;
  const fit = fitOf(recent, g => g.diversity);
  const last = recent[recent.length - 1].diversity!;
  if (!fit || fit.slope >= 0 || -fit.slope < SIGNIFICANT * fit.se || last < COLLAPSE_DIVERSITY) return null;
  const left = (last - COLLAPSE_DIVERSITY) / -fit.slope;
  if (left >= 20) return null;
  return { level: 'warn', chart: 'diversity', title: 'Zmierza do zapaści', since: recent[0].generation,
    detail: `Różnorodność spada o ${dec(-fit.slope, 4)} na generację; w tym tempie za ok. ${Math.max(1, Math.round(left))} gen. wszystkie zespoły będą jeździć tym samym mózgiem.` };
};

const diverging: Detector = history => {
  const recent = history.filter(g => g.diversity !== null && g.medianLap !== null).slice(-LONG_WINDOW);
  if (recent.length < MIN_LONG_POINTS) return null;
  const div = fitOf(recent, g => g.diversity), med = fitOf(recent, g => g.medianLap);
  const mean = sum(recent, g => g.diversity!) / recent.length;
  if (!div || !med || div.slope <= 0 || div.slope * recent.length < 0.5 * mean || med.slope <= 0.05 || med.slope < SIGNIFICANT * med.se) return null;
  return { level: 'warn', chart: 'diversity', title: 'Populacja się rozjeżdża', since: recent[0].generation,
    detail: `Zespoły oddalają się od mózgu mistrza, a mediana okrążeń rośnie o ${perGen(med.slope)}: rozrzut idzie w gorszą stronę, mutacja jest za silna.` };
};

const mutationStuck: Detector = (history, ctx) => {
  if (!history.length || ctx.trend.gensSinceRecord < TREND_WINDOW) return null;
  const last = history[history.length - 1].meanMutationRate;
  if (last <= 0) return null;
  const tail = streak(history, g => Math.abs(g.meanMutationRate - last) <= 0.01 * last);
  if (tail.length < LONG_WINDOW) return null;
  const atFloor = ctx.mutationFloor !== undefined && last <= ctx.mutationFloor * 1.05;
  const atCeiling = ctx.mutationCeiling !== undefined && last >= ctx.mutationCeiling * 0.95;
  const where = atFloor ? ' (na minimum: zespoły „zamarzły”, podnieś mutację)' : atCeiling ? ' (na maksimum: każda próba i tak przegrywa)' : '';
  return { level: 'warn', chart: 'mutation', title: 'Mutacja stoi', since: tail[0].generation,
    detail: `Średnia stopa mutacji od ${tail.length} gen. wynosi ${dec(last, 3)}${where}, choć rekordu nie ma od ${ctx.trend.gensSinceRecord} gen.: wyżarzanie przestało reagować na brak postępu.` };
};

const mutationNoEffect: Detector = (history, ctx) => {
  const last = history[history.length - 1];
  const { trialSuccess, trials } = ctx.trend;
  if (!last || ctx.mutationCeiling === undefined || last.meanMutationRate < 0.9 * ctx.mutationCeiling || trialSuccess === null || trials < 10 || trialSuccess >= 0.05) return null;
  const tail = streak(history, g => g.meanMutationRate >= 0.9 * ctx.mutationCeiling!);
  return { level: 'info', chart: 'mutation', title: 'Silna mutacja bez efektu', since: tail[0].generation,
    detail: `Mutacja jest blisko maksimum (${dec(last.meanMutationRate, 3)}), a tylko ${pct(trialSuccess)} z ${trials} prób eksploracji dało lepszy mózg. Losowe zmiany już nie pomagają: potrzebna inna topologia albo reset.` };
};

// ---- Network ----

const saturated: Detector = history => {
  const tail = streak(history, g => g.hiddenSaturation !== null && g.hiddenSaturation > 0.5);
  if (tail.length < TREND_WINDOW) return null;
  return { level: 'warn', chart: 'network', title: 'Nasycone neurony', since: tail[0].generation,
    detail: `Średnio ${pct(sum(tail, g => g.hiddenSaturation!) / tail.length)} neuronów ukrytych mistrza siedzi przy granicy tanh: korekty online prawie nie zmieniają sieci, a mutacje słabo zmieniają zachowanie.` };
};

// ---- The session as a whole ----

const paceFloor: Detector = history => {
  const tail = streak(history, g => g.paceAtFloor !== null && g.paceAtFloor >= 0.5);
  if (tail.length < TREND_WINDOW) return null;
  const last = tail[tail.length - 1];
  return { level: 'bad', chart: 'general', title: 'Zapas tempa na minimum', since: tail[0].generation,
    detail: `Od ${tail.length} gen. ${pct(last.paceAtFloor!)} kierowców ma zapas przyczepności planera przy minimum (średnio ${dec(last.meanPaceMargin ?? 0, 2)}). `
      + 'Auta jadą wolniej niezależnie od sieci, więc cofanie mózgów i mutacja nie przywrócą tempa; nadzorca resetuje wtedy szukanie tempa.' };
};

const stuck: Detector = (history, ctx) => {
  const { gensSinceRecord, trialSuccess, trials } = ctx.trend;
  if (gensSinceRecord < STUCK_GENERATIONS) return null;
  const recent = history.filter(g => g.medianLap !== null).slice(-LONG_WINDOW);
  const med = fitOf(recent, g => g.medianLap);
  if (recent.length < MIN_LONG_POINTS || !med || Math.abs(med.slope) >= 0.02) return null;
  const last = history[history.length - 1];
  const reasons = [
    last.diversity !== null && last.diversity < 5 * COLLAPSE_DIVERSITY ? 'zespoły jeżdżą prawie tym samym mózgiem' : '',
    trialSuccess !== null && trials >= 10 && trialSuccess < 0.05 ? `eksploracja trafia w ${pct(trialSuccess)} prób` : '',
  ].filter(Boolean);
  if (!reasons.length) return null;
  return { level: 'bad', chart: 'general', title: 'Nauka utknęła', since: recordSince(history),
    detail: `${gensSinceRecord} gen. bez rekordu sesji, mediana stoi (${perGen(med.slope)}), ${reasons.join(', ')}. `
      + 'Kolejne generacje nic nie dają: zmień topologię sieci, dodaj wyspy albo zresetuj naukę.' };
};

const DETECTORS: Detector[] = [stuck, paceFloor, wrongDirection, strayed, noise, championOnly, blind,
  guardianDrives, dominantCause, onlineStalled, interventionsFlat,
  crashSurge, changesHurt, noOneImproves, islandsUseless,
  diversityCollapse, towardCollapse, diverging, mutationStuck, mutationNoEffect, saturated];

/** Notes on the session's charts, most serious first; never empty. */
export function insights(history: readonly GenerationStats[], ctx: InsightContext): Insight[] {
  if (history.length < TREND_WINDOW) {
    return [{ level: 'info', chart: 'general', title: 'Za mało danych', since: history[0]?.generation ?? 1,
      detail: `Uwagi pojawią się po ${TREND_WINDOW} zakończonych generacjach (jest ${history.length}).` }];
  }
  const found = DETECTORS.map(detect => detect(history, ctx)).filter((i): i is Insight => i !== null);
  if (!found.some(i => i.level === 'bad' || i.level === 'warn')) {
    const med = fitOf(history.filter(g => g.medianLap !== null).slice(-TREND_WINDOW), g => g.medianLap);
    found.push(med && med.slope < -0.02
      ? { level: 'good', chart: 'general', title: 'Zdrowa nauka', since: history[Math.max(0, history.length - TREND_WINDOW)].generation,
        detail: `Mediana okrążeń spada o ${perGen(med.slope)} i nie widać objawów problemów.` }
      : { level: 'good', chart: 'general', title: 'Bez niepokojących objawów', since: history[0].generation,
        detail: `Żaden z detektorów nie widzi problemu w ${history.length} generacjach.` });
  }
  return found.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
}
