/** Small Canvas 2D line charts for the learning panel: one y-axis, thin lines, a crosshair with a tooltip. */

export interface ChartSeries {
  label: string;
  color: string;
  values: (number | null)[];
}

export interface LineChartData {
  /** One x label per value (generation numbers). */
  x: number[];
  series: ChartSeries[];
  format: (value: number) => string;
  /** Lower bound of the y-axis (e.g. 0 for shares); free when absent. */
  yMin?: number;
}

const INK_MUTED = '#8b949e';
const GRID = 'rgba(255, 255, 255, 0.07)';
const PAD = { left: 52, right: 12, top: 10, bottom: 20 };

export class LineChart {
  private data: LineChartData | null = null;
  private hover: number | null = null;
  private readonly tooltip: HTMLDivElement;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly empty: string) {
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'lp-tooltip hidden';
    canvas.parentElement?.appendChild(this.tooltip);
    canvas.addEventListener('pointermove', e => {
      const index = this.indexAt(e.offsetX);
      if (index !== this.hover) { this.hover = index; this.draw(); }
    });
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
  }

  set(data: LineChartData): void {
    this.data = data;
    if (this.hover !== null && this.hover >= data.x.length) this.hover = null;
    this.draw();
  }

  private plotWidth(): number { return Math.max(1, this.canvas.clientWidth - PAD.left - PAD.right); }

  private xAt(index: number, count: number): number {
    return PAD.left + (count > 1 ? this.plotWidth() * index / (count - 1) : this.plotWidth() / 2);
  }

  private indexAt(offsetX: number): number | null {
    const count = this.data?.x.length ?? 0;
    if (count < 1) return null;
    const t = (offsetX - PAD.left) / this.plotWidth();
    return Math.max(0, Math.min(count - 1, Math.round(t * (count - 1))));
  }

  draw(): void {
    const canvas = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px "JetBrains Mono", monospace';

    const data = this.data;
    const values = data ? data.series.flatMap(s => s.values.filter((v): v is number => v !== null && Number.isFinite(v))) : [];
    if (!data || data.x.length < 2 || !values.length) {
      ctx.fillStyle = INK_MUTED; ctx.textAlign = 'center';
      ctx.fillText(this.empty, w / 2, h / 2);
      this.tooltip.classList.add('hidden');
      return;
    }
    let min = Math.min(...values), max = Math.max(...values);
    if (data.yMin !== undefined) min = Math.min(min, data.yMin);
    if (max - min < 1e-9) { max += 1; min = data.yMin !== undefined ? Math.max(data.yMin, min - 1) : min - 1; }
    const span = max - min, plotH = h - PAD.top - PAD.bottom, count = data.x.length;
    const yAt = (v: number) => PAD.top + plotH - plotH * (v - min) / span;

    ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.fillStyle = INK_MUTED; ctx.textAlign = 'right';
    for (let i = 0; i <= 3; i++) {
      const v = min + span * i / 3, y = Math.round(yAt(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(w - PAD.right, y); ctx.stroke();
      ctx.fillText(data.format(v), PAD.left - 6, y + 3);
    }
    ctx.textAlign = 'center';
    for (const index of [0, count >> 1, count - 1]) ctx.fillText(String(data.x[index]), this.xAt(index, count), h - 5);

    ctx.lineWidth = 2; ctx.lineJoin = 'round';
    for (const series of data.series) {
      ctx.strokeStyle = series.color; ctx.beginPath();
      let open = false;
      series.values.forEach((v, i) => {
        if (v === null || !Number.isFinite(v)) { open = false; return; }
        const x = this.xAt(i, count), y = yAt(v);
        if (open) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        open = true;
      });
      ctx.stroke();
    }

    const hover = this.hover;
    if (hover === null) { this.tooltip.classList.add('hidden'); return; }
    const x = Math.round(this.xAt(hover, count)) + 0.5;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, h - PAD.bottom); ctx.stroke();
    for (const series of data.series) {
      const v = series.values[hover];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      ctx.fillStyle = series.color; ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, yAt(v), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    const tip = this.tooltip;
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'lp-tooltip-head';
    head.textContent = `Generacja ${data.x[hover]}`;
    tip.appendChild(head);
    for (const series of data.series) {
      const v = series.values[hover];
      const row = document.createElement('div');
      row.className = 'lp-tooltip-row';
      const key = document.createElement('span');
      key.className = 'lp-key'; key.style.background = series.color;
      const value = document.createElement('strong');
      value.textContent = v === null || v === undefined || !Number.isFinite(v) ? '—' : data.format(v);
      const label = document.createElement('span');
      label.textContent = series.label;
      row.append(key, value, label);
      tip.appendChild(row);
    }
    tip.classList.remove('hidden');
    const left = x + 12 + tip.offsetWidth > w ? x - 12 - tip.offsetWidth : x + 12;
    tip.style.left = `${canvas.offsetLeft + left}px`;
    tip.style.top = `${canvas.offsetTop + PAD.top}px`;
  }
}
