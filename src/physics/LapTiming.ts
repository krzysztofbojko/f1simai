import { Car, type LapFinishEvent } from './Car';
import type { Track } from '../track/Track';
import { lineCrossingT, segmentIntersectionT } from '../math/Vector2';
import { CONDITION_BANDS } from './Weather';
import { scoreGate, scoreLap, scoreSplit } from './Fitness';

/**
 * Lap timing of a car: gates cleared in order along the track, splits and sectors, the lap at the
 * start/finish line with the crossing interpolated inside the physics step, and the retirements
 * a lap cannot go on from (outside the fence, out of fuel, stuck).
 */

/**
 * Sector ending at gate `g` (0..3), from the previous split. Leaves the sector in `sectorEvent`
 * and returns its time, or null when the lap was not timed from the line. A stress lap is a valid
 * time in qualifying and the race; in training it is not a reference for learning.
 */
export function timeSector(car: Car, g: number, split: number): number | null {
  const start = g === 0 ? 0 : car.currentLapSplits[g - 1];
  if (!car.flyingLap || start === null || start === undefined) return null;
  const sectorTime = split - start;
  car.sectorEvent = { gateIndex: g, sectorTime, splitTime: split, valid: !car.lapExcursion && !(car.stressLap && !car.isRaceMode) };
  return sectorTime;
}

export function checkTrackProgress(car: Car, track: Track): LapFinishEvent | null {
  if (car.fitness > car.peakFitness) {
    car.peakFitness = car.fitness;
  }
  // Asphalt is a surface transition, not a collision. Legacy test doubles
  // without barrier geometry retain their explicitly supplied hard boundary.
  if (!track.sweepBarrier) {
    const corners = car.footprint(2.75);
    if (track.isOutOfBounds(car.pos) || corners.some(corner => track.isOutOfBounds(corner))) {
      car.eliminate('barrier', 0.45); return null;
    }
  } else if (track.sampleSurface(car.pos).outsideBarrier) {
    // Safety fallback for invalid/spawned positions already outside the fence.
    car.eliminate('barrier', 0.45); return null;
  }

  if (car.isOutOfFuel && car.speed < 1.0) {
    car.eliminationReason = 'fuel';
    car.isAlive = false;
    car.effectiveThrottle = 0;
    car.lateralG = 0;
    car.longitudinalG = 0;
    car.vel.set(0, 0);
    car.speed = 0;
    car.speedKmh = 0;
    car.respawnTimer = 0.5;
    car.fitness = Math.max(0, Math.round(car.fitness * 0.75));
    return null;
  }

  // A car that cannot rejoin the asphalt within OFF_TRACK_RECOVERY_TIME is retired instead of idling for half a minute.
  if (car.timeSinceCheckpoint > (car.recoveryTimer > 0 ? Car.STUCK_RECOVERY_TIMEOUT : Car.STUCK_TIMEOUT) || (!car.isManual && car.offTrackTime > Car.OFF_TRACK_RECOVERY_TIME)) {
    car.eliminationReason = 'stuck';
    car.isAlive = false;
    car.effectiveThrottle = 0;
    car.lateralG = 0;
    car.longitudinalG = 0;
    car.vel.set(0, 0);
    car.speed = 0;
    car.speedKmh = 0;
    car.respawnTimer = 0.5;
    // Stagnation penalty preserving relative ranking
    car.fitness = Math.max(0, Math.round(car.fitness * 0.50));
    return null;
  }

  const cpCount = track.checkpoints.length;
  if (cpCount === 0) return null;
  const clearedCpIdx = car.currentCheckpointIdx % cpCount;
  const nextCp = track.checkpoints[clearedCpIdx];
  const distToCp = car.pos.dist(nextCp.center);

  // Cheap AABB broadphase before the exact segment crossing
  let crossedGate = false;
  let crossingT: number | null = null;
  const minX1 = Math.min(car.prevPos.x, car.pos.x);
  const maxX1 = Math.max(car.prevPos.x, car.pos.x);
  const minY1 = Math.min(car.prevPos.y, car.pos.y);
  const maxY1 = Math.max(car.prevPos.y, car.pos.y);

  const minX2 = Math.min(nextCp.p1.x, nextCp.p2.x);
  const maxX2 = Math.max(nextCp.p1.x, nextCp.p2.x);
  const minY2 = Math.min(nextCp.p1.y, nextCp.p2.y);
  const maxY2 = Math.max(nextCp.p1.y, nextCp.p2.y);

  if (maxX1 >= minX2 && minX1 <= maxX2 && maxY1 >= minY2 && minY1 <= maxY2) {
    crossingT = segmentIntersectionT(car.prevPos, car.pos, nextCp.p1, nextCp.p2);
    crossedGate = crossingT !== null;
  }

  const isNearCp = clearedCpIdx !== 0 && distToCp < Math.min(3, track.width * 0.2) && car.withinTrackLimits;
  // (1) Checkpoint zaliczaj tylko przy ruchu zgodnym z tangentem toru
  const isMovingForwardAlongTrack = car.vel.dot(nextCp.tangent) > 0.5;

  // A car that rejoins the asphalt beyond gates it passed off the road resumes at the gate ahead.
  // The skipped gates earn nothing and spoil the lap; without this the car could never clear
  // them and would be retired as stuck while driving, leaving a wreck on the racing line.
  if (car.timeSinceCheckpoint > Car.REJOIN_MIN_TIME && car.withinTrackLimits && isMovingForwardAlongTrack && !crossedGate && !isNearCp) {
    const missed = (track.gateIndexOf(track.sampleSurface(car.pos).index) - clearedCpIdx + cpCount) % cpCount + 1;
    // On the inside of a hairpin the nearest centreline segment is already the next one before
    // the car reaches the gate: one gate counts as missed only once the car is beyond its line.
    const beyondGate = missed > 1 || car.pos.sub(nextCp.center).dot(nextCp.tangent) > 0;
    // Never past the start/finish gate (index 0), which counts the lap.
    if (beyondGate && missed <= Car.MAX_REJOIN_SKIPPED_GATES && clearedCpIdx !== 0 && clearedCpIdx + missed <= cpCount) {
      car.currentCheckpointIdx = (clearedCpIdx + missed) % cpCount;
      car.timeSinceCheckpoint = 0;
      car.lapCompromised = true;
      car.lapExcursion = true;
      return null;
    }
  }

  if (car.withinTrackLimits && isMovingForwardAlongTrack && (crossedGate || isNearCp)) {
    // A gate taken just before its line (close to its centre) is timed where the car will meet the line at its present speed.
    return passGate(car, track, crossingT ?? lineCrossingT(car.prevPos, car.pos, nextCp.p1, nextCp.p2));
  }

  return null;
}

/**
 * The car clears its next gate: splits, sectors and, at the start/finish gate, the lap. `gateT` is
 * the fraction of this step at which it met the gate line (null: at the end of the step); the step
 * ends past the line by (1 - t) of its length. The pit lane clears the gates it runs beside too.
 */
export function passGate(car: Car, track: Track, gateT: number | null): LapFinishEvent | null {
  const cpCount = track.checkpoints.length;
  const clearedCpIdx = car.currentCheckpointIdx % cpCount;
  const nextCp = track.checkpoints[clearedCpIdx];
  car.checkpointsCleared++;
  const overshoot = gateT === null ? 0 : Math.max(-0.5, Math.min(car.lastStepDt, (1 - Math.max(0, gateT)) * car.lastStepDt));
  const gateTime = car.lapTime - overshoot;

  scoreGate(car, track, nextCp, clearedCpIdx);

  car.timeSinceCheckpoint = 0;
  car.currentCheckpointIdx = (clearedCpIdx + 1) % cpCount;
  car.lineNet?.passPoint(clearedCpIdx, cpCount, car.lapTime);

  // Check 4 timing checkpoints (CP1, CP2, CP3)
  if (track.timingGates && track.timingGates.length === 4) {
    for (let g = 0; g < 3; g++) {
      const gate = track.timingGates[g];
      if (car.currentLapSplits[g] === null && clearedCpIdx === gate.checkpointIndex && gateTime > 1.2) {
        const split = gateTime;
        car.currentLapSplits[g] = split;
        const prevPbSplit = car.bestLapSplits[g];
        const delta = prevPbSplit !== null ? (split - prevPbSplit) : 0;
        car.lastCheckpointDelta = {
          gateIndex: g,
          gateName: gate.name,
          delta,
          splitTime: split,
          sectorTime: timeSector(car, g, split),
        };
        scoreSplit(car, delta);
      }
    }
  }

  // Completed a full lap crossing the start/finish line (cleared checkpoint 0)!
  if (clearedCpIdx === 0) {
    car.ersHarvestedLap = 0;
    car.lineCrossingRaceTime = car.totalRaceTime - overshoot;
    if (car.checkpointsCleared >= track.checkpoints.length * 0.8) {
      const finishedLapTime = gateTime;
      car.lastLapTime = finishedLapTime;
      car.currentLapSplits[3] = finishedLapTime;
      const prevPbFinish = car.bestLapSplits[3] || car.bestLapTime;
      car.lastCheckpointDelta = {
        gateIndex: 3,
        gateName: 'CP 4 (META)',
        delta: prevPbFinish !== null ? (finishedLapTime - prevPbFinish) : 0,
        splitTime: finishedLapTime,
        sectorTime: timeSector(car, 3, finishedLapTime),
      };

      // Handed over as it is: the car starts a fresh array for the next lap below.
      const finishedTrajectory = car.currentLapTrajectory;
      const finishedMaxSpeedKmh = Math.round(car.maxSpeedInLap * 3.6);
      const avgSpeedKmh = finishedLapTime > 0
        ? Math.round((track.totalLength / finishedLapTime) * 3.6 * 10) / 10
        : 0;

      car.currentLap++;
      // Laps after the chequered flag are not raced: they neither count nor set a time.
      const afterFlag = car.isFinishedRace;
      if (!afterFlag) car.raceLapsCompleted++;
      // Training compares laps within one track-condition class: a lap the rain caught is timed, not learnt from.
      const [bandLow, bandHigh] = CONDITION_BANDS[Car.config.conditions];
      const offConditions = !car.isRaceMode && (car.lapWetMin < bandLow || car.lapWetMax > bandHigh);
      car.lapWetMin = car.lapWetMax = car.wetness;
      if (!car.lapCompromised && !offConditions) scoreLap(car, finishedLapTime);
      const compromised = car.lapCompromised || car.pressureLearningBlocked || offConditions || afterFlag;
      // Only the network's own excursions probe the limit: a stress lap (less grip, noisy sensors)
      // or a scripted mistake says nothing about the pace the car can hold.
      if (!car.isManual) car.pace.finishLap(finishedLapTime, !compromised, car.lapExcursion && !car.lapContact && !car.lapIncident && !car.stressLap);
      car.lapExcursion = false;
      car.lapContact = false;
      car.lapIncident = car.incidentActive;
      if (!compromised && (!car.bestLapTime || finishedLapTime < car.bestLapTime)) {
        car.bestLapTime = finishedLapTime;
        car.bestLapPressure = car.driverPressure;
        car.bestLapSplits = [...car.currentLapSplits];
        if (car.brain) {
          car.safeBrainBackup = car.brain.clone();
          car.safeBrainPressure = car.driverPressure;
        }
      }

      const yellow = car.lapYellow;
      car.lapYellow = false;
      car.pressureLearningBlocked = car.pressureElapsed < 2;
      car.lapCompromised = car.incidentActive || car.recoveryTimer > 0 || car.pressureLearningBlocked;
      car.rollLapPerformanceVariation();
      car.currentLapTrajectory = [];
      car.maxSpeedInLap = 0;
      car.distanceCoveredInLap = 0;
      // The part of this step beyond the line already belongs to the new lap.
      car.lapTime = overshoot;
      car.flyingLap = true;
      car.currentLapSplits = [null, null, null, null];
      const fuelUsed = car.lapStartFuel - car.fuelKg;
      car.lapStartFuel = car.fuelKg;

      return {
        compromised,
        pressure: car.driverPressure,
        lapTime: finishedLapTime,
        trajectory: finishedTrajectory,
        maxSpeed: finishedMaxSpeedKmh,
        avgSpeed: avgSpeedKmh,
        fuelRemaining: Math.round(car.fuelKg * 10) / 10,
        fuelUsed,
        yellow,
      };
    } else {
      // First time crossing the start/finish line from grid slot: start flying lap!
      car.lapTime = overshoot;
      car.lapStartFuel = car.fuelKg;
      car.flyingLap = true;
      car.lapWetMin = car.lapWetMax = car.wetness;
      car.currentLapSplits = [null, null, null, null];
      car.lastCheckpointDelta = null;
      car.currentLapTrajectory = [];
      car.maxSpeedInLap = 0;
      car.distanceCoveredInLap = 0;
    }
  }
  return null;
}

