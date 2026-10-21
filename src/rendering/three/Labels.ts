import * as THREE from 'three';
import { CameraRig } from './Cameras';
import { CarView } from './CarFleet';
import { StaticLabel } from './TrackMesh';
import { Point2 } from './Geometry';

interface Pending { view: CarView; text: string; kind: string; priority: boolean; x: number; y: number; w: number; h: number }

/** Average advance of JetBrains Mono, as a share of the font size (emoji count double). */
const CHAR_WIDTH = 0.62;

function labelText(view: CarView): { text: string; kind: string } {
  const car = view.car;
  const speed = Math.round(car.speedKmh);
  const match = car.driverName.match(/^([^\s]+)\s+([^\s(]+)/);
  const short = match ? match[2] : car.driverName.split(' ')[0];
  if (!car.isAlive) return { text: '💥 DNF', kind: 'dnf' };
  if (car.isPitting) return { text: `⛽ ${short}: PIT STOP (${car.pitTimer.toFixed(1)}s)`, kind: 'pitting' };
  if (car.yellowFlag) return { text: `⚑ ŻÓŁTA: ${short} ${speed} km/h`, kind: 'yellow' };
  if (car.isOutOfFuel) return { text: `⚠️ ${short}: LIMP MODE (NO FUEL)`, kind: 'pit' };
  if (car.wantsToPit) return { text: `🔧 ${short}: BOX THIS LAP`, kind: 'pit' };
  if (view.isPlayer) return { text: `🏎️ GRACZ: ${speed} km/h`, kind: 'player' };
  if (view.isSelected) return { text: `🎯 ${short}: ${speed} km/h`, kind: 'selected' };
  if (view.isLeader) return { text: `👑 ${short}: ${speed} km/h`, kind: 'leader' };
  return { text: `${short}: ${speed} km/h`, kind: 'normal' };
}

/** Pooled HTML element with cached text/class, so unchanged labels cost no DOM writes. */
class Slot {
  readonly el = document.createElement('div');
  private text = '';
  private cls = '';
  private color = '';
  private shown = true;

  constructor(parent: HTMLElement) { parent.appendChild(this.el); this.hide(); }

  show(text: string, cls: string, x: number, y: number, color = ''): void {
    if (text !== this.text) { this.el.textContent = text; this.text = text; }
    if (cls !== this.cls) { this.el.className = cls; this.cls = cls; }
    if (color !== this.color) { this.el.style.setProperty('--label-color', color); this.color = color; }
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    if (!this.shown) { this.el.style.display = ''; this.shown = true; }
  }

  hide(): void { if (this.shown) { this.el.style.display = 'none'; this.shown = false; } }
}

/**
 * Car speed badges, sector names and editor hints as an HTML layer over the canvas: crisp
 * text at any zoom. Important badges are placed first; ordinary ones are dropped when they
 * would overlap a badge already placed (as in the 2D view).
 */
export class Labels {
  private readonly cars: Slot[] = [];
  private readonly statics: Slot[] = [];
  private readonly badge: Slot;
  private readonly pending: Pending[] = [];
  private readonly placed: number[] = [];
  private readonly p = new THREE.Vector2();

  constructor(private readonly layer: HTMLElement) {
    this.badge = new Slot(layer);
  }

  private overlaps(x: number, y: number, w: number, h: number): boolean {
    const a = this.placed;
    for (let i = 0; i < a.length; i += 4) {
      if (x < a[i] + a[i + 2] && x + w > a[i] && y < a[i + 1] + a[i + 3] && y + h > a[i + 1]) return true;
    }
    return false;
  }

  update(rig: CameraRig, views: CarView[], showSpeed: boolean, statics: StaticLabel[], drawBadge: Point2 | null): void {
    this.pending.length = 0;
    this.placed.length = 0;
    const ppm = rig.pixelsPerMetre;
    const lift = ppm ? Math.max(24, 0.9 * ppm + 16) : 30;
    for (const view of views) {
      const car = view.car;
      if (car.wreckRemoved || (!showSpeed && car.isAlive)) continue;
      if (!rig.worldToScreen(car.pos.x, car.pos.y, 1.2, this.p)) continue;
      const { text, kind } = labelText(view);
      const strong = view.isLeader || view.isPlayer || view.isSelected || car.isPitting;
      const font = strong ? 10 : 9;
      let chars = 0;
      for (const ch of text) chars += ch.codePointAt(0)! > 0x2000 ? 2 : 1;
      const w = chars * font * CHAR_WIDTH + 14, h = strong ? 18 : 16;
      const priority = strong || car.yellowFlag || car.wantsToPit || car.isOutOfFuel || !car.isAlive;
      this.pending.push({ view, text, kind: strong ? `${kind} strong` : kind, priority, x: this.p.x - w / 2, y: this.p.y - lift - h, w, h });
    }

    let used = 0;
    for (const pass of [true, false]) {
      for (const item of this.pending) {
        if (item.priority !== pass) continue;
        if (!pass && this.overlaps(item.x - 2, item.y - 2, item.w + 4, item.h + 4)) continue;
        this.placed.push(item.x - 2, item.y - 2, item.w + 4, item.h + 4);
        if (!this.cars[used]) this.cars[used] = new Slot(this.layer);
        this.cars[used++].show(item.text, `car-label ${item.kind}`, item.x, item.y, item.view.car.color);
      }
    }
    for (let i = used; i < this.cars.length; i++) this.cars[i].hide();

    let s = 0;
    for (const label of statics) {
      if (!rig.worldToScreen(label.x, label.y, 0.5, this.p)) continue;
      if (!this.statics[s]) this.statics[s] = new Slot(this.layer);
      this.statics[s++].show(label.text, `track-label ${label.className}`, this.p.x, this.p.y, label.color);
    }
    for (let i = s; i < this.statics.length; i++) this.statics[i].hide();

    if (drawBadge && rig.worldToScreen(drawBadge.x, drawBadge.y, 0, this.p)) this.badge.show('📏 PROSTA (SHIFT)', 'track-label straight', this.p.x, this.p.y, '#FFD700');
    else this.badge.hide();
  }
}
