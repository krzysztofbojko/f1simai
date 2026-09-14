export class Vector2 {
  constructor(public x: number = 0, public y: number = 0) {}

  set(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  clone(): Vector2 {
    return new Vector2(this.x, this.y);
  }

  add(v: Vector2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  addMut(v: Vector2): this {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  sub(v: Vector2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  subMut(v: Vector2): this {
    this.x -= v.x;
    this.y -= v.y;
    return this;
  }

  mul(s: number): Vector2 {
    return new Vector2(this.x * s, this.y * s);
  }

  mulMut(s: number): this {
    this.x *= s;
    this.y *= s;
    return this;
  }

  div(s: number): Vector2 {
    return new Vector2(this.x / s, this.y / s);
  }

  magSq(): number {
    return this.x * this.x + this.y * this.y;
  }

  mag(): number {
    return Math.sqrt(this.magSq());
  }

  heading(): number {
    return Math.atan2(this.y, this.x);
  }

  normalize(): Vector2 {
    const m = this.mag();
    if (m > 0.000001) {
      return this.div(m);
    }
    return new Vector2(0, 0);
  }

  dot(v: Vector2): number {
    return this.x * v.x + this.y * v.y;
  }

  cross(v: Vector2): number {
    return this.x * v.y - this.y * v.x;
  }

  dist(v: Vector2): number {
    return this.sub(v).mag();
  }

  distSq(v: Vector2): number {
    return this.sub(v).magSq();
  }

  rotate(angleRad: number): Vector2 {
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    return new Vector2(
      this.x * cos - this.y * sin,
      this.x * sin + this.y * cos
    );
  }

  normal(): Vector2 {
    // 90 degrees counter-clockwise
    return new Vector2(-this.y, this.x);
  }

  static fromAngle(angleRad: number, length: number = 1): Vector2 {
    return new Vector2(Math.cos(angleRad) * length, Math.sin(angleRad) * length);
  }

  static lerp(a: Vector2, b: Vector2, t: number): Vector2 {
    return new Vector2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  }
}

export interface LineSegment {
  p1: Vector2;
  p2: Vector2;
}

export interface IntersectionResult {
  point: Vector2;
  dist: number;
}

/**
 * Finds intersection between ray (rayOrigin -> rayDir) and segment (p1 -> p2).
 * rayDir does not need to be normalized, but dist is in units of rayDir if not.
 */
export function raySegmentIntersection(
  origin: Vector2,
  dir: Vector2,
  p1: Vector2,
  p2: Vector2,
  maxDist: number
): IntersectionResult | null {
  const x1 = origin.x;
  const y1 = origin.y;
  const x2 = origin.x + dir.x * maxDist;
  const y2 = origin.y + dir.y * maxDist;

  const x3 = p1.x;
  const y3 = p1.y;
  const x4 = p2.x;
  const y4 = p2.y;

  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-6) return null;

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    const pt = new Vector2(x1 + t * (x2 - x1), y1 + t * (y2 - y1));
    return {
      point: pt,
      dist: t * maxDist
    };
  }

  return null;
}

/**
 * Checks if two 2D segments intersect
 */
export function segmentsIntersect(p1: Vector2, p2: Vector2, p3: Vector2, p4: Vector2): boolean {
  const ccw = (a: Vector2, b: Vector2, c: Vector2) => {
    return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
  };
  return (
    ccw(p1, p3, p4) !== ccw(p2, p3, p4) &&
    ccw(p1, p2, p3) !== ccw(p1, p2, p4)
  );
}

/**
 * Distance from point P to line segment AB
 */
export function distToSegment(p: Vector2, a: Vector2, b: Vector2): number {
  const l2 = a.distSq(b);
  if (l2 === 0) return p.dist(a);
  let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  const proj = new Vector2(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y));
  return p.dist(proj);
}
