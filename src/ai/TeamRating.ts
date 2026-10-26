import type { TeamRecord } from './Population';

/**
 * How a brain is judged in training. One clean lap says little: the same brain spreads its laps by
 * several per cent (per-lap grip and power, traffic, the pace probe, running wide), more than brains
 * differ. A team's rating is therefore the median of the recent clean laps of the brains it accepted, and
 * a brain becomes the team's record brain only when the median of its own `JUDGE_LAPS` clean laps beats
 * that rating. Laps of a brain that goes back never enter the rating: they would drag it towards a
 * slower brain, which would then pass more easily, and the team would drift away from its best pace.
 * The fastest single lap stays the team's record in the tables; it never picks a brain.
 */

/** Clean laps of the team's accepted brains kept for its rating, newest last. */
export const RECENT_LAPS = 20;
/** Recent clean laps a team needs before their median counts as its rating: the first lap and one judged brain. */
export const RATING_MIN_LAPS = 5;
/** Clean laps a brain drives before its verdict. */
export const JUDGE_LAPS = 4;
/** A single lap this many spreads slower than the rating is a broken brain: it goes back at once. */
const DEGRADED_SPREADS = 3;
/** Floor of the degraded margin, s: a team with very even laps is not reverted for a tenth. */
const DEGRADED_MIN_SECONDS = 2.5;

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The team's typical clean lap with the brains it keeps (median of the recent laps); null before enough laps. */
export function teamRating(record: TeamRecord): number | null {
  return record.recentLaps.length >= RATING_MIN_LAPS ? median(record.recentLaps) : null;
}

/** Robust spread of the team's recent laps (scaled median absolute deviation, s). */
export function lapSpread(record: TeamRecord): number {
  const rating = median(record.recentLaps);
  return 1.4826 * median(record.recentLaps.map(t => Math.abs(t - rating)));
}

/** A lap so slow against the team's rating that the brain driving it is broken, not unlucky. */
export function degradedLap(record: TeamRecord, lapTime: number): boolean {
  const rating = teamRating(record);
  return rating !== null && lapTime > rating + Math.max(DEGRADED_MIN_SECONDS, DEGRADED_SPREADS * lapSpread(record));
}
