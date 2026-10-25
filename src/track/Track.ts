import { Vector2, LineSegment, raySegmentIntersection, IntersectionResult, distToSegment, segmentsIntersect } from '../math/Vector2';
import { TrackPoint } from '../math/Spline';
import { PitLane } from './PitLane';

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
  /** The checkpoint (gate) the timing line sits on. */
  checkpointIndex: number;
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
  /** Former per-circuit pit-lane loss: still read from track files, no longer used (the lane is driven). */
  public pitLaneLoss: number | null = null;
  /** The pit lane beside the start/finish straight (null on a track too short for one). */
  public pitLane: PitLane | null = null;

  /** Metres between consecutive track points (the spline resamples them uniformly). */
  public spacing: number = 1;
  /**
   * Centreline curvature smoothed over a triangular window CURVATURE_WINDOW metres wide: what
   * corner detection (kerbs, runoff, racing line margins, the line network's road preview) reads.
   */
  public smoothedCurvature: Float64Array = new Float64Array(0);
  /** Centreline curvature averaged over about GATE_SPACING metres: the bend at a point as a gate or kerb sees it. */
  public localCurvature: Float64Array = new Float64Array(0);
  /** For every track point, the checkpoint (gate) at or before it. */
  private pointGate: Int32Array = new Int32Array(0);

  /** Metres between checkpoints (gates): lap progress, fitness and timing count gates, not points. */
  static readonly GATE_SPACING = 18;
  /** Base of the triangular curvature filter: 54 m, three points of the former 18 m track. */
  static readonly CURVATURE_WINDOW = 54;
  /** Along-track distance under which two stretches of track count as neighbours, not as separate roads. */
  static readonly NEIGHBOUR_DISTANCE = 45;
  /** Runoff widens for a corner this many metres before it and keeps the width as far after it. */
  static readonly RUNOFF_REACH = 54;
  /** Metres over which a corner's runoff demand falls off by a factor e. */
  static readonly RUNOFF_FALLOFF = 60;
  /** Radius (m) searched ring by ring for the nearest centreline before scanning the whole track. */
  private static readonly SURFACE_SEARCH_RADIUS = 240;

  // High-performance spatial grid for O(1) raycasting and collision checks
  private spatialCellSize: number = 8;
  private boundaryGrid: Map<number, IndexedSegment[]> = new Map();
  private centerGrid: Map<number, IndexedSegment[]> = new Map();
  private queryId: number = 0;
  private surfaceCache = new WeakMap<Vector2, { x: number; y: number; sample: SurfaceSample }>();

  constructor(points: TrackPoint[], width: number = 90) {
    this.points = points;
    this.width = width;
    this.validatePoints();
    this.buildGeometry();
    this.validateAsphalt();
    this.buildRunoff();
    this.pitLane = PitLane.build(this);
  }

  /** Track points covering `metres` along the track (at least one). */
  pointsFor(metres: number): number {
    return Math.max(1, Math.round(metres / this.spacing));
  }

  /** The track point `metres` ahead of `index` (behind when negative). */
  pointAhead(index: number, metres: number): number {
    const n = this.points.length;
    return ((index + Math.round(metres / this.spacing)) % n + n) % n;
  }

  /** The checkpoint at or before a track point: the last gate a car at that point has reached. */
  gateIndexOf(pointIndex: number): number {
    const n = this.pointGate.length;
    return n ? this.pointGate[((pointIndex % n) + n) % n] : 0;
  }

  private hashCell(gx: number, gy: number): number {
    return (gx << 16) | (gy & 0xffff);
  }

  /** Segments of `grid` in cells overlapping the box, each once. */
  private segmentsInBox(grid: Map<number, IndexedSegment[]>, minX: number, minY: number, maxX: number, maxY: number): IndexedSegment[] {
    const cs = this.spatialCellSize, found: IndexedSegment[] = [];
    this.queryId++; const query = this.queryId;
    for (let gx = Math.floor(minX / cs); gx <= Math.floor(maxX / cs); gx++) {
      for (let gy = Math.floor(minY / cs); gy <= Math.floor(maxY / cs); gy++) {
        const cell = grid.get(this.hashCell(gx, gy));
        if (cell) for (const segment of cell) if (segment.lastQueryId !== query) { segment.lastQueryId = query; found.push(segment); }
      }
    }
    return found;
  }

  /** Points within which another stretch of track is the same road: at least the two segments sharing an end. */
  private neighbourPoints(): number {
    return Math.max(2, Track.NEIGHBOUR_DISTANCE / this.spacing);
  }

  /** Along-track distance in points between two track points, the short way round. */
  private separation(i: number, j: number): number {
    const n = this.points.length, d = Math.abs(i - j);
    return Math.min(d, n - d);
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

  /** Centred moving average over `metres` of track (an odd number of points), around the closed loop. */
  private boxFilter(values: Float64Array, metres: number): Float64Array {
    const n = values.length, half = Math.floor(this.pointsFor(metres) / 2);
    const out = new Float64Array(n);
    if (n === 0) return out;
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
    // Sum of values[a..b] for any a ≤ b, wrapping around the loop.
    const sum = (a: number, b: number): number => {
      const laps = Math.floor(a / n), from = a - laps * n, to = b - laps * n;
      if (to < n) return prefix[to + 1] - prefix[from];
      const whole = Math.floor((to + 1) / n);
      return prefix[n] - prefix[from] + (whole - 1) * prefix[n] + prefix[(to + 1) - whole * n];
    };
    for (let i = 0; i < n; i++) out[i] = sum(i - half, i + half) / (2 * half + 1);
    return out;
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
        index: i,
        id: segId++,
        lastQueryId: 0,
        p1: curr.left,
        p2: next.left
      };
      this.leftSegments.push(leftSeg);
      this.addSegmentToGrid(this.boundaryGrid, leftSeg);

      const rightSeg: IndexedSegment = {
        index: i,
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
    }
    this.spacing = n > 0 && this.totalLength > 0 ? this.totalLength / n : 1;
    const curvature = Float64Array.from(this.points, p => p.curvature);
    this.smoothedCurvature = this.boxFilter(this.boxFilter(curvature, Track.CURVATURE_WINDOW), Track.CURVATURE_WINDOW);
    this.localCurvature = this.boxFilter(this.boxFilter(curvature, Track.GATE_SPACING), Track.GATE_SPACING);

    // Gates: evenly spaced points, the first on the start/finish line (point 0).
    const gates = Math.min(n, Math.max(4, Math.round(this.totalLength / Track.GATE_SPACING)));
    this.pointGate = new Int32Array(n);
    for (let g = 0; g < gates; g++) {
      const i = Math.floor(g * n / gates), curr = this.points[i];
      this.checkpoints.push({
        index: i,
        p1: curr.left,
        p2: curr.right,
        center: curr.center,
        tangent: curr.tangent,
        curvature: this.localCurvature[i],
      });
      const end = g + 1 < gates ? Math.floor((g + 1) * n / gates) : n;
      this.pointGate.fill(g, i, end);
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
        let bestGate = 0;
        if (frac !== 1.0) { // the finish line is gate 0, at the start position
          let minDiff = Infinity;
          for (let k = 0; k < this.checkpoints.length; k++) {
            const diff = Math.abs(dists[this.checkpoints[k].index] - targetDist);
            if (diff < minDiff) {
              minDiff = diff;
              bestGate = k;
            }
          }
        }
        const bestIdx = this.checkpoints[bestGate].index;

        const pt = this.points[bestIdx];
        this.timingGates.push({
          id: g + 1,
          name: gateNames[g],
          pointIndex: bestIdx,
          checkpointIndex: bestGate,
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

  private validatePoints(): void {
    if (this.points.length < 3 || !Number.isFinite(this.width) || this.width <= 0
      || this.points.some(p => ![p.center, p.left, p.right].every(q => Number.isFinite(q.x + q.y)))) {
      throw new Error('Tor zawiera niepoprawną geometrię.');
    }
  }

  private validateAsphalt(): void {
    const n = this.points.length, reach = this.width, neighbours = this.neighbourPoints();
    for (let i = 0; i < n; i++) {
      const a = this.points[i], b = this.points[(i + 1) % n];
      // Two stretches of asphalt can only touch where their centrelines come within a track width.
      const nearby = this.segmentsInBox(this.centerGrid, Math.min(a.center.x, b.center.x) - reach, Math.min(a.center.y, b.center.y) - reach,
        Math.max(a.center.x, b.center.x) + reach, Math.max(a.center.y, b.center.y) + reach);
      for (const segment of nearby) {
        const j = segment.index!;
        if (j < i + 2 || (i === 0 && j === n - 1)) continue;
        const c = this.points[j], d = this.points[(j + 1) % n];
        const separated = this.separation(i, j) > neighbours;
        const distance = Math.min(distToSegment(a.center, c.center, d.center), distToSegment(b.center, c.center, d.center), distToSegment(c.center, a.center, b.center), distToSegment(d.center, a.center, b.center));
        if ((separated && distance < this.width * 0.98) || segmentsIntersect(a.center, b.center, c.center, d.center) ||
          (separated && [a.left, a.right].some((edge, side) =>
            [c.left, c.right].some((other, otherSide) => segmentsIntersect(edge, side ? b.right : b.left, other, otherSide ? d.right : d.left))))) {
          throw new Error('Asfalt toru przecina się. Narysuj trasę bez przecinających się odcinków.');
        }
      }
    }
  }

  private buildRunoff(): void {
    const n = this.points.length, base = this.width * 0.25, curved = this.smoothedCurvature;
    const reach = Math.round(Track.RUNOFF_REACH / this.spacing), neighbours = this.neighbourPoints();
    const desired = this.points.map((_, i) => {
      let left = base, right = base;
      // Look ahead for the corner approach and retain its runoff on the exit.
      for (let d = -reach; d <= reach; d++) {
        const k = curved[(i + d + n) % n], abs = Math.abs(k);
        if (abs < 0.001) continue;
        const approach = Math.min(85, Math.sqrt(1.3 * 9.81 / Math.max(0.0005, abs)));
        const severity = Math.min(1, abs / 0.008);
        const brakingDistance = approach * approach / (2 * 0.5 * 9.81);
        const width = Math.max(this.width, Math.min(4 * this.width, brakingDistance * severity));
        const smoothWeight = Math.exp(-Math.abs(d) * this.spacing / Track.RUNOFF_FALLOFF);
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
        const length = widths[side] * 2 + 1, end = edge.add(outward.mul(length));
        const edges = this.segmentsInBox(this.boundaryGrid, Math.min(edge.x, end.x), Math.min(edge.y, end.y), Math.max(edge.x, end.x), Math.max(edge.y, end.y));
        for (const segment of edges) {
          if (this.separation(segment.index!, i) <= neighbours) continue;
          const hit = raySegmentIntersection(edge, outward, segment.p1, segment.p2, widths[side] * 2 + 1);
          if (hit) widths[side] = Math.min(widths[side], Math.max(0.15, (hit.dist - 0.5) * 0.45));
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
        const key = side === 'left' ? 'leftBarrier' : 'rightBarrier', from = a[key], to = b[key];
        const edges = this.segmentsInBox(this.boundaryGrid, Math.min(from.x, to.x), Math.min(from.y, to.y), Math.max(from.x, to.x), Math.max(from.y, to.y));
        for (const segment of edges) {
          if (this.separation(segment.index!, i) <= neighbours) continue;
          if (segmentsIntersect(from, to, segment.p1, segment.p2)) {
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
    this.surfaceCache = new WeakMap();
  }

  /** Callers treat samples as read-only, so repeated queries for the same unmoved position reuse one. */
  sampleSurface(pos: Vector2): SurfaceSample {
    const cached = this.surfaceCache.get(pos);
    if (cached && cached.x === pos.x && cached.y === pos.y) return cached.sample;
    const sample = this.computeSurface(pos);
    this.surfaceCache.set(pos, { x: pos.x, y: pos.y, sample });
    return sample;
  }

  private computeSurface(pos: Vector2): SurfaceSample {
    const cs = this.spatialCellSize, gx = Math.floor(pos.x / cs), gy = Math.floor(pos.y / cs);
    const px = pos.x, py = pos.y;
    let min = Infinity, best = 0, fraction = 0, cx = 0, cy = 0;
    // Scalar form of the segment projection; same operation order as the Vector2 version.
    const test = (p1: Vector2, p2: Vector2, index: number) => {
      const ex = p2.x - p1.x, ey = p2.y - p1.y;
      const t = Math.max(0, Math.min(1, ((px - p1.x) * ex + (py - p1.y) * ey) / Math.max(0.0001, ex * ex + ey * ey)));
      const qx = p1.x + ex * t, qy = p1.y + ey * t, dx = qx - px, dy = qy - py, distance = dx * dx + dy * dy;
      if (distance < min) { min = distance; best = index; fraction = t; cx = qx; cy = qy; }
    };
    this.queryId++; const query = this.queryId;
    const visit = (x: number, y: number) => {
      const cell = this.centerGrid.get(this.hashCell(x, y));
      if (!cell) return;
      for (let i = 0; i < cell.length; i++) {
        const seg = cell[i];
        if (seg.lastQueryId !== query) { seg.lastQueryId = query; test(seg.p1, seg.p2, seg.index!); }
      }
    };
    // Rings of cells around the position's own: once the nearest segment found so far is closer
    // than any cell outside the searched square can be, it is the nearest of the whole track.
    const inner = Math.min(px - gx * cs, (gx + 1) * cs - px, py - gy * cs, (gy + 1) * cs - py);
    for (let ring = 0, rings = Math.ceil(Track.SURFACE_SEARCH_RADIUS / cs); ring <= rings; ring++) {
      if (ring === 0) visit(gx, gy);
      else for (let k = -ring; k <= ring; k++) {
        visit(gx + k, gy - ring); visit(gx + k, gy + ring);
        if (k > -ring && k < ring) { visit(gx - ring, gy + k); visit(gx + ring, gy + k); }
      }
      const clear = inner + ring * cs;
      if (min <= clear * clear) break;
    }
    if (!Number.isFinite(min)) for (let i = 0; i < this.points.length; i++) test(this.points[i].center, this.points[(i + 1) % this.points.length].center, i);
    const center = new Vector2(cx, cy);
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
    const pad = 3.1, cs = this.spatialCellSize, candidates: IndexedSegment[] = [];
    const minX = Math.min(from.x, to.x) - pad, maxX = Math.max(from.x, to.x) + pad, minY = Math.min(from.y, to.y) - pad, maxY = Math.max(from.y, to.y) + pad;
    this.queryId++; const query = this.queryId;
    for (let x = Math.floor(minX / cs); x <= Math.floor(maxX / cs); x++) {
      for (let y = Math.floor(minY / cs); y <= Math.floor(maxY / cs); y++) {
        const cell = this.barrierGrid.get(this.hashCell(x, y));
        if (cell) for (const segment of cell) {
          if (segment.lastQueryId === query) continue;
          segment.lastQueryId = query;
          // Only segments the swept body can reach.
          if (Math.max(segment.p1.x, segment.p2.x) < minX || Math.min(segment.p1.x, segment.p2.x) > maxX
            || Math.max(segment.p1.y, segment.p2.y) < minY || Math.min(segment.p1.y, segment.p2.y) > maxY) continue;
          candidates.push(segment);
        }
      }
    }
    if (!candidates.length) return null;
    // Scalar body corners (same arithmetic as the Vector2 form): order -+ as [-L,-W], [L,-W], [L,W], [-L,W].
    const CX = [-2.75, 2.75, 2.75, -2.75], CY = [-0.9, -0.9, 0.9, 0.9];
    let px = 0, py = 0, fx = 0, fy = 0, sx = 0, sy = 0;
    const pose = (t: number, xs: number[], ys: number[]) => {
      px = from.x + (to.x - from.x) * t; py = from.y + (to.y - from.y) * t;
      const heading = fromHeading + (toHeading - fromHeading) * t;
      fx = Math.cos(heading); fy = Math.sin(heading); sx = -fy; sy = fx;
      for (let k = 0; k < 4; k++) { xs[k] = px + fx * CX[k] + sx * CY[k]; ys[k] = py + fy * CX[k] + sy * CY[k]; }
    };
    const ccw = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
    const inside = (p: Vector2) => Math.abs((p.x - px) * fx + (p.y - py) * fy) <= 2.75 && Math.abs((p.x - px) * sx + (p.y - py) * sy) <= 0.9;
    const cxs = [0, 0, 0, 0], cys = [0, 0, 0, 0];
    const contact = (t: number): IndexedSegment | null => {
      pose(t, cxs, cys);
      for (const segment of candidates) {
        if (inside(segment.p1) || inside(segment.p2)) return segment;
        const x3 = segment.p1.x, y3 = segment.p1.y, x4 = segment.p2.x, y4 = segment.p2.y;
        for (let i = 0; i < 4; i++) {
          const ax = cxs[i], ay = cys[i], bx = cxs[(i + 1) % 4], by = cys[(i + 1) % 4];
          if (ccw(ax, ay, x3, y3, x4, y4) !== ccw(bx, by, x3, y3, x4, y4) && ccw(ax, ay, bx, by, x3, y3) !== ccw(ax, ay, bx, by, x4, y4)) return segment;
        }
      }
      return null;
    };
    const steps = Math.max(1, Math.ceil((from.dist(to) + Math.abs(toHeading - fromHeading) * 3) / 0.25));
    let prevX = [0, 0, 0, 0], prevY = [0, 0, 0, 0], curX = [0, 0, 0, 0], curY = [0, 0, 0, 0];
    pose(0, prevX, prevY);
    for (let i = 0; i <= steps; i++) {
      let hit = contact(i / steps), fraction = i / steps;
      pose(i / steps, curX, curY);
      if (i > 0) for (const segment of candidates) for (let k = 0; k < 4; k++) {
        const pathX = curX[k] - prevX[k], pathY = curY[k] - prevY[k], length = Math.sqrt(pathX * pathX + pathY * pathY);
        if (length <= 1e-10) continue;
        // Inlined raySegmentIntersection(previous corner, path / length, segment, length).
        const x1 = prevX[k], y1 = prevY[k], x2 = x1 + pathX / length * length, y2 = y1 + pathY / length * length;
        const x3 = segment.p1.x, y3 = segment.p1.y, x4 = segment.p2.x, y4 = segment.p2.y;
        const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
        if (Math.abs(den) < 1e-6) continue;
        const s = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
        const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
        if (!(s >= 0 && s <= 1 && u >= 0 && u <= 1)) continue;
        const t = (i - 1 + s * length / length) / steps;
        if (t < fraction) { hit = segment; fraction = t; }
      }
      [prevX, curX] = [curX, prevX]; [prevY, curY] = [curY, prevY];
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
  /** Distance between consecutive grid slots: a staggered grid, 16 m per row. */
  static readonly GRID_SLOT_SPACING = 8;

  getGridSlot(slotIndex: number): { pos: Vector2; heading: number; checkpointIdx: number } {
    if (this.points.length === 0) return { pos: new Vector2(0, 0), heading: 0, checkpointIdx: 0 };

    const n = this.points.length;
    const side = (slotIndex % 2 === 0) ? -1 : 1;

    // Walk backwards from the start line (point 0); pole sits on the last point before it.
    const firstGap = this.points[n - 1].center.dist(this.points[0].center);
    let remaining = Math.min(firstGap + slotIndex * Track.GRID_SLOT_SPACING, this.totalLength * 0.9);
    let ahead = 0;
    let behind = n - 1;
    for (let guard = 0; guard < n; guard++) {
      const segment = this.points[behind].center.dist(this.points[ahead].center);
      if (remaining <= segment || segment === 0) break;
      remaining -= segment;
      ahead = behind;
      behind = (behind - 1 + n) % n;
    }
    const from = this.points[behind];
    const to = this.points[ahead];
    const segment = from.center.dist(to.center);
    const t = segment > 0 ? Math.max(0, Math.min(1, 1 - remaining / segment)) : 0;
    const center = from.center.add(to.center.sub(from.center).mul(t));

    const lateralDist = Math.min(this.width * 0.22, 14);
    const pos = center.add(from.normal.mul(side * lateralDist));
    const heading = from.tangent.heading();

    // On a curve the lateral offset can put a slot past the next gate's line; that gate is then
    // behind the car and could never be crossed, so count it as already passed.
    const gates = this.checkpoints.length;
    let checkpointIdx = this.gateIndexOf(t >= 1 ? ahead : behind);
    for (let guard = 0; guard < 3 && gates > 0; guard++) {
      const next = this.checkpoints[(checkpointIdx + 1) % gates];
      if (pos.sub(next.center).dot(next.tangent) < 0) break;
      checkpointIdx = (checkpointIdx + 1) % gates;
    }
    return { pos, heading, checkpointIdx };
  }

  /**
   * Casts a ray from origin in direction angleRad up to maxDist.
   * Uses spatial grid for O(1) candidate lookup instead of checking all 300+ track segments.
   */
  castRay(origin: Vector2, angleRad: number, maxDist: number = 300): IntersectionResult {
    const dir = Vector2.fromAngle(angleRad, 1);
    const ox = origin.x, oy = origin.y, tx = ox + dir.x * maxDist, ty = oy + dir.y * maxDist;
    let closestDist = maxDist, hitX = tx, hitY = ty;

    const cs = this.spatialCellSize;
    let gx = Math.floor(ox / cs), gy = Math.floor(oy / cs);
    const endGx = Math.floor(tx / cs), endGy = Math.floor(ty / cs);
    // Grid traversal along the ray (Amanatides-Woo): cells in the order the ray enters them.
    const stepX = dir.x > 0 ? 1 : -1, stepY = dir.y > 0 ? 1 : -1;
    const deltaX = dir.x !== 0 ? cs / Math.abs(dir.x) : Infinity, deltaY = dir.y !== 0 ? cs / Math.abs(dir.y) : Infinity;
    let exitX = dir.x !== 0 ? ((stepX > 0 ? (gx + 1) * cs - ox : ox - gx * cs) / Math.abs(dir.x)) : Infinity;
    let exitY = dir.y !== 0 ? ((stepY > 0 ? (gy + 1) * cs - oy : oy - gy * cs) / Math.abs(dir.y)) : Infinity;

    this.queryId++;
    const qId = this.queryId;

    for (let guard = 0; guard < 4096; guard++) {
      const cell = this.boundaryGrid.get(this.hashCell(gx, gy));
      if (cell) {
        const len = cell.length;
        for (let i = 0; i < len; i++) {
          const seg = cell[i];
          if (seg.lastQueryId === qId) continue;
          seg.lastQueryId = qId;

          // Inlined raySegmentIntersection(origin, dir, seg.p1, seg.p2, closestDist): same arithmetic, no allocation.
          const x2 = ox + dir.x * closestDist, y2 = oy + dir.y * closestDist;
          const x3 = seg.p1.x, y3 = seg.p1.y, x4 = seg.p2.x, y4 = seg.p2.y;
          // A segment whose box is clearly apart from the ray's box cannot intersect it.
          if (Math.max(x3, x4) < Math.min(ox, x2) - 1e-3 || Math.min(x3, x4) > Math.max(ox, x2) + 1e-3
            || Math.max(y3, y4) < Math.min(oy, y2) - 1e-3 || Math.min(y3, y4) > Math.max(oy, y2) + 1e-3) continue;
          const den = (ox - x2) * (y3 - y4) - (oy - y2) * (x3 - x4);
          if (Math.abs(den) < 1e-6) continue;
          const t = ((ox - x3) * (y3 - y4) - (oy - y3) * (x3 - x4)) / den;
          const u = -((ox - x2) * (oy - y3) - (oy - y2) * (ox - x3)) / den;
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
            const dist = t * closestDist;
            if (dist < closestDist) {
              hitX = ox + t * (x2 - ox);
              hitY = oy + t * (y2 - oy);
              closestDist = dist;
            }
          }
        }
      }
      // A hit before the ray leaves this cell cannot be beaten by any cell further along.
      const exit = Math.min(exitX, exitY);
      if (closestDist <= exit || exit >= maxDist || (gx === endGx && gy === endGy)) break;
      if (exitX < exitY) { gx += stepX; exitX += deltaX; } else { gy += stepY; exitY += deltaY; }
    }

    return {
      point: new Vector2(hitX, hitY),
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
