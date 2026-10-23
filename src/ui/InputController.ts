import type { CarControl } from '../physics/Car';

export interface InputHandlers {
  /** The player drives a car: the driving keys must not scroll the page. */
  isDriving(): boolean;
  /** P: ask for a pit stop at the next crossing of the line, or cancel it. */
  onPitToggle(): void;
  /** Shift pressed or released (straight segments while drawing a track). */
  onShift(down: boolean): void;
}

const DRIVING_KEYS = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'w', 's', 'a', 'd'];

/** Keyboard of the page: WASD / arrows drive the player's car, P calls it in, Shift draws straights. */
export class InputController {
  private readonly keys: Record<string, boolean> = {};
  /** Shift is held down. */
  shiftHeld = false;

  constructor(private readonly handlers: InputHandlers) {
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      this.keys[key] = true;
      if (key === 'p') this.handlers.onPitToggle();
      if (this.handlers.isDriving() && DRIVING_KEYS.includes(key)) e.preventDefault();
      if (e.key === 'Shift') {
        this.shiftHeld = true;
        this.handlers.onShift(true);
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys[e.key.toLowerCase()] = false;
      if (e.key === 'Shift') {
        this.shiftHeld = false;
        this.handlers.onShift(false);
      }
    });
  }

  /** The player's demand from the keys held: full lock, full throttle or full brake. */
  playerControl(): CarControl {
    let steer = 0;
    let throttle = 0;
    let brake = 0;
    if (this.keys['a'] || this.keys['arrowleft']) steer -= 1;
    if (this.keys['d'] || this.keys['arrowright']) steer += 1;
    if (this.keys['w'] || this.keys['arrowup']) throttle = 1;
    if (this.keys['s'] || this.keys['arrowdown']) brake = 1;
    return { steer, throttle, brake };
  }
}
