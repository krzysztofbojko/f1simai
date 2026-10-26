import type { GenerationStats, DriverStats, VerdictLevel } from '../ai/LearningStats';
import type { Insight, InsightChart } from '../ai/LearningInsights';
import { stringifyLearningLog, type LearningLog } from '../ai/LearningLog';
import type { LearningReport } from '../workers/sim.worker';
import { LineChart } from './charts';
import { formatLapTime } from './format';
import { icon } from './icons';

type Tab = 'overview' | 'insights' | 'trends' | 'drivers' | 'network';
type SortKey = 'bestLap' | 'lastLap' | 'laps' | 'lapsSincePB' | 'mutationRate' | 'interventionRate' | 'paceMargin' | 'lineBest' | 'distanceToChampion' | 'crashes';

interface PanelState { open: boolean; tab: Tab; x: number; y: number; w: number; h: number }

const STORAGE_KEY = 'f1_learning_panel';
const POLL_MS = 1000;
const COLORS = { gold: '#ffd700', cyan: '#00d2be', papaya: '#ff8000', purple: '#c98bf0' };
const LEVEL_LABEL: Record<VerdictLevel, string> = { good: 'OK', warn: 'Uwaga', bad: 'Problem', info: 'Info' };
const LEVEL_MARK: Record<VerdictLevel, string> = { good: '✓', warn: '!', bad: '✕', info: 'i' };
const CHART_LABEL: Record<InsightChart, string> = { laps: 'Czas okrążenia', interventions: 'Interwencje strażnika', events: 'Zdarzenia',
  diversity: 'Różnorodność', mutation: 'Mutacja', network: 'Sieć', general: 'Cała sesja' };
const TREND_CHARTS: readonly InsightChart[] = ['laps', 'interventions', 'events', 'diversity', 'mutation'];
const SESSION_LABEL: Record<string, string> = { IDLE: 'Trening', QUALIFYING: 'Kwalifikacje', QUALI_FINISHED: 'Po kwalifikacjach',
  GRID_START: 'Start', RACING: 'Wyścig', FINISHED: 'Po wyścigu' };

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const lap = (t: number | null) => t === null ? '—' : formatLapTime(t);
const pct = (v: number | null, digits = 0) => v === null ? '—' : `${(v * 100).toFixed(digits).replace('.', ',')}%`;
const num = (v: number | null, digits = 2) => v === null ? '—' : v.toFixed(digits).replace('.', ',');
const slope = (v: number | null) => v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2).replace('.', ',')} s/gen`;
const crashTotal = (g: GenerationStats) => Object.values(g.crashes).reduce((sum, n) => sum + n, 0);

function loadState(): PanelState {
  const fallback: PanelState = { open: false, tab: 'overview', x: 80, y: 90, w: 720, h: 560 };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return saved && typeof saved === 'object' ? { ...fallback, ...saved } : fallback;
  } catch { return fallback; }
}

/**
 * Floating learning-diagnostics window: it never pauses the simulation or blocks the page.
 * While open it asks the worker for a report once a second; closed, it costs nothing.
 */
export class LearningPanel {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly status: HTMLElement;
  private state = loadState();
  private report: LearningReport | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private sort: { key: SortKey; dir: 1 | -1 } = { key: 'bestLap', dir: 1 };
  private charts: Record<string, LineChart> = {};
  private readonly insightsTab: HTMLButtonElement;
  private readonly downloadButton: HTMLButtonElement;

  constructor(private readonly fetchReport: () => Promise<LearningReport>, private readonly fetchLog: () => Promise<LearningLog>,
    private readonly onSelectDriver: (color: string) => void) {
    this.root = document.createElement('section');
    this.root.className = 'learning-panel hidden';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-labelledby', 'lp-title');
    this.root.innerHTML = `
      <header class="lp-header">
        <h2 id="lp-title">Diagnostyka uczenia</h2>
        <span class="panel-tag cyan" id="lp-status">—</span>
        <button class="f1-btn icon-btn lp-download" aria-label="Pobierz log sesji do analizy (JSON)" title="Pobierz log całej sesji do analizy, np. przez AI (JSON)">${icon('download')}</button>
        <button class="f1-btn icon-btn lp-close" aria-label="Zamknij diagnostykę (L)" title="Zamknij (L)">${icon('close')}</button>
      </header>
      <nav class="lp-tabs" role="tablist">
        <button role="tab" data-tab="overview">Przegląd</button>
        <button role="tab" data-tab="insights">Uwagi</button>
        <button role="tab" data-tab="trends">Trendy</button>
        <button role="tab" data-tab="drivers">Kierowcy</button>
        <button role="tab" data-tab="network">Sieć</button>
      </nav>
      <div class="lp-body"></div>`;
    document.getElementById('app')!.appendChild(this.root);
    this.body = this.root.querySelector('.lp-body')!;
    this.status = this.root.querySelector('#lp-status')!;
    this.insightsTab = this.root.querySelector('[data-tab="insights"]')!;
    this.downloadButton = this.root.querySelector('.lp-download')!;
    this.downloadButton.addEventListener('click', () => { void this.download(); });
    this.root.querySelector('.lp-close')!.addEventListener('click', () => this.toggle(false));
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button =>
      button.addEventListener('click', () => this.showTab(button.dataset.tab as Tab)));
    this.body.addEventListener('click', e => this.onBodyClick(e));
    this.setupDrag();
    new ResizeObserver(() => {
      if (this.root.classList.contains('hidden')) return;
      this.state.w = this.root.offsetWidth; this.state.h = this.root.offsetHeight;
      this.save();
      for (const chart of Object.values(this.charts)) chart.draw();
    }).observe(this.root);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && this.state.open) this.poll(); });
    this.applyGeometry();
    this.showTab(this.state.tab);
    if (this.state.open) this.toggle(true);
  }

  get isOpen(): boolean { return this.state.open; }

  toggle(open = !this.state.open): void {
    this.state.open = open;
    this.root.classList.toggle('hidden', !open);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (open) {
      this.applyGeometry();
      this.poll();
      this.timer = setInterval(() => this.poll(), POLL_MS);
    }
    this.save();
  }

  private save(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch { /* per-viewer convenience only */ }
  }

  /** Keep the window on screen whatever the viewport became since it was saved. */
  private applyGeometry(): void {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(Math.max(360, this.state.w), vw - 16), h = Math.min(Math.max(280, this.state.h), vh - 16);
    this.state.x = Math.max(8, Math.min(this.state.x, vw - w - 8));
    this.state.y = Math.max(8, Math.min(this.state.y, vh - h - 8));
    Object.assign(this.root.style, { left: `${this.state.x}px`, top: `${this.state.y}px`, width: `${w}px`, height: `${h}px` });
  }

  private setupDrag(): void {
    const header = this.root.querySelector<HTMLElement>('.lp-header')!;
    let start: { x: number; y: number; left: number; top: number } | null = null;
    header.addEventListener('pointerdown', e => {
      if ((e.target as HTMLElement).closest('button')) return;
      start = { x: e.clientX, y: e.clientY, left: this.state.x, top: this.state.y };
      header.setPointerCapture(e.pointerId);
    });
    header.addEventListener('pointermove', e => {
      if (!start) return;
      this.state.x = start.left + e.clientX - start.x;
      this.state.y = start.top + e.clientY - start.y;
      this.applyGeometry();
    });
    const end = () => { if (start) { start = null; this.save(); } };
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
  }

  private async poll(): Promise<void> {
    if (this.inFlight || document.hidden || !this.state.open) return;
    this.inFlight = true;
    try {
      this.report = await this.fetchReport();
      this.render();
    } catch {
      this.status.textContent = 'brak danych z symulacji';
    } finally {
      this.inFlight = false;
    }
  }

  private async download(): Promise<void> {
    if (this.downloadButton.disabled) return;
    this.downloadButton.disabled = true;
    this.status.textContent = 'przygotowuję log…';
    try {
      const log = await this.fetchLog();
      const blob = new Blob([stringifyLearningLog(log)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `f1-diagnostyka-uczenia-gen${log.generation}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.status.textContent = `log: ${log.generations.length} generacji`;
    } catch {
      this.status.textContent = 'nie udało się pobrać logu';
    } finally {
      this.downloadButton.disabled = false;
    }
  }

  private showTab(tab: Tab): void {
    this.state.tab = tab;
    this.save();
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => {
      const active = button.dataset.tab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    this.charts = {};
    this.body.innerHTML = tab === 'trends' ? this.trendsSkeleton() : '';
    if (tab === 'trends') {
      this.body.querySelectorAll<HTMLCanvasElement>('canvas[data-chart]').forEach(canvas => {
        this.charts[canvas.dataset.chart!] = new LineChart(canvas, 'Wykres pojawi się po 2 zakończonych generacjach');
      });
    }
    this.render();
  }

  private render(): void {
    const report = this.report;
    if (!report) { if (this.state.tab !== 'trends') this.body.innerHTML = '<p class="lp-empty">Pobieranie danych…</p>'; return; }
    if (!this.downloadButton.disabled) this.status.textContent = `${SESSION_LABEL[report.sessionState] ?? report.sessionState} · gen ${report.generation}`;
    this.renderInsightsTab(report.insights);
    if (this.state.tab === 'overview') this.body.innerHTML = this.overviewHtml(report);
    else if (this.state.tab === 'insights') this.body.innerHTML = this.insightsHtml(report.insights);
    else if (this.state.tab === 'trends') this.renderTrends(report);
    else if (this.state.tab === 'drivers') this.body.innerHTML = this.driversHtml(report);
    else this.body.innerHTML = this.networkHtml(report);
  }

  private overviewHtml(r: LearningReport): string {
    const c = r.current, t = r.trend;
    const verdicts = r.verdicts.map(v => `
      <div class="lp-verdict ${v.level}">
        <span class="lp-verdict-mark" aria-hidden="true">${LEVEL_MARK[v.level]}</span>
        <div><strong>${LEVEL_LABEL[v.level]}: ${escapeHtml(v.title)}</strong><p>${escapeHtml(v.detail)}</p></div>
      </div>`).join('');
    const tile = (label: string, value: string, note = '', hint = '') =>
      `<div class="lp-tile"${hint ? ` title="${escapeHtml(hint)}"` : ''}><span class="lp-tile-label">${label}</span><strong>${value}</strong>${note ? `<span class="lp-tile-note">${note}</span>` : ''}</div>`;
    const lastGen = r.history[r.history.length - 1];
    const crashes = c.crashes;
    const raceNote = r.raceMode ? '<p class="lp-note">Trwa sesja wyścigowa: ewolucja jest wstrzymana, liczniki interwencji i wypadków dalej rosną.</p>' : '';
    return `
      ${raceNote}
      <div class="lp-verdicts">${verdicts}</div>
      <div class="lp-tiles">
        ${tile('Rekord sesji', lap(r.sessionBest), t.gensSinceRecord ? `${t.gensSinceRecord} gen. bez rekordu` : 'świeży rekord')}
        ${tile('Trend mediany', slope(t.medianSlope), `best ${slope(t.bestSlope)}`, 'Nachylenie prostej dopasowanej do ostatnich 10 generacji; ujemne = szybciej')}
        ${tile('Interwencje strażnika', pct(c.interventionRate, 1), lastGen ? `poprz. gen. ${pct(lastGen.interventionRate, 1)}` : '', 'Udział kroków, w których ekspert poprawił sieć. Spada = sieć jedzie sama coraz lepiej')}
        ${tile('Skuteczność eksploracji', pct(t.trialSuccess), `z ${t.trials} zakończonych prób`, 'Mocniejsza mutacja po 8 okrążeniach bez rekordu życiowego')}
        ${tile('Różnorodność', num(c.diversity, 4), `mutacja śr. ${num(c.meanMutationRate, 3)}`, 'Średnia odległość (RMS wag) mózgów zespołów od mózgu mistrza')}
        ${tile('Wyspy', r.islands.count ? `${r.islands.count} × ${Math.round(r.islands.stepsPerSecond / 1000)}k kr/s` : 'wyłączone', `adopcji: ${r.islands.adopted}`)}
      </div>
      <h3 class="lp-subhead">${r.raceMode ? `Sesja wyścigowa <span>od generacji ${c.generation}</span>` : `Bieżąca generacja ${c.generation} <span>${Math.round(c.simSeconds)} s symulacji</span>`}</h3>
      <dl class="lp-facts">
        <div><dt>Czyste okrążenia</dt><dd>${c.cleanLaps}${c.yellowLaps ? ` (${c.yellowLaps} pod żółtą)` : ''}</dd></div>
        <div><dt>Skażone okrążenia</dt><dd>${c.compromisedLaps}</dd></div>
        <div><dt>Najlepsze / mediana</dt><dd>${lap(c.bestLap)} / ${lap(c.medianLap)}</dd></div>
        <div><dt>Rekordy życiowe</dt><dd>${c.personalBests}</dd></div>
        <div><dt>Cofnięcia mózgu</dt><dd>${c.reverts}</dd></div>
        <div><dt>Próby eksploracji</dt><dd>${c.trialsStarted} (✓ ${c.trialsWon} / ✕ ${c.trialsLost})</dd></div>
        <div><dt>Wypadki</dt><dd>${crashTotal(c)} — bariera ${crashes.barrier}, auto ${crashes.car}, utknął ${crashes.stuck}, pod prąd ${crashes['wrong-way']}</dd></div>
        <div><dt>Korekty online (DAgger)</dt><dd>${c.onlineTrainSteps}</dd></div>
        <div><dt>Adopcje z wysp</dt><dd>${c.islandAdoptions}</dd></div>
      </dl>
      <h3 class="lp-subhead">Przyczyny interwencji <span>udział kroków AI</span></h3>
      <dl class="lp-facts">
        <div><dt>Korytarz skrętu</dt><dd>${pct(c.causes.steer, 1)}</dd></div>
        <div><dt>Strażnik przejmuje</dt><dd>${pct(c.causes.guard, 1)}</dd></div>
        <div><dt>Hamowanie awaryjne</dt><dd>${pct(c.causes.brake, 1)}</dd></div>
        <div><dt>Asysta ruszania</dt><dd>${pct(c.causes.launch, 1)}</dd></div>
        <div><dt>Limit gazu przy ścianie</dt><dd>${pct(c.causes.clearance, 1)}</dd></div>
      </dl>`;
  }

  /** Tab label: how many notes need attention, coloured by the most serious one. */
  private renderInsightsTab(insights: readonly Insight[]): void {
    const serious = insights.filter(i => i.level === 'bad' || i.level === 'warn');
    this.insightsTab.textContent = serious.length ? `Uwagi (${serious.length})` : 'Uwagi';
    this.insightsTab.dataset.level = serious[0]?.level ?? '';
  }

  private insightHtml(insight: Insight, showChart: boolean): string {
    const target = TREND_CHARTS.includes(insight.chart) || insight.chart === 'network' ? insight.chart : null;
    const meta = `od gen. ${insight.since}${showChart ? ` · ${CHART_LABEL[insight.chart]}` : ''}`;
    const inner = `
        <span class="lp-verdict-mark" aria-hidden="true">${LEVEL_MARK[insight.level]}</span>
        <div><strong>${escapeHtml(insight.title)}</strong> <span class="lp-insight-meta">${meta}</span><p>${escapeHtml(insight.detail)}</p></div>`;
    return showChart && target
      ? `<button class="lp-verdict lp-insight ${insight.level}" data-goto="${target}" title="Pokaż wykres: ${CHART_LABEL[insight.chart]}">${inner}</button>`
      : `<div class="lp-verdict ${insight.level}">${inner}</div>`;
  }

  private insightsHtml(insights: readonly Insight[]): string {
    return `<p class="lp-note">Automatyczne uwagi do wykresów: od kiedy trwa objaw i co można zrobić. Kliknij uwagę, aby zobaczyć jej wykres.</p>
      <div class="lp-verdicts">${insights.map(i => this.insightHtml(i, true)).join('')}</div>`;
  }

  private trendsSkeleton(): string {
    const legend = (items: [string, string][]) => `<div class="lp-legend">${items.map(([label, color]) =>
      `<span><span class="lp-key" style="background:${color}"></span>${label}</span>`).join('')}</div>`;
    const card = (id: string, title: string, items: [string, string][]) =>
      `<figure class="lp-chart" data-chart-card="${id}"><figcaption>${title}</figcaption>${items.length > 1 ? legend(items) : ''}<div class="lp-canvas-wrap"><canvas data-chart="${id}"></canvas></div><div class="lp-verdicts lp-chart-notes" data-notes="${id}"></div></figure>`;
    return `<div class="lp-charts">
      ${card('laps', 'Czas okrążenia po generacjach', [['Najlepsze w gen.', COLORS.gold], ['Mediana czystych', COLORS.cyan], ['Rekord sesji', COLORS.purple]])}
      ${card('interventions', 'Interwencje strażnika (udział kroków)', [['Wszystkie', COLORS.gold], ['Korytarz skrętu', COLORS.cyan], ['Strażnik przejmuje', COLORS.papaya], ['Hamowanie awaryjne', COLORS.purple]])}
      ${card('events', 'Zdarzenia w generacji', [['Rekordy życiowe', COLORS.cyan], ['Cofnięcia mózgu', COLORS.papaya], ['Wypadki', COLORS.purple], ['Adopcje z wysp', COLORS.gold]])}
      ${card('diversity', 'Różnorodność populacji (RMS wag od mistrza)', [])}
      ${card('mutation', 'Średnia stopa mutacji zespołów', [])}
    </div>`;
  }

  private renderTrends(r: LearningReport): void {
    const h = r.history, x = h.map(g => g.generation);
    const set = (id: string, series: { label: string; color: string; values: (number | null)[] }[], format: (v: number) => string, yMin?: number) =>
      this.charts[id]?.set({ x, series, format, yMin });
    const secs = (v: number) => `${v.toFixed(1).replace('.', ',')}s`;
    const share = (v: number) => `${(v * 100).toFixed(0)}%`;
    const count = (v: number) => v.toFixed(0);
    set('laps', [
      { label: 'Najlepsze w gen.', color: COLORS.gold, values: h.map(g => g.bestLap) },
      { label: 'Mediana czystych', color: COLORS.cyan, values: h.map(g => g.medianLap) },
      { label: 'Rekord sesji', color: COLORS.purple, values: h.map(g => g.sessionBest) },
    ], secs);
    set('interventions', [
      { label: 'Wszystkie', color: COLORS.gold, values: h.map(g => g.interventionRate) },
      { label: 'Korytarz skrętu', color: COLORS.cyan, values: h.map(g => g.interventionRate === null ? null : g.causes.steer) },
      { label: 'Strażnik przejmuje', color: COLORS.papaya, values: h.map(g => g.interventionRate === null ? null : g.causes.guard) },
      { label: 'Hamowanie awaryjne', color: COLORS.purple, values: h.map(g => g.interventionRate === null ? null : g.causes.brake) },
    ], share, 0);
    set('events', [
      { label: 'Rekordy życiowe', color: COLORS.cyan, values: h.map(g => g.personalBests) },
      { label: 'Cofnięcia mózgu', color: COLORS.papaya, values: h.map(g => g.reverts) },
      { label: 'Wypadki', color: COLORS.purple, values: h.map(crashTotal) },
      { label: 'Adopcje z wysp', color: COLORS.gold, values: h.map(g => g.islandAdoptions) },
    ], count, 0);
    set('diversity', [{ label: 'Różnorodność', color: COLORS.cyan, values: h.map(g => g.diversity) }], v => v.toFixed(3), 0);
    set('mutation', [{ label: 'Stopa mutacji', color: COLORS.papaya, values: h.map(g => g.meanMutationRate) }], v => v.toFixed(3), 0);
    this.body.querySelectorAll<HTMLElement>('[data-notes]').forEach(el => {
      const notes = r.insights.filter(i => i.chart === el.dataset.notes).slice(0, 2);
      const html = notes.map(i => this.insightHtml(i, false)).join('');
      if (el.innerHTML !== html) el.innerHTML = html;
    });
  }

  private driversHtml(r: LearningReport): string {
    const { key, dir } = this.sort;
    const rows = [...r.drivers].sort((a, b) => {
      const va = a[key], vb = b[key];
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * dir;
    });
    const head = (label: string, sortKey: SortKey, hint: string) =>
      `<th><button data-sort="${sortKey}" title="${hint}" class="${key === sortKey ? 'sorted' : ''}">${label}${key === sortKey ? (dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`;
    const row = (d: DriverStats) => `
      <tr data-color="${escapeHtml(d.color)}" class="${d.alive ? '' : 'dead'}">
        <td class="lp-driver"><span class="team-dot" style="background-color:${escapeHtml(d.color)}"></span>${escapeHtml(d.name)}${d.champion ? ' <span class="lp-badge gold">mistrz</span>' : ''}${d.exploring ? ' <span class="lp-badge cyan">próba</span>' : ''}</td>
        <td>${lap(d.bestLap)}</td><td>${lap(d.lastLap)}</td><td>${d.laps}</td><td>${d.lapsSincePB}</td>
        <td>${num(d.mutationRate, 3)}</td><td>${pct(d.interventionRate, 1)}</td><td>${num(d.paceMargin, 3)}</td>
        <td>${lap(d.lineBest)}</td><td>${num(d.distanceToChampion, 4)}</td><td>${d.crashes}</td>
      </tr>`;
    return `<p class="lp-note">Kliknij wiersz, aby śledzić kierowcę na torze.</p>
      <div class="lp-table-wrap"><table class="lp-table">
        <thead><tr><th>Kierowca</th>
          ${head('Best', 'bestLap', 'Rekord życiowy (czyste okrążenie)')}
          ${head('Last', 'lastLap', 'Ostatnie okrążenie')}
          ${head('Okr.', 'laps', 'Okrążenia w sesji')}
          ${head('Od PB', 'lapsSincePB', 'Czyste okrążenia od ostatniego rekordu życiowego (8 = próba eksploracji)')}
          ${head('Mutacja', 'mutationRate', 'Bieżąca stopa mutacji zespołu (wyżarzanie)')}
          ${head('Interw.', 'interventionRate', 'Udział kroków poprawionych przez strażnika')}
          ${head('Tempo', 'paceMargin', 'Margines przyczepności z wyszukiwania tempa')}
          ${head('Linia', 'lineBest', 'Najlepszy czas sieci linii jazdy')}
          ${head('Δ mistrz', 'distanceToChampion', 'Odległość wag od mózgu mistrza (RMS)')}
          ${head('Wypadki', 'crashes', 'Wypadki w sesji')}
        </tr></thead>
        <tbody>${rows.map(row).join('')}</tbody>
      </table></div>`;
  }

  private networkHtml(r: LearningReport): string {
    const n = r.network;
    if (!n) return '<p class="lp-empty">Mistrz sesji wyłoni się po pierwszym okrążeniu lub postępie na torze.</p>';
    const bar = (value: number, max: number, cls: string) =>
      `<span class="lp-bar"><span class="${cls}" style="width:${Math.min(100, value / max * 100).toFixed(1)}%"></span></span>`;
    const maxAbs = Math.max(...n.layers.map(l => l.meanAbsWeight), 1e-6);
    const layers = n.layers.map((l, i) => `
      <tr>
        <td>${i === n.layers.length - 1 ? 'Wyjście' : `Ukryta ${i + 1}`}</td>
        <td>${l.inputs} → ${l.outputs}</td>
        <td>${bar(l.meanAbsWeight, maxAbs, 'cyan')} ${num(l.meanAbsWeight, 3)}</td>
        <td>${bar(l.saturation, 1, l.saturation > 0.5 ? 'papaya' : 'gold')} ${pct(l.saturation)}</td>
      </tr>`).join('');
    const saturated = n.layers.slice(0, -1).some(l => l.saturation > 0.5);
    const notes = r.insights.filter(i => i.chart === 'network');
    return `
      ${notes.length ? `<div class="lp-verdicts">${notes.map(i => this.insightHtml(i, false)).join('')}</div>` : ''}
      <div class="lp-tiles">
        <div class="lp-tile"><span class="lp-tile-label">Mistrz</span><strong><span class="team-dot" style="background-color:${escapeHtml(n.color)}"></span>${escapeHtml(n.driver)}</strong></div>
        <div class="lp-tile"><span class="lp-tile-label">Topologia</span><strong>${n.layerSizes.join('-')}</strong></div>
        <div class="lp-tile"><span class="lp-tile-label">Parametry</span><strong>${n.parameters.toLocaleString('pl-PL')}</strong></div>
      </div>
      <div class="lp-table-wrap"><table class="lp-table">
        <thead><tr><th>Warstwa</th><th>Wymiar</th><th>Średnie |w|</th><th>Nasycenie tanh</th></tr></thead>
        <tbody>${layers}</tbody>
      </table></div>
      <p class="lp-note">Nasycenie: odsetek neuronów z |aktywacją| &gt; 0,95 w ostatnim kroku jazdy mistrza. ${saturated
        ? 'Ponad połowa neuronów ukrytych jest nasycona: gradient korekt online prawie nie płynie, a mutacje słabo zmieniają zachowanie.'
        : 'Warstwy ukryte pracują w zakresie liniowym — sieć ma jeszcze pole do nauki.'}</p>`;
  }

  private onBodyClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const goto = target.closest<HTMLElement>('[data-goto]')?.dataset.goto;
    if (goto) {
      this.showTab(goto === 'network' ? 'network' : 'trends');
      this.body.querySelector(`[data-chart-card="${goto}"]`)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const sortButton = target.closest<HTMLButtonElement>('[data-sort]');
    if (sortButton) {
      const key = sortButton.dataset.sort as SortKey;
      this.sort = { key, dir: this.sort.key === key ? (this.sort.dir === 1 ? -1 : 1) : 1 };
      this.render();
      return;
    }
    const row = target.closest<HTMLElement>('tr[data-color]');
    if (row?.dataset.color) this.onSelectDriver(row.dataset.color);
  }
}
