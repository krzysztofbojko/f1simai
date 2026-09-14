import { Vector2 } from './Vector2';

export interface TrackPoint {
  center: Vector2;
  left: Vector2;
  right: Vector2;
  tangent: Vector2;
  normal: Vector2;
  curvature: number;
}

export class Spline {
  /**
   * Catmull-Rom spline evaluation for 4 points
   */
  static catmullRom(p0: Vector2, p1: Vector2, p2: Vector2, p3: Vector2, t: number): Vector2 {
    const t2 = t * t;
    const t3 = t2 * t;

    const f0 = -0.5 * t3 + t2 - 0.5 * t;
    const f1 = 1.5 * t3 - 2.5 * t2 + 1.0;
    const f2 = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
    const f3 = 0.5 * t3 - 0.5 * t2;

    return new Vector2(
      p0.x * f0 + p1.x * f1 + p2.x * f2 + p3.x * f3,
      p0.y * f0 + p1.y * f1 + p2.y * f2 + p3.y * f3
    );
  }

  /**
   * Smooth raw points into a closed spline with uniform point spacing
   */
  static generateClosedTrack(
    rawPoints: Vector2[],
    trackWidth: number = 90,
    targetSpacing: number = 20
  ): TrackPoint[] {
    if (rawPoints.length < 4) return [];

    // Filter points that are too close
    const filtered: Vector2[] = [rawPoints[0]];
    for (let i = 1; i < rawPoints.length; i++) {
      if (rawPoints[i].dist(filtered[filtered.length - 1]) > 18) {
        filtered.push(rawPoints[i]);
      }
    }

    if (filtered.length < 4) return [];

    // Ensure winding order is counter-clockwise (positive signed area)
    let area = 0;
    for (let i = 0; i < filtered.length; i++) {
      const j = (i + 1) % filtered.length;
      area += filtered[i].cross(filtered[j]);
    }
    // If clockwise, reverse so cars travel in a standard counter-clockwise or clockwise direction
    if (area < 0) {
      filtered.reverse();
    }

    const n = filtered.length;
    const rawSplinePoints: Vector2[] = [];

    // Subdivide each segment
    const samplesPerSegment = 12;
    for (let i = 0; i < n; i++) {
      const p0 = filtered[(i - 1 + n) % n];
      const p1 = filtered[i];
      const p2 = filtered[(i + 1) % n];
      const p3 = filtered[(i + 2) % n];

      for (let s = 0; s < samplesPerSegment; s++) {
        const t = s / samplesPerSegment;
        rawSplinePoints.push(Spline.catmullRom(p0, p1, p2, p3, t));
      }
    }

    // Now re-sample uniformly by arc-length
    const totalRaw = rawSplinePoints.length;
    let totalLength = 0;
    const cumDist: number[] = [0];
    for (let i = 0; i < totalRaw; i++) {
      const next = rawSplinePoints[(i + 1) % totalRaw];
      const d = rawSplinePoints[i].dist(next);
      totalLength += d;
      cumDist.push(totalLength);
    }

    const numPoints = Math.max(20, Math.round(totalLength / targetSpacing));
    const stepLength = totalLength / numPoints;
    const uniformCenter: Vector2[] = [];

    let currentRawIdx = 0;
    for (let i = 0; i < numPoints; i++) {
      const targetDist = i * stepLength;
      while (currentRawIdx < totalRaw && cumDist[currentRawIdx + 1] < targetDist) {
        currentRawIdx++;
      }
      const pA = rawSplinePoints[currentRawIdx % totalRaw];
      const pB = rawSplinePoints[(currentRawIdx + 1) % totalRaw];
      const distA = cumDist[currentRawIdx];
      const distB = cumDist[currentRawIdx + 1];
      const factor = distB > distA ? (targetDist - distA) / (distB - distA) : 0;
      uniformCenter.push(Vector2.lerp(pA, pB, factor));
    }

    // Now compute tangents, normals, curvature, left and right edges
    const result: TrackPoint[] = [];
    const count = uniformCenter.length;

    for (let i = 0; i < count; i++) {
      const prev = uniformCenter[(i - 1 + count) % count];
      const curr = uniformCenter[i];
      const next = uniformCenter[(i + 1) % count];

      const tangent = next.sub(prev).normalize();
      const normal = tangent.normal(); // points to the left

      // Curvature approximation
      const v1 = curr.sub(prev).normalize();
      const v2 = next.sub(curr).normalize();
      const curvature = v1.cross(v2); // positive = left turn, negative = right turn

      const halfW = trackWidth / 2;
      const left = curr.add(normal.mul(halfW));
      const right = curr.sub(normal.mul(halfW));

      result.push({
        center: curr,
        left,
        right,
        tangent,
        normal,
        curvature
      });
    }

    return result;
  }
}
