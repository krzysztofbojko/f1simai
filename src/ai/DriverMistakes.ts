import type { CarControl } from '../physics/Car';

/** Simulation-time Poisson hazard. A mistake perturbs controls, never momentum. */
export class DriverMistakes {
  public remaining = 0;
  public cooldown = 0;
  public count = 0;
  private steerBias = 0;
  private lateBrake = false;
  constructor(private random: () => number = () => Math.random()) {}

  static probability(risk: number, dt: number): number {
    return -Math.expm1(-Math.max(0, Math.min(1, risk)) * Math.max(0, dt) / 600);
  }

  step(control: CarControl, dt: number, risk: number, eligible: boolean): { control: CarControl; affected: boolean } {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (!eligible) { this.remaining = 0; return { control, affected: false }; }
    if (this.remaining <= 0 && this.cooldown <= 0 && this.random() < DriverMistakes.probability(risk, dt)) {
      this.remaining = 0.2 + this.random() * 0.4;
      this.lateBrake = this.random() < 0.5 && control.brake > 0.05;
      this.steerBias = (this.random() < 0.5 ? -1 : 1) * (0.08 + this.random() * 0.12);
      this.cooldown = 30;
      this.count++;
    }
    const affected = this.remaining > 0;
    if (!affected) return { control, affected: false };
    this.remaining = Math.max(0, this.remaining - dt);
    return { affected: true, control: this.lateBrake
      ? { ...control, brake: control.brake * 0.25 }
      : { ...control, steer: Math.max(-1, Math.min(1, control.steer + this.steerBias)) } };
  }

  reset(): void { this.remaining = 0; this.cooldown = 0; }
}
