import { Car } from '../../physics/Car';

const SVG = 'http://www.w3.org/2000/svg';
/** The needle sweeps 270° clockwise, from lower left (−135° from straight up) to lower right. */
const START = -135, SWEEP = 270;
const DIAL_R = 82;
/** Needle lag (s): enough to move like a mechanical needle, not to hide gear changes. */
const NEEDLE_LAG = 0.08;
/** Shift lights: the first lights at this rpm, all of them at the upshift point. */
const SHIFT_LIGHTS = 10, SHIFT_FROM = 11000;
const FUEL_RESERVE_KG = 10;

interface Zone { from: number; to: number; color: string }
interface Needle { color: string }
interface GaugeSpec {
  size: 'large' | 'medium' | 'small';
  label: string;
  unit?: string;
  min: number;
  max: number;
  major: number;
  minor?: number;
  format?: (value: number) => string;
  zones?: Zone[];
  needles?: Needle[];
  /** Big digit in the hub (the gear on the tachometer). */
  hubText?: boolean;
  /** Legend under the hub for multi-needle gauges. */
  legend?: string;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

const polar = (deg: number, r: number) => {
  const a = deg * Math.PI / 180;
  return { x: r * Math.sin(a), y: -r * Math.cos(a) };
};

/** One round analogue dial: face, scale and numbers drawn once, then only the needles turn. */
class Gauge {
  readonly root: SVGSVGElement;
  private readonly needles: SVGGElement[] = [];
  private readonly shown: number[] = [];
  private readonly drawn: number[] = [];
  private readonly hub: SVGTextElement | null = null;
  private hubValue = '';

  constructor(private readonly spec: GaugeSpec) {
    const svg = this.root = el('svg', { viewBox: '-100 -100 200 200', class: `dash-gauge dash-${spec.size}`, 'aria-hidden': 'true' });
    el('circle', { r: 97, class: 'dash-bezel' }, svg);
    el('circle', { r: 90, class: 'dash-face' }, svg);
    for (const z of spec.zones ?? []) {
      const a = polar(this.angle(z.from), 86), b = polar(this.angle(z.to), 86);
      const large = this.angle(z.to) - this.angle(z.from) > 180 ? 1 : 0;
      el('path', { d: `M${a.x} ${a.y}A86 86 0 ${large} 1 ${b.x} ${b.y}`, stroke: z.color, class: 'dash-zone' }, svg);
    }
    const minor = spec.minor ?? spec.major;
    const steps = Math.round((spec.max - spec.min) / minor);
    for (let i = 0; i <= steps; i++) {
      const v = spec.min + i * minor, deg = this.angle(v);
      const isMajor = Math.abs((v - spec.min) / spec.major - Math.round((v - spec.min) / spec.major)) < 1e-6;
      const p = polar(deg, DIAL_R), q = polar(deg, isMajor ? DIAL_R - 13 : DIAL_R - 7);
      el('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: isMajor ? 'dash-tick major' : 'dash-tick' }, svg);
      if (!isMajor) continue;
      const t = polar(deg, DIAL_R - 27);
      const text = el('text', { x: t.x, y: t.y, class: 'dash-num' }, svg);
      text.textContent = spec.format ? spec.format(v) : String(v);
    }
    const label = el('text', { x: 0, y: spec.hubText ? 48 : 40, class: 'dash-label' }, svg);
    label.textContent = spec.label;
    if (spec.unit) el('text', { x: 0, y: spec.hubText ? 62 : 56, class: 'dash-unit' }, svg).textContent = spec.unit;
    if (spec.legend) el('text', { x: 0, y: -30, class: 'dash-unit' }, svg).textContent = spec.legend;
    for (const needle of spec.needles ?? [{ color: '#ff3b1f' }]) {
      const g = el('g', { class: 'dash-needle' }, svg);
      el('polygon', { points: `-3.2,14 0,${-(DIAL_R - 4)} 3.2,14`, fill: needle.color }, g);
      this.needles.push(g);
      this.shown.push(NaN);
      this.drawn.push(NaN);
    }
    el('circle', { r: spec.hubText ? 24 : 9, class: 'dash-hub' }, svg);
    if (spec.hubText) this.hub = el('text', { x: 0, y: 2, class: 'dash-hub-text' }, svg);
  }

  private angle(value: number): number {
    const s = this.spec, t = Math.max(0, Math.min(1, (value - s.min) / (s.max - s.min)));
    return START + t * SWEEP;
  }

  /** Moves needle `i` toward `value`; `snap` jumps there (a new car in view). */
  set(i: number, value: number, k: number, snap: boolean): void {
    const prev = this.shown[i];
    const v = snap || !Number.isFinite(prev) ? value : prev + (value - prev) * k;
    this.shown[i] = v;
    const deg = this.angle(v);
    if (Math.abs(deg - this.drawn[i]) < 0.15) return;
    this.drawn[i] = deg;
    this.needles[i].setAttribute('transform', `rotate(${deg.toFixed(2)})`);
  }

  setHub(text: string): void {
    if (!this.hub || text === this.hubValue) return;
    this.hubValue = text;
    this.hub.textContent = text;
  }
}

/**
 * Cockpit dashboard over the 3D view: analogue tachometer with the gear and shift lights,
 * speedometer, fuel, ERS, tyre and brake temperature dials, and warning lamps.
 */
export class Dashboard {
  private readonly root: HTMLElement;
  private readonly tach: Gauge;
  private readonly speed: Gauge;
  private readonly fuel: Gauge;
  private readonly ers: Gauge;
  private readonly tyres: Gauge;
  private readonly brakes: Gauge;
  private readonly shift: HTMLElement[] = [];
  private readonly lamps: Record<'lock' | 'yellow' | 'pit' | 'fuel', HTMLElement>;
  private readonly lampState = new Map<HTMLElement, boolean>();
  private car: Car | null = null;
  private shiftLit = -1;

  constructor(root: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'dashboard';
    this.root.hidden = true;

    this.tyres = new Gauge({ size: 'small', label: 'OPONY', unit: '°C', min: 40, max: 140, major: 20, minor: 10, legend: 'P · T',
      zones: [{ from: 40, to: 80, color: '#3d8bff' }, { from: 85, to: 115, color: '#00e676' }, { from: 125, to: 140, color: '#ff3b1f' }],
      needles: [{ color: '#ffffff' }, { color: '#ff8000' }] });
    this.speed = new Gauge({ size: 'medium', label: 'km/h', min: 0, max: 360, major: 40, minor: 20 });
    this.tach = new Gauge({ size: 'large', label: '×1000 obr/min', min: Car.IDLE_RPM, max: Car.REV_LIMIT, major: 1000, minor: 500,
      format: v => String(v / 1000), hubText: true, zones: [{ from: Car.UPSHIFT_RPM, to: Car.REV_LIMIT, color: '#ff3b1f' }] });
    const quarters = ['E', '¼', '½', '¾', 'F'];
    this.fuel = new Gauge({ size: 'small', label: 'PALIWO', min: 0, max: Car.MAX_FUEL_CAPACITY, major: Car.MAX_FUEL_CAPACITY / 4,
      minor: Car.MAX_FUEL_CAPACITY / 8, format: v => quarters[Math.round(v / (Car.MAX_FUEL_CAPACITY / 4))],
      zones: [{ from: 0, to: FUEL_RESERVE_KG, color: '#ff3b1f' }] });
    this.ers = new Gauge({ size: 'small', label: 'ERS', unit: '%', min: 0, max: 100, major: 25, minor: 12.5,
      zones: [{ from: 0, to: 15, color: '#ff3b1f' }, { from: 85, to: 100, color: '#00e676' }] });
    this.brakes = new Gauge({ size: 'small', label: 'HAMULCE', unit: '×100 °C', min: 0, max: 1200, major: 200, minor: 100, legend: 'P · T',
      format: v => String(v / 100),
      zones: [{ from: 0, to: Car.BRAKE_WINDOW_LOW, color: '#3d8bff' }, { from: Car.BRAKE_WINDOW_LOW, to: Car.BRAKE_WINDOW_HIGH, color: '#00e676' }, { from: Car.BRAKE_WINDOW_HIGH, to: 1200, color: '#ff3b1f' }],
      needles: [{ color: '#ffffff' }, { color: '#ff8000' }] });

    const lights = document.createElement('div');
    lights.className = 'dash-shift';
    for (let i = 0; i < SHIFT_LIGHTS; i++) {
      const led = document.createElement('span');
      led.className = i < 4 ? 'green' : i < 8 ? 'red' : 'blue';
      lights.appendChild(led);
      this.shift.push(led);
    }
    const lamp = (text: string, kind: string) => {
      const node = document.createElement('span');
      node.className = `dash-lamp ${kind}`;
      node.textContent = text;
      return node;
    };
    this.lamps = { lock: lamp('BLOKADA', 'amber'), yellow: lamp('ŻÓŁTA FLAGA', 'yellow'), pit: lamp('PIT', 'blue'), fuel: lamp('REZERWA', 'red') };
    const lampRow = document.createElement('div');
    lampRow.className = 'dash-lamps';
    lampRow.append(...Object.values(this.lamps));

    const centre = document.createElement('div');
    centre.className = 'dash-centre';
    centre.append(lights, this.tach.root, lampRow);
    const left = document.createElement('div');
    left.className = 'dash-side';
    left.append(this.tyres.root, this.speed.root);
    const right = document.createElement('div');
    right.className = 'dash-side';
    right.append(this.fuel.root, this.ers.root, this.brakes.root);
    this.root.append(left, centre, right);
    root.appendChild(this.root);
  }

  /** Shows the dashboard of `car` (null hides it); `dt` is real time for the needle lag. */
  update(car: Car | null, dt: number): void {
    this.root.hidden = !car;
    if (!car) { this.car = null; return; }
    const snap = car !== this.car;
    this.car = car;
    const k = 1 - Math.exp(-dt / NEEDLE_LAG);
    this.tach.set(0, car.engineRpm, k, snap);
    this.tach.setHub(car.gear <= 0 ? 'N' : String(car.gear));
    this.speed.set(0, car.speedKmh, k, snap);
    this.fuel.set(0, car.fuelKg, k, snap);
    this.ers.set(0, car.ersEnergy / Car.ERS_CAPACITY * 100, k, snap);
    this.tyres.set(0, car.tyreTempFront, k, snap);
    this.tyres.set(1, car.tyreTempRear, k, snap);
    this.brakes.set(0, car.brakeTempFront, k, snap);
    this.brakes.set(1, car.brakeTempRear, k, snap);

    const lit = Math.max(0, Math.min(SHIFT_LIGHTS, Math.ceil((car.engineRpm - SHIFT_FROM) / (Car.UPSHIFT_RPM - SHIFT_FROM) * SHIFT_LIGHTS)));
    if (lit !== this.shiftLit) {
      this.shiftLit = lit;
      this.shift.forEach((led, i) => led.classList.toggle('on', i < lit));
    }
    this.lamp(this.lamps.lock, car.wheelLockFront || car.wheelLockRear);
    this.lamp(this.lamps.yellow, car.yellowFlag);
    this.lamp(this.lamps.pit, car.isPitting);
    this.lamp(this.lamps.fuel, car.fuelKg < FUEL_RESERVE_KG);
  }

  private lamp(node: HTMLElement, on: boolean): void {
    if (this.lampState.get(node) === on) return;
    this.lampState.set(node, on);
    node.classList.toggle('on', on);
  }
}
