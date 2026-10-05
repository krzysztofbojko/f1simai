/** Changes AI planning only; tyre and brake forces retain their physical limits. */
export function normalizePressure(value: number): number {
  return Number.isFinite(value) ? Math.max(-10, Math.min(10, Math.round(value))) : 0;
}
export function pressureProfile(value: number) {
  const p = Number.isFinite(value) ? Math.max(-10, Math.min(10, value)) : 0;
  const t = Math.abs(p) / 10;
  return {
    cornerGrip: .45 + t * (p < 0 ? -.13 : .30),
    braking: 1 + t * (p < 0 ? -.15 : .80),
    coastMargin: .15 - (p > 0 ? t * .13 : 0),
    brakeFloor: .65 - (p > 0 ? t * .20 : 0),
    attacks: 1 + t * (p < 0 ? -.5 : 1),
    mistakes: 1 + t * (p < 0 ? -.75 : 3),
  };
}

export function loadDriverPressure(): number {
  try { return normalizePressure(Number(localStorage.getItem('f1_driver_pressure') ?? 0)); }
  catch { return 0; }
}
