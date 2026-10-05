/** Short, voluntary race attacks. Timing uses simulation seconds, not frames. */
export class BattlePush {
  remaining = 0;
  cooldown = 0;
  opponent = '';
  count = 0;
  constructor(private random: () => number = () => Math.random()) {}
  reset(): void { this.remaining = 0; this.cooldown = 0; this.opponent = ''; this.count = 0; }
  step(dt: number, opponent: string | null, eligible: boolean): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.remaining = Math.max(0, this.remaining - dt);
    if (!eligible || !opponent || (this.remaining > 0 && opponent !== this.opponent)) this.remaining = 0;
    if (eligible && opponent && this.remaining === 0 && this.cooldown === 0 && this.random() < -Math.expm1(-dt / 15)) {
      this.remaining = 3 + this.random() * 3;
      this.cooldown = this.remaining + 20;
      this.opponent = opponent;
      this.count++;
    }
    if (this.remaining === 0) this.opponent = '';
  }
}
