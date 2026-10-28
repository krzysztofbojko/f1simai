import { Car, type CarControl, type DrivePlan } from './Car';
import { Track } from '../track/Track';
import { Vector2 } from '../math/Vector2';
import { LineProfile } from '../ai/LineProfile';
import { pressureProfile } from '../ai/DriverPressure';
import { updatePitRequest } from './PitStrategy';

/**
 * Drive planner: the sensor-to-feature pipeline that feeds the network, and the rule-based
 * "expert" controller. The expert is the teacher used to pre-train networks and the guardian that
 * takes over in emergencies; ordinary driving is decided by the neural network (Car.getAIControl).
 *
 * It looks ahead along the car's racing line for the most demanding corner, works out the braking
 * point from the tyre grip, downforce and drag, and steers by pure pursuit towards a point a short
 * distance ahead, round cars the LiDAR sees in the path.
 */
export function planDrive(car: Car, track: Track, leaderSpeeds?: number[]): DrivePlan {
  updatePitRequest(car);

  const n = track.checkpoints.length;
  const racingLine = car.racingLine(track);
  if (!car.lineProfile || !car.lineProfile.matches(track)) car.lineProfile = LineProfile.fromLine(track, racingLine.offsets);
  const here = track.sampleSurface(car.pos);
  if (here.surface === 'asphalt' && !car.isPitting && car.recoveryTimer <= 0 && !car.incidentActive && car.speed > 15) {
    if (here.index !== car.lineProfileIndex) car.lineProfile.recordSince(car.lineProfileIndex, car.lineProfileLateral, here.index, here.lateral);
    car.lineProfileIndex = here.index;
    car.lineProfileLateral = here.lateral;
  }
  // Project onto nearby centerline segments and aim a short physical distance
  // ahead. A whole checkpoint of lookahead cuts across narrow hairpins. The distance grows
  // with speed without a cap: pursuit turns a heading error away in about lookahead / (2·speed),
  // and a capped lookahead made that time shorter than the steering lag at high speed, so the
  // wheels sawed a few times a second.
  const points = track.points, pointCount = points.length;
  let segmentIndex = here.index;
  let segmentFraction = here.fraction;
  let remaining = Math.max(8, 5 + car.speed * 0.25);
  let targetPosition = points[segmentIndex].center;
  for (let step = 0; step < pointCount; step++) {
    const start = points[segmentIndex].center;
    const end = points[(segmentIndex + 1) % pointCount].center;
    const length = start.dist(end);
    const available = length * (1 - segmentFraction);
    if (remaining <= available) {
      targetPosition = Vector2.lerp(start, end, segmentFraction + remaining / Math.max(0.001, length));
      break;
    }
    remaining -= available;
    segmentIndex = (segmentIndex + 1) % pointCount;
    segmentFraction = 0;
    targetPosition = end;
  }
  {
    // The racing line where the car will be, shifted by the deliberate move off it.
    const road = track.sampleSurface(targetPosition), bounds = racingLine.limits(road.index);
    const lateral = racingLine.offsetAt(road.index, road.fraction) + car.raceLineOffset - car.raceLineBaseline;
    targetPosition = targetPosition.add(road.tangent.normal().mul(Math.max(bounds.lower, Math.min(bounds.upper, lateral))));
  }
  const toTarget = targetPosition.sub(car.pos).normalize();
  const headingVec = Vector2.fromAngle(car.heading);
  const cpAngleDiff = Math.atan2(headingVec.cross(toTarget), headingVec.dot(toTarget)) / Math.PI;

  const normalizedSpeed = Math.min(1.0, car.speed / 95.0);

  // 2. Speed-dependent braking zone: the line ahead, sampled every few metres, over a horizon
  // of 144 m to 432 m that grows with speed to give ample runway for high-speed braking.
  const brakingHorizon = Track.GATE_SPACING * Math.max(8, Math.min(24, Math.ceil(car.speed / 3.4)));
  const sampleStride = track.pointsFor(Car.PLAN_SAMPLE_SPACING);
  let maxOverspeed = -1.0;
  let maxUpcomingCurvature = 0;

  // Planned grip: friction coefficient (tyre state, pressure, learned pace) acting on weight plus downforce.
  const pressure = pressureProfile(car.yellowFlag || car.isPitting || car.recoveryTimer > 0 || !car.withinTrackLimits
    ? Math.min(0, car.effectiveDriverPressure) : car.effectiveDriverPressure);
  const paceMargin = car.pace.value(car.isRaceMode);
  const pushing = car.battlePush.remaining > 0;
  const tyreMu = car.baseTireGrip * Math.min(car.tyreGripFront, car.tyreGripRear);
  const muCorner = tyreMu * (Car.PLAN_CORNER_GRIP + (pressure.cornerGrip - 0.45) * 0.25) * paceMargin;
  // Cold or fading discs cap the deceleration below the tyres' grip: plan the braking with them.
  const brakeEfficiency = car.brakeEfficiency;
  const muBrake = tyreMu * Math.min(0.9 * brakeEfficiency, (Car.PLAN_BRAKE_GRIP + (pressure.braking - 1) * 0.15) * car.brakingAggression * (1 + (paceMargin - 1) * 0.5) * (pushing ? 1.08 : 1));
  const aeroPerV2 = 0.5 * car.airDensity * car.downforceCoeff * car.wakeDownforce * (1 - 0.35 * car.damage) * Car.PLAN_AERO_SHARE / car.totalMass;
  const dragPerV2 = 0.5 * car.airDensity * car.dragCoeff / car.totalMass;
  // Braking from v to w (both squared) at a = muBrake·(g + aero·v²) + drag·v²: d(v²)/ds = 2(A + B·v²).
  const brakeA = muBrake * Car.GRAVITY, brakeB = muBrake * aeroPerV2 + dragPerV2;
  const brakingDistance = (v2: number, w2: number) => v2 <= w2 ? 0 : Math.log((v2 + brakeA / brakeB) / (w2 + brakeA / brakeB)) / (2 * brakeB);
  const entrySpeedSq = (w2: number, d: number) => (w2 + brakeA / brakeB) * Math.exp(2 * brakeB * d) - brakeA / brakeB;

  // Spare grip felt right now: rises slowly while every condition holds, drops at once otherwise.
  const turnSign = Math.sign(track.points[here.index]?.curvature ?? 0);
  const outsideRoom = track.width / 2 + turnSign * here.lateral - car.width / 2;
  const free = (Car.PUSH_UTILISATION_FULL - car.tireUtilization) / (Car.PUSH_UTILISATION_FULL - Car.PUSH_UTILISATION_FREE);
  const canPush = !car.isSliding && here.surface === 'asphalt' && !car.yellowFlag && !car.isPitting && car.recoveryTimer <= 0
    && Math.max(car.tyreGripTempFront, car.tyreGripTempRear) < Car.PUSH_TYRE_MAX_TEMP && outsideRoom > Car.PUSH_EDGE_ROOM;
  const pushTarget = canPush ? Math.max(0, Math.min(1, free)) : 0;
  car.cornerPush = pushTarget < car.cornerPush ? pushTarget
    : car.cornerPush + (pushTarget - car.cornerPush) * Math.min(1, car.lastStepDt / Car.PUSH_RISE_TIME);

  let accumulatedDist = 0;
  let prevPos = car.pos;
  // Deceleration still needed to reach the safe speed of the most demanding corner ahead,
  // and the braking distance that takes relative to the distance left (1 = brake now).
  let requiredDecel = 0;
  let brakingNeed = 0;
  // Safe speed of the corner the car is in when that corner is the binding limit ahead.
  let holdSpeed = Infinity;

  for (let k = sampleStride; accumulatedDist < brakingHorizon && k <= pointCount; k += sampleStride) {
    const pointIndex = (here.index + k) % pointCount;
    // Distances along the racing line: shorter on the inside, longer around the outside.
    const linePoint = racingLine.point(pointIndex);
    accumulatedDist += prevPos.dist(linePoint);
    prevPos = linePoint;

    // Radius of the line actually driven through this point, not of the centreline.
    const curK = car.lineProfile.curvature(track, pointIndex);
    if (curK > maxUpcomingCurvature) {
      maxUpcomingCurvature = curK;
    }

    if (curK > 0.002) {
      // Steady-state limit v²·κ = μ(g + aero·v²); below the aero threshold the corner is flat out.
      const room = curK - muCorner * aeroPerV2;
      const gripV = room > 0 ? Math.min(Car.PLAN_MAX_SPEED, Math.sqrt(muCorner * Car.GRAVITY / room)) : Car.PLAN_MAX_SPEED;
      // Only the corner under the car is pushed: corners ahead are still braked for as planned.
      const underCar = accumulatedDist < Math.max(25, car.speed * 0.5);
      const push = underCar ? 1 + Car.PLAN_PUSH_MAX * car.cornerPush : 1;
      const safeV = Math.max(5, gripV * push * (pushing ? 1.04 : 1) * (car.lineDeviation > .8 ? .88 : 1));
      if (safeV >= Car.PLAN_MAX_SPEED) continue;

      // A hairpin sampled at its apex is entered well before it: reach the safe speed where
      // the arc starts (about half of a hairpin's arc before the apex), while still braking straight.
      const brakeDist = curK >= Car.PLAN_HAIRPIN_CURVATURE ? Math.max(0, accumulatedDist - Math.min(15, 1.2 / curK)) : accumulatedDist;
      const maxAllowedV = Math.sqrt(entrySpeedSq(safeV * safeV, brakeDist));

      const overspeed = (car.speed - maxAllowedV) / Math.max(8.0, safeV * 0.35);
      if (overspeed > maxOverspeed) {
        maxOverspeed = overspeed;
        holdSpeed = accumulatedDist < Math.max(25, car.speed * 0.5) ? safeV : Infinity;
      }
      if (car.speed > safeV) {
        // Over at least 0.4 s of travel: inside the corner a small overspeed must not read as a stop.
        const horizon = Math.max(2, brakeDist, car.speed * 0.4);
        requiredDecel = Math.max(requiredDecel, (car.speed * car.speed - safeV * safeV) / (2 * horizon));
        brakingNeed = Math.max(brakingNeed, brakingDistance(car.speed * car.speed, safeV * safeV) / horizon);
      }
    }
  }

  const curvatureInput = Math.min(1.0, maxUpcomingCurvature * 25.0);
  const overspeedDelta = Math.max(-1.0, Math.min(1.0, maxOverspeed));

  const inputs: number[] = [
    ...(car.stressLap ? car.noisyRayDistances() : car.rayDistances),
    normalizedSpeed,
    Math.max(-1.0, Math.min(1.0, car.angularVelocity * 1.5)),
    cpAngleDiff,
    curvatureInput,
    overspeedDelta,
    // Vehicle state: lets the network learn tyre / hybrid / gearbox dependent driving.
    Math.max(0, Math.min(1, (car.tyreGripTempFront - 60) / 80)),
    Math.max(0, Math.min(1, (car.tyreGripTempRear - 60) / 80)),
    Math.max(0, Math.min(1, Math.max(car.tyreWearFront, car.tyreWearRear))),
    Math.max(0, Math.min(1, car.ersEnergy / Car.ERS_CAPACITY)),
    car.gear / 8,
    Math.max(0, Math.min(1, (car.engineRpm - Car.IDLE_RPM) / (Car.REV_LIMIT - Car.IDLE_RPM))),
    // Ride height relative to static (0 = on the plank, 1 = 1.5x static): floor near its stall.
    Math.max(0, Math.min(1, car.rideHeightFront / (1.5 * Car.FRH_STATIC))),
    Math.max(0, Math.min(1, car.rideHeightRear / (1.5 * Car.RRH_STATIC))),
  ];

  // Walls only: the clearance thresholds are calibrated to the track edges; cars are handled below.
  const walls = car.rayWallDistances.length === car.rayDistances.length ? car.rayWallDistances : car.rayDistances;
  const midRay = Math.floor(walls.length / 2);
  let leftRaySum = 0, rightRaySum = 0;
  for (let i = 0; i < midRay; i++) leftRaySum += walls[i];
  for (let i = midRay + 1; i < walls.length; i++) rightRaySum += walls[i];
  const leftRayAvg = leftRaySum / Math.max(1, midRay);
  const rightRayAvg = rightRaySum / Math.max(1, midRay);
  const wallRepulsion = (rightRayAvg - leftRayAvg) * 0.8;

  const lookaheadDistance = Math.max(8, targetPosition.dist(car.pos));
  const pursuitAngle = Math.atan2(2 * car.wheelbase * Math.sin(cpAngleDiff * Math.PI), lookaheadDistance);
  // Yaw-rate feedback: steer toward the yaw rate the pursuit arc needs (catches
  // slides and spins that a purely geometric controller cannot see).
  const desiredYawRate = car.speed * 2 * Math.sin(cpAngleDiff * Math.PI) / lookaheadDistance;
  const yawFeedback = car.speed > 6 ? Math.max(-0.6, Math.min(0.6, Car.YAW_FEEDBACK * (desiredYawRate - car.angularVelocity) / car.maxSteerAngle)) : 0;
  // Steering lock usable at this speed: the kinematic angle for the grip-limited turn
  // plus a slip-angle allowance; more lock only saturates the front axle.
  const gripSteer = Math.min(1, (car.baseTireGrip * Car.GRAVITY * car.wheelbase / Math.max(1, car.speed * car.speed) + 0.14) / car.maxSteerAngle);
  // Cars the LiDAR sees in the path (the corridor the car sweeps, plus a margin) that it is closing
  // on: the most urgent one (shortest time to contact) is steered round, away from its centre,
  // and braked for, both harder as the time to contact shrinks.
  // A car alongside (bodies overlapping lengthwise) that is close or closing in sideways pushes
  // the steering away from it: the buffer grows with the speed at which the gap closes.
  let carUrgency = 0, carSide = 0, sideUrgency = 0, sideSign = 0;
  const forwardVec = Vector2.fromAngle(car.heading), leftVec = forwardVec.normal();
  for (let i = 0; i < car.rayCars.length; i++) {
    const other = car.rayCars[i];
    if (!other) continue;
    const dist = car.rayDistances[i] * Car.RAY_MAX_DIST, angle = car.rayAngles[i];
    const ahead = dist * Math.cos(angle), lateral = dist * Math.sin(angle);
    if (Math.abs(ahead) <= 2.75 + Car.CAR_AVOID_MARGIN) {
      const side = Math.sign(lateral);
      const gap = Math.abs(lateral) - car.width / 2;
      const closingSide = Math.max(0, car.vel.sub(other.vel).dot(leftVec) * side);
      const urgency = 1 - gap / (Car.CAR_SIDE_GAP + Car.CAR_SIDE_LOOKAHEAD * closingSide);
      if (urgency > sideUrgency) { sideUrgency = Math.min(1, urgency); sideSign = side; }
    }
    // Beyond the nose (half length 2.75 m) and inside the swept corridor: in the path ahead.
    const nose = ahead - 2.75;
    if (nose <= 0 || Math.abs(lateral) > car.width / 2 + Car.CAR_AVOID_MARGIN) continue;
    const closing = car.vel.sub(other.vel).dot(forwardVec);
    if (closing < 0.5) continue;
    const urgency = 1 - nose / closing / Car.CAR_AVOID_TTC;
    if (urgency <= carUrgency) continue;
    carUrgency = urgency;
    // Dead centre ahead: go round on the side with more room to the walls.
    carSide = Math.sign(other.pos.sub(car.pos).dot(leftVec)) || -Math.sign(wallRepulsion) || 1;
  }
  const avoidLock = Math.atan(Car.CAR_AVOID_G * Car.GRAVITY * car.wheelbase / Math.max(1, car.speed * car.speed)) / car.maxSteerAngle;
  const avoidSteer = Math.max(-avoidLock, Math.min(avoidLock, -(carSide * carUrgency + sideSign * sideUrgency) * avoidLock));
  const idealSteer = Math.max(-gripSteer, Math.min(gripSteer, pursuitAngle / car.maxSteerAngle + wallRepulsion * 0.1 + yawFeedback + avoidSteer));
  let steer = idealSteer;

  // Check forward clearance using central LiDAR rays. A neighbouring ray that meets the white line
  // beside the car's path (the racing line runs close to it) is no wall ahead: it only counts
  // when its hit lies inside the corridor the car sweeps going straight on.
  const forwardDistNorm = walls[midRay] ?? 1.0;
  const inCorridor = (i: number) => {
    const d = walls[i] ?? 1.0;
    return d * Car.RAY_MAX_DIST * Math.abs(Math.sin(car.rayAngles[i] ?? 0)) <= car.width / 2 + Car.CORRIDOR_MARGIN ? d : 1.0;
  };
  const leftForwardNorm = inCorridor(Math.max(0, midRay - 1));
  const rightForwardNorm = inCorridor(Math.min(walls.length - 1, midRay + 1));
  const minCenterClearance = Math.min(forwardDistNorm, leftForwardNorm, rightForwardNorm) * (Car.CLEARANCE_REF_WIDTH / Math.max(5, track.width));

  // 3. F1 Racing Throttle & Braking Policy:
  let throttle: number;
  let brake: number;

  if (brakingNeed > Car.BRAKE_ONSET) {
    // Braking zone: one progressive application. The pedal asks for the deceleration still needed,
    // converted with the tyre grip (with downforce) and drag at this speed, so it eases off by
    // itself as the speed approaches the corner's safe speed instead of pulsing on and off.
    throttle = 0.0;
    const v2 = car.speed * car.speed;
    const tyreDecel = car.baseTireGrip * Math.min(car.tyreGripFront, car.tyreGripRear) * (Car.GRAVITY + 0.5 * car.airDensity * car.downforceCoeff * car.wakeDownforce * v2 / car.totalMass);
    const dragDecel = 0.5 * car.airDensity * car.dragCoeff * v2 / car.totalMass;
    const onset = Math.min(1, (brakingNeed - Car.BRAKE_ONSET) / (1 - Car.BRAKE_ONSET));
    // Weaker discs need more pedal for the same deceleration.
    brake = Math.min(1, Math.max(0, requiredDecel * onset - dragDecel) / Math.max(1, tyreDecel * brakeEfficiency));
    // Trail braking: the tyre already turning the car keeps only the rest of its friction circle
    // for braking, so the pedal is eased to what the front axle can take without locking.
    const lateralShare = Math.min(1, Math.abs(car.lateralG) * Car.GRAVITY / Math.max(1, tyreDecel));
    brake = Math.min(brake, Car.TRAIL_BRAKE_PEDAL * Math.sqrt(1 - lateralShare * lateralShare) / Math.max(0.5, brakeEfficiency));
  } else if (overspeedDelta > -pressure.coastMargin && holdSpeed < Infinity) {
    // Inside the corner that limits the speed: hold it with partial throttle (drag compensation
    // plus a proportional term) instead of coasting down and re-accelerating through the arc.
    brake = 0.0;
    const dragPower = 0.5 * car.airDensity * car.dragCoeff * car.speed * car.speed * car.speed;
    throttle = Math.max(0, Math.min(0.7, dragPower / Car.ICE_POWER + 0.12 * (holdSpeed * 0.98 - car.speed)));
  } else if (overspeedDelta > -pressure.coastMargin) {
    // Transition / lift & coast zone: cut throttle, prevent violent bang-bang throttle spikes
    throttle = 0.0;
    brake = 0.0;
  } else {
    // In acceleration or cruising zone - NO BRAKING!
    brake = 0.0;
    if (minCenterClearance > Car.CLEAR_FULL) {
      if (Math.abs(steer) < 0.35) {
        // Straights, gentle sweepers, and corner exits: 100% FLAT OUT
        throttle = 1.0;
      } else {
        // Apex cornering: traction control modulation
        const steerExcess = Math.abs(steer) - 0.35;
        throttle = Math.max(0.35, 1.0 - steerExcess * 0.80);
      }
    } else if (minCenterClearance > Car.CLEAR_LIFT) {
      // Approaching barrier/wall: lift to maintain control, never demand acceleration
      throttle = 0.20;
    } else {
      // Emergency wall proximity: cut throttle and brake; once nearly stopped creep
      // along the pursuit path instead of waiting in front of the wall forever.
      if (car.speed < 4) { throttle = 0.3; brake = 0; }
      else { throttle = 0.0; brake = 0.40; }
    }

    // Telemetry coaching from session leader (only when firmly outside braking zones and clear of walls):
    if (leaderSpeeds && leaderSpeeds.length > 0 && overspeedDelta <= -0.20 && minCenterClearance > Car.CLEAR_COACH) {
      const leaderV = leaderSpeeds[car.currentCheckpointIdx % leaderSpeeds.length];
      if (leaderV && car.speedKmh < leaderV - 8) {
        throttle = 1.0;
      }
    }
  }

  // Corner exit: the rear tyres already carry their share of the cornering force, so the drive may
  // take only the rest of their friction circle; more pushes the car wide onto the outside kerb.
  const v2 = car.speed * car.speed;
  const tyreAccel = car.baseTireGrip * Math.min(car.tyreGripFront, car.tyreGripRear) * (Car.GRAVITY + 0.5 * car.airDensity * car.downforceCoeff * car.wakeDownforce * v2 / car.totalMass);
  const cornerShare = Math.min(1, Math.abs(car.lateralG) * Car.GRAVITY / Math.max(1, tyreAccel));
  const driveAccel = Car.EXIT_DRIVE_SHARE * Car.REAR_WEIGHT_SHARE * tyreAccel * Math.sqrt(1 - cornerShare * cornerShare);
  const fullDriveAccel = (Car.ICE_POWER + Car.ERS_POWER) / Math.max(10, car.speed) / car.totalMass;
  if (cornerShare > 0.25) throttle = Math.min(throttle, Math.max(0.2, driveAccel / fullDriveAccel));

  // 4. Traction & Stability Control:
  if (car.isSliding) {
    throttle = Math.min(throttle, 0.20);
  }
  const currentCp = track.checkpoints[car.currentCheckpointIdx % n];
  if (currentCp && headingVec.dot(currentCp.tangent) < 0.90) {
    throttle = Math.min(throttle, 0.45);
  }
  if (carUrgency > 0) {
    throttle = 0;
    brake = Math.max(brake, Math.min(1, 0.3 + carUrgency));
  }

  const offRoad = (track.sampleSurface?.(car.pos).surface ?? 'asphalt') !== 'asphalt';
  if (offRoad) {
    // The geometric pursuit target remains on asphalt; at low speed it brings
    // the car back without the asphalt-edge LiDAR treating escape as a wall.
    steer = Math.max(-1, Math.min(1, pursuitAngle / car.maxSteerAngle));
    throttle = car.speed > 12 ? 0 : Math.abs(pursuitAngle) < 0.8 ? 0.22 : 0.1;
    // Soft ground can hold a car at a standstill: push harder the longer it has not moved.
    car.offRoadStillTime = car.speed < 1.5 ? car.offRoadStillTime + 1 / 60 : 0;
    if (car.speed < 4) throttle = Math.min(1, Math.max(throttle, 0.22) + car.offRoadStillTime * 0.4);
    brake = car.speed > 18 ? 0.45 : car.speed > 10 ? 0.15 : 0;
  }
  const expert: CarControl = { steer, throttle, brake };
  return {
    inputs, expert, idealSteer, pushing, offRoad, overspeedDelta, minCenterClearance,
    guarded: offRoad || minCenterClearance <= Car.CLEAR_LIFT || Math.max(carUrgency, sideUrgency) > Car.CAR_AVOID_GUARD || car.yellowFlag || car.isPitting || car.recoveryTimer > 0,
  };
}
