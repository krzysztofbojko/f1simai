/**
 * The lap split into corners for the driver's per-corner limit search (PaceSearch). A corner is a run
 * of points bending more than `BEND`; corners closer than `MERGE_GAP` (a chicane, an S-bend) are one.
 * Around its arc every corner owns the straight it is braked on and the stretch it is left on:
 * braking zone → arc → exit, then the next corner's braking zone.
 */
export interface TrackCorner {
  id: number;
  /** First point of the braking zone, the arc and the point after the exit (indices wrap around the lap). */
  brakeStart: number;
  arcStart: number;
  arcEnd: number;
  exitEnd: number;
  /** Point of the tightest bend. */
  apex: number;
}

/** Phase of a point inside its corner's zone. */
export const enum CornerPhase { None = 0, Brake = 1, Arc = 2, Exit = 3 }

export interface TrackCorners {
  corners: TrackCorner[];
  /** Corner whose zone (braking, arc or exit) a point lies in, -1 on the rest of a straight. */
  zone: Int16Array;
  phase: Uint8Array;
}

/** Bend (1/m) from which a point belongs to a corner: the one from which corners carry kerbs. */
export const BEND = 0.003;
/** Bends separated by a straight shorter than this (m) are one corner. */
export const MERGE_GAP = 40;
/** A bend shorter than this (m) is a kink, not a corner. */
export const MIN_ARC = 10;
/** Longest braking zone (m) a corner owns before its arc. */
export const MAX_BRAKE_ZONE = 250;
/** Stretch (m) after the arc that still shows how the corner was left. */
export const EXIT_LENGTH = 60;

export function findCorners(curvature: ArrayLike<number>, spacing: number): TrackCorners {
  const n = curvature.length;
  const zone = new Int16Array(n).fill(-1), phase = new Uint8Array(n);
  const bend = (i: number) => Math.abs(curvature[i]) >= BEND;
  const start = Array.from({ length: n }, (_, i) => i).find(i => !bend(i));
  // No straight at all (a ring) or no bend at all: nothing to split.
  if (start === undefined || !Array.from({ length: n }, (_, i) => i).some(bend)) return { corners: [], zone, phase };
  const points = (metres: number) => Math.max(1, Math.round(metres / Math.max(1e-6, spacing)));

  // Bends as [from, to) in lap order counted from the first straight point, so none wraps.
  const runs: [number, number][] = [];
  for (let k = 0; k < n;) {
    if (!bend((start + k) % n)) { k++; continue; }
    const from = k;
    while (k < n && bend((start + k) % n)) k++;
    const last = runs[runs.length - 1];
    if (last && from - last[1] < points(MERGE_GAP)) last[1] = k;
    else runs.push([from, k]);
  }
  // The last bend may run into the first across the counting start.
  if (runs.length > 1 && n - runs[runs.length - 1][1] + runs[0][0] < points(MERGE_GAP)) {
    const [from] = runs.pop()!;
    runs[0] = [from - n, runs[0][1]];
  }
  const arcs = runs.filter(([from, to]) => to - from >= points(MIN_ARC));
  if (!arcs.length) return { corners: [], zone, phase };

  const corners: TrackCorner[] = arcs.map(([from, to], id) => {
    let apex = from;
    for (let k = from; k < to; k++) if (Math.abs(curvature[(start + k + n) % n]) > Math.abs(curvature[(start + apex + n) % n])) apex = k;
    const next = arcs[(id + 1) % arcs.length][0] + (id + 1 === arcs.length ? n : 0);
    const exitEnd = Math.min(to + points(EXIT_LENGTH), next);
    return { id, brakeStart: from, arcStart: from, arcEnd: to, exitEnd, apex };
  });
  // Braking zones: from the previous corner's exit, at most MAX_BRAKE_ZONE before the arc.
  corners.forEach((c, id) => {
    const prev = corners[(id - 1 + corners.length) % corners.length];
    const prevExit = prev.exitEnd - (id === 0 ? n : 0);
    c.brakeStart = Math.max(prevExit, c.arcStart - points(MAX_BRAKE_ZONE));
    if (corners.length === 1) c.brakeStart = Math.max(c.exitEnd - n, c.arcStart - points(MAX_BRAKE_ZONE));
  });
  for (const c of corners) {
    const mark = (from: number, to: number, p: CornerPhase) => {
      for (let k = from; k < to; k++) { const i = ((start + k) % n + n) % n; zone[i] = c.id; phase[i] = p; }
    };
    mark(c.brakeStart, c.arcStart, CornerPhase.Brake);
    mark(c.arcStart, c.arcEnd, CornerPhase.Arc);
    mark(c.arcEnd, c.exitEnd, CornerPhase.Exit);
    // Store real point indices.
    const wrap = (k: number) => ((start + k) % n + n) % n;
    c.brakeStart = wrap(c.brakeStart); c.arcStart = wrap(c.arcStart); c.arcEnd = wrap(c.arcEnd);
    c.exitEnd = wrap(c.exitEnd); c.apex = wrap(c.apex);
  }
  return { corners, zone, phase };
}
