/**
 * Tyre compounds: three dry slicks and two treaded wet-weather tyres. Each scales the axle
 * grip of the thermal / wear model in `Car` (medium on a dry track is the calibrated 1.0),
 * moves its working-temperature window and wears at its own rate.
 */
export type TyreCompound = 'soft' | 'medium' | 'hard' | 'intermediate' | 'wet';

export const TYRE_COMPOUNDS: readonly TyreCompound[] = ['soft', 'medium', 'hard', 'intermediate', 'wet'];

export interface CompoundSpec {
  /** Name shown in the UI. */
  label: string;
  /** One-letter badge (S / M / H / I / W). */
  letter: string;
  /** Sidewall band colour, as on the real tyres. */
  color: string;
  /** Grip relative to a medium on a dry track, on a dry (0), damp (0.5) and soaked (1) track. */
  grip: [number, number, number];
  /** Centre of the working-temperature window (deg C). */
  optimum: number;
  /** Width (deg C) of the window below and above the optimum. */
  coldWidth: number;
  hotWidth: number;
  /** Wear rate relative to a medium. */
  wear: number;
}

export const COMPOUND_SPECS: Record<TyreCompound, CompoundSpec> = {
  soft:         { label: 'Soft',         letter: 'S', color: '#e8222b', grip: [1.035, 0.74, 0.46], optimum: 95,  coldWidth: 20, hotWidth: 22, wear: 1.8 },
  medium:       { label: 'Medium',       letter: 'M', color: '#f5c518', grip: [1.0,   0.72, 0.45], optimum: 100, coldWidth: 22, hotWidth: 26, wear: 1.0 },
  hard:         { label: 'Hard',         letter: 'H', color: '#f2f2f2', grip: [0.97,  0.70, 0.44], optimum: 108, coldWidth: 24, hotWidth: 30, wear: 0.6 },
  intermediate: { label: 'Intermediate', letter: 'I', color: '#2fb54a', grip: [0.88,  0.86, 0.68], optimum: 80,  coldWidth: 22, hotWidth: 20, wear: 2.6 },
  wet:          { label: 'Wet',          letter: 'W', color: '#1f6fe0', grip: [0.82,  0.80, 0.78], optimum: 70,  coldWidth: 22, hotWidth: 18, wear: 3.4 },
};

export function isCompound(value: unknown): value is TyreCompound {
  return typeof value === 'string' && (TYRE_COMPOUNDS as readonly string[]).includes(value);
}

export function isSlick(compound: TyreCompound): boolean {
  return compound === 'soft' || compound === 'medium' || compound === 'hard';
}

/** Grip factor of a compound on a track with `wetness` (0 dry .. 1 soaked), interpolated between the three points. */
export function compoundGrip(compound: TyreCompound, wetness: number): number {
  const [dry, damp, wet] = COMPOUND_SPECS[compound].grip;
  const w = Math.max(0, Math.min(1, wetness));
  return w <= 0.5 ? dry + (damp - dry) * w * 2 : damp + (wet - damp) * (w - 0.5) * 2;
}

/** The compound family that is fastest on this track: slicks, intermediates or full wets. */
export function weatherCompound(wetness: number, dryChoice: TyreCompound): TyreCompound {
  let best = isSlick(dryChoice) ? dryChoice : 'medium';
  for (const c of ['intermediate', 'wet'] as const) if (compoundGrip(c, wetness) > compoundGrip(best, wetness) + 0.01) best = c;
  return best;
}

/** True when another compound family would be clearly faster in these conditions. */
export function wrongForConditions(compound: TyreCompound, wetness: number): boolean {
  const best = weatherCompound(wetness, compound);
  return best !== compound && compoundGrip(best, wetness) > compoundGrip(compound, wetness) * 1.04;
}

/** AI stint plan on a dry track: the next slick after `current`. */
export function nextDryCompound(current: TyreCompound): TyreCompound {
  return current === 'hard' ? 'medium' : 'hard';
}

/** AI starting slick by grid slot, so the field runs mixed strategies. */
export function startingDryCompound(gridIndex: number): TyreCompound {
  return (['medium', 'soft', 'hard'] as const)[gridIndex % 3];
}
