import { Vector2, LineSegment, raySegmentIntersection, IntersectionResult, distToSegment, segmentsIntersect } from '../math/Vector2';
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
  index?: number;
}

export type SurfaceType = 'asphalt' | 'grass' | 'gravel';
export interface SurfaceSample {
  surface: SurfaceType;
  center: Vector2;
  tangent: Vector2;
  index: number;
  fraction: number;
  lateral: number;
  outsideBarrier: boolean;
}
export interface RunoffPoint {
  requestedLeftWidth: number;
  requestedRightWidth: number;
  leftWidth: number;
  rightWidth: number;
  grassWidth: number;
  leftGrass: Vector2;
  rightGrass: Vector2;
  leftBarrier: Vector2;
  rightBarrier: Vector2;
}
export interface BarrierContact { fraction: number; normal: Vector2; }

export class Track {
  public points: TrackPoint[];
  public leftSegments: IndexedSegment[] = [];
  public rightSegments: IndexedSegment[] = [];
  public runoff: RunoffPoint[] = [];
  public barrierSegments: IndexedSegment[] = [];
  private barrierGrid: Map<number, IndexedSegment[]> = new Map();
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
    this.validateAsphalt();
    this.buildGeometry();
    this.buildRunoff();
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
        index: i,
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

  private validateAsphalt(): void {
    const n = this.points.length;
    if (n < 3 || !Number.isFinite(this.width) || this.width <= 0 || this.points.some(p => !Number.isFinite(p.center.x + p.center.y))) {
      throw new Error('Tor zawiera niepoprawną geometrię.');
    }
    for (let i = 0; i < n; i++) {
      const a = this.points[i], b = this.points[(i + 1) % n];
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const c = this.points[j], d = this.points[(j + 1) % n];
        const separation = Math.min(j - i, n - (j - i));
        const distance = Math.min(distToSegment(a.center, c.center, d.center), distToSegment(b.center, c.center, d.center), distToSegment(c.center, a.center, b.center), distToSegment(d.center, a.center, b.center));
        if ((separation > 2 && distance < this.width * 0.98) || segmentsIntersect(a.center, b.center, c.center, d.center) ||
          (separation > 2 && [a.left, a.right].some((edge, side) =>
            [c.left, c.right].some((other, otherSide) => segmentsIntersect(edge, side ? b.right : b.left, other, otherSide ? d.right : d.left))))) {
          throw new Error('Asfalt toru przecina się. Narysuj trasę bez przecinających się odcinków.');
        }
      }
    }
  }

  private buildRunoff(): void {
    const n = this.points.length, base = this.width * 0.25;
    const curved = this.points.map((_, i) => {
      let k = 0;
      for (let d = -2; d <= 2; d++) k += this.points[(i + d + n) % n].curvature * (3 - Math.abs(d));
      return k / 9;
    });
    const desired = this.points.map((_, i) => {
      let left = base, right = base;
      // Look ahead for the corner approach and retain its runoff on the exit.
      for (let d = -3; d <= 3; d++) {
        const k = curved[(i + d + n) % n], abs = Math.abs(k);
        if (abs < 0.001) continue;
        const approach = Math.min(85, Math.sqrt(1.3 * 9.81 / Math.max(0.0005, abs)));
        const severity = Math.min(1, abs / 0.008);
        const brakingDistance = approach * approach / (2 * 0.5 * 9.81);
        const width = Math.max(this.width, Math.min(4 * this.width, brakingDistance * severity));
        const smoothWeight = Math.exp(-Math.abs(d) * 0.3);
        if (k > 0) right = Math.max(right, base + (width - base) * smoothWeight);
        else left = Math.max(left, base + (width - base) * smoothWeight);
      }
      return { left, right };
    });
    this.runoff = this.points.map((point, i) => {
      const widths = [desired[i].left, desired[i].right];
      for (let side = 0; side < 2; side++) {
        const edge = side ? point.right : point.left;
        const outward = point.normal.mul(side ? -1 : 1);
        // Split the available space with neighbouring stretches of track.
        for (let j = 0; j < n; j++) {
          if (Math.min(Math.abs(j - i), n - Math.abs(j - i)) <= 2) continue;
          const next = this.points[(j + 1) % n];
          for (const [a, b] of [[this.points[j].left, next.left], [this.points[j].right, next.right]]) {
            const hit = raySegmentIntersection(edge, outward, a, b, widths[side] * 2 + 1);
            if (hit) widths[side] = Math.min(widths[side], Math.max(0.15, (hit.dist - 0.5) * 0.45));
          }
        }
      }
      const grassWidth = Math.min(this.width * 0.08, widths[0] * 0.4, widths[1] * 0.4);
      return { requestedLeftWidth: desired[i].left, requestedRightWidth: desired[i].right,
        leftWidth: widths[0], rightWidth: widths[1], grassWidth,
        leftGrass: point.left.add(point.normal.mul(grassWidth)),
        rightGrass: point.right.sub(point.normal.mul(grassWidth)),
        leftBarrier: point.left.add(point.normal.mul(widths[0])),
        rightBarrier: point.right.sub(point.normal.mul(widths[1])) };
    });
    const smoothWidths = () => {
      // Bound widening to 0.3 m per metre along the track. Only narrowing is
      // allowed here, so smoothing cannot consume space needed by another road.
      for (const direction of [1, -1]) for (let step = 0; step < 2 * n; step++) {
        const i = ((step * direction) % n + n) % n, neighbour = (i - direction + n) % n;
        const limit = this.points[i].center.dist(this.points[neighbour].center) * 0.3;
        const r = this.runoff[i], previous = this.runoff[neighbour];
        r.leftWidth = Math.min(r.leftWidth, previous.leftWidth + limit);
        r.rightWidth = Math.min(r.rightWidth, previous.rightWidth + limit);
      }
      for (let i = 0; i < n; i++) {
        const r = this.runoff[i], p = this.points[i];
        r.leftBarrier = p.left.add(p.normal.mul(r.leftWidth));
        r.rightBarrier = p.right.sub(p.normal.mul(r.rightWidth));
      }
    };
    smoothWidths();
    // Segment connectors can cut a nearby asphalt ribbon even when their
    // endpoints are clear. Shrink both endpoints until the entire edge clears it.
    for (let pass = 0; pass < 20; pass++) {
      let changed = false;
      for (let i = 0; i < n; i++) for (const side of ['left', 'right'] as const) {
        const ni = (i + 1) % n, a = this.runoff[i], b = this.runoff[ni];
        const key = side === 'left' ? 'leftBarrier' : 'rightBarrier';
        for (let j = 0; j < n; j++) {
          if (Math.min(Math.abs(j - i), n - Math.abs(j - i)) <= 2) continue;
          const p = this.points[j], q = this.points[(j + 1) % n];
          if (segmentsIntersect(a[key], b[key], p.left, q.left) || segmentsIntersect(a[key], b[key], p.right, q.right)) {
            for (const idx of [i, ni]) {
              const r = this.runoff[idx], point = this.points[idx];
              if (side === 'left') { r.leftWidth *= 0.7; r.leftBarrier = point.left.add(point.normal.mul(r.leftWidth)); }
              else { r.rightWidth *= 0.7; r.rightBarrier = point.right.sub(point.normal.mul(r.rightWidth)); }
            }
            changed = true; break;
          }
        }
      }
      if (!changed) break;
      smoothWidths();
    }
    this.barrierGrid.clear(); this.barrierSegments = [];
    for (let i = 0; i < n; i++) {
      const r = this.runoff[i], point = this.points[i];
      r.grassWidth = Math.min(r.grassWidth, r.leftWidth * 0.4, r.rightWidth * 0.4);
      r.leftGrass = point.left.add(point.normal.mul(r.grassWidth));
      r.rightGrass = point.right.sub(point.normal.mul(r.grassWidth));
      for (const side of ['leftBarrier', 'rightBarrier'] as const) {
        const segment = { id: i * 2 + (side === 'leftBarrier' ? 0 : 1), lastQueryId: 0,
          p1: r[side], p2: this.runoff[(i + 1) % n][side] };
        this.barrierSegments.push(segment); this.addSegmentToGrid(this.barrierGrid, segment);
      }
    }
  }

  sampleSurface(pos: Vector2): SurfaceSample {
    const cs = this.spatialCellSize, gx = Math.floor(pos.x / cs), gy = Math.floor(pos.y / cs);
    let min = Infinity, best = 0, fraction = 0, center = this.points[0].center;
    const test = (segment: IndexedSegment) => {
      const edge = segment.p2.sub(segment.p1);
      const t = Math.max(0, Math.min(1, pos.sub(segment.p1).dot(edge) / Math.max(0.0001, edge.magSq())));
      const projection = segment.p1.add(edge.mul(t)), distance = projection.distSq(pos);
      if (distance < min) { min = distance; best = segment.index!; fraction = t; center = projection; }
    };
    this.queryId++; const query = this.queryId;
    for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) {
      for (const seg of this.centerGrid.get(this.hashCell(x, y)) || []) {
        if (seg.lastQueryId !== query) { seg.lastQueryId = query; test(seg); }
      }
    }
    if (!Number.isFinite(min)) for (let i = 0; i < this.points.length; i++) test({ p1: this.points[i].center, p2: this.points[(i + 1) % this.points.length].center, index: i, id: i, lastQueryId: 0 });
    const next = (best + 1) % this.points.length;
    const tangent = this.points[next].center.sub(this.points[best].center).normalize();
    const normal = tangent.normal(), lateral = pos.sub(center).dot(normal);
    const a = this.runoff[best], b = this.runoff[next];
    const asphaltEdge = Vector2.lerp(lateral >= 0 ? this.points[best].left : this.points[best].right,
      lateral >= 0 ? this.points[next].left : this.points[next].right, fraction);
    const asphaltWidth = Math.abs(asphaltEdge.sub(center).dot(normal));
    const excess = Math.sqrt(min) - asphaltWidth;
    const grassEdge = Vector2.lerp(lateral >= 0 ? a.leftGrass : a.rightGrass, lateral >= 0 ? b.leftGrass : b.rightGrass, fraction);
    const barrierEdge = Vector2.lerp(lateral >= 0 ? a.leftBarrier : a.rightBarrier, lateral >= 0 ? b.leftBarrier : b.rightBarrier, fraction);
    const grassWidth = Math.abs(grassEdge.sub(center).dot(normal)) - asphaltWidth;
    const runoffWidth = Math.abs(barrierEdge.sub(center).dot(normal)) - asphaltWidth;
    return { surface: excess <= 0 ? 'asphalt' : excess <= grassWidth ? 'grass' : 'gravel',
      center, tangent, index: best, fraction, lateral, outsideBarrier: excess > runoffWidth + 0.01 };
  }

  /** Swept oriented 5.5 x 1.8 m body, including rotation and glancing contacts. */
  sweepBarrier(from: Vector2, to: Vector2, fromHeading: number, toHeading: number): BarrierContact | null {
    const pad = 3.1, cs = this.spatialCellSize, candidates = new Set<IndexedSegment>();
    for (let x = Math.floor((Math.min(from.x, to.x) - pad) / cs); x <= Math.floor((Math.max(from.x, to.x) + pad) / cs); x++) {
      for (let y = Math.floor((Math.min(from.y, to.y) - pad) / cs); y <= Math.floor((Math.max(from.y, to.y) + pad) / cs); y++) {
        for (const segment of this.barrierGrid.get(this.hashCell(x, y)) || []) candidates.add(segment);
      }
    }
    if (!candidates.size) return null;
    const contact = (t: number): IndexedSegment | null => {
      const position = Vector2.lerp(from, to, t), heading = fromHeading + (toHeading - fromHeading) * t;
      const forward = Vector2.fromAngle(heading), side = forward.normal();
      const corners = [[-2.75, -0.9], [2.75, -0.9], [2.75, 0.9], [-2.75, 0.9]].map(([x, y]) => position.add(forward.mul(x)).add(side.mul(y)));
      for (const segment of candidates) {
        const inside = (p: Vector2) => Math.abs(p.sub(position).dot(forward)) <= 2.75 && Math.abs(p.sub(position).dot(side)) <= 0.9;
        if (inside(segment.p1) || inside(segment.p2) || corners.some((p, i) => segmentsIntersect(p, corners[(i + 1) % 4], segment.p1, segment.p2))) return segment;
      }
      return null;
    };
    const steps = Math.max(1, Math.ceil((from.dist(to) + Math.abs(toHeading - fromHeading) * 3) / 0.25));
    const bodyCorners = (t: number) => {
      const position = Vector2.lerp(from, to, t), forward = Vector2.fromAngle(fromHeading + (toHeading - fromHeading) * t), side = forward.normal();
      return [[-2.75,-0.9],[2.75,-0.9],[2.75,0.9],[-2.75,0.9]].map(([x,y]) => position.add(forward.mul(x)).add(side.mul(y)));
    };
    let previousCorners = bodyCorners(0);
    for (let i = 0; i <= steps; i++) {
      let hit = contact(i / steps), fraction = i / steps;
      const corners = bodyCorners(i / steps);
      if (i > 0) for (const segment of candidates) for (let k = 0; k < 4; k++) {
        const path = corners[k].sub(previousCorners[k]), length = path.mag();
        if (length <= 1e-10) continue;
        const crossing = raySegmentIntersection(previousCorners[k], path.div(length), segment.p1, segment.p2, length);
        const t = crossing ? (i - 1 + crossing.dist / length) / steps : Infinity;
        if (t < fraction) { hit = segment; fraction = t; }
      }
      previousCorners = corners;
      if (!hit) continue;
      let low = Math.max(0, (i - 1) / steps), high = fraction;
      for (let k = 0; k < 10; k++) { const mid = (low + high) / 2; if (contact(mid)) high = mid; else low = mid; }
      const midpoint = hit.p1.add(hit.p2).mul(0.5);
      let normal = hit.p2.sub(hit.p1).normalize().normal();
      if (normal.dot(this.sampleSurface(midpoint).center.sub(midpoint)) < 0) normal = normal.mul(-1);
      return { fraction: Math.max(0, low - 0.0001), normal };
    }
    return null;
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

    return minDist > Math.max(1.1, this.width * 0.5);
  }
}
