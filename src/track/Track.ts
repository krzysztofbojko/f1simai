import { Vector2, LineSegment, raySegmentIntersection, IntersectionResult, distToSegment } from '../math/Vector2';
import { TrackPoint } from '../math/Spline';

export interface Checkpoint {
  index: number;
  p1: Vector2; // left
  p2: Vector2; // right
  center: Vector2;
  tangent: Vector2;
  curvature: number;
}

export interface TimingGate {
  id: number;           // 1, 2, 3, 4
  name: string;         // "CP 1", "CP 2", "CP 3", "CP 4 (META)"
  pointIndex: number;
  left: Vector2;
  right: Vector2;
  center: Vector2;
  tangent: Vector2;
  normal: Vector2;
  fraction: number;     // 0.25, 0.50, 0.75, 1.0
  distanceAlongTrack: number;
}

export interface IndexedSegment extends LineSegment {
  id: number;
  lastQueryId: number;
}

export class Track {
  public points: TrackPoint[];
  public leftSegments: IndexedSegment[] = [];
  public rightSegments: IndexedSegment[] = [];
  public checkpoints: Checkpoint[] = [];
  public timingGates: TimingGate[] = [];
  public width: number;
  public totalLength: number = 0;

  // High-performance spatial grid for O(1) raycasting and collision checks
  private spatialCellSize: number = 80;
  private boundaryGrid: Map<number, IndexedSegment[]> = new Map();
  private centerGrid: Map<number, IndexedSegment[]> = new Map();
  private queryId: number = 0;

  constructor(points: TrackPoint[], width: number = 90) {
    this.points = points;
    this.width = width;
    this.buildGeometry();
  }

  private hashCell(gx: number, gy: number): number {
    return (gx << 16) | (gy & 0xffff);
  }

  private addSegmentToGrid(grid: Map<number, IndexedSegment[]>, seg: IndexedSegment): void {
    const cs = this.spatialCellSize;
    const minGx = Math.floor(Math.min(seg.p1.x, seg.p2.x) / cs);
    const maxGx = Math.floor(Math.max(seg.p1.x, seg.p2.x) / cs);
    const minGy = Math.floor(Math.min(seg.p1.y, seg.p2.y) / cs);
    const maxGy = Math.floor(Math.max(seg.p1.y, seg.p2.y) / cs);

    for (let gx = minGx; gx <= maxGx; gx++) {
      for (let gy = minGy; gy <= maxGy; gy++) {
        const key = this.hashCell(gx, gy);
        let cell = grid.get(key);
        if (!cell) {
          cell = [];
          grid.set(key, cell);
        }
        cell.push(seg);
      }
    }
  }

  private buildGeometry(): void {
    const n = this.points.length;
    this.leftSegments = [];
    this.rightSegments = [];
    this.checkpoints = [];
    this.totalLength = 0;
    this.boundaryGrid.clear();
    this.centerGrid.clear();

    let segId = 0;
    for (let i = 0; i < n; i++) {
      const nextIdx = (i + 1) % n;
      const curr = this.points[i];
      const next = this.points[nextIdx];

      const leftSeg: IndexedSegment = {
        id: segId++,
        lastQueryId: 0,
        p1: curr.left,
        p2: next.left
      };
      this.leftSegments.push(leftSeg);
      this.addSegmentToGrid(this.boundaryGrid, leftSeg);

      const rightSeg: IndexedSegment = {
        id: segId++,
        lastQueryId: 0,
        p1: curr.right,
        p2: next.right
      };
      this.rightSegments.push(rightSeg);
      this.addSegmentToGrid(this.boundaryGrid, rightSeg);

      const centerSeg: IndexedSegment = {
        id: segId++,
        lastQueryId: 0,
        p1: curr.center,
        p2: next.center
      };
      this.addSegmentToGrid(this.centerGrid, centerSeg);

      this.totalLength += curr.center.dist(next.center);

      this.checkpoints.push({
        index: i,
        p1: curr.left,
        p2: curr.right,
        center: curr.center,
        tangent: curr.tangent,
        curvature: curr.curvature,
      });
    }

    // Build 4 timing checkpoints (divided evenly across track distance: 25%, 50%, 75%, 100%)
    this.timingGates = [];
    if (n >= 4 && this.totalLength > 0) {
      let accum = 0;
      const dists: number[] = [0];
      for (let i = 0; i < n; i++) {
        const nextIdx = (i + 1) % n;
        accum += this.points[i].center.dist(this.points[nextIdx].center);
        dists.push(accum);
      }

      const fractions = [0.25, 0.50, 0.75, 1.0];
      const gateNames = ['CP 1', 'CP 2', 'CP 3', 'CP 4 (META)'];

      for (let g = 0; g < 4; g++) {
        const frac = fractions[g];
        const targetDist = this.totalLength * frac;
        let bestIdx = 0;
        if (frac === 1.0) {
          bestIdx = 0; // Finish line / start position
        } else {
          let minDiff = Infinity;
          for (let i = 0; i < n; i++) {
            const diff = Math.abs(dists[i] - targetDist);
            if (diff < minDiff) {
              minDiff = diff;
              bestIdx = i;
            }
          }
        }

        const pt = this.points[bestIdx];
        this.timingGates.push({
          id: g + 1,
          name: gateNames[g],
          pointIndex: bestIdx,
          left: pt.left.clone(),
          right: pt.right.clone(),
          center: pt.center.clone(),
          tangent: pt.tangent.clone(),
          normal: pt.normal.clone(),
          fraction: frac,
          distanceAlongTrack: Math.round(dists[bestIdx] || 0)
        });
      }
    }
  }

  get startPosition(): Vector2 {
    if (this.points.length === 0) return new Vector2(0, 0);
    return this.points[0].center.clone();
  }

  get startAngle(): number {
    if (this.points.length === 0) return 0;
    return this.points[0].tangent.heading();
  }

  /**
   * Generates staggered 2x2 starting grid slots along the main straight
   */
  getGridSlot(slotIndex: number): { pos: Vector2; heading: number; checkpointIdx: number } {
    if (this.points.length === 0) return { pos: new Vector2(0, 0), heading: 0, checkpointIdx: 0 };

    const n = this.points.length;
    const row = Math.floor(slotIndex / 2);
    const side = (slotIndex % 2 === 0) ? -1 : 1;

    // Go backwards from start line (point 0) along points
    const ptsPerRow = 2;
    const ptIdx = (n - 1 - (row * ptsPerRow) % n + n) % n;
    const pt = this.points[ptIdx];

    const lateralDist = Math.min(this.width * 0.22, 14);
    const pos = pt.center.add(pt.normal.mul(side * lateralDist));
    const heading = pt.tangent.heading();

    return { pos, heading, checkpointIdx: ptIdx };
  }

  /**
   * Casts a ray from origin in direction angleRad up to maxDist.
   * Uses spatial grid for O(1) candidate lookup instead of checking all 300+ track segments.
   */
  castRay(origin: Vector2, angleRad: number, maxDist: number = 300): IntersectionResult {
    const dir = Vector2.fromAngle(angleRad, 1);
    const target = origin.add(dir.mul(maxDist));
    let closestDist = maxDist;
    let hitPoint = target;

    const cs = this.spatialCellSize;
    const minGx = Math.floor(Math.min(origin.x, target.x) / cs);
    const maxGx = Math.floor(Math.max(origin.x, target.x) / cs);
    const minGy = Math.floor(Math.min(origin.y, target.y) / cs);
    const maxGy = Math.floor(Math.max(origin.y, target.y) / cs);

    this.queryId++;
    const qId = this.queryId;

    for (let gx = minGx; gx <= maxGx; gx++) {
      for (let gy = minGy; gy <= maxGy; gy++) {
        const cell = this.boundaryGrid.get(this.hashCell(gx, gy));
        if (!cell) continue;

        const len = cell.length;
        for (let i = 0; i < len; i++) {
          const seg = cell[i];
          if (seg.lastQueryId === qId) continue;
          seg.lastQueryId = qId;

          const hit = raySegmentIntersection(origin, dir, seg.p1, seg.p2, closestDist);
          if (hit && hit.dist < closestDist) {
            closestDist = hit.dist;
            hitPoint = hit.point;
          }
        }
      }
    }

    return {
      point: hitPoint,
      dist: closestDist
    };
  }

  /**
   * Fast check if car position is outside track limits using localized spatial grid.
   */
  isOutOfBounds(pos: Vector2): boolean {
    if (this.points.length < 3) return true;

    const cs = this.spatialCellSize;
    const gx = Math.floor(pos.x / cs);
    const gy = Math.floor(pos.y / cs);

    let minDist = Infinity;
    this.queryId++;
    const qId = this.queryId;

    for (let cx = gx - 1; cx <= gx + 1; cx++) {
      for (let cy = gy - 1; cy <= gy + 1; cy++) {
        const cell = this.centerGrid.get(this.hashCell(cx, cy));
        if (!cell) continue;

        const len = cell.length;
        for (let i = 0; i < len; i++) {
          const seg = cell[i];
          if (seg.lastQueryId === qId) continue;
          seg.lastQueryId = qId;

          const d = distToSegment(pos, seg.p1, seg.p2);
          if (d < minDist) {
            minDist = d;
          }
        }
      }
    }

    if (minDist === Infinity) {
      // Pos is far outside any indexed track cell
      return true;
    }

    return minDist > Math.max(1.1, this.width * 0.54);
  }
}
