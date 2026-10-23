import { Vector2 } from '../math/Vector2';
import type { Car } from '../physics/Car';
import type { Population, LapLeaderboardEntry } from '../ai/Population';
import type { Track } from '../track/Track';
import { neutralWeather, type WeatherState } from '../physics/Weather';
import type { MotionInterpolator } from '../rendering/MotionInterpolator';
import { applyCarView } from '../workers/CarView';
import type { SimSnapshot, RaceState, RaceStanding, QualifyingSnapshot } from '../workers/sim.worker';

/** The session as the last snapshot described it: what the page shows besides the cars. */
export interface SessionView {
  raceState: RaceState;
  totalLaps: number;
  currentLap: number;
  startLights: number;
  winner: string | null;
  standings: RaceStanding[];
  weather: WeatherState;
  qualifying: QualifyingSnapshot | null;
  /** Training leaderboard of the teams. */
  teamStandings: LapLeaderboardEntry[];
}

export function emptySessionView(): SessionView {
  return { raceState: 'IDLE', totalLaps: 50, currentLap: 1, startLights: 0, winner: null, standings: [], weather: neutralWeather(), qualifying: null, teamStandings: [] };
}

/** What a snapshot updates on the page: the display copy of the field and the car interpolation. */
export interface SyncTarget {
  readonly population: Population;
  readonly track: Track;
  readonly playerCar: Car | null;
  /** The car the user follows; the snapshot carries its network (or the leader's when none is). */
  readonly selectedCar: Car | null;
  readonly motion: MotionInterpolator;
}

/**
 * Applies worker snapshots to the page. The page keeps a display copy of the field (cars, records,
 * lines, history) that only this class writes from the snapshots; it never simulates.
 */
export class SnapshotSync {
  readonly session: SessionView = emptySessionView();

  apply(snapshot: SimSnapshot, target: SyncTarget): void {
    const { population, track, playerCar } = target;
    for (let i = 0; i < population.cars.length; i++) {
      const car = population.cars[i];
      const view = snapshot.cars[i];
      if (car && view) applyCarView(car, view);
    }

    if (snapshot.timingGates && snapshot.timingGates.length > 0) {
      if (!track.timingGates || track.timingGates.length !== snapshot.timingGates.length ||
          track.timingGates[0]?.distanceAlongTrack !== snapshot.timingGates[0]?.distanceAlongTrack) {
        track.timingGates = snapshot.timingGates.map(g => ({
          ...g,
          left: new Vector2(g.left.x, g.left.y),
          right: new Vector2(g.right.x, g.right.y),
          center: new Vector2(g.center.x, g.center.y),
          tangent: new Vector2(g.tangent.x, g.tangent.y),
          normal: new Vector2(g.normal.x, g.normal.y),
        }));
      }
    }

    population.bestRacingLine = snapshot.bestRacingLine.map(p => ({ ...p }));
    population.leaderCheckpointSpeeds = [...snapshot.leaderCheckpointSpeeds];
    population.learningHistory = snapshot.learningHistory.map(h => ({ ...h }));
    population.globalBestLap = snapshot.globalBestLap;
    population.generation = snapshot.generation;

    const session = this.session;
    session.raceState = snapshot.raceState;
    session.totalLaps = snapshot.raceTotalLaps;
    session.currentLap = snapshot.raceCurrentLap;
    session.startLights = snapshot.raceStartLights;
    session.winner = snapshot.raceWinner;
    session.standings = snapshot.raceStandings || [];
    if (snapshot.weather) session.weather = snapshot.weather;
    session.qualifying = snapshot.qualifying ?? null;

    if (snapshot.teamStandings && snapshot.teamStandings.length > 0) {
      session.teamStandings = snapshot.teamStandings;
      for (const standing of snapshot.teamStandings) {
        const rec = population.teamRecords.find(t => t.color === standing.carColor);
        if (rec) {
          if (standing.hasFinishedLap && standing.lapTime > 0) {
            if (!rec.bestLapTime || standing.lapTime < rec.bestLapTime) {
              rec.bestLapTime = standing.lapTime;
              rec.bestLapPressure = standing.bestLapPressure ?? 0;
            }
          }
          if (standing.lastLapTime !== undefined) {
            rec.lastLapTime = standing.lastLapTime;
          }
          rec.avgSpeed = standing.avgSpeed;
          rec.topSpeed = standing.topSpeed;
          rec.fuelRemaining = standing.fuelRemaining;
        }
        const car = population.cars.find(c => c.color === standing.carColor);
        if (car && standing.hasFinishedLap && standing.lapTime > 0) {
          if (!car.bestLapTime || standing.lapTime < car.bestLapTime) {
            car.bestLapTime = standing.lapTime;
          }
        }
        if (car && standing.lastLapTime !== undefined) {
          car.lastLapTime = standing.lastLapTime;
        }
      }
    }

    // Leader: the car on top of the team standings, else the one with the highest fitness.
    let leaderCar: Car | undefined;
    if (snapshot.teamStandings && snapshot.teamStandings.length > 0 && snapshot.teamStandings[0].carColor) {
      leaderCar = population.cars.find(c => c.color === snapshot.teamStandings[0].carColor);
    }
    if (!leaderCar) {
      let maxFit = -Infinity;
      for (const c of population.cars) {
        if (c.fitness > maxFit) {
          maxFit = c.fitness;
          leaderCar = c;
        }
      }
    }
    if (leaderCar) population.currentLeader = leaderCar;

    if (playerCar && snapshot.playerCar) applyCarView(playerCar, snapshot.playerCar);

    const synced = population.cars.filter((_, i) => snapshot.cars[i]);
    if (playerCar && snapshot.playerCar) synced.push(playerCar);
    target.motion.push(snapshot.simTime, synced);

    if (snapshot.activeCarBrainJson) {
      const brain = (target.selectedCar || population.currentLeader)?.brain;
      if (brain) {
        try {
          brain.fromJSON(snapshot.activeCarBrainJson);
        } catch (e) {}
      }
    }

    if (snapshot.topology && typeof snapshot.topology === 'string') population.topology = snapshot.topology;
    syncSettingControls(snapshot);
  }
}

/** Settings the worker owns, shown in their controls unless the user is changing them right now. */
function syncSettingControls(snapshot: SimSnapshot): void {
  if (snapshot.islands) {
    const islands = snapshot.islands;
    const slider = document.getElementById('slider-islands') as HTMLInputElement | null;
    if (slider && slider.max !== String(islands.max)) slider.max = String(islands.max);
    if (slider && document.activeElement !== slider && slider.value !== String(islands.count)) {
      slider.value = String(islands.count);
      const label = document.getElementById('val-islands');
      if (label) label.textContent = String(islands.count);
    }
    const status = document.getElementById('islands-status');
    if (status) {
      status.textContent = islands.count === 0 ? 'Wyłączone: trening na jednym rdzeniu.'
        : !islands.running ? `${islands.count} wysp wstrzymanych (pauza, kwalifikacje lub wyścig).`
        : `${islands.count} wysp · ${islands.stepsPerSecond > 0 ? `${Math.round(islands.stepsPerSecond / 60)}× czasu rzeczywistego łącznie` : 'rozgrzewka…'} · przejęte modele: ${islands.adopted}`;
    }
  }

  if (snapshot.computeProfile) {
    const selectProfile = document.getElementById('select-compute-profile') as HTMLSelectElement | null;
    if (selectProfile && document.activeElement !== selectProfile && selectProfile.value !== snapshot.computeProfile) {
      selectProfile.value = snapshot.computeProfile;
    }
  }

  const isRacing = snapshot.raceState === 'GRID_START' || snapshot.raceState === 'RACING';
  const selectTop = document.getElementById('select-topology') as HTMLSelectElement | null;
  if (selectTop) {
    selectTop.disabled = isRacing;
    if (snapshot.topology && typeof snapshot.topology === 'string' && document.activeElement !== selectTop && selectTop.value !== snapshot.topology) {
      selectTop.value = snapshot.topology;
    }
  }
}
