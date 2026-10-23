import type { Car } from '../physics/Car';
import type { Population } from '../ai/Population';
import { COMPOUND_SPECS } from '../physics/Tyres';
import type { QualifyingSnapshot } from '../workers/sim.worker';
import type { SessionView } from './SnapshotSync';
import { formatLapTime } from './format';

/** What the race screens read from the page and what they may ask it to do. */
export interface RaceUIHost {
  readonly session: SessionView;
  readonly population: Population;
  readonly playerCar: Car | null;
  readonly selectedCar: Car | null;
  readonly isPlayerDriving: boolean;
  /** Starts the race on the grid of the qualifying that just ended. */
  startQualifiedRace(): void;
}

/**
 * Race screens of the page: the session banners and status, the leaderboard (training, qualifying
 * and race), the qualifying result with its countdown to the start, and the podium.
 */
export class RaceUI {
  static readonly LEADERBOARD_ROWS = 10;
  private hasShownQualiModal = false;
  private hasShownPodiumModal = false;
  private qualiCountdownTimer: number | null = null;

  constructor(private readonly host: RaceUIHost) {
    document.getElementById('btn-quali-start-race')?.addEventListener('click', () => {
      this.startRaceFromQualifying();
    });
    document.getElementById('btn-quali-hold')?.addEventListener('click', () => {
      this.clearQualiCountdown();
      const label = document.getElementById('quali-start-label');
      if (label) label.textContent = 'Start wyścigu';
    });
    document.getElementById('btn-close-podium')?.addEventListener('click', () => {
      document.getElementById('podium-modal')?.classList.add('hidden');
    });
  }

  private get session(): SessionView { return this.host.session; }

  /** A new session starts: its results will be shown again when it ends. */
  sessionStarted(): void {
    this.hasShownPodiumModal = false;
    this.hasShownQualiModal = false;
    this.clearQualiCountdown();
    document.getElementById('quali-modal')?.classList.add('hidden');
  }

  /** Back to training: no countdown, no result windows. */
  sessionStopped(): void {
    this.clearQualiCountdown();
    document.getElementById('quali-modal')?.classList.add('hidden');
    document.getElementById('podium-modal')?.classList.add('hidden');
  }

  /** After each snapshot: the end of qualifying or of the race opens its result once. */
  onSnapshot(snapshot: { raceState: string; qualifying: QualifyingSnapshot | null; raceStandings: SessionView['standings'] }): void {
    if (snapshot.raceState === 'QUALI_FINISHED' && snapshot.qualifying && !this.hasShownQualiModal) {
      this.hasShownQualiModal = true;
      this.showQualifyingModal(snapshot.qualifying);
    }
    if (snapshot.raceState === 'FINISHED' && !this.hasShownPodiumModal) {
      this.hasShownPodiumModal = true;
      this.showPodiumModal(snapshot.raceStandings);
    }
  }

  /** Session banners, race status and the leaderboard, every frame. */
  update(): void {
    // Race Mode HUD elements
    const raceTag = document.getElementById('race-status-tag');
    const inQualifying = this.session.raceState === 'QUALIFYING' || this.session.raceState === 'QUALI_FINISHED';
    document.getElementById('quali-info-banner')?.classList.toggle('hidden', !inQualifying);
    document.getElementById('race-info-banner')?.classList.toggle('hidden', inQualifying || this.session.raceState === 'IDLE');
    if (inQualifying) this.updateQualifyingBanner();
    if (raceTag) {
      if (this.session.raceState === 'QUALIFYING') {
        const q = this.session.qualifying;
        raceTag.textContent = q ? `KWALIFIKACJE Q${q.session + 1}${q.phase === 'break' ? ' (PRZERWA)' : q.phase === 'overtime' ? ' (FLAGA)' : ''}` : 'KWALIFIKACJE';
        raceTag.className = 'panel-tag';
        raceTag.style.background = '#b138dd';
      } else if (this.session.raceState === 'QUALI_FINISHED') {
        raceTag.textContent = 'KWALIFIKACJE — WYNIKI';
        raceTag.className = 'panel-tag';
        raceTag.style.background = '#b138dd';
      } else if (this.session.raceState === 'GRID_START') {
        raceTag.textContent = 'START (GRID)';
        raceTag.className = 'panel-tag';
        raceTag.style.background = '#e10600';
      } else if (this.session.raceState === 'RACING') {
        raceTag.textContent = 'WYŚCIG TRWA';
        raceTag.className = 'panel-tag cyan';
        raceTag.style.background = '';
      } else if (this.session.raceState === 'FINISHED') {
        raceTag.textContent = 'META (FLAGA)';
        raceTag.className = 'panel-tag';
        raceTag.style.background = '#a855f7';
      } else {
        raceTag.textContent = 'TRENING';
        raceTag.className = 'panel-tag gold';
        raceTag.style.background = '';
      }
    }

    const raceLapCounter = document.getElementById('race-lap-counter');
    if (raceLapCounter) {
      raceLapCounter.textContent = `${this.session.currentLap} / ${this.session.totalLaps}`;
    }
    const raceLeaderEl = document.getElementById('race-leader-name');
    if (raceLeaderEl) {
      const topCar = this.session.standings?.[0];
      raceLeaderEl.textContent = topCar ? topCar.driverName.split(' ')[0] : '-';
    }
    const racePitStatusEl = document.getElementById('race-pit-status');
    const pitPlayerBtn = document.getElementById('btn-pit-player');
    const playerControlledCar = (this.host.isPlayerDriving ? (this.host.population.cars.find(c => c.isManual) || this.host.playerCar) : null);
    if (playerControlledCar) {
      if (playerControlledCar.isPitting) {
        if (racePitStatusEl) racePitStatusEl.textContent = 'W BOKSIE!';
        if (pitPlayerBtn) pitPlayerBtn.classList.add('active');
      } else if (playerControlledCar.wantsToPit) {
        if (racePitStatusEl) racePitStatusEl.textContent = 'ZJAZD [P]';
        if (pitPlayerBtn) pitPlayerBtn.classList.add('active');
      } else {
        if (racePitStatusEl) racePitStatusEl.textContent = 'OTWARTE';
        if (pitPlayerBtn) pitPlayerBtn.classList.remove('active');
      }
    }

    // Leaderboard: top 10 of the field
    const leaderboardContainer = document.getElementById('leaderboard-list')!;
    const standings = (this.session.raceState !== 'IDLE' && this.session.standings.length > 0)
      ? this.session.standings.map(rs => {
          const matchingEntry = (this.session.teamStandings || []).find(s => s.carColor === rs.carColor);
          const car = this.host.population.cars.find(c => c.color === rs.carColor);
          return {
            id: rs.rank,
            rank: rs.rank,
            lapTime: rs.bestLap || 0,
            lastLapTime: rs.lastLap ?? (matchingEntry?.lastLapTime ?? (car ? car.lastLapTime : null)),
            avgSpeed: matchingEntry ? matchingEntry.avgSpeed : (car ? Math.round(car.speedKmh) : 0),
            topSpeed: matchingEntry ? matchingEntry.topSpeed : (car ? Math.round(car.maxSpeedInLap * 3.6) : 0),
            fuelRemaining: car ? Math.round(car.fuelKg * 10) / 10 : (matchingEntry ? matchingEntry.fuelRemaining : 0),
            driverName: rs.driverName,
            carColor: rs.carColor,
            generation: this.host.population.generation,
            isPlayer: rs.isPlayer,
            hasFinishedLap: rs.bestLap !== null,
            bestLapPressure: matchingEntry?.bestLapPressure ?? car?.bestLapPressure ?? 0,
            gap: rs.gap,
            gapToLeader: rs.gapToLeader || rs.gap || '—',
            gapToPrevious: rs.gapToPrevious || '—',
          };
        })
      : ((this.session.teamStandings && this.session.teamStandings.length > 0)
          ? this.session.teamStandings.map(s => ({ ...s }))
          : this.host.population.teamStandings.map(s => ({ ...s })));

    // In training mode, sort standings by immutable personal best lap time ascending (P1 on top)
    if (this.session.raceState === 'IDLE') {
      standings.sort((a, b) => {
        const bestA = this.getDriverTrueBest(a.carColor, a.lapTime, a.hasFinishedLap);
        const bestB = this.getDriverTrueBest(b.carColor, b.lapTime, b.hasFinishedLap);
        if (bestA !== null && bestB !== null) return bestA - bestB;
        if (bestA !== null) return -1;
        if (bestB !== null) return 1;
        return 0;
      });
      standings.forEach((entry, idx) => {
        entry.rank = idx + 1;
      });
    }

    // Determine overall fastest lap in current session for calculating P1 / deltas
    const sessionBests = standings
      .map(e => this.getDriverTrueBest(e.carColor, e.lapTime, e.hasFinishedLap))
      .filter((t): t is number => typeof t === 'number' && t > 0);
    const sessionFastestLap = sessionBests.length > 0 ? Math.min(...sessionBests) : null;

    // Top 10 of the field; a followed driver or the player outside it is appended below a divider.
    const topRows = standings.slice(0, RaceUI.LEADERBOARD_ROWS);
    const extraRows = standings.slice(RaceUI.LEADERBOARD_ROWS).filter(e =>
      e.isPlayer || (this.host.selectedCar?.color === e.carColor));
    const qualiBoard = (this.session.raceState === 'QUALIFYING' || this.session.raceState === 'QUALI_FINISHED') ? this.session.qualifying : null;
    const leaderboardHtml = qualiBoard ? this.renderQualifyingRows(qualiBoard) : [...topRows, ...extraRows]
      .map((entry, rowIndex) => {
        const divider = rowIndex === topRows.length
          ? `<div class="leaderboard-divider" data-car-color="divider">poza TOP ${RaceUI.LEADERBOARD_ROWS} (${standings.length} aut)</div>` : '';
        const car = this.host.population.cars.find(c => c.color === entry.carColor)
          || (this.host.playerCar && this.host.playerCar.color === entry.carColor ? this.host.playerCar : null);
        const isSelected = this.host.selectedCar && (
          (entry.isPlayer && this.host.selectedCar === this.host.playerCar) ||
          (!entry.isPlayer && this.host.selectedCar === car)
        );

        const bestTimeVal = this.getDriverTrueBest(entry.carColor, entry.lapTime, entry.hasFinishedLap);
        const teamRec = this.host.population.teamRecords.find(t => t.color === entry.carColor);
        const bestPressure = entry.bestLapPressure ?? teamRec?.bestLapPressure ?? car?.bestLapPressure ?? 0;
        const pressureBadge = bestTimeVal !== null ? `<span class="time-delta" title="Presja podczas rekordowego okrążenia">P ${bestPressure > 0 ? '+' : ''}${bestPressure}</span>` : '';
        const lastTimeVal = (entry as any).lastLapTime ?? teamRec?.lastLapTime ?? car?.lastLapTime ?? null;
        const lastTimeStr = (lastTimeVal && lastTimeVal > 0) ? formatLapTime(lastTimeVal) : '--:--.---';

        // 1. Czas najlepszy (Personal Best) lub pozycja/strata w wyścigu
        const isRace = this.session.raceState !== 'IDLE';
        let bestTimeStr: string;
        let deltaStr: string;
        let gapToLeader = '—';
        let gapToPrevious = '—';

        if (isRace) {
          const rs = this.session.standings.find(s => s.carColor === entry.carColor);
          bestTimeStr = bestTimeVal ? formatLapTime(bestTimeVal) : '--:--.---';
          gapToLeader = rs?.gapToLeader || rs?.gap || (entry as any).gapToLeader || '—';
          gapToPrevious = rs?.gapToPrevious || (entry as any).gapToPrevious || '—';
          deltaStr = rs ? rs.gap : '';
        } else if (bestTimeVal !== null) {
          bestTimeStr = formatLapTime(bestTimeVal);
          if (sessionFastestLap && Math.abs(bestTimeVal - sessionFastestLap) < 0.001) {
            deltaStr = 'P1';
          } else if (sessionFastestLap && bestTimeVal > sessionFastestLap) {
            deltaStr = `+${(bestTimeVal - sessionFastestLap).toFixed(3)}s`;
          } else {
            deltaStr = '';
          }
        } else {
          bestTimeStr = '--:--.---';
          deltaStr = '';
        }

        // 2. Czas aktualny (bieżący przejazd)
        let currentTimeStr: string;
        if (car && car.isPitting) {
          currentTimeStr = `PIT (${car.pitTimer.toFixed(1)}s)`;
        } else if (car && !car.isAlive) {
          if (this.session.raceState !== 'IDLE') {
            currentTimeStr = '<span class="time-dnf">DNF</span>';
          } else {
            currentTimeStr = 'PIT (RESPAWN)';
          }
        } else if (car && car.wantsToPit) {
          currentTimeStr = `${formatLapTime(car.lapTime)} [BOX]`;
        } else if (car) {
          currentTimeStr = formatLapTime(car.lapTime);
        } else {
          currentTimeStr = '--:--.---';
        }

        // 2b. Checkpoint Delta Badge (F1 broadcast style)
        let cpBadgeHtml = '';
        const targetCar = entry.isPlayer ? this.host.playerCar : car;
        if (targetCar && targetCar.isAlive && targetCar.lastCheckpointDelta) {
          const cp = targetCar.lastCheckpointDelta;
          const sign = cp.delta <= 0 ? '-' : '+';
          const valStr = `${sign}${Math.abs(cp.delta).toFixed(3)}s`;
          const gateLabel = `CP${cp.gateIndex + 1}`;
          let colorClass = 'cp-red';
          if (cp.isPurple) {
            colorClass = 'cp-purple';
          } else if (cp.delta <= 0) {
            colorClass = 'cp-green';
          }
          cpBadgeHtml = `<span class="cp-delta-pill ${colorClass}" title="${cp.gateName}: split ${formatLapTime(cp.splitTime)}">${gateLabel} ${valStr}</span>`;
        }

        const rankClass = entry.rank <= 3 ? `rank-${entry.rank}` : '';
        const dnfClass = (car && !car.isAlive) ? 'dnf-item' : '';
        const selectedClass = isSelected ? 'selected-item' : '';

        return `${divider}
          <div class="leaderboard-item ${rankClass} ${dnfClass} ${selectedClass}" data-car-color="${entry.carColor}" data-is-player="${entry.isPlayer ? 'true' : 'false'}">
            <div class="leaderboard-left">
              <div class="rank-badge">${entry.rank}</div>
              <div class="driver-details">
                <div class="driver-title">
                  <span class="team-dot" style="background-color: ${entry.carColor}"></span>
                  <span>${entry.driverName}</span>
                  ${car && this.session.raceState !== 'IDLE' ? `<span class="tyre-badge" style="--tyre-color: ${COMPOUND_SPECS[car.tyreCompound].color}" title="Opony: ${COMPOUND_SPECS[car.tyreCompound].label}">${COMPOUND_SPECS[car.tyreCompound].letter}</span>` : ''}
                </div>
                <div class="driver-stats-row">
                  <span class="avg-speed-badge">Śr: ${entry.avgSpeed} km/h</span>
                  <span>Vmax: ${entry.topSpeed} km/h</span>
                  <span title="Paliwo">${entry.fuelRemaining} kg</span>
                  ${car && car.pitStopsCount > 0 ? `<span class="stat-pit">PIT ×${car.pitStopsCount}</span>` : ''}
                  ${this.session.raceState !== 'IDLE' && car ? `<span>L${car.raceLapsCompleted}/${this.session.totalLaps}</span>` : (car && car.currentLap > 0 ? `<span>L${car.currentLap}</span>` : '')}
                  ${car && !car.isAlive && this.session.raceState !== 'IDLE' ? '<span class="time-dnf">DNF (rozbity)</span>' : ''}
                  ${car ? `<span title="Agresja hamowania">Ham. ${Math.round(car.brakingAggression * 100)}%</span>` : ''}
                </div>
              </div>
            </div>
            <div class="time-details">
              ${isRace ? `
                <div class="time-row">
                  <span class="time-lbl">DO LIDERA</span>
                  <span class="gap-leader-val">${gapToLeader}</span>
                </div>
                <div class="time-row">
                  <span class="time-lbl">DO POPRZ.</span>
                  <span class="gap-prev-val">${gapToPrevious}</span>
                </div>
                <div class="time-row">
                  <span class="time-lbl">BEST</span>
                  <span class="time-main">${bestTimeStr}</span>${pressureBadge}
                </div>
                <div class="time-row">
                  <span class="time-lbl">LAST</span>
                  <span class="time-last-val">${lastTimeStr}</span>
                </div>
                <div class="time-row">
                  <span class="time-lbl">POZA TOREM</span>
                  <span class="time-last-val" title="Wyjazdy wszystkimi czterema kołami poza asfalt">${targetCar ? targetCar.trackLimitExits : 0}×</span>
                </div>
                <div class="time-row">
                  <span class="time-lbl">TERAZ</span>
                  <span class="time-curr-val">${currentTimeStr}</span>
                  ${cpBadgeHtml}
                </div>
              ` : `
                <div class="time-row">
                  <span class="time-lbl">BEST</span>
                  <span class="time-main">${bestTimeStr}</span>${pressureBadge}
                  ${deltaStr ? `<span class="time-delta">${deltaStr}</span>` : ''}
                </div>
                <div class="time-row">
                  <span class="time-lbl">LAST</span>
                  <span class="time-last-val">${lastTimeStr}</span>
                </div>

              `}
            </div>
          </div>
        `;
      })
      .join('');
    // Keep each driver's row stable while live timings and ranking change.
    const template = document.createElement('template');
    template.innerHTML = leaderboardHtml;
    const existingRows = new Map(Array.from(leaderboardContainer.children).map(row => [row.getAttribute('data-car-color'), row]));
    Array.from(template.content.children).forEach((freshRow, index) => {
      const row = existingRows.get(freshRow.getAttribute('data-car-color')) || freshRow;
      if (row !== freshRow) {
        row.className = freshRow.className;
        if (row.innerHTML !== freshRow.innerHTML) row.innerHTML = freshRow.innerHTML;
        row.setAttribute('data-is-player', freshRow.getAttribute('data-is-player') || 'false');
      }
      if (leaderboardContainer.children[index] !== row) leaderboardContainer.insertBefore(row, leaderboardContainer.children[index] || null);
      existingRows.delete(freshRow.getAttribute('data-car-color'));
    });
    existingRows.forEach(row => row.remove());

  }

  /** Race start after qualifying: the grid follows the qualifying classification. */
  private startRaceFromQualifying(): void {
    this.clearQualiCountdown();
    document.getElementById('quali-modal')?.classList.add('hidden');
    this.host.startQualifiedRace();
  }

  clearQualiCountdown(): void {
    if (this.qualiCountdownTimer !== null) window.clearInterval(this.qualiCountdownTimer);
    this.qualiCountdownTimer = null;
  }

  /** Session clock, leader and the drivers currently in the elimination zone. */
  private updateQualifyingBanner(): void {
    const q = this.session.qualifying;
    if (!q) return;
    const session = Math.min(q.session, 2);
    const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const set = (id: string, text: string) => { const el = document.getElementById(id); if (el && el.textContent !== text) el.textContent = text; };
    set('quali-session', `Q${session + 1}`);
    set('quali-time-left', q.phase === 'session' ? clock(q.timeLeft) : q.phase === 'overtime' ? 'FLAGA' : q.phase === 'break' ? `PRZERWA ${Math.ceil(q.timeLeft)} s` : 'KONIEC');
    const leader = q.standings[0];
    const leaderTime = leader?.times[session] ?? null;
    set('quali-leader', leader && leaderTime !== null ? `${leader.driverName.split(' ').slice(-1)[0]} ${formatLapTime(leaderTime)}` : '-');
    const active = q.standings.filter(r => r.eliminatedIn === 0);
    const cut = active.length - q.eliminatedAfter;
    let zone = '';
    if (q.phase !== 'finished' && session < 2 && q.eliminatedAfter > 0 && cut > 0) {
      const cutoffTime = active[cut - 1]?.times[session] ?? null;
      const names = active.slice(cut).map(r => {
        const t = r.times[session];
        const gap = t !== null && cutoffTime !== null ? ` +${(t - cutoffTime).toFixed(3)}` : ' bez czasu';
        return `${r.driverName.split(' ').slice(-1)[0]}${gap}`;
      });
      zone = `Strefa eliminacji P${cut + 1}–P${active.length}: ${names.join(' · ')}`;
    }
    set('quali-dropzone', zone);
  }

  /** Qualifying leaderboard: top 10 of the session (plus the followed driver), with knockout status. */
  private renderQualifyingRows(q: QualifyingSnapshot): string {
    const session = Math.min(q.session, 2);
    const active = q.standings.filter(r => r.eliminatedIn === 0);
    const cut = q.phase === 'finished' || session >= 2 ? Infinity : active.length - q.eliminatedAfter;
    const top = q.standings.slice(0, RaceUI.LEADERBOARD_ROWS);
    const extra = q.standings.slice(RaceUI.LEADERBOARD_ROWS).filter(r =>
      this.host.selectedCar?.color === r.color || (this.host.isPlayerDriving && this.host.playerCar?.color === r.color));
    return [...top, ...extra].map((r, rowIndex) => {
      const divider = rowIndex === top.length
        ? `<div class="leaderboard-divider" data-car-color="divider">poza TOP ${RaceUI.LEADERBOARD_ROWS} (${q.standings.length} aut)</div>` : '';
      const car = this.host.population.cars.find(c => c.color === r.color) || (this.host.playerCar?.color === r.color ? this.host.playerCar : null);
      const isPlayer = !!this.host.playerCar && this.host.playerCar.color === r.color && !this.host.population.cars.includes(this.host.playerCar);
      const best = r.eliminatedIn > 0 ? r.times[r.eliminatedIn - 1] : r.times[session];
      const status = r.eliminatedIn > 0 ? `OUT Q${r.eliminatedIn}` : r.onTrack ? 'NA TORZE' : (q.phase === 'finished' ? `Q3` : 'W GARAŻU');
      const current = r.onTrack && car && car.isAlive ? formatLapTime(car.lapTime) : '--:--.---';
      const classes = [
        'leaderboard-item',
        r.position <= 3 ? `rank-${r.position}` : '',
        r.eliminatedIn > 0 ? 'quali-out' : '',
        r.eliminatedIn === 0 && r.position > cut ? 'quali-danger' : '',
        this.host.selectedCar?.color === r.color ? 'selected-item' : '',
      ].filter(Boolean).join(' ');
      return `${divider}
        <div class="${classes}" data-car-color="${r.color}" data-is-player="${isPlayer ? 'true' : 'false'}">
          <div class="leaderboard-left">
            <div class="rank-badge">${r.position}</div>
            <div class="driver-details">
              <div class="driver-title">
                <span class="team-dot" style="background-color: ${r.color}"></span>
                <span>${r.driverName}</span>
                ${r.outside107 ? '<span class="quali-flag-107">107%</span>' : ''}
              </div>
              <div class="driver-stats-row">
                <span class="quali-status ${r.onTrack ? 'on-track' : ''}">${status}</span>
                <span>Q1 ${r.times[0] !== null ? formatLapTime(r.times[0]) : '—'}</span>
                ${r.times[1] !== null ? `<span>Q2 ${formatLapTime(r.times[1])}</span>` : ''}
                ${r.times[2] !== null ? `<span>Q3 ${formatLapTime(r.times[2])}</span>` : ''}
              </div>
            </div>
          </div>
          <div class="time-details">
            <div class="time-row">
              <span class="time-lbl">BEST</span>
              <span class="time-main">${best !== null ? formatLapTime(best) : '--:--.---'}</span>
              ${r.gap !== null && r.gap > 0 ? `<span class="time-delta">+${r.gap.toFixed(3)}s</span>` : ''}
            </div>
            <div class="time-row">
              <span class="time-lbl">TERAZ</span>
              <span class="time-curr-val">${current}</span>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  private showQualifyingModal(q: QualifyingSnapshot): void {
    const modal = document.getElementById('quali-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    const pole = q.standings[0];
    const poleTag = document.getElementById('quali-pole-tag');
    if (poleTag) poleTag.textContent = pole ? `POLE: ${pole.driverName.toUpperCase()}` : 'POLE POSITION';
    const time = (t: number | null) => t !== null ? formatLapTime(t) : '—';
    const body = document.getElementById('quali-table-body');
    if (body) {
      body.innerHTML = q.standings.map(s => `
        <tr>
          <td><strong>#${s.position}</strong></td>
          <td><span class="team-dot" style="background-color:${s.color}"></span> ${s.driverName}${s.outside107 ? '<span class="quali-flag-107" title="Wolniej niż 107% najlepszego czasu Q1 — start z końca stawki za zgodą sędziów">107%</span>' : ''}</td>
          <td>${time(s.times[0])}</td>
          <td>${s.eliminatedIn === 1 ? '<span class="quali-status">OUT</span>' : time(s.times[1])}</td>
          <td>${s.eliminatedIn > 0 ? '<span class="quali-status">OUT</span>' : time(s.times[2])}</td>
          <td>${s.position === 1 ? '—' : s.gap !== null ? `+${s.gap.toFixed(3)}s` : '—'}</td>
        </tr>
      `).join('');
    }
    // Automatic race start after a short countdown, unless the user holds it.
    let remaining = 10;
    const label = document.getElementById('quali-start-label');
    const tick = () => {
      if (label) label.textContent = `Start wyścigu (${remaining} s)`;
      if (remaining-- <= 0) this.startRaceFromQualifying();
    };
    this.clearQualiCountdown();
    tick();
    this.qualiCountdownTimer = window.setInterval(tick, 1000);
  }

  getDriverTrueBest(carColor: string, entryLapTime?: number, entryHasFinished?: boolean): number | null {
    const car = this.host.population.cars.find(c => c.color === carColor)
      || (this.host.playerCar && this.host.playerCar.color === carColor ? this.host.playerCar : null);
    const teamRec = this.host.population.teamRecords.find(t => t.color === carColor);
    const rs = this.session.standings.find(s => s.carColor === carColor);

    const candidates: number[] = [];
    if (entryHasFinished && typeof entryLapTime === 'number' && entryLapTime > 0) {
      candidates.push(entryLapTime);
    }
    if (teamRec && typeof teamRec.bestLapTime === 'number' && teamRec.bestLapTime > 0) {
      candidates.push(teamRec.bestLapTime);
    }
    if (car && typeof car.bestLapTime === 'number' && car.bestLapTime > 0) {
      candidates.push(car.bestLapTime);
    }
    if (rs && typeof rs.bestLap === 'number' && rs.bestLap > 0) {
      candidates.push(rs.bestLap);
    }

    if (candidates.length === 0) return null;
    const trueBest = Math.min(...candidates);

    if (teamRec && (!teamRec.bestLapTime || trueBest < teamRec.bestLapTime)) {
      teamRec.bestLapTime = trueBest;
    }
    if (car && (!car.bestLapTime || trueBest < car.bestLapTime)) {
      car.bestLapTime = trueBest;
    }

    return trueBest;
  }

  private showPodiumModal(standings: SessionView['standings']): void {
    const modal = document.getElementById('podium-modal');
    if (!modal) return;
    modal.classList.remove('hidden');

    const lapsTag = document.getElementById('podium-laps-tag');
    if (lapsTag) lapsTag.textContent = `${this.session.totalLaps} OKRĄŻEŃ`;

    const podiumCards = document.getElementById('podium-cards');
    if (podiumCards && standings && standings.length >= 3) {
      const p1 = standings[0];
      const p2 = standings[1];
      const p3 = standings[2];

      podiumCards.innerHTML = `
        <div class="podium-card p2">
          <div class="podium-pos-badge" style="background:${p2.carColor}; color:#fff;">2</div>
          <div class="podium-driver">${p2.driverName}</div>
          <div class="podium-time">${p2.gap}</div>
          <div class="podium-time">Pit stopy: ${p2.pitStops}</div>
        </div>
        <div class="podium-card p1">
          <div class="podium-pos-badge" style="background:${p1.carColor}; color:#fff;">1</div>
          <div class="podium-driver">${p1.driverName}</div>
          <div class="podium-time">ZWYCIĘZCA</div>
          <div class="podium-time">Pit stopy: ${p1.pitStops}</div>
        </div>
        <div class="podium-card p3">
          <div class="podium-pos-badge" style="background:${p3.carColor}; color:#fff;">3</div>
          <div class="podium-driver">${p3.driverName}</div>
          <div class="podium-time">${p3.gap}</div>
          <div class="podium-time">Pit stopy: ${p3.pitStops}</div>
        </div>
      `;
    }

    const tableBody = document.getElementById('podium-table-body');
    if (tableBody && standings) {
      tableBody.innerHTML = standings.map(s => `
        <tr>
          <td><strong>#${s.rank}</strong></td>
          <td><span class="team-dot" style="background-color:${s.carColor}"></span> ${s.driverName}</td>
          <td>${s.gap}</td>
          <td>${s.pitStops}</td>
          <td>${s.bestLap ? formatLapTime(s.bestLap) : '--:--.---'}</td>
          <td>${s.totalTime.toFixed(1)}s</td>
        </tr>
      `).join('');
    }
  }
}
