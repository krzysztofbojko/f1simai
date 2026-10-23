import type { Car } from './Car';
import type { Track, Checkpoint } from '../track/Track';
import { Vector2 } from '../math/Vector2';

/**
 * Fitness: the score that ranks drivers within a training generation. It rewards progress along
 * the circuit, clean gates, the racing line and fast laps, and penalises driving backwards,
 * leaving the track and sliding. Lap times, not fitness, decide records and model selection.
 */

/**
 * Progress along the track in this step: driving forward along the circuit earns fitness, going
 * backwards, against the direction, beyond the track limits or sliding costs it. Returns true when
 * the car has just been retired for driving the wrong way.
 */
export function scoreStep(car: Car, track: Track, heading: Vector2, dt: number): boolean {
  const cpCount = track.checkpoints.length;
  if (cpCount > 0) {
    const targetCp = track.checkpoints[car.currentCheckpointIdx % cpCount];
    const prevCp = track.checkpoints[(car.currentCheckpointIdx - 1 + cpCount) % cpCount];
    const trackTangent = targetCp.tangent;
    const trackAlignment = heading.dot(trackTangent);
    const directionalSpeed = car.vel.dot(trackTangent);

    // Local curve detection: avoid false positive wrong-way in tight hairpins
    const isHighCurvature = Math.abs(targetCp.curvature) > 0.0025 || Math.abs(prevCp.curvature) > 0.0025;
    const toTarget = targetCp.center.sub(car.pos);
    const distToTarget = toTarget.mag();
    const toTargetDir = distToTarget > 0.001 ? toTarget.div(distToTarget) : trackTangent;
    const approachAlignment = heading.dot(toTargetDir);
    const approachSpeed = car.vel.dot(toTargetDir);

    const effectiveAlignment = isHighCurvature ? Math.max(trackAlignment, approachAlignment) : trackAlignment;
    const effectiveSpeed = isHighCurvature ? Math.max(directionalSpeed, approachSpeed) : directionalSpeed;

    // Positive directional progress along track
    if (car.withinTrackLimits && effectiveSpeed > 0 && effectiveAlignment > 0) {
      const alignBonus = Math.max(0.15, effectiveAlignment);
      car.fitness += effectiveSpeed * alignBonus * 0.15 * dt;
    } else if (effectiveSpeed < 0 && !isHighCurvature) {
      // Penalty for moving backwards along track
      car.fitness = Math.max(0, car.fitness + effectiveSpeed * 0.45 * dt);
    }

    // Penalty for wrong heading / driving in reverse direction (never terminate on high curvature)
    if (car.recoveryTimer <= 0 && effectiveAlignment < -0.20 && !isHighCurvature) {
      const wrongWayPenalty = (250.0 * Math.abs(effectiveAlignment) + Math.abs(car.speed) * 6.0) * dt;
      car.fitness = Math.max(0, car.fitness - wrongWayPenalty);

      if (effectiveAlignment < -0.45 && directionalSpeed < -5.0 && car.speed > 8.0) {
        car.wrongWayTimer += dt;
        if (car.wrongWayTimer > 1.6) {
          // Terminate car driving backwards at speed on straight/gentle corner
          car.eliminationReason = 'wrong-way';
          car.isAlive = false;
          car.effectiveThrottle = 0;
          car.lateralG = 0;
          car.longitudinalG = 0;
          car.vel.set(0, 0);
          car.speed = 0;
          car.speedKmh = 0;
          car.respawnTimer = 0.5;
          // Fixed penalty preserving relative progress info
          car.fitness = Math.max(0, car.fitness - 1500);
          return true;
        }
      } else {
        car.wrongWayTimer = Math.max(0, car.wrongWayTimer - dt * 0.5);
      }
    } else {
      car.wrongWayTimer = 0;
    }
  }

  // Leaving the track is never rewarded: it costs fitness for as long as the car is beyond the limits.
  if (!car.withinTrackLimits) {
    car.fitness = Math.max(0, car.fitness - (80 + car.speed * 5) * (1 - car.surfaceFractions.asphalt * 0.5) * dt);
  }

  // Penalty for skidding and loss of adhesion
  if (car.isSkidding) {
    const slipMagnitude = Math.abs(car.vel.dot(heading.normal())) + (car.understeerSlip + car.oversteerSlip) * 14.0;
    const skidPenalty = (45.0 + slipMagnitude * 6.0) * dt;
    car.fitness = Math.max(0, car.fitness - skidPenalty);
  }
  return false;
}

/**
 * Reward for clearing a checkpoint: more for a clean, stable passage on the asphalt, on the
 * racing line through a corner or fast out of one; a gate taken off the asphalt costs fitness.
 */
export function scoreGate(car: Car, track: Track, nextCp: Checkpoint, clearedCpIdx: number): void {
  const cpCount = track.checkpoints.length;
  const forwardDir = Vector2.fromAngle(car.heading);
  const trackAlignment = forwardDir.dot(nextCp.tangent);
  const isClean = !car.isSkidding && trackAlignment > 0.45 && Math.abs(car.angularVelocity) < 2.0;

  // Base checkpoint reward; a gate taken with a wheel off the asphalt earns nothing and costs fitness
  const onAsphalt = car.withinTrackLimits;
  if (onAsphalt) car.fitness += 1200;
  else car.fitness = Math.max(0, car.fitness - 600);

  // Clean checkpoint bonus: grip and stability count, the lateral position does not, so the
  // whole width of the asphalt is free for the racing line.
  if (isClean && onAsphalt) {
    car.fitness += 1000;
  } else if (car.isSkidding) {
    // Slid through checkpoint sideways / out of control
    car.fitness = Math.max(0, car.fitness - 200);
  }

  // Point 2: Racing-line and exit speed rewards
  if (Math.abs(nextCp.curvature) > 0.003) {
    // On the racing line through the corner: wide on entry, at the kerb on the apex, wide on exit.
    const offLine = Math.abs(track.sampleSurface(car.pos).lateral - car.racingLine(track).offsetAt(nextCp.index));
    if (offLine < 1.2 && isClean && onAsphalt) {
      car.fitness += 800;
    }
  } else if (clearedCpIdx > 0) {
    const prevCp = track.checkpoints[(clearedCpIdx - 1 + cpCount) % cpCount];
    if (Math.abs(prevCp.curvature) > 0.003 && car.speed > 22 && isClean && onAsphalt) {
      // High speed corner exit acceleration reward!
      car.fitness += 600 + Math.round(car.speedKmh * 2);
    }
  }
}

/** Positive reinforcement for a split faster than the personal best (`delta` < 0). */
export function scoreSplit(car: Car, delta: number): void {
  if (delta < 0) {
    const sectorBonus = Math.min(3000, Math.round(Math.abs(delta) * 1000));
    car.fitness += 1500 + sectorBonus;
  }
}

/** Substantial lap completion reward, larger for a faster lap. */
export function scoreLap(car: Car, lapTime: number): void {
  car.fitness += 30000 + Math.round(150000 / Math.max(10, lapTime));
}
